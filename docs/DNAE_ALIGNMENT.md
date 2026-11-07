# Industrial X-Ray and Valmet DNAe: how the two could fit together later

Status: design note, written on 2026-11-07. **Nothing in this document is built.**

## 0. What is true today

* **The prototype does not connect to Valmet DNAe** or to any other control system, historian or CMMS. There is no
  network path, no account and no code for one.
* All asset data comes from the **synthetic** Valmet × Since AI builder pack (`data/raw/builder_pack.xlsx`). Every
  sheet carries `synthetic_record`; every asset has `data_classification = SYNTHETIC`. The workbook's
  `connectivity_profile` column (OPC_UA, MQTT_EDGE, ...) is a synthetic label, not a connection.
* The prototype has **no write or control path**. The copilot refuses requests such as "open valve CV-003" or
  "shut down M-006" (`control_request` in `backend/xray/api.py`, `controlRequest` in `web/src/faq-match.js`), the
  work-order endpoint returns a draft that a planner must approve (`"control_actions": "none (draft only)"`), and the
  robot in the 3D view is a simulation.
* What follows is a proposal for a later pilot. Every DNAe statement below is quoted from Valmet's public pages
  (section 1). Anything those pages do not say is marked as an open question for Valmet, not assumed.

## 1. What Valmet's public pages say about Valmet DNAe

Sources, read on 2026-11-07:
[DNAe overview](https://www.valmet.com/automation/control-systems/dnae) and
[DNAe architecture](https://www.valmet.com/automation/control-systems/dnae/architecture/).

| Topic | Quoted from the pages |
|---|---|
| What it is | "Valmet DNAe is a web-based distributed control system designed to evolve with your needs for optimal production." (overview) |
| OT/IT data | "The architecture of Valmet DNAe DCS seamlessly connects the operational technology (OT) and information technology (IT) domains, leveraging the latest technologies for secure data exchange and integration. Its effective data management capabilities give operators real-time insights into plant operations and asset performance management, enabling informed decision-making." (overview) |
| Interfaces to other systems | "At the core of Valmet DNAe Distributed Control System is the Trusted Information Framework (TIF). It is the backbone for communication and data modeling across all automation system functionalities such as user interface management, real-time and advanced process controls, system and application configuration, and process data collection for analytics. The TIF framework streamlines vertical OT/IT and cloud connectivity and horizontal communication interfaces for external systems." (architecture) |
| Security | "Valmet DNAe is the world’s first fully web-based DCS with ISASecure System Security Assurance (SSA) cybersecurity compliance. The system follows ISA/IEC 62443-3-3 (SSA) and its development ISA/IEC 62443-4-1 (SDLA) standards." and "... role-based access control, authentication, audit trails, encryption mechanisms, content-signed software, secure communication, and comprehensive logging." (overview) |
| Reference model | "These standardized architectures adhere to the ISA-95 reference architecture model." (architecture) |
| Users and maintenance | "The system provides a common user interface for controls, analytics, configuration, and maintenance." (overview) |

What the two pages do **not** say: they name no data-exchange protocol (OPC UA is not mentioned), no historian product,
no API for external read access and no CMMS integration. Both pages link to separate "Connectivity" and
"Cybersecurity" pages, which this note did not review. So the interface choices in section 3 are **candidates to
confirm with Valmet**, not described DNAe features.

## 2. Where Industrial X-Ray could complement DNAe

DNAe is the control system: operators run the process from it. Industrial X-Ray is a pre-visit and field tool for
technicians, planners and remote experts: a 3D scan of the room, equipment located in it, a diagnosis with sources,
a draft work order and a planned route, opened in a browser before anyone walks in. The two meet at **read-only data**:

| X-Ray needs (today from the workbook) | Workbook sheet it replaces | Likely owner at a site |
|---|---|---|
| Equipment status and condition | `Current_State` | DCS (DNAe) or a condition-monitoring system |
| Process measurements for trends and baselines (the copilot compares the last 12 h with the first 24 h and with peers) | `Telemetry_Sample_3d` | DCS process data collection or a historian |
| Alarms and events | `Alarms_Events` | DCS |
| Maintenance records and work orders | `Maintenance_History`, `Historical_Service_Cases` | CMMS / EAM |
| Asset information (tag, class, area, criticality, service interval) | `Asset_Master` | CMMS / EAM asset register, DCS tag database |
| Manuals and procedures | `Knowledge_Docs`, `RAG_Corpus_Index` | Document management |

Nothing flows the other way. Industrial X-Ray does not send setpoints, commands, acknowledgements or work orders
into DNAe or a CMMS; a planner copies an approved draft into the CMMS by hand.

## 3. Possible read-only connection paths (to confirm with Valmet)

The generic design is in [DATA_INTEGRATION.md](DATA_INTEGRATION.md) (adapters, provenance labels, staleness, security).
For a DNAe site the candidates are, in order of least intrusion:

1. **An offline historian extract first.** A one-off export of recorded data (CSV or similar) for site-approved tags
   and alarms, loaded instead of the workbook and labelled `replay`. No connection to the control system at all. This
   is the recommended first pilot step.
2. **DNAe's own integration interfaces.** The architecture page says TIF provides "horizontal communication interfaces
   for external systems". Which interface, which data and which access model a read-only external client may use is
   an open question for Valmet (section 6).
3. **A standard industrial interface, if the site offers one.** For example an OPC UA server or a historian read API
   exposed through the site's DMZ, used only with subscriptions and reads, never Write or Call
   ([DATA_INTEGRATION.md](DATA_INTEGRATION.md) §3). Whether DNAe exposes such an interface is not stated on the pages
   above and is not assumed here.
4. **The CMMS / EAM read API** for asset information and maintenance records, which usually live outside the DCS.

In every path the adapter maps external identifiers to our asset IDs through a reviewed table, attaches provenance
(`synthetic`, `replay` or `live`, observed and received time, quality) and turns stale or bad-quality values into
data-quality issues, which already lower the diagnosis confidence (`dq_pen` in `Copilot.evidence`). The copilot,
the API and the front end keep the same evidence schema.

### The read-only boundary (applies to every path)

| Rule | What it means |
|---|---|
| Allowlists approved by the site owner | Only tags, alarms and records on a list the site owner approved are read; anything else is not requested |
| Start offline | First an offline historian extract; a live feed only after that pilot step is reviewed |
| Read-only adapter in an industrial DMZ | One adapter, placed in the site's DMZ, reads and forwards; it has no write or method-call rights (for OPC UA: no Write, no Call) and the source enforces this |
| The technician's browser never connects to the DCS | Browsers talk only to the Industrial X-Ray backend, which never sits in the control network |
| People verify tag-to-asset bindings | Every mapping from a source tag to an asset and to a scene object is reviewed by a person before use; field confirmation by tag, QR or NFC |
| Role-based access and audit | Site sign-in with roles (viewer, technician, planner); every read, mapping change and draft is logged |
| No automated control path | No component, rule or language-model output can send a command, setpoint or acknowledgement to any plant system |

## 4. Out of scope, by design

* **No writes and no control**: no setpoints, no start/stop/open/close, no alarm acknowledgement or reset, no
  configuration changes, no mode changes, no interaction with Advanced Process Controls.
* No placement of Industrial X-Ray software inside the control network or on DNAe servers.
* No automatic creation of work orders in a CMMS: drafts only, approved by a planner.
* No safety decisions: the copilot says it cannot judge whether equipment is safe to run; that belongs to site
  procedures, permits, lockout/tagout and qualified personnel (`DOC-FIELD-SAFETY`).
* No claim of DNAe compatibility, certification or endorsement.

## 5. Security and approval

* **Site and Valmet approval first.** Any connection needs written approval from the site's OT security owner and,
  where it touches DNAe, from Valmet. The site's own policy decides, not this document.
* **Fit the site's zone model.** Valmet states that DNAe follows ISA/IEC 62443-3-3 and 62443-4-1 (section 1). An external read-only client
  belongs in a separate zone, reached through an approved conduit (typically an industrial DMZ), with connections going
  out of the DMZ rather than into the control network. ISA/IEC 62443 is a reference for this design; we claim no
  compliance ourselves.
* **Least privilege**: one read-only service account per source, limited to the mapped tags and assets; credentials in
  a secret store and rotated; the source system enforces read-only, not only our code.
* **User access** through the site's identity provider, with roles (viewer, technician, planner) checked on every API
  call; append-only audit log of who viewed what and of every adapter fetch.
* **AI use**: only the evidence package for one asset is sent to the language model, and only if the site allows it;
  otherwise the template wording runs. The model's text cannot trigger any action, and every citation is checked
  against the evidence.
* **Data handling**: plant data and the 3D scan of a plant are sensitive; they stay in the region and tenancy the site
  approves.

## 6. Open questions for Valmet

1. Which DNAe interface (if any) is intended for read-only access by an external application, and what does it expose:
   equipment status, process measurements, alarms and events, asset information?
2. Is a read-only client allowed at all on a production DNAe system, and what approval and zoning does Valmet require?
3. Where do maintenance records and the asset register live at a typical DNAe site (which CMMS / EAM)?
4. Can a pilot start with exported, replayed data from a DNAe site before any live connection?
5. Do DNAe tag names map one-to-one to asset tags (such as `P-005`), or is a separate mapping table needed?
