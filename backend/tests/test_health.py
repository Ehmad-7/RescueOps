from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

client = TestClient(app)


def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert isinstance(body["gemini_configured"], bool)


def test_health_does_not_leak_key():
    key = get_settings().gemini_api_key
    if key:
        assert key not in client.get("/health").text


def test_settings_env_override(monkeypatch):
    monkeypatch.setenv("MAX_AGENT_STEPS", "not-a-number")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://a.app, https://b.app")
    get_settings.cache_clear()
    try:
        s = get_settings()
        assert s.max_agent_steps == 20
        assert s.allowed_origins == ("https://a.app", "https://b.app")
    finally:
        get_settings.cache_clear()
