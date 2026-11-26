# RescueOps — TODO

## Phase 0 — Planning
- [x] Repository audit (empty repo, branch `main`, remote `origin`; Python 3.12, Node 22, Docker present; gcloud & vercel CLI missing)
- [x] Architecture and MVP scope (`PLAN.md`)
- [x] Development environment and secrets setup (`.gitignore`, `.env.example`)

## Phase 1 — Backend core
- [x] Backend scaffold (FastAPI, `/health`, `.env` config, venv, pytest)
- [x] Demo app + scenarios (`sandbox/`), workspace creation per run
- [x] Ops MCP server (health check, tests, logs, start/stop/restart, status) — `mcp` 2.x `MCPServer`, stdio
- [x] Filesystem MCP server integration (official server 2.4.0, `--confine-roots` to run workspace)
- [x] MCP client manager → Gemini function declarations (`app/mcp_bridge.py`: discovery, schema conversion, calls, timeouts, cleanup, path jail)
- [x] Gemini integration (google-genai 3.6.1, manual function calling, SDK retries off; default `gemini-3.1-flash-lite`)
- [x] Autonomous agent loop (`app/agent.py`: `update_plan`/`finish` control tools, step/tool/time budgets)
- [x] Action safety in loop (step/tool/per-turn/time budgets, bounded observations, malformed calls → errors); path jail + allowlist in bridge
- [ ] (stretch) Interactive approval gate for destructive actions
- [x] Failure handling and replanning (tool errors, verification failures and Gemini errors handled; transient retry)
- [x] Independent verification on finish (restart + health + tests; failure returns control, max 3 attempts)
- [x] Event interface (`app/events.py` `EventLog` with replay + subscribe)
- [x] Run API + SSE (`POST /runs`, `GET /runs/{id}`, `GET /runs/{id}/events`, `POST /runs/{id}/cancel`, `GET /scenarios`; replay, Last-Event-ID, heartbeats, concurrency limit)

## Phase 2 — Deploy early
- [ ] Dockerfile (Python + Node ≥24, `npm ci` in backend/, MCP servers preinstalled, init process for zombie reaping e.g. `tini`)
- [ ] Cloud Run deployment (needs gcloud CLI + project)
- [ ] Smoke test live backend

## Phase 3 — Frontend
- [ ] Next.js + TS + Tailwind scaffold
- [ ] Dashboard: goal input, scenario picker, plan panel, live tool calls/log, verified result
- [ ] Frontend-backend integration (SSE)
- [ ] Vercel deployment

## Phase 4 — Quality
- [x] Agent-loop tests with a scripted model over real MCP servers (`tests/test_agent.py`)
- [x] Live Gemini runs: all 3 scenarios verified with `gemini-3.1-flash-lite` (2026-11-26)
- [ ] Re-check larger models (`gemini-3.8-flash` returned 503/504 on 2026-11-26)
- [ ] README and setup instructions
- [ ] Demo scenario and recording checklist
- [ ] Final GitHub cleanup and verification

## Blockers / notes
- gcloud CLI not installed; GCP project + billing needed for Cloud Run.
- Vercel CLI not installed (use `npx vercel` or GitHub integration).
- Filesystem MCP server requires Node ≥24 (works on local Node 22 with an engine warning; use Node 24 in Docker).
