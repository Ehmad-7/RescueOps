# RescueOps — Frontend

Dashboard for the RescueOps recovery agent: launch a recovery run, follow the agent's live
activity (plan, tool calls, verification), and see the authoritative run summary. Built with
Next.js (App Router), TypeScript and Tailwind CSS.

- **Live timeline:** native `EventSource` on `GET /runs/{id}/events`. Reconnects resume from the
  last event (`Last-Event-ID`, or `?after=` after a hard failure), events are deduplicated by
  `seq`, and the stream is closed after the terminal event.
- **Run summary:** `GET /runs/{id}` stays the source of truth for status and result. It is polled
  while the run is active (slower while the live stream is open) and refreshed on the terminal event.

## Requirements

- Node.js 20.9 or newer
- A running RescueOps backend. From the repository root:

  ```bash
  cd backend
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  npm install                                   # official filesystem MCP server
  .venv/bin/uvicorn app.main:app --port 8000    # reads GEMINI_API_KEY etc. from ../.env
  ```

  The backend's `ALLOWED_ORIGINS` must include the frontend origin
  (default: `http://localhost:3000`).

## Setup

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev        # http://localhost:3000
```

## Environment

| Variable              | Required | Description                                               |
| --------------------- | -------- | --------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | yes      | Backend base URL without trailing slash, e.g. `http://localhost:8000` |

`NEXT_PUBLIC_*` variables are inlined into the browser bundle at build time: set it before
`npm run build` (and in the Vercel project settings), and never put secrets in it. The Gemini
API key stays on the backend.

## Scripts

| Command         | Purpose                                      |
| --------------- | -------------------------------------------- |
| `npm run dev`   | Development server                           |
| `npm run lint`  | ESLint                                       |
| `npm test`      | Unit tests (event parsing, dedup, reconnect) via `node --test` |
| `npm run build` | Production build, including type checking    |
| `npm start`     | Serve the production build                   |

## Backend endpoints used

| Method | Path                | Use                                  |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/health`           | Backend/Gemini status indicator      |
| GET    | `/scenarios`        | Failure scenario options             |
| POST   | `/runs`             | Start a run (`{ goal, scenario }`)   |
| GET    | `/runs/{id}`        | Run summary (polled while active)    |
| GET    | `/runs/{id}/events` | Live event stream (SSE)              |
| POST   | `/runs/{id}/cancel` | Cancel an active run                 |
