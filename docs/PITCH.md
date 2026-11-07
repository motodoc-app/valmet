# Pitch: Industrial X-Ray — the pre-visit copilot

**One line:** We turn a scan of an unfamiliar industrial site into an interactive workspace where technicians can
understand equipment, plan maintenance, rehearse procedures and get expert support — before they arrive.

**Promise:** Explore the site. Understand the equipment. Plan the maintenance. Practise the task. Get expert support.
Before stepping onto the factory floor.

Everything below is shown in the working prototype (in the hosted demo the diagnoses were generated in advance), and every limit is stated on screen and in
[`LIMITATIONS.md`](LIMITATIONS.md). Numbers come from the repository (`docs/SCENE_QUALITY.md`, tests, the app).

---

## Slides (7)

**1 · The problem: the first visit is the expensive one**
A technician is sent to service a pump at a plant they have never seen. Today they arrive with a work order, a PDF
and a phone number. Finding the asset, understanding its condition, clearing access and getting expert advice all
happen on site, under time pressure.
*Visual: the raw scan opening on the briefing card "Service P-005".*

**2 · A real scan, understood — and measured honestly**
The supplied Gaussian-splat scan (1.68 M splats, integrity-checked) is segmented into **676 object candidates**, each
with an oriented 3D box, a name and a confidence. We report what that number means:

| Tier | Count |
|---|---:|
| Segmented candidates | 676 |
| Given a specific equipment type | 416 |
| Specific type with confidence ≥ 0.70 | 195 |
| Corrected in the team's visual review (not field-verified) | 7 |
| Linked to a (synthetic) workbook asset | 30 |

An AI second-opinion check of a 60-object random sample agreed with 18 % of specific labels (95 % CI 11–30 %; half
could not be judged from sparse renders). **We do not claim 676 recognised objects.** A human check sheet is ready
(`docs/label_review_sample.csv`); a pilot would report precision and recall per category.
*Visual: the Scene-understanding panel, then the colour-coded semantic view and the site map.*

**3 · Plan the visit: interactive maintenance planning**
A pallet truck is parked in P-005's service area. In Plan mode (or *Plan access* on the asset card) the technician
grabs it — or any other floor object — lifts, turns and drops it; the scanned splats inside its box move with it.
Collisions with known obstacles, approximate clearance, whether the service zone is clear, and the robot's route
before and after are recomputed on the spot; every step can be undone. The scan file is never changed; the plan
exports as a summary.
*Approximate geometry (boxes + occupancy grid) — not an engineering clearance check. The cut-out is approximate and
may leave holes or ghosting.*
*Visual: dragging the proxy from red to green; route before/after.*

**4 · Understand the fault, with evidence**
The copilot explains P-005's likely fouling: telemetry against its own baseline and its peers, alarms, work orders
and similar cases, a confidence of 52 % with its breakdown, and the first safe step. Every claim cites a record;
unsupported citations are removed automatically. A collision-free route (A* on a 2.5D heightfield, validated) shows
the way in; it re-routes live when an aisle is blocked. Ride along in *Robot POV* (or Chase, Angled, Top, Free) —
a simulated robot camera rendered from the scan, not a live feed — and on arrival the app offers *Inspect
equipment* or *See diagnosis*.
*Data: the challenge's synthetic workbook. Hosted demo: diagnoses and 320 copilot answers generated in advance by the
same backend, and labelled so. If live AI is unavailable on a server, the pre-generated narrative is shown, labelled.*

**5 · Rehearse before touching anything**
*Explore internals (X-Ray)* opens a teaching model of the pump in a panel right over the room, with the suspect parts
in red; closing it returns to exactly the same view, robot state and selection. The full X-Ray view, Learn and a
scored Practice exercise behind a safety check go deeper. Five equipment types, 49 components.
*Illustrative teaching models — not manufacturer drawings, not reconstructed from the scan, not certified training.*

**6 · Expert support without a site visit**
The technician pins notes on the scene and sends the whole context — asset, evidence, plan and pins — to a remote
specialist as a link or package. The expert adds a recommendation (optionally AI-drafted, marked for review) and a
draft work order, and sends it back.
*Asynchronous hand-off: no live multi-user session in this prototype; no connection to plant controls.*

**7 · Value, limits and the pilot**
Proposed benefits: better-prepared technicians, less uncertainty at unfamiliar sites, faster equipment
identification, planned access, knowledge transfer, more useful remote support, possibly fewer repeat visits.
**None are measured yet.** The Value page shows the arithmetic with editable, hypothetical inputs.
Pilot KPIs: object-identification precision/recall on a labelled sample · share of target assets located correctly
· time to find equipment · time to prepare a visit · planning collisions caught · training scores · time to assemble
a remote-support case · start-up time and frame rate on standard laptops · technician confidence (SUS).
Roadmap: read-only plant data connectors (OPC UA / historian / CMMS, see [`DATA_INTEGRATION.md`](DATA_INTEGRATION.md)),
per-object Gaussian extraction and IFC for key equipment ([`RESEARCH_NOTES.md`](RESEARCH_NOTES.md)), live
multi-user sessions, a live camera feed from a real robot, a real CMMS integration.
Browser-based: no install, a shareable link — advantages over current tools are hypotheses to benchmark, not claims.

---

## Live presentation (≈ 4 min)

| t | Do | Say |
|---|---|---|
| 0:00 | App open on the briefing card | "A technician has to service pump P-005 at a site they've never seen. This is a real scan of that room." |
| 0:20 | Rail → Scene understanding | "676 candidates — and we're honest about what that means: 416 typed, 195 confident, 30 linked to records." |
| 0:45 | Rail → Semantic view, then Site map | "Readable from a distance: colour by equipment type. And a floor plan you can print before you travel." |
| 1:05 | Ask "Where is P-005?" → Understand → Open | "The copilot finds it and explains the likely fouling — every claim links to its source. Synthetic data." |
| 1:35 | Card → Send robot here → Robot POV mid-route | "The way in is checked: a collision-free route that reads every asset it passes. This is the robot's simulated camera, rendered from the scan." |
| 2:05 | Arrival prompt → Inspect equipment → close | "Look inside without leaving the room — an illustrative teaching model — and close it to land exactly where we were." |
| 2:30 | Card → Plan access → grab the pallet truck → drop | "The service area is blocked. Move it — collisions, clearance and the route update instantly." |
| 3:00 | Open full X-Ray view → Practice | "Rehearse: a scored exercise behind a safety check." |
| 3:20 | Support tab → Share | "Send everything to an expert as a link; they reply with a recommendation and a draft work order." |
| 3:45 | Value / About | "These benefits are proposals — here is how a pilot measures them, and here is what this prototype is not." |

## Recorded demo (organisers' format: about 2 minutes)
Organisers' format: Problem 0–15 s · Solution 15–35 s · Live demo 35–95 s · Business impact 95–120 s; the presenter
script with Robot POV, the arrival prompt, the in-scene X-Ray and Plan access is in [`DEMO_GUIDE.md`](DEMO_GUIDE.md).
The pre-recorded narration follows an earlier cut (Problem 0–13 s · Solution 14–37 s · Live demo 37–83 s · Business
impact 83–110 s) and does not mention the new camera or in-scene X-Ray. Narration lines, the AI voice-over,
English subtitles and per-line timing are in `docs/video/` (see [`DEMO_GUIDE.md`](DEMO_GUIDE.md)). A captioned,
narrated backup recording is rendered frame by frame by `web/tests/record-demo.cjs`; the main video should be
recorded on a laptop with a GPU following the same timeline.
