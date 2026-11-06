"""Bind workbook assets (Asset_Master/Current_State) to extracted 3D objects.

The brief explicitly allows procedural mapping. We make it *class-aware* and *transparent*:
  1. each workbook asset class has a set of compatible visual labels (from the VLM/heuristic labeller)
  2. assets are assigned greedily to the most confident compatible object (exact class match first,
     then documented fallbacks), never two assets to one object
  3. the pre-determined faulty target (highest maintenance priority) is bound to a reachable,
     pump-like object so the robot can physically get there
Each binding records method + mapping_confidence (Builder Q-06: lower confidence when mapping is weak).
"""
from __future__ import annotations

import json
from pathlib import Path

from .metadata import BuilderPack, priority_score

COMPATIBLE = {
    "PROCESS_PUMP": (["circulation pump", "centrifugal pump", "pump-motor unit"],
                     ["electric motor", "heat exchanger", "other equipment"]),
    "ELECTRIC_MOTOR": (["electric motor", "pump-motor unit"], ["junction box", "control panel", "other equipment"]),
    "CONTROL_VALVE": (["control valve", "manual valve", "valve actuator"], ["pipe elbow / fitting"]),
    "PRESSURE_TRANSMITTER": (["pressure transmitter", "pressure gauge", "flow meter"],
                             ["temperature sensor", "junction box", "pipe label / tag"]),
    "VIBRATION_SENSOR": (["vibration sensor", "temperature sensor"], ["junction box", "pipe label / tag"]),
}


def build_mapping(scene: dict, pack: BuilderPack, reachable_ids: set[str], overrides: dict | None = None) -> dict:
    overrides = overrides or {}
    objs = {o["id"]: o for o in scene["objects"] if o["kind"] == "object"}
    assets = pack.assets.to_dict("records")
    for a in assets:
        a["priority"] = priority_score(a)
    assets.sort(key=lambda a: -a["priority"])
    target = assets[0]
    used: set[str] = set()
    bindings: dict[str, dict] = {}

    def candidates(cls: str, tier: int, need_reachable: bool):
        labels = COMPATIBLE[cls][tier]
        c = [o for o in objs.values() if o["label"] in labels and o["id"] not in used
             and (not need_reachable or o["id"] in reachable_ids)]
        return sorted(c, key=lambda o: (-o["confidence"], -o["n_points"]))

    def bind(asset: dict, obj: dict, method: str, weight: float) -> None:
        used.add(obj["id"])
        bindings[asset["asset_id"]] = {
            "asset_id": asset["asset_id"], "tag": asset["tag"], "object_id": obj["id"],
            "method": method, "visual_label": obj["label"],
            "mapping_confidence": round(min(0.95, obj["confidence"] * weight), 2),
        }

    # manual overrides (human-verified identity, e.g. QR/NFC scan in the field)
    for aid, oid in overrides.items():
        a = next((x for x in assets if x["asset_id"] == aid), None)
        if a and oid in objs:
            bind(a, objs[oid], "manual override (verified)", 1.0)

    # 1) faulty target must be reachable
    if target["asset_id"] not in bindings:
        for tier, w in ((0, 1.0), (1, 0.6)):
            c = candidates(target["asset_class"], tier, need_reachable=True)
            if c:
                bind(target, c[0], "class-aware (target, reachable)" if tier == 0 else "class fallback (target)", w)
                break
    # 2) remaining assets: degraded ones first, prefer reachable so the route passes them
    for a in assets:
        if a["asset_id"] in bindings:
            continue
        for tier, w in ((0, 1.0), (1, 0.6)):
            c = candidates(a["asset_class"], tier, need_reachable=False)
            c.sort(key=lambda o: (o["id"] not in reachable_ids, -o["confidence"]))
            if c:
                bind(a, c[0], "class-aware" if tier == 0 else "class fallback", w)
                break
    return {"target_asset_id": target["asset_id"], "target_priority": target["priority"],
            "bindings": bindings,
            "unbound_assets": [a["asset_id"] for a in assets if a["asset_id"] not in bindings],
            "policy": __doc__.strip()}


def load_overrides(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}
