# RescueOps — TODO

## Phase 0 — Planning
- [x] Repository audit (empty repo, branch `main`, remote `origin`; Python 3.12, Node 22, Docker present; gcloud & vercel CLI missing)
- [x] Architecture and MVP scope (`PLAN.md`)
- [x] Development environment and secrets setup (`.gitignore`, `.env.example`)

## Phase 1 — Backend core
- [x] Backend scaffold (FastAPI, `/health`, `.env` config, venv, pytest)
- [x] Demo app + scenarios (`sandbox/`), workspace creation per run
- [x] Ops MCP server (health check, tests, logs, start/stop/restart, status) — `mcp` 2.x `MCPServer`, stdio
- [ ] Filesystem MCP server integration (rooted at run workspace)
- [ ] MCP client manager → Gemini function declarations
- [ ] Gemini integration (google-genai, function calling)
- [ ] Autonomous agent loop (plan tool, bounded steps, finish tool)
- [ ] Controlled workspace and action safety (policy, path jail, timeouts)
- [ ] Failure handling and replanning (errors as observations)
- [ ] Independent verification on finish
- [ ] Run API + SSE event stream

## Phase 2 — Deploy early
- [ ] Dockerfile (Python + Node, MCP servers preinstalled)
- [ ] Cloud Run deployment (needs gcloud CLI + project) 
- [ ] Smoke test live backend

## Phase 3 — Frontend
- [ ] Next.js + TS + Tailwind scaffold
- [ ] Dashboard: goal input, scenario picker, plan panel, live tool calls/log, verified result
- [ ] Frontend-backend integration (SSE)
- [ ] Vercel deployment

## Phase 4 — Quality
- [ ] Automated tests (policy, workspace, ops tools, scenarios break/fix, loop with fake model)
- [ ] Realistic end-to-end runs per scenario with Gemini
- [ ] README and setup instructions
- [ ] Demo scenario and recording checklist
- [ ] Final GitHub cleanup and verification

## Blockers / notes
- gcloud CLI not installed; GCP project + billing needed for Cloud Run.
- Vercel CLI not installed (use `npx vercel` or GitHub integration).
- `GEMINI_API_KEY` needed in `.env`.
