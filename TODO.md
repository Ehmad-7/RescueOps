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
- [ ] Gemini integration (google-genai 3.6.1 installed; function-calling loop pending)
- [ ] Autonomous agent loop (plan tool, bounded steps, finish tool)
- [ ] Action safety policy in agent loop (approval gate, step/run budgets) — path jail, tool allowlist, timeouts done in bridge
- [ ] Failure handling and replanning (errors as observations)
- [ ] Independent verification on finish
- [ ] Run API + SSE event stream

## Phase 2 — Deploy early
- [ ] Dockerfile (Python + Node ≥24, `npm ci` in backend/, MCP servers preinstalled)
- [ ] Cloud Run deployment (needs gcloud CLI + project)
- [ ] Smoke test live backend

## Phase 3 — Frontend
- [ ] Next.js + TS + Tailwind scaffold
- [ ] Dashboard: goal input, scenario picker, plan panel, live tool calls/log, verified result
- [ ] Frontend-backend integration (SSE)
- [ ] Vercel deployment

## Phase 4 — Quality
- [ ] Agent-loop tests with a scripted model (workspace/ops/bridge tests already exist)
- [ ] Realistic end-to-end runs per scenario with Gemini
- [ ] README and setup instructions
- [ ] Demo scenario and recording checklist
- [ ] Final GitHub cleanup and verification

## Blockers / notes
- gcloud CLI not installed; GCP project + billing needed for Cloud Run.
- Vercel CLI not installed (use `npx vercel` or GitHub integration).
- Filesystem MCP server requires Node ≥24 (works on local Node 22 with an engine warning; use Node 24 in Docker).
