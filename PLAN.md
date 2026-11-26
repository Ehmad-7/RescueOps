# RescueOps — Plan

Autonomous Gemini DevOps agent: given a goal like *"Investigate why my application is broken and recover it"*, it inspects a sandboxed app, diagnoses, repairs, verifies with real checks, and reports.

## Architecture

```
Next.js dashboard (Vercel)
   │  POST /api/runs {goal, scenario}      GET /api/runs/{id}/events (SSE)
   ▼
FastAPI backend (Cloud Run)
   ├─ Agent loop (Gemini function calling, google-genai SDK)
   ├─ MCP client (python `mcp` SDK, stdio)
   │    ├─ filesystem MCP  (@modelcontextprotocol/server-filesystem, rooted at run workspace)
   │    └─ ops MCP         (own FastMCP server: health check, tests, logs, restart)
   ├─ Safety policy (allowlist, path jail, approval gate, timeouts)
   └─ Run workspaces  /tmp/rescueops/runs/<run_id>/app   (copied from a broken-app scenario)
```

- One backend container (Python + Node for the filesystem MCP server, pre-installed — no runtime `npx` download).
- In-memory run store; runs are ephemeral. No database.

## Target app & scenarios
`sandbox/demo_app/` — tiny stdlib Python HTTP service (`/health`, `/api/items`) with `config.json` and unittest tests. Each scenario is a patch that breaks it differently:
1. **bad-config** — `max_items` has wrong type in `config.json` → app refuses to start.
2. **code-bug** — `inventory.total_value` uses a wrong key → KeyError on start, tests fail.
3. **missing-file** — `data/items.json` left as `items.json.bak` → FileNotFoundError on start.
4. *(stretch)* **multi-fault** — two faults; first fix doesn't fully recover → forces replanning.

Each run copies the healthy app, applies the scenario, and gives the agent only the goal (never the scenario name).

## Agent loop
```
system prompt + goal + tool schemas (discovered from MCP list_tools)
loop (max ~20 steps, wall-clock budget):
  Gemini → text reasoning (plan/update) and/or function_call(s)
  policy.check(call) → deny | needs_approval | allow
  execute via MCP session (timeout) → real result (or error)
  emit events (thought, tool_call, tool_result, error) to SSE
  append function_response to history
  stop when model calls `finish(status, root_cause, summary, evidence)`
finish is accepted as "verified" only if the backend's own health check + tests pass
```
- Tools are not ordered by code; Gemini picks them each step from real observations.
- Failed tool calls / failed checks are returned as results, so the model must replan.
- A plan is required up front (`update_plan` tool) and revised on failure — shown in UI.
- Final verification is independent of the model's claim (prevents faked success).

## MCP integration
- **filesystem** (official): `list_directory`, `read_text_file`, `search_files`, `edit_file`, `write_file`, … rooted only at the run's workspace.
- **ops** (custom, `mcp` 2.x `MCPServer`, stdio, one process per run bound to one workspace): `get_app_status`, `start_app`, `stop_app`, `restart_app`, `read_logs`, `run_health_check`, `run_tests`. No tool takes a path or command; each runs a fixed argv in the workspace with timeout and output cap.
- Tool schemas are fetched dynamically via `list_tools` and converted to Gemini function declarations; the agent decides when to call them.

## Safety model
- No shell tool. Only allowlisted operations with fixed argv (no string interpolation into a shell).
- Path jail: filesystem MCP root = run workspace; backend re-validates paths.
- Exposed write ops limited to edit/write within workspace; filesystem `move_file`/destructive ops require approval (MVP: denied → agent must replan).
- Subprocess limits: fixed argv, cwd=workspace, own process group, rlimits (512MB memory, 10MB file size), timeouts, output truncation, env scrubbed of secrets, app binds 127.0.0.1 only.
- Residual risk: the agent can edit app code that the app/tests then execute. Contained by the above limits and the ephemeral Cloud Run container; no secrets reachable from the child env.
- Bounded iterations, per-tool timeouts, total run timeout, rate limiting of runs.
- Secrets only via env (`GEMINI_API_KEY`); `.env` git-ignored.

## Deployment
- Backend: Dockerfile → Cloud Run (`gcloud run deploy --source`), `GEMINI_API_KEY` via Secret Manager/env, CORS restricted to the Vercel origin.
- Frontend: Vercel, `NEXT_PUBLIC_API_URL` → Cloud Run URL.
- Deploy a skeleton early (by mid-build) and redeploy per milestone.

## MVP scope (must-have)
Agent loop + 2 MCP servers + 3 scenarios + independent verification + SSE dashboard + live deployment + README.
Stretch: interactive approval in UI, multi-fault scenario, run history.
