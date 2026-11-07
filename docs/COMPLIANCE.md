# Challenge compliance — requirement by requirement

Checked on 7 Nov 2026 against commit `e694afc` (branch `ccr-3b4e61d7-jdmlgf`) by reading the code, running the
documented commands and a 28-step click-through of the production build (`?scan=off`, headless Chromium).

**Sources of the requirements.**
* **Valmet's challenge brief:** *Valmet_x_SinceAI_2026_Challenge_Brief_FINAL_updated (1).docx* in the organisers'
  Google Drive folder (sections 01–08). Quotes below are its exact wording.
* **The workbook's `Builder_Questions` sheet** (Q-01 … Q-10) in `builder_pack.xlsx`, also from the organisers.
* **The organisers' Discord announcement** "How to make a winning demo video" (screenshots shared by the team).
* **The general hackathon criteria** (Technical execution 30 %, Challenge fit & impact 25 %, Innovation 20 %,
  Prototype & demo 15 %, Responsible implementation & feasibility 10 %) come from the team's QA brief. We have not
  seen them in an official organiser document, so section 4 treats them as the team's reading.
* **The submission platform and its form fields are unknown to us.** They are not in the brief, the workbook or the
  messages we have. See [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md).

**Test evidence** names a suite and a check exactly as it prints. Suites and their check counts on `e694afc`:
`web/tests/e2e.mjs` 78 · `e2e-pov-xray` 54 · `e2e-planning` 58 · `e2e-review` 45 · `e2e-ux` 65 · `e2e-support` 45 ·
`e2e-copilot` 31 · `e2e-render` 26 · `e2e-layers` 22 · `pytest tests` 19 (all passed in the final-QA baseline run;
for this document pytest and the journey were re-run and passed). "Journey" means the 28-step
click-through in [`DEMO_GUIDE.md`](DEMO_GUIDE.md) (all 28 steps passed on this commit).

Status: **Met** = implemented, verified in code and by a test or the journey. **Partial** = works but with a gap
stated in the row. **Not met** = missing.

## 1. Valmet's demo requirements (brief §07 "Submission Format": "At minimum, the demo must:")

| # | Requirement (exact wording) | Where implemented | Demo evidence | Test evidence | Status | Limitations |
|---|---|---|---|---|---|---|
| V1 | "process Industrial Boiler Room.ply to extract and 3D-frame as many industrial assets/objects as possible (similar to the concept shown in semantic extraction demo 1.mp4 and semantic extraction demo 2.mp4)" | `backend/xray/ply_io.py`, `canonical.py`, `segmentation.py` (`cluster_objects`: DBSCAN eps 7.5 cm, recursive re-clustering, oriented boxes), `vlm_labeler.py` (38-class taxonomy); `scripts/step1_scene.py` … `step3_vlm.py` | Rail → *3D frames*, *Semantic view*, *Scene understanding* (676 → 416 → 195 → 8 → 30) | pytest `test_objects_are_framed_and_labelled`, `test_scene_quality_tiers_are_consistent_with_scene_json`; e2e-layers "semantic: one InstancedMesh for every object" | **Met** (on the replacement scan) | The original *Industrial Boiler Room.ply* is corrupt from record 502,483 in every copy ([`integrity_original_boiler_room.md`](integrity_original_boiler_room.md)); we use the *Equipment Room.ply* Valmet shared on Google Drive (SHA-256 verified). 676 are **candidates**, not recognised objects: 416 have a specific type, 195 a confidence ≥ 0.70; an AI second-opinion audit agreed with 18 % of a 60-object sample ([`SCENE_QUALITY.md`](SCENE_QUALITY.md)). |
| V2 | "map device statuses, telemetry, and metadata from Valmet_SinceAI_2026_Synthetic_Industrial_Metaverse_Builder_Pack.xlsx to the extracted 3D assets (random/procedural mapping is allowed), including designating a pre-determined faulty target device" | `metadata.py` (reads 10 data sheets), `mapping.py` (class-aware one-to-one binding with `method` and `mapping_confidence`); target = highest criticality × (100 − health) × model confidence → P-005 | Asset list (left), asset card, *Pre-visit briefing · Service P-005* | pytest `test_mapping_is_one_to_one_and_target_reachable`; journey step 7 | **Met** | All 30 workbook assets are linked; the other 646 candidates carry scene labels only (the workbook has 30 assets). Links are procedural, as the brief allows. |
| V3 | "simulate a service worker avatar or 3D robot walking along an automatically defined, logical, collision-free path (not passing through walls or obstacles) to locate the faulty device" | `navigation.py` (multi-level height field, obstacle band 0.12–1.25 m, clearance-aware 8-connected A*, line-of-sight smoothing, independent validation); browser port in `web/src/static-api.js`; robot in `facility.js` | *Send robot here* → robot drives 7.7 m to P-005 (stops ≈ 1 m in front of the pump set, facing it), 0 collisions, min clearance 0.206 m (≥ 0.20 m radius) | pytest `test_route_is_collision_free`, `test_reroute_around_blocked_walkway`; e2e "3D: route collision-free", "3D: robot moves", "3D: block aisle reroutes"; journey 8–12 | **Met** | The robot is virtual; geometry is from one unsurveyed scan (scale ≈ metric). Validation is against our own obstacle grid, not ground truth. |
| V4 | "dynamically highlight and display the 3D frames and mapped Excel metadata for nearby assets encountered along the avatar/robot's path" | Proximity radius 1.2 m (`config/project.json`); arc-length index per object (`main.js` playback); *En route* card "Assets read along the way" with status, issue and health; `/api/proximity` | Mid-route: frames light up within 1.2 m, the card lists each workbook asset passed | e2e "3D: proximity follows scrubbing", "No WebGL: route shown" | **Met** | Shows the workbook status for the 30 linked assets; other framed candidates are counted, not described. |
| V5 | "trigger an AI-assisted diagnostic and service guidance workflow when the avatar/robot reaches the faulty device" | `copilot.py` (evidence engine, confidence, hypotheses, citation checker, LLM narration with template fallback); arrival in `main.js` + `xray-overlay.js` (*You've arrived at P-005*) | On arrival: diagnosis card (52 % confidence with breakdown, cited evidence, next safe step), *See diagnosis* / *Inspect equipment* | e2e "3D: arrival diagnosis", "3D: citations rendered", "3D: evidence tab shows telemetry"; e2e-pov-xray "Arrival → See diagnosis"; pytest `test_diagnosis_is_grounded`, `test_citation_checker_strips_unknown_ids` | **Met** | Hosted demo: diagnoses were generated in advance by the same backend (labelled). The OpenAI account used in development has no credits; live AI needs your own key. Not a validated diagnostic model. |
| V6 | "display the simulation on any convenient, easy-to-build UI/platform (Python visualizer, web app, game engine, etc.)" | `web/` (three.js 0.180 + Spark 2.4, Vite); FastAPI server or static export; 2D floor-plan fallback (`plan2d.js`) | Live demo link; `npm run dev` on localhost | e2e "3D: app boots", "No WebGL: floor plan opens", "Context loss: switches to floor plan" | **Met** | Software rendering (no GPU) is slow with the full scan; use `?scan=off` or `#plan` there. |

## 2. Valmet's submission package (brief §07 "Submission package:")

| # | Requirement (exact wording) | Where | Status | Notes |
|---|---|---|---|---|
| P1 | "working demo (runnable locally in Python/Rust/web or clearly recorded)" | Live demo artifact; `npm run dev` / `uvicorn` (README *Run it*) | **Met** | Verified on this commit: `npm run build` (manifest check OK), backend on a test port answered `/api/assets`, `/api/diagnose/<P-005>` (confidence 0.52) and `/docs`. |
| P2 | "source-code repository with concise README and setup instructions" | GitHub `motodoc-app/valmet`, branch `ccr-3b4e61d7-jdmlgf`; `README.md` | **Partial** | README and setup are in place. **Repository visibility is unknown to us**: judges need access (make it public or add them). Server mode and `pytest` need the organisers' workbook in `data/raw/` (git-ignored); the static demo does not. |
| P3 | "5–8 presentation slides describing the 3D semantic extraction pipeline, obstacle-free pathfinding logic, Excel metadata mapping, and AI approach" | Deck artifact (8 slides: cover + 7); text in [`PITCH.md`](PITCH.md) | **Met** (content) / sharing pending | The deck is private until shared from its Share menu. |
| P4 | "short demo video (maximum 5 minutes) showing the avatar/robot navigating the logical path in Industrial Boiler Room.ply, framing nearby assets along the way, and diagnosing the faulty device" | Script in [`DEMO_GUIDE.md`](DEMO_GUIDE.md); narration, subtitles and timing in `docs/video/` | **Not met yet** | The video has not been recorded. The organisers' Discord asks for **about 2 minutes** with voice narration and English subtitles, which also satisfies Valmet's 5-minute maximum. The pre-recorded narration follows an earlier cut (no Robot POV, no in-scene X-Ray). |
| P5 | "brief technical note describing the models, libraries, and software components used" | [`ARCHITECTURE.md`](ARCHITECTURE.md) | **Met** | |

## 3. Requirement areas named in the team's QA brief

| Area | Requirement (wording from Valmet's brief unless marked) | Where implemented | Demo evidence | Test evidence | Status | Limitations |
|---|---|---|---|---|---|---|
| 1. Semantic scene understanding | "extract rich semantic equipment information and navigable space from a base 3D Gaussian Splatting environment" (§02) | RANSAC floor/ceiling/4 walls, objects, labels (`segmentation.py`, `vlm_labeler.py`); walkable area 19.57 m² (`navigation.py`); *Scene understanding* panel (`quality.js`, `scripts/scene_quality.py`) | Rail → *Scene understanding*, *Semantic view*, *Site map*, *Floor map* | pytest `test_scene_quality_tiers_are_consistent_with_scene_json`; e2e-layers "site map: drawn (many colours)" | **Met** | Labels are a vision model's self-reported, uncalibrated guesses. |
| 2. Object identification | "which clusters of points represent individual machines" (§02) | VLM labels with confidence; *Review labels* queue of 481 candidates (`review.js`) with export and `scripts/merge_review.py` | Ask "Where is the expansion vessel?"; *Review labels* | e2e "Copilot: “Where are the control valves?”"; pytest `test_scene_search_finds_objects_by_meaning`; e2e-review "merge_review.py merges the export" | **Partial** | No human-verified precision: the AI audit (18 % agreement, 53 % "can't tell") is not ground truth, and no site staff have reviewed labels. 260 candidates stay "other equipment" rather than being guessed. |
| 3. Autonomous navigation | "the avatar or 3D robot automatically calculate and travel a logical, real-world path to the pre-determined faulty device" (§06) | Default start = farthest drivable cell; A* to the target's approach cell; copilot command "Send a technician to …" plans and drives | *Send robot here*; ask "Send a technician to inspect the faulty pump" | e2e "Copilot: “Send a technician to inspect the faulty pump”", "3D: robot moves"; journey 8–10 | **Met** | Autonomy is limited to route planning and driving in simulation; nothing is dispatched in the real world. |
| 4. Obstacle avoidance | "walking on valid floor paths and avoiding walls/obstacles rather than walking through solid objects" (§06) | Obstacle band relative to the local floor, clearance ≥ robot radius, step limit 0.18 m, 2.5 cm re-sampled validation; *Block aisle* re-plans from the robot's position; Plan-mode proxies become obstacles | *Block aisle* mid-route (new detour from the robot's position, 0 collisions); Plan: route 7.72 m → 7.63 m | pytest `test_reroute_around_blocked_walkway`, `test_layout_plan_clears_one_footprint_and_blocks_another`; e2e "3D: block aisle reroutes"; e2e-planning "Route before and after computed, both collision-free" | **Met** | Unsegmented objects are invisible to the planner (known case: a second pallet truck at ≈ (2.75, 0.90) m). |
| 5. Asset information | "device statuses, metadata, and telemetry values provided in the Excel builder pack" (§02) | Asset card, diagnosis *Evidence* tab (telemetry z-scores, events, work orders, cases, data quality), Library (`/api/knowledge/search`) | Asset card → *What's wrong?* → Evidence / Sources | e2e "3D: evidence tab shows telemetry", "No WebGL: P-005 evidence (telemetry, events)" | **Met** | All values are synthetic. The workbook's full 14-day telemetry CSV was not supplied; the 3-day sample is used. |
| 6. AI-supported fault diagnosis | "an AI assistant diagnoses the condition and recommends next inspection/service steps based on the Excel pack's data and documentation" (§02) | `copilot.py` evidence engine + hypotheses linked to X-Ray components + next safe steps; 30 diagnoses exported | P-005: likely fouling, 52 % | pytest `test_diagnosis_is_grounded`, `test_diagnosis_links_to_components_for_every_faulty_asset`; e2e "3D: arrival diagnosis" | **Met** | Rule-based evidence and LLM wording; not validated against real outcomes. |
| 7. Evidence and explainability | "AI diagnostics, grounding & explainability … provide grounded troubleshooting/inspection guidance" (§06); Q-03 "Explain every diagnosis with exact evidence IDs and confidence"; Q-06 "Reduce confidence when sensor or mapping quality is poor" | Citation checker removes IDs not in the evidence; confidence = model × evidence × (1 − data-quality penalty) × (0.6 + 0.4 × mapping confidence), shown with its breakdown | Diagnosis card → confidence breakdown, grey source tags that open documents | pytest `test_citation_checker_strips_unknown_ids`, `test_answer_cites_only_context_ids`, `test_faq_file_is_complete_and_grounded`; e2e-copilot "citation click opens the source" | **Met** | Confidence formula is our design, not calibrated. |
| 8. Industrial relevance | Guiding question: "deliver AI service guidance" so a robot can "realistically navigate to a faulty device" (§03) | Pre-visit workflow (Explore → Understand → Plan → Practise → Support); work-order draft; read-only design; Valmet DNAe only as a possible future, authorised read-only data source (roadmap; the prototype does not connect to DNAe) | Briefing card steps 1–5; *Draft work order* | e2e "No WebGL: work order draft"; e2e-planning "Draft work order includes the access preparation" | **Partial** | Not tested with technicians or real plant data; benefits are hypotheses ([`LIMITATIONS.md`](LIMITATIONS.md)). |
| 9. Technician workflows | Q-05 "Support 3D object → evidence → service case → work-order draft on mobile/tablet"; Q-10 "Package evidence for remote expert collaboration" | Asset card actions, diagnosis, *Draft work order* (`POST /api/work-orders/draft`, draft only), Plan, Learn, Practice, Support (`support.js`), phone layout (`mobile.js`) | Journey 13–27 | e2e "Phone plan: dispatch by tap"; e2e-support "expert: work-order draft opens (draft only)", "reply: recommendation shown with citations"; e2e-ux phone checks "…: Tools sheet lists the rail actions incl. About" | **Met** | Remote support is an asynchronous hand-off (link/package), not a live session. Work orders are drafts; no CMMS. |
| 10. Responsible and safe implementation | Workbook `START_HERE`: "no … autonomous field-control instructions"; team rules: label simulated and synthetic content | No write path to any control system; safety gates before Practice; "Synthetic data", "Simulated robot camera", "Illustrative teaching model", "approximate" labels on screen; About sheet; [`LIMITATIONS.md`](LIMITATIONS.md) | Practice: 3 check boxes before *Start exercise*; POV HUD; X-Ray badge; Plan disclaimer | e2e-pov-xray "POV HUD: labelled as simulated, speed + distance", "X-Ray panel: labelled illustrative, suspected parts in red"; e2e-planning "Right card states the honest disclaimer"; e2e-support "tech: banner says no live session"; journey 25 | **Met** | Training content is conceptual, not certified; no security review, authentication or audit log (prototype). |

### Builder questions (workbook sheet `Builder_Questions`)

| Q | Builder question (exact wording) | Status | Where |
|---|---|---|---|
| Q-01 (P0) | "Identify a device in 3D and show its current state, recent evidence and documents." | **Met** | Asset card, diagnosis, Library |
| Q-02 (P0) | "Detect emerging degradation from multivariate time-series patterns." | **Partial** | z-scores against the asset's own baseline and peers, and a per-day trend (`copilot.py`); no trained anomaly model; the asset's state label comes from the workbook |
| Q-03 (P0) | "Explain every diagnosis with exact evidence IDs and confidence." | **Met** | Citation checker, confidence breakdown |
| Q-04 (P1) | "Prioritize work using condition, criticality and uncertainty." | **Met** | Priority = criticality × (100 − health) × model confidence; *Assets by priority* list |
| Q-05 (P0) | "Support 3D object → evidence → service case → work-order draft on mobile/tablet." | **Met** | Phone layout; e2e phone checks |
| Q-06 (P0) | "Reduce confidence when sensor or mapping quality is poor." | **Met** | Data-quality penalty and mapping-confidence factor |
| Q-07 (P1) | "Replace synthetic feeds with OPC UA/MQTT/API sources without redesigning the product." | **Partial** (design only) | `metadata.py` is the single reader; [`DATA_INTEGRATION.md`](DATA_INTEGRATION.md); no connector built |
| Q-08 (P2) | "Upgrade scene mapping to CV/VLM recognition while preserving identity confidence." | **Partial** | Objects are VLM-labelled; asset ↔ object links stay procedural with a mapping confidence |
| Q-09 (P1) | "Remain portable across web, OpenUSD/Omniverse, Unity and Unreal." | **Partial** (web only) | Objects and anchors are plain JSON; no OpenUSD/Unity/Unreal export built |
| Q-10 (P1) | "Package evidence for remote expert collaboration." | **Met** | Support hand-off (link, code, JSON/Markdown package) |

### Organisers' video guidance (Discord announcement)
"You have around 2 minutes"; recommended structure "Problem (0–15s) · Solution (15–35s) · Live Demo (35–95s) ·
Business Impact (95–120s)"; "Localhost is enough!"; "Simulated data and prototypes are fine — just clearly explain
what's real and what's simulated"; "Add voice narration + English subtitles!". The presenter script in
[`DEMO_GUIDE.md`](DEMO_GUIDE.md) follows this structure. **Status: script ready, video not recorded.**

## 4. Valmet's evaluation criteria (brief §06) — self-assessment

| Criterion (weight) | Our evidence | Honest assessment |
|---|---|---|
| Semantic asset extraction density & 3D framing (30 %) | 676 framed candidates + floor, ceiling, 4 walls; tiers 416 / 195 / 7 / 30; all 30 workbook assets mapped | Strong on density and framing; weaker on verified correctness (AI audit 18 % agreement on a sample, no human precision figure). |
| Realistic obstacle-aware navigation & proximity display (25 %) | Validated collision-free routes, live reroute, proximity list both directions, five camera modes incl. Robot POV | Strong. Caveat: obstacles are only what segmentation and the occupancy grid see. |
| AI diagnostics, grounding & explainability (20 %) | Evidence engine, citation checker, confidence breakdown, 30 pre-generated diagnoses, 320 cited FAQ answers | Strong on grounding; live LLM not demonstrable on the hosted site and the dev key has no credits. |
| Backend architecture & technical implementation (15 %) | Modular Python pipeline (`run_pipeline.py`, 6 steps), FastAPI following `API_Contract`, static export, config per site, 19 pytest + 424 browser checks | Strong. Server mode needs the organisers' workbook locally. |
| Demo clarity & innovation (10 %) | Pre-visit story, Tour, in-scene X-Ray, Plan mode, Support hand-off, 2D fallback | Good; depends on the video, which is not yet recorded. |

## 5. General hackathon criteria (from the team's QA brief; distinct from Valmet's technical requirements)

| Criterion (weight) | Self-assessment | What would raise it |
|---|---|---|
| Technical execution (30 %) | High: end-to-end pipeline from raw PLY to a hosted app; every route validated; 443 automated checks passing; graceful fallbacks (classic scan, `scene.splat`, 2D plan). | Human-verified label precision; a real GPU benchmark. |
| Challenge fit & impact (25 %) | High fit: all six §07 demo items are met; follows Valmet's on-site feedback (pre-visit, interaction, Robot POV, in-scene X-Ray). Impact is argued, not measured. | Pilot KPIs in [`LIMITATIONS.md`](LIMITATIONS.md). |
| Innovation (20 %) | Medium–high: grab-and-move scan cut-outs in Plan mode, in-scene exploded models, citation-checked copilot, honest quality tiers. Individual techniques (DBSCAN, A*, BM25) are standard. | Per-object Gaussian extraction ([`RESEARCH_NOTES.md`](RESEARCH_NOTES.md)). |
| Prototype & demo (15 %) | Prototype: high (works hosted, on localhost and without WebGL). Demo: **at risk until the video is recorded**. | Record the ~2-minute video with narration and subtitles. |
| Responsible implementation & feasibility (10 %) | High: read-only by design, safety gates, every simulated/synthetic/illustrative element labelled, limitations and pilot path written down; no claim of DNAe connection. Feasibility rests on stated assumptions. | Security review, authentication and audit logging in a pilot. |

## 6. What could not be verified
* The submission platform and its fields.
* Whether the GitHub repository is visible to judges.
* The general hackathon criteria's official source (we only have them from the team's brief).
* Real-world accuracy of anything: labels, links, diagnoses and clearances are unverified on site.
