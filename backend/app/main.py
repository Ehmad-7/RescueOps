from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings

settings = get_settings()

app = FastAPI(title="RescueOps", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    # Never return secret values, only whether they are configured.
    return {
        "status": "ok",
        "version": app.version,
        "gemini_configured": settings.gemini_configured,
        "model": settings.gemini_model,
    }
