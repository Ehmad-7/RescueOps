import json

import pytest

from app.workspace import SCENARIOS, TEMPLATE_DIR, create_workspace, delete_workspace


def test_template_is_clean():
    assert json.loads((TEMPLATE_DIR / "config.json").read_text())["max_items"] == 50
    assert (TEMPLATE_DIR / "data" / "items.json").exists()


@pytest.mark.parametrize("scenario", list(SCENARIOS))
def test_scenario_creates_isolated_copy(tmp_path, scenario):
    before = {p.relative_to(TEMPLATE_DIR): p.read_bytes() for p in TEMPLATE_DIR.rglob("*") if p.is_file()}
    a = create_workspace(scenario, "run-a", runs_dir=tmp_path)
    b = create_workspace(scenario, "run-b", runs_dir=tmp_path)
    assert a != b and a.is_relative_to(tmp_path) and (a / "app.py").exists()
    after = {p.relative_to(TEMPLATE_DIR): p.read_bytes() for p in TEMPLATE_DIR.rglob("*") if p.is_file()}
    assert before == after  # template never mutated


def test_scenarios_actually_break_something(tmp_path):
    cfg = create_workspace("bad-config", "c", runs_dir=tmp_path)
    assert json.loads((cfg / "config.json").read_text())["max_items"] == "fifty"
    bug = create_workspace("code-bug", "b", runs_dir=tmp_path)
    assert 'item["quantity"]' in (bug / "inventory.py").read_text()
    miss = create_workspace("missing-file", "m", runs_dir=tmp_path)
    assert not (miss / "data" / "items.json").exists()


@pytest.mark.parametrize("bad", ["../x", "a/b", "", "A" * 3, "x" * 65])
def test_rejects_bad_run_ids(tmp_path, bad):
    with pytest.raises(ValueError):
        create_workspace("code-bug", bad, runs_dir=tmp_path)


def test_rejects_unknown_scenario_and_duplicate(tmp_path):
    with pytest.raises(ValueError):
        create_workspace("nope", "r", runs_dir=tmp_path)
    create_workspace("code-bug", "r", runs_dir=tmp_path)
    with pytest.raises(FileExistsError):
        create_workspace("code-bug", "r", runs_dir=tmp_path)


def test_delete_guard(tmp_path):
    app = create_workspace("code-bug", "r", runs_dir=tmp_path)
    with pytest.raises(ValueError):
        delete_workspace(tmp_path / "elsewhere" / "x" / "app", runs_dir=tmp_path / "other")
    delete_workspace(app, runs_dir=tmp_path)
    assert not (tmp_path / "r").exists()
