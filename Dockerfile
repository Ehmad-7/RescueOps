# RescueOps backend image for Google Cloud Run.
# Build from the repository root (the backend needs sandbox/demo_app next to it):
#   docker build -t rescueops-backend .
# Secrets (GEMINI_API_KEY) are supplied at runtime only; nothing secret is copied into the image.

# --- Node MCP servers (filesystem server requires Node >= 24) ---------------------------------
FROM node:24-slim AS node-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Runtime ------------------------------------------------------------------------------------
FROM python:3.12-slim

# tini as PID 1: forwards signals and reaps orphaned MCP/app/test child processes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Node runtime only (the MCP server needs `node`, not npm).
COPY --from=node-deps /usr/local/bin/node /usr/local/bin/node

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    RUNS_DIR=/tmp/rescueops/runs \
    PORT=8080

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

# Repository layout is preserved: /app/backend and /app/sandbox/demo_app (template + trusted tests).
COPY backend/app ./app
COPY --from=node-deps /app/backend/node_modules ./node_modules
COPY backend/package.json ./
COPY sandbox/demo_app /app/sandbox/demo_app

# Non-root. Code and template stay root-owned (read-only to the service); per-run workspaces are
# created under RUNS_DIR in /tmp, which is writable.
RUN useradd --system --uid 10001 --no-create-home --home-dir /tmp rescueops
USER rescueops

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
# exec: uvicorn replaces the shell, so tini signals it directly. Cloud Run sets $PORT.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8080}\""]
