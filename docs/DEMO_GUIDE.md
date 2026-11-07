# Demo guide (one page)

**Live demo:** open the link and wait for the room to appear (a point preview shows first, full detail follows).
No 3D graphics on the machine? It opens the 2D floor plan by itself, and the journey below still works.

| # | Do this | Say this (plain words) | For the engineers in the room |
|---|---|---|---|
| 1 | Nothing yet: let the room load | "This is a real 3D scan of an equipment room, not a drawing." | 1.68 M Gaussian splats, integrity-checked, re-oriented so the floor is y = 0. |
| 2 | Rail → frames → *all* | "The software found 676 objects on its own and named them, each with a confidence." | RANSAC planes + recursive DBSCAN + gravity-aligned oriented boxes; names from a vision model on rendered crops; 4 human corrections, marked. |
| 3 | Press **/**, ask *Where is the faulty pump?* | "It knows which record belongs to which machine." | Class-aware mapping with a stated confidence; P-005 is the highest-priority asset in the workbook. |
| 4 | Ask *Send a technician to inspect the faulty pump*; camera → **Broadcast** | "A robot plans its own safe path and reads every machine it passes." | 2.5D heightfield, clearance-aware A* for a 0.2 m radius, smoothing, independent validation; proximity 1.2 m. |
| 5 | **Block aisle** | "Something is in the way: it finds a detour in milliseconds." | Oriented barrier added to the grid, re-plan from the current pose; dashed line = old route. |
| 6 | Speed **4×**, wait for arrival | "It says what is wrong, how sure it is, and what to do first." | Evidence engine (telemetry z-scores, alarms, work orders, cases) → LLM narration; uncited claims removed; confidence 52 % with its breakdown. |
| 7 | Click a grey citation tag | "Every claim links to its source." | Citations are checked against the evidence set before display. |
| 8 | **Open X-Ray view** | "Now we look inside the pump. Red parts are where the evidence points." | Procedural teaching model from the equipment library; illustrative, not OEM. |
| 9 | Bottom bar → **Motor**, **Valve** … | "It works for every type of equipment in the plant, not just this pump." | 5 device types, 49 components; adding a type is one JSON entry. |
| 10 | **Learn**, then **Practice** | "A new technician can learn and rehearse safely before touching anything." | Safety gate first; no connection to any control system. |
| 11 | **Draft work order** | "It drafts the paperwork; a person approves it." | Draft only, evidence IDs attached, no control actions. |
| 12 | **Value** | "What it could be worth, with every assumption on screen." | Hypothetical inputs, formula shown; a pilot would measure the five listed metrics. |

**Handy keys:** `/` ask · `Space` play / pause the robot · `F` hide all panels (focus) · `Esc` show them again.
**Rewind:** *Reverse* plays the run backwards; the route slider scrubs to any moment.
**If something goes wrong:** add `#plan` to the URL for the floor plan; it needs no GPU.

**What is real and what is not:** the room, the object frames, names and routes come from the supplied scan.
All asset data is synthetic. The X-Ray models are illustrative teaching models. No OEM manuals were supplied.
