# Pitch deck (7 slides) + demo-video script (≤ 5 min)

## Slides

**1 · Industrial X-Ray AI — From Factory to Component**
A raw 3D scan becomes a plant that knows its equipment: it finds the fault, drives a safe route there, explains the
diagnosis with evidence, and lets the technician look inside the machine.
*Visual: the splat scene with coloured asset frames and the robot route.*

**2 · The problem**
Field-service context is split across the physical space, condition data and documents, and raw splat scans have no
semantics. *Visual: the raw splat next to the same view with frames.*

**3 · Semantic 3D extraction (30 %)**
Plane fitting → recursive DBSCAN → pipe merging → oriented 3-D frames → VLM labels on renders → human review layer.
**170 objects**, floor, ceiling and wall, each label with its confidence and source. *Visual: before/after, category chips.*
Data-integrity finding: only 33.4 % of the supplied PLY is valid (record 502,483 onward is random bytes in every copy).
The pipeline flags this instead of hiding it, and re-runs on a repaired file.

**4 · Obstacle-aware navigation (25 %)**
Multi-level height-field (main floor plus a raised area at +0.62 m) → clearance-aware A* → LOS smoothing →
**independent validation** (min clearance 0.206 m ≥ 0.20 m robot radius, 0 collisions, about 12 ms). Live rerouting
around a blocked walkway. Proximity framing within 1.2 m (87 objects and 16 assets along the route).
*Visual: the nav grid overlay and the reroute ghost path.*

**5 · Grounded diagnostics (20 %)**
Evidence engine (telemetry z-scores against own baseline and peers, alarms, work orders, similar cases, data quality)
→ LLM narration that may cite only evidence IDs. The server strips unsupported IDs. The confidence calculation is
shown: 0.52 for P-005, lowered by data-quality issues and the mapping. Safe next steps follow DOC-FIELD-SAFETY.
*Visual: the diagnosis panel.*

**6 · From facility to component: X-Ray, Learn, Practice**
Exploded *illustrative* pump with suspected parts linked to the diagnosis, component Q&A with citations, guided
tutorials synced to 3D highlights, and a scored virtual exercise behind a safety gate. Clearly labelled as educational,
non-OEM and not connected to controls.

**7 · Architecture & business value**
Python pipeline + FastAPI (API_Contract) + three.js/Spark, with pytest guarantees. Illustrative ROI (hypothetical
inputs): if locating equipment and gathering evidence and documents takes about
25 min per corrective job today, and the copilot cuts that by 60 %, then a site with 600 such jobs a year saves
about 150 technician-hours a year (≈ €9 k at €60/h). That is before the effect of better first-time-fix rates
or the training value. *These are assumptions to validate with Valmet, not measurements.*

## Video script (target 4:30)

| t | Screen | Voice-over |
|---|---|---|
| 0:00 | Title → splat scene | “This is Valmet's boiler-room scan. Raw splats know nothing. Here is what our pipeline turns it into.” |
| 0:15 | Toggle frames all / assets; nav grid | “170 objects segmented and framed, floor and walls fitted, every label with its confidence and source. Green is where a robot can safely drive.” |
| 0:40 | Integrity badge → report | “The supplied file is two-thirds corrupt from record 502,483 onward, in every copy. We report it and use only the valid third. The pipeline re-runs on a fixed file.” |
| 1:00 | Ask “Where is the faulty pump?” | “The copilot ranks assets by criticality, health and confidence: P-005, a production-critical pump showing a fouling signature.” |
| 1:15 | “Send a technician…” → robot drives | “A* on the multi-level height-field, then validated: minimum clearance 0.206 m for a 0.2 m robot, zero collisions. Everything within 1.2 m gets framed and its status read from the workbook.” |
| 1:50 | Block walkway → reroute | “Someone parks a trolley in the aisle. We replan in milliseconds from where the robot is now.” |
| 2:10 | Arrival → diagnosis panel | “On arrival: observation, evidence, hypothesis, uncertainty and the next safe step. Every bracket is a real record: alarms, work orders, cases, documents. Unsupported citations are stripped automatically. Confidence is 0.52, and here is why.” |
| 2:55 | ENTER X-RAY MODE → explode | “Now inside the machine. This model is illustrative, not from the scan. The parts linked to the leading hypothesis glow red: impeller and volute. The wear ring is the alternative.” |
| 3:20 | Click impeller → ask | “Each part shows its function, symptoms, and P-005's own signals: flow down, current up.” |
| 3:40 | LEARN fouling | “Learn mode explains why fouling lowers flow but raises current, step by step and synced to 3D.” |
| 4:00 | PRACTICE quick run → summary | “Practice: a fictional bearing case behind a safety gate. Pick the part, answer, then disassemble in the right order. Scored, and never a substitute for certified training.” |
| 4:20 | Work-order draft → closing | “Finally, a draft work order with evidence IDs and safety prerequisites. From factory to component, explained and verifiable.” |
