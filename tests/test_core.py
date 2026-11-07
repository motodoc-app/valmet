"""Core guarantees of the pipeline (run: `pytest -q` from the repo root, no network needed)."""
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("XRAY_USE_LLM", "0")   # deterministic template mode for tests

from xray import config  # noqa: E402

config.USE_LLM = False
from xray.world import World  # noqa: E402


@pytest.fixture(scope="module")
def world():
    return World()


def test_integrity_report_is_consistent():
    rep = json.loads((config.DATA_OUT / "integrity_report.json").read_text())
    assert rep["size_matches_header"] is True
    assert rep["first_implausible_record"] == rep["contiguous_valid_records"]
    if rep["contiguous_valid_records"] < rep["declared_vertex_count"]:
        assert rep["tail_plausible_fraction"] < 0.05      # a corrupt tail is noise, never used as data
    else:
        assert rep["contiguous_valid_fraction"] == 1.0


def test_objects_are_framed_and_labelled(world):
    objs = [o for o in world.scene["objects"] if o["kind"] == "object"]
    assert len(objs) >= 100
    for o in objs:
        assert len(o["center"]) == 3 and all(s > 0 for s in o["size"])
        assert 0 <= o["confidence"] <= 1
        assert o["label_source"] in {"geometry-heuristic", "vlm+geometry", "human-verified"}


def test_mapping_is_one_to_one_and_target_reachable(world):
    b = world.mapping["bindings"]
    objs = [v["object_id"] for v in b.values()]
    assert len(objs) == len(set(objs))
    tgt = b[world.mapping["target_asset_id"]]
    assert tgt["object_id"] in world.reachable


def test_route_is_collision_free(world):
    tid = world.mapping["bindings"][world.mapping["target_asset_id"]]["object_id"]
    r = world.plan(world.start_xz, tid)
    assert r["ok"] and r["validation"]["collision_free"]
    assert r["validation"]["min_clearance_m"] >= config.ROBOT_RADIUS - 1e-6


def test_reroute_around_blocked_walkway(world):
    tid = world.mapping["bindings"][world.mapping["target_asset_id"]]["object_id"]
    r = world.plan(world.start_xz, tid)
    wp = r["waypoints"]
    mid = wp[len(wp) // 2]
    r2 = world.plan(world.start_xz, tid, [{"x": mid[0], "z": mid[2], "w": 0.6, "d": 0.6}])
    if r2["ok"]:
        assert r2["validation"]["collision_free"]
        assert r2["waypoints"] != wp
    else:
        assert "blocked" in r2["reason"]
    world.plan(world.start_xz, tid, [])   # reset


def test_citation_checker_strips_unknown_ids(world):
    cp = world.copilot
    text, bad = cp._check_citations("Seen in [EVT-99999] and [DOC-FIELD-SAFETY].", {"DOC-FIELD-SAFETY"})
    assert "EVT-99999" not in text and "DOC-FIELD-SAFETY" in text and bad == ["EVT-99999"]


def test_diagnosis_is_grounded(world):
    aid = world.mapping["target_asset_id"]
    d = world.copilot.diagnose(aid)
    allowed = world.copilot.valid_ids(d)
    assert d["narrative"]["mode"] == "template"
    import re
    for ids in re.findall(r"\[([^\[\]]+)\]", d["narrative"]["text"]):
        for i in ids.split(","):
            assert i.strip() in allowed
    assert any(s["source"] == "DOC-FIELD-SAFETY" for s in d["next_steps"])
    assert 0 < d["confidence"]["overall"] < 1


def test_every_workbook_class_has_a_complete_device_model(world):
    """Same features for any device: each asset class in the workbook has an exploded model, knowledge,
    lessons and a practice scenario whose references all resolve."""
    from xray.copilot import LIBRARY
    classes = {a["asset_class"] for a in world.pack.assets.to_dict("records")}
    assert classes <= set(LIBRARY["classes"]), classes - set(LIBRARY["classes"])
    for cls, d in LIBRARY["classes"].items():
        ids = {c["id"] for c in d["components"]}
        assert len(ids) == len(d["components"]) >= 5
        for c in d["components"]:
            assert c["shape"] and len(c["pos"]) == 3 and len(c["explode"]) == 3 and c["function"]
        refs = [f for t in d["learn_topics"] for s in t["steps"] for f in s["focus"]]
        for sc in d["practice_scenarios"]:
            for t in sc["tasks"]:
                refs += (t["answer"] if isinstance(t.get("answer"), list) else []) + t.get("order", [])
        refs += [c for hs in d["hypotheses"].values() for h in hs for c in h[1]]
        assert set(refs) <= ids, (cls, set(refs) - ids)
        assert d["learn_topics"] and d["practice_scenarios"]


def test_diagnosis_links_to_components_for_every_faulty_asset(world):
    from xray.copilot import LIBRARY
    for a in world.pack.assets.to_dict("records"):
        if a["issue_code"] == "NORMAL":
            continue
        d = world.copilot.evidence(a["asset_id"])
        ids = {c["id"] for c in LIBRARY["classes"][a["asset_class"]]["components"]}
        linked = {c for h in d["hypotheses"] for c in h["components"]}
        assert linked and linked <= ids, (a["tag"], a["issue_code"], linked)


def test_scene_search_finds_objects_by_meaning():
    from xray.api import find_objects
    vessels = find_objects("expansion vessel")
    assert vessels and "vessel" in vessels[0]["label"]
    cabinets = find_objects("electrical cabinets")
    assert len(cabinets) >= 3 and all("cabinet" in o["label"] or o.get("category") == "electrical" for o in cabinets[:3])
