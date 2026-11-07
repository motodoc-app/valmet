# Limitations and how a pilot would close them

Industrial X-Ray is a hackathon prototype. This page lists what each capability really is, so nothing in the demo or
the pitch is read as more than it is, and how a commercial pilot would validate or overcome each limit.

| Capability | What the prototype does | What it does **not** do | How a pilot closes the gap |
|---|---|---|---|
| Object recognition | Segments the scan into object **candidates** with oriented boxes; a vision model names them with a confidence; 7 labels were corrected in the team's visual review of renders (not field-verified). See [`SCENE_QUALITY.md`](SCENE_QUALITY.md) for the tiers (candidates → specific type → confident → review-corrected → linked) and an AI second-opinion audit of a sample. | It does not establish that every candidate is one real, correctly named object. Counts are not comparable with another team's count without the same evaluation. | Human-label a random sample; report precision and recall per category; tune segmentation on site data; add a review workflow. |
| Asset ↔ object links | Procedural, class-aware matching of the 30 workbook assets to compatible objects, each with a confidence. | Not confirmed on site; the workbook has no real coordinates for the scan. | Link assets through tags, QR/NFC codes or survey coordinates; measure the share of target assets located correctly. |
| Asset data | The challenge's **synthetic** 14-sheet workbook (telemetry, alarms, work orders, cases, documents). | No live plant data, no historian, no CMMS connection. | Read-only connectors (OPC UA, historian, CMMS/EAM) behind site security; see [`DATA_INTEGRATION.md`](DATA_INTEGRATION.md). |
| Diagnosis | Evidence engine + LLM narration; every citation is checked and unsupported ones removed; confidence shown with its breakdown. In the hosted demo the diagnoses were **generated in advance** by the same backend. | Hosted demo: no live AI reasoning for free questions (document search instead). Not a validated diagnostic model. | Run the API service; compare suggestions with technician outcomes; track agreement and false alarms. |
| Navigation | 2.5D heightfield, clearance-aware A*, smoothing, independent route validation, live re-routing. | The robot is virtual; the floor model comes from one scan and can be out of date. | Re-scan or update the map; test against a real robot or walked routes. |
| Maintenance planning | Moves a **virtual proxy** of an object; approximate collision and clearance checks against object boxes and the occupancy grid; re-plans the route. The scan is never changed. | Not an engineering clearance or installation check; boxes are approximations; service-zone size is an assumed example. | Use certified models (e.g. IFC from Scan-to-BIM) for key equipment; take service envelopes from OEM data; compare plans with what happened on site. |
| X-Ray teaching models | Procedural, data-driven models for 5 equipment types (49 components), linked to fault codes and signals. | Not manufacturer drawings; not reconstructed from the scan. | Licensed OEM models or site documentation; review content with experienced technicians. |
| Learn / Practice | Guided lessons and a scored exercise behind a safety check. | Not certified training; not a procedure to follow on real equipment. | Validate content with the training organisation; measure training performance. |
| Remote support | Asynchronous hand-off: pins, notes, plan and asset context travel in a link or package; the expert's reply comes back the same way. Any "example" reply is labelled as an example. | No live multi-user session, no video, no presence. | Add a real-time session service with authentication and audit logging. |
| Control | Read-only: highlights, notes, plans and draft work orders. | No connection to actuators, PLCs, valves or plant controls — by design. | Any write path would need permissions, interlocks, security review and industrial validation; out of scope. |
| Value | Calculator with editable, hypothetical inputs and the formula shown. | No measured savings. | Measure the pilot KPIs below. |
| Performance claims | Runs in a browser with no install; the hosted demo is a static site. | We have **not** measured it against Unity or any other tool. | Fair benchmark on the same scan and hardware: time to first view, interaction frame rate, time to share, cost per user. |

## Pilot KPIs (to be measured during a pilot — none are measured here)

1. Object-identification precision and recall on a human-labelled random sample.
2. Percentage of target assets located correctly in the scan.
3. Time to find a given piece of equipment (new technician, with vs without the tool).
4. Time to prepare a maintenance visit.
5. Planning collisions or access problems caught before the visit.
6. Technician training performance (exercise scores, errors on first real job).
7. Time to assemble a remote-support case and get an expert answer.
8. System start-up time and interaction frame rate on standard laptops.
9. Technician confidence and usability ratings (e.g. SUS questionnaire).
