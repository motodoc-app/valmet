# Industrial X-Ray AI — From Factory to Component

**Valmet × Since AI Hackathon 2026 · Industrial Metaverse: Semantic 3D Scene Understanding & Autonomous Field-Service Copilot**

A working demonstrator that turns Valmet's raw Gaussian-splat scan of a boiler room into a scene that *understands its
equipment*. An inspection robot drives a computed, collision-free route to a faulty pump, framing every asset it passes.
On arrival a grounded copilot explains the fault with cited evidence. The technician can then go *inside* the
machine (X-Ray), learn why the fault happens, and rehearse an inspection in a scored virtual exercise.

```
fault detected → machine located → safe navigation → grounded AI diagnosis → X-Ray component view → learn / practise → work-order draft
```

| Challenge criterion (weight) | What the demo shows |
|---|---|
| Semantic extraction & 3D frames (30 %) | **170 objects** segmented from the splats and boxed with oriented 3D frames. Floor, ceiling and wall are plane-fitted. A vision-language model labels each cluster from renders. Every label carries its confidence and source. |
| Obstacle-aware navigation & proximity (25 %) | 2.5-D multi-level height-field, clearance-aware A* and line-of-sight smoothing. **Every route is re-validated** (min clearance ≥ robot radius, 0 collisions). A blocked walkway triggers live rerouting (~10 ms). Objects within 1.2 m of the robot are framed and listed live. |
| Grounded AI diagnostics (20 %) | A deterministic evidence engine combines telemetry z-scores against the asset's own baseline and its peers, alarms, work orders, similar cases and data-quality issues. The LLM narration may cite **only IDs from that evidence package**, and the server strips any other ID. The confidence calculation is shown. A template fallback works offline. |
| Backend architecture (15 %) | Modular Python pipeline (`step1 → step2 → step3`) and a FastAPI service that follows the builder pack's `API_Contract`. Pytest covers the core guarantees. |
| Demo clarity & innovation (10 %) | Photoreal splats in the browser, a one-click robot dispatch, a natural-language command bar, and the facility → X-Ray → Learn → Practice journey. |

## Quick start (demo uses the committed, pre-processed data)

```bash
# backend
pip install -r requirements.txt
cd backend && uvicorn xray.api:app --port 8000          # http://localhost:8000/docs
# web (second terminal)
cd web && npm install && npm run dev -- --port 5173     # http://localhost:5173
```

* Optional AI narration: set `OPENAI_API_KEY` (model: `XRAY_LLM_MODEL`, default `gpt-5.4-mini`). Without it the copilot
  runs in **template mode**: the same evidence, confidence and citations, phrased by templates.
* Single process: `cd web && npm run build`, then `cd backend && python -m xray.api` serves the app at `http://localhost:8000`.
* Tests: `pytest -q` (offline, deterministic).

### Demo script (≈ 4 min)
1. **Facility.** The left panel shows 170 framed objects, 30 mapped assets and 5.5 m² of walkable floor. Toggle *Nav grid* to show walkable (green) and occupied (red) cells.
2. In the command bar, type **“Where is the faulty pump?”**. The camera flies to **P-005** (FOULING, health 44, A-critical).
3. Type **“Send a technician to inspect the faulty pump”**. A toast reports route length, compute time and validation (min clearance). The robot enters through the doorway, and assets within 1.2 m light up with status labels while the proximity feed fills.
4. Press **⛔ Block walkway**. A barrier drops on the route, A* replans from the robot's current position, and the old route stays visible as a ghost.
5. **Arrival.** The diagnosis panel shows the cited narrative, a confidence breakdown, telemetry sparklines with z-scores, alarms, work orders, similar cases, data-quality penalties and the next safe steps. Click any citation chip to open its source.
6. **ENTER X-RAY MODE.** The scan transitions to an exploded, *illustrative* pump. The impeller and volute are flagged red (leading hypothesis) and the wear ring amber (alternative). Click a part to see its function, symptoms and live evidence signals for P-005, then ask the copilot about it.
7. **LEARN → “Why does fouling lower flow but raise current?”** Each step highlights the relevant parts.
8. **PRACTICE.** Confirm the safety gate, then work through the bearing-degradation scenario: pick the component, answer the quiz, and do the virtual disassembly and reassembly in order. Finish on the scored summary.
9. Back in the facility, use **Draft work order** to produce a draft (no control actions) with evidence IDs and safety prerequisites.

## Pipeline

```
data/raw/industrial_boiler_room.ply ─┐
                                     ├─ scripts/step1_scene.py     integrity report, canonical frame, web .splat, caches
data/raw/builder_pack.xlsx ──────────┤─ scripts/step2_semantics.py planes + DBSCAN + OBBs (+ VLM labels + review layer)
                                     └─ scripts/step3_vlm.py       optional: label clusters with a VLM (cached)
backend/xray/api.py                  World = scene + NavMap + mapping + copilot  →  REST API
web/                                 three.js + Spark (Gaussian splats) UI
```

Re-run on a new or repaired scan: put the files in `data/raw/`, then run `python scripts/step1_scene.py && python scripts/step2_semantics.py && python scripts/step3_vlm.py && python scripts/step2_semantics.py`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the technical note and [`docs/PITCH.md`](docs/PITCH.md) for slides and the video script.

## ⚠ Scan integrity (read before judging coverage)

The supplied `Industrial Boiler Room.ply` declares 1,506,136 splats. Its size matches the header exactly, but
**records from #502,483 onward are random bytes**. The same corruption appears in the direct `.ply`, the two-part RAR
extraction and the ZIP copy (all have the same SHA-256). We use only the valid **502,483 splats (33.4 %)**. That is the
door-side section of the room with the pump set, pallet truck, cage, wall piping and circulation pumps. We do not
repair or invent the rest. The full report is in [`data/processed/integrity_report.md`](data/processed/integrity_report.md).
Every stage re-runs unchanged on a repaired file.

## Honesty notes

* **Labels.** Geometry proposes clusters, the VLM names them from renders, and a small review layer
  (`config/scene_annotations.json`) records **2** human corrections. The VLM had called a pallet truck a pump, and the
  real pump set was split into 5 fragments. Both are shown as `human-verified` in the UI. All other labels are
  automatic, and 54 stay "other equipment" with low confidence rather than being guessed.
* **Mapping.** The brief allows procedural mapping. Ours is class-aware with per-binding confidence, and a weak match
  ("class fallback") lowers diagnosis confidence.
* **Scale.** The scene is treated as approximately metric (ceiling 2.04 units, standard-size door). Scale is not surveyed.
* **Navigation scope.** The partial scan holds one well-reconstructed floor zone (5.5 m² walkable at a 0.2 m robot
  radius). A raised area 0.62 m higher is detected, but no stairs or ramp connect to it, so it is excluded rather than
  driven through.
* **X-Ray model.** The pump is procedurally generated for education. It is not from the scan, not an OEM drawing and
  not a Valmet product. Learn and Practice content is conceptual: no operational repair procedure, explicit safety gates,
  no connection to real controls.
* All asset data is synthetic (builder pack). Asset cards in the RAG corpus are generated from workbook rows because the
  `.md` files listed in `RAG_Corpus_Index` were not in the package.
