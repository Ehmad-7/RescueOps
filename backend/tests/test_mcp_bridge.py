import os
import sys

import anyio
import pytest
from google.genai import types
from mcp.client.stdio import StdioServerParameters

from app.mcp_bridge import (FS_TOOLS, MCPBridgeError, MCPManager, PathGuard, PathViolation, ToolSpec,
                            json_schema_to_gemini, to_function_declaration)
from app.workspace import create_workspace

OPS_TOOLS = {"get_app_status", "start_app", "stop_app", "restart_app", "read_logs", "run_health_check", "run_tests"}


@pytest.fixture
def ws(tmp_path):
    return create_workspace("code-bug", "bridge", runs_dir=tmp_path / "runs")


def run(coro_fn, *a):
    return anyio.run(coro_fn, *a)


# ----------------------------------------------------------------- schema conversion (pure)
def test_schema_conversion_preserves_structure():
    schema = {
        "type": "object", "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": False,
        "properties": {
            "path": {"type": "string", "description": "file"},
            "edits": {"type": "array", "minItems": 1, "items": {"type": "object", "properties": {
                "oldText": {"type": "string"}, "newText": {"type": "string"}}, "required": ["oldText", "newText"]}},
            "depth": {"type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991},
            "mode": {"type": "string", "enum": ["a", "b"]},
            "maybe": {"type": ["string", "null"]},
            "opt": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": None},
            "ref": {"$ref": "#/$defs/Thing"},
        },
        "required": ["path", "edits"],
        "$defs": {"Thing": {"type": "boolean", "description": "a thing"}},
    }
    s = json_schema_to_gemini(schema)
    assert s.type == types.Type.OBJECT and s.required == ["path", "edits"]
    assert s.properties["path"].description == "file"
    edits = s.properties["edits"]
    assert edits.type == types.Type.ARRAY and edits.min_items == 1
    assert edits.items.properties["oldText"].type == types.Type.STRING
    assert s.properties["depth"].minimum == 0 and s.properties["depth"].maximum is None
    assert s.properties["mode"].enum == ["a", "b"]
    assert s.properties["maybe"].nullable and s.properties["maybe"].type == types.Type.STRING
    assert s.properties["opt"].nullable and s.properties["opt"].type == types.Type.INTEGER
    assert s.properties["ref"].type == types.Type.BOOLEAN and s.properties["ref"].description == "a thing"
    dumped = s.model_dump(exclude_none=True)
    assert "additional_properties" not in dumped


def test_function_declaration_without_params():
    fd = to_function_declaration(ToolSpec("ops", "run_tests", "Run tests", {"type": "object", "properties": {}}))
    assert fd.name == "run_tests" and fd.description == "Run tests" and fd.parameters is None


def test_schema_rejects_unknown_type():
    with pytest.raises(ValueError):
        json_schema_to_gemini({"type": "tuple"})


# ----------------------------------------------------------------- path guard (pure)
def test_path_guard(ws, tmp_path):
    g = PathGuard(ws)
    assert g.resolve("config.json", write=True) == str(ws / "config.json")
    assert g.resolve(str(ws / "data"), write=False) == str(ws / "data")
    for bad in ("../x", "/etc/passwd", "data/../../x", "", "a\x00b"):
        with pytest.raises(PathViolation):
            g.resolve(bad, write=False)
    with pytest.raises(PathViolation):
        g.resolve("tests/test_app.py", write=True)
    assert g.resolve("tests/test_app.py", write=False)  # reading tests is fine
    (tmp_path / "secret").write_text("x")
    os.symlink(tmp_path / "secret", ws / "link")
    with pytest.raises(PathViolation):
        g.resolve("link", write=False)
    args = g.rewrite_args("copy_file", {"source": "tests/test_app.py", "destination": "data/x.py"})
    assert args["source"].startswith(str(ws)) and args["destination"].startswith(str(ws))
    with pytest.raises(PathViolation):
        g.rewrite_args("read_multiple_files", {"paths": ["config.json", "../../etc/hosts"]})
    assert g.relativize(f"error in {ws}/app.py") == "error in app.py"


# ----------------------------------------------------------------- real MCP servers
def test_discovery_and_declarations(ws):
    async def main():
        async with MCPManager(ws) as m:
            names = set(m.tools)
            assert OPS_TOOLS <= names and names - OPS_TOOLS == FS_TOOLS
            assert "move_file" not in names and "list_allowed_directories" not in names
            assert {m.tools[n].server for n in FS_TOOLS} == {"filesystem"}
            decls = {d.name: d for d in m.function_declarations()}
            assert set(decls) == names
            edit = decls["edit_file"]
            assert edit.description and "edits" in edit.parameters.properties
            assert edit.parameters.properties["edits"].items.properties["newText"].type == types.Type.STRING
            assert isinstance(m.gemini_tool(), types.Tool)
    run(main)


def test_real_calls_diagnose_and_repair(ws):
    async def main():
        async with MCPManager(ws) as m:
            listing = await m.call("list_directory", {"path": "."})
            assert listing["ok"] and "inventory.py" in listing["result"] and str(ws) not in listing["result"]
            assert (await m.call("start_app"))["result"]["ok"] is False
            logs = await m.call("read_logs", {"lines": 30})
            assert "KeyError" in logs["result"]["log"] and str(ws) not in logs["result"]["log"]
            src = await m.call("read_text_file", {"path": "inventory.py"})
            assert 'item["quantity"]' in src["result"]
            edit = await m.call("edit_file", {"path": "inventory.py", "edits": [
                {"oldText": 'item["quantity"]', "newText": 'item["qty"]'}]})
            assert edit["ok"], edit
            assert (await m.call("restart_app"))["result"]["ok"] is True
            assert (await m.call("run_health_check"))["result"]["healthy"] is True
            assert (await m.call("run_tests"))["result"]["passed"] is True
            await m.call("stop_app")
    run(main)
    assert 'item["qty"]' in (ws / "inventory.py").read_text()  # real file change


def test_errors_and_restrictions(ws, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")

    async def main():
        async with MCPManager(ws) as m:
            r = await m.call("read_text_file", {"path": str(outside)})
            assert not r["ok"] and "blocked" in r["error"]
            r = await m.call("write_file", {"path": "tests/test_app.py", "content": "pass"})
            assert not r["ok"] and "not permitted" in r["error"]
            r = await m.call("move_file", {"source": "app.py", "destination": "x.py"})
            assert not r["ok"] and "disallowed" in r["error"]
            r = await m.call("read_text_file", {"path": "does_not_exist.txt"})  # real server-side error
            assert not r["ok"] and r["server"] == "filesystem" and r["error"]
            r = await m.call("edit_file", {"path": "app.py", "edits": [{"oldText": "NOPE_NOT_THERE", "newText": "x"}]})
            assert not r["ok"]
    run(main)
    assert outside.read_text() == "secret"
    assert "pass" != (ws / "tests" / "test_app.py").read_text()


def test_timeout_is_reported(ws):
    async def main():
        async with MCPManager(ws, call_timeout=0.01) as m:
            r = await m.call("run_tests")
            assert not r["ok"] and "timed out" in r["error"]
    run(main)


def test_connection_failure_cleans_up(ws):
    servers = {"ops": StdioServerParameters(command=sys.executable, args=["-m", "app.ops.server", str(ws)]),
               "broken": StdioServerParameters(command=sys.executable, args=["-c", "import sys; sys.exit(3)"])}

    async def main():
        m = MCPManager(ws, servers=servers)
        with pytest.raises(MCPBridgeError, match="broken"):
            await m.__aenter__()
        assert m.sessions == {}
        r = await m.call("run_tests")
        assert not r["ok"]
    run(main)


def test_secrets_not_passed_to_servers(ws, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "leak-me")
    from app.mcp_bridge import default_servers
    for p in default_servers(ws).values():
        assert "GEMINI_API_KEY" not in (p.env or {})
