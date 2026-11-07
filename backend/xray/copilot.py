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

# Equipment library: one entry per asset class (exploded model, component knowledge, fault hypotheses,
# lessons, practice scenario). Adding a device type is a data change, not a code change.
LIBRARY = json.loads(config.LIBRARY_PATH.read_text())
# Product documentation (how the prototype works), so general questions ("how does the robot plan routes?",
# "what data is synthetic?") are answered from citable text instead of the model's own knowledge.
APP_DOCS_PATH = config.LIBRARY_PATH.parent / "app_docs.json"
APP_DOCS = json.loads(APP_DOCS_PATH.read_text()) if APP_DOCS_PATH.exists() else {"docs": [], "provenance": ""}


def kb_id(cls: str, component: str) -> str:
    return f"KB-XRAY-{cls}#{component}"


def hypotheses_for(cls: str, issue: str) -> list:
    """Class-specific hypotheses (with linked components) from the library; generic fallback otherwise."""
    if str(issue or "").upper() in ("NORMAL", "NONE", ""):
        return [["No active fault indicated; continue routine monitoring", []]]
    h = LIBRARY["classes"].get(cls, {}).get("hypotheses", {}).get(issue)
    if h:
        return h
    for other in LIBRARY["classes"].values():
        if issue in other.get("hypotheses", {}):
            return [[t, []] for t, _ in other["hypotheses"][issue]]
    return [["Unspecified deviation; verify locally", []]]


def record_checks(a: dict, tel: dict, events, wos) -> list[dict]:
    """Places where the workbook's records disagree with each other. Reported as uncertainty, never resolved by guessing."""
    out = []
    last_svc = str(a.get("last_service_date") or "")[:10]
    latest = wos.sort_values("opened_at").iloc[-1] if len(wos) else None
    if last_svc and latest is not None and last_svc > str(latest["opened_at"])[:10]:
        out.append({"check": "service_date_without_work_order", "source": a["asset_id"],
                    "text": f"Asset_Master gives last service {last_svc}, but the latest work order on record is "
                            f"{latest['work_order_id']} on {str(latest['opened_at'])[:10]}: no work order backs that date."})
    abnormal = [s for s in tel.get("signals", []) if s["abnormal"]]
    if a["condition_state"] != "healthy" and tel.get("signals") and not abnormal:
        out.append({"check": "condition_without_abnormal_telemetry", "source": "Telemetry_Sample_3d",
                    "text": f"Condition is {a['condition_state'].replace('_', ' ')}, but no signal in the 3-day telemetry "
                            "sample crosses the anomaly threshold: the condition rests on the Current_State record and "
                            "the events, not on a clear trend."})
    open_high = events[(events.status == "open") & (events.severity == "high")] if "status" in events else events.iloc[0:0]
    if a["condition_state"] == "healthy" and len(open_high):
        ids = ", ".join(open_high.event_id.head(3))
        out.append({"check": "healthy_with_open_high_events", "source": ids,
                    "text": f"Condition is healthy, but {len(open_high)} high-severity event(s) are still open ({ids}): "
                            "confirm on site which record is current."})
    return out


# a question about the selected asset (vs. one about the plant or the prototype): decides whether the offline answer
# leads with that asset's evidence
ASSET_Q = re.compile(r"\b(it|its|this|that|[a-z]{1,3}-\d{3})\b|check|safe|running|wrong|problem|evidence|history|confiden|"
                     r"telemetry|signal|why|suspect|fault|status|condition|health|serviced", re.I)


def _tok(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9_]+", s.lower()) if len(w) > 2]


_QSTOP = {"what", "how", "does", "the", "this", "that", "with", "for", "are", "can", "should", "which", "when", "where",
          "why", "who", "about", "there", "any", "you", "tell"}


def covered(question: str, hits: list[dict]) -> bool:
    """Weak matches (one rare word of four) are not answers: most of the question's words must be in the top source
    (same rule as the hosted demo's document search in web/src/static-api.js)."""
    qw = [w for w in _tok(question) if w not in _QSTOP]
    if not qw:
        return bool(hits)
    if not hits:
        return False
    top = _tok(f"{hits[0]['title']} {hits[0]['text']}")
    n = sum(1 for w in qw if any(x == w or x.startswith(w[:5]) for x in top))
    return n >= 2 or n / len(qw) >= 0.5


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
        for cls, lib in LIBRARY["classes"].items():
          for comp in lib["components"]:
            docs.append({"id": kb_id(cls, comp["id"]), "title": f"{comp['name']} ({lib['label'].lower()}, training note)",
                         "scope": cls, "component": comp["id"],
                         "text": f"{comp['name']}: {comp['function']} Typical symptoms: "
                                 f"{'; '.join(comp['failure_symptoms'])}. Signals: {', '.join(comp['evidence_signals'])}.",
                         "kind": "training_kb", "source": "Industrial X-Ray AI educational knowledge base (non-OEM)"})
        for d in APP_DOCS["docs"]:
            docs.append({"id": d["id"], "title": d["title"], "scope": "APP", "text": d["text"], "kind": "app_doc",
                         "source": "Industrial X-Ray product documentation (README / docs)"})
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
        all_wos = self.pack.work_orders[self.pack.work_orders.asset_id == asset_id]
        checks = record_checks(a, tel, ev, all_wos)
        # confidence: model confidence, reduced by data-quality issues and weak 3D identity mapping (Q-06)
        conf = float(a["model_confidence"] or 0.5)
        dq_pen = sum(0.06 if d["severity"] == "high" else 0.03 for d in dq)
        map_conf = binding["mapping_confidence"] if binding else 0.5
        abnormal = [s for s in tel["signals"] if s["abnormal"]]
        support = min(1.0, 0.55 + 0.15 * len(abnormal) + 0.05 * min(len(related), 4) + 0.05 * min(len(cases), 3))
        overall = max(0.05, min(0.95, conf * support * (1 - min(dq_pen, 0.4)) * (0.6 + 0.4 * map_conf)))
        hyps = []
        for i, (h, comps) in enumerate(hypotheses_for(cls, issue)):
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
            "work_order_count": int(len(all_wos)),
            "record_checks": checks,
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
        ids |= {i.strip() for c in ev.get("record_checks", []) for i in str(c["source"]).split(",")}
        cls = ev["asset"]["asset_class"]
        ids |= {kb_id(cls, c["id"]) for c in LIBRARY["classes"].get(cls, {}).get("components", [])}
        return ids

    # ------------------------------------------------------------------ narration
    # circuit breaker: after a quota error, rate limit, timeout or connection failure, skip the LLM for a while so
    # every fallback answer is instant instead of waiting on a dead network (venue Wi-Fi, exhausted credits)
    _down_until = 0.0

    def _trip(self, e: Exception) -> None:
        import time
        if type(e).__name__ in {"RateLimitError", "APITimeoutError", "APIConnectionError", "AuthenticationError", "PermissionDeniedError"}:
            type(self)._down_until = time.monotonic() + 300

    def _client(self):
        import time
        if not config.USE_LLM or time.monotonic() < type(self)._down_until:
            return None
        if self._llm is None:
            try:
                from openai import OpenAI
                self._llm = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "proxy-injected"), timeout=12, max_retries=0)
            except Exception:  # noqa: BLE001
                self._llm = False
        return self._llm or None

    def _check_citations(self, text: str, allowed: set[str]) -> tuple[str, list[str]]:
        bad = []

        def repl(m):
            ids = [x.strip() for x in re.split(r"[,;]", m.group(1)) if x.strip()]
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
                f"Evidence score {ev['confidence']['overall']:.2f} (not a calibrated probability) — reduced by {len(ev['data_quality'])} data-quality issue(s). "
                + "".join(f"Record check: {c['text']} [{c['source']}]. " for c in ev.get("record_checks", [])) +
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
            "'Next safe step:'. Give the confidence as an evidence score with two decimals (e.g. 0.52), never as a percentage or probability. The issue label comes from the workbook: say the records show it, never that you detected it. Never give disassembly or repair instructions; recommend "
            "verification and escalation (DOC-FIELD-SAFETY). Name the asset by its tag (P-005), not its asset ID. "
            "Cite telemetry statements with [Telemetry_Sample_3d] and "
            "the asset's condition with its asset ID. If record_checks lists records that disagree, say so under "
            "'Uncertainty:' and do not resolve the disagreement. A healthy asset with no fault hypothesis has no "
            "suspected fault: do not invent one. At most 130 words.")
        user = (f"Question: {question or 'Diagnose this device for the arriving technician.'}\n\nEVIDENCE JSON:\n"
                + json.dumps(slim, default=str)[:24000])
        try:
            r = client.chat.completions.create(model=config.LLM_MODEL, messages=[
                {"role": "system", "content": sys_prompt}, {"role": "user", "content": user}])
            text = r.choices[0].message.content.strip()
            text, bad = self._check_citations(text, allowed)
            return {"text": text, "mode": f"llm:{config.LLM_MODEL}", "invalid_citations": bad}
        except Exception as e:  # noqa: BLE001
            self._trip(e)
            return {"text": self.template_summary(ev), "mode": f"template (LLM unavailable: {type(e).__name__})",
                    "invalid_citations": []}

    def diagnose(self, asset_id: str) -> dict:
        ev = self.evidence(asset_id)
        ev["narrative"] = self.narrate(ev)
        return ev

    # ------------------------------------------------------------------ free-form questions
    def fleet(self) -> list[dict]:
        """Compact view of every workbook asset, highest maintenance priority first (citable by asset ID)."""
        if getattr(self, "_fleet", None) is not None:
            return self._fleet
        ev = self.pack.events
        open_ev = ev[ev.status == "open"] if "status" in ev else ev.iloc[0:0]
        n_open = open_ev.groupby("asset_id").size().to_dict()
        n_open_high = open_ev[open_ev.severity == "high"].groupby("asset_id").size().to_dict()
        rows = []
        for a in self.pack.assets.to_dict("records"):
            rows.append({"asset_id": a["asset_id"], "tag": a["tag"], "class": a["asset_class"], "area": a["area_name"],
                         "criticality": a["criticality"], "condition": a["condition_state"], "health": a["health_score"],
                         "issue": a["issue_code"], "summary": a["issue_summary"], "urgency": a["urgency"],
                         "last_service": str(a["last_service_date"])[:10], "service_interval_days": a["service_interval_days"],
                         "open_alarms_events": int(n_open.get(a["asset_id"], 0)),
                         "open_high_severity": int(n_open_high.get(a["asset_id"], 0)),
                         "priority": priority_score(a), "card": f"DOC-ASSET-{a['asset_id'][-3:]}"})
        self._fleet = sorted(rows, key=lambda r: -r["priority"])
        return self._fleet

    def retrieve(self, question: str, scope: str | None = None, component: str | None = None,
                 general: bool = False) -> list[dict]:
        """Top documents for a question: workbook docs/cards/cases (scoped to the asset class) + product docs."""
        q = question + (f" {component}" if component else "")
        hits = self.corpus.search(q, k=5, scope=scope)
        for h in self.corpus.search(q, k=4 if general else 2, kinds=["app_doc"]):
            if h["score"] >= (1.0 if general else 2.0) and all(h["id"] != x["id"] for x in hits):
                hits.append(h)
        if component:
            kb = self.corpus.get(kb_id(scope, component)) if scope else next(
                (d for d in self.corpus.docs if d.get("component") == component), None)
            if kb and all(kb["id"] != h["id"] for h in hits):
                hits.insert(0, kb)
        return hits

    @staticmethod
    def compose(hits: list[dict], n: int = 3) -> str:
        """Readable answer from the top documents: one or two sentences per source, each with its [ID]."""
        out = []
        for h in hits[:n]:
            sents = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", str(h["text"]).strip())
            body = " ".join(sents[:2]).strip().replace(" 00:00", "")
            body = re.sub(r"\b[A-Z]+(?:_[A-Z]+)+\b", lambda m: m.group(0).lower().replace("_", " "), body)
            if len(body) > 320:
                body = body[:300].rsplit(" ", 1)[0] + "…"
            out.append(f"{h['title']}: {body} [{h['id']}]")
        return "\n".join(out) or "No supporting document found in the builder pack."

    def offline_text(self, ev: dict | None, hits: list[dict], question: str = "") -> str:
        """No LLM: the selected asset's key evidence (if any) followed by the top documents, all cited."""
        if not ev:
            return self.compose(hits) if covered(question, hits) else (
                f"Nothing in the builder pack or the product documentation matches “{question}”. Try naming an asset "
                "(“What should I check first on P-005?”), a symptom (“Which motor is overheating?”) or a feature "
                "(“How does the robot plan routes?”).")
        a, h0, nxt = ev["asset"], ev["hypotheses"][0], ev["next_steps"][1]
        lead = (f"{a['tag']}: {a['condition_state'].replace('_', ' ')}, health {a['health_score']}, "
                f"{str(a['issue_summary']).rstrip('.')} [{a['asset_id']}]. Leading hypothesis: {h0['hypothesis']}. "
                f"Recommended next check: {nxt['step']} [{nxt['source']}] No physical work without permit and "
                f"lockout/tagout [DOC-FIELD-SAFETY].")
        rest = [h for h in hits if h["id"] not in (nxt["source"], a["asset_id"])]
        return lead + "\n" + self.compose(rest, 2)

    def answer(self, question: str, asset_id: str | None = None, component: str | None = None,
               history: list[dict] | None = None, hint: str | None = None) -> dict:
        """Free question -> grounded answer. Context = the selected asset's evidence (if any) + retrieved documents +
        the fleet table; the last turns of the conversation make follow-ups ("and what should I check first?") work.
        Every [ID] in the LLM's text is checked against that context and removed if unknown."""
        scope = None
        ev = None
        if asset_id:
            ev = self.evidence(asset_id)
            scope = ev["asset"]["asset_class"]
        history = [h for h in (history or []) if isinstance(h, dict) and h.get("q")][-3:]
        rq = question
        if history and len(_tok(question)) <= 6:          # short follow-up: retrieve with the previous question too
            rq = f"{question} {history[-1]['q']}"
        if hint:                                           # extra retrieval words (paraphrases), never shown to the LLM
            rq += f" {hint}"
        if ev:
            rq += f" {ev['asset']['issue_code'].replace('_', ' ').lower()}"
        hits = self.retrieve(rq, scope, component, general=ev is None)
        fleet = self.fleet()
        allowed = {h["id"] for h in hits} | (self.valid_ids(ev) if ev else set())
        allowed |= {r["asset_id"] for r in fleet} | {r["tag"] for r in fleet} | {r["card"] for r in fleet}
        allowed |= {"Telemetry_Sample_3d", "DOC-FIELD-SAFETY", "DOC-RAG-GUIDE", "DOC-3D-MAPPING"}
        client = self._client()
        if client is None:
            return {"text": self.offline_text(ev if ASSET_Q.search(question) else None, hits, question), "sources": hits, "mode": "retrieval-only", "asset_id": asset_id}
        slim = None
        if ev:
            slim = {k: v for k, v in ev.items() if k not in ("telemetry", "documents")}
            slim["telemetry"] = [{k: s[k] for k in s if k != "series"} for s in ev["telemetry"]["signals"]]
            slim["documents"] = [{"id": d["id"], "title": d["title"], "text": d["text"]} for d in ev["documents"]]
        context = json.dumps({"selected_asset_evidence": slim,
                              "retrieved_documents": [{k: h[k] for k in ("id", "title", "text")} for h in hits],
                              "fleet_by_priority": fleet}, default=str)[:32000]
        sys_prompt = (
            "You are the copilot of Industrial X-Ray, a pre-visit tool for field technicians. Answer the question "
            "using ONLY the context JSON (the selected asset's evidence package, retrieved documents and the fleet "
            "table). Start with the direct answer, then the key evidence. Plain, calm English, 2 to 5 short sentences, "
            "at most 110 words; no headings; a short list only if the question asks for several items. Write codes in "
            "plain words (say 'fouling', 'attention required', not FOULING). Every factual statement must end with "
            "the ID of its source in square brackets exactly as given, e.g. [ASSET-017], [EVT-00037], [CASE-025], "
            "[DOC-APP-NAV], [Telemetry_Sample_3d]; never invent an ID, number or fact. If the context does not "
            "answer the question, say so plainly and say what it does contain. The asset data is synthetic (builder "
            "pack); KB-XRAY notes are general training knowledge, not OEM instructions. This is decision support "
            "only: never decide that equipment is safe, never give repair, disassembly or control instructions; "
            "recommend verification and escalation under site procedures and lockout/tagout [DOC-FIELD-SAFETY]; "
            "asked whether something is safe, say the tool cannot judge that and the decision belongs to site "
            "procedures and qualified personnel, then give the evidence. "
            "The confidence value is an evidence score, not a probability; never present it as a percentage chance. The issue label (e.g. fouling) is recorded in the workbook: explain it, never claim you discovered it. Name assets by their tag (P-005, M-006) and cite fleet-table rows by their asset_id (one ID per bracket "
            "or comma-separated); the table's name is not an ID. Never name people, roles or teams that are not in "
            "the context. Do not offer to do more work and do not end with a question. "
            "The evidence lists only the latest work orders; work_order_count is the total on record, so never count the "
            "list as the whole history. If record_checks says records disagree, say so when it is relevant and do not "
            "resolve it. "
            "Earlier turns are given for follow-up questions; resolve 'it', 'this' or 'that' from them.")
        msgs = [{"role": "system", "content": sys_prompt}]
        for h in history:
            msgs.append({"role": "user", "content": str(h["q"])[:300]})
            msgs.append({"role": "assistant", "content": str(h.get("a", ""))[:700]})
        sel = f"{ev['asset']['tag']} ({ev['asset']['asset_id']})" if ev else "none"
        msgs.append({"role": "user", "content": f"Question: {question}\nSelected asset: {sel}\n"
                                                 f"Selected component: {component or 'none'}\nContext: {context}"})
        try:
            r = client.chat.completions.create(model=config.LLM_MODEL, messages=msgs)
            text, bad = self._check_citations(r.choices[0].message.content.strip(), allowed)
            return {"text": text, "sources": hits, "mode": f"llm:{config.LLM_MODEL}", "invalid_citations": bad,
                    "asset_id": asset_id}
        except Exception as e:  # noqa: BLE001
            self._trip(e)
            return {"text": self.offline_text(ev if ASSET_Q.search(question) else None, hits, question), "sources": hits, "mode": f"retrieval-only ({type(e).__name__})",
                    "asset_id": asset_id}
