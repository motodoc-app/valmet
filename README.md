# Industrial X-Ray — the pre-visit copilot

**Valmet × Since AI Hackathon 2026 · Industrial Metaverse: Semantic 3D Scene Understanding & Autonomous Field-Service Copilot**

**Explore the site. Understand the equipment. Plan the maintenance. Practise the task. Get expert support — before
stepping onto the factory floor.**

Industrial X-Ray turns a scan of an unfamiliar industrial site into an interactive workspace. The demo follows one
technician preparing to service pump P-005: find it in the real 3D scan, read the cited diagnosis, clear its service
area in a safe layout simulation, check the route in, rehearse on an exploded teaching model, and hand the whole
context to a remote expert.

```
Explore (scan, semantic view, site map) → Understand (cited diagnosis) → Plan (move a virtual proxy: collisions,
clearance, route) → Practise (X-Ray, Learn, Practice) → Support (pins + hand-off link to an expert) → Value
```

### In plain words
Someone walked through a real equipment room with a 3D scanner. This software splits that scan into hundreds of
object candidates and guesses what each one is (with a confidence), links the pumps, motors and valves to the plant's
maintenance records, and lets a technician prepare a visit from a laptop: where the machine is, what is probably
wrong, how to get to it, what is in the way, what to do, and who to ask. Press **Tour** in the app for a guided
walk-through: each step has a plain explanation and one line for engineers.

| Criterion (weight) | What the demo shows |
|---|---|
| Semantic extraction & 3D frames (30 %) | **676 segmented object candidates** with oriented 3D frames, plus floor, ceiling and 4 walls as planes, from the full 1.68 M-splat scan. A vision-language model names each candidate with a confidence. We report honest tiers — 416 with a specific type, 195 at confidence ≥ 0.70, 7 review corrections, 30 linked to records — plus an AI second-opinion audit and a human check sheet ([`docs/SCENE_QUALITY.md`](docs/SCENE_QUALITY.md)). Semantic colour view and an overhead site map. |
| Obstacle-aware navigation & proximity (25 %) | Multi-level height-field, clearance-aware A*, smoothing and an independent validation pass (0 collisions, clearance ≥ the 0.20 m robot radius). **Block aisle** re-routes live; **Plan mode** moves a virtual proxy and re-plans with the changed layout; every asset within 1.2 m of the route is read out, exactly, forwards and in reverse. |
| Grounded AI diagnostics (20 %) | An evidence engine combines telemetry z-scores against the asset's own baseline and its peers, alarms, work orders, similar cases and data-quality issues. The LLM narration may cite **only** IDs from that evidence; anything else is removed. Confidence is shown with its breakdown (0.52 for P-005). |
| Backend architecture (15 %) | Modular Python pipeline and a FastAPI service following the workbook's `API_Contract`; a serverless export runs the same app as a static site; feature modules plug in through `web/src/ext.js`; 11 pytest guarantees and headless-browser suites. |
| Demo clarity & innovation (10 %) | A pre-visit workflow Valmet described: explore, understand, plan, practise, get support. Interactive planning and a remote hand-off; a 2D floor plan keeps finding, routing and the diagnosis working without WebGL; phone layout; runs from a fresh checkout. |

Everything that is synthetic, approximate, precomputed or illustrative is labelled in the app (About sheet) and in
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## What is automatic, what is labelled, what is illustrative

| Feature | How it works | Status |
|---|---|---|
| 3D environment | Gaussian-splat scan rendered in the browser; orbit, zoom, click any frame | Real scan |
| Object frames (676) | Plane fitting + clustering on the point cloud, fully automatic | Automatic |
| Object names | A vision model labels each cluster from rendered views; confidence shown; "other equipment" when unsure | Automatic, 7 review corrections (marked; team visual check, not field-verified). See `docs/SCENE_QUALITY.md` |
| Scene search (“Where is the expansion vessel?”) | Searches those labels and workbook tags across the whole scan | Automatic |
| Asset ↔ object link | Class-aware procedural mapping with a stated confidence (the brief allows this) | Procedural |
| Navigation, reroute, proximity | Computed from the scan's floor and obstacles; every route validated | Automatic |
| Diagnosis | Workbook telemetry, alarms, work orders, cases and documents; LLM wording limited to cited IDs | Grounded in synthetic data |
| Exploded models, lessons, practice | One library entry per equipment type (pump, motor, control valve, pressure transmitter, vibration sensor) | Illustrative teaching models, not from the scan, not OEM |
| Manuals | Retrieval over the builder pack's documents and the training notes, with citations | No OEM manuals were supplied |
| Maintenance planning | Virtual proxy of an object moved on the floor; collisions vs object boxes and the occupancy grid, clearance from the distance transform, route re-planned | Approximate simulation; the scan is never changed; not an engineering check |
| Remote support | Pins, question, plan and evidence serialised into a link or package; expert reply and draft work order come back the same way | Asynchronous hand-off; no live multi-user session; no plant controls |
| Semantic view, site map | Category-coloured boxes over a dimmed scan; overhead plan with legend and PNG export | Derived from the candidates above (same caveats) |
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
cd web && npm ci && npm run dev                      # http://localhost:5173 (uses the live API)
```

A fresh checkout renders the scan with no extra step: `npm run dev` and `npm run build` first generate the streaming
scan chunks (`web/public/static/scan-*.wasm` + `scan.json`) from the committed `web/public/data/scene.splat`
(`web/scripts/scan-chunks.mjs`). The build then checks that every manifest entry exists with its declared byte size,
splat count and SHA-256 (`web/scripts/check-manifest.mjs`, run on `public/` before and on `dist/` after the build)
and fails if one does not. If the chunks are ever missing at runtime, the app loads `scene.splat` instead.

**Full-fidelity scan.** The 3D view renders the supplied Gaussian-splat model at full fidelity: 1,669,970 of
1,676,481 splats with view-dependent colour (SH degree 3), as 18 compressed SPZ chunks in `web/public/static/hq/`
(37 MB, built by `web/scripts/build-hq-scan.mjs` from the raw PLY, verified by `check-manifest.mjs`). Phones load the
most important 730 k splats. `?render=classic` (or any loading failure) falls back to the earlier compact scan, then to
`scene.splat`. Before/after images from identical camera poses and the measurements are in
[`docs/RENDERING.md`](docs/RENDERING.md).

**Works without 3D graphics.** The entry point (`web/src/boot.js`) checks for WebGL 2 before any 3D code loads. If it
is missing, if the 3D renderer fails to start, or if the GPU drops the context mid-session, the app opens a **2D floor
plan** instead: the same assets, dispatch, live route and reroute, proximity reads, P-005 diagnosis with its evidence
and sources, work-order draft and copilot. Add `#plan` to the URL to open it on purpose (useful on slow devices).
Phones get a bottom-sheet layout and a lighter scan.

* **AI narration:** set `OPENAI_API_KEY` (`XRAY_LLM_MODEL`, default `gpt-5.4-mini`). Without it the copilot runs in
  template mode with the same evidence, confidence and citations.
* **Hosted / static mode:** `python scripts/export_static.py && cd web && npm run build` produces `web/dist`, a static
  site with no server. Routes and reroutes are planned in the browser by a JS port of `navigation.py`, and the
  diagnoses are the backend's own output, generated at export time.
* **Tests:** `pytest -q` (pipeline guarantees) and `cd web && npm run build && node tests/e2e.mjs` (headless
  Chromium: the full 3D journey, every X-Ray device type, copilot commands, the floor plan with WebGL disabled, GPU
  context loss, missing scan chunks and a phone viewport; needs a global `playwright`). Point it at a running dev
  server with `BASE=http://localhost:5173/` to test server mode.

### Rebuild from the raw scan, or run it on another site
Put `equipment_room.ply` and `builder_pack.xlsx` in `data/raw/` (see `data/raw/README.md`), then:
```bash
python scripts/run_pipeline.py                       # validate → objects → VLM labels → export → web build
python scripts/run_pipeline.py --no-vlm --no-llm     # fully offline
```
Everything site-specific (name, input files, robot size, proximity radius, LLM model, equipment library) is in
`config/project.json`. To use another room, copy that file and pass `--project`. See
[`docs/REPLICATE.md`](docs/REPLICATE.md) for the workbook sheets, adding an equipment type, and reusing single layers.

## Demo script (≈ 4 min) — "a technician preparing to service pump P-005"
The full presenter version with plain-language and engineering lines is [`docs/DEMO_GUIDE.md`](docs/DEMO_GUIDE.md);
**Tour** in the app drives the same story by itself.

1. **Explore.** The room loads on the *Pre-visit briefing* card. The tool rail on the right opens *Scene understanding*
   (676 candidates → 416 typed → 195 confident → 7 review-corrected → 30 linked), the *semantic view*, the *site map*
   and the *clean-scan* filter.
2. **Find it.** Press **/** and ask *“Where is P-005?”*.
3. **Understand.** *Open* on the briefing card: the cited diagnosis (confidence 52 %), evidence tab, sources.
4. **Plan.** The *Plan* tab: the hand pallet truck blocks P-005's service area; move its virtual stand-in, watch
   collisions, clearance, the service zone and the route update (8.40 m → 7.98 m); reset or export. The scan is never changed.
5. **Check the way in.** *Explore* → *Send robot*; camera *Broadcast*, speed 4×; *Block aisle* re-routes live; *Reverse*
   and the route slider replay the run.
6. **Rehearse.** *X-Ray* (pump, motor, valve, transmitter, vibration sensor), *Learn*, *Practice*.
7. **Support.** *Support* tab: pin notes, *Share* → the expert opens the link, adds a recommendation (AI drafts must be
   reviewed) and a draft work order, and sends it back.
8. **Value / About.** Hypothetical value with editable inputs; the About sheet lists what each capability is and is not.

## Data notes
* **Scan.** `Equipment Room.ply` (the file shared on Google Drive, id `1MrwNjHxFqk5IfHpJQ24KlTn5nAAn40rd`; verified identical on 7 Nov 2026: 395,651,019 bytes, SHA-256 `83d8c7d99316c08c9719cfc2c5a6b9d1903b89847780e2458adc662c79f32955`): 1,676,481 splats, all valid (`data/processed/integrity_report.md`). The originally
  distributed `Industrial Boiler Room.ply` was corrupt from record 502,483 onward, identically in the PLY, RAR and
  ZIP copies. That report is kept in `docs/integrity_original_boiler_room.md`.
* **Labels.** Geometry proposes clusters and the vision model names them; 258 objects remain "other equipment"
  rather than being guessed. The review layer (`config/scene_annotations.json`) records 7 corrections, each tagged
  `review-corrected` with a note: the pump set fragments were merged, and a pallet truck, a pressure washer, a
  chair, a cluttered corner (previously linked to P-002), a shelf and a small table that the model had called pumps
  were relabelled. These come from the build team's visual check of rendered crops (AI-assisted), not from a person
  on site; a human precision check is set up in `docs/label_review_sample.csv`.
* **Mapping** is class-aware and procedural, as the brief allows. It prefers objects along the demo route, and
  every binding states its method and confidence.
* **Scale** is treated as approximately metric (ceiling 2.05 units); it was not surveyed.
* **The X-Ray models** are procedural teaching models. It is not from the scan, not an OEM drawing and not a Valmet
  product. Learn and Practice content is conceptual, sits behind explicit safety gates and has no connection to any
  control system. All asset data is synthetic.

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (technical note) · [`docs/PITCH.md`](docs/PITCH.md) (slides and video script) ·
[`docs/DEMO_GUIDE.md`](docs/DEMO_GUIDE.md) (one-page presenter guide) · [`docs/REPLICATE.md`](docs/REPLICATE.md) (another site or challenge).
