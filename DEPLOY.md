# Deploying the RescueOps backend

The backend image contains Python 3.12, Node 24 (for the filesystem MCP server), the FastAPI app,
and `sandbox/demo_app` (the demo template and its trusted tests). `tini` runs as PID 1 and the
service runs as a non-root user. Per-run workspaces are created under `RUNS_DIR`
(`/tmp/rescueops/runs`, writable).

**No secrets are in the image.** `GEMINI_API_KEY` is supplied at runtime only.

## Build

From the repository root (the build needs both `backend/` and `sandbox/`):

```bash
docker build -t rescueops-backend .
```

## Run locally

```bash
# Reads GEMINI_API_KEY from your shell; never put the key on the command line or in the image.
docker run --rm -p 8080:8080 \
  -e GEMINI_API_KEY \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  rescueops-backend

curl http://localhost:8080/health
```

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | none | Runtime secret (Secret Manager on Cloud Run). |
| `ALLOWED_ORIGINS` | yes, for the deployed frontend | `http://localhost:3000` | Comma-separated exact origins, such as `https://rescueops.vercel.app`. |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-lite` | |
| `PORT` | no | `8080` | Set automatically by Cloud Run. |
| `RUNS_DIR` | no | `/tmp/rescueops/runs` | Must be writable. |
| `MAX_AGENT_STEPS` / `MAX_TOOL_CALLS` / `RUN_TIMEOUT_S` / `MAX_CONCURRENT_RUNS` | no | `20` / `40` / `300` / `2` | |

The frontend (Vercel) only needs `NEXT_PUBLIC_API_URL=<Cloud Run service URL>`.

## Cloud Run

Runs and their event logs live **in memory** in a single instance, and the agent keeps working after
`POST /runs` returns. That is why these settings are required:

```bash
PROJECT=<your-project> REGION=<region>
gcloud builds submit --tag "$REGION-docker.pkg.dev/$PROJECT/rescueops/backend" .   # or docker push
printf %s "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-       # once

gcloud run deploy rescueops-backend \
  --image "$REGION-docker.pkg.dev/$PROJECT/rescueops/backend" \
  --region "$REGION" --allow-unauthenticated \
  --max-instances 1 --min-instances 0 \
  --no-cpu-throttling \
  --memory 1Gi --cpu 1 \
  --timeout 900 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars ALLOWED_ORIGINS=https://<your-frontend-origin>
```

- `--max-instances 1`: status and SSE requests must reach the instance that holds the run.
- `--no-cpu-throttling`: the agent runs in the background between requests.
- `--timeout 900`: SSE streams stay open for the whole run (up to 300 s, plus verification).
- `--memory 1Gi`: `/tmp` is in memory, and each run starts Node, Python and app processes.

Runs are lost when the instance restarts or scales to zero. The service has no authentication or
rate limiting; `MAX_CONCURRENT_RUNS` is the only cap on Gemini usage.
