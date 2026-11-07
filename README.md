# Industrial X-Ray — From Factory to Component

**Valmet × Since AI Hackathon 2026 · Industrial Metaverse: Semantic 3D Scene Understanding & Autonomous Field-Service Copilot**

The demonstrator takes a raw Gaussian-splat scan of an equipment room and works out what is in it. An inspection robot
plans a collision-free route to a faulty pump and reads every asset it passes. On arrival, a copilot explains the fault
using cited evidence. The technician can then open an X-Ray view of the machine, learn why the fault happens and
rehearse the inspection.

```
fault detected → located → safe route (live reroute) → grounded diagnosis → X-Ray component view → learn / practise → work-order draft
```

| Criterion (weight) | What the demo shows |
|---|---|
| Semantic extraction & 3D frames (30 %) | **676 objects** with oriented 3D frames, plus floor, ceiling and **4 walls** fitted as planes, from the full 1.68 M-splat scan. A vision-language model names every cluster from renders, and each label carries its confidence and source. Four human review corrections are recorded and visible in the UI. |
| Obstacle-aware navigation & proximity (25 %) | Multi-level height-field, clearance-aware A*, smoothing and an **independent validation** pass. The demo route is **8.4 m across the room**, with 0 collisions and minimum clearance of at least the 0.20 m robot radius. **Block aisle** reroutes live in about 10–20 ms. Every object within 1.2 m is framed (208 along the route), and the 19 workbook assets passed are read out. |
| Grounded AI diagnostics (20 %) | A deterministic evidence engine combines telemetry z-scores against the asset's own baseline and its peers, alarms, work orders, similar cases and data-quality issues. The LLM narration may cite **only** IDs from that evidence; the server removes anything else. The confidence calculation is shown (0.52 for P-005). |
| Backend architecture (15 %) | Modular Python pipeline and a FastAPI service following the workbook's `API_Contract`. Pytest covers the core guarantees. A serverless export runs the same app as a static site. |
| Demo clarity & innovation (10 %) | Photoreal splats in the browser, natural-language commands, and a calm studio-style UI. The journey runs facility → X-Ray → Learn → Practice. |

## What is automatic, what is labelled, what is illustrative

| Feature | How it works | Status |
|---|---|---|
| 3D environment | Gaussian-splat scan rendered in the browser; orbit, zoom, click any frame | Real scan |
| Object frames (676) | Plane fitting + clustering on the point cloud, fully automatic | Automatic |
| Object names | A vision model labels each cluster from rendered views; confidence shown; 258 left as "other equipment" | Automatic, 4 human corrections (marked) |
| Scene search (“Where is the expansion vessel?”) | Searches those labels and workbook tags across the whole scan | Automatic |
| Asset ↔ object link | Class-aware procedural mapping with a stated confidence (the brief allows this) | Procedural |
| Navigation, reroute, proximity | Computed from the scan's floor and obstacles; every route validated | Automatic |
| Diagnosis | Workbook telemetry, alarms, work orders, cases and documents; LLM wording limited to cited IDs | Grounded in synthetic data |
| Exploded models, lessons, practice | One library entry per equipment type (pump, motor, control valve, pressure transmitter, vibration sensor) | Illustrative teaching models, not from the scan, not OEM |
| Manuals | Retrieval over the builder pack's documents and the training notes, with citations | No OEM manuals were supplied |
| Value page | Calculator with editable, clearly hypothetical inputs and the formula shown | Illustrative |

### Every feature works for every device
All 30 workbook assets get the same flow: select (in the scan, the list or by asking) → equipment card with its
function and components → diagnosis → X-Ray exploded model of its type → lesson → practice → work order. Device
behaviour lives in data, not code: `backend/xray/knowledge/equipment.json` holds, per asset class, the exploded model
(built from a small shape vocabulary), component knowledge, fault-to-component hypotheses, lessons and a practice
scenario. Adding a new equipment type means adding one entry to that file. `pytest` checks that every class in the
workbook has a complete entry and that every faulty asset's diagnosis points at real components of its model.

## Run it

```bash
pip install -r requirements.txt
cd backend && uvicorn xray.api:app --port 8000      # API + docs at http://localhost:8000/docs
cd web && npm install && npm run dev                 # http://localhost:5173 (uses the live API)
```

* **AI narration:** set `OPENAI_API_KEY` (`XRAY_LLM_MODEL`, default `gpt-5.4-mini`). Without it the copilot runs in
  template mode with the same evidence, confidence and citations.
* **Hosted / static mode:** `python scripts/export_static.py && cd web && npm run build` produces `web/dist`, a static
  site with no server. Routes and reroutes are planned in the browser by a JS port of `navigation.py`, and the
  diagnoses are the backend's own output, generated at export time.
* **Tests:** `pytest -q`.

### Rebuild from the raw scan
Put `equipment_room.ply` and `builder_pack.xlsx` in `data/raw/` (see `data/raw/README.md`), then run:
```bash
python scripts/step1_scene.py      # integrity report, canonical frame, web splat, caches
python scripts/step2_semantics.py  # planes, objects, 3D frames (+ cached VLM labels + review layer)
python scripts/step3_vlm.py        # optional: label clusters with a vision-language model (cached)
python scripts/step2_semantics.py  # merge labels
```

## Demo script (≈ 4 min)
1. **Facility.** The left list shows the 30 workbook assets in priority order. Hover over the scan: 676 frames,
   with assets coloured by condition. In the dock, switch frames between *All*, *Assets* and *Off*, and turn on
   *Floor map* to see the drivable floor.
2. Press **/** and ask **“Where is the faulty pump?”**. The camera flies to **P-005**: fouling, health 44, production-critical.
3. Ask **“Send a technician to inspect the faulty pump”**. The robot crosses the room, assets light up as it passes
   and the right card lists every asset it reads.
   Switch the camera in the bottom bar: **Chase** (behind the robot), **Broadcast** (high TV-style side camera),
   **Top** (whole room from above, ceiling cut away) or **Free**. The mini-map shows the robot, route, barriers and
   every asset; click it to look at any spot.
4. Press **Block aisle**. A barrier drops across the route ahead and the robot replans from where it is. The old
   route stays visible as a dashed line.
5. **Arrival.** The diagnosis card has three tabs. *Overview* covers observation, evidence, hypothesis, uncertainty,
   the next safe step and the confidence breakdown. *Evidence* has telemetry sparklines with z-scores, alarms, work
   orders and data quality. *Sources* lists the documents. Click any citation to open it.
6. **Open X-Ray view.** An exploded illustrative pump appears on a studio podium. The parts linked to the leading
   hypothesis (impeller, volute) are marked *Suspected* and the alternative (wear ring) is marked separately. Use
   the explode slider, see-through and labels, isolate a component, and check its evidence or ask about it.
7. **Learn.** Work through the fouling lesson; each step highlights the parts it describes. **Practice:** confirm
   the safety gate, then do the bearing exercise (pick the part, quiz, disassemble and reassemble in order) and
   finish on the scored summary.
8. **Draft work order.** A draft with evidence IDs and safety prerequisites; it triggers no control actions.
9. **Any device.** Ask “Where is the expansion vessel?” (scene search), click any asset and choose *Explain and show
   components*, or switch device in the X-Ray list: motor, control valve, transmitter and vibration sensor all have
   their own exploded model, lesson and practice exercise.
10. **Value.** Adjust the hypothetical inputs and see the formula update; the page lists what a pilot should measure.

## Data notes
* **Scan.** `Equipment Room.ply`: 1,676,481 splats, all valid (`data/processed/integrity_report.md`). The originally
  distributed `Industrial Boiler Room.ply` was corrupt from record 502,483 onward, identically in the PLY, RAR and
  ZIP copies. That report is kept in `docs/integrity_original_boiler_room.md`.
* **Labels.** Geometry proposes clusters and the vision model names them; 258 objects remain "other equipment"
  rather than being guessed. The review layer (`config/scene_annotations.json`) records 4 corrections, each tagged
  `human-verified` with a note: the pump set fragments were merged, and a pallet truck, a pressure washer and a
  chair that the model had called pumps were relabelled.
* **Mapping** is class-aware and procedural, as the brief allows. It prefers objects along the demo route, and
  every binding states its method and confidence.
* **Scale** is treated as approximately metric (ceiling 2.05 units); it was not surveyed.
* **The X-Ray pump** is a procedural teaching model. It is not from the scan, not an OEM drawing and not a Valmet
  product. Learn and Practice content is conceptual, sits behind explicit safety gates and has no connection to any
  control system. All asset data is synthetic.

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (technical note) · [`docs/PITCH.md`](docs/PITCH.md) (slides and video script).
