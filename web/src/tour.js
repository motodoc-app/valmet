// Guided tour: a technician prepares to service pump P-005 before travelling to the site.
// Each step says what you see in plain words, with one line for engineers, and drives the app itself.
// Steps for optional modules (Plan, Support) appear only when those modules are present.
import { icon } from "./icons.js";
import { esc } from "./ui.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function steps(A) {
  const { S, X } = A, n = S.data.stats.n_objects, t = S.target.asset;
  const list = [
    { title: "Arriving virtually",
      plain: `You have to service pump ${t.tag} at a site you have never visited. This is a real 3D scan of the equipment room. Drag to look around, scroll to zoom.`,
      eng: `${S.data.integrity.declared_vertex_count.toLocaleString()} Gaussian splats from the supplied PLY, integrity-checked and re-oriented so the floor is y = 0.`,
      run: () => { A.setMode("facility"); A.pause(); A.setFrames("none"); A.setCamera("chase"); A.flyHome(); } },
    { title: "What the software found",
      plain: `The scan was split into ${n} object candidates, each with a box, a name and a confidence. Not every candidate is a verified object: the Scene understanding panel on the right rail shows how many are categorised, confident, human-checked and linked to records.`,
      eng: "Room-envelope RANSAC planes, recursive DBSCAN, gravity-aligned oriented boxes, vision-model labels from rendered crops, a review layer of corrections (team visual check, not field-verified).",
      run: () => A.setFrames("all") },
    { title: `Find ${t.tag}`,
      plain: `Ask the copilot where the pump is. It finds the workbook record and the scene object it is linked to, and flies you there.`,
      eng: "Rule-based intent router over the asset register and scene labels; the asset-to-object link is procedural, with a stated confidence.",
      run: async () => { A.setMode("facility"); A.pause(); A.setFrames("assets"); await A.ask(`Where is ${t.tag}?`); } },
    { title: "Understand the problem",
      plain: "The copilot explains what is probably wrong, how sure it is, and what to check first. Every grey tag is a source you can open. The asset data is synthetic.",
      eng: "Evidence engine (telemetry z-scores against own baseline and peers, alarms, work orders, similar cases) → LLM narration; citations are checked and unsupported ones removed.",
      run: async () => { await A.diagnose(t.asset_id); } },
  ];
  if (X.modes.has("plan")) list.push(
    { title: "Plan access to the pump",
      plain: "A pallet truck is parked in the pump's service area. In Plan mode you move a virtual stand-in for it and immediately see collisions, clearance and how the route changes. The scan itself is never changed.",
      eng: "Planning proxy = oriented footprint; collision against object boxes and the occupancy grid, clearance from the distance transform; the route is re-planned with the proxy as an obstacle and the original footprint cleared.",
      run: async () => { await X.planning?.demo?.(); } });
  list.push(
    { title: "Check the way in",
      plain: "The inspection robot drives the route to the pump and reads every asset it passes. The camera watches from above, like a match broadcast.",
      eng: "2.5D multi-level heightfield, clearance-aware A* for a 0.2 m robot radius, line-of-sight smoothing, independent validation of the final path.",
      run: async () => { A.setMode("facility"); A.setRate(2); A.setCamera("broadcast"); await A.dispatch(t.asset_id); } },
    { title: "Rehearse the job",
      plain: "X-Ray opens a teaching model of the pump. The parts the evidence points to are red. Learn and Practice then walk through the fault and a scored exercise, with a safety check first.",
      eng: "Procedural, data-driven models from the equipment library (5 device types, 49 components). Illustrative, not manufacturer drawings.",
      run: async (alive) => { for (let i = 0; i < 40 && !S.robot.arrived && alive(); i++) await wait(500); if (alive()) await A.enterXRay(null, t.asset_id); } });
  if (X.modes.has("support")) list.push(
    { title: "Ask a remote specialist",
      plain: "Pin notes on the scene and send the whole context — asset, evidence, plan and pins — to an expert as a link or package. The expert adds a recommendation and a draft work order. This example is labelled as an example.",
      eng: "Asynchronous hand-off: state is serialised into the link or a package file; no live multi-user server and no connection to plant controls.",
      run: async () => { await X.support?.demo?.(); } });
  list.push(
    { title: "Why it matters",
      plain: "Technicians arrive knowing where the equipment is, what is probably wrong, how to get to it and what to do. These are proposed benefits; a pilot would measure them. The Value page shows the arithmetic with editable assumptions.",
      eng: "Pilot KPIs: object-identification precision/recall on a labelled sample, assets located correctly, time to find equipment, time to prepare a visit, planning collisions caught, training scores.",
      run: () => A.setMode("value") });
  return list;
}

let el = null;
export async function startTour(A) {
  el?.remove();
  document.querySelector(".toast")?.remove();
  document.body.classList.add("touring");
  const list = steps(A);
  el = document.createElement("div");
  el.className = "tour"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Guided tour");
  document.getElementById("app").appendChild(el);
  let i = 0, token = 0;
  const show = async () => {
    const s = list[i];
    el.innerHTML = `<div class="h"><span>Guided tour · ${i + 1} of ${list.length}</span><button class="link" data-tour-x aria-label="Close tour">${icon("close")}</button></div>
      <div class="t">${esc(s.title)}</div><p class="p">${esc(s.plain)}</p><p class="eng"><b>For engineers:</b> ${esc(s.eng)}</p>
      <div class="nav"><button class="btn" data-tour-b ${i ? "" : "disabled"}>Back</button><button class="btn primary" data-tour-n>${i === list.length - 1 ? "Finish" : "Next"}</button></div>`;
    const me = ++token;
    try { await s.run(() => me === token && !!el); } catch (e) { console.warn("tour step", e); }
  };
  el.onclick = async (e) => {
    if (e.target.closest("[data-tour-x]")) return end();
    if (e.target.closest("[data-tour-b]") && i > 0) { i--; return show(); }
    if (e.target.closest("[data-tour-n]")) { if (i === list.length - 1) return end(); i++; return show(); }
  };
  const end = () => { token++; el?.remove(); el = null; document.body.classList.remove("touring"); };
  show();
}
