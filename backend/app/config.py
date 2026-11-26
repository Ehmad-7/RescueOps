"""Settings loaded from environment (and repo-root/backend .env files)."""
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent

# Real environment variables take precedence over .env files.
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(REPO_ROOT / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str
    gemini_model: str
    allowed_origins: tuple[str, ...]
    runs_dir: Path
    max_agent_steps: int
    max_tool_calls: int
    run_timeout_s: int

    @property
    def gemini_configured(self) -> bool:
        return bool(self.gemini_api_key)


@lru_cache
def get_settings() -> Settings:
    origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    return Settings(
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite"),
        allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        runs_dir=Path(os.getenv("RUNS_DIR", "/tmp/rescueops/runs")),
        max_agent_steps=_int("MAX_AGENT_STEPS", 20),
        max_tool_calls=_int("MAX_TOOL_CALLS", 40),
        run_timeout_s=_int("RUN_TIMEOUT_S", 300),
    )
