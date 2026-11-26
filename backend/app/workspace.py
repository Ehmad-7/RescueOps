"""Per-run isolated workspaces created from the clean demo template + a failure scenario."""
import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Callable

from app.config import REPO_ROOT, get_settings

TEMPLATE_DIR = REPO_ROOT / "sandbox" / "demo_app"
_RUN_ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")


def _bad_config(app: Path) -> None:
    cfg_path = app / "config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["max_items"] = "fifty"  # wrong type -> app refuses to start
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")


def _code_bug(app: Path) -> None:
    mod = app / "inventory.py"
    src = mod.read_text()
    broken = src.replace('item["qty"] * item["price"]', 'item["quantity"] * item["price"]')
    assert broken != src, "template changed; code-bug scenario no longer applies"
    mod.write_text(broken)


def _missing_file(app: Path) -> None:
    # Simulates a bad deploy that left the data file under the wrong name.
    (app / "data" / "items.json").rename(app / "data" / "items.json.bak")


SCENARIOS: dict[str, tuple[str, Callable[[Path], None]]] = {
    "bad-config": ("Invalid value type in config.json", _bad_config),
    "code-bug": ("KeyError in inventory.total_value", _code_bug),
    "missing-file": ("Required data file missing", _missing_file),
}


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


def create_workspace(scenario: str, run_id: str | None = None, runs_dir: Path | None = None) -> Path:
    """Copy the template into <runs_dir>/<run_id>/app and apply the scenario. Returns the app dir."""
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario: {scenario}")
    run_id = new_run_id() if run_id is None else run_id
    if not _RUN_ID_RE.match(run_id):
        raise ValueError("invalid run id")
    base = (runs_dir or get_settings().runs_dir).resolve()
    app_dir = base / run_id / "app"
    if app_dir.exists():
        raise FileExistsError(f"workspace already exists: {run_id}")
    shutil.copytree(TEMPLATE_DIR, app_dir, symlinks=False,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "logs"))
    SCENARIOS[scenario][1](app_dir)
    return app_dir


def delete_workspace(app_dir: Path, runs_dir: Path | None = None) -> None:
    base = (runs_dir or get_settings().runs_dir).resolve()
    run_dir = app_dir.resolve().parent
    if run_dir.parent != base:
        raise ValueError("refusing to delete outside runs dir")
    shutil.rmtree(run_dir)
