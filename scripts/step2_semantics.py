"""Step 2: semantic extraction -> data/processed/scene_objects.json (+ web copy)."""
from __future__ import annotations

import json
import shutil
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from xray import config, segmentation  # noqa: E402


def main() -> None:
    out = config.DATA_OUT
    g = np.load(out / "geometry.npz")
    rep = json.loads((out / "integrity_report.json").read_text())
    lo = np.array(rep["canonical_bounds_p1"]) - 0.2
    hi = np.array(rep["canonical_bounds_p99"]) + 0.2
    lo[1] = -0.1
    res = segmentation.extract(g["xyz"].astype(np.float64), g["rgb"], lo, hi)
    objs = [o.to_dict() for o in res["objects"]]
    # merge VLM labels if a cache exists
    cache = out / "vlm_labels.json"
    if cache.exists():
        vlm = json.loads(cache.read_text())
        for o in objs:
            v = vlm.get(o["id"])
            if v and v.get("label") and v.get("geometry_signature") == _sig(o):
                o["heuristic_label"] = o["label"]
                o["label"] = v["label"]
                o["category"] = v.get("category", o.get("category"))
                o["label_source"] = "vlm+geometry"
                o["confidence"] = round(float(v.get("confidence", o["confidence"])), 2)
                o["vlm_rationale"] = v.get("rationale", "")
    for o in objs:
        o.setdefault("category", _category(o["label"]))
    objs = apply_annotations(objs, config.ROOT / "config" / "scene_annotations.json")
    scene = {
        "frame": {"up": "+Y", "floor_y": 0.0, "units": "approx. metres (see integrity report)"},
        "bounds": {"min": lo.tolist(), "max": hi.tolist()},
        "ceiling_y": res["ceiling_y"],
        "planes": res["planes"],
        "objects": objs,
        "stats": {
            "n_objects": sum(o["kind"] == "object" for o in objs),
            "n_structures": sum(o["kind"] == "structure" for o in objs),
            "labels": Counter(o["label"] for o in objs),
        },
        "partial_scan": {
            "used_splats": rep["contiguous_valid_records"],
            "declared_splats": rep["declared_vertex_count"],
            "fraction": rep["contiguous_valid_fraction"],
        },
    }
    (out / "scene_objects.json").write_text(json.dumps(scene, indent=1))
    shutil.copy(out / "scene_objects.json", config.WEB_PUBLIC / "scene_objects.json")
    np.savez_compressed(out / "object_points.npz", obj=res["obj_points"], obj_c=res["obj_colors"],
                        struct=res["struct_points"])
    print(json.dumps(scene["stats"], indent=1))


def apply_annotations(objs: list[dict], path: Path) -> list[dict]:
    if not path.exists():
        return objs
    ann = json.loads(path.read_text())
    for m in ann.get("merge_regions", []):
        lo, hi = np.array(m["region_min"]), np.array(m["region_max"])
        grp = [o for o in objs if o["kind"] == "object" and (np.array(o["center"]) >= lo).all()
               and (np.array(o["center"]) <= hi).all()]
        if not grp:
            continue
        mins = np.min([np.array(o["center"]) - np.array(o["size"]) / 2 for o in grp], axis=0)
        maxs = np.max([np.array(o["center"]) + np.array(o["size"]) / 2 for o in grp], axis=0)
        keep = grp[0]
        keep.update({"center": np.round((mins + maxs) / 2, 3).tolist(), "size": np.round(maxs - mins, 3).tolist(),
                     "yaw": 0.0, "n_points": int(sum(o["n_points"] for o in grp)),
                     "auto_label": keep["label"], "label": m["label"], "category": m["category"],
                     "label_source": "human-verified", "confidence": 0.9, "review_note": m["note"],
                     "vlm_rationale": None, "heuristic_label": None,
                     "merged_from": [o["id"] for o in grp]})
        drop = {o["id"] for o in grp[1:]}
        objs = [o for o in objs if o["id"] not in drop]
    for r in ann.get("relabel_near", []):
        pt = np.array(r["point"])
        cand = [o for o in objs if o["kind"] == "object"]
        o = min(cand, key=lambda o: np.linalg.norm(np.array(o["center"]) - pt))
        if np.linalg.norm(np.array(o["center"]) - pt) < 0.3:
            o.update({"auto_label": o["label"], "label": r["label"], "category": r["category"],
                      "label_source": "human-verified", "confidence": 0.9, "review_note": r["note"],
                      "vlm_rationale": None})
    return objs


def _sig(o: dict) -> str:
    return f"{o['center'][0]:.2f},{o['center'][1]:.2f},{o['center'][2]:.2f}|{o['n_points']}"


CATS = {
    "pipe": "piping", "valve": "valve", "pump": "rotating", "motor": "rotating", "tank": "vessel",
    "vessel": "vessel", "cabinet": "electrical", "panel": "electrical", "wall": "structure",
    "gauge": "instrument", "sensor": "instrument", "transmitter": "instrument", "meter": "instrument",
}


def _category(label: str) -> str:
    low = label.lower()
    for k, v in CATS.items():
        if k in low:
            return v
    return "other"


if __name__ == "__main__":
    main()
