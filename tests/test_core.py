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
        assert o["label_source"] in {"geometry-heuristic", "vlm+geometry", "review-corrected"}


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


def test_unreachable_target_is_not_reported_as_a_blocked_walkway(world):
    """An object outside the robot's drivable area (no barriers placed) gets an honest no-route reason."""
    from xray.navigation import NO_ROUTE_UNREACHABLE
    objs = [o["id"] for o in world.scene["objects"] if o["kind"] == "object"]
    unreachable = [i for i in objs if i not in world.reachable and world.nav.approach_cell(world.objects[i]) is not None]
    assert unreachable, "expected at least one object the robot cannot drive to"
    r = world.plan(world.start_xz, unreachable[0])
    assert not r["ok"] and r["reason"] == NO_ROUTE_UNREACHABLE and "blocked" not in r["reason"]


def test_route_clearance_is_meaningful_at_the_destination_and_for_a_blocked_start(world):
    tid = world.mapping["bindings"][world.mapping["target_asset_id"]]["object_id"]
    first = world.plan(world.start_xz, tid)
    assert first["start_snap_m"] < 0.05
    end = first["waypoints"][-1]
    here = world.plan((end[0], end[2]), tid)          # mission that starts at its destination
    assert here["ok"] and here["already_there"] and here["length_m"] < 0.1
    assert 0 < here["validation"]["min_clearance_m"] < 5, "never the 1e9 placeholder"
    sx, sz = world.start_xz                           # a barrier right on the robot's spot
    blocked = world.plan(world.start_xz, tid, [{"x": sx, "z": sz, "w": 0.6, "d": 0.6, "yaw": 0.0}])
    assert blocked["ok"] and blocked["start_snap_m"] >= 0.3
    world.plan(world.start_xz, tid, [])               # reset


def test_layout_plan_clears_one_footprint_and_blocks_another(world):
    """Maintenance planning: moving equipment frees its old footprint and occupies the new one; the route stays valid."""
    import numpy as np
    nav = world.nav
    tid = world.mapping["bindings"][world.mapping["target_asset_id"]]["object_id"]
    tc = world.objects[tid]["center"]
    moved = world.objects.get("OBJ-028") or min(
        (o for o in world.scene["objects"] if o["kind"] == "object" and o["id"] != tid),
        key=lambda o: (o["center"][0] - tc[0]) ** 2 + (o["center"][2] - tc[2]) ** 2)
    clear = {"x": moved["center"][0], "z": moved["center"][2], "w": moved["size"][0] + 0.12,
             "d": moved["size"][2] + 0.12, "yaw": moved["yaw"]}
    wp = world.plan(world.start_xz, tid)["waypoints"]
    mid = wp[len(wp) // 2]
    block = {"x": mid[0], "z": mid[2], "w": moved["size"][0], "d": moved["size"][2], "yaw": 0.3}   # parked across the route
    r = world.plan(world.start_xz, tid, [block], [clear])
    cm = np.zeros_like(nav.floor); nav._rasterise_box(nav._box(clear), cm)
    bm = np.zeros_like(nav.floor); nav._rasterise_box(nav._box(block), bm)
    assert (nav.occupied_raw & cm).any(), "the moved object occupied cells before the move"
    assert not nav.occupied[cm & nav.floor & ~bm].any(), "its old footprint is free floor in the plan"
    assert nav.occupied[bm].all(), "its new footprint is an obstacle"
    assert r["ok"] and r["clears"] == [clear] and r["blocks"] == [block]
    assert r["validation"]["collision_free"] and r["validation"]["collisions"] == 0
    assert r["validation"]["min_clearance_m"] >= config.ROBOT_RADIUS - 1e-6
    for x, _, z in r["waypoints"]:   # no waypoint inside the new footprint
        rr, cc = nav.grid.to_cell(x, z)
        assert not bm[rr, cc]
    world.plan(world.start_xz, tid)   # reset
    assert not nav.cleared.any() and np.array_equal(nav.occupied, nav.occupied_raw)


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


def test_scene_quality_tiers_are_consistent_with_scene_json():
    """The honest 'what was recognised' funnel (scripts/scene_quality.py -> quality.json) must match the scene the
    app shows, and each tier must be a subset of the one it narrows."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import scene_quality as sq
    scene = json.loads((ROOT / "web" / "public" / "static" / "scene.json").read_text())
    shipped = json.loads((ROOT / "web" / "public" / "static" / "quality.json").read_text())
    objs = {o["id"]: o for o in scene["objects"] if o["kind"] == "object"}
    tiers = {k: set(v) for k, v in sq.compute_tiers(scene).items()}
    # recomputed tiers == shipped tiers (quality.json is not stale)
    assert {k: set(v) for k, v in shipped["tier_ids"].items()} == tiers
    assert {t["id"]: t["n"] for t in shipped["tiers"]} == {k: len(v) for k, v in tiers.items()}
    # subset relations
    assert tiers["categorised"] <= tiers["candidates"]
    assert tiers["confident"] <= tiers["categorised"]
    assert tiers["review_corrected"] <= tiers["candidates"]
    assert tiers["linked"] <= tiers["candidates"]
    # counts agree with scene.json's own fields
    assert len(tiers["candidates"]) == scene["stats"]["n_objects"] == len(objs)
    assert len(tiers["linked"]) == scene["n_bound_assets"] == sum("asset" in o for o in objs.values())
    assert len(tiers["review_corrected"]) == sum(o["label_source"] == "review-corrected" for o in objs.values())
    assert all(objs[i]["label"] != "other equipment" and objs[i]["confidence"] >= shipped["threshold"]
               for i in tiers["confident"])
    # flags and the audit sample only reference real candidates; the sample is unique and complete
    assert set(shipped["flags_by_id"]) <= tiers["candidates"]
    ids = [r["id"] for r in shipped["audit"]["sample"]]
    assert len(ids) == len(set(ids)) and set(ids) <= tiers["candidates"]
    a = shipped["audit"]
    assert a["agree"] + a["disagree"] + a["cant_tell"] + a["pending"] == a["n"]
    assert a["wilson95_all"][0] <= a["agree_rate_all"] <= a["wilson95_all"][1]
