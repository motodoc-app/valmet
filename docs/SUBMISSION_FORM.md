# Submission form — copy-paste answers (Industrial X-Ray)

Fill the official form on **sinceai.app** (one team entry; deadline **Sun 8 Nov 2026, 10:00 Finland time**). Field names
below are the ones an independent audit reported for the form; use whatever the form actually asks.

## Links
| What | Link |
|---|---|
| Live demo (no install, runs in the browser) | https://claude.ai/artifact/FbUbNXsimhQWK9Zw9Vpebs |
| Source code (GitHub) | https://github.com/motodoc-app/valmet (default branch `ccr-3b4e61d7-jdmlgf`) |
| Video (YouTube, unlisted or public) | *paste your link* |
| Pitch deck | https://claude.ai/artifact/S8rpiiuncbmJm7mEiPsFc2 (share it first: Share → Anyone with the link) |
| Source ZIP | `industrial-xray-source.zip` (≈ 84 MB; made by `scripts/make_source_zip.sh`) |
| Backup demo (earlier build) | https://claude.ai/artifact/PKt4BtBkZvpTE3V9RyBDZe |

## Project name
Industrial X-Ray

## Tagline (one line)
A pre-visit copilot: explore the scanned plant, understand the fault, plan access and rehearse the job — before
stepping onto the factory floor.

## Short description (≈ 50 words)
Industrial X-Ray turns Valmet's Gaussian-splat scan and equipment records into an interactive pre-visit workspace. It
segments the scan into 676 object candidates, links workbook assets to them, sends a simulated robot along a
collision-free route, explains the likely fault with cited evidence, and lets technicians look inside equipment, plan
access and hand a case to an expert.

## Long description (≈ 200 words)
The first visit to an unfamiliar plant is where time goes: finding the asset, understanding the fault, clearing access
and reaching an expert all happen on site. Industrial X-Ray moves that preparation before travel.

From Valmet's Equipment Room scan (1.68 M trained Gaussian splats, rendered at full fidelity in the browser) the
pipeline fits floor, walls and ceiling, clusters 676 object candidates with oriented 3D frames, labels them with a
vision model and reports honestly how many are confidently identified (195). The 30 synthetic workbook assets are
linked to scene objects procedurally. A simulated inspection robot plans a collision-free A* route on a 2.5D floor
grid, re-routes around blocked aisles, reads nearby assets on the way, and on arrival stops in front of pump P-005 and
faces it (Robot POV is a simulated camera rendered from the scan). The copilot explains the likely fault from
telemetry, alarms and work orders with checked citations. An exploded, illustrative teaching model opens in the room;
Plan mode moves equipment (approximate collision and clearance checks); Learn/Practice rehearse the task; Support hands
the whole context to a remote expert as an asynchronous link.

All plant data is the challenge's synthetic workbook; there is no connection to real controls or to Valmet DNAe.

## Technologies
Python · FastAPI · NumPy · SciPy · scikit-learn · pandas · openpyxl · JavaScript · three.js · Spark (Gaussian-splat
renderer) · Vite · OpenAI API (gpt-5.4-mini for vision labels of object crops and for diagnosis/copilot narration,
pre-generated for the hosted demo) · Playwright and pytest for testing.

## Challenge
Valmet — Industrial Metaverse: Semantic 3D Scene Understanding & Autonomous Field-Service Copilot.

## Data and AI disclosure (if the form asks)
- Scan: Valmet's *Equipment Room.ply* from the organisers' Google Drive (SHA-256 verified); the originally distributed
  *Industrial Boiler Room.ply* was corrupt (see `docs/integrity_original_boiler_room.md`).
- Plant data: the organisers' synthetic builder-pack workbook. No real plant data.
- AI: vision-model labels (confidence shown, 8 review corrections marked), LLM narration with citation checks; the
  hosted demo shows answers pre-generated at export time and says so. Teaching models are illustrative, not OEM
  drawings or reconstructions from the scan. Collision/clearance checks are approximate. ROI is hypothetical.
- Built with AI coding assistance during the hackathon.
