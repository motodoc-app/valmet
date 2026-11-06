# Technical note — models, libraries, components

## 1. Data integrity & canonical frame (`ply_io.py`, `canonical.py`)
* Binary PLY parser (59 float32 properties per record = 236 B). It runs a plausibility check on every record
  (finite values, bounded position, scale, opacity, quaternion and SH DC) and reports block-wise statistics. The
  contiguous valid prefix is used; the corrupt tail is excluded, not repaired.
* COLMAP/3DGS y-down → three.js y-up. RANSAC + SVD floor plane → +Y; yaw is chosen to maximise histogram sharpness
  of wall and pipe structure, so walls are axis-aligned. The floor is translated to y = 0. Splat quaternions are rotated
  consistently, and the web viewer loads a `.splat` export (32 B/splat, sorted by importance) with no extra transform.

## 2. Semantic extraction (`segmentation.py`, `vlm_labeler.py`)
1. Geometry splats: opacity ≥ 0.25 and max scale ≤ 0.25 m, voxelised at 3 cm, with floaters removed (kd-tree density).
2. Structure: floor (frame), ceiling (constrained RANSAC) and walls (iterative vertical RANSAC with size, density and
   de-duplication tests).
3. Objects: DBSCAN (eps 7.5 cm). Over-sized clusters are re-clustered recursively with a tighter radius plus colour
   features, and split spatially as a last resort. Collinear pipe fragments are merged by PCA-axis union-find.
   Thin fragments lying on the wall plane are rejected as wall texture.
4. Frames: gravity-aligned oriented boxes. Yaw comes from 2-D PCA of the footprint and snaps to the wall grid;
   extents are robust (2–98 % percentiles).
5. Labels: a geometric/colour heuristic proposes first. A VLM (`gpt-5.4-mini`) then sees a context render and a
   close-up render from our CPU splat renderer with the box drawn in, and picks from a 38-class industrial taxonomy
   (the "2-D foundation model lifted to 3-D" approach suggested in the brief). Results are cached in
   `vlm_labels.json` keyed by geometry signature. A review layer (`config/scene_annotations.json`) applies region-based
   human corrections, tagged `human-verified`.

## 3. Navigation (`navigation.py`)
* Height-field per cell: the lowest densely supported 5 cm slab, estimated on a 10 cm grid, outlier-filtered and
  resampled to a 5 cm nav grid. Several floor levels are detected (0.00 m main floor, 0.62 m raised area, …).
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

## 6. Front end (`web/`)
three.js 0.180 with **Spark 2.4** (Gaussian-splat renderer that composites with meshes), CSS2D labels, OrbitControls,
and plain JS modules: `facility.js` (splats, frames, robot, route, blocks, nav grid), `xray.js` (procedural pump with
11 tagged components and exploded/ghost views), `training.js` (Learn and Practice), `main.js` (state, panels, command
bar, transitions).

## 7. API (FastAPI, follows the workbook `API_Contract`)
`GET /api/assets`, `/api/assets/{id}`, `/telemetry`, `/events`, `/documents`, `GET /api/scene/anchors`,
`POST /api/copilot/query`, `POST /api/work-orders/draft` (draft only), plus `GET /api/scene`, `GET /api/nav/grid`,
`POST /api/nav/plan`, `GET /api/proximity`, `GET /api/diagnose/{id}`, `POST /api/copilot/command`,
`GET /api/knowledge/search`, `GET /api/xray/model`. Interactive docs are at `/docs`.

## 8. Libraries
numpy, scipy (ndimage, cKDTree), scikit-learn (DBSCAN), pandas/openpyxl, FastAPI/uvicorn, Pillow, OpenAI SDK
(optional); three.js, @sparkjsdev/spark, Vite. Playwright is used only for headless QA screenshots.

## 9. Path to production (Builder Q-07/Q-09)
Swap `metadata.py` for OPC UA / MQTT / CMMS adapters without changing the API. Scene objects and anchors are plain
JSON (center, size, yaw, confidence), easy to export to OpenUSD, Unity or Unreal. Replace the review layer with
QR/NFC confirmations in the field.
