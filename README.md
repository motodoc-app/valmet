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

**Links.** Live demo: https://claude.ai/artifact/FbUbNXsimhQWK9Zw9Vpebs · backup of an earlier build:
https://claude.ai/artifact/PKt4BtBkZvpTE3V9RyBDZe · pitch deck: https://claude.ai/artifact/S8rpiiuncbmJm7mEiPsFc2 ·
code: `motodoc-app/valmet`, branch `ccr-3b4e61d7-jdmlgf`. Requirement-by-requirement check:
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md); what is left to submit: [`docs/SUBMISSION_CHECKLIST.md`](docs/SUBMISSION_CHECKLIST.md).

### In plain words
Someone walked through a real equipment room with a 3D scanner. This software splits that scan into hundreds of
object candidates and guesses what each one is (with a confidence), links the pumps, motors and valves to the challenge's
synthetic maintenance records, and lets a technician prepare a visit from a laptop: where the machine is, what is probably
wrong, how to get to it, what is in the way, what to do, and who to ask. Press **Tour** in the app for a guided
walk-through: each step has a plain explanation and one line for engineers.

Valmet's evaluation criteria, from the challenge brief:

| Criterion (weight) | What the demo shows |
|---|---|
| Semantic extraction & 3D frames (30 %) | **676 segmented object candidates** with oriented 3D frames, plus floor, ceiling and 4 walls as planes, from the full 1.68 M-splat scan. A vision-language model names each candidate with a confidence. We report honest tiers — 416 with a specific type, 195 at confidence ≥ 0.70, 8 review corrections, 30 linked to records — plus an AI second-opinion audit and a human check sheet ([`docs/SCENE_QUALITY.md`](docs/SCENE_QUALITY.md)). Semantic colour view and an overhead site map. |
| Obstacle-aware navigation & proximity (25 %) | Multi-level height-field, clearance-aware A*, smoothing and an independent validation pass (0 collisions, clearance ≥ the 0.20 m robot radius). **Block aisle** re-routes live; **Plan mode** moves a virtual proxy and re-plans with the changed layout; every asset within 1.2 m of the route is read out, exactly, forwards and in reverse. |
| Grounded AI diagnostics (20 %) | An evidence engine combines telemetry z-scores against the asset's own baseline and its peers, alarms, work orders, similar cases and data-quality issues. The LLM narration may cite **only** IDs from that evidence; anything else is removed. Confidence is shown with its breakdown (0.52 for P-005). |
| Backend architecture (15 %) | Modular Python pipeline and a FastAPI service following the workbook's `API_Contract`; a serverless export runs the same app as a static site; feature modules plug in through `web/src/ext.js`; 19 pytest checks and 9 headless-browser suites (424 checks). |
| Demo clarity & innovation (10 %) | A pre-visit workflow Valmet described: explore, understand, plan, practise, get support. Interactive planning and a remote hand-off; a 2D floor plan keeps finding, routing and the diagnosis working without WebGL; phone layout; runs from a fresh checkout. |

Everything that is synthetic, approximate, precomputed or illustrative is labelled in the app (About sheet) and in
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## What is automatic, what is labelled, what is illustrative

| Feature | How it works | Status |
|---|---|---|
| 3D environment | Gaussian-splat scan rendered in the browser; orbit, zoom, click any frame | Real scan |
| Object frames (676) | Plane fitting + clustering on the point cloud, fully automatic | Automatic |
| Object names | A vision model labels each cluster from rendered views; confidence shown; "other equipment" when unsure | Automatic, 8 review corrections (marked; team visual check, not field-verified). See `docs/SCENE_QUALITY.md` |
| Scene search (“Where is the expansion vessel?”) | Searches those labels and workbook tags across the whole scan | Automatic |
| Asset ↔ object link | Class-aware procedural mapping with a stated confidence (the brief allows this) | Procedural |
| Navigation, reroute, proximity | Computed from the scan's floor and obstacles; every route validated | Automatic |
| Robot camera (Robot POV, Chase, Angled, Top, Free) | Robot POV is a first-person view 0.95 m up at the robot's front, tilted 8° down, with smoothed turning; switching camera never restarts the route or moves the robot | Simulated: rendered from the 3D scan, not a live feed (said on screen) |
| In-scene X-Ray | Select an asset → *Explore internals (X-Ray)*: the exploded model opens in a panel over the room; × / Esc puts the camera, robot and selection back exactly | Illustrative teaching model, not reconstructed from the scan (said on screen) |
| Diagnosis | Workbook telemetry, alarms, work orders, cases and documents; LLM wording limited to cited IDs | Grounded in synthetic data |
| Exploded models, lessons, practice | One library entry per equipment type (pump, motor, control valve, pressure transmitter, vibration sensor) | Illustrative teaching models, not from the scan, not OEM |
| Manuals | Retrieval over the builder pack's documents and the training notes, with citations | No OEM manuals were supplied |
| Maintenance planning | Grab any floor object (lift, drag, turn, drop; undo / redo); the scan splats inside its box move with it; collisions vs object boxes and the occupancy grid, clearance from the distance transform, service zone, route before / after | Approximate simulation; the cut-out may leave holes or ghosting; the scan file is never changed; not an engineering check |
| Label review | *Scene understanding* → *Review labels*: a queue of 481 low-confidence or generic candidates to confirm, rename or reject; exports a review layer (JSON) and a CSV; `scripts/merge_review.py` merges it into the config | Human-in-the-loop tool; its agreement rate is not a random sample |
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

**Quickest (no Python, no organiser files):** the hosted/static mode runs from a fresh checkout.
```bash
cd web && npm ci && npm run dev                      # http://localhost:5173 — static mode when no API answers
```

**With the Python server (live API, optional live AI):** needs Python 3.10+, Node 18+ and the organisers' workbook at
`data/raw/builder_pack.xlsx` (not committed, see *Data notes*). Two terminals, both from the repository root:
```bash
pip install -r requirements.txt
cd backend && uvicorn xray.api:app --port 8000       # terminal 1 — API + docs at http://localhost:8000/docs
cd web && npm ci && npm run dev                      # terminal 2 — http://localhost:5173, proxies /api to :8000
```
Another API port: `XRAY_API=http://127.0.0.1:8100 npm run dev` (read by `web/vite.config.js`). Single process: after
`cd web && npm run build`, the API also serves the built app at http://localhost:8000.

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
  template mode with the same evidence, confidence and citations. With a key, the server copilot answers live and
  remembers the last 3 turns. If live AI is unavailable (no credits, no network), a call gives up after 12 s with no
  retries and the server skips the LLM for the next 5 minutes, so later answers come back at once: diagnoses show the
  pre-generated narrative, labelled "Pre-generated … (live AI unavailable)", and the copilot badge reads *Live AI
  unavailable*. Note: the OpenAI account used during development currently has no credits (429 insufficient_quota),
  so live AI on localhost needs your own key with credits.
* **Hosted / static mode:** `python scripts/export_static.py && cd web && npm run build` (the export needs the
  workbook) produces `web/dist`, a static site with no server. Routes and reroutes are planned in the browser by a JS port of `navigation.py`, and the
  diagnoses are the backend's own output, generated at export time. `python scripts/export_faq.py` adds the copilot FAQ
  (`static/faq.json`: 9 questions for every asset plus 50 general ones, 320 answers, generated by the backend copilot
  with citation checks); the hosted copilot answers from it and labels every answer with how it was made
  ("Pre-generated answer to a similar question").
* **Tests:** `python -m pytest -q tests` (19 pipeline guarantees; needs `data/raw/builder_pack.xlsx`) and, after
  `cd web && npm run build`, the headless-Chromium suites (need a global `playwright`:
  `npm i -g playwright && npx playwright install chromium`). Each starts its own `vite preview` on a random port;
  `BASE=http://localhost:5173/` points one at a running dev server instead (server mode). `vite preview` proxies `/api`
  to port 8000 like the dev server, so leave 8000 free for the static-mode results above.

  | Suite (`web/tests/`) | Checks | Covers |
  |---|---:|---|
  | `node tests/e2e.mjs` | 78 | 3D journey, every X-Ray device type, copilot commands, floor plan without WebGL, GPU context loss, missing scan chunks, phones, Tour |
  | `node tests/e2e-pov-xray.mjs` | 54 | Robot POV and camera switching, in-scene X-Ray, arrival prompt |
  | `node tests/e2e-planning.mjs` | 58 | Plan mode: pick, drag, turn, collisions, clearance, service zone, routes, undo / redo, export |
  | `node tests/e2e-review.mjs` | 45 | Review labels, export, `merge_review.py` |
  | `node tests/e2e-ux.mjs` | 65 | Navigation pad, keys, coach cards, phone layout |
  | `node tests/e2e-support.mjs` | 45 | Remote-support hand-off, technician and expert round trip |
  | `node tests/e2e-copilot.mjs` | 31 | Copilot panel, answers, citations, chips |
  | `node tests/e2e-render.mjs` | 26 | Full-fidelity scan, fallbacks, intro, phones |
  | `SCAN=0 node tests/e2e-layers.mjs` | 22 | Semantic view, clean scan, site map |

  Counts are from commit `e694afc`, where all of them passed.

### Rebuild from the raw scan, or run it on another site
Put the organisers' files in `data/raw/` (not committed): the scan *Equipment Room.ply* as `equipment_room.ply` and
*Valmet_SinceAI_2026_Synthetic_Industrial_Metaverse_Builder_Pack.xlsx* as `builder_pack.xlsx`. Then:
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
   (676 candidates → 416 typed → 195 confident → 8 review-corrected → 30 linked), the *semantic view*, the *site map*
   and the *clean-scan* filter.
2. **Find it.** Press **/** and ask *“Where is P-005?”*.
3. **Understand.** *Open* on the briefing card: the cited diagnosis (confidence 52 %), evidence tab, sources.
4. **Plan.** The *Plan* tab (or *Plan access* on the asset card): the hand pallet truck blocks P-005's service area;
   grab it (the scanned truck moves with it as an approximate cut-out), turn it with the wheel, R or Q / E, drop it;
   collisions, clearance, the service zone and the route update (8.40 m → 7.98 m); undo, reset or export. The scan
   file is never changed.
5. **Check the way in.** *Send robot here* on the card; switch the camera to *Robot POV* mid-route (simulated robot
   camera, rendered from the scan), or *Angled* at 4×; *Block aisle* re-routes live; *Reverse* and the route slider
   replay the run. On arrival: *You've arrived at P-005* → *Inspect equipment* or *See diagnosis*.
6. **Rehearse.** *Inspect equipment* / *Explore internals (X-Ray)* opens the exploded model over the room (× or Esc
   returns exactly to where you were); *Open full X-Ray view* for pump, motor, valve, transmitter, vibration sensor;
   *Learn*, *Practice*.
7. **Support.** *Support* tab: pin notes, *Share* → the expert opens the link, adds a recommendation (AI drafts must be
   reviewed) and a draft work order, and sends it back.
8. **Value / About.** Hypothetical value with editable inputs; the About sheet lists what each capability is and is not.

## Valmet feedback: implemented vs planned
Implemented in this prototype:
* **Robot camera modes:** Robot POV, Chase, Angled, Top and Free. Robot POV is a *simulated* camera rendered from the
  3D scan, not a live feed, and the screen says so. Switching camera never restarts navigation or moves the robot.
* **In-scene X-Ray:** *Explore internals (X-Ray)* draws the exploded teaching model in a panel over the room (explode,
  see-through, labels, component list, suspected parts in red, *Show only this part*, *Open full X-Ray view*). The
  robot pauses while it is open; closing restores the exact camera pose, camera mode, robot motion and selection.
* **Arrival prompt:** "You've arrived at P-005" with *Inspect equipment* and *See diagnosis*.
* **Asset card actions:** *Send robot here* · *Explore internals (X-Ray)* · *What's wrong?* · *Plan access*.

Planned / roadmap (not in this prototype): a live camera feed from a real robot; a multi-user, real-time support
session; a real CMMS integration. The X-Ray interiors are illustrative teaching models; we do **not** claim to
reconstruct equipment interiors from the splat scan.

## Data notes
* **Scan.** `Equipment Room.ply` (the file shared on Google Drive, id `1MrwNjHxFqk5IfHpJQ24KlTn5nAAn40rd`; verified identical on 7 Nov 2026: 395,651,019 bytes, SHA-256 `83d8c7d99316c08c9719cfc2c5a6b9d1903b89847780e2458adc662c79f32955`): 1,676,481 splats, all valid (`data/processed/integrity_report.md`). The originally
  distributed `Industrial Boiler Room.ply` was corrupt from record 502,483 onward, identically in the PLY, RAR and
  ZIP copies. That report is kept in `docs/integrity_original_boiler_room.md`.
* **Labels.** Geometry proposes clusters and the vision model names them; 260 objects remain "other equipment"
  rather than being guessed. The review layer (`config/scene_annotations.json`) records 8 corrections, each tagged
  `review-corrected` with a note: the real pump set on the concrete plinth (which P-005 is now linked to) was
  relabelled from "other equipment"; fragments behind the pink pallet truck that an earlier review had merged and
  called the pump set were corrected to "other equipment" on 7 Nov after checking the rendered scan from two
  viewpoints; and a pallet truck, a pressure washer, a chair, a cluttered corner, a shelf and a small table that the
  model had called pumps were relabelled. These come from the build team's visual check of rendered crops (AI-assisted), not from a person
  on site; a human precision check is set up in `docs/label_review_sample.csv`.
* **Mapping** is class-aware and procedural, as the brief allows. It prefers objects along the demo route, and
  every binding states its method and confidence.
* **Scale** is treated as approximately metric (ceiling 2.05 units); it was not surveyed.
* **The X-Ray models** are procedural teaching models. It is not from the scan, not an OEM drawing and not a Valmet
  product. Learn and Practice content is conceptual, sits behind explicit safety gates and has no connection to any
  control system. All asset data is synthetic.
* **Workbook.** `builder_pack.xlsx` has 16 sheets; `backend/xray/metadata.py` reads the 10 data sheets (asset master,
  current state, 3-day telemetry sample, alarms, maintenance history, service cases, knowledge docs, RAG index, data
  quality, scene anchors), the API follows its `API_Contract` sheet, and its `Builder_Questions` are answered in
  [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md). The full 14-day telemetry CSV it mentions was not supplied.

## Licence and attribution
* **No licence has been chosen for this repository yet**, so its own code is not open-source licensed until the
  authors add one.
* **Organiser data.** The scan (*Equipment Room.ply*, and the earlier *Industrial Boiler Room.ply*) and the synthetic
  workbook were supplied by Valmet and Since AI for the hackathon and remain theirs. The raw files are not committed,
  but files **derived** from them are, so the demo runs from a fresh checkout: `web/public/data/scene.splat`,
  `web/public/static/hq/*.wasm` (the rendered scan), `data/processed/`, and the JSON exports in
  `web/public/static/`. Check with the organisers before making the repository public.
* **Third-party libraries** (used, not modified): three.js (MIT), Spark `@sparkjsdev/spark` (MIT), Vite (MIT);
  NumPy, SciPy, scikit-learn, pandas, Uvicorn, Starlette (BSD), FastAPI, Pydantic, openpyxl (MIT), Pillow (MIT-CMU),
  OpenAI Python SDK (Apache-2.0); Playwright (Apache-2.0) for tests only.
* **AI services.** Object labels, diagnosis narration and the 320 FAQ answers were generated with an OpenAI model
  (`gpt-5.4-mini`, set in `config/project.json`); `docs/video/narration.mp3` is an AI-generated voice (OpenAI
  text-to-speech). External works cited in [`docs/RESEARCH_NOTES.md`](docs/RESEARCH_NOTES.md) are referenced, not
  included.

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (technical note) · [`docs/PITCH.md`](docs/PITCH.md) (slides and video script) ·
[`docs/DEMO_GUIDE.md`](docs/DEMO_GUIDE.md) (presenter guide and 28-step walkthrough) · [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md)
(requirement-by-requirement check) · [`docs/SUBMISSION_CHECKLIST.md`](docs/SUBMISSION_CHECKLIST.md) ·
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) · [`docs/SCENE_QUALITY.md`](docs/SCENE_QUALITY.md) ·
[`docs/RENDERING.md`](docs/RENDERING.md) · [`docs/DATA_INTEGRATION.md`](docs/DATA_INTEGRATION.md) ·
[`docs/RESEARCH_NOTES.md`](docs/RESEARCH_NOTES.md) · [`docs/REPLICATE.md`](docs/REPLICATE.md) (another site or challenge).
