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


def test_blind_incident_corrupts_only_one_field_in_the_copy(tmp_path):
    tpl = TEMPLATE_DIR / "data" / "items.json"
    tpl_bytes, tpl_mtime = tpl.read_bytes(), tpl.stat().st_mtime_ns
    ws = create_workspace("blind-incident", "blind", runs_dir=tmp_path)
    data = ws / "data" / "items.json"
    items, clean = json.loads(data.read_text()), json.loads(tpl_bytes)
    assert items[1]["sku"] == "B-200" and items[1]["qty"] == "3"  # string, not int
    clean[1]["qty"] = "3"
    assert items == clean  # nothing else changed
    # same formatting (only the two quote characters added) and the template's mtime
    assert data.read_text() == tpl_bytes.decode().replace('"qty": 3,', '"qty": "3",')
    assert data.stat().st_mtime_ns == tpl_mtime
    assert tpl.read_bytes() == tpl_bytes and tpl.stat().st_mtime_ns == tpl_mtime  # template untouched


def test_blind_incident_leaves_no_trace_of_the_scenario_in_the_workspace(tmp_path):
    ws = create_workspace("blind-incident", "blind", runs_dir=tmp_path)
    names = {p.relative_to(ws) for p in ws.rglob("*")}
    assert names == {p.relative_to(TEMPLATE_DIR) for p in TEMPLATE_DIR.rglob("*")
                     if "__pycache__" not in p.parts and p.suffix != ".pyc" and "logs" not in p.parts}
    desc = SCENARIOS["blind-incident"][0]
    for p in ws.rglob("*"):
        if p.is_file():
            text = p.read_text(errors="ignore").lower()
            assert "blind" not in text and desc.lower() not in text


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
