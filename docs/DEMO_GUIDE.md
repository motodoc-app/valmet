# Demo guide (one page) — "A technician preparing to service pump P-005"

**Live demo:** open the link and wait for the room to appear (a point preview shows first, full detail follows).
No 3D graphics on the machine? It opens the 2D floor plan by itself; finding, diagnosing and the route still work.
**Short on time?** Press **Tour**: it drives the same story by itself.

| # | Do this | Say this (plain words) | For the engineers in the room |
|---|---|---|---|
| 1 | Nothing yet: let the room load on the **Pre-visit briefing** card | "Before travelling, the technician opens the site. This is a real 3D scan of the equipment room." | 1.68 M Gaussian splats, integrity-checked, re-oriented so the floor is y = 0. |
| 2 | Rail → **Scene understanding** (check icon); optionally **Review labels** | "The software split the scan into 676 candidates. We show what that really means: 416 typed, 195 confident, 8 corrected in our review, 30 linked to records. A person can confirm, rename or reject the uncertain ones." | RANSAC planes + recursive DBSCAN + oriented boxes; VLM labels on rendered crops; tiers and an AI second-opinion audit in `docs/SCENE_QUALITY.md`. Review queue: 481 low-confidence / generic candidates, keys Y / R / N; exports a `scene_annotations.json` layer + CSV (`scripts/merge_review.py`). Its agreement rate is not a random sample. |
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
https://claude.ai/artifact/PKt4BtBkZvpTE3V9RyBDZe (live demo: https://claude.ai/artifact/FbUbNXsimhQWK9Zw9Vpebs).

**What is real and what is not:** the room, the object candidates, names and routes come from the supplied scan; object
names are a vision model's guesses with a confidence. All asset data is synthetic. Diagnoses in the hosted demo were
generated in advance. The robot camera is simulated from the scan. Planning is approximate. Remote support is an
asynchronous hand-off. X-Ray models are illustrative. No control of plant equipment. No savings are measured.

## Full walkthrough (28 steps) with the exact control names
Control names below are copied from the code (`web/src/main.js`, `xray-overlay.js`, `planning.js`, `training.js`,
`support.js`). All 28 steps were clicked through on the production build on 7 Nov 2026 (`?scan=off`, headless
Chromium, commit `e694afc`): every step passed, no page errors. Tabs along the top, left to right: **Explore ·
X-Ray · Plan · Learn · Practice · Support · Value**. The camera buttons are in the bottom bar (the dock).

| # | Step | Do exactly this | What you should see |
|---|---|---|---|
| 1 | Open the app | Open the live-demo link (or `npm run dev` → http://localhost:5173) | Loading screen, then the room |
| 2 | Load the facility | Wait for the scan | Right: **Pre-visit briefing · Service P-005** card; left: **Assets by priority** (30) |
| 3 | Explore the room | Drag to orbit, scroll to zoom, or use the navigation pad / `W A S D`, `Q E`; right-hand tool rail: *Semantic view*, *Site map*, *Scene understanding* | Room from any angle; rail tooltips explain each tool |
| 4 | Top view | Dock → **Top** | Straight down on the whole room |
| 5 | Angled view (formerly "Broadcast") | Dock → **Angled** | Above at an angle, like a broadcast camera |
| 6 | Robot POV | Dock → **Robot POV** | Robot's-eye view; HUD "Simulated robot camera — rendered from the 3D scan, not a live feed" |
| 7 | Search P-005 | Press **/** (or click *Ask about the plant*), type *Where is P-005?*, Enter | P-005 selected; asset card on the right |
| 8 | Plan a robot route | Asset card → **Send robot here** | Route drawn; dock shows "8.4 m · A* … ms · clearance 0.206 m · 0 collisions" |
| 9 | Start navigation | (starts by itself) — dock **Pause** / **Play** toggles it; **Speed** cycles 1–4× | Robot drives; *En route* card |
| 10 | Robot moves | Watch, or switch to **Chase** / **Robot POV** mid-route | *Assets read along the way* fills with status and health |
| 11 | Insert an obstacle | Dock → **Block aisle** (enabled while a route is active and the robot has not arrived) | A block appears ahead of the robot |
| 12 | Reroute | (automatic) | New route from the robot's position (≈ 8.4 → 8.65 m), still 0 collisions |
| 13 | Arrive | Wait for the end of the route | Prompt **You've arrived at P-005** with **Inspect equipment** and **See diagnosis**; the diagnosis card opens on the right |
| 14 | Equipment card | Left list → **P-005** (or click the pump) | Asset card: **Robot is here** · **Explore internals (X-Ray)** (primary) · **What's wrong?** · **Plan access** |
| 15 | AI diagnosis | Asset card → **What's wrong?** (or **See diagnosis** on the prompt) | Likely fouling, **52 %** confidence with breakdown, grey source tags; tabs Overview / Evidence / Sources |
| 16 | In-scene X-Ray | Arrival prompt → **Inspect equipment** (or asset card → **Explore internals (X-Ray)**) | Panel over the room: "X-Ray · P-005 · Process pump", badge "Illustrative teaching model — not reconstructed from the scan", suspected parts red |
| 17 | Explode | Panel slider **Explode** (or **Assemble** to put it back) | Parts separate |
| 18 | Inspect components | Click a part in the model or in the panel's list; **See-through**, **Labels**, **Show only this part** | Part highlighted; its function and linked faults on the right of the panel |
| 19 | Close without losing position | Panel **×** (or `Esc`) | Same camera, camera mode, robot position and selection as before (measured: camera moved 0.000 m) |
| 20 | Maintenance planning | Tab **Plan** (or asset card → **Plan access**) | Card "Make room to service P-005": Pick → Move → Check |
| 21 | Move a virtual proxy | **Pick the pallet truck**, then drag it on the floor (or the card's arrow buttons / arrow keys; turn with the wheel, `R`, `Q` / `E` or the dock's turn buttons); **Done – check the result** | Proxy follows; the scanned truck moves with it (approximate cut-out) |
| 22 | Collision / clearance feedback | Drop it on another object to see a collision; **Suggest a good spot for me** for a clean result | While overlapping, the proxy turns red and the *Clearance* tile reads "0 m · collision"; then "It fits. No collisions, the P-005 service zone is clear …", clearance, route 8.40 m → 7.98 m |
| 23 | Reset the layout | **Reset all** (undo with **Undo** / `Ctrl+Z`) | Scanned layout back; no moves |
| 24 | Open a lesson | Tab **Learn** → lesson **01** "Why does fouling lower flow but raise current?" | Lesson text with the relevant parts highlighted |
| 25 | Practice exercise | Tab **Practice** → tick the 3 *Before you start* boxes → **Start exercise** → answer, **Continue** | "Task 1 of 6" …; completion summary with score and takeaways |
| 26 | Remote support | Tab **Support** → **Pin a note** → click the pump → **Save pin** → **Share with expert** (optional **Load example expert reply**) | Banner "Asynchronous hand-off · no live session · no plant controls"; link / package to send |
| 27 | Work-order draft | Explore → P-005 → **What's wrong?** → **Draft work order** (also in Plan and in the expert's reply) | Sheet "Work order draft … Draft · needs planner approval · no control actions" |
| 28 | Business value | Tab **Value** | "What could this be worth?" — every number is a hypothetical input you can change |

Close with rail → **About this demo** (what each capability is and is not). **Reset the whole demo** on the
briefing card puts everything back for the next run.

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

Timing: the robot cruises at 0.6 m/s, so the 8.4 m route takes about 15 s at 1×; press **Speed** for 2× or 4× to fit
the 0:42–0:55 slot.

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
