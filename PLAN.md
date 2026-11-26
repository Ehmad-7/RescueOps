# RescueOps — Plan

Autonomous Gemini DevOps agent: given a goal like *"Investigate why my application is broken and recover it"*, it inspects a sandboxed app, diagnoses, repairs, verifies with real checks, and reports.

## Architecture

```
Next.js dashboard (Vercel)
   │  POST /runs {goal, scenario}   GET /runs/{id}   GET /runs/{id}/events (SSE)   POST /runs/{id}/cancel
   ▼
FastAPI backend (Cloud Run)
   ├─ Agent loop (Gemini function calling, google-genai SDK)
   ├─ MCP client (python `mcp` SDK, stdio)
   │    ├─ filesystem MCP  (@modelcontextprotocol/server-filesystem, rooted at run workspace)
   │    └─ ops MCP         (own `MCPServer`: status, start/stop/restart, logs, health, tests)
   ├─ Safety policy (allowlist, path jail, approval gate, timeouts)
   └─ Run workspaces  /tmp/rescueops/runs/<run_id>/app   (copied from a broken-app scenario)
```

- One backend container (Python + Node for the filesystem MCP server, pre-installed — no runtime `npx` download).
- In-memory run store (`app/runs.py` `RunManager`); runs are ephemeral, no database. Each run is an asyncio task:
  workspace → MCP servers → agent → cleanup (workspace deleted, servers and app stopped).
  Status: `queued → running → verified | unverified | failed | cancelled`. Max `MAX_CONCURRENT_RUNS` active (429 beyond), 100 stored.
- SSE: `id: <seq>`, `event: <type>`, `data: <json>`; replay from `Last-Event-ID` header or `?after=`; `: keep-alive` every 15s; stream closes after the terminal event.
- Cloud Run note: in-memory state requires a single instance (`--max-instances 1`) and request-based CPU kept alive by the open SSE stream; acceptable for the demo.

## Target app & scenarios
`sandbox/demo_app/` — tiny stdlib Python HTTP service (`/health`, `/api/items`) with `config.json` and unittest tests. Each scenario is a patch that breaks it differently:
1. **bad-config** — `max_items` has wrong type in `config.json` → app refuses to start.
2. **code-bug** — `inventory.total_value` uses a wrong key → KeyError on start, tests fail.
3. **missing-file** — `data/items.json` left as `items.json.bak` → FileNotFoundError on start.
4. *(stretch)* **multi-fault** — two faults; first fix doesn't fully recover → forces replanning.

Each run copies the healthy app, applies the scenario, and gives the agent only the goal (never the scenario name).

## Agent loop (`app/agent.py`)
```
contents = [goal]; tools = MCP-discovered declarations + control tools (update_plan, finish)
loop while steps < MAX_AGENT_STEPS (and within RUN_TIMEOUT_S):
  Gemini generate (manual function calling; transient 429/5xx retried with backoff)
  append model content verbatim (keeps thought signatures); emit short non-thought text as status
  for each function call (≤6 per turn, ≤MAX_TOOL_CALLS total):
    update_plan → validate + store + emit plan_updated
    finish      → independent verification (restart_app + run_health_check + run_tests)
                  pass → run verified; fail → results returned to model, it continues (max 3 attempts)
    MCP tool    → bridge call (path jail, allowlist, timeout) → real result/error, bounded size
  send all function responses back; no tool call → nudge (max 2 idle turns)
finally: stop_app; emit run_completed | run_failed
```
- No scenario-specific logic: the prompt is generic and Gemini picks every tool from observations.
- Verification is backend-driven and independent of the model's claim.
- Statuses: `verified` (verification passed), `unverified` (finish claimed but checks failed 3×), `failed` (limits, API errors, agent gave up).
- Events (`app/events.py`): `run_started`, `plan_updated`, `agent_status`, `tool_started`, `tool_completed`, `tool_failed`, `verification_started`, `verification_completed`, `run_completed`, `run_failed`. Thought parts are never emitted. `EventLog.subscribe()` replays then streams, ready for SSE.

## MCP integration
- **filesystem** (official `@modelcontextprotocol/server-filesystem` 2.4.0, installed via `backend/package.json`, started with `--confine-roots <workspace>`). Exposed subset: `read_text_file`, `read_multiple_files`, `list_directory`, `directory_tree`, `search_files`, `get_file_info`, `write_file`, `edit_file`, `create_directory`, `copy_file`. Not exposed: `move_file` (destructive), `read_media_file`, `read_file`, `append_file`, `list_directory_with_sizes`, `list_allowed_directories`.
- **ops** (custom, `mcp` 2.x `MCPServer`, stdio, one process per run bound to one workspace): `get_app_status`, `start_app`, `stop_app`, `restart_app`, `read_logs`, `run_health_check`, `run_tests`. No tool takes a path or command; each runs a fixed argv in the workspace with timeout and output cap.
- `app/mcp_bridge.py` `MCPManager`: starts both servers per run, discovers tools via `list_tools`, converts JSON Schemas to Gemini `types.Schema` function declarations, routes calls, enforces timeouts, and returns real results/errors as JSON observations. Agent uses workspace-relative paths; absolute paths in results are mapped back.

## Safety model
- No shell tool; only allowlisted MCP tools. Ops tools take no paths/commands and run fixed argv.
- Path jail (two layers): filesystem server allowed dir = workspace, and the bridge re-validates every path arg (rejects `..`, outside absolute paths, symlink escapes, NUL bytes).
- Integrity: writes to `tests/` and `logs/` are blocked, so the agent cannot "fix" a failure by editing the checks. Destructive tools (`move_file`) are not exposed.
- MCP server processes get a minimal env (no `GEMINI_API_KEY`).
- App/test subprocess limits: fixed argv, cwd=workspace, same process group as the ops server (SDK group-kills it on shutdown; `stop_app` signals only the app PID), plus a post-teardown sweep of any process whose cwd is inside the workspace (covers a crashed/SIGKILLed ops server), rlimits (512MB memory, 10MB file size), timeouts, output truncation, env scrubbed of secrets, app binds 127.0.0.1 only.
- Residual risk: the agent can edit app code that the app/tests then execute. Contained by the above limits and the ephemeral Cloud Run container; no secrets reachable from the child env.
- Bounded iterations, tool-call budget, per-turn call cap, per-tool and per-model-call timeouts, total run timeout, bounded observation sizes; rate limiting of runs (API milestone).
- Secrets only via env (`GEMINI_API_KEY`); `.env` git-ignored.

## Deployment
- Backend: Dockerfile (Python 3.12 + Node 24, `pip install`, `npm ci`) → Cloud Run (`gcloud run deploy --source`), `GEMINI_API_KEY` via Secret Manager/env, CORS restricted to the Vercel origin.
- Frontend: Vercel, `NEXT_PUBLIC_API_URL` → Cloud Run URL.
- Deploy a skeleton early (by mid-build) and redeploy per milestone.

## MVP scope (must-have)
Agent loop + 2 MCP servers + 3 scenarios + independent verification + SSE dashboard + live deployment + README.
Stretch: interactive approval in UI, multi-fault scenario, run history.
