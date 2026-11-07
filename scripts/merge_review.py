"""Merge a review layer exported from the app ('Review labels' panel) into config/scene_annotations.json.

    python scripts/merge_review.py ~/Downloads/scene_annotations.a-virtanen-2026-11-07.json [--dry-run]
    python scripts/run_pipeline.py --from 2        # apply it: labels become label_source='review-corrected'

relabel_near entries whose point lies within 0.05 m of an existing entry replace it (the newer decision about the
same object wins); all others are appended. merge_regions are appended unless one with the same name exists.
The file keeps its _doc and existing entries; the previous version is kept as scene_annotations.json.bak.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "config" / "scene_annotations.json"
SAME_POINT_M = 0.05


def valid_entry(r: dict) -> bool:
    p = r.get("point")
    return (isinstance(p, list) and len(p) == 3 and all(isinstance(v, (int, float)) for v in p)
            and isinstance(r.get("label"), str) and bool(r["label"].strip())
            and isinstance(r.get("category"), str) and isinstance(r.get("note"), str))


def merge(base: dict, new: dict) -> tuple[dict, int, int]:
    out = {**base, "merge_regions": list(base.get("merge_regions", [])), "relabel_near": list(base.get("relabel_near", []))}
    added = replaced = 0
    for r in new.get("relabel_near", []):
        if not valid_entry(r):
            sys.exit(f"invalid relabel_near entry (needs point[3], label, category, note): {r}")
        r = {"point": [round(float(v), 3) for v in r["point"]], "label": r["label"].strip(), "category": r["category"], "note": r["note"]}
        hit = next((i for i, e in enumerate(out["relabel_near"]) if math.dist(e["point"], r["point"]) < SAME_POINT_M), None)
        if hit is None:
            out["relabel_near"].append(r)
            added += 1
        else:
            out["relabel_near"][hit] = r
            replaced += 1
    names = {m.get("name") for m in out["merge_regions"]}
    for m in new.get("merge_regions", []):
        if m.get("name") not in names:
            out["merge_regions"].append(m)
            added += 1
    return out, added, replaced


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("review", type=Path, help="review-layer JSON downloaded from the app")
    ap.add_argument("--into", type=Path, default=TARGET, help="annotations file to update (default: config/scene_annotations.json)")
    ap.add_argument("--dry-run", action="store_true", help="print the merged file instead of writing it")
    a = ap.parse_args()
    new = json.loads(a.review.read_text())
    base = json.loads(a.into.read_text()) if a.into.exists() else {"_doc": "Review layer.", "merge_regions": [], "relabel_near": []}
    out, added, replaced = merge(base, new)
    print(f"{added} added, {replaced} replaced -> {len(out['relabel_near'])} relabel_near, {len(out['merge_regions'])} merge_regions")
    if a.dry_run:
        print(json.dumps(out, indent=2))
        return
    if a.into.exists():
        shutil.copy(a.into, a.into.with_name(a.into.name + ".bak"))
    a.into.write_text(json.dumps(out, indent=2) + "\n")
    print(f"written {a.into}; now run: python scripts/run_pipeline.py --from 2")


if __name__ == "__main__":
    main()
