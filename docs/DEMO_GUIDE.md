# Demo guide (one page) — "A technician preparing to service pump P-005"

**Live demo:** open the link and wait for the room to appear (a point preview shows first, full detail follows).
No 3D graphics on the machine? It opens the 2D floor plan by itself; finding, diagnosing and the route still work.
**Short on time?** Press **Tour**: it drives the same story by itself.

| # | Do this | Say this (plain words) | For the engineers in the room |
|---|---|---|---|
| 1 | Nothing yet: let the room load on the **Pre-visit briefing** card | "Before travelling, the technician opens the site. This is a real 3D scan of the equipment room." | 1.68 M Gaussian splats, integrity-checked, re-oriented so the floor is y = 0. |
| 2 | Rail → **Scene understanding** (check icon); optionally **Review labels** | "The software split the scan into 676 candidates. We show what that really means: 416 typed, 195 confident, 7 corrected in our review, 30 linked to records. A person can confirm, rename or reject the uncertain ones." | RANSAC planes + recursive DBSCAN + oriented boxes; VLM labels on rendered crops; tiers and an AI second-opinion audit in `docs/SCENE_QUALITY.md`. Review queue: 481 low-confidence / generic candidates, keys Y / R / N; exports a `scene_annotations.json` layer + CSV (`scripts/merge_review.py`). Its agreement rate is not a random sample. |
| 3 | Rail → **Semantic view**, then **Site map** | "Readable from a distance: colour by equipment type, and a floor plan to print before the visit." | One InstancedMesh for all boxes; site map from the occupancy grid + footprints; PNG export. |
| 4 | Press **/**, ask *Where is P-005?* | "It finds the record and the object it is linked to." | Procedural, class-aware link with a stated confidence. |
| 5 | Briefing → **Understand · Open** | "The likely fault, how sure it is, and the first safe step. Every grey tag names its source; document tags open." | Evidence engine → LLM narration; citations checked; confidence 52 % with breakdown. Synthetic data. |
| 6 | Asset card → **Send robot here**; mid-route switch the camera to **Robot POV** (or **Angled**, speed **4×**) | "The way in is checked: a collision-free route that reads every asset it passes. This is the robot's view — simulated from the scan, not a live camera." | 2.5D heightfield, clearance-aware A*, smoothing, independent validation. POV: 0.95 m up, 8° down, smoothed turning; switching camera never restarts the route. **Block aisle** re-routes live. |
| 7 | *You've arrived at P-005* → **Inspect equipment** (or **Explore internals (X-Ray)** on the card) | "Look inside without leaving the room: suspect parts in red. Close it and we're exactly where we were." | Exploded model drawn in a panel over the room; robot paused while open; × / Esc restores camera pose, mode, robot motion and selection. Illustrative teaching model, not reconstructed from the scan, not OEM. **Open full X-Ray view** → *Practice* for the scored exercise. |
| 8 | Card → **Plan access** → grab the pallet truck, turn it (wheel / R / Q E), drop it | "A pallet truck blocks the service area. Pick it up and move it: collisions, clearance and the route update." | Any floor object can be moved; the splats inside its box move with it (approximate cut-out: may leave holes or ghosting). Checks vs object boxes and the occupancy grid; route re-planned with the original footprint cleared; undo / redo. Approximate — not an engineering check. |
| 9 | **Support** tab → pin a note → **Share** | "Send the whole context to a remote expert as a link; the reply comes back with a draft work order." | Asynchronous hand-off (state in the link/package); no live session; no plant controls. |
| 10 | **Value**, then rail → **About** | "Proposed benefits with editable assumptions — and exactly what this prototype is not." | Pilot KPIs in `docs/LIMITATIONS.md`. |

**Handy keys:** `/` ask · `Space` play / pause the robot · `F` hide all panels (focus) · `Esc` close panels / show them again
(and closes the in-scene X-Ray) · in Plan: `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo.
**Plan caveat:** *Suggest a good spot* can put the pallet truck next to a second scanned pallet truck at about
(2.75, 0.90) m: that one was not segmented as an object, so the planner does not know it is there. Place it by hand
in the demo.
**Rewind:** *Reverse* plays the run backwards; the route slider scrubs to any moment.
**If something goes wrong:** add `#plan` to the URL for the floor plan; it needs no GPU. Backup copy of the earlier demo:
see the README.

**What is real and what is not:** the room, the object candidates, names and routes come from the supplied scan; object
names are a vision model's guesses with a confidence. All asset data is synthetic. Diagnoses in the hosted demo were
generated in advance. The robot camera is simulated from the scan. Planning is approximate. Remote support is an
asynchronous hand-off. X-Ray models are illustrative. No control of plant equipment. No savings are measured.

## Presenter script (≈ 2 min, organisers' format)
| Time | Part | Do | Say (summary) |
|---|---|---|---|
| 0:00–0:15 | Problem | Title over the scan | "The first visit to an unfamiliar plant is where the time goes: finding the asset, the fault, access and an expert all happen on site." |
| 0:15–0:35 | Solution | Scan → semantic view → Scene understanding | "A scan becomes a workspace you prepare in before you travel: 676 object candidates, and we show honestly how many are confidently identified." |
| 0:35–0:42 | Live demo | Ask *Where is P-005?* → card → **What's wrong?** | "Likely fouling, 52 % confidence, every claim cited. Synthetic data." |
| 0:42–0:55 | | **Send robot here** → switch to **Robot POV** mid-route | "The robot checks a collision-free way in. This is its camera — simulated from the scan, not a live feed." |
| 0:55–1:10 | | *You've arrived at P-005* → **Inspect equipment** → explode, suspect parts red → **×** | "Look inside without leaving the room: an illustrative teaching model. Close it and we're exactly where we were." |
| 1:10–1:35 | | **Plan access** → grab the pallet truck → drop it clear | "The truck blocks the service area. Move it: collisions, clearance and the route update — the route gets shorter. Approximate, not an engineering check." |
| 1:35–2:00 | Business impact | Value page → closing title | "Technicians arrive prepared. Data is synthetic and savings are not yet measured; a pilot measures time to find equipment and to prepare a visit." |

Mention the **Support** hand-off in one line if time allows ("send the whole context to an expert as a link —
an asynchronous hand-off, not a live session").

## The 2-minute submission video (organisers' format: Problem 0–15 s · Solution 15–35 s · Live demo 35–95 s · Business impact 95–120 s)
Everything for it is in `docs/video/`:
The pre-recorded narration below follows an earlier cut (it does not mention Robot POV or the in-scene X-Ray, and its
live-demo part runs 0:37–1:23). To show the new features, narrate the presenter script above in your own voice, or
keep the recorded narration and simply use the in-scene X-Ray and Plan access buttons during its X-Ray and Plan lines.
- `script.json` — the 14 narration lines, each tied to a scene.
- `narration.mp3` — the voice-over (110.7 s, **AI-generated voice**, OpenAI text-to-speech), made by `python scripts/make_narration.py`.
- `subtitles.srt` — English subtitles timed to that narration (upload with the video, or burn in).
- `timing.json` — when each line starts; the backup recorder uses it.

| Time | Part | What is on screen | Narration (summary) |
|---|---|---|---|
| 0:00–0:13 | Problem | Title over the scan | The first visit to an unfamiliar plant is where the time goes. |
| 0:14–0:37 | Solution | Scan → semantic view → Scene understanding | A scan becomes a prepare-before-you-travel workspace; 676 candidates, honestly measured. |
| 0:37–1:23 | Live demo | Ask “Where is P-005?” → diagnosis → **Plan** (move the pallet truck) → robot route → X-Ray → **Support** hand-off | Find, understand, plan access, check the way in, rehearse, ask an expert. |
| 1:23–1:50 | Impact | Value page → closing title | Arrive prepared; synthetic data, savings not yet measured; what a pilot measures. |

**Recording it yourself (recommended, real GPU):** open the app full screen at 1920×1080, start your screen recorder
(OBS, or Cmd+Shift+5 / Win+Alt+R), play `narration.mp3` in your headphones and click through the scenes in the table
as the narration reaches them; afterwards put `narration.mp3` under the video and add `subtitles.srt` (CapCut / OBS /
YouTube). Or narrate it in your own voice using the lines in `script.json`.
**Backup recording (no GPU needed):** `node web/tests/record-demo.cjs http://localhost:4710/ out-dir` renders the same
timeline frame by frame with the narration and burned-in English subtitles.
