"""Pre-generate the hosted demo's copilot FAQ with the real backend copilot (does NOT touch the diagnoses).

The hosted (static) demo has no live LLM. So that its "Ask about the plant" box still gives real, grounded answers,
this script asks the backend copilot — the same evidence engine, retrieval and citation checker as the live API —
a broad set of questions a technician or a judge would ask:
  * for EVERY workbook asset: what is wrong, why it is flagged, what to check first, whether it is safe to keep
    running, what evidence supports the diagnosis, its maintenance history, confidence, data quality, telemetry;
  * general questions about the plant, the data and how the prototype works (labels, routes, Plan, Support, pilot...).
The browser (web/src/static-api.js) matches a typed question to the closest entry (a named tag must match) and shows
the answer labelled "Pre-generated answer to a similar question".

  python scripts/export_faq.py             # LLM answers (needs the OpenAI API / proxy), ~2–4 min, 12 threads
  python scripts/export_faq.py --no-llm    # offline: evidence + document-search answers
  python scripts/export_faq.py --corpus    # also rewrite static/corpus.json (adds the product docs, so their
                                           # citations open in the hosted demo)
"""
from __future__ import annotations

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from xray import config  # noqa: E402
from xray.world import World  # noqa: E402

OUT = config.ROOT / "web" / "public" / "static"

# per-asset questions: (intent key, question template). The intent key lets the browser match paraphrases.
ASSET_QS = [
    ("wrong", "What's wrong with {tag}?"),
    ("flagged", "Why is {tag} flagged?"),
    ("check", "What should I check first on {tag}?"),
    ("safe", "Is {tag} safe to keep running?"),
    ("evidence", "What evidence supports the {tag} diagnosis?"),
    ("history", "What is the maintenance history of {tag}?"),
    ("confidence", "How confident is the diagnosis for {tag}?"),
    ("dq", "Are there data-quality issues for {tag}?"),
    ("telemetry", "What does the telemetry show for {tag}?"),
]

# general questions: (question, [paraphrases that should map to it])
GENERAL_QS = [
    ("Which assets need attention first?", ["what should I look at first", "top priority assets", "most urgent equipment", "what needs maintenance first", "which equipment is in the worst condition"]),
    ("Which motor is overheating?", ["hot motor", "motor temperature high", "which motor runs hot"]),
    ("Which pump is in the worst condition?", ["worst pump", "faulty pump", "which pump needs attention"]),
    ("Which control valves are degraded?", ["valve problems", "which valves have issues", "bad valves"]),
    ("Which assets are healthy?", ["what is working fine", "healthy equipment", "which machines are ok"]),
    ("How many assets are in the workbook and what types are they?", ["how many assets", "what equipment is there", "asset types", "list the equipment classes"]),
    ("Why is P-005 the target of the demo?", ["why p-005", "why was this pump chosen", "how was the target chosen"]),
    ("How were the objects in the scan labelled?", ["how did you label objects", "how are objects recognised", "object recognition", "how does semantic segmentation work", "how were the frames made"]),
    ("How accurate are the object labels?", ["label accuracy", "can I trust the labels", "precision of labels", "how good is the object detection"]),
    ("How are workbook assets linked to objects in the scan?", ["asset mapping", "how do you know which object is P-005", "mapping confidence", "how are assets matched to the 3d scan"]),
    ("How does the robot plan routes?", ["route planning", "how does navigation work", "path planning", "how does the robot avoid obstacles", "how is the route computed"]),
    ("What happens when I block the aisle?", ["block aisle", "reroute", "what if the walkway is blocked", "dynamic obstacle"]),
    ("Is the route collision-free?", ["route validation", "does the robot collide", "clearance of the route"]),
    ("What does proximity reading mean?", ["proximity", "what does the robot read along the route", "nearby assets"]),
    ("What data is real and what is synthetic?", ["is this real data", "synthetic data", "is the plant data real", "what is simulated", "where does the data come from"]),
    ("What is the builder pack workbook?", ["builder pack", "workbook", "excel data", "which sheets are used"]),
    ("What does Plan mode do?", ["plan mode", "maintenance planning", "layout simulation", "move equipment virtually"]),
    ("What does Support mode do?", ["support mode", "remote support", "remote expert", "hand-off to an expert"]),
    ("What is the X-Ray view?", ["x-ray view", "exploded model", "teaching model", "are the x-ray models real"]),
    ("What are Learn and Practice?", ["learn mode", "practice mode", "training", "can I practise"]),
    ("How is the diagnosis confidence calculated?", ["confidence formula", "how confident is the copilot", "confidence score"]),
    ("How does the copilot avoid making things up?", ["hallucination", "citations", "how is the ai grounded", "can I trust the ai", "citation check"]),
    ("What can I ask the copilot?", ["what can you do", "help", "what questions can I ask", "how do I use the copilot"]),
    ("Is the hosted demo using live AI?", ["offline demo", "is this live ai", "static mode", "pre-generated answers"]),
    ("Can the app control plant equipment?", ["control", "can it stop the pump", "does it write to the plant", "is it read only", "can it open a valve"]),
    ("What would a pilot measure?", ["pilot kpis", "how would you validate this", "what metrics", "success criteria", "kpi"]),
    ("How would it connect to real plant data?", ["opc ua", "mqtt", "historian", "cmms integration", "connect to plant systems", "integration"]),
    ("What are the main limitations of the prototype?", ["limitations", "what does it not do", "weaknesses", "what is missing"]),
    ("What is the Value page?", ["value", "savings", "roi", "business value"]),
    ("Can I create a work order?", ["work order", "draft work order", "send to cmms"]),
    ("What safety rules apply before working on equipment?", ["safety", "lockout tagout", "permit", "loto", "is it safe to work on it"]),
    ("What is fouling in a process pump?", ["fouling", "deposits in pump", "pump efficiency loss"]),
    ("What is cavitation risk?", ["cavitation", "pump cavitation"]),
    ("What does misalignment look like in the data?", ["misalignment", "shaft misalignment"]),
    ("What is current imbalance in a motor?", ["current imbalance", "phase imbalance"]),
    ("What causes a control valve position deviation?", ["position deviation", "valve not reaching setpoint", "stiction"]),
    ("What is calibration drift?", ["calibration drift", "transmitter drift", "sensor drift"]),
    ("What is a vibration sensor mounting issue?", ["mounting issue", "loose sensor"]),
    ("Why do data-quality issues lower confidence?", ["data quality", "missing data", "timestamp jitter"]),
    ("Which assets have high vibration?", ["abnormal vibration", "vibrating equipment"]),
    ("How was the 3D scan processed?", ["scan processing", "gaussian splat", "how big is the scan", "the 3d scan", "point cloud"]),
    ("Does it work without a GPU or on a phone?", ["phone", "mobile", "no webgl", "2d floor plan", "slow laptop"]),
    ("What should a technician do on arrival at P-005?", ["arrival", "first steps on site", "what to do when I get there"]),
    ("Which alarms are open?", ["open alarms", "active alarms", "current alarms"]),
    ("Who should I escalate to?", ["escalation", "who do I call", "expert help"]),
    ("How are similar historical cases used?", ["historical cases", "similar cases", "past cases"]),
    ("What documents are in the library?", ["library", "manuals", "documents", "knowledge base"]),
    ("Are the manuals from the manufacturer?", ["oem manuals", "official manuals", "manufacturer documentation"]),
    ("Which areas of the plant have problems?", ["areas", "which area", "plant sections"]),
    ("Which assets are overdue for service?", ["overdue", "service interval", "last service"]),
]


def cited(text: str) -> list[str]:
    return list(dict.fromkeys(i.strip() for m in re.findall(r"\[([^\[\]\n]{2,80})\]", text) for i in m.split(",")))


def main(with_llm: bool = True, write_corpus: bool = False) -> None:
    config.USE_LLM = with_llm
    w = World()
    cp = w.copilot
    jobs = []
    for aid, a in w.assets_summary.items():
        for key, tpl in ASSET_QS:
            jobs.append({"q": tpl.format(tag=a["tag"]), "intent": key, "tag": a["tag"], "asset_id": aid})
    for q, alts in GENERAL_QS:
        tag = re.search(r"\b([A-Z]{1,3}-\d{3})\b", q)
        aid = next((x for x, a in w.assets_summary.items() if tag and a["tag"] == tag.group(1)), None)
        jobs.append({"q": q, "intent": "general", "tag": None, "asset_id": aid, "alts": alts})

    def run(job):
        for attempt in range(3):
            r = cp.answer(job["q"], job["asset_id"], hint=" ".join(job.get("alts", [])) or None)
            if not with_llm or str(r.get("mode", "")).startswith("llm"):
                break
            time.sleep(2 + 3 * attempt)
        ids = cited(r["text"])
        titles = {d["id"]: d for d in r.get("sources", [])}
        src = [{"id": i, "title": (titles.get(i) or cp.corpus.get(i) or {}).get("title")} for i in ids]
        return {**job, "text": r["text"], "mode": r.get("mode"), "invalid_citations": r.get("invalid_citations", []),
                "sources": src}

    t0 = time.time()
    with ThreadPoolExecutor(12) as ex:
        faq = list(ex.map(run, jobs))
    for i, f in enumerate(faq):
        f["id"] = f"FAQ-{i + 1:03d}"
    llm = sum(1 for f in faq if str(f["mode"]).startswith("llm"))
    out = {"generated": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "model": config.LLM_MODEL if with_llm else None,
           "note": "Answers generated in advance by the backend copilot (evidence engine + retrieval + citation check) "
                   "from the synthetic builder pack and the product documentation. No live AI in the hosted demo.",
           "count": len(faq), "llm_answers": llm, "faq": faq}
    (OUT / "faq.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str))
    if write_corpus:
        (OUT / "corpus.json").write_text(json.dumps(cp.corpus.docs, default=str))
    bad = sum(len(f["invalid_citations"]) for f in faq)
    print(f"faq: {len(faq)} answers ({llm} LLM) in {time.time() - t0:.0f}s, {bad} invalid citations stripped, "
          f"{(OUT / 'faq.json').stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main(with_llm="--no-llm" not in sys.argv, write_corpus="--corpus" in sys.argv)
