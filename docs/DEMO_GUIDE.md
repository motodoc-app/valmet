# Demo guide (one page) — "A technician preparing to service pump P-005"

**Live demo:** open the link and wait for the room to appear (a point preview shows first, full detail follows).
No 3D graphics on the machine? It opens the 2D floor plan by itself; finding, diagnosing and the route still work.
**Short on time?** Press **Tour**: it drives the same story by itself.

| # | Do this | Say this (plain words) | For the engineers in the room |
|---|---|---|---|
| 1 | Nothing yet: let the room load on the **Pre-visit briefing** card | "Before travelling, the technician opens the site. This is a real 3D scan of the equipment room." | 1.68 M Gaussian splats, integrity-checked, re-oriented so the floor is y = 0. |
| 2 | Rail → **Scene understanding** (check icon) | "The software split the scan into 676 candidates. We show what that really means: 416 typed, 195 confident, 7 corrected in our review, 30 linked to records." | RANSAC planes + recursive DBSCAN + oriented boxes; VLM labels on rendered crops; tiers and an AI second-opinion audit in `docs/SCENE_QUALITY.md`. |
| 3 | Rail → **Semantic view**, then **Site map** | "Readable from a distance: colour by equipment type, and a floor plan to print before the visit." | One InstancedMesh for all boxes; site map from the occupancy grid + footprints; PNG export. |
| 4 | Press **/**, ask *Where is P-005?* | "It finds the record and the object it is linked to." | Procedural, class-aware link with a stated confidence. |
| 5 | Briefing → **Understand · Open** | "The likely fault, how sure it is, and the first safe step. Every grey tag is a source." | Evidence engine → LLM narration; citations checked; confidence 52 % with breakdown. Synthetic data. |
| 6 | **Plan** tab → pallet truck → drag the stand-in | "A pallet truck blocks the service area. Move a virtual stand-in: collisions, clearance and the route update." | Proxy footprint vs object boxes and the occupancy grid; clearance from the distance transform; re-plan with the original footprint cleared. Approximate — not an engineering check. |
| 7 | **Explore** → *Send robot to check the route*; camera **Broadcast**; speed **4×** | "The way in is checked: a collision-free route that reads every asset it passes." | 2.5D heightfield, clearance-aware A*, smoothing, independent validation. **Block aisle** re-routes live. |
| 8 | **X-Ray**, then **Practice** | "Rehearse: suspect parts in red, then a scored exercise behind a safety check." | 5 device types, 49 components; illustrative teaching models, not OEM. |
| 9 | **Support** tab → pin a note → **Share** | "Send the whole context to a remote expert as a link; the reply comes back with a draft work order." | Asynchronous hand-off (state in the link/package); no live session; no plant controls. |
| 10 | **Value**, then rail → **About** | "Proposed benefits with editable assumptions — and exactly what this prototype is not." | Pilot KPIs in `docs/LIMITATIONS.md`. |

**Handy keys:** `/` ask · `Space` play / pause the robot · `F` hide all panels (focus) · `Esc` close panels / show them again.
**Rewind:** *Reverse* plays the run backwards; the route slider scrubs to any moment.
**If something goes wrong:** add `#plan` to the URL for the floor plan; it needs no GPU. Backup copy of the earlier demo:
see the README.

**What is real and what is not:** the room, the object candidates, names and routes come from the supplied scan; object
names are a vision model's guesses with a confidence. All asset data is synthetic. Diagnoses in the hosted demo were
generated in advance. Planning is approximate. Remote support is an asynchronous hand-off. X-Ray models are
illustrative. No control of plant equipment. No savings are measured.

## Recording the video on a laptop (main video)
1. Chrome, full screen (F11), 1920×1080, fresh page load; close the "New here?" hint.
2. Follow rows 1–10 above, about 25 seconds each; keep the mouse slow; use **Focus (F)** while the robot drives.
3. Use the OS screen recorder (macOS: Cmd+Shift+5; Windows: Win+Alt+R) or OBS; voice over with the "Say this" column.
4. A captioned backup recording made without a GPU is produced by `web/tests/record-demo.cjs`.
