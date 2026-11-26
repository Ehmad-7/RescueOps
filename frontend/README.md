# RescueOps — Frontend

Dashboard for the RescueOps recovery agent: launch a recovery run, then follow its status,
plan, diagnosis and independent verification result. Built with Next.js (App Router),
TypeScript and Tailwind CSS.

The run summary refreshes by polling `GET /runs/{id}` while a run is active.

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
| `npm run build` | Production build, including type checking    |
| `npm start`     | Serve the production build                   |

## Backend endpoints used

| Method | Path                | Use                                  |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/health`           | Backend/Gemini status indicator      |
| GET    | `/scenarios`        | Failure scenario options             |
| POST   | `/runs`             | Start a run (`{ goal, scenario }`)   |
| GET    | `/runs/{id}`        | Run summary (polled while active)    |
| POST   | `/runs/{id}/cancel` | Cancel an active run                 |
