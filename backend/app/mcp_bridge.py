"""Connects to a run's MCP servers and exposes their tools as Gemini function declarations.

Servers (both stdio, one process each per run, bound to one workspace):
  - filesystem: official @modelcontextprotocol/server-filesystem, allowed dir = workspace
  - ops:        app.ops.server (controlled app operations)

The agent addresses files with workspace-relative paths. The bridge validates every
path argument (no escape via `..`, absolute paths or symlinks, no writes to protected
dirs), rewrites it to an absolute path for the server, and maps absolute paths in
results back to relative ones. Only an allowlist of tools is exposed.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

import anyio
from google.genai import types
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from app.config import BACKEND_DIR

FS_SERVER_JS = BACKEND_DIR / "node_modules" / "@modelcontextprotocol" / "server-filesystem" / "dist" / "index.js"

# Filesystem tools the agent may use. Excluded: move_file (destructive), read_media_file,
# read_file (deprecated alias), append_file, list_directory_with_sizes, list_allowed_directories
# (would reveal host paths).
FS_TOOLS = {
    "read_text_file", "read_multiple_files", "list_directory", "directory_tree", "search_files",
    "get_file_info", "write_file", "edit_file", "create_directory", "copy_file",
}
FS_WRITE_TOOLS = {"write_file", "edit_file", "create_directory", "copy_file"}
PATH_ARGS = ("path", "source", "destination")
# Writes here would let the agent "fix" a failure by changing the checks themselves.
PROTECTED_DIRS = ("tests", "logs")

CONNECT_TIMEOUT = 20.0
CALL_TIMEOUT = 45.0
MAX_RESULT_CHARS = 12000

_SCHEMA_KEYS = {
    "description": "description", "enum": "enum", "format": "format", "default": "default",
    "minItems": "min_items", "maxItems": "max_items", "minLength": "min_length",
    "maxLength": "max_length", "minimum": "minimum", "maximum": "maximum",
    "pattern": "pattern", "title": "title", "nullable": "nullable",
}
_TYPES = {"string", "number", "integer", "boolean", "array", "object", "null"}


class MCPBridgeError(Exception):
    """Connection/setup failure (as opposed to a tool-level error, which is returned)."""


class PathViolation(Exception):
    pass


@dataclass(frozen=True)
class ToolSpec:
    server: str
    name: str
    description: str
    input_schema: dict


# --------------------------------------------------------------------------- schema conversion
def json_schema_to_gemini(schema: dict, defs: dict | None = None) -> types.Schema:
    """Convert an MCP (JSON Schema) input schema to a Gemini `types.Schema`.

    Keeps types, descriptions, properties, required, items, enums and bounds; resolves
    local `$ref`s; maps type lists / `anyOf` with null to `nullable`; drops keys Gemini
    does not support (`$schema`, `additionalProperties`, `exclusiveMinimum`, ...).
    """
    defs = {**(defs or {}), **schema.get("$defs", {}), **schema.get("definitions", {})}
    if "$ref" in schema:
        ref = schema["$ref"].rsplit("/", 1)[-1]
        if ref not in defs:
            raise ValueError(f"unresolvable $ref {schema['$ref']}")
        merged = {**defs[ref], **{k: v for k, v in schema.items() if k != "$ref"}}
        return json_schema_to_gemini(merged, defs)

    out: dict[str, Any] = {k_out: schema[k_in] for k_in, k_out in _SCHEMA_KEYS.items() if k_in in schema}
    if "exclusiveMinimum" in schema and "minimum" not in schema:
        out["minimum"] = schema["exclusiveMinimum"]
    if isinstance(out.get("maximum"), (int, float)) and out["maximum"] >= 2**53 - 1:
        del out["maximum"]  # JS MAX_SAFE_INTEGER sentinel, not a real bound

    typ = schema.get("type")
    if isinstance(typ, list):
        non_null = [t for t in typ if t != "null"]
        if "null" in typ:
            out["nullable"] = True
        if len(non_null) == 1:
            typ = non_null[0]
        else:
            out["any_of"] = [json_schema_to_gemini({**schema, "type": t}, defs) for t in non_null]
            typ = None
    variants = schema.get("anyOf") or schema.get("oneOf")
    if variants:
        non_null = [v for v in variants if v.get("type") != "null"]
        if len(non_null) < len(variants):
            out["nullable"] = True
        if len(non_null) == 1:
            inner = json_schema_to_gemini(non_null[0], defs).model_dump(exclude_none=True)
            out = {**inner, **out}
        else:
            out["any_of"] = [json_schema_to_gemini(v, defs) for v in non_null]
    if typ is None and "properties" in schema:
        typ = "object"
    if typ is not None:
        if typ not in _TYPES:
            raise ValueError(f"unsupported schema type {typ!r}")
        out["type"] = types.Type(typ.upper())
    if "properties" in schema:
        out["properties"] = {k: json_schema_to_gemini(v, defs) for k, v in schema["properties"].items()}
        out["property_ordering"] = list(schema["properties"])
    if "required" in schema:
        out["required"] = list(schema["required"])
    if "items" in schema and isinstance(schema["items"], dict):
        out["items"] = json_schema_to_gemini(schema["items"], defs)
    return types.Schema(**out)


def to_function_declaration(spec: ToolSpec) -> types.FunctionDeclaration:
    schema = spec.input_schema or {"type": "object", "properties": {}}
    params = json_schema_to_gemini(schema)
    has_params = bool(schema.get("properties"))
    return types.FunctionDeclaration(
        name=spec.name, description=spec.description, parameters=params if has_params else None)


# --------------------------------------------------------------------------- path jail
class PathGuard:
    def __init__(self, root: Path):
        self.root = Path(root).resolve(strict=True)

    def resolve(self, value: Any, *, write: bool) -> str:
        if not isinstance(value, str) or not value.strip() or "\x00" in value:
            raise PathViolation("path must be a non-empty string")
        raw = Path(value)
        candidate = raw if raw.is_absolute() else self.root / raw
        # realpath follows symlinks for existing components, so links pointing out are caught.
        resolved = Path(os.path.realpath(candidate))
        if not resolved.is_relative_to(self.root):
            raise PathViolation(f"path '{value}' is outside the workspace")
        rel = resolved.relative_to(self.root)
        if write and rel.parts and rel.parts[0] in PROTECTED_DIRS:
            raise PathViolation(f"writes to '{rel.parts[0]}/' are not permitted")
        if write and rel == Path("."):
            raise PathViolation("cannot write to the workspace root itself")
        return str(resolved)

    def rewrite_args(self, tool: str, args: dict) -> dict:
        args = dict(args)
        write = tool in FS_WRITE_TOOLS
        for key in PATH_ARGS:
            if key in args:
                # copy_file only writes its destination
                args[key] = self.resolve(args[key], write=write and not (tool == "copy_file" and key == "source"))
        if "paths" in args:
            if not isinstance(args["paths"], list):
                raise PathViolation("paths must be a list")
            args["paths"] = [self.resolve(p, write=False) for p in args["paths"]]
        return args

    def relativize(self, text: str) -> str:
        return text.replace(str(self.root) + os.sep, "").replace(str(self.root), ".")


# --------------------------------------------------------------------------- manager
class MCPManager:
    """Async context manager owning the MCP sessions (and their subprocesses) for one run."""

    def __init__(self, workspace: Path, errlog: TextIO | None = None,
                 call_timeout: float = CALL_TIMEOUT, servers: dict[str, StdioServerParameters] | None = None):
        self.workspace = Path(workspace).resolve(strict=True)
        self.guard = PathGuard(self.workspace)
        self.call_timeout = call_timeout
        self._errlog = errlog
        self._servers = servers or default_servers(self.workspace)
        self._stack: AsyncExitStack | None = None
        self.sessions: dict[str, ClientSession] = {}
        self.tools: dict[str, ToolSpec] = {}

    async def __aenter__(self) -> "MCPManager":
        self._stack = AsyncExitStack()
        await self._stack.__aenter__()
        errlog = self._errlog
        if errlog is None:
            errlog = self._stack.enter_context(open(os.devnull, "w"))
        try:
            for name, params in self._servers.items():
                try:
                    # Long-lived contexts must not be entered inside a cancel scope that
                    # exits before them, so only the handshake is time-bounded.
                    read, write = await self._stack.enter_async_context(stdio_client(params, errlog=errlog))
                    session = await self._stack.enter_async_context(ClientSession(read, write))
                    with anyio.fail_after(CONNECT_TIMEOUT):
                        await session.initialize()
                        listed = await session.list_tools()
                except Exception as e:  # noqa: BLE001 - normalise any startup failure
                    raise MCPBridgeError(f"failed to connect to MCP server '{name}': {type(e).__name__}: {e}") from e
                self.sessions[name] = session
                for t in listed.tools:
                    if name == "filesystem" and t.name not in FS_TOOLS:
                        continue
                    if t.name in self.tools:
                        raise MCPBridgeError(f"duplicate tool name '{t.name}' across MCP servers")
                    self.tools[t.name] = ToolSpec(name, t.name, t.description or "", t.input_schema or {})
        except BaseException:
            await self.aclose()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        stack, self._stack = self._stack, None
        self.sessions.clear()
        if stack is not None:
            # Not wrapped in a shield scope: the stdio task groups must exit in the
            # cancel-scope context they were entered in.
            await stack.aclose()  # terminates server subprocesses

    def function_declarations(self) -> list[types.FunctionDeclaration]:
        return [to_function_declaration(s) for s in self.tools.values()]

    def gemini_tool(self) -> types.Tool:
        return types.Tool(function_declarations=self.function_declarations())

    async def call(self, name: str, args: dict | None = None) -> dict:
        """Call a tool and return a JSON-serialisable result. Never raises for tool-level problems."""
        spec = self.tools.get(name)
        if spec is None:
            return {"ok": False, "tool": name, "error": f"unknown or disallowed tool '{name}'"}
        args = dict(args or {})
        try:
            if spec.server == "filesystem":
                args = self.guard.rewrite_args(name, args)
        except PathViolation as e:
            return {"ok": False, "tool": name, "server": spec.server, "error": f"blocked: {e}"}
        session = self.sessions.get(spec.server)
        if session is None:
            return {"ok": False, "tool": name, "server": spec.server, "error": "MCP session is closed"}
        try:
            with anyio.fail_after(self.call_timeout):
                res = await session.call_tool(name, args)
        except TimeoutError:
            return {"ok": False, "tool": name, "server": spec.server,
                    "error": f"tool timed out after {self.call_timeout:.0f}s"}
        except Exception as e:  # noqa: BLE001 - protocol/transport errors become observations
            return {"ok": False, "tool": name, "server": spec.server, "error": f"{type(e).__name__}: {e}"}
        return self._format(spec, res)

    def _format(self, spec: ToolSpec, res: Any) -> dict:
        is_error = bool(getattr(res, "is_error", False))
        structured = getattr(res, "structured_content", None)
        texts = [c.text for c in (getattr(res, "content", None) or []) if getattr(c, "type", None) == "text"]
        out: dict[str, Any] = {"ok": not is_error, "tool": spec.name, "server": spec.server}
        payload = None
        if spec.server == "ops" and not is_error:
            if structured is not None:
                payload = structured.get("result", structured) if isinstance(structured, dict) else structured
            else:  # MCPServer may return a dict tool result as JSON text only
                try:
                    payload = json.loads("\n".join(texts))
                except ValueError:
                    payload = None
        if payload is not None:
            # tracebacks/log lines can contain absolute workspace paths
            out["result"] = json.loads(self.guard.relativize(json.dumps(payload, default=str)))
        else:
            text = self.guard.relativize("\n".join(texts))
            if len(text) > MAX_RESULT_CHARS:
                text = text[:MAX_RESULT_CHARS] + "\n...[truncated]"
            out["result" if not is_error else "error"] = text
        return out


def default_servers(workspace: Path) -> dict[str, StdioServerParameters]:
    node = shutil.which("node")
    if node is None or not FS_SERVER_JS.is_file():
        raise MCPBridgeError("filesystem MCP server not installed (need node and `npm install` in backend/)")
    # Minimal env: no secrets (e.g. GEMINI_API_KEY) reach MCP server processes.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(workspace), "LANG": "C.UTF-8"}
    return {
        "filesystem": StdioServerParameters(
            command=node, args=[str(FS_SERVER_JS), "--confine-roots", str(workspace)],
            cwd=str(workspace), env=env),
        "ops": StdioServerParameters(
            command=sys.executable, args=["-m", "app.ops.server", str(workspace)],
            cwd=str(BACKEND_DIR), env=env),
    }


def result_to_json(result: dict) -> str:
    return json.dumps(result, default=str)
