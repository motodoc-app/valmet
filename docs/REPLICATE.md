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
