"""Loads all processed artefacts into one in-memory 'world' used by the API and scripts."""
from __future__ import annotations

import json
import math
from functools import cached_property

import numpy as np

from . import config
from .copilot import Copilot
from .mapping import build_mapping, load_overrides
from .metadata import BuilderPack
from .navigation import NavMap

DEMO_START_XZ = (-0.8, 1.32)   # in the double doorway: the robot enters the plant room from the corridor


class World:
    def __init__(self):
        out = config.DATA_OUT
        self.scene = json.loads((out / "scene_objects.json").read_text())
        self.integrity = json.loads((out / "integrity_report.json").read_text())
        rc = np.load(out / "render_cache.npz")
        pts = rc["xyz"][rc["opacity"] > 0.15]
        self.nav = NavMap(pts, self.scene["objects"], np.array(self.scene["bounds"]["min"]),
                          np.array(self.scene["bounds"]["max"]))
        self.pack = BuilderPack(config.XLSX_PATH)
        self.objects = {o["id"]: o for o in self.scene["objects"]}
        start = self.nav.nearest_walkable(*DEMO_START_XZ)
        reach = set()
        if start is not None:
            from scipy import ndimage
            lab, _ = ndimage.label(self.nav.walkable)
            zone = lab[start]
            for o in self.scene["objects"]:
                if o["kind"] != "object":
                    continue
                g = self.nav.approach_cell(o)
                if g is not None and lab[g] == zone:
                    reach.add(o["id"])
        self.reachable = reach
        self.start_xz = self.nav.grid.to_world(*start) if start else DEMO_START_XZ
        self.mapping = build_mapping(self.scene, self.pack, reach,
                                     load_overrides(config.ROOT / "config" / "mapping_overrides.json"))
        self.by_object = {b["object_id"]: b for b in self.mapping["bindings"].values()}
        self.copilot = Copilot(self.pack, self.mapping)

    @cached_property
    def assets_summary(self) -> dict:
        out = {}
        for a in self.pack.assets.to_dict("records"):
            b = self.mapping["bindings"].get(a["asset_id"])
            out[a["asset_id"]] = {
                "asset_id": a["asset_id"], "tag": a["tag"], "asset_class": a["asset_class"],
                "area_name": a["area_name"], "criticality": a["criticality"], "health_score": a["health_score"],
                "condition_state": a["condition_state"], "issue_code": a["issue_code"],
                "issue_summary": a["issue_summary"], "urgency": a["urgency"],
                "model_confidence": a["model_confidence"],
                "object_id": b["object_id"] if b else None,
                "mapping_confidence": b["mapping_confidence"] if b else None,
                "mapping_method": b["method"] if b else None,
                "is_target": a["asset_id"] == self.mapping["target_asset_id"],
            }
        return out

    def scene_payload(self) -> dict:
        objs = []
        for o in self.scene["objects"]:
            d = {k: o[k] for k in ("id", "kind", "label", "label_source", "confidence", "center", "size", "yaw",
                                   "n_points", "color_rgb", "category")}
            d["heuristic_label"] = o.get("heuristic_label")
            d["vlm_rationale"] = o.get("vlm_rationale")
            d["reachable"] = o["id"] in self.reachable
            b = self.by_object.get(o["id"])
            if b:
                d["asset"] = self.assets_summary[b["asset_id"]]
            objs.append(d)
        nav = self.nav
        return {
            "objects": objs, "planes": self.scene["planes"], "stats": self.scene["stats"],
            "ceiling_y": self.scene["ceiling_y"], "bounds": self.scene["bounds"],
            "partial_scan": self.scene["partial_scan"],
            "integrity": {k: self.integrity[k] for k in ("declared_vertex_count", "contiguous_valid_records",
                                                         "contiguous_valid_fraction", "first_implausible_record",
                                                         "sha256", "scale_note")},
            "navigation": {"levels": nav.levels, "zones": nav.zones, "robot_radius_m": nav.robot_radius,
                           "max_step_m": nav.max_step, "cell_m": nav.res,
                           "walkable_area_m2": round(float(nav.walkable.sum() * nav.res ** 2), 2)},
            "start": [round(self.start_xz[0], 3), 0.0, round(self.start_xz[1], 3)],
            "target_asset_id": self.mapping["target_asset_id"],
            "target_object_id": (self.mapping["bindings"].get(self.mapping["target_asset_id"]) or {}).get("object_id"),
            "n_bound_assets": len(self.mapping["bindings"]),
        }

    def plan(self, start_xz, object_id: str, blocks: list[dict] | None = None) -> dict:
        self.nav.set_blockages(blocks or [])
        res = self.nav.plan(tuple(start_xz), self.objects[object_id])
        res["blocks"] = blocks or []
        if res.get("ok"):
            res["proximity_preview"] = self.along_route(res["waypoints"])
        return res

    def along_route(self, waypoints: list, radius: float = 1.4) -> list[dict]:
        """Assets that come within `radius` of the route (what the robot will 'see')."""
        seen = {}
        pts = []
        for a, b in zip(waypoints[:-1], waypoints[1:]):
            n = max(2, int(math.dist(a, b) / 0.1))
            pts += [(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t) for t in np.linspace(0, 1, n)]
        for o in self.scene["objects"]:
            if o["kind"] != "object":
                continue
            d = min(math.hypot(o["center"][0] - x, o["center"][2] - z) for x, z in pts)
            if d < radius:
                b = self.by_object.get(o["id"])
                seen[o["id"]] = {"object_id": o["id"], "label": o["label"], "min_distance_m": round(d, 2),
                                 "asset_id": b["asset_id"] if b else None}
        return sorted(seen.values(), key=lambda s: s["min_distance_m"])
