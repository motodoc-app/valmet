"""Grounded field-service copilot.

Two layers, deliberately separated:
  * Evidence engine (deterministic): gathers identity, condition, telemetry statistics, alarms, work orders,
    similar historical cases, data-quality issues and documents — every item has a source ID.
  * Narrator (LLM, optional): turns the evidence package into a short explanation. It may only cite IDs that
    exist in the package; any other citation is stripped and reported. If no LLM is available the same
    structure is produced from templates, so the demo never depends on the network.
"""
from __future__ import annotations

import json
import math
import os
import re
from collections import Counter
from pathlib import Path

from . import config
from .metadata import BuilderPack, priority_score, telemetry_evidence

KB_PUMP = json.loads((Path(__file__).parent / "knowledge" / "pump_components.json").read_text())

ISSUE_HYPOTHESES = {
    "FOULING": [("Fouling / deposits in impeller or volute", ["impeller", "casing"]),
                ("Internal wear (wear-ring clearance growth)", ["wear_ring"]),
                ("Process-side restriction (strainer / partially closed valve)", [])],
    "CAVITATION_RISK": [("Insufficient suction head → cavitation", ["impeller", "casing"]),
                        ("Suction-side restriction", [])],
    "SEAL_DEGRADATION": [("Mechanical seal face wear", ["seal"]), ("Shaft run-out stressing the seal", ["shaft"])],
    "BEARING_WEAR": [("Bearing degradation", ["bearing_inboard", "bearing_outboard"]),
                     ("Lubrication issue", ["bearing_housing"])],
    "MISALIGNMENT": [("Shaft misalignment at coupling", ["coupling"]), ("Soft foot / baseplate", ["baseplate"])],
    "CURRENT_IMBALANCE": [("Electrical supply / winding imbalance", ["motor"]), ("Mechanical load change", [])],
    "OVERHEATING": [("Cooling or load issue", ["motor"])],
    "POSITION_DEVIATION": [("Actuator / positioner tracking problem", []), ("Valve friction (stiction)", [])],
    "CALIBRATION_DRIFT": [("Positioner calibration drift", [])],
    "MOUNTING_ISSUE": [("Sensor mounting degraded", ["bearing_housing"])],
}


def _tok(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9_]+", s.lower()) if len(w) > 2]


class Corpus:
    """Tiny BM25 index over every citable text in the builder pack + the X-Ray knowledge base."""

    def __init__(self, pack: BuilderPack):
        docs = []
        for d in pack.docs.to_dict("records"):
            docs.append({"id": d["doc_id"], "title": d["title"], "scope": d["scope"], "text": d["content"],
                         "kind": "knowledge_doc", "source": "Knowledge_Docs"})
        for a in pack.assets.to_dict("records"):
            txt = (f"{a['tag']} {a['asset_class']} in {a['area_name']} ({a['process_context']}), criticality "
                   f"{a['criticality']}. Installed {a['installation_date']}, last service {a['last_service_date']}, "
                   f"interval {a['service_interval_days']} days, connectivity {a['connectivity_profile']}. "
                   f"Current condition {a['condition_state']} (health {a['health_score']}): {a['issue_summary']}. "
                   f"Recommended next check: {a['recommended_next_check']}.")
            docs.append({"id": f"DOC-ASSET-{a['asset_id'][-3:]}", "title": f"Asset card {a['tag']}",
                         "scope": a["asset_class"], "asset_id": a["asset_id"], "text": txt, "kind": "asset_card",
                         "source": "generated from Asset_Master + Current_State rows (RAG_Corpus_Index asset_card)"})
        for c in pack.cases.to_dict("records"):
            docs.append({"id": c["case_id"], "title": f"{c['asset_class']} · {c['historical_issue_code']}",
                         "scope": c["asset_class"], "issue_code": c["historical_issue_code"],
                         "text": f"{c['historical_interpretation']}. Next check: {c['recommended_next_check']}. "
                                 f"Workflow: {c['safe_evidence_workflow']} Severity {c['severity']}.",
                         "kind": "service_case", "source": "Historical_Service_Cases"})
        for comp in KB_PUMP["components"]:
            docs.append({"id": f"KB-XRAY-PUMP#{comp['id']}", "title": f"{comp['name']} (illustrative pump)",
                         "scope": "PROCESS_PUMP", "component": comp["id"],
                         "text": f"{comp['name']}: {comp['function']} Typical symptoms: "
                                 f"{'; '.join(comp['failure_symptoms'])}. Signals: {', '.join(comp['evidence_signals'])}.",
                         "kind": "training_kb", "source": "Industrial X-Ray AI educational knowledge base (non-OEM)"})
        self.docs = docs
        self.tf = [Counter(_tok(d["title"] + " " + d["text"] + " " + d.get("scope", ""))) for d in docs]
        self.dl = [sum(t.values()) for t in self.tf]
        self.avg = sum(self.dl) / len(self.dl)
        df = Counter()
        for t in self.tf:
            df.update(t.keys())
        self.idf = {w: math.log(1 + (len(docs) - n + 0.5) / (n + 0.5)) for w, n in df.items()}

    def search(self, query: str, k: int = 6, scope: str | None = None, kinds: list[str] | None = None) -> list[dict]:
        q = _tok(query)
        scores = []
        for i, (t, d) in enumerate(zip(self.tf, self.docs)):
            if kinds and d["kind"] not in kinds:
                continue
            s = 0.0
            for w in q:
                if w in t:
                    f = t[w]
                    s += self.idf[w] * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * self.dl[i] / self.avg))
            if scope and d.get("scope") in (scope, "ALL"):
                s *= 1.3
            if s > 0:
                scores.append((s, i))
        scores.sort(reverse=True)
        return [dict(self.docs[i], score=round(s, 3)) for s, i in scores[:k]]

    def get(self, doc_id: str) -> dict | None:
        return next((d for d in self.docs if d["id"] == doc_id), None)


class Copilot:
    def __init__(self, pack: BuilderPack, mapping: dict | None = None):
        self.pack = pack
        self.corpus = Corpus(pack)
        self.mapping = mapping or {"bindings": {}}
        self._llm = None

    # ------------------------------------------------------------------ evidence
    def evidence(self, asset_id: str) -> dict:
        a = self.pack.asset(asset_id)
        cls = a["asset_class"]
        tel = telemetry_evidence(self.pack, asset_id, cls)
        ev = self.pack.events[self.pack.events.asset_id == asset_id]
        issue = a["issue_code"]
        related = ev[(ev.event_code == issue) | (ev.severity == "high")].head(8).to_dict("records")
        wos = self.pack.work_orders[self.pack.work_orders.asset_id == asset_id].head(6).to_dict("records")
        cases = self.pack.cases[(self.pack.cases.asset_class == cls) &
                                (self.pack.cases.historical_issue_code == issue)].to_dict("records")
        dq = self.pack.data_quality[self.pack.data_quality.asset_id == asset_id].to_dict("records")
        docs = [self.corpus.get(d) for d in (a["knowledge_doc_id"], f"DOC-ASSET-{asset_id[-3:]}",
                                              "DOC-FIELD-SAFETY", "DOC-RAG-GUIDE")]
        docs = [d for d in docs if d]
        binding = self.mapping.get("bindings", {}).get(asset_id)
        # confidence: model confidence, reduced by data-quality issues and weak 3D identity mapping (Q-06)
        conf = float(a["model_confidence"] or 0.5)
        dq_pen = sum(0.06 if d["severity"] == "high" else 0.03 for d in dq)
        map_conf = binding["mapping_confidence"] if binding else 0.5
        abnormal = [s for s in tel["signals"] if s["abnormal"]]
        support = min(1.0, 0.55 + 0.15 * len(abnormal) + 0.05 * min(len(related), 4) + 0.05 * min(len(cases), 3))
        overall = max(0.05, min(0.95, conf * support * (1 - min(dq_pen, 0.4)) * (0.6 + 0.4 * map_conf)))
        hyps = []
        for i, (h, comps) in enumerate(ISSUE_HYPOTHESES.get(issue, [("Unspecified deviation", [])])):
            hyps.append({"hypothesis": h, "components": comps, "rank": i + 1,
                         "status": "leading hypothesis" if i == 0 else "alternative — not excluded"})
        steps = [
            {"step": "Confirm asset identity on site (tag / QR / NFC) before acting.",
             "source": "DOC-3D-MAPPING", "why": "3D identity mapping is probabilistic"},
            {"step": f"{a['recommended_next_check'].capitalize()} — the check recommended for {issue}.",
             "source": f"DOC-ASSET-{asset_id[-3:]}"},
        ]
        for c in cases[:1]:
            steps.append({"step": c["safe_evidence_workflow"], "source": c["case_id"]})
        steps.append({"step": "Do not open or adjust the equipment without permit, isolation and lockout/tagout; "
                              "follow site procedures and OEM instructions.", "source": "DOC-FIELD-SAFETY"})
        return {
            "asset": {k: a[k] for k in ("asset_id", "tag", "asset_class", "area_name", "criticality", "health_score",
                                        "condition_state", "issue_code", "issue_summary", "urgency",
                                        "recommended_next_check", "model_confidence", "last_service_date",
                                        "service_interval_days", "connectivity_profile", "qr_id", "nfc_id")},
            "priority": priority_score(a),
            "binding": binding,
            "telemetry": tel,
            "events": related,
            "work_orders": wos,
            "similar_cases": cases[:5],
            "data_quality": dq,
            "documents": docs,
            "hypotheses": hyps,
            "next_steps": steps,
            "confidence": {"overall": round(overall, 2), "model_confidence": conf,
                           "evidence_support": round(support, 2), "data_quality_penalty": round(min(dq_pen, 0.4), 2),
                           "mapping_confidence": map_conf,
                           "explanation": "overall = model confidence × evidence support × (1 − data-quality penalty) "
                                          "× (0.6 + 0.4 × 3D mapping confidence)"},
            "synthetic_notice": "All asset data is synthetic (Valmet × Since AI builder pack).",
        }

    def valid_ids(self, ev: dict) -> set[str]:
        ids = {d["id"] for d in ev["documents"]} | {e["event_id"] for e in ev["events"]}
        ids |= {w["work_order_id"] for w in ev["work_orders"]} | {c["case_id"] for c in ev["similar_cases"]}
        ids |= {d["issue_id"] for d in ev["data_quality"]} | {ev["asset"]["asset_id"], ev["asset"]["tag"]}
        ids |= {"Telemetry_Sample_3d", "DOC-3D-MAPPING", "DOC-FIELD-SAFETY", "DOC-RAG-GUIDE"}
        ids |= {f"KB-XRAY-PUMP#{c['id']}" for c in KB_PUMP["components"]}
        return ids

    # ------------------------------------------------------------------ narration
    def _client(self):
        if not config.USE_LLM:
            return None
        if self._llm is None:
            try:
                from openai import OpenAI
                self._llm = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "proxy-injected"), timeout=40)
            except Exception:  # noqa: BLE001
                self._llm = False
        return self._llm or None

    def _check_citations(self, text: str, allowed: set[str]) -> tuple[str, list[str]]:
        bad = []

        def repl(m):
            ids = [x.strip() for x in m.group(1).split(",")]
            keep = [i for i in ids if i in allowed]
            bad.extend(i for i in ids if i not in allowed)
            return f"[{', '.join(keep)}]" if keep else ""
        out = re.sub(r"\[([^\[\]\n]{2,80})\]", repl, text)
        out = re.sub(r"[ \t]+([.,;:])", r"\1", re.sub(r"[ \t]{2,}", " ", out))
        return out, bad

    def template_summary(self, ev: dict) -> str:
        a = ev["asset"]
        ab = [s for s in ev["telemetry"]["signals"] if s["abnormal"]]
        top = ev["telemetry"]["signals"][:3]
        sig_txt = "; ".join(
            f"{s['signal']} {s['recent_mean']}{s['unit']} vs peers {s['peer_mean']}{s['unit']} (z={s['z_vs_peers']})"
            for s in top)
        ev_ids = ", ".join(e["event_id"] for e in ev["events"][:3])
        case_ids = ", ".join(c["case_id"] for c in ev["similar_cases"][:2])
        return (f"Observation: {a['tag']} ({a['asset_class']}, {a['area_name']}) is {a['condition_state']} with health "
                f"{a['health_score']} and issue {a['issue_code']} — {a['issue_summary']} [{a['asset_id']}]. "
                f"Telemetry (last 12 h): {sig_txt}; {len(ab)} signal(s) beyond the anomaly threshold [Telemetry_Sample_3d]. "
                f"Recent events: {ev_ids or 'none'}"
                + (f" [{ev_ids}]" if ev_ids else "") + ". "
                f"Hypothesis: {ev['hypotheses'][0]['hypothesis']} (similar historical cases"
                + (f" [{case_ids}]" if case_ids else "") + "); alternatives are not excluded. "
                f"Confidence {ev['confidence']['overall']:.2f} — reduced by {len(ev['data_quality'])} data-quality issue(s). "
                f"Next safe step: {ev['next_steps'][1]['step']} [{ev['next_steps'][1]['source']}]. "
                f"No physical work without permit and lockout/tagout [DOC-FIELD-SAFETY].")

    def narrate(self, ev: dict, question: str | None = None) -> dict:
        allowed = self.valid_ids(ev)
        client = self._client()
        if client is None:
            return {"text": self.template_summary(ev), "mode": "template", "invalid_citations": []}
        slim = {k: v for k, v in ev.items() if k != "telemetry"}
        slim["telemetry"] = [{k: s[k] for k in s if k != "series"} for s in ev["telemetry"]["signals"]]
        sys_prompt = (
            "You are a field-service copilot talking to a technician who has just reached the machine. Use ONLY the "
            "evidence JSON. Follow DOC-RAG-GUIDE. Write plain, calm English: no snake_case or ALL_CAPS codes in the prose "
            "(say 'process pump', 'fouling', 'attention required'); evidence IDs go only in square brackets, exactly as "
            "given, e.g. [EVT-00037], [CASE-025], [DOC-PROCESS_PUMP-CORE], [Telemetry_Sample_3d]. Use exactly these five "
            "labelled lines, each one or two short sentences: 'Observation:', 'Evidence:', 'Hypothesis:', 'Uncertainty:', "
            "'Next safe step:'. Give confidence as a percentage. Never give disassembly or repair instructions; recommend "
            "verification and escalation (DOC-FIELD-SAFETY). At most 130 words.")
        user = (f"Question: {question or 'Diagnose this device for the arriving technician.'}\n\nEVIDENCE JSON:\n"
                + json.dumps(slim, default=str)[:24000])
        try:
            r = client.chat.completions.create(model=config.LLM_MODEL, messages=[
                {"role": "system", "content": sys_prompt}, {"role": "user", "content": user}])
            text = r.choices[0].message.content.strip()
            text, bad = self._check_citations(text, allowed)
            return {"text": text, "mode": f"llm:{config.LLM_MODEL}", "invalid_citations": bad}
        except Exception as e:  # noqa: BLE001
            return {"text": self.template_summary(ev), "mode": f"template (LLM unavailable: {type(e).__name__})",
                    "invalid_citations": []}

    def diagnose(self, asset_id: str) -> dict:
        ev = self.evidence(asset_id)
        ev["narrative"] = self.narrate(ev)
        return ev

    # ------------------------------------------------------------------ free-form questions
    def answer(self, question: str, asset_id: str | None = None, component: str | None = None) -> dict:
        scope = None
        ev = None
        if asset_id:
            ev = self.evidence(asset_id)
            scope = ev["asset"]["asset_class"]
        q = question + (f" {component}" if component else "")
        hits = self.corpus.search(q, k=6, scope=scope)
        if component:
            kb = self.corpus.get(f"KB-XRAY-PUMP#{component}")
            if kb and kb not in hits:
                hits.insert(0, kb)
        allowed = {h["id"] for h in hits} | (self.valid_ids(ev) if ev else set())
        client = self._client()
        if client is None:
            body = " ".join(f"{h['text']} [{h['id']}]" for h in hits[:3])
            return {"text": body or "No supporting document found in the builder pack.", "sources": hits,
                    "mode": "retrieval-only"}
        context = json.dumps({"retrieved": [{k: h[k] for k in ("id", "title", "text", "source")} for h in hits],
                              "asset_evidence": ({k: v for k, v in ev.items() if k not in ("telemetry",)}
                                                 if ev else None)}, default=str)[:20000]
        sys_prompt = ("Answer the technician's question using ONLY the context. Cite IDs in square brackets. "
                      "If the context does not support an answer, say so. Mark illustrative/training (KB-XRAY-PUMP) "
                      "content as general training knowledge, not OEM instructions. No step-by-step repair or "
                      "disassembly procedures. Max 120 words.")
        try:
            r = client.chat.completions.create(model=config.LLM_MODEL, messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": f"Question: {question}\nSelected component: {component}\nContext: {context}"}])
            text, bad = self._check_citations(r.choices[0].message.content.strip(), allowed)
            return {"text": text, "sources": hits, "mode": f"llm:{config.LLM_MODEL}", "invalid_citations": bad}
        except Exception as e:  # noqa: BLE001
            body = " ".join(f"{h['text']} [{h['id']}]" for h in hits[:3])
            return {"text": body, "sources": hits, "mode": f"retrieval-only ({type(e).__name__})"}
