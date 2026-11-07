// Guided tour: eight short steps through the whole journey. Each step says what you see in plain words,
// with one line for engineers underneath, and drives the app (camera, frames, robot, X-Ray) itself.
import { icon } from "./icons.js";
import { esc } from "./ui.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function steps(A) {
  const { S } = A, n = S.data.stats.n_objects, t = S.target.asset;
  return [
    { title: "This is a real room, scanned in 3D",
      plain: "What you see is not a drawing: it is a 3D scan of an equipment room, made of millions of tiny coloured blobs. Drag to look around, scroll to zoom.",
      eng: `${S.data.integrity.declared_vertex_count.toLocaleString()} Gaussian splats from the supplied PLY, integrity-checked and re-oriented to a Y-up frame with the floor at y = 0.`,
      run: () => { A.setMode("facility"); A.setFrames("none"); A.setCamera("chase"); A.flyHome(); } },
    { title: `The software found ${n} objects`,
      plain: "Every box is one thing the software separated from the scan by itself: pumps, pipes, valves, cabinets. Each one has a name and a confidence score.",
      eng: "Room-envelope RANSAC for walls and floor, recursive DBSCAN on the rest, gravity-aligned oriented boxes, names from a vision model on rendered crops, plus a human review layer.",
      run: () => A.setFrames("all") },
    { title: "Maintenance records are matched to the scan",
      plain: `The plant's asset list (synthetic data) is linked to the objects it describes. ${t.tag}, a ${t.asset_class.replaceAll("_", " ").toLowerCase()} with a simulated fault, is marked in red.`,
      eng: "Class-compatible assignment with a stated mapping confidence for every asset; nothing is matched without a compatible object.",
      run: () => { A.setFrames("assets"); A.selectAsset(t.asset_id, { fly: true }); } },
    { title: "A robot plans its own safe route",
      plain: "The inspection robot works out a path on the open floor that keeps clear of every machine, then drives it. The camera now watches from above, like a match broadcast.",
      eng: "2.5D multi-level heightfield, clearance-aware A* for a 0.2 m robot radius, line-of-sight smoothing, then a collision and clearance check of the final path.",
      run: async () => { A.setRate(1); A.setCamera("broadcast"); await A.dispatch(t.asset_id); } },
    { title: "It reads every machine it passes",
      plain: "The blue circle is the robot's 1.2 m reading range. Every machine that comes inside it is logged on the right, with its condition.",
      eng: "Proximity is computed against the oriented boxes along the arc length of the route, so scrubbing forward or back stays exact.",
      run: () => {} },
    { title: "Blocked? It finds another way",
      plain: "A barrier is dropped in the aisle ahead. The robot re-plans in milliseconds and takes a detour. The dashed line is the old route.",
      eng: "The barrier is added to the occupancy grid as an oriented footprint and A* re-plans from the robot's current position.",
      run: async () => { if (A.S.robot.done) { await A.dispatch(t.asset_id); await wait(2500); } await A.blockAisle(); A.setRate(2); } },
    { title: "On arrival, the copilot explains the fault",
      plain: "When the robot arrives, the AI says what is probably wrong, how sure it is, and what to do first. Every small grey tag is a source you can click.",
      eng: "Evidence engine (telemetry z-scores against peers and own baseline, alarms, work orders, similar cases) → LLM narration; citations are checked and unsupported ones removed.",
      run: async (alive) => { for (let i = 0; i < 80 && !A.S.robot.arrived && alive(); i++) await wait(500); if (alive() && A.S.mode === "facility") A.setCamera("free"); } },
    { title: "Look inside the machine",
      plain: "X-Ray opens a teaching model of the device. The parts the evidence points to are red. Pick another device type in the bar at the bottom to see inside it too.",
      eng: "Procedural, data-driven models from the equipment library (5 device types, 49 components), each linked to fault codes, signals and a training note. Illustrative, not OEM drawings.",
      run: async () => { await A.enterXRay(null, t.asset_id); } },
  ];
}

let el = null;
export async function startTour(A) {
  el?.remove();
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
  const end = () => { token++; el?.remove(); el = null; };
  show();
}
