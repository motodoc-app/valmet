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
* All 14 workbook sheets are loaded. The faulty target is the asset with the highest
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
* **Knowledge Center**: BM25 over 99 documents (8 knowledge docs, 30 asset cards, 50 service cases, 11 illustrative
  component notes). Answers cite IDs.
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
(LLM-narrated at export time and citation-checked), pre-answered component questions, the BM25 corpus. The splat chunks are built
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
and the diagnosis card shared by both views), and `main.js` (state, cards, dock, playback, ask bar, transitions).

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

## 8. API (FastAPI, follows the workbook `API_Contract`)
`GET /api/assets`, `/api/assets/{id}`, `/telemetry`, `/events`, `/documents`, `GET /api/scene/anchors`,
`POST /api/copilot/query`, `POST /api/work-orders/draft` (draft only), plus `GET /api/scene`, `GET /api/nav/grid`,
`POST /api/nav/plan`, `GET /api/proximity`, `GET /api/diagnose/{id}`, `POST /api/copilot/command`,
`GET /api/knowledge/search`, `GET /api/xray/model`. Interactive docs are at `/docs`.

## 9. Libraries
numpy, scipy (ndimage, cKDTree), scikit-learn (DBSCAN), pandas/openpyxl, FastAPI/uvicorn, Pillow, OpenAI SDK
(optional); three.js, @sparkjsdev/spark, Vite. Playwright is used only for headless QA screenshots.

## 10. Path to production (Builder Q-07/Q-09)
Swap `metadata.py` for OPC UA / MQTT / CMMS adapters without changing the API. Scene objects and anchors are plain
JSON (center, size, yaw, confidence), easy to export to OpenUSD, Unity or Unreal. Replace the review layer with
QR/NFC confirmations in the field.

## Further reading
* [`RESEARCH_NOTES.md`](RESEARCH_NOTES.md): point clouds, Gaussian splatting, Gaussian-object extraction, scan-to-BIM
  and IFC compared; verdicts on the references shared on Discord; a staged pilot path.
* [`DATA_INTEGRATION.md`](DATA_INTEGRATION.md): how read-only OPC UA, historian, MQTT/Sparkplug, CMMS/EAM and
  document data could replace the synthetic workbook later, with provenance labels and security controls.
