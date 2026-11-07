# Technical note — models, libraries, components

## 1. Data integrity & canonical frame (`ply_io.py`, `canonical.py`)
* Binary PLY parser (59 float32 properties per record = 236 B). It runs a plausibility check on every record
  (finite values, bounded position, scale, opacity, quaternion and SH DC) and reports block-wise statistics. The
  contiguous valid prefix is used; the corrupt tail is excluded, not repaired.
* COLMAP/3DGS y-down → three.js y-up. RANSAC + SVD floor plane → +Y. Yaw is the rotation that minimises the robust
  bounding-box area of the floor footprint, so the walls end up axis-aligned. The floor is translated to y = 0. Splat quaternions are rotated
  consistently, and the web viewer loads a `.splat` export (32 B/splat, sorted by importance) with no extra transform.

## 2. Semantic extraction (`segmentation.py`, `vlm_labeler.py`)
1. Geometry splats: opacity ≥ 0.25 and max scale ≤ 0.25 m, voxelised at 3 cm, with floaters removed (kd-tree density).
2. Structure: floor (frame), ceiling (constrained RANSAC) and the room envelope. For each side of the room a vertical
   plane is fitted with RANSAC inside a slab next to the robust boundary, and kept if it is at least 1.5 m wide and
   1 m tall (4 walls found).
3. Objects: DBSCAN (eps 7.5 cm). Over-sized clusters are re-clustered recursively with a tighter radius plus colour
   features, and split spatially as a last resort. Collinear pipe fragments are merged by PCA-axis union-find.
   Thin fragments lying on the wall plane are rejected as wall texture.
4. Frames: gravity-aligned oriented boxes. Yaw comes from 2-D PCA of the footprint and snaps to the wall grid;
   extents are robust (2–98 % percentiles).
5. Labels: a geometric/colour heuristic proposes first. A VLM (`gpt-5.4-mini`) then sees a context render and a
   close-up render from our CPU splat renderer with the box drawn in, and picks from a 38-class industrial taxonomy
   (the "2-D foundation model lifted to 3-D" approach suggested in the brief). Results are cached in
   `vlm_labels.json` keyed by geometry signature. A review layer (`config/scene_annotations.json`) applies region-based
   corrections from the team's visual review of renders, tagged `review-corrected` (not field-verified).

## 3. Navigation (`navigation.py`)
* Height-field per cell: the lowest densely supported 5 cm slab, estimated on a 10 cm grid, outlier-filtered and
  resampled to a 5 cm nav grid. Several floor levels are detected (0.00 m main floor, 0.62 m raised area, …).
* Default start: the drivable cell farthest from the target by route distance (BFS), so the demo route crosses the room.
* Obstacles are measured relative to the *local* floor: splats between 0.12 m and 1.25 m (robot height), plus
  footprints of extracted objects in that band, using the median floor under the footprint.
* Walkable = observed floor ∧ distance-transform clearance > robot radius (0.20 m). A* is 8-connected with no corner
  cutting and a step limit of 0.18 m, and its cost term keeps the robot in the middle of aisles. Line-of-sight
  smoothing only keeps shortcuts that stay inside the walkable set.
* Validation re-samples the final polyline at about 2.5 cm against the raw obstacle grid, the floor mask and dynamic
  blocks, and reports minimum clearance and collision count. A dynamic block is rasterised into the grid, and the route
  is replanned from the robot's current position.
* Proximity: objects within 1.2 m of the robot are framed and labelled live. `/api/proximity` and
  `proximity_preview` provide the same query server-side.

## 4. Metadata mapping (`metadata.py`, `mapping.py`)
* The workbook has 16 sheets; `metadata.py` loads the 10 data sheets (`Asset_Master`, `Current_State`,
  `Telemetry_Sample_3d`, `Alarms_Events`, `Maintenance_History`, `Historical_Service_Cases`, `Knowledge_Docs`,
  `RAG_Corpus_Index`, `Data_Quality`, `Scene_Anchors`). The faulty target is the asset with the highest
  `criticality × (100 − health) × model_confidence` → **P-005** (FOULING, A-critical, health 44).
* Class-aware one-to-one binding (e.g. PROCESS_PUMP ← pump-motor unit / circulation pump), then documented fallbacks.
  The target must be reachable. Each binding stores `method` and `mapping_confidence`.

## 5. Grounded copilot (`copilot.py`)
* **Evidence engine** (deterministic): identity and current state; telemetry statistics from the last 12 h against
  the asset's own first-24 h baseline and against class peers (z-scores and trend per day); events matching the issue
  code or of high severity; work orders; historical cases with the same class and issue; data-quality issues;
  documents (Knowledge_Docs, generated asset cards, field-safety guide).
* **Confidence** = model confidence × evidence support × (1 − data-quality penalty) × (0.6 + 0.4 × mapping confidence).
  It is shown to the user.
* **Hypotheses** come from issue-code knowledge and are linked to X-Ray components. The leading hypothesis is shown
  alongside the alternatives.
* **Narration**: the LLM follows the `DOC-RAG-GUIDE` contract (Observation / Evidence / Hypothesis / Uncertainty /
  Next safe step). A server-side citation checker removes any ID that is not in the evidence package and reports it.
  A template fallback keeps the same structure.
* **Live LLM and its failure mode**: free questions in server mode are answered live with the last 3 turns as
  context. The client uses a 12 s timeout and no retries; a quota error, rate limit, timeout, connection or auth
  failure trips a class-level circuit breaker (`_trip`) that skips the LLM for 5 minutes, so later fallbacks are
  instant. The web client (`api.js`) then shows the narrative pre-generated at export time, labelled "Pre-generated …
  (live AI unavailable)", or the closest pre-generated FAQ answer; the copilot badge reads *Live AI unavailable*.
* **Knowledge Center**: BM25 (`Corpus` in `copilot.py`) over 153 documents: 8 knowledge docs, 30 asset cards, 50
  service cases, 49 illustrative component training notes and 16 product-documentation notes
  (`knowledge/app_docs.json`). Answers cite IDs.
* **Command router**: transparent rules for "faulty / abnormal <signal> / send / x-ray / practise / manual". Anything
  else falls through to retrieval-augmented question answering.

## 5b. Equipment library (`backend/xray/knowledge/equipment.json`)
One entry per asset class: a teaching model described with a shape vocabulary (cylinder, box, torus, ring, fins,
blades, coil, bolts, thread, hex, plus named pump parts), each component's function, failure signs, evidence signals
and fault codes, class-specific fault → component hypotheses, lessons and a scored practice scenario. The X-Ray
viewer builds any entry, normalises its size to the podium, keeps exploded parts above it and frames the camera
automatically; the copilot uses the same entry for hypotheses and citations (`KB-XRAY-<CLASS>#<component>`).
The command router adds semantic scene search ("where is …") over all 676 object labels.

## 6. Hosted mode (`scripts/export_static.py`, `web/src/static-api.js`)
The export writes the scene, nav grid (floor, obstacle and height bitmaps), approach cells, all 30 diagnoses
(LLM-narrated at export time and citation-checked), pre-answered component questions, the BM25 corpus, and the
copilot FAQ (`scripts/export_faq.py`: 320 answers, 9 per asset + 50 general, citation-checked). `faq-match.js`
matches a typed question to an entry (a named tag must match; otherwise IDF-weighted token similarity above a
threshold) and the answer is labelled "Pre-generated answer to a similar question". The splat chunks are built
from the committed `web/public/data/scene.splat` by the web build (`web/scripts/scan-chunks.mjs`: quantised 17-byte
records, most visible splats first, ≤ 15 MB per file), and `web/scripts/check-manifest.mjs` fails the build if any
manifest entry is missing or its byte size, splat count or SHA-256 differs. At runtime a missing chunk set falls
back to `scene.splat`. In the browser, `static-api.js` reimplements the API: an exact Euclidean distance transform
(Felzenszwalb), A* with the same cost and step rule, line-of-sight smoothing, validation, and BM25 retrieval. The
same front end runs against either backend.

## 7. Front end (`web/`)
three.js 0.180 with **Spark 2.4** (Gaussian-splat renderer that composites with meshes), CSS2D labels, OrbitControls,
and plain JS modules: `boot.js` (entry: checks WebGL 2 before any 3D code is loaded), `facility.js` (splats, frames,
robot, route, blocks, floor map), `xray.js` (data-driven exploded models for every equipment type, with explode,
see-through, isolate and labels), `training.js` (Learn and Practice), `tour.js` (guided tour), `ui.js` (formatting
and the diagnosis card shared by both views), `xray-overlay.js` (in-scene X-Ray panel and arrival prompt),
`copilot-ui.js` (conversation panel), `navpad.js` (on-screen navigation pad and keys), `guide.js` (coach cards),
`mobile.js` (phone layout and Tools sheet), `twin.js` (condition pins and the Twin overlay), `look.js` (backdrop, floor
plate, adaptive resolution, auto cut-away) and
`main.js` (state, cards, dock, playback, camera modes, ask bar, transitions).

**Camera modes.** Robot POV, Chase, Angled, Top and Free only move the viewing camera; they never touch the route or
the robot. Robot POV sits 0.95 m above the floor just ahead of the robot, tilted 8° down, and follows the heading
through a damped turn-rate filter so corners do not snap; the robot's own body is hidden and a HUD reads "Simulated
robot camera — rendered from the 3D scan, not a live feed". Dragging or scrolling hands the camera over to Free.

**In-scene X-Ray.** The asset card's *Explore internals (X-Ray)* (or *Inspect equipment* on the arrival prompt)
draws the same `xray.js` scene into a panel over the room with a scissor viewport and its own camera and
OrbitControls. On open it saves the room camera pose and mode, the robot's motion and the selection, and pauses the
robot; × or Esc restores all of them exactly. Explode, see-through, labels, the component list, suspected parts in
red, *Show only this part* and *Open full X-Ray view* work as in the full tab. Labelled "Illustrative teaching model
— not reconstructed from the scan".

**Graceful degradation.** `plan2d.js` is a 2D floor plan on a canvas with the same API client: it opens when WebGL 2
is missing, when the renderer throws during start-up, or when the GPU loses the context and does not restore it
within 2.5 s (`webglcontextlost`). It keeps the core job: select assets (list or map), dispatch, the live route with
reroute, proximity reads, the full diagnosis with evidence and sources, the work-order draft and the copilot. Phones
use a bottom-sheet layout, pixel ratio 1 and the two most important scan chunks.

**Playback.** Each route stores, per object, the arc length at which it first comes within the proximity radius.
Play, pause, reverse, 1–4× speed and scrubbing then only move an arc-length cursor, so the "assets read" list stays
exact in both directions at no per-frame cost.

**Replication.** Site-specific values (name, inputs, robot geometry, proximity radius, LLM model, knowledge paths)
live in `config/project.json`, read by `backend/xray/config.py`; `scripts/run_pipeline.py` runs the whole chain for
any project file. See `docs/REPLICATE.md`. The design language is one calm dark
studio look with the system typeface, a numbered list card, a tabbed detail card, a bottom control dock and a tool rail.

## 7b. Pre-visit workflow modules (`web/src/ext.js` + one file per feature)
`ext.js` is the extension interface: `registerMode` (a tab with its own cards, dock and picking), `addRailButton`,
and hooks (`boot`, `frame`, `select`, `minimap`, `planExtras`, `modeChange`). Every route request goes through
`withExtras`, so a module can add obstacles (`blocks`) or free a footprint (`clears`) for all planners at once.
- **Scene understanding** (`quality.js`, `scripts/scene_quality.py` → `static/quality.json`, `docs/SCENE_QUALITY.md`):
  exact tier counts (candidates → specific type → confident → review-corrected → linked), data-quality flags
  (fragments, tiny/flat, low support, possible over-merges), and a frozen, stratified 60-object AI second-opinion
  audit with Wilson intervals; a blank CSV for the human check.
- **Layers** (`layers.js`, `semantic.js`, `scanfilter.js`, `sitemap.js`, Facility methods): category-coloured boxes
  in one `InstancedMesh` over a dimmed scan; "show uncertain"; a clean-scan filter that splits haze splats into
  their own layer at decode time (≈ 6 % of splats); an overhead site map with legend, click-to-fly and PNG export.
- **Maintenance planning** (`planning.js`, `splatcut.js`): grab any floor object, lift, drag, turn (wheel, R,
  Q / E) and drop it; undo / redo; Top, Angled and Eye-level views. Live collision checks against other objects'
  boxes and occupied grid cells (excluding the original footprint), clearance from the grid distance transform, an
  assumed P-005 service zone, and the route re-planned on drop with the proxy as an obstacle and the original
  footprint cleared (`clears` in `navigation.py`, `world.py`, `api.py` and the browser planner); before and after
  routes are both drawn. **Scan cut-out:** the splats inside the object's (slightly padded) box are copied once into
  a small splat mesh that follows the proxy, and the original spot is hidden by a render-time Spark SDF edit. It is
  approximate: nearby fragments can move along and holes or ghosting can remain; collisions always use the boxes. The
  scan data is never modified. Known gap: *Suggest a good spot* can place the pallet truck next to a second scanned
  pallet truck at about (2.75, 0.90) that was not segmented, so it is not among the obstacles. Export as Markdown/JSON.
- **Label review** (`review.js`): from *Scene understanding* → *Review labels*, a queue of 481 low-confidence or
  "other equipment" candidates, uncertain first; confirm (Y), rename (R) or reject (N), skip and undo. Decisions stay
  in the browser and export as a `relabel_near` layer in the `config/scene_annotations.json` format plus a CSV with the
  columns of `docs/label_review_sample.csv`; `scripts/merge_review.py` merges the layer into the config. The shown
  agreement rate (with a Wilson interval) describes the reviewed queue, which is not a random sample.
- **Remote support** (`support.js`): pins on objects or the floor, a question, the shared asset context and plan,
  serialised (deflate + base64url) into a `#support=` link, a code or a JSON/Markdown package with an optional
  view snapshot; the expert view adds pins, an AI-drafted recommendation that must be reviewed, and a work-order
  draft; "send back" makes the next round. Asynchronous by design: no session server.
- **Tour** (`tour.js`) drives the whole P-005 story through these modules; `?capture` renders frame by frame for
  the recorded demo (`web/tests/record-demo.cjs`).

## 8. API (FastAPI, follows the workbook `API_Contract`)
`GET /api/assets`, `/api/assets/{id}`, `/telemetry`, `/events`, `/documents`, `GET /api/scene/anchors`,
`POST /api/copilot/query`, `POST /api/work-orders/draft` (draft only), plus `GET /api/scene`, `GET /api/nav/grid`,
`POST /api/nav/plan`, `GET /api/proximity`, `GET /api/diagnose/{id}`, `POST /api/copilot/command`,
`GET /api/knowledge/search`, `GET /api/knowledge/doc/{id}`, `GET /api/xray/model`, `GET /api/health`. Interactive
docs are at `/docs`. The server needs the workbook (`data/raw/builder_pack.xlsx`); the PLY is only needed by the
pipeline steps 1–3.

## 9. Libraries
numpy, scipy (ndimage, cKDTree), scikit-learn (DBSCAN), pandas/openpyxl, FastAPI/uvicorn (pydantic), Pillow, OpenAI
SDK (optional); three.js 0.180, @sparkjsdev/spark 2.4, Vite 6. Playwright is used only for the headless test suites
and screenshots. Licences are listed in the README (*Licence and attribution*).

**Tests.** `pytest` (19 pipeline guarantees: integrity, framing, one-to-one mapping, collision-free routes and
reroutes, layout plans, citation checking, grounded diagnoses, a complete device library, scene search, quality
tiers, copilot chat and FAQ grounding) and 9 headless-Chromium suites in `web/tests/` with 424 checks in total;
counts per suite are in the README.

## 10. Path to production (Builder Q-07/Q-09)
Swap `metadata.py` for OPC UA / MQTT / CMMS adapters without changing the API. Scene objects and anchors are plain
JSON (center, size, yaw, confidence), easy to export to OpenUSD, Unity or Unreal. Replace the review layer with
QR/NFC confirmations in the field.

## Further reading
* [`RESEARCH_NOTES.md`](RESEARCH_NOTES.md): point clouds, Gaussian splatting, Gaussian-object extraction, scan-to-BIM
  and IFC compared; verdicts on the references shared on Discord; a staged pilot path.
* [`DATA_INTEGRATION.md`](DATA_INTEGRATION.md): how read-only OPC UA, historian, MQTT/Sparkplug, CMMS/EAM and
  document data could replace the synthetic workbook later, with provenance labels and security controls.
