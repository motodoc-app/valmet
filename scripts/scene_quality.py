"""Scene-understanding quality report: what the 676 segmented candidates actually are.

Reads only shipped artefacts (web/public/static/scene.json, config/scene_annotations.json and, if present,
data/processed/vlm_labels.json) and writes:
  web/public/static/quality.json   - tier funnel, per-category table, audit summary (the in-app panel reads it)
  docs/SCENE_QUALITY.md            - the same numbers with exact definitions, for the team / judges
  docs/label_review_sample.csv     - the stratified sample with a BLANK human_verdict column (real precision check)

It never changes labels, object ids or the object count. The AI second-opinion audit verdicts are read from
docs/label_audit_ai.csv (written by hand while viewing the crop renders); they are an AI cross-check, not ground truth.

Run: python scripts/scene_quality.py
"""
from __future__ import annotations

import csv
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCENE = ROOT / "web" / "public" / "static" / "scene.json"
ANNOTATIONS = ROOT / "config" / "scene_annotations.json"
OUT_JSON = ROOT / "web" / "public" / "static" / "quality.json"
OUT_MD = ROOT / "docs" / "SCENE_QUALITY.md"
SAMPLE_CSV = ROOT / "docs" / "label_review_sample.csv"
AI_AUDIT_CSV = ROOT / "docs" / "label_audit_ai.csv"
CROP_DIR = "data/processed/crops"          # crops are git-ignored; path is relative to the repo root

GENERIC_LABELS = {"other equipment", "unknown", "not an object / fragment", "", None}   # the last: rejected in a human review (review.js)
CONF_T = 0.70            # "confidently identified" threshold (see THRESHOLD_WHY)
THRESHOLD_WHY = ("0.70 is the same gate the 3D view already uses to decide which object labels are worth showing "
                 "(facility.js). The VLM's confidence is self-reported and uncalibrated, so the threshold is a "
                 "presentation rule, not a probability; the audit below reports agreement per confidence band.")
SEED = 20261107
SAMPLE_N = 60            # specific-label sample (precision of labels the app shows as identified)
OTHER_N = 10             # small extra sample of "other equipment" (did the labeller miss something obvious?)

# data-quality rules (all on the oriented 3D frame or point count; boxes are clamped to >= 0.04 m per axis)
TOUCH_M = 0.03           # same-label frames closer than this (or overlapping) -> fragment group
TINY_M = 0.15            # largest extent below this -> tiny
FLAT_M = 0.0401          # smallest extent at the 0.04 m clamp -> flat / sub-4 cm thick
LOW_PTS = 50             # fewer raw splats than this -> low support
OVER_VOL = 0.5           # volume >= this (m^3) ...
OVER_EXT = 1.2           # ... or largest extent >= this with elongation < OVER_ELONG -> possible over-merge
OVER_ELONG = 4.0
SMALL_DEVICE = {"pipe label / tag", "temperature sensor", "pressure gauge", "pressure transmitter",
                "junction box", "valve actuator", "flow meter", "manual valve", "control valve"}
MISMATCH_EXT = 0.6       # a small-device label on a frame longer than this -> label/geometry mismatch

FAMILY = {  # display grouping of the VLM taxonomy (the per-object VLM 'category' is inconsistent across objects)
    "pump-motor unit": "rotating", "circulation pump": "rotating", "centrifugal pump": "rotating",
    "electric motor": "rotating",
    "control valve": "valve", "manual valve": "valve", "valve actuator": "valve",
    "temperature sensor": "instrument", "pressure gauge": "instrument", "pressure transmitter": "instrument",
    "flow meter": "instrument", "vibration sensor": "instrument",
    "insulated pipe (horizontal)": "piping", "insulated pipe (vertical)": "piping",
    "pipe elbow / fitting": "piping", "pipe label / tag": "piping (tag)",
    "electrical cabinet": "electrical", "control panel": "electrical", "junction box": "electrical",
    "cable tray": "electrical",
    "heat exchanger": "vessel", "expansion vessel": "vessel", "storage tank": "vessel",
    "trolley / cart": "logistics", "wall-mounted board": "structure-like", "other equipment": "unidentified",
}


# ----------------------------------------------------------------------------- helpers
def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def specific(o: dict) -> bool:
    return o["label"] not in GENERIC_LABELS


def _rect(o: dict):
    cs, sn = math.cos(o["yaw"]), math.sin(o["yaw"])
    hx, hz = o["size"][0] / 2, o["size"][2] / 2
    ax = [(cs, sn), (-sn, cs)]          # same convention as facility.js / vlm_labeler.box_corners
    cx, cz = o["center"][0], o["center"][2]
    corners = [(cx + sx * hx * cs - sz * hz * sn, cz + sx * hx * sn + sz * hz * cs)
               for sx in (-1, 1) for sz in (-1, 1)]
    return corners, ax


def box_gap(a: dict, b: dict) -> float:
    """Separating distance between two yaw-rotated boxes (0 when they overlap). SAT on the XZ rectangles,
    combined with the vertical interval gap."""
    ca, axa = _rect(a)
    cb, axb = _rect(b)
    g2 = 0.0
    for ux, uz in axa + axb:
        pa = [x * ux + z * uz for x, z in ca]
        pb = [x * ux + z * uz for x, z in cb]
        g2 = max(g2, min(pa) - max(pb), min(pb) - max(pa))
    ya = (a["center"][1] - a["size"][1] / 2, a["center"][1] + a["size"][1] / 2)
    yb = (b["center"][1] - b["size"][1] / 2, b["center"][1] + b["size"][1] / 2)
    gy = max(0.0, ya[0] - yb[1], yb[0] - ya[1])
    return math.hypot(max(g2, 0.0), gy)


def inside(p: list, o: dict) -> bool:
    cs, sn = math.cos(o["yaw"]), math.sin(o["yaw"])
    dx, dy, dz = p[0] - o["center"][0], p[1] - o["center"][1], p[2] - o["center"][2]
    lx, lz = dx * cs + dz * sn, -dx * sn + dz * cs
    return abs(lx) <= o["size"][0] / 2 and abs(dy) <= o["size"][1] / 2 and abs(lz) <= o["size"][2] / 2


# ----------------------------------------------------------------------------- tiers
def compute_tiers(scene: dict) -> dict:
    objs = [o for o in scene["objects"] if o["kind"] == "object"]
    t1 = [o["id"] for o in objs]
    t2 = [o["id"] for o in objs if specific(o)]
    t3 = [o["id"] for o in objs if specific(o) and o["confidence"] >= CONF_T]
    t4 = [o["id"] for o in objs if o["label_source"] == "review-corrected"]
    t5 = [o["id"] for o in objs if o.get("asset")]
    return {"candidates": t1, "categorised": t2, "confident": t3, "review_corrected": t4, "linked": t5}


def fragment_groups(objs: list[dict]) -> list[list[str]]:
    by_label = defaultdict(list)
    for o in objs:
        if specific(o):
            by_label[o["label"]].append(o)
    groups = []
    for lab, lst in by_label.items():
        parent = {o["id"]: o["id"] for o in lst}

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                a, b = lst[i], lst[j]
                # cheap reject on centre distance before the exact gap
                reach = (max(a["size"]) + max(b["size"])) * 0.75 + TOUCH_M
                if math.dist(a["center"], b["center"]) > reach:
                    continue
                if box_gap(a, b) <= TOUCH_M:
                    parent[find(a["id"])] = find(b["id"])
        comp = defaultdict(list)
        for o in lst:
            comp[find(o["id"])].append(o["id"])
        groups += [sorted(g) for g in comp.values() if len(g) > 1]
    return sorted(groups, key=lambda g: (-len(g), g[0]))


def quality_flags(objs: list[dict]) -> tuple[dict, dict]:
    flags: dict[str, list[str]] = {o["id"]: [] for o in objs}
    groups = fragment_groups(objs)
    for g in groups:
        for i in g:
            flags[i].append("fragment")
    for o in objs:
        s = sorted(o["size"])
        elong = s[2] / max(s[1], 1e-3)
        vol = o["size"][0] * o["size"][1] * o["size"][2]
        if vol >= OVER_VOL or (s[2] >= OVER_EXT and elong < OVER_ELONG):
            flags[o["id"]].append("possible_overmerge")
        if s[2] < TINY_M:
            flags[o["id"]].append("tiny")
        if s[0] <= FLAT_M:
            flags[o["id"]].append("flat")
        if o["n_points"] < LOW_PTS:
            flags[o["id"]].append("low_points")
        if o["label"] in SMALL_DEVICE and s[2] >= MISMATCH_EXT:
            flags[o["id"]].append("label_size_mismatch")
    # candidates whose centre lies inside another (larger) candidate's frame: likely a part of that object
    nested = []
    for o in objs:
        for p in objs:
            if p is o or max(p["size"]) <= max(o["size"]):
                continue
            if inside(o["center"], p):
                nested.append((o["id"], p["id"]))
                flags[o["id"]].append("nested")
                break
    return flags, {"fragment_groups": groups, "nested": nested}


# ----------------------------------------------------------------------------- sample
def draw_sample(objs: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """Stratified (by label) random sample of VLM-labelled specific objects, proportional allocation with at
    least one per label (largest remainder), fixed seed. Plus a small simple random sample of 'other equipment'."""
    rng = random.Random(SEED)
    if AI_AUDIT_CSV.exists():
        # Frozen sample: once audited, the sample must not change when later review corrections shrink the pool.
        # Objects are reported with the label they had when audited (the VLM label being evaluated).
        rows = list(csv.DictReader(AI_AUDIT_CSV.open()))
        byid = {o["id"]: o for o in objs}
        if rows and all(r["id"] in byid for r in rows):
            mk = lambda r: {**byid[r["id"]], "label": r["label"]}
            sample = [mk(r) for r in rows if r["label"] != "other equipment"]
            other = [mk(r) for r in rows if r["label"] == "other equipment"]
            audited_vlm = {**{o["id"]: o["label"] for o in objs if specific(o) and o["label_source"] == "vlm+geometry"},
                           # objects corrected because of this audit still belong to the audited population
                           **{o["id"]: o.get("auto_label") or o["label"] for o in objs if o["label_source"] == "review-corrected"
                              and "scene-quality audit" in (o.get("review_note") or "")}}
            sizes = Counter(audited_vlm.values())
            return sorted(sample, key=lambda o: o["id"]), sorted(other, key=lambda o: o["id"]), {
                "pool": len(audited_vlm), "strata": dict(sizes), "alloc": dict(Counter(o["label"] for o in sample)), "frozen": True}
    pool = [o for o in objs if specific(o) and o["label_source"] == "vlm+geometry"]
    strata = defaultdict(list)
    for o in pool:
        strata[o["label"]].append(o)
    labels = sorted(strata)
    alloc = {lab: 1 for lab in labels}
    rest = SAMPLE_N - len(labels)
    quota = {lab: rest * len(strata[lab]) / len(pool) for lab in labels}
    for lab in labels:
        alloc[lab] += int(quota[lab])
    left = SAMPLE_N - sum(alloc.values())
    for lab in sorted(labels, key=lambda lab: (-(quota[lab] - int(quota[lab])), lab))[:left]:
        alloc[lab] += 1
    sample = []
    for lab in labels:
        members = sorted(strata[lab], key=lambda o: o["id"])
        sample += rng.sample(members, min(alloc[lab], len(members)))
    other_pool = sorted([o for o in objs if not specific(o) and o["label_source"] == "vlm+geometry"],
                        key=lambda o: o["id"])
    other = rng.sample(other_pool, OTHER_N)
    sizes = {lab: len(strata[lab]) for lab in labels}
    return sorted(sample, key=lambda o: o["id"]), sorted(other, key=lambda o: o["id"]), {
        "pool": len(pool), "strata": sizes, "alloc": alloc}


def read_ai_audit() -> dict:
    if not AI_AUDIT_CSV.exists():
        return {}
    with AI_AUDIT_CSV.open() as f:
        return {r["id"]: r for r in csv.DictReader(f)}


def audit_summary(sample: list[dict], other: list[dict], strata: dict, ai: dict) -> dict:
    def tally(lst):
        c = Counter(ai.get(o["id"], {}).get("ai_verdict", "pending") for o in lst)
        return {k: c.get(k, 0) for k in ("agree", "disagree", "cant_tell", "pending")}
    t = tally(sample)
    n = len(sample)
    dec = t["agree"] + t["disagree"]
    lo, hi = wilson(t["agree"], n)
    lo2, hi2 = wilson(t["agree"], dec)
    # stratum-weighted point estimate (strata are labels; weights = share of the pool)
    w_num = 0.0
    w_den = 0.0
    for lab, size in strata["strata"].items():
        members = [o for o in sample if o["label"] == lab]
        d = [ai.get(o["id"], {}).get("ai_verdict") for o in members]
        if members:
            w_num += size * sum(v == "agree" for v in d) / len(members)
            w_den += size
    bands = []
    for lo_b, hi_b in ((0.0, 0.5), (0.5, CONF_T), (CONF_T, 1.01)):
        m = [o for o in sample if lo_b <= o["confidence"] < hi_b]
        tb = tally(m)
        bands.append({"band": f"{lo_b:.2f}-{min(hi_b, 1.0):.2f}", "n": len(m), **tb,
                      "wilson_all": [round(x, 3) for x in wilson(tb["agree"], len(m))]})
    fam = defaultdict(lambda: Counter())
    for o in sample:
        fam[FAMILY.get(o["label"], "other")][ai.get(o["id"], {}).get("ai_verdict", "pending")] += 1
    return {
        "kind": "AI second-opinion audit (a second model viewing the same crop renders). NOT human ground truth.",
        "population": f"{strata['pool']} objects with a specific VLM label (label_source 'vlm+geometry')",
        "design": f"stratified by label, proportional allocation, >= 1 per label, seed {SEED}",
        "n": n, **t,
        "agree_rate_all": round(t["agree"] / n, 3) if n else None,
        "wilson95_all": [round(lo, 3), round(hi, 3)],
        "agree_rate_decided": round(t["agree"] / dec, 3) if dec else None,
        "wilson95_decided": [round(lo2, 3), round(hi2, 3)],
        "weighted_agree_rate_all": round(w_num / w_den, 3) if w_den else None,
        "by_confidence": bands,
        "by_family": {k: dict(v) for k, v in sorted(fam.items())},
        "other_equipment_check": {"n": len(other), **tally(other),
                                  "meaning": "agree = nothing more specific is clearly visible in the crop"},
        "complete": t["pending"] == 0,
    }


# ----------------------------------------------------------------------------- main
def build() -> dict:
    scene = json.loads(SCENE.read_text())
    objs = [o for o in scene["objects"] if o["kind"] == "object"]
    structs = [o for o in scene["objects"] if o["kind"] == "structure"]
    tiers = compute_tiers(scene)
    flags, extra = quality_flags(objs)
    ann = json.loads(ANNOTATIONS.read_text()) if ANNOTATIONS.exists() else {}
    byid = {o["id"]: o for o in objs}

    # confidence histogram (0.1 bins), split specific vs 'other equipment'; human-verified kept separate
    hist = []
    for k in range(10):
        lo, hi = k / 10, (k + 1) / 10
        sel = [o for o in objs if o["label_source"] != "review-corrected" and lo <= o["confidence"] < (hi if k < 9 else 1.01)]
        hist.append({"lo": round(lo, 1), "hi": round(hi, 1), "specific": sum(specific(o) for o in sel),
                     "other": sum(not specific(o) for o in sel)})

    # per-label table
    rows = []
    for lab, lst in sorted(defaultdict(list, {k: [o for o in objs if o["label"] == k]
                                              for k in {o["label"] for o in objs}}).items(),
                           key=lambda kv: (-len(kv[1]), kv[0])):
        cats = Counter(o["category"] for o in lst)
        rows.append({
            "label": lab, "family": FAMILY.get(lab, "other"), "count": len(lst),
            "mean_confidence": round(sum(o["confidence"] for o in lst) / len(lst), 2),
            "confident": sum(o["confidence"] >= CONF_T for o in lst) if lab not in GENERIC_LABELS else 0,
            "linked": sum(bool(o.get("asset")) for o in lst),
            "sources": dict(Counter(o["label_source"] for o in lst)),
            "vlm_categories": dict(cats),
            "flagged": sum(bool(flags[o["id"]]) for o in lst),
        })
    fam_rows = defaultdict(lambda: {"count": 0, "confident": 0, "conf_sum": 0.0})
    for o in objs:
        f = fam_rows[FAMILY.get(o["label"], "other")]
        f["count"] += 1
        f["conf_sum"] += o["confidence"]
        f["confident"] += int(specific(o) and o["confidence"] >= CONF_T)
    families = [{"family": k, "count": v["count"], "confident": v["confident"],
                 "mean_confidence": round(v["conf_sum"] / v["count"], 2)}
                for k, v in sorted(fam_rows.items(), key=lambda kv: -kv[1]["count"])]

    # linking
    linked = [byid[i] for i in tiers["linked"]]
    link = {
        "n": len(linked), "workbook_assets": scene.get("n_bound_assets"),
        "methods": dict(Counter(o["asset"]["mapping_method"] for o in linked)),
        "mapping_confidence_mean": round(sum(o["asset"]["mapping_confidence"] for o in linked) / max(1, len(linked)), 2),
        "mapping_confidence_ge_T": sum(o["asset"]["mapping_confidence"] >= CONF_T for o in linked),
        "linked_and_confident": sum(i in set(tiers["confident"]) for i in tiers["linked"]),
        "note": "The workbook is synthetic (challenge builder pack); bindings are procedural and class-aware "
                "(backend/xray/mapping.py), not field-verified. Mapping confidence = visual confidence x tier weight.",
    }

    # structure
    planes = Counter(p["label"] for p in scene.get("planes", []))
    structure = {
        "planes": dict(planes), "wall_frames": len(structs),
        "structure_like_candidates": [o["id"] for o in objs if o["category"] == "structure"],
        "note": "Floor, ceiling and walls are fitted planes (RANSAC), not object candidates; they are excluded "
                "from the 676. Two candidates labelled 'wall-mounted board' are structure-like and stay in the count.",
    }

    # audit
    fc = Counter(f for fl in flags.values() for f in fl)
    any_flag = sum(bool(f) for f in flags.values())
    groups = extra["fragment_groups"]
    grp_by_label = Counter(byid[g[0]]["label"] for g in groups)
    tags = [o for o in objs if o["label"] == "pipe label / tag"]
    data_quality = {
        "rules": {
            "fragment": f"same specific label and oriented frames overlapping or within {TOUCH_M} m (union-find groups)",
            "possible_overmerge": f"volume >= {OVER_VOL} m^3, or largest extent >= {OVER_EXT} m with elongation < {OVER_ELONG}",
            "tiny": f"largest extent < {TINY_M} m",
            "flat": "smallest extent at the 0.04 m frame clamp (thinner than ~4 cm)",
            "low_points": f"fewer than {LOW_PTS} raw splats in the cluster",
            "label_size_mismatch": f"small-device label ({', '.join(sorted(SMALL_DEVICE))}) on a frame >= {MISMATCH_EXT} m long",
            "nested": "centre lies inside a larger candidate's frame (likely a part of it)",
        },
        "counts": {k: fc.get(k, 0) for k in ("fragment", "possible_overmerge", "tiny", "flat", "low_points",
                                             "label_size_mismatch", "nested")},
        "any_flag": any_flag, "no_flag": len(objs) - any_flag,
        "fragment_groups": len(groups),
        "objects_in_fragment_groups": sum(len(g) for g in groups),
        "excess_if_merged": sum(len(g) - 1 for g in groups),
        "fragment_groups_by_label": dict(grp_by_label.most_common()),
        "largest_fragment_groups": groups[:8],
        "examples": {
            k: [i for i in sorted(flags) if k in flags[i]][:12]
            for k in ("possible_overmerge", "label_size_mismatch", "tiny", "low_points", "nested")
        },
        "pipe_tags": {
            "n": len(tags),
            "tiny": sum("tiny" in flags[o["id"]] for o in tags),
            "flat": sum("flat" in flags[o["id"]] for o in tags),
            "low_points": sum("low_points" in flags[o["id"]] for o in tags),
            "longer_than_mismatch": sum("label_size_mismatch" in flags[o["id"]] for o in tags),
        },
        "nested_pairs": extra["nested"][:20],
    }

    sample, other, strata = draw_sample(objs)
    ai = read_ai_audit()
    audit = audit_summary(sample, other, strata, ai)
    audit["sample"] = [{"id": o["id"], "label": o["label"], "confidence": o["confidence"],
                        "ai_verdict": ai.get(o["id"], {}).get("ai_verdict", "pending"),
                        "reason": ai.get(o["id"], {}).get("reason", "")} for o in sample + other]

    t = {k: len(v) for k, v in tiers.items()}
    return {
        "generated_by": "scripts/scene_quality.py", "source": "web/public/static/scene.json",
        "threshold": CONF_T, "threshold_why": THRESHOLD_WHY,
        "tiers": [
            {"id": "candidates", "n": t["candidates"], "name": "Segmented candidates",
             "rule": "kind == 'object': every DBSCAN cluster that got an oriented 3D frame (walls/floor/ceiling excluded)"},
            {"id": "categorised", "n": t["categorised"], "name": "Given a specific type",
             "rule": "label is a specific taxonomy class, i.e. not 'other equipment' / unknown"},
            {"id": "confident", "n": t["confident"], "name": "Confidently identified",
             "rule": f"specific type and confidence >= {CONF_T} (VLM self-reported, or 0.9 after a review correction)"},
            {"id": "review_corrected", "n": t["review_corrected"], "name": "Review-corrected",
             "rule": "label_source == 'review-corrected' (config/scene_annotations.json review layer)"},
            {"id": "linked", "n": t["linked"], "name": "Linked to a workbook asset",
             "rule": "has a procedural binding to one of the synthetic workbook assets (mapping.py)"},
        ],
        "tier_ids": tiers,
        "human_review": {
            "n": t["review_corrected"],
            "specific_after_review": sum(specific(byid[i]) for i in tiers["review_corrected"]),
            "corrections": [{"id": i, "auto": byid[i].get("auto_label"), "final": byid[i]["label"],
                             "merged_from": byid[i].get("merged_from"), "note": byid[i].get("review_note")}
                            for i in tiers["review_corrected"]],
            "review_entries": len(ann.get("merge_regions", [])) + len(ann.get("relabel_near", [])),
        },
        "histogram": hist,
        "by_label": rows,
        "by_family": families,
        "linking": link,
        "structure": structure,
        "data_quality": data_quality,
        "audit": audit,
        "flags_by_id": {i: f for i, f in flags.items() if f},
        "caveat": ("676 is the number of segmented 3D candidates, not the number of correctly recognised physical "
                   "objects. Candidates include fragments of one object (pipe runs split into pieces), small tags "
                   "and clutter. Confidence is the vision model's own estimate and is not calibrated; only a few "
                   "labels were corrected in a team review of renders (AI-assisted), and none has been verified on site. Workbook links are procedural to synthetic records."),
        "_sample_rows": sample, "_other_rows": other, "_strata": strata,
    }


def write_sample_csv(q: dict) -> None:
    rows = q["_sample_rows"] + q["_other_rows"]
    with SAMPLE_CSV.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "label", "confidence", "stratum", "crop_path", "human_verdict", "human_correct_label", "notes"])
        for o in rows:
            stratum = o["label"] if specific(o) else "other-equipment check"
            w.writerow([o["id"], o["label"], o["confidence"], stratum, f"{CROP_DIR}/{o['id']}.jpg", "", "", ""])


def pct(a: float) -> str:
    return f"{100 * a:.1f}%"


def write_md(q: dict) -> None:
    T = {t["id"]: t for t in q["tiers"]}
    n1 = T["candidates"]["n"]
    a = q["audit"]
    dq = q["data_quality"]
    L = []
    L.append("# Scene understanding: what was actually recognised\n")
    L.append("_Generated by `python scripts/scene_quality.py` from `web/public/static/scene.json`. "
             "Numbers here are exact counts; no accuracy figure in this document is verified by a person unless it says so._\n")
    L.append("## Plain-English summary\n")
    L.append(f"> {q['caveat']}\n")
    L.append("We should say: *\"The pipeline segments the scan into "
             f"{n1} object candidates with oriented 3D frames; {T['categorised']['n']} get a specific equipment "
             f"type, {T['confident']['n']} of those with confidence >= {q['threshold']:.2f}; "
             f"{T['linked']['n']} are linked to the (synthetic) workbook assets.\"* We should not compare "
             f"{n1} with another team's object count: the counting units differ (fragments, tags and clutter are "
             "candidates here), and no one has measured precision against ground truth yet.\n")
    L.append("## Tier funnel\n")
    L.append("| Tier | Count | Share of candidates | Exact definition |\n|---|---:|---:|---|")
    for t in q["tiers"]:
        L.append(f"| {t['name']} | {t['n']} | {pct(t['n'] / n1)} | {t['rule']} |")
    L.append("")
    L.append(f"Subset relations: categorised ⊆ candidates; confident ⊆ categorised; review-corrected ⊆ candidates "
             f"({q['human_review']['specific_after_review']} of {q['human_review']['n']} review-corrected objects "
             f"carry a specific type, the other {q['human_review']['n'] - q['human_review']['specific_after_review']} were corrected *to* 'other equipment'); linked ⊆ candidates "
             f"({q['linking']['linked_and_confident']} of {q['linking']['n']} linked objects are also in the confident tier).\n")
    L.append(f"**Threshold.** {q['threshold_why']}\n")
    L.append("### Confidence histogram (VLM-labelled candidates; the 4 review-corrected objects are excluded)\n")
    L.append("| Confidence | Specific type | 'other equipment' |\n|---|---:|---:|")
    for h in q["histogram"]:
        L.append(f"| {h['lo']:.1f}–{h['hi']:.1f} | {h['specific']} | {h['other']} |")
    L.append("")
    L.append("## Per-category table\n")
    L.append("Label = the VLM taxonomy class (or the human-review label). 'VLM categories' shows that the model's "
             "free category field is not always consistent for the same label (e.g. 'electric motor' as rotating "
             "and electrical); the family column is a fixed grouping used for display.\n")
    L.append(f"| Label | Family | Count | Mean conf. | ≥ {q['threshold']:.2f} | Linked | Label source | VLM categories | Flagged |\n"
             "|---|---|---:|---:|---:|---:|---|---|---:|")
    for r in q["by_label"]:
        src = ", ".join(f"{k} {v}" for k, v in r["sources"].items())
        cats = ", ".join(f"{k} {v}" for k, v in r["vlm_categories"].items())
        L.append(f"| {r['label']} | {r['family']} | {r['count']} | {r['mean_confidence']:.2f} | {r['confident']} | "
                 f"{r['linked']} | {src} | {cats} | {r['flagged']} |")
    L.append("")
    L.append("| Family | Count | Confident | Mean conf. |\n|---|---:|---:|---:|")
    for r in q["by_family"]:
        L.append(f"| {r['family']} | {r['count']} | {r['confident']} | {r['mean_confidence']:.2f} |")
    L.append("")
    st = q["structure"]
    L.append("## Structure surfaces (reported separately)\n")
    L.append(f"Fitted planes: {', '.join(f'{k} × {v}' for k, v in st['planes'].items())}. "
             f"{st['wall_frames']} wall frames are shown in the app as `kind: structure` and are **not** among the "
             f"{n1} candidates. Structure-like candidates inside the count: {', '.join(st['structure_like_candidates'])} "
             "('wall-mounted board').\n")
    lk = q["linking"]
    L.append("## Workbook linking\n")
    L.append(f"{lk['n']} candidates are linked to {lk['workbook_assets']} workbook assets (one-to-one). Methods: "
             + ", ".join(f"{k} × {v}" for k, v in lk["methods"].items())
             + f". Mean mapping confidence {lk['mapping_confidence_mean']:.2f}; {lk['mapping_confidence_ge_T']} "
             f"of {lk['n']} have mapping confidence ≥ {q['threshold']:.2f}. {lk['note']}\n")
    hr = q["human_review"]
    L.append("## Human review layer\n")
    L.append(f"{hr['n']} objects carry `label_source: review-corrected` from {hr['review_entries']} entries in "
             "`config/scene_annotations.json`:\n")
    for c in hr["corrections"]:
        m = f" (merged from {', '.join(c['merged_from'])})" if c["merged_from"] else ""
        L.append(f"- **{c['id']}**: {c['auto']} → **{c['final']}**{m}. {c['note']}")
    L.append("")
    L.append("## Data-quality audit of candidates\n")
    L.append("Visual check of the largest 'possible over-merge' frames: OBJ-005 (chair + upright device + clutter, "
             "labelled pump-motor unit and linked to a workbook pump), OBJ-007 (shelf with mixed items), OBJ-009 "
             "(metal rack with items, labelled pump-motor unit) and OBJ-020 (two overhead pipe runs in one frame) look "
             "merged; OBJ-010 (white cabinet) looks like one object.\n")
    L.append(f"{dq['any_flag']} of {n1} candidates trigger at least one rule below; {dq['no_flag']} trigger none. "
             "Rules overlap (one object can be tiny, flat and low-support at once). Flags are review hints, not verdicts.\n")
    L.append("| Flag | Count | Rule |\n|---|---:|---|")
    for k, v in dq["counts"].items():
        L.append(f"| {k} | {v} | {dq['rules'][k]} |")
    L.append("")
    L.append(f"**Fragments / duplicates.** {dq['fragment_groups']} groups of same-label touching frames contain "
             f"{dq['objects_in_fragment_groups']} candidates; merging each group would remove "
             f"{dq['excess_if_merged']} candidates. Groups by label: "
             + ", ".join(f"{k} {v}" for k, v in dq["fragment_groups_by_label"].items()) + ". Largest groups: "
             + "; ".join(", ".join(g) for g in dq["largest_fragment_groups"][:5]) + ". Touching is not proof of "
             "duplication: groups chain through large frames (the largest one chains through the 1.6 m OBJ-005 frame), "
             "so the merge count is an upper bound for pipe-run fragments, not an exact duplicate count.\n")
    pt = dq["pipe_tags"]
    L.append(f"**'pipe label / tag' ({pt['n']}).** {pt['tiny']} tiny, {pt['flat']} flat, {pt['low_points']} "
             f"low-support, and {pt['longer_than_mismatch']} are ≥ {MISMATCH_EXT} m long, which is not tag-sized "
             "(they look like thin pipe or conduit segments). Real pipe tags are small and flat, so many of these are "
             "plausible, but this class is the biggest single source of inflated counts.\n")
    L.append("**Examples by id.**\n")
    for k, ids in dq["examples"].items():
        L.append(f"- {k}: {', '.join(ids) if ids else '—'}")
    L.append("")
    L.append("## Label audit (AI second opinion — NOT human ground truth)\n")
    L.append(f"Design: {a['design']}; population: {a['population']}. A second model (Claude) looked at the same "
             "crop renders the labeller saw (context + close-up with the magenta 3D frame) and recorded agree / "
             "disagree / can't tell with a one-line reason (`docs/label_audit_ai.csv`). It shares the labeller's "
             "handicap (sparse splat renders), so this measures *plausibility to a second model*, not correctness.\n")
    if a["complete"]:
        L.append(f"| Outcome | Count |\n|---|---:|\n| agree | {a['agree']} |\n| disagree | {a['disagree']} |\n"
                 f"| can't tell | {a['cant_tell']} |\n| **n** | {a['n']} |\n")
        L.append(f"- Agreement over all sampled (can't-tell counted as not agreeing): **{a['agree']}/{a['n']} = "
                 f"{pct(a['agree_rate_all'])}**, 95% Wilson interval **{pct(a['wilson95_all'][0])}–{pct(a['wilson95_all'][1])}**.")
        if a["agree_rate_decided"] is not None:
            L.append(f"- Agreement among decidable crops: {a['agree']}/{a['agree'] + a['disagree']} = "
                     f"{pct(a['agree_rate_decided'])}, 95% Wilson {pct(a['wilson95_decided'][0])}–{pct(a['wilson95_decided'][1])}.")
        L.append(f"- Stratum-weighted point estimate (weights = label share of the pool): {pct(a['weighted_agree_rate_all'])} "
                 "(the Wilson interval above is for the unweighted sample).")
        L.append("\n| Confidence band | n | agree | disagree | can't tell | Wilson 95% (agree/all) |\n|---|---:|---:|---:|---:|---|")
        for b in a["by_confidence"]:
            L.append(f"| {b['band']} | {b['n']} | {b['agree']} | {b['disagree']} | {b['cant_tell']} | "
                     f"{pct(b['wilson_all'][0])}–{pct(b['wilson_all'][1])} |")
        L.append("\n| Family | agree | disagree | can't tell |\n|---|---:|---:|---:|")
        for k, v in a["by_family"].items():
            L.append(f"| {k} | {v.get('agree', 0)} | {v.get('disagree', 0)} | {v.get('cant_tell', 0)} |")
        oc = a["other_equipment_check"]
        L.append(f"\n'other equipment' check ({oc['n']} random, {oc['meaning']}): agree {oc['agree']}, "
                 f"disagree {oc['disagree']}, can't tell {oc['cant_tell']}.\n")
        L.append("<details><summary>All sampled verdicts</summary>\n\n| id | label | conf. | AI verdict | reason |\n|---|---|---:|---|---|")
        for r in a["sample"]:
            L.append(f"| {r['id']} | {r['label']} | {r['confidence']:.2f} | {r['ai_verdict']} | {r['reason']} |")
        L.append("\n</details>\n")
    else:
        L.append(f"_Audit incomplete: {a['pending']} of {a['n']} sampled objects have no AI verdict yet._\n")
    L.append("### Real precision check at the event (human)\n")
    L.append("`docs/label_review_sample.csv` lists the same sample (id, label, confidence, stratum, crop path) with an "
             "empty `human_verdict` column. Open each crop (`data/processed/crops/<id>.jpg`, or select the id in the app), "
             "write agree / disagree / cant_tell, and compute agree/n with a Wilson interval. Only that number may be "
             "presented as precision.\n")
    L.append("## Proposed label corrections (NOT applied)\n")
    L.append("These are for the team lead to accept or reject via `config/scene_annotations.json` review entries "
             "(then `python scripts/step2_semantics.py`). Nothing was changed in the data.\n")
    for p in PROPOSALS:
        L.append(f"- **{p[0]}** {p[1]}")
    L.append("")
    L.append("## How to talk about it\n")
    L.append("- Lead with the method (unsupervised 3D segmentation + VLM labels with provenance + a review layer of team corrections, not field-verified), "
             "then show the funnel, not the 676.\n- Point at the confidence filter and review layer as the honest part: "
             "every label carries its source and confidence, and corrections are logged.\n- Do not quote a "
             "percentage accuracy; quote the AI-audit interval only as an AI cross-check, and offer the CSV for a "
             "live human check.\n")
    OUT_MD.write_text("\n".join(L))


# Proposed corrections from the AI second-opinion audit and the size rules (written after viewing the crops).
# Not applied: each needs a person to confirm (scene_annotations.json relabel_near entry + step2_semantics.py).
PROPOSALS: list[tuple[str, str]] = [
    ("OBJ-005 (linked to workbook pump P-002 / ASSET-014)",
     "'pump-motor unit' 0.78: the 1.6 x 1.1 x 1.3 m frame contains an office chair, an upright black device and clutter. "
     "Check in person before demoing this asset binding; likely over-merged."),
    ("OBJ-009", "'pump-motor unit' 0.74 -> 'shelving' (crop shows a metal rack with items on it)."),
    ("OBJ-033", "'pump-motor unit' 0.74 -> 'other equipment' (a small table / bench)."),
    ("OBJ-019", "'expansion vessel' 0.88 -> 'ladder' (crop shows a step ladder). Caution: it is the only object "
     "labelled 'expansion vessel' and tests/test_core.py::test_scene_search_finds_objects_by_meaning expects a "
     "search for 'expansion vessel' to return a label containing 'vessel'; update that test in the same change."),
    ("OBJ-034, OBJ-088, OBJ-098, OBJ-123, OBJ-125",
     "'pipe label / tag' -> 'insulated pipe (horizontal/vertical)' (1.1-1.9 m long thin runs; seen in the crops). "
     "The other 22 tags >= 0.6 m long (label_size_mismatch flag) should be reviewed the same way."),
    ("OBJ-165, OBJ-238", "'electric motor' -> 'other equipment' (pipe surface; thin object next to a ladder)."),
    ("OBJ-201", "'pump-motor unit' -> 'other equipment' (30 x 12 x 7 cm flat fragment)."),
    ("OBJ-303, OBJ-340, OBJ-596, OBJ-271", "instrument labels -> 'other equipment' (ladder leg, stick/handle, hanging "
     "cable, bare pipe surface)."),
    ("OBJ-371, OBJ-380", "'control valve' -> 'other equipment' (chair / hose region near the floor)."),
    ("OBJ-053", "'circulation pump' -> 'pipe elbow / fitting' (curved insulated pipe)."),
    ("OBJ-124 + OBJ-143", "two labels (centrifugal pump / pump-motor unit) on the same small red item 0.28 m apart; "
     "OBJ-143 is linked to a workbook pump. Likely one physical object (or a fitting): keep at most one."),
    ("Category field", "normalise the VLM 'category' per label (e.g. 4 'pipe label / tag' have category 'other', "
     "'electric motor' appears as rotating and electrical, 'heat exchanger' as other and vessel). Display-only, "
     "but it affects category filters and search."),
]


def main() -> None:
    q = build()
    write_sample_csv(q)
    write_md(q)
    pub = {k: v for k, v in q.items() if not k.startswith("_")}
    OUT_JSON.write_text(json.dumps(pub, separators=(",", ":")))
    t = {x["id"]: x["n"] for x in q["tiers"]}
    print(json.dumps(t), "| flags:", json.dumps(q["data_quality"]["counts"]),
          "| audit:", q["audit"]["agree"], "/", q["audit"]["n"], "pending", q["audit"]["pending"])


if __name__ == "__main__":
    main()
