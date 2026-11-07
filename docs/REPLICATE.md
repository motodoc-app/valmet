# Run Industrial X-Ray on another room, plant or challenge

The software is not tied to this equipment room. Everything that belongs to one site sits in files you swap:
nothing in the code names this room, these assets or this pump.

| What changes per site | Where it lives | Format |
|---|---|---|
| Site name, input files, robot size, proximity radius, LLM model | `config/project.json` (copy it per site) | JSON, documented below |
| The 3D scan | any path set in `inputs.ply` | Gaussian-splat PLY (3DGS layout: x y z, f_dc_0..2, opacity, scale_0..2, rot_0..3; extra SH bands are ignored) |
| Asset records, telemetry, alarms, work orders, cases, documents | any path set in `inputs.workbook` | Excel workbook with the builder-pack sheets (below) |
| Equipment types: exploded model, components, fault hypotheses, lessons, practice | `backend/xray/knowledge/equipment.json` (`knowledge.equipment_library`) | JSON, one entry per asset class |
| Human corrections to object labels | `config/scene_annotations.json` | merge / relabel rules, each with a note |
| Forced asset ↔ object links (optional) | `config/mapping_overrides.json` | `{asset_id: object_id}` |

## 1. Three commands

```bash
cp config/project.json config/my-site.json          # edit: site.name, inputs.ply, inputs.workbook, robot.*
python scripts/run_pipeline.py --project config/my-site.json
XRAY_PROJECT=config/my-site.json uvicorn --app-dir backend xray.api:app --port 8000   # → http://localhost:8000
```

`run_pipeline.py` runs, in order: PLY validation and canonical frame → planes, objects and oriented frames →
vision-model labels (cached, `--no-vlm` to skip) → merge labels → static export (`--no-llm` for template wording) →
web build with scan chunks and a manifest check. `--from N` resumes at step N. Each step is also a script of its own.

Offline (no API key): `python scripts/run_pipeline.py --no-vlm --no-llm`. Objects then carry geometry labels and the
diagnoses use template wording; the evidence, confidence, citations, routes and every UI feature are unchanged.

## 2. `config/project.json`

```jsonc
{
  "site":   { "name": "Equipment Room" },                 // shown in the app header and page title
  "inputs": { "ply": "data/raw/equipment_room.ply", "workbook": "data/raw/builder_pack.xlsx" },
  "robot":  { "radius_m": 0.20,                            // inflation radius used by the planner
              "max_step_m": 0.18,                          // highest floor step it can climb
              "proximity_m": 1.2,                          // assets inside this radius are "read"
              "obstacle_min_height_m": 0.12, "obstacle_max_height_m": 1.25 },  // what blocks it (overhead pipes do not)
  "geometry": { "voxel_m": 0.03, "nav_cell_m": 0.05, "min_opacity": 0.25, "max_splat_scale_m": 0.25 },
  "llm":    { "model": "gpt-5.4-mini", "vision_model": "gpt-5.4-mini", "enabled": true },
  "knowledge": { "equipment_library": "...", "scene_annotations": "...", "mapping_overrides": "..." }
}
```

Environment variables still override single values: `XRAY_PLY`, `XRAY_XLSX`, `XRAY_LLM_MODEL`, `XRAY_USE_LLM=0`.
The LLM needs `OPENAI_API_KEY`.

## 3. The workbook

Sheets read (by name): `Asset_Master`, `Current_State`, `Telemetry_Sample_3d`, `Alarms_Events`,
`Maintenance_History`, `Historical_Service_Cases`, `Knowledge_Docs`, `RAG_Corpus_Index`, `Data_Quality`,
`Scene_Anchors`. The column names are those of the challenge builder pack (`backend/xray/metadata.py` is the single
place that reads them; adapt it there if a new source names them differently). The asset with the highest
maintenance priority becomes the demo target automatically.

## 4. A new equipment type

Add one entry to `equipment.json` under its asset class (the value in `Asset_Master.asset_class`):

* `label`, `function`, `model_title`
* `components[]`: `id`, `name`, `group`, `function`, `failure_symptoms`, `evidence_signals` (telemetry signal
  names), `issue_codes`, and a `shape` made of primitives (`cyl`, `box`, `sphere`, `torus`, `ring`, `hex`, `thread`, `coil`, `fins`, `blades`, `bolts`) with
  `pos`, `explode` (direction it moves when exploded) and `finish`
* `hypotheses`: issue code → ranked `[text, [component ids]]`
* `learn_topics[]` and `practice_scenarios[]`

`pytest` fails if a workbook asset class has no complete entry, or if a faulty asset's diagnosis points at a
component the model does not have. The X-Ray view, Learn, Practice, the copilot's component answers and the
library all pick the new type up with no code change.

## 5. Check the result

```bash
pytest -q                               # pipeline guarantees (routes collision-free, citations checked, library complete…)
cd web && npm run build && node tests/e2e.mjs     # browser: 3D journey, no-WebGL floor plan, phone layout, copilot
```

## 6. Another challenge entirely

The layers are separable: `ply_io` + `canonical` (any splat scan), `segmentation` + `vlm_labeler` (objects and
names), `navigation` (any robot footprint), `metadata` + `mapping` (any asset register), `copilot` (evidence +
citation-checked narration over any document set), and the web client, which only talks to the API in
`backend/xray/api.py` (or its static export). Replace the layer you need; the others keep working.

## 7. A person confirms the labels (Review labels)

The vision model proposes a label and a confidence for every segmented candidate; a site engineer confirms them in
the app, so every label that reaches the asset register says who checked it.

1. Open the scene, press the **✓ Scene understanding** rail button (phones: Tools → Scene understanding) and choose
   **Review labels**. The queue holds the uncertain candidates first (confidence < 0.70 or "other equipment"; 481 in
   this room); switch to *All candidates* or sort by *Linked assets first* / *Largest first*.
2. For each object the camera flies to it and outlines it in amber. Decide: **✓ Correct as is** (`Y`),
   **✎ Rename** (`R`: free text + category from the scene taxonomy), **✗ Not an object / fragment** (`N`) or
   **Skip** (`→`). `←` goes back, `U` undoes. Decisions are kept in this browser (localStorage) until exported.
3. In **Summary & export** enter your name, check the tally (agreed / renamed / rejected) and the observed
   agreement with a 95 % Wilson interval. This is *your* review, a human check, unlike the AI second-opinion audit;
   because the queue starts with the uncertain objects, the rate describes the reviewed objects, not the whole room.
4. Download **Review layer .json**: the `config/scene_annotations.json` format, one `relabel_near` entry per
   decision (`point` = object centre, `label`, `category`, `note` = "Confirmed / Renamed / Rejected in review by
   <name> on <date> …"; rejected objects get the label `not an object / fragment`). Optionally download the
   **Study .csv** (precision study): the columns of `docs/label_review_sample.csv` plus `verdict, new_label, reviewer, time`.
5. Merge and rebuild:

```bash
python scripts/merge_review.py ~/Downloads/scene_annotations.<name>-<date>.json   # keeps a .bak; same object = replaced
python scripts/run_pipeline.py --from 2                                            # labels become 'review-corrected'
python scripts/scene_quality.py                                                     # refresh the quality panel numbers
```

The hosted demo is a static site: it **cannot write files**. Review in the browser, download, and commit the merged
`config/scene_annotations.json` from a checkout. `relabel_near` matches the nearest candidate within 0.3 m, so the
layer survives pipeline re-runs as long as the segmentation keeps its object centres.
