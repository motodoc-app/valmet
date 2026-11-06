"""FastAPI backend — routes follow the builder pack's API_Contract sheet, plus spatial endpoints."""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .copilot import KB_PUMP
from .metadata import telemetry_evidence
from .world import World

app = FastAPI(title="Industrial X-Ray AI", version="0.1.0",
              description="Semantic 3D scene understanding + autonomous field-service copilot (Valmet × Since AI 2026)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_t0 = time.time()
WORLD = World()
STARTUP_S = round(time.time() - _t0, 2)


class PlanReq(BaseModel):
    object_id: str | None = None
    asset_id: str | None = None
    start: list[float] | None = None          # [x, z]
    blocks: list[dict] = []


class QueryReq(BaseModel):
    question: str
    asset_id: str | None = None
    component: str | None = None


class CommandReq(BaseModel):
    text: str
    selected_asset_id: str | None = None


class DraftReq(BaseModel):
    asset_id: str
    notes: str | None = None


def _asset_or_404(asset_id: str) -> dict:
    s = WORLD.assets_summary.get(asset_id)
    if not s:
        raise HTTPException(404, f"unknown asset {asset_id}")
    return s


@app.get("/api/health")
def health():
    return {"ok": True, "startup_s": STARTUP_S, "llm_model": config.LLM_MODEL if config.USE_LLM else None,
            "objects": WORLD.scene["stats"]["n_objects"]}


# ---------------------------------------------------------------- scene / spatial
@app.get("/api/scene")
def scene():
    return WORLD.scene_payload()


@app.get("/api/scene/anchors")
def anchors():
    """3D mapping and confidence (API_Contract) — the Scene_Anchors layer remapped to the real scan."""
    out = []
    for aid, b in WORLD.mapping["bindings"].items():
        o = WORLD.objects[b["object_id"]]
        out.append({"asset_id": aid, "tag": b["tag"], "object_id": b["object_id"], "center": o["center"],
                    "bbox": o["size"], "yaw": o["yaw"], "mapping_confidence": b["mapping_confidence"],
                    "mapping_method": b["method"], "visual_label": b["visual_label"],
                    "label_source": o["label_source"]})
    return {"anchors": out, "target_asset_id": WORLD.mapping["target_asset_id"], "policy": WORLD.mapping["policy"]}


@app.get("/api/nav/grid")
def nav_grid():
    return WORLD.nav.export()


@app.post("/api/nav/plan")
def nav_plan(req: PlanReq):
    oid = req.object_id
    if req.asset_id:
        b = WORLD.mapping["bindings"].get(req.asset_id)
        if not b:
            raise HTTPException(404, "asset not mapped to a scene object")
        oid = b["object_id"]
    if oid not in WORLD.objects:
        raise HTTPException(404, "unknown object")
    start = req.start or list(WORLD.start_xz)
    t = time.time()
    res = WORLD.plan(start, oid, req.blocks)
    res["compute_ms"] = round((time.time() - t) * 1000, 1)
    res["object_id"] = oid
    return res


@app.get("/api/proximity")
def proximity(x: float, z: float, r: float = 1.2):
    hits = []
    for o in WORLD.scene["objects"]:
        if o["kind"] != "object":
            continue
        d = math.hypot(o["center"][0] - x, o["center"][2] - z)
        if d <= r:
            b = WORLD.by_object.get(o["id"])
            hits.append({"object_id": o["id"], "label": o["label"], "distance_m": round(d, 2),
                         "asset": WORLD.assets_summary[b["asset_id"]] if b else None})
    return sorted(hits, key=lambda h: h["distance_m"])


# ---------------------------------------------------------------- API_Contract routes
@app.get("/api/assets")
def assets():
    return list(WORLD.assets_summary.values())


@app.get("/api/assets/{asset_id}")
def asset(asset_id: str):
    s = _asset_or_404(asset_id)
    full = WORLD.pack.asset(asset_id)
    return {**s, "master": full, "documents": [d["id"] for d in WORLD.copilot.evidence(asset_id)["documents"]]}


@app.get("/api/assets/{asset_id}/telemetry")
def asset_telemetry(asset_id: str):
    s = _asset_or_404(asset_id)
    return telemetry_evidence(WORLD.pack, asset_id, s["asset_class"])


@app.get("/api/assets/{asset_id}/events")
def asset_events(asset_id: str, limit: int = 20):
    _asset_or_404(asset_id)
    ev = WORLD.pack.events
    return ev[ev.asset_id == asset_id].head(limit).to_dict("records")


@app.get("/api/assets/{asset_id}/documents")
def asset_documents(asset_id: str):
    _asset_or_404(asset_id)
    return WORLD.copilot.evidence(asset_id)["documents"]


@app.get("/api/diagnose/{asset_id}")
def diagnose(asset_id: str):
    _asset_or_404(asset_id)
    return WORLD.copilot.diagnose(asset_id)


@app.post("/api/copilot/query")
def copilot_query(req: QueryReq):
    return WORLD.copilot.answer(req.question, req.asset_id, req.component)


@app.get("/api/knowledge/search")
def knowledge_search(q: str, k: int = 8):
    return WORLD.copilot.corpus.search(q, k=k)


@app.get("/api/knowledge/doc/{doc_id}")
def knowledge_doc(doc_id: str):
    d = WORLD.copilot.corpus.get(doc_id)
    if not d:
        raise HTTPException(404)
    return d


@app.get("/api/xray/model")
def xray_model():
    return KB_PUMP


@app.post("/api/work-orders/draft")
def work_order_draft(req: DraftReq):
    """Draft only — never sent to a CMMS, never a control action (API_Contract)."""
    ev = WORLD.copilot.evidence(req.asset_id)
    a = ev["asset"]
    return {
        "draft_id": f"WO-DRAFT-{a['tag']}-{datetime.now(timezone.utc).strftime('%H%M%S')}",
        "status": "DRAFT — requires planner approval", "asset_id": a["asset_id"], "tag": a["tag"],
        "area_name": a["area_name"], "maintenance_type": "inspection",
        "priority": "high" if a["urgency"] == "high" else "medium",
        "action": a["recommended_next_check"], "role": "field_technician",
        "problem": f"{a['issue_code']}: {a['issue_summary']}",
        "evidence_ids": [e["event_id"] for e in ev["events"][:5]] + [c["case_id"] for c in ev["similar_cases"][:2]],
        "knowledge_doc_id": next((d["id"] for d in ev["documents"] if d["kind"] == "knowledge_doc"), None),
        "safety_prerequisites": ["Work permit", "Isolation + lockout/tagout per site procedure",
                                 "OEM / site-approved procedure", "Qualified personnel"],
        "confidence": ev["confidence"]["overall"], "notes": req.notes,
        "schema": "Maintenance_History", "control_actions": "none (draft only)",
    }


# ---------------------------------------------------------------- natural-language commands
SIGNAL_WORDS = {"vibration": "vibration_mm_s", "temperature": "bearing_temp_c", "temp": "bearing_temp_c",
                "current": "motor_current_a", "pressure": "process_pressure_bar", "flow": "process_flow_pct",
                "stiction": "stiction_index", "position": "position_actual_pct"}
CLASS_WORDS = {"pump": "PROCESS_PUMP", "motor": "ELECTRIC_MOTOR", "valve": "CONTROL_VALVE",
               "transmitter": "PRESSURE_TRANSMITTER", "sensor": "VIBRATION_SENSOR"}


@app.post("/api/copilot/command")
def command(req: CommandReq):
    """Rule-based intent router (transparent + deterministic); free-form questions fall through to RAG."""
    t = req.text.lower()
    actions: list[dict] = []
    assets = WORLD.assets_summary
    cls = next((c for w, c in CLASS_WORDS.items() if w in t), None)
    sig = next((s for w, s in SIGNAL_WORDS.items() if w in t), None)
    asset_id = req.selected_asset_id
    reason = ""
    if sig and re.search(r"abnormal|high|unusual|anomal|elevated|highest|find", t):
        best = None
        for aid, a in assets.items():
            if cls and a["asset_class"] != cls:
                continue
            for s in telemetry_evidence(WORLD.pack, aid, a["asset_class"])["signals"]:
                if s["signal"] == sig and s["z_vs_peers"] is not None:
                    if best is None or s["z_vs_peers"] > best[1]:
                        best = (aid, s["z_vs_peers"], s)
        if best:
            asset_id = best[0]
            s = best[2]
            reason = (f"{assets[asset_id]['tag']} has the most abnormal {sig}: {s['recent_mean']}{s['unit']} vs peer "
                      f"mean {s['peer_mean']}{s['unit']} (z = {s['z_vs_peers']}) [Telemetry_Sample_3d].")
    elif re.search(r"fault|faulty|broken|worst|priority|critical|problem|alarm", t):
        cand = [a for a in assets.values() if (not cls or a["asset_class"] == cls)]
        from .metadata import priority_score
        cand.sort(key=lambda a: -priority_score(WORLD.pack.asset(a["asset_id"])))
        if cand:
            asset_id = cand[0]["asset_id"]
            a = cand[0]
            reason = (f"{a['tag']} has the highest maintenance priority"
                      + (f" among {cls.replace('_', ' ').lower()}s" if cls else "") +
                      f": {a['condition_state']}, health {a['health_score']}, {a['issue_code']} "
                      f"({a['criticality']}) [{a['asset_id']}].")
    if asset_id:
        a = assets[asset_id]
        actions.append({"type": "select", "asset_id": asset_id, "object_id": a["object_id"]})
        if a["object_id"]:
            o = WORLD.objects[a["object_id"]]
            reason += (f" It is mapped to scene object {a['object_id']} ('{o['label']}', {o['label_source']}) at "
                       f"x={o['center'][0]:.1f}, z={o['center'][2]:.1f} m — mapping confidence "
                       f"{a['mapping_confidence']}.")
    if re.search(r"send|go to|navigate|inspect|dispatch|walk|drive|route", t) and asset_id:
        actions.append({"type": "navigate", "asset_id": asset_id, "object_id": assets[asset_id]["object_id"]})
        reason += " Dispatching the inspection robot along a collision-free route."
    if re.search(r"x-?ray|explode|inside|internal|component", t):
        actions.append({"type": "xray"})
    if re.search(r"practi[cs]e|exercise|train|rehears", t):
        actions.append({"type": "practice"})
    if re.search(r"learn|tutorial|teach", t):
        actions.append({"type": "learn"})
    if re.search(r"manual|document|doc|knowledge|procedure", t):
        actions.append({"type": "knowledge"})
    if not reason and not actions:
        ans = WORLD.copilot.answer(req.text, req.selected_asset_id)
        return {"intent": "question", "text": ans["text"], "sources": ans.get("sources", []), "actions": [],
                "mode": ans.get("mode")}
    if not reason:
        ans = WORLD.copilot.answer(req.text, asset_id)
        reason = ans["text"]
    return {"intent": "command", "text": reason.strip(), "actions": actions, "asset_id": asset_id}


# serve the built web app if present (single-process demo: `python -m xray.api` or uvicorn)
_dist = config.ROOT / "web" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")


def main():
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
