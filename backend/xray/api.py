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
from .copilot import LIBRARY
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
    blocks: list[dict] = []                   # extra obstacles {x, z, w, d, yaw}
    clears: list[dict] = []                   # footprints treated as free floor (equipment moved in a layout plan)


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
    res = WORLD.plan(start, oid, req.blocks, req.clears)
    res["compute_ms"] = round((time.time() - t) * 1000, 1)
    res["object_id"] = oid
    return res


@app.get("/api/proximity")
def proximity(x: float, z: float, r: float = config.PROXIMITY_M):
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
    """Equipment library: exploded model + component knowledge + lessons + practice for every asset class."""
    return LIBRARY


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
                "stiction": "stiction_index", "position": "position_actual_pct", "overheat": "bearing_temp_c"}
ANOMALY = r"abnormal|high|unusual|anomal|elevated|highest|find|overheat|hot\b|worst|most"
COND_RANK = {"attention_required": 0, "degraded": 1, "watch": 2, "healthy": 3}
XRAY_WORDS = r"x-?ray|explode|inside|internal|component|parts"
STATUS_WORDS = r"wrong|why|flag|status|health|condition|issue|diagnos|problem|fault"
def find_component(t: str, cls: str | None, selected_cls: str | None):
    """Longest component name mentioned in the text, restricted to a named device type; ties go to the selection's type."""
    hits = []
    for k, c in LIBRARY["classes"].items():
        for p in c["components"]:
            n = p["name"].lower()
            if re.search(r"\b" + re.escape(n) + r"s?\b", t):
                hits.append((len(n), k == selected_cls, k, p))
    if cls:
        hits = [h for h in hits if h[2] == cls]
    if not hits:
        return None
    hits.sort(key=lambda h: (-h[0], not h[1]))
    return hits[0][2], hits[0][3]


CLASS_WORDS = {"pump": "PROCESS_PUMP", "motor": "ELECTRIC_MOTOR", "valve": "CONTROL_VALVE",
               "transmitter": "PRESSURE_TRANSMITTER", "sensor": "VIBRATION_SENSOR"}
STOP = {"the", "where", "is", "are", "find", "show", "me", "a", "an", "all", "of", "in", "this", "room", "please", "locate", "which"}


def find_objects(phrase: str) -> list[dict]:
    """Semantic search over the 3D scene: match words against every object's label (from the vision model or
    review) and against workbook tags/classes. Returns matching objects, best first."""
    words = [w for w in re.findall(r"[a-z0-9\-]+", phrase.lower()) if w not in STOP]
    if not words:
        return []
    out = []
    for o in WORLD.scene["objects"]:
        if o["kind"] != "object":
            continue
        b = WORLD.by_object.get(o["id"])
        a = WORLD.assets_summary[b["asset_id"]] if b else None
        hay = f"{o['label']} {o.get('category', '')} " + (f"{a['tag']} {a['asset_class'].replace('_', ' ')}" if a else "")
        hay = hay.lower()
        score = sum(1 for w in words if w in hay or (w.endswith("s") and w[:-1] in hay))
        if score:
            out.append((score + o["confidence"] + (0.5 if a else 0), o))
    out.sort(key=lambda x: -x[0])
    top = out[0][0] if out else 0
    return [o for sc, o in out if sc >= top - 0.6]


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
    # an asset named by tag ("send the robot to M-006") wins over the current selection
    tag_m = re.search(r"\b([a-z]{1,3}-\d{3})\b", t)
    named = next((a["asset_id"] for a in assets.values() if tag_m and a["tag"].lower() == tag_m.group(1)), None)
    if named:
        asset_id = named
        # "what's wrong with P-005?" / "why is P-005 flagged?": show its diagnosis
        if re.search(STATUS_WORDS, t) and not re.search(r"send|go to|navigate|dispatch|" + XRAY_WORDS, t):
            a = assets[named]
            return {"intent": "command", "asset_id": named,
                    "actions": [{"type": "select", "asset_id": named, "object_id": a["object_id"]}, {"type": "diagnose", "asset_id": named}],
                    "text": (f"{a['tag']}: {a['issue_summary']}. Condition {a['condition_state'].replace('_', ' ')}, health "
                             f"{a['health_score']}, criticality {a['criticality']} [{a['asset_id']}]. Opening its diagnosis with the evidence.")}
    # a question about a named component ("what does the impeller do?"): answer it for that device type and show the part
    comp = find_component(t, cls, assets.get(asset_id, {}).get("asset_class"))
    if comp and re.search(r"what (does|is|are)|what's|explain|how (does|do i|to)|inspect|fail|faulty|evidence|purpose|why", t) \
            and not re.search(r"\bwhere\b", t):
        ccls, c = comp
        from .metadata import priority_score
        if assets.get(asset_id, {}).get("asset_class") != ccls:
            same = sorted((a for a in assets.values() if a["asset_class"] == ccls),
                          key=lambda a: (COND_RANK.get(a["condition_state"], 9), -priority_score(WORLD.pack.asset(a["asset_id"]))))
            asset_id = same[0]["asset_id"] if same else None
        ans = WORLD.copilot.answer(req.text, asset_id, c["id"])
        acts = [{"type": "xray", "asset_id": asset_id, "focus": [c["id"]]}] if asset_id else []
        return {"intent": "component", "text": ans["text"], "sources": ans.get("sources", []), "actions": acts,
                "asset_id": asset_id, "component": c["id"], "mode": ans.get("mode")}
    sig_q = bool(sig and re.search(ANOMALY, t))     # "where is the vibration sensor?" names a device, not a symptom
    if sig_q:
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
    # a named equipment type overrides a selection of a different type ("explain this valve" while a pump is selected)
    if cls and not reason and (not asset_id or assets.get(asset_id, {}).get("asset_class") != cls) \
            and re.search(r"explain|what does|how does|component|parts|x-?ray|inside|practi|learn|this", t):
        from .metadata import priority_score
        same = sorted((a for a in assets.values() if a["asset_class"] == cls),
                      key=lambda a: (COND_RANK.get(a["condition_state"], 9), -priority_score(WORLD.pack.asset(a["asset_id"]))))
        if same:
            asset_id = same[0]["asset_id"]
    # "where is the expansion vessel / circulation pump / P-002?" -> semantic search over the scene
    m = re.search(r"(?:where(?:'s| is| are)|locate|find|show me)\s+(?:the\s+|all\s+|a\s+)?(.+?)[?.!]*$", t)
    if m and (re.search(r"manual|document|\bdocs?\b|knowledge|procedure|guide", m.group(1)) or re.search(XRAY_WORDS, t)):
        m = None          # "show me the manual" / "show me inside the motor" are not scene searches
    # "where are the control valves?" names what to look for: the current selection must not answer it
    if m and not reason and not sig_q and not re.search(r"\b(it|this|that|here|selected)\b", m.group(1)):
        asset_id = None
    if not asset_id and m and not sig_q:
        tag = re.search(r"\b([a-z]{1,2}-\d{3})\b", t)
        if tag:
            hit = next((a for a in assets.values() if a["tag"].lower() == tag.group(1)), None)
            if hit:
                asset_id = hit["asset_id"]
                noun = hit['asset_class'].replace('_', ' ').lower()
                reason = f"{hit['tag']} is {'an' if noun[0] in 'aeiou' else 'a'} {noun} in {hit['area_name']} [{hit['asset_id']}]."
        else:
            found = find_objects(m.group(1))
            if found:
                best = found[0]
                b = WORLD.by_object.get(best["id"])
                actions.append({"type": "select_object", "object_id": best["id"], "matches": [o["id"] for o in found[:40]],
                                "asset_id": b["asset_id"] if b else None})
                asset_id = b["asset_id"] if b else None
                reason = (f"Found {len(found)} object{'s' if len(found) != 1 else ''} labelled like “{m.group(1)}” in the scan. "
                          f"Highlighting {'them' if len(found) > 1 else 'it'}; the closest match is {best['id']} "
                          f"({best['label']}, {round(best['confidence'] * 100)}% confidence, {best['label_source']}).")
                if b:
                    reason += f" It is mapped to workbook asset {b['tag']} [{b['asset_id']}]."
    lib_only = bool(re.search(r"manual|document|\bdocs?\b|knowledge|procedure|guide", t)) and not reason \
        and not re.search(r"send|go to|navigate|dispatch|x-?ray|explode|inside|explain", t)
    if lib_only:
        a = assets.get(asset_id)
        q = f"{a['asset_class'].replace('_', ' ').lower()} {a['issue_code'].replace('_', ' ').lower()}" if a else ""
        return {"intent": "command", "actions": [{"type": "knowledge", "query": q}], "asset_id": asset_id,
                "text": f"Opening the library{' with the documents for ' + a['tag'] + ' (' + q + ')' if a else ''}. "
                        "Every document has an ID you can cite."}
    # select only what the question picked; an inherited selection just scopes the answer
    if asset_id and (asset_id != req.selected_asset_id or reason or named) \
            and not any(a["type"] == "select_object" for a in actions):
        a = assets[asset_id]
        actions.append({"type": "select", "asset_id": asset_id, "object_id": a["object_id"]})
        if not reason:
            noun = a['asset_class'].replace('_', ' ').lower()
            reason = (f"{a['tag']} is {'an' if noun[0] in 'aeiou' else 'a'} {noun} in {a['area_name']}, "
                      f"{a['condition_state'].replace('_', ' ')}, health {a['health_score']} [{a['asset_id']}].")
        if a["object_id"] and "mapped to workbook asset" not in reason:
            o = WORLD.objects[a["object_id"]]
            reason += (f" It is mapped to scene object {a['object_id']} ('{o['label']}', {o['label_source']}) at "
                       f"x={o['center'][0]:.1f}, z={o['center'][2]:.1f} m — mapping confidence "
                       f"{a['mapping_confidence']}.")
    if re.search(r"send|go to|navigate|inspect|dispatch|walk|drive|route", t) and asset_id \
            and not re.search(r"practi[cs]e|learn|train|rehears|how do i|how to", t):
        actions.append({"type": "navigate", "asset_id": asset_id, "object_id": assets[asset_id]["object_id"]})
        reason += " Dispatching the inspection robot along a collision-free route."
    if re.search(r"x-?ray|explode|inside|internal|component|parts", t):
        actions.append({"type": "xray", "asset_id": asset_id})
    if re.search(r"explain|what does|what is this|how does", t) and asset_id:
        a = assets[asset_id]
        lib = LIBRARY["classes"].get(a["asset_class"], {})
        noun = lib.get('label', a['asset_class']).lower()
        reason = (f"{a['tag']} is {'an' if noun[0] in 'aeiou' else 'a'} {noun}. {lib.get('function', '')} "
                  f"Its main components: {', '.join(c['name'].lower() for c in lib.get('components', [])[:8])}. "
                  f"Current condition: {a['condition_state'].replace('_', ' ')}, health {a['health_score']} [{a['asset_id']}]. ") + reason
    if re.search(r"practi[cs]e|exercise|train|rehears", t):
        actions.append({"type": "practice"})
    if re.search(r"learn|tutorial|teach", t):
        actions.append({"type": "learn"})
    if re.search(r"manual|document|doc|knowledge|procedure", t):
        actions.append({"type": "knowledge"})
    if not reason and not actions:
        # a free question that names a tag ("why is P-005 losing flow?") is scoped to that asset
        tag = re.search(r"\b([a-z]{1,3}-\d{3})\b", t)
        named = next((a["asset_id"] for a in assets.values() if tag and a["tag"].lower() == tag.group(1)), None)
        ans = WORLD.copilot.answer(req.text, named or req.selected_asset_id)
        return {"intent": "question", "text": ans["text"], "sources": ans.get("sources", []), "actions": [],
                "mode": ans.get("mode")}
    if not reason and actions and all(a["type"] in ("practice", "learn", "xray", "knowledge") for a in actions):
        reason = " ".join({"xray": "Opening the X-Ray view.", "practice": "Opening Practice: a fictional case, with a safety check first.",
                           "learn": "Opening the guided lessons.", "knowledge": "Opening the library."}[a["type"]] for a in actions)
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
