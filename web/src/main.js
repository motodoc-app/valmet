// Industrial X-Ray — app controller.
// Journey: facility → ask / dispatch → route + proximity → arrival diagnosis → X-Ray → Learn / Practice.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { api, connect, scanManifest, SCAN_FALLBACK } from "./api.js";
import { Facility, decodeXq16 } from "./facility.js";
import { XRay } from "./xray.js";
import { initTraining } from "./training.js";
import { icon } from "./icons.js";

import { $, $$, esc, nice, cites, pad, kv, sparkline, signalName, toast, header, diagnosisHTML, LITE } from "./ui.js";
import { startTour } from "./tour.js";
import { createCopilot } from "./copilot-ui.js";   // [copilot-ui]
import { APP, emit, withExtras } from "./ext.js";
// feature modules register their modes, rail buttons and hooks on import (see ext.js)
import "./planning.js";
import "./support.js";
import "./layers.js";
import "./quality.js";
import "./xray-overlay.js";   // in-scene X-Ray panel + arrival prompt (APP.xo, APP.arrival)

// ------------------------------------------------------------------ skeleton
function modeTabs() {
  const list = [["facility", "Explore"], ["xray", "X-Ray"], ["learn", "Learn"], ["practice", "Practice"], ["value", "Value"]];
  for (const d of APP.modes.values()) { const i = list.findIndex(([id]) => id === d.after); list.splice(i < 0 ? list.length - 1 : i + 1, 0, [d.id, d.label]); }
  return list.map(([id, l]) => `<button data-mode="${id}" class="${id === "facility" ? "on" : ""}">${l}</button>`).join("");
}
/** Modes that show the facility scene (Explore and registered scene modes such as Plan and Support). */
const sceneMode = (m = S.mode) => m === "facility" || APP.modes.get(m)?.scene === "facility";
$("#app").innerHTML = `
<canvas class="gl"></canvas>
<div class="vignette"></div>
<div class="labels"></div>
<div class="fade"></div>
<div class="wordmark"><div class="eyebrow">Industrial X-Ray</div><div class="name" id="siteName">Equipment Room</div></div>
<nav class="modes" aria-label="Mode">${modeTabs()}</nav>
<div class="topright">
  <div class="ask">
    <label class="field">${icon("search")}<input id="ask" placeholder="Ask about the plant" autocomplete="off" aria-label="Ask the copilot"/><span class="kbd">/</span></label>
    <div class="pop hidden" id="pop"></div>
  </div>
  <button class="iconbtn" id="tourBtn" title="Guided tour (1 minute)" aria-label="Guided tour">${icon("tour")}<span class="lbl">Tour</span></button>
  <button class="iconbtn" id="libBtn" title="Library" aria-label="Library">${icon("book")}</button>
</div>
<aside class="card left" id="left"></aside>
<aside class="card right" id="right"></aside>
<section class="card value hidden" id="value" aria-label="Value calculator"></section>
<div class="card sheet hidden" id="sheet"></div>
<div class="dock" id="dock"></div>
<div class="rail" id="rail">
  <button data-rail="in" title="Zoom in">${icon("plus")}</button><button data-rail="out" title="Zoom out">${icon("minus")}</button>
  <button data-rail="reset" title="Reset view">${icon("reset")}</button><hr>
  ${APP.rail.map((b) => `<button data-rail="x:${b.id}" class="${b.sceneOnly ? "fac-only" : ""}" title="${b.title}">${icon(b.icon)}</button>`).join("")}
  <button data-rail="frames" class="fac-only" title="3D frames">${icon("frames")}</button><button data-rail="grid" class="fac-only" title="Floor map: where the robot can drive">${icon("grid")}</button><button data-rail="minimap" class="fac-only" title="Mini-map">${icon("map")}</button><hr class="fac-only">
  <button data-rail="focus" title="Focus: hide panels (F)">${icon("focus")}</button><button data-rail="full" title="Full screen">${icon("full")}</button><button data-rail="help" title="About this demo">${icon("help")}</button>
</div>
<div class="scan-status hidden" id="scanStatus" role="status"></div>
<div class="pov-hud hidden" id="povHud" role="status" aria-live="off"></div>
<div class="minimap" id="minimap" aria-label="Mini-map"><div class="mm-h"><span>Room overview</span><span class="note">click to look</span></div><canvas></canvas></div>
<button class="btn focus-exit" id="focusExit">${icon("close")}Show panels</button>
<div class="loading" id="loading"><div class="box">Starting<div class="bar"><i></i></div></div></div>`;

const S0 = { sparkOk: false };
const NEAR = () => S.data?.proximity_m ?? 1.2;      // proximity radius (m), from config/project.json
// ------------------------------------------------------------------ renderer, scenes, cameras
const canvas = $("canvas.gl");
// Splats are already soft-edged: MSAA buys nothing but costs fill-rate. Cap the pixel ratio for steady frame times.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(LITE ? 1 : Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
// If the GPU drops the context (driver reset, too many tabs) and it does not come back, switch to the floor plan.
let lostTimer = null;
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  toast("The graphics driver stopped responding. Recovering…", 3000);
  lostTimer = setTimeout(() => { location.hash = "plan=lost"; location.reload(); }, 2500);
});
canvas.addEventListener("webglcontextrestored", () => { clearTimeout(lostTimer); toast("3D view restored."); });
const labels = new CSS2DRenderer({ element: $(".labels") });
labels.setSize(innerWidth, innerHeight);

const fac = new THREE.Scene();
fac.background = new THREE.Color(0x0a0b0d);
fac.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(2, 4, 1); fac.add(sun);
// If the splat engine cannot start (blocked WASM or workers), the scan falls back to a point cloud.
try { fac.add(new SparkRenderer({ renderer })); S0.sparkOk = true; } catch (e) { console.warn("SparkRenderer unavailable", e); S0.sparkOk = false; }
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.03, 80);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
const xCam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.02, 60);
const xControls = new OrbitControls(xCam, canvas);
xControls.enableDamping = true;
xControls.enabled = false;
xControls.minDistance = 1.2; xControls.maxDistance = 9;
xControls.maxPolarAngle = Math.PI * 0.48;
// X-Ray camera home is computed per device by XRay.load() (auto-fit to the exploded model)
const xHome = () => S.xray.home || { pos: new THREE.Vector3(2.4, 2.1, 4.4), tgt: new THREE.Vector3(0, 0.5, 0) };

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
  for (const c of [camera, xCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
});

// ------------------------------------------------------------------ state
export const S = {
  sparkOk: S0.sparkOk,
  mode: "facility", data: null, fac: null, xray: null, kb: null, home: null,
  selected: null, target: null, diag: null, curve: null, route: null, prevRoute: null,
  robot: { moving: false, s: 0, len: 0, v: 0, dir: 1, rate: 1, done: true, arrived: false, follow: 0 }, blocks: [], seen: new Map(),
  firstSeen: null, seenBefore: new Set(),
  cam: "chase", minimap: !LITE, frames: "none", grid: false, tab: "overview", xSelected: null, xTab: "overview",
};

// ------------------------------------------------------------------ boot
async function boot() {
  await connect();
  const [data, kb, manifest] = await Promise.all([api.scene(), api.xrayModel(), scanManifest()]);
  S.data = data; S.kb = kb;
  S.fac = new Facility(fac, data);
  S.xray = new XRay(kb, renderer);
  S.target = data.objects.find((o) => o.id === data.target_object_id);
  S.objById = new Map(data.objects.map((o) => [o.id, o]));
  S.home = homeView();
  if (data.site?.name) { $("#siteName").textContent = data.site.name; document.title = `Industrial X-Ray · ${data.site.name}`; }
  S.fac.setShowMode(S.frames);
  if (!S.minimap) $("#minimap").classList.add("hidden");
  camera.position.copy(S.home.pos); controls.target.copy(S.home.tgt);
  startIntro();                      // [render: Agent V] establishing shot (see introView)
  initTraining(S, { $, esc, cites, setMode, card: (h) => ($("#right").innerHTML = h), xCam, xControls, toast, icon, focusPart });
  Object.assign(APP, { S, THREE, scene: fac, camera, controls, xCam, xControls, renderer, canvas, labelsRoot: $(".labels"), api, flyTo, card, sheet,
    setMode, sceneMode, selectObject, selectAsset, restart, dispatch, blockAisle, replan, renderDock, renderLeft, renderRail,
    renderOverviewCard, renderDiagnosis, renderAssetCard, resetAll, setCamera, showWorkOrder, enterXRay, ask, toast, viewOffset,
    prepareXRay, selectComponent, cancelTween: () => { tween = null; }, xHome });
  emit("boot", APP);
  renderLeft(); renderOverviewCard(); renderDock();
  initMinimap().catch((e) => console.warn("mini-map", e));
  // The interface is usable now; the scan streams in behind it and never blocks the page.
  $("#loading").style.opacity = 0;
  setTimeout(() => $("#loading")?.remove(), 700);
  if (!/[?&]qa\b/.test(location.search)) setTimeout(() => toast(`New here? <button class="link" data-tour style="color:var(--text)">Take the 1-minute tour ${icon("chev")}</button>`, 9000), 1500);
  const pill = $("#scanStatus");
  const mb = (x) => (x / 1e6).toFixed(1);
  // ?scan=off skips the scan (automated tests on software-rendered GPUs, very weak devices)
  if (new URLSearchParams(location.search).get("scan") === "off") return;
  S.fac.loadScan(manifest, ({ received, total, phase }) => {
    pill.classList.remove("hidden");
    pill.textContent = phase === "done" ? "" : total ? `Loading scan · ${mb(received)} of ${mb(total)} MB` : "Loading scan…";
    if (phase === "done") pill.classList.add("hidden");
    if (phase !== "download" && S.intro?.stage === "hold") setTimeout(playIntro, 900);   // [render: Agent V] first chunk is up
  }, { splats: S.sparkOk, fallback: SCAN_FALLBACK, lite: LITE }).then(() => {
    if (S.fac.splatMode === "points") toast("Showing the scan as a point cloud: this browser could not start the splat renderer.", 6000);
  }).catch((e) => { pill.textContent = "The scan could not be loaded. Everything else still works."; console.warn(e); });
}

function homeView() {
  // [render: Agent V] Eye height (1.65 m) at the short wall nearest the robot, 1 m off the centre line towards it,
  // looking down the long axis of the room. The old corner view at 1.85 m sat 20 cm under the ceiling ducts and behind
  // the big insulated pipe column, whose blurry splats filled half of the first picture.
  const b = S.data.bounds, s = S.data.start;
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2], lo = [b.min[0], b.min[2]], hi = [b.max[0], b.max[2]], st = [s[0], s[2]];
  const L = hi[1] - lo[1] >= hi[0] - lo[0] ? 1 : 0, W = 1 - L;          // long axis (0 = x, 1 = z) and the short one
  const p = [0, 0], t = [0, 0];
  p[L] = st[L] < c[L] ? lo[L] + 0.65 : hi[L] - 0.65;
  p[W] = c[W] + Math.max(-1, Math.min(1, st[W] - c[W]));
  t[L] = c[L] + (c[L] - p[L]) * 0.33;
  t[W] = c[W] - (p[W] - c[W]) * 0.45;
  return { pos: new THREE.Vector3(p[0], 1.65, p[1]), tgt: new THREE.Vector3(t[0], 0.5, t[1]) };
}

// [render: Agent V] ---- boot camera intro: an establishing shot of the whole room from above (cut-away: no ceiling,
// haze or wall skins, see look.js), then one smooth 2.6 s dolly down to the eye-level home view once the first scan
// chunk is on screen. Skipped for ?capture / ?qa / ?scan=off / ?intro=0 and deep links (#...); any drag, camera
// button or mode change during the shot ends it where it is.
function introView() {
  const b = S.data.bounds, h = S.home.pos, cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const d = new THREE.Vector3(h.x - cx, 0, h.z - cz).normalize();
  return { pos: new THREE.Vector3(cx + d.x * 5.2, 6.4, cz + d.z * 5.2), tgt: new THREE.Vector3(cx - d.x * 0.6, 0, cz - d.z * 0.6) };
}
function startIntro() {
  if (/[?&](capture|qa|intro=0|scan=off)\b/.test(location.search) || location.hash) return;
  const v = introView();
  camera.position.copy(v.pos); controls.target.copy(v.tgt);
  S.fac.setCutaway(true);            // look.js keeps it while the camera is above the ceiling and lifts it on the way down
  S.intro = { stage: "hold" };
  const stop = () => { if (S.intro) { if (S.intro.stage === "fly") tween = null; S.intro = null; } };
  controls.addEventListener("start", stop, { once: true });
  setTimeout(playIntro, 9000);       // scan slow or unavailable: fly home anyway
}
function playIntro() {
  if (S.intro?.stage !== "hold") return;
  if (S.cam !== "chase" || S.mode !== "facility" || tween) { S.intro = null; return; }
  S.intro.stage = "fly";
  flyTo(S.home.pos, S.home.tgt, 2.6);
  setTimeout(() => { if (S.intro?.stage === "fly") S.intro = null; }, 2800);
}

// ------------------------------------------------------------------ left card: assets (facility) / components (x-ray)
function renderLeft() {
  if (["xray", "learn", "practice"].includes(S.mode)) return renderComponents();
  const assets = S.data.objects.filter((o) => o.asset).map((o) => o.asset);
  const rank = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
  assets.sort((a, b) => (b.is_target - a.is_target) || rank[a.condition_state] - rank[b.condition_state] || a.health_score - b.health_score);
  const nav = S.data.navigation;
  $("#left").classList.remove("tall");
  $("#left").innerHTML = `
    <div class="card-h"><span class="t">Assets by priority</span><span class="card-tools"><span class="note">${assets.length}</span><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b" style="padding:0 8px 8px">${assets.map((a, i) => `
      <button class="list-row ${S.selected?.asset?.asset_id === a.asset_id ? "on" : ""}" data-asset="${a.asset_id}">
        <span class="n">${pad(i + 1)}</span>
        <span class="nm"><b>${a.tag}</b><small>${nice(a.asset_class)} · ${a.is_target ? "Simulated fault" : nice(a.issue_code)}</small></span>
        <span class="health s-${a.condition_state}">${a.health_score}</span></button>`).join("")}</div>
    <div class="card-f"><span><b>${S.data.stats.n_objects}</b> object candidates</span><span><b>${nav.walkable_area_m2}</b> m² drivable</span><span><b>${(S.data.integrity.declared_vertex_count / 1e6).toFixed(1)}M</b> splats</span></div>`;
  $("#left").onclick = (e) => {
    if (e.target.closest("[data-min-card]")) return;
    const r = e.target.closest("[data-asset]"); if (!r) return;
    if (APP.xo?.open) return APP.xo.show(r.dataset.asset);      // X-Ray panel open: look inside that asset instead
    selectAsset(r.dataset.asset, { fly: true });
  };
}

function renderComponents() {
  $("#left").classList.add("tall");
  const lead = new Set(S.xDiag?.hypotheses?.[0]?.components || []);
  const alt = new Set((S.xDiag?.hypotheses || []).slice(1).flatMap((h) => h.components));
  $("#left").innerHTML = `
    <div class="card-h"><span class="t">Components · ${esc(xDef().label)}</span><span class="card-tools"><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button><button class="link" data-close-x title="Back to facility">${icon("close")}</button></span></div>
    <div style="padding:0 16px 10px"><select class="search" id="xDevice" aria-label="Device">${deviceOptions()}</select></div>
    <div class="card-b" style="padding:0 8px 8px">${S.xray.order().filter((id) => xComp(id)).map((id, i) => {
      const c = xComp(id);
      return `<button class="list-row ${S.xSelected === id ? "on" : ""}" data-comp="${id}"><span class="n">${pad(i + 1)}</span>
        <span class="nm"><b>${esc(c.name)}</b></span>${lead.has(id) ? '<span class="pill red">Suspected</span>' : alt.has(id) ? '<span class="pill amber">Alternative</span>' : S.xSelected === id ? icon("chev") : ""}</button>`;
    }).join("")}</div>`;
  $("#left").onclick = (e) => {
    if (e.target.closest("[data-min-card]")) return;
    if (e.target.closest("[data-close-x]")) return setMode("facility");
    const r = e.target.closest("[data-comp]"); if (r) selectComponent(r.dataset.comp);
  };
  $("#xDevice").onchange = (e) => switchDevice(e.target.value);
}

// ------------------------------------------------------------------ right card
function card(html) { $("#right").innerHTML = html; $("#right").scrollTop = 0; }

function renderOverviewCard() {
  const t = S.target.asset, has = (m) => APP.modes.has(m);
  const step = (n, title, text, act, label) => `<div class="journey-step"><span class="k">${n}</span><div><b>${title}</b><small>${text}</small></div>${act ? `<button class="btn" ${act}>${label}</button>` : ""}</div>`;
  card(`${header("Pre-visit briefing", `Service ${t.tag}`, '<span class="tag syn">Synthetic data</span>')}
    <div class="sub">${nice(t.asset_class)} · ${esc(t.area_name)} · <span class="status s-${t.condition_state}">${nice(t.condition_state)}</span> · health ${t.health_score}</div>
    <div class="actions-top"><button class="btn primary" data-act="locate">${icon("target")}Show me ${t.tag}</button><button class="btn" data-act="dispatch">${icon("play")}Send robot</button></div>
    <p class="p" style="margin-top:12px">${esc(t.issue_summary)}. Prepare the visit before you travel — follow the steps:</p>
    <div class="journey">
      ${step(1, "Explore", "Find the pump and its surroundings in the real scan.", 'data-act="locate"', "Show")}
      ${step(2, "Understand", "Read the cited diagnosis; see the suspect parts.", 'data-act="diagnose-target"', "Open")}
      ${has("plan") ? step(3, "Plan", "Clear the service area in a safe layout simulation.", 'data-goto="plan"', "Plan") : ""}
      ${step(has("plan") ? 4 : 3, "Practice", "Rehearse the inspection on the teaching model.", 'data-goto="practice"', "Practise")}
      ${has("support") ? step(has("plan") ? 5 : 4, "Support", "Hand the context to a remote specialist.", 'data-goto="support"', "Share") : ""}
    </div>
    <p class="note" style="margin-top:12px"><button class="link" data-act="reset-all">${icon("reset")}Reset the whole demo</button></p>
    <div class="section">${kv("Criticality", esc(t.criticality))}${kv("Linked scene object", `${esc(S.target.label)} · ${Math.round(t.mapping_confidence * 100)}% (procedural link)`)}</div>
    <div class="section"><div class="label">See inside any device</div>
      <div class="row">${Object.entries(S.kb.classes).map(([cls, c]) => `<button class="chip" data-xclass="${cls}">${esc(SHORT[cls] || c.label)}</button>`).join("")}</div>
      <p class="note" style="margin-top:8px">Illustrative teaching models, not parts reconstructed from the scan.</p></div>
  </div>`);
}

const planActive = () => { const x = withExtras({}); return (x.blocks?.length || 0) + (x.clears?.length || 0) > 0; };
function renderTransitCard() {
  if (APP.modes.get(S.mode)?.ownsCard) return;          // Plan / Support keep their own card while the robot drives
  const assets = [...S.seen.keys()].map((id) => S.data.objects.find((o) => o.id === id)).filter((o) => o?.asset);
  const others = S.seen.size - assets.length;
  card(`${header("En route", S.navObject.asset.tag, "")}
    <div class="sub">${S.route.length_m} m · ${S.route.validation.collision_free ? "collision-free" : "check route"} · min clearance ${S.route.validation.min_clearance_m} m</div>
    ${planActive() ? `<p class="plan-note">${icon("layers")}<span>Uses your <b>proposed layout</b> from Plan mode. <button class="link" data-goto="plan">Open Plan to change or reset it</button></span></p>` : ""}
    <div class="section"><div class="label"><span>Assets read along the way</span><span>${assets.length}</span></div>
      <div class="feed">${assets.map((o) => `<button class="list-row" data-obj="${o.id}"><span class="dot s-${o.asset.condition_state}"></span>
        <span class="nm"><b style="font-family:var(--mono)">${o.asset.tag}</b><small>${nice(o.asset.condition_state)} · ${nice(o.asset.issue_code)}</small></span><span class="health s-${o.asset.condition_state}">${o.asset.health_score}</span></button>`).join("") || '<div class="note">Nothing in range yet.</div>'}</div></div>
    <div class="section note"><span id="otherCount">${S.seen.size}</span> objects framed within ${NEAR()} m so far.</div>
    ${S.diag ? `<div class="section"><button class="btn block" data-act="result">${icon("spark")}Show the diagnosis</button></div>` : ""}</div>`);
}

function renderAssetCard(o) {
  const a = o.asset;
  if (!a) {
    return card(`${header(nice(o.category), esc(o.label), "", true)}
      <div class="sub">Scene object · not linked to a workbook asset</div>
      <div class="section">${identityRows(o)}</div></div>`);
  }
  card(`${header(nice(a.asset_class), a.tag, '<span class="tag syn">Synthetic</span>', true)}
    <div class="sub"><span class="status s-${a.condition_state}">${nice(a.condition_state)}</span> · ${esc(a.issue_summary)}</div>
    ${assetActions(o)}
    <div class="section">${kv("Health", a.health_score)}${kv("Criticality", esc(a.criticality))}${kv("Area", esc(a.area_name))}</div>
    ${equipmentInfo(a)}
    <div class="section"><div class="label">3D identity</div>${identityRows(o)}</div></div>`);
}

/** One connected twin: the same four actions on every asset card (scene click, list, search, copilot, arrival).
 *  The primary action follows the journey: send the robot first; once it stands at this asset, look inside. */
function assetActions(o) {
  const a = o.asset, model = !!S.kb.classes[a.asset_class], here = robotAt(o);
  return `<div class="actions-top">
      <button class="btn ${here && model ? "" : "primary"}" data-act="dispatch-sel" ${here ? "disabled title=\"The robot is standing at this asset\"" : ""}>${icon(here ? "check" : "play")}${here ? "Robot is here" : "Send robot here"}</button>
      ${model ? `<button class="btn ${here ? "primary" : ""}" data-act="xo-sel" title="Open the exploded teaching model over the scene">${icon("layers")}Explore internals (X-Ray)</button>` : ""}
      <button class="btn" data-act="diagnose-sel">${icon("spark")}What's wrong?</button>
      ${APP.modes.has("plan") ? `<button class="btn" data-act="plan-sel" title="Plan the access: move what is in the way in a safe layout simulation">${icon("grid")}Plan access</button>` : ""}</div>`;
}
const robotAt = (o) => !!(o && S.robot.arrived && S.navObject?.id === o.id && S.curve && S.robot.s >= S.robot.len - 0.05);
function equipmentInfo(a) {
  const lib = S.kb.classes[a.asset_class];
  if (!lib) return "";
  return `<div class="section"><div class="label">Equipment</div><p class="p">${esc(lib.function)}</p>
    <div class="row">${lib.components.map((c) => `<button class="pill" data-xpart="${c.id}">${esc(c.name)}</button>`).join("")}</div></div>`;
}
function deviceOptions() {
  const order = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
  const as = S.data.objects.filter((o) => o.asset && S.kb.classes[o.asset.asset_class]).map((o) => o.asset)
    .sort((a, b) => a.asset_class.localeCompare(b.asset_class) || order[a.condition_state] - order[b.condition_state]);
  return Object.keys(S.kb.classes).map((cls) => `<optgroup label="${esc(S.kb.classes[cls].label)}">${as.filter((a) => a.asset_class === cls)
    .map((a) => `<option value="${a.asset_id}" ${a.asset_id === S.xAsset?.asset_id ? "selected" : ""}>${a.tag} · ${nice(a.condition_state)}</option>`).join("")}</optgroup>`).join("");
}

function identityRows(o) {
  return `${kv("Label", `${esc(o.label)} · ${Math.round(o.confidence * 100)}%`)}${kv("Source", { "vlm+geometry": "Vision model + geometry", "review-corrected": "Review-corrected (team visual check, not field-verified)", "geometry-heuristic": "Geometry rules" }[o.label_source] || o.label_source)}
    ${kv("Frame", `${o.size.map((v) => v.toFixed(2)).join(" × ")} m`)}${o.asset ? kv("Mapping", `${Math.round(o.asset.mapping_confidence * 100)}%`) : ""}
    ${o.review_note ? `<p class="note" style="margin-top:8px">${esc(o.review_note)}</p>` : o.vlm_rationale ? `<p class="note" style="margin-top:8px">${esc(o.vlm_rationale)}</p>` : ""}`;
}


function renderDiagnosis() {
  card(`${diagnosisHTML(S.diag, S.tab, { actions: `<button class="btn primary" data-act="xray">${icon("layers")}See inside (X-Ray)</button><button class="btn" data-act="wo">${icon("doc")}Draft work order</button>` })}
    <p class="note" style="margin-top:10px;text-align:center">Decision support only. No control actions.</p></div>`);
}

$("#right").addEventListener("click", async (e) => {
  const t = e.target;
  const go = t.closest("[data-goto]")?.dataset.goto;
  if (go) return go === "xray" ? enterXRay() : setMode(go);
  const tab = t.closest("[data-tab]"); if (tab) { S.tab = tab.dataset.tab; return renderDiagnosis(); }
  const xt = t.closest("[data-xtab]"); if (xt) { S.xTab = xt.dataset.xtab; return renderPartCard(); }
  const pq = t.closest("[data-partq]"); if (pq) { $("#partQ").value = pq.dataset.partq; return askPart(); }
  if (t.closest("[data-close-card]")) { S.cardLock = false; S.selected = null; S.fac.setHighlighted([], { target: S.target.id }); renderLeft(); return S.diag && S.robot.arrived ? renderDiagnosis() : S.curve && !S.robot.done ? renderTransitCard() : S.diag ? renderDiagnosis() : renderOverviewCard(); }
  const row = t.closest("[data-obj]"); if (row) return selectObject(S.data.objects.find((o) => o.id === row.dataset.obj));
  const act = t.closest("[data-act]")?.dataset.act;
  if (act === "dispatch") dispatch(S.target.asset.asset_id);
  if (act === "locate") selectObject(S.target, { fly: true });
  if (act === "reset-all") return resetAll();
  if (act === "diagnose-target") { S.cardLock = true; S.diag = await api.diagnose(S.target.asset.asset_id); S.tab = "overview"; renderDiagnosis(); }
  if (act === "dispatch-sel") dispatch(S.selected.asset.asset_id);
  if (act === "diagnose-sel") { S.cardLock = true; S.diag = await api.diagnose(S.selected.asset.asset_id); S.tab = "overview"; renderDiagnosis(); }
  if (act === "xray") enterXRay(null, S.diag?.asset?.asset_id);
  if (act === "xray-sel") enterXRay(null, S.selected.asset.asset_id);
  if (act === "xo-sel") APP.xo ? APP.xo.show(S.selected.asset.asset_id) : enterXRay(null, S.selected.asset.asset_id);
  if (act === "plan-sel") { const o = S.selected; if (APP.planning?.pickObject) APP.planning.pickObject(o.id); else setMode("plan"); }
  if (act === "wo") showWorkOrder(S.diag.asset.asset_id);
  if (act === "result") renderDiagnosis();
  if (act === "isolate") { const on = S.xray.hidden.size === 0; S.xray.isolate(on ? S.xSelected : null); renderPartCard(); }
  if (act === "askpart") askPart();
});

// ------------------------------------------------------------------ selection
function selectAsset(id, opts) { const o = S.data.objects.find((x) => x.asset?.asset_id === id); if (o) selectObject(o, opts); }
function selectObject(o, { fly = false } = {}) {
  if (!o) return;
  S.selected = o;
  emit("select", o);
  S.fac.setHighlighted([...S.seen.keys()], { selected: o.id, target: S.target.id });
  renderLeft();
  if (!S.robot.moving && (S.mode === "facility" || !APP.modes.get(S.mode)?.ownsCard)) renderAssetCard(o);
  if (fly) { const c = new THREE.Vector3(...o.center); flyTo(c.clone().add(viewOffset(c)), c); }
}
function viewOffset(c) {
  // stand on the walkable side: toward the room centre
  const centre = new THREE.Vector3((S.data.bounds.min[0] + S.data.bounds.max[0]) / 2, 0, (S.data.bounds.min[2] + S.data.bounds.max[2]) / 2);
  const d = centre.sub(c).setY(0).normalize();
  return new THREE.Vector3(d.x * 1.9, 1.15, d.z * 1.9);
}

// ------------------------------------------------------------------ dock
// Camera modes (the navpad's Robot / Eye / Angled / Top buttons map onto the same ids: robot = pov, eye = free at eye level)
const CAMS = [["pov", "Robot POV", "Ride along: the robot's own camera, rendered from the 3D scan"], ["chase", "Chase", "Follow behind the robot"],
  ["broadcast", "Angled", "Watch from above at an angle, like a broadcast camera"], ["top", "Top", "Look straight down on the whole room"], ["free", "Free", "Move the camera yourself"]];
const SHORT = { PROCESS_PUMP: "Pump", ELECTRIC_MOTOR: "Motor", CONTROL_VALVE: "Valve", PRESSURE_TRANSMITTER: "Transmitter", VIBRATION_SENSOR: "Vibration sensor" };
function renderDock() {
  const x = ["xray", "learn", "practice"].includes(S.mode);
  renderRail();
  const md = APP.modes.get(S.mode);
  if (md?.dock) { $("#dock").innerHTML = md.dock(); return; }
  if (x) {
    const pct = Math.round(S.xray.target * 100);
    $("#dock").innerHTML = `
      <div class="grp"><button class="tool" data-d="assemble">${icon("cube")}Assemble</button></div>
      <div class="grp slider"><div class="top"><span>Explode</span><span id="xpct">${pct}%</span></div><input type="range" id="explode" min="0" max="100" value="${pct}" aria-label="Explode"/></div>
      <div class="grp"><button class="tool" data-d="all">${icon("expand")}All parts</button><button class="tool ${S.xray.ghost ? "on" : ""}" data-d="ghost"><span class="switch"></span>See-through</button><button class="tool ${S.xray.labelsOn ? "on" : ""}" data-d="labels"><span class="switch"></span>Labels</button></div>
      <div class="grp"><div class="seg" role="group" aria-label="Device type">${Object.keys(S.kb.classes).map((cls) => `<button data-xclass="${cls}" class="${S.xClass === cls ? "on" : ""}">${SHORT[cls] || nice(cls)}</button>`).join("")}</div></div>`;
    $("#explode").oninput = (e) => { S.xray.setExplode(e.target.value / 100); $("#xpct").textContent = `${e.target.value}%`; };
    return;
  }
  const r = S.route, R = S.robot, active = !!S.curve;
  $("#dock").innerHTML = `
    <div class="grp"><button class="tool" data-d="dispatch">${icon("play")}${active ? "Restart" : "Dispatch"}</button>
      <button class="tool" data-d="block" ${active && !R.done ? "" : "disabled"}>${icon("barrier")}Block aisle</button></div>
    <div class="grp"><button class="tool" id="playBtn" data-d="play" ${active ? "" : "disabled"}>${icon(R.moving ? "pause" : "play")}${R.moving ? "Pause" : "Play"}</button>
      <button class="tool ${R.moving && R.dir < 0 ? "on" : ""}" data-d="reverse" ${active ? "" : "disabled"}>${icon("rewind")}Reverse</button>
      <button class="tool" data-d="rate" title="Playback speed">${`<b style="font:600 13px var(--mono);height:18px">${R.rate}×</b>`}Speed</button></div>
    <div class="grp routeinfo"><div class="top"><span>Route</span><b id="rLen">${r ? r.length_m + " m" : "Not planned"}</b></div>
      <input type="range" id="scrub" min="0" max="1000" value="${active ? Math.round((R.s / R.len) * 1000) : 0}" ${active ? "" : "disabled"} aria-label="Route progress: drag to scrub forward or back"/>
      <small id="rMeta">${r ? `<span id="rProg"></span>A* ${r.compute_ms} ms · clearance ${r.validation.min_clearance_m} m · ${r.validation.collisions} collisions` : `Robot radius ${S.data.navigation.robot_radius_m} m · step limit ${S.data.navigation.max_step_m} m`}</small></div>
    <div class="grp"><div class="seg" role="group" aria-label="Camera">${CAMS.map(([v, l, t]) => `<button data-cam="${v}" class="${S.cam === v ? "on" : ""}" title="${t}" aria-pressed="${S.cam === v}">${l}</button>`).join("")}</div></div>
`;
  progressUI();
}
function progressUI() {
  const R = S.robot, sc = $("#scrub");
  if (sc && document.activeElement !== sc && R.len) sc.value = Math.round((R.s / R.len) * 1000);
  const t = $("#rProg"); if (t && R.len) t.textContent = `${R.s.toFixed(1)} of ${R.len.toFixed(1)} m · `;
}
function togglePlay(dir = 1) {
  const R = S.robot;
  if (!S.curve) return;
  if (R.moving && R.dir === dir) { R.moving = false; R.v = 0; return renderDock(); }
  if (dir > 0 && R.s >= R.len - 1e-3) { R.s = 0; R.arrived = R.arrived && false; }   // replay from the start
  if (dir < 0 && R.s <= 1e-3) return;
  R.dir = dir; R.moving = true; R.done = false; R.v = 0;
  renderDock();
}

$("#dock").addEventListener("input", (e) => {
  if (e.target.id !== "scrub" || !S.curve) return;
  const R = S.robot;
  R.moving = false; R.v = 0; R.s = (e.target.value / 1000) * R.len; R.follow = 1.2;
  poseRobot(0, true); proximity(); progressUI();
  const b = $("#playBtn"); if (b) b.innerHTML = `${icon("play")}Play`;
  if (R.s >= R.len - 1e-3 && !R.arrived) { R.done = true; arrive(); }
});
$("#dock").addEventListener("click", async (e) => {
  const md = APP.modes.get(S.mode);
  if (md?.dock) return md.onDock?.(e);
  const cm = e.target.closest("[data-cam]");
  if (cm) { setCamera(cm.dataset.cam); return renderDock(); }
  const xc = e.target.closest("[data-xclass]"); if (xc) return openClass(xc.dataset.xclass);
  const d = e.target.closest("[data-d]")?.dataset.d;
  if (!d) return;
  if (d === "dispatch") restart((S.selected?.asset || S.target.asset).asset_id);
  if (d === "play") togglePlay(1);
  if (d === "reverse") togglePlay(-1);
  if (d === "rate") { S.robot.rate = { 1: 2, 2: 4, 4: 1 }[S.robot.rate]; renderDock(); }

  if (d === "block") blockAisle();
  if (d === "assemble") { S.xray.setExplode(0); renderDock(); }
  if (d === "all") { S.xray.isolate(null); flyTo(xHome().pos, xHome().tgt, 1, xCam, xControls); if (S.xSelected) renderPartCard(); }
  if (d === "ghost") { S.xray.setGhost(!S.xray.ghost); renderDock(); }
  if (d === "labels") { S.xray.setLabels(!S.xray.labelsOn); renderDock(); }
});

// ------------------------------------------------------------------ rail
const FRAMES = { all: "All 3D frames", assets: "Asset frames only", none: "No frames" };
function renderRail() {
  const fac = sceneMode();
  $$("#rail .fac-only").forEach((b) => b.classList.toggle("hidden", !fac));
  for (const b of APP.rail) $(`#rail [data-rail="x:${b.id}"]`)?.classList.toggle("on", !!b.isOn?.());
  const f = $('#rail [data-rail="frames"]'); f.classList.toggle("on", S.frames !== "none"); f.title = `3D frames: ${FRAMES[S.frames]} (click to change)`;
  $('#rail [data-rail="grid"]').classList.toggle("on", S.grid);
  $('#rail [data-rail="minimap"]').classList.toggle("on", S.minimap);
}
$("#rail").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-rail]")?.dataset.rail;
  if (r?.startsWith("x:")) { await APP.rail.find((b) => b.id === r.slice(2))?.onClick(APP); return renderRail(); }
  const x = !sceneMode(), cam = x ? xCam : camera, ctl = x ? xControls : controls;
  if (r === "in" || r === "out") {
    if (!x && S.cam === "pov") setCamera("free"); const v = cam.position.clone().sub(ctl.target).multiplyScalar(r === "in" ? 0.8 : 1.25); flyTo(ctl.target.clone().add(v), ctl.target.clone(), 0.4, cam, ctl); }
  if (r === "reset") x ? flyTo(xHome().pos, xHome().tgt, 1, xCam, xControls) : flyTo(S.home.pos, S.home.tgt);
  if (r === "full") document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.().catch(() => {});
  if (r === "help") showAbout();
  if (r === "focus") setFocus(true);
  if (r === "frames") { S.frames = { all: "assets", assets: "none", none: "all" }[S.frames]; S.fac.setShowMode(S.frames); toast(FRAMES[S.frames], 1600); }
  if (r === "grid") { S.grid = !S.grid; if (S.grid) S.fac.showGrid(await api.grid()); S.fac.gridGroup.visible = S.grid; }
  if (r === "minimap") { S.minimap = !S.minimap; $("#minimap").classList.toggle("hidden", !S.minimap); }
  renderRail();
});

// ------------------------------------------------------------------ navigation + robot
function restart(assetId) {
  S.blocks = []; S.fac.setBlocks([]); S.prevRoute = null; S.seenBefore = new Set();
  S.fac.robot.position.set(...S.data.start);
  return dispatch(assetId);
}
/** Arc length at which each object first comes within 1.2 m: makes scrubbing and reverse playback exact and cheap. */
function firstContact(curve, len) {
  const out = new Map(), n = Math.max(2, Math.ceil(len / 0.05)), objs = S.data.objects.filter((o) => o.kind === "object");
  for (let i = 0; i <= n; i++) {
    const p = curve.getPointAt(i / n), s = (i / n) * len;
    for (const o of objs) if (!out.has(o.id) && Math.hypot(o.center[0] - p.x, o.center[2] - p.z) < NEAR()) out.set(o.id, s);
  }
  return out;
}
async function applyRoute(res, { keepSpeed = true } = {}) {
  S.route = res;
  S.fac.setWalkable(await api.grid());      // grid reflects the blocks used for this plan
  // start the drawn/driven curve exactly where the robot is (the plan starts at the centre of its grid cell,
  // a few cm away), so a reroute never makes the robot jump
  const r = S.fac.robot.position, w0 = res.waypoints[0];
  const pts = Math.hypot(r.x - w0[0], r.z - w0[2]) > 0.005 ? [[r.x, 0, r.z], ...res.waypoints] : res.waypoints;
  S.curve = S.fac.drawRoute(pts);
  if (S.prevRoute) S.fac.ghostRoute(S.prevRoute);
  Object.assign(S.robot, { len: S.curve.getLength(), s: 0, moving: true, dir: 1, done: false, v: keepSpeed ? S.robot.v : 0 });
  S.firstSeen = firstContact(S.curve, S.robot.len);
  renderDock();
}

async function dispatch(assetId, { start = null, quiet = false } = {}) {
  const o = S.data.objects.find((x) => x.asset?.asset_id === assetId);
  if (!o) return null;
  if (!sceneMode()) setMode("facility");
  S.navObject = o;
  const p = S.fac.robot.position;
  const res = await api.plan(withExtras({ object_id: o.id, start: start || [p.x, p.z], blocks: S.blocks }));
  if (!res.ok) { toast(esc(res.reason)); return null; }
  S.seenBefore = new Set(); S.seen.clear(); S.robot.arrived = false; S.cardLock = false;
  await applyRoute(res, { keepSpeed: quiet });
  S.diag = null;
  S.diagPromise = api.diagnose(assetId);
  if (!quiet) toast(`Route planned: <b>${res.length_m} m</b> in ${res.compute_ms} ms. Collision-free, minimum clearance ${res.validation.min_clearance_m} m.`);
  renderDock(); renderTransitCard();
  return res;
}

/** Back to a clean start: no plan, no support hand-off, no barriers, robot at its dock, briefing card. */
function resetAll() {
  try { APP.planning?.reset?.(); } catch (e) { console.warn(e); }
  try { APP.support?.reset?.(); } catch (e) { console.warn(e); }
  S.blocks = []; S.fac.setBlocks([]); S.prevRoute = null; S.route = null; S.curve = null; S.diag = null; S.cardLock = false;
  Object.assign(S.robot, { moving: false, s: 0, len: 0, v: 0, done: true, arrived: false });
  S.fac.robot.position.set(...S.data.start); S.fac.routeGroup.clear();
  S.seen = new Map(); S.seenBefore = new Set(); S.selected = null;
  setMode("facility"); renderLeft(); renderOverviewCard(); renderDock();
  flyTo(S.home.pos, S.home.tgt);
  toast("Demo reset: original layout, no hand-off, robot at its dock.");
}

/** Re-plan the active route from where the robot is (e.g. after a planned layout change). Returns the plan result. */
async function replan({ quiet = false } = {}) {
  if (!S.navObject) return null;
  const p = S.fac.robot.position;
  const res = await api.plan(withExtras({ object_id: S.navObject.id, start: [p.x, p.z], blocks: S.blocks }));
  if (!res.ok) { if (!quiet) toast(esc(res.reason)); return res; }
  if (S.curve && !S.robot.done) { S.prevRoute = S.route?.waypoints || null; await applyRoute(res); }   // only an active run is re-routed
  return res;
}

async function blockAisle() {
  if (!S.curve || S.robot.done) return;
  // Drop the barrier on the route ahead. If that spot cuts the only corridor, try further along, so the demo
  // shows a real detour; if no placement leaves a safe route, the robot stops instead of driving through.
  const prev = S.route, prevCurve = S.curve, prevLeft = S.robot.len - S.robot.s;
  const v0 = S.robot.v; S.robot.moving = false;      // hold still while re-planning
  const p0 = S.fac.robot.position, start = [p0.x, p0.z];
  let best = null;
  for (const ahead of [0.9, 1.5, 2.2, 3.0, 3.8, 4.6]) {
    const s = S.robot.s + ahead;
    if (s > S.robot.len - 0.6) break;
    const u = s / S.robot.len, p = prevCurve.getPointAt(u), tan = prevCurve.getTangentAt(u);
    const b = { x: +p.x.toFixed(2), z: +p.z.toFixed(2), w: 0.9, d: 0.35, yaw: Math.atan2(tan.z, tan.x) + Math.PI / 2 };
    const res = await api.plan(withExtras({ object_id: S.navObject.id, start, blocks: [...S.blocks, b] }));
    if (res.ok && (!best || res.length_m > best.res.length_m)) best = { b, res };
    if (best && best.res.length_m - prevLeft > 0.8) break;                          // a clear detour: good enough
  }
  if (best) {
    S.blocks.push(best.b);
    const res = await api.plan(withExtras({ object_id: S.navObject.id, start, blocks: S.blocks }));   // planner state = chosen barrier
    S.fac.setBlocks(S.blocks);
    S.prevRoute = prev.waypoints;
    S.seenBefore = new Set(S.seen.keys());
    S.robot.v = v0;
    await applyRoute(res);
    if (!S.robot.arrived) renderTransitCard();
    const extra = res.length_m - prevLeft;
    toast(`Aisle blocked. New collision-free route in <b>${res.compute_ms} ms</b>: ${res.length_m} m to go${extra > 0.05 ? `, a ${extra.toFixed(1)} m detour` : ", squeezing past the barrier"}.`, 6000);
    return;
  }
  S.robot.moving = false;
  toast("No safe detour exists from here. The robot has stopped and is waiting.", 6000);
  renderDock();
}

const _v = new THREE.Vector3(), _t = new THREE.Vector3();
// Frame-rate independent smoothing: same feel at 30, 60 or 120 fps.
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const CRUISE = 0.6, ACCEL = 0.45;           // m/s, m/s²
let proxClock = 0, transitDirty = false, transitClock = 0, camYaw = null;
function updateRobot(dt, t) {
  const R = S.robot, robot = S.fac.robot;
  robot.userData.ring.material.opacity = 0.22 + 0.12 * Math.sin(t * 2);
  if (!S.curve) return;
  if (R.moving) {
    // trapezoidal speed profile in either direction: accelerate away, cruise, brake into the end
    const remain = R.dir > 0 ? R.len - R.s : R.s, cruise = CRUISE * R.rate, acc = ACCEL * R.rate;
    R.v = Math.min(cruise, (R.v ?? 0) + acc * dt, Math.sqrt(2 * acc * Math.max(remain, 0)) + 0.04 * R.rate);
    R.s = Math.max(0, Math.min(R.len, R.s + R.dir * R.v * dt));
    poseRobot(dt);
    // proximity at 10 Hz is plenty for a robot moving < 1 m/s, and keeps the frame budget for rendering
    proxClock += dt;
    if (proxClock > 0.1) { proxClock = 0; proximity(); progressUI(); }
  }
  transitClock += dt;
  if (transitDirty && transitClock > 0.4) { transitDirty = false; transitClock = 0; if (!S.cardLock && !(S.diag && R.arrived)) renderTransitCard(); }   // never replace a card the user opened
  R.follow = Math.max(0, R.follow - dt);
  if (R.moving || R.follow > 0) followCamera(dt);
  if (R.moving && R.dir > 0 && R.s >= R.len - 1e-3) { R.moving = false; R.v = 0; R.done = true; camYaw = null; renderDock(); if (!R.arrived) arrive(); }
  if (R.moving && R.dir < 0 && R.s <= 1e-3) { R.moving = false; R.v = 0; renderDock(); }
}
function poseRobot(dt, snap = false) {
  const R = S.robot, robot = S.fac.robot;
  const u = R.s / R.len, p = S.curve.getPointAt(u);
  const ahead = S.curve.getPointAt(Math.min(1, (R.s + 0.35) / R.len));
  robot.position.set(p.x, 0, p.z);
  if (ahead.distanceToSquared(p) > 1e-6) {
    const want = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    let dy = want - robot.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    robot.rotation.y += snap ? dy : dy * damp(7, dt);
  }
}
function proximity() {
  const p = S.fac.robot.position, near = [];
  for (const o of S.data.objects) if (o.kind === "object" && Math.hypot(o.center[0] - p.x, o.center[2] - p.z) < NEAR()) near.push(o.id);
  // seen = everything read on earlier legs + everything this route has passed so far (exact in both directions)
  const before = S.seen.size, assetsBefore = [...S.seen.keys()].filter((id) => S.objById.get(id)?.asset).length;
  S.seen = new Map([...S.seenBefore].map((id) => [id, true]));
  if (S.firstSeen) for (const [id, s0] of S.firstSeen) if (s0 <= S.robot.s + 1e-6) S.seen.set(id, true);
  const assetsNow = [...S.seen.keys()].filter((id) => S.objById.get(id)?.asset).length;
  if (assetsNow !== assetsBefore || (before && !S.seen.size)) transitDirty = true;
  S.fac.setHighlighted(near, { selected: S.selected?.id, target: S.target.id });
  const other = $("#otherCount"); if (other) other.textContent = S.seen.size;
}
function followCamera(dt) {
  const robot = S.fac.robot, p = robot.position;
  if (S.cam === "chase") {
    // chase camera follows a damped heading, so corners turn the view gently instead of snapping
    const yaw = robot.rotation.y;
    if (camYaw === null) camYaw = yaw;
    let d = yaw - camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * damp(2.2, dt);
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    _v.set(p.x - fx * 2.6 + fz * 0.7, 1.9, p.z - fz * 2.6 - fx * 0.7);
    camera.position.lerp(_v, damp(3, dt));
    controls.target.lerp(_t.set(p.x + fx * 1.0, 0.5, p.z + fz * 1.0), damp(4, dt));
  } else if (S.cam === "broadcast") {
    // TV-style: a high camera on a fixed side of the room that pans with the robot, never rotating with it
    const b = broadcastOffset();
    camera.position.lerp(_v.set(p.x + b.x, b.y, p.z + b.z), damp(1.6, dt));
    controls.target.lerp(_t.set(p.x, 0.2, p.z), damp(2.4, dt));
  }
}

async function arrive() {
  S.robot.arrived = true;
  const o = S.navObject, c = new THREE.Vector3(...o.center), r = S.fac.robot.position.clone();
  const dir = c.clone().sub(r).setY(0).normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  if (S.cam === "chase" || S.cam === "free") flyTo(r.clone().addScaledVector(dir, -0.9).addScaledVector(side, 1.0).setY(1.7), c.clone().setY(Math.max(0.35, c.y)));
  S.selected = o;
  S.fac.setHighlighted([], { selected: o.id, target: o.id });
  const owned = APP.modes.get(S.mode)?.ownsCard;          // Plan / Support keep their own cards
  renderDock(); if (!owned) renderLeft();
  // in-scene prompt (navigate → arrive → inspect → understand), except in modes that own their card (Plan, Support)
  if (owned || !APP.arrival?.show(o)) toast(`Arrived at <b>${o.asset.tag}</b>. Diagnosis ready.`);
  S.diag = await S.diagPromise; S.tab = "overview";
  if (owned || APP.modes.get(S.mode)?.ownsCard) return;
  $("#right").classList.remove("min");
  renderDiagnosis();
}

// ------------------------------------------------------------------ spectator cameras
const roomBox = () => {
  const b = S.data.bounds;
  return { x0: b.min[0], x1: b.max[0], z0: b.min[2], z1: b.max[2], cx: (b.min[0] + b.max[0]) / 2, cz: (b.min[2] + b.max[2]) / 2 };
};
function broadcastOffset() {
  // stand on the long side of the room, high and pulled back, like the main camera at a football match
  const r = roomBox(), wide = r.x1 - r.x0 >= r.z1 - r.z0;
  // ~45° down from just outside the long wall; the cut-away keeps the near wall from blocking the view
  return wide ? new THREE.Vector3(0, 5.0, (r.z1 - r.z0) * 0.5 + 1.0) : new THREE.Vector3((r.x1 - r.x0) * 0.5 + 1.0, 5.0, 0);
}
function topView() {
  const r = roomBox(), fov = (camera.fov * Math.PI) / 180;
  const spanZ = (r.z1 - r.z0) * 1.08, spanX = ((r.x1 - r.x0) * 1.08) / camera.aspect;
  const h = Math.max(spanZ, spanX) / (2 * Math.tan(fov / 2));
  // a hair of +z offset keeps OrbitControls stable; screen right = +x, screen down = +z (same as the mini-map)
  return { pos: new THREE.Vector3(r.cx, h, r.cz + 0.01), tgt: new THREE.Vector3(r.cx, 0, r.cz) };
}
/** Switch the facility camera. Only the camera changes: route, progress, speed and the moving/paused state never do. */
export function setCamera(mode) {
  const prev = S.cam;
  S.cam = mode;
  const high = mode === "broadcast" || mode === "top";
  S.fac.setCutaway(high);
  controls.minPolarAngle = 0;
  camera.far = high ? 120 : 80; camera.updateProjectionMatrix();
  if (mode === "pov") {
    // blend from wherever the camera is into the robot's sensor pose (no cut, no restart)
    tween = null; povYaw = null;
    povBlend = prev === "pov" ? null : { k: 0, p0: camera.position.clone(), t0: controls.target.clone() };
    return;
  }
  if (mode === "top") { const v = topView(); flyTo(v.pos, v.tgt, 1.2); }
  if (mode === "broadcast") { const p = S.fac.robot.position, b = broadcastOffset(); flyTo(new THREE.Vector3(p.x + b.x, b.y, p.z + b.z), new THREE.Vector3(p.x, 0.2, p.z), 1.2); }
  if (mode === "chase") {
    // paused or arrived on a route: settle in behind the robot; idle at the dock: the eye-level home view
    if (S.robot.moving) return;
    if (S.curve) { tween = null; camYaw = null; S.robot.follow = 1.6; } else flyTo(S.home.pos, S.home.tgt, 1.0);
  }
}

// ------------------------------------------------------------------ robot POV: the robot's own (simulated) camera
// Sensor ~0.95 m up at the front of the robot, looking along a damped heading with a slight downward tilt.
// The heading is smoothed on top of the robot's own damped yaw, so corners turn the view gently; scrubbing snaps the
// robot but the camera eases after it. After arrival the camera turns to face the asset. The robot's own body is hidden.
const POV = { h: 0.95, fwd: 0.17, look: 2.2, tilt: 0.14, w: 4.2, wMax: 2.2 };   // m, m, m, rad, 1/s, rad/s
let povYaw = null, povW = 0, povBlend = null, povHidden = false;
function povCamera(dt) {
  const r = S.fac.robot, p = r.position, R = S.robot;
  let want = r.rotation.y;
  if (R.arrived && !R.moving && S.curve && R.s >= R.len - 1e-3 && S.navObject) {
    const c = S.navObject.center; if (Math.hypot(c[0] - p.x, c[2] - p.z) > 0.05) want = Math.atan2(c[0] - p.x, c[2] - p.z);
  }
  if (povYaw === null || !Number.isFinite(povYaw)) { povYaw = want; povW = 0; }
  // critically damped spring on the heading with a turn-rate limit: no whip pans, no jerk when a turn starts or ends
  let d = want - povYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  povW += (POV.w * POV.w * d - 2 * POV.w * povW) * dt;
  povW = Math.max(-POV.wMax, Math.min(POV.wMax, povW));
  povYaw += povW * dt;
  const fx = Math.sin(povYaw), fz = Math.cos(povYaw);
  _v.set(p.x + fx * POV.fwd, POV.h, p.z + fz * POV.fwd);
  _t.set(_v.x + fx * POV.look, POV.h - Math.tan(POV.tilt) * POV.look, _v.z + fz * POV.look);
  if (povBlend) {
    povBlend.k = Math.min(1, povBlend.k + dt / 0.8);
    const k = povBlend.k, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(povBlend.p0, _v, e); controls.target.lerpVectors(povBlend.t0, _t, e);
    if (k >= 1) povBlend = null;
  } else { camera.position.copy(_v); controls.target.copy(_t); }
}
/** Hide the robot's own body in POV (the camera sits inside its sensor head); the spectator tag stays managed by setCutaway. */
function povRobotVisibility(pov) {
  if (pov === povHidden) return;
  povHidden = pov;
  const r = S.fac.robot;
  for (const c of r.children) if (c !== r.userData.tag) c.visible = !pov;
}
let hudClock = 1;
function povHud(dt, on) {
  const el = $("#povHud");
  hudClock += dt;
  if (!on) { if (!el.classList.contains("hidden")) el.classList.add("hidden"); return; }
  if (hudClock < 0.12 && !el.classList.contains("hidden")) return;
  hudClock = 0;
  const R = S.robot, active = !!S.curve, left = active ? Math.max(0, R.len - R.s) : 0;
  const tag = S.navObject?.asset?.tag || S.target.asset.tag;
  const state = !active ? "Docked · waiting for a route" : R.moving ? (R.dir < 0 ? "Reversing" : `Driving to ${tag}`) : R.s >= R.len - 1e-3 ? `Arrived at ${tag}` : R.s <= 1e-3 ? "At the start · paused" : "Paused";
  el.innerHTML = `<div class="pov-top"><span class="pov-rec"><i></i>Robot camera</span><span class="pov-state">${state}</span></div>
    <div class="pov-tel"><span>Speed <b>${(R.moving ? R.v : 0).toFixed(2)} m/s</b></span><span>To go <b>${active ? left.toFixed(1) + " m" : "–"}</b></span></div>
    <div class="pov-note">Simulated robot camera — rendered from the 3D scan, not a live feed</div>`;
  el.classList.remove("hidden");
}

// ------------------------------------------------------------------ mini-map (2D, always shows the whole room)
const MM = { w: 232, base: null, k: 1, h: 0, grid: null, t: 0 };
async function initMinimap() {
  const g = await api.grid();
  MM.grid = g;
  MM.k = MM.w / (g.W * g.res);
  MM.h = Math.round(g.H * g.res * MM.k);
  const base = document.createElement("canvas"); base.width = g.W; base.height = g.H;
  const ctx = base.getContext("2d"), img = ctx.createImageData(g.W, g.H);
  for (let i = 0; i < g.W * g.H; i++) {
    const o = i * 4;
    if (g.walkableMask[i]) img.data.set([236, 239, 243, 46], o);
    else if (g.occupiedMask[i]) img.data.set([140, 148, 158, 110], o);
  }
  ctx.putImageData(img, 0, 0);
  MM.base = base;
  const cv = $("#minimap canvas");
  cv.width = MM.w * 2; cv.height = MM.h * 2; cv.style.width = MM.w + "px"; cv.style.height = MM.h + "px";
  cv.onclick = (e) => {             // click the map to look there from above
    if (APP.xo?.open) return;
    const r = cv.getBoundingClientRect(), x = MM.grid.x0 + (e.clientX - r.left) / MM.k, z = MM.grid.z0 + (e.clientY - r.top) / MM.k;
    S.cam = "free"; renderDock();
    flyTo(new THREE.Vector3(x, 4.5, z + 2.2), new THREE.Vector3(x, 0, z), 0.9);
  };
}
const STATUS_CSS = { healthy: "#30d158", watch: "#ffd60a", degraded: "#ff9f0a", attention_required: "#ff453a" };
function drawMinimap(dt) {
  if (!S.minimap || !MM.base) return;
  MM.t += dt; if (MM.t < 0.066) return; MM.t = 0;   // 15 fps is plenty for a map
  const cv = $("#minimap canvas"), ctx = cv.getContext("2d"), g = MM.grid, k = MM.k * 2;
  const X = (x) => (x - g.x0) * k, Z = (z) => (z - g.z0) * k;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(MM.base, 0, 0, cv.width, cv.height);
  if (S.prevRoute) { ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(160,166,176,.7)"; ctx.lineWidth = 1.5; ctx.beginPath(); S.prevRoute.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Z(p[2]))); ctx.stroke(); ctx.setLineDash([]); }
  if (S.curve) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 80; i++) { const p = S.curve.getPointAt(i / 80); (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.x), Z(p.z)); }
    ctx.stroke();
  }
  for (const b of S.blocks) { ctx.fillStyle = "#ff9f0a"; ctx.fillRect(X(b.x) - 4, Z(b.z) - 4, 8, 8); }
  for (const o of S.data.objects) {
    if (!o.asset) continue;
    const seen = S.seen.has(o.id), tgt = o.id === S.target.id;
    ctx.fillStyle = STATUS_CSS[o.asset.condition_state] || "#ccc";
    ctx.globalAlpha = seen || tgt ? 1 : 0.55;
    ctx.beginPath(); ctx.arc(X(o.center[0]), Z(o.center[2]), tgt ? 5 : 3.2, 0, Math.PI * 2); ctx.fill();
    if (tgt) { ctx.strokeStyle = "#ff453a"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(o.center[0]), Z(o.center[2]), 9, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  const r = S.fac.robot, rx = X(r.position.x), rz = Z(r.position.z);
  ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(rx, rz, NEAR() * k, 0, Math.PI * 2); ctx.stroke();
  ctx.save(); ctx.translate(rx, rz); ctx.rotate(-r.rotation.y + Math.PI);
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  // camera footprint: where the main view is looking
  emit("minimap", ctx, X, Z, k);
  const t = controls.target; ctx.strokeStyle = "rgba(10,132,255,.9)"; ctx.lineWidth = 1.5; ctx.strokeRect(X(t.x) - 5, Z(t.z) - 5, 10, 10);
}

// ------------------------------------------------------------------ camera tween
let tween = null;
function flyTo(pos, target, dur = 1.1, cam = camera, ctl = controls) {
  // a requested facility view (select + fly, zoom, reset, mini-map...) takes the camera out of the robot POV
  if (cam === camera && S.cam === "pov") { S.cam = "free"; povBlend = null; if (sceneMode() && !APP.modes.get(S.mode)?.dock) renderDock(); }
  tween = { p0: cam.position.clone(), t0: ctl.target.clone(), p1: pos.clone(), t1: target.clone(), k: 0, dur, cam, ctl };
}
function updateTween(dt) {
  if (!tween) return;
  tween.k = Math.min(1, tween.k + dt / tween.dur);
  const k = tween.k, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  tween.cam.position.lerpVectors(tween.p0, tween.p1, e);
  tween.ctl.target.lerpVectors(tween.t0, tween.t1, e);
  if (k >= 1) tween = null;
}

// ------------------------------------------------------------------ X-Ray (any device: the model comes from the library)
const xDef = () => S.kb.classes[S.xClass];
const xComp = (id) => xDef()?.components.find((c) => c.id === id);
const assetById = (id) => S.data.objects.find((o) => o.asset?.asset_id === id)?.asset;

/** Load the exploded model + diagnosis for one asset (defaults: selection, current diagnosis, then the target). */
async function prepareXRay(assetId) {
  assetId = assetId || S.xAsset?.asset_id || S.selected?.asset?.asset_id || S.diag?.asset?.asset_id || S.target.asset.asset_id;
  const a = assetById(assetId);
  if (!S.kb.classes[a.asset_class]) { toast(`No teaching model for ${nice(a.asset_class)} yet.`); return false; }
  // fetch first, then switch device state + model together, so no render ever sees a half-switched device
  const diag = S.diag?.asset?.asset_id === assetId ? S.diag : await api.diagnose(assetId);
  if (S.xClass !== a.asset_class) S.xSelected = null;
  S.xAsset = a; S.xClass = a.asset_class; S.xDiag = diag;
  S.xray.load(S.xClass);
  const lead = S.xDiag.hypotheses[0]?.components || [];
  S.xray.highlight(lead, { alt: S.xDiag.hypotheses.slice(1).flatMap((h) => h.components) });
  return true;
}
async function enterXRay(focus = null, assetId = null) {
  const from = S.mode;
  if (!(await prepareXRay(assetId))) return;
  if (from === "facility") {
    const o = S.data.objects.find((x) => x.asset?.asset_id === S.xAsset.asset_id) || S.target;
    const c = new THREE.Vector3(...o.center);
    flyTo(c.clone().add(new THREE.Vector3(0.3, 0.1, 0.3)), c, 0.8);
    await wait(500); $(".fade").classList.add("on"); await wait(500);
  }
  setMode("xray");
  const h = xHome();
  xCam.position.copy(h.pos).sub(h.tgt).multiplyScalar(1.3).add(h.tgt); xControls.target.copy(h.tgt);
  flyTo(h.pos, h.tgt, 1.4, xCam, xControls);
  S.xray.setExplode(0);
  $(".fade").classList.remove("on");
  setTimeout(() => { S.xray.setExplode(0.65); renderDock(); }, 900);
  const lead = S.xDiag.hypotheses[0]?.components || [];
  S.xSelected = (focus && focus[0]) || lead[0] || null;
  S.xray.selected = S.xSelected;
  renderComponents(); renderPartCard();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Open X-Ray for a device type: the highest-priority asset of that class (fault first). */
function openClass(cls) {
  const order = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
  const a = S.data.objects.filter((o) => o.asset?.asset_class === cls).map((o) => o.asset)
    .sort((x, y) => (y.is_target - x.is_target) || order[x.condition_state] - order[y.condition_state] || x.health_score - y.health_score)[0];
  if (!a) return toast(`No ${esc(nice(cls).toLowerCase())} is mapped in this scan.`);
  if (!["xray", "learn", "practice"].includes(S.mode)) return enterXRay(null, a.asset_id);
  return switchDevice(a.asset_id);
}
async function switchDevice(assetId) {
  await prepareXRay(assetId);
  S.xSelected = S.xDiag.hypotheses[0]?.components?.[0] || null; S.xray.selected = S.xSelected;
  const h = xHome(); flyTo(h.pos, h.tgt, 1.0, xCam, xControls);
  S.xray.setExplode(0.65); renderDock();
  if (S.mode === "xray") { renderComponents(); renderPartCard(); } else setMode(S.mode);
}

function renderPartCard() {
  if (S.mode !== "xray") return;
  const c = xComp(S.xSelected), D = S.xDiag;
  if (!c) return card(`${header("Illustrative model", esc(xDef().model_title), '<span class="tag">Illustrative</span>')}
    <div class="sub">${S.xAsset.tag} · ${nice(S.xAsset.condition_state)} · ${nice(S.xAsset.issue_code)}</div>
    <p class="p" style="margin-top:12px">${esc(xDef().function)}</p><p class="note">${esc(S.kb.provenance)}</p><p class="note">Select a component on the left or in the model.</p></div>`);
  const lead = new Set(D?.hypotheses?.[0]?.components || []);
  const tel = Object.fromEntries((D?.telemetry?.signals || []).map((s) => [s.signal, s]));
  const isolated = S.xray.hidden.size > 0;
  const tabs = { overview: "Overview", evidence: "Evidence", ask: "Ask" };
  const body = {
    overview: `<p class="p">${esc(c.function)}</p>${kv("Group", nice(c.group))}${kv("Linked faults", c.issue_codes.map(nice).join(", "))}
      ${lead.has(c.id) ? kv("Status", `<span style="color:var(--bad)">Suspected for ${D.asset.tag}</span>`) : ""}
      <div class="section"><div class="label">Typical failure signs</div>${c.failure_symptoms.map((s, i) => `<div class="step"><span class="k">${i + 1}</span><span>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</span></div>`).join("")}</div>`,
    evidence: `<div class="label note" style="margin-bottom:4px">Signals for ${D?.asset?.tag ?? "this asset"}</div>${c.evidence_signals.map((s) => { const t = tel[s]; const hot = t && (t.abnormal || Math.abs(t.z_vs_peers ?? 0) >= 1.5);
      return `<div class="sig"><div><b>${signalName(s)}</b><small>${t ? `${t.recent_mean} ${t.unit} · peers ${t.peer_mean} · <span class="${hot ? "flag" : ""}">z ${t.z_vs_peers}</span>` : "Not measured on this asset"}</small></div>${t ? sparkline(t.series, 88, 26, hot) : ""}</div>`; }).join("")}`,
    ask: `<input class="search" id="partQ" value="What does the ${esc(c.name.toLowerCase())} do and what evidence suggests it may be faulty?"/>
      <div class="row" style="margin-top:8px">${[`How do I inspect the ${c.name.toLowerCase()}?`, `Show me the maintenance guidance for the ${c.name.toLowerCase()}`].map((q) => `<button class="pill" data-partq="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      <div class="section"><button class="btn block" data-act="askpart">${icon("spark")}Ask the copilot</button></div><div id="partA" class="section"></div>
      <p class="note">Answers come only from the builder-pack documents and the training notes, with citations. They are not OEM repair procedures.</p>`,
  };
  card(`${header(nice(c.group), esc(c.name), '<span class="tag">Illustrative</span>')}
    <div class="actions-top"><button class="btn" data-act="isolate">${icon("target")}${isolated ? "Show all parts" : "Show only this part"}</button></div>
    <div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-xtab="${k}" class="${S.xTab === k ? "on" : ""}">${v}</button>`).join("")}</div>
    ${body[S.xTab]}
    <div class="section" style="text-align:center"><button class="link" data-docid="KB-XRAY-${S.xClass}#${c.id}">Training note ${icon("arrow")}</button></div></div>`);
}

async function askPart() {
  $("#partA").innerHTML = '<div class="note">Looking it up…</div>';
  const a = await api.query($("#partQ").value, S.xAsset?.asset_id, S.xSelected);
  $("#partA").innerHTML = `<div class="narr">${cites(a.text)}</div><p class="note" style="margin-top:6px">${esc(a.mode)} · ${a.sources?.length ?? 0} sources</p>`;
}

export function focusPart(id, dist = null) {
  const c = S.xray.partCenter(id), h = xHome();
  dist = dist ?? h.pos.distanceTo(h.tgt) * 0.6;          // scaled to the model: small sensors and large pumps alike
  const dir = h.pos.clone().sub(h.tgt).normalize();
  flyTo(c.clone().addScaledVector(dir, dist), c, 0.9, xCam, xControls);
}
function selectComponent(id) {
  S.xSelected = id;
  S.xray.selected = id;
  if (S.mode === "xray") { renderComponents(); renderPartCard(); focusPart(id); }
  S.onComponentPick?.(id);
}

// ------------------------------------------------------------------ value (ROI): transparent, hypothetical inputs
const ROI_INPUTS = [
  ["techs", "Technicians using the tool", 50, 1, 500, 1, ""],
  ["tasks", "Information look-ups per technician per week", 4, 1, 40, 1, ""],
  ["before", "Minutes to find location, documents and history today", 30, 1, 120, 1, "min"],
  ["after", "Minutes with Industrial X-Ray", 10, 1, 120, 1, "min"],
  ["rate", "Loaded labour cost per hour", 50, 10, 200, 1, "€"],
  ["weeks", "Working weeks per year", 50, 1, 52, 1, ""],
  ["hires", "New technicians onboarded per year", 10, 0, 200, 1, ""],
  ["trainH", "Onboarding hours saved per new technician", 16, 0, 160, 1, "h"],
  ["downH", "Downtime hours avoided per year (needs validated plant data)", 0, 0, 200, 1, "h"],
  ["downC", "Cost of one downtime hour", 5000, 0, 50000, 500, "€"],
];
export function computeROI(v) {
  const hours = v.techs * v.tasks * v.weeks * Math.max(0, v.before - v.after) / 60;
  const lookup = hours * v.rate, training = v.hires * v.trainH * v.rate, downtime = v.downH * v.downC;
  return { hours, lookup, training, downtime, total: lookup + training + downtime };
}
S.roi = Object.fromEntries(ROI_INPUTS.map(([k, , d]) => [k, d]));
const eur = (x) => "€" + Math.round(x).toLocaleString("en-US");
const num = (x) => Math.round(x).toLocaleString("en-US");
function roiNumbers() {
  const v = S.roi, r = computeROI(v);
  $("#roiTotal").textContent = eur(r.total);
  $("#roiLookup").textContent = eur(r.lookup);
  $("#roiTrain").textContent = eur(r.training);
  $("#roiDown").textContent = r.downtime ? eur(r.downtime) : "not counted";
  $("#roiF").innerHTML = `
    <div class="formula">${v.techs} technicians × ${v.tasks} look-ups/week × ${v.weeks} weeks × (${v.before} − ${v.after}) min ÷ 60 = <b>${num(r.hours)} h</b></div>
    <div class="formula">${num(r.hours)} h × €${v.rate}/h = <b>${eur(r.lookup)}</b></div>
    <div class="formula">${v.hires} new technicians × ${v.trainH} h × €${v.rate}/h = <b>${eur(r.training)}</b></div>
    <div class="formula">${v.downH} h × ${eur(v.downC)} = <b>${eur(r.downtime)}</b></div>`;
  for (const [k, , , , , , unit] of ROI_INPUTS) {
    const el = $(`[data-roiv="${k}"]`);
    if (el) el.textContent = `${unit === "€" ? "€" : ""}${num(v[k])}${unit && unit !== "€" ? " " + unit : ""}`;
  }
}
function renderValue() {
  const v = S.roi;
  $("#value").innerHTML = `
    <div class="card-h"><span class="eyebrow-row">Business value<span class="tag">Illustrative</span></span><button class="link" data-mode-back title="Back to facility">${icon("close")}</button></div>
    <div class="card-b value-grid">
      <div>
        <div class="h1" style="font-size:19px">What could this be worth?</div>
        <p class="p">Every number below is a hypothetical input you can change. Nothing here is a measured Valmet saving; a pilot would replace these assumptions with measurements.</p>
        ${ROI_INPUTS.map(([k, label, , min, max, step]) => `<label class="roi-in"><span>${label}</span>
          <span class="roi-row"><input type="range" min="${min}" max="${max}" step="${step}" value="${v[k]}" data-roi="${k}" aria-label="${label}"/><b data-roiv="${k}"></b></span></label>`).join("")}
      </div>
      <div>
        <div class="roi-total"><span>Potential annual value</span><b id="roiTotal"></b><small>Labour-time value. It becomes cash only if the saved time is redeployed or costs fall.</small></div>
        <div class="kv"><span>Faster information look-ups</span><span id="roiLookup"></span></div>
        <div class="kv"><span>Faster onboarding</span><span id="roiTrain"></span></div>
        <div class="kv"><span>Avoided downtime</span><span id="roiDown"></span></div>
        <div class="section"><div class="label">How it is calculated</div><div id="roiF"></div></div>
        <div class="section"><div class="label">What a pilot should measure</div>
          <div class="step"><span class="k">1</span><span>Time from work order to standing at the right asset with the right documents.</span></div>
          <div class="step"><span class="k">2</span><span>Wrong-asset or wrong-part events per 100 jobs.</span></div>
          <div class="step"><span class="k">3</span><span>First-time-fix rate and repeat visits.</span></div>
          <div class="step"><span class="k">4</span><span>Hours until a new technician works independently.</span></div>
          <div class="step"><span class="k">5</span><span>Downtime per fault, only with validated operating data.</span></div></div>
      </div>
    </div>`;
  $$("[data-roi]").forEach((el) => (el.oninput = (e) => { S.roi[e.target.dataset.roi] = +e.target.value; roiNumbers(); }));
  roiNumbers();
}
$("#value").addEventListener("click", (e) => { if (e.target.closest("[data-mode-back]")) setMode("facility"); });

// ------------------------------------------------------------------ modes
export function setMode(mode) {
  const x = ["xray", "learn", "practice"].includes(mode), prev = S.mode, md = APP.modes.get(mode);
  if (prev !== mode) { try { APP.modes.get(prev)?.exit?.(mode); } catch (e) { console.warn("mode exit", e); } }
  $("#value").classList.toggle("hidden", mode !== "value");
  $("#right").classList.toggle("hidden", mode === "value");
  $("#dock").classList.toggle("hidden", mode === "value");
  $("#minimap").classList.toggle("hidden", !(mode === "facility" || md?.minimap) || !S.minimap);
  if (mode === "value") renderValue();
  S.mode = mode;
  $$(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  controls.enabled = !x; xControls.enabled = x;
  $(".labels").innerHTML = "";
  $("#left").classList.toggle("hidden", mode === "value");
  S.onComponentPick = null;
  if (md) {
    S.xray.selected = null;
    const l = md.left?.(); if (l != null) { $("#left").classList.remove("tall"); $("#left").innerHTML = l; } else renderLeft();
    try { md.enter?.(prev); } catch (e) { console.warn("mode enter", e); }
  }
  if (mode === "facility") { S.xray.selected = null; renderLeft(); S.diag ? renderDiagnosis() : (S.robot.moving ? renderTransitCard() : renderOverviewCard()); }
  if (mode === "xray") { renderComponents(); renderPartCard(); }
  if (mode === "learn" || mode === "practice") {
    // the device model must exist before the component list or the lesson can render
    const go = () => { if (S.mode !== mode) return; renderComponents(); renderDock(); const h = xHome(); xCam.position.copy(h.pos); xControls.target.copy(h.tgt); mode === "learn" ? S.training.learn() : S.training.practice(); };
    if (!S.xClass) { card(`<div class="card-b" style="padding-top:16px"><span class="note">Loading the device model…</span></div>`); prepareXRay().then(go); } else go();
  }
  renderDock();
  emit("modeChange", mode, prev);
}
$(".modes").onclick = (e) => { const m = e.target.closest("[data-mode]")?.dataset.mode; if (m && m !== S.mode) m === "xray" ? enterXRay() : setMode(m); };

// ------------------------------------------------------------------ ask
// [copilot-ui] the conversation panel (bubbles, mode labels, follow-up chips, suggestions) lives in copilot-ui.js;
// main.js only runs the returned actions. Keep this block small: other agents edit the rest of main.js.
const pop = $("#pop"), askIn = $("#ask");
document.addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement !== askIn && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); askIn.focus(); } });
const COPILOT = createCopilot({ pop, input: askIn, api: () => api, selected: () => S.selected?.asset || S.diag?.asset,
  assetById: (id) => id && S.data?.objects.find((o) => o.asset?.asset_id === id)?.asset, run: runAskActions });
export function ask(q) { return COPILOT.ask(q); }
// [/copilot-ui]

async function runAskActions(r) {
    if (r.actions?.length && APP.xo?.open) APP.xo.close();   // the copilot drives the room: put it back first
    for (const a of r.actions || []) {
      if (a.type === "select") { if (!sceneMode()) setMode("facility"); selectAsset(a.asset_id, { fly: !r.actions.some((x) => x.type === "navigate") }); }
      if (a.type === "navigate") { S.blocks = []; S.fac.setBlocks([]); S.prevRoute = null; await dispatch(a.asset_id); }
      if (a.type === "xray") { if (S.mode === "xray" && S.xAsset?.asset_id === a.asset_id && a.focus) selectComponent(a.focus[0]); else await enterXRay(a.focus || null, a.asset_id); }
      if (a.type === "select_object") {
        if (!sceneMode()) setMode("facility");
        const best = S.data.objects.find((o) => o.id === a.object_id);
        S.matches = a.matches || [];
        S.fac.setHighlighted(S.matches, { selected: best.id, target: S.target.id });
        S.selected = best; renderAssetCard(best); renderLeft();
        const c = new THREE.Vector3(...best.center); flyTo(c.clone().add(viewOffset(c)), c);
      }
      if (a.type === "diagnose") { S.cardLock = true; if (!sceneMode()) setMode("facility"); S.diag = await api.diagnose(a.asset_id); S.tab = "overview"; $("#right").classList.remove("min"); renderDiagnosis(); }
      if (a.type === "practice") setMode("practice");
      if (a.type === "learn") setMode("learn");
      if (a.type === "knowledge") openLibrary(a.query || "");
    }
}

// ------------------------------------------------------------------ library, docs, work order, about
function sheet(head, body) {
  $("#sheet").innerHTML = `<div class="card-h"><span class="t">${head}</span><button class="link" data-close-sheet>${icon("close")}</button></div><div class="card-b">${body}</div>`;
  $("#sheet").classList.remove("hidden");
}
$("#sheet").addEventListener("click", (e) => { if (e.target.closest("[data-close-sheet]")) $("#sheet").classList.add("hidden"); });
$("#libBtn").onclick = () => openLibrary();
async function openLibrary(q = "") {
  sheet("Library", `<input class="search" id="libQ" placeholder="Search manuals, asset cards and service cases" value="${esc(q)}"/>
    <p class="note" style="margin:8px 0 4px">8 knowledge documents, 30 asset cards, 50 service cases and ${Object.values(S.kb.classes).reduce((n, c) => n + c.components.length, 0)} training notes across ${Object.keys(S.kb.classes).length} equipment types. Answers cite the document IDs.</p><div id="libRes"></div>`);
  const run = async () => {
    const res = await api.search($("#libQ").value);
    $("#libRes").innerHTML = res.map((d) => `<button class="doc" data-docid="${esc(d.id)}"><span class="k">${nice(d.kind)}</span><code>${esc(d.id)}</code><p>${esc(d.title)} · ${esc(d.text.slice(0, 120))}…</p></button>`).join("") || '<p class="note">No matches.</p>';
  };
  $("#libQ").onkeydown = (e) => e.key === "Enter" && run();
  run();
}
async function showDoc(id) {
  // [qa4] an event / work order / data-quality record of the open diagnosis opens the workbook row itself
  const rec = [...(S.diag?.events || []), ...(S.diag?.work_orders || []), ...(S.diag?.data_quality || [])].find((r) => (r.event_id || r.work_order_id || r.issue_id) === id);
  if (rec) return sheet(esc(id), `<div class="sub">Workbook record (${/^EVT/.test(id) ? "Alarms_Events" : /^WO/.test(id) ? "Maintenance_History" : "Data_Quality"}) · synthetic</div>
    <div class="section">${Object.entries(rec).filter(([k]) => k !== "synthetic_record").map(([k, v]) => kv(nice(k), esc(v))).join("")}</div>`);
  if (/^(EVT|WO|DQ)-/.test(id)) return toast(`${esc(id)} is a synthetic workbook record; open its asset's diagnosis (Evidence tab) to see it.`);
  if (id === "Telemetry_Sample_3d") return toast("Telemetry_Sample_3d is the 30-minute synthetic telemetry stream in the builder pack.");
  try {
    const d = await api.doc(id);
    sheet(esc(d.id), `<div class="h1" style="font-size:17px">${esc(d.title)}</div><div class="sub">${nice(d.kind)} · ${esc(d.source)}</div>
      <p class="p" style="margin-top:12px;color:var(--text)">${esc(d.text)}</p>${d.kind === "training_kb" ? '<p class="note">General training knowledge for the illustrative model, not an OEM manual.</p>' : ""}`);
  } catch { toast(`${esc(id)} is a workbook record.`); }
}
export function setFocus(on) { document.body.classList.toggle("focus", on); }
$("#focusExit").onclick = () => setFocus(false);
$("#tourBtn").onclick = () => startTour(TOUR_API);
document.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === "f" || e.key === "F") setFocus(!document.body.classList.contains("focus"));
  if (e.key === "Escape") { setFocus(false); $("#sheet").classList.add("hidden"); pop.classList.add("hidden"); }
  if (e.key === " " && S.curve && sceneMode()) { e.preventDefault(); togglePlay(1); }
});
document.addEventListener("click", (e) => {
  const mn = e.target.closest("[data-min-card]"); if (mn) { mn.closest(".card").classList.toggle("min"); return; }
  if (e.target.closest("[data-tour]")) { $(".toast")?.remove(); return startTour(TOUR_API); }
  const xc = e.target.closest("#right [data-xclass]"); if (xc) return openClass(xc.dataset.xclass);
  const c = e.target.closest(".cite, [data-docid]"); if (c) showDoc(c.dataset.doc || c.dataset.docid);
  const x = e.target.closest("[data-xcomp]"); if (x) enterXRay(x.dataset.xcomp.split(","), S.diag?.asset?.asset_id);
  const xp = e.target.closest("[data-xpart]");
  if (xp && S.selected?.asset) { if (sceneMode() && APP.xo) APP.xo.show(S.selected.asset.asset_id, { focus: xp.dataset.xpart }); else enterXRay([xp.dataset.xpart], S.selected.asset.asset_id); }
});
async function showWorkOrder(id) {
  const w = await api.draftWO(id);
  sheet("Work order draft", `<div class="h1" style="font-size:17px">${w.tag} · ${esc(nice(w.action))}</div><div class="sub">${esc(w.status)} · no control actions</div>
    <div class="section">${kv("Problem", esc(w.problem))}${kv("Type", nice(w.maintenance_type))}${kv("Priority", nice(w.priority))}${kv("Role", nice(w.role))}${kv("Confidence", Math.round(w.confidence * 100) + "%")}</div>
    <div class="section"><div class="label">Evidence</div><div class="row">${w.evidence_ids.map((i) => `<span class="cite" data-doc="${i}">${i}</span>`).join("")}</div></div>
    <div class="section"><div class="label">Before any work</div>${w.safety_prerequisites.map((s) => `<label class="gate"><input type="checkbox"/> ${esc(s)}</label>`).join("")}</div>`);
}
function showAbout() {
  const i = S.data.integrity, n = S.data.navigation;
  const row = (what, is, isNot) => `<div class="truth"><b>${what}</b><span>${is}</span><small>${isNot}</small></div>`;
  sheet("About this prototype", `<div class="h1" style="font-size:17px">Industrial X-Ray · pre-visit copilot</div>
    <p class="p">Explore the site. Understand the equipment. Plan the maintenance. Practise the task. Get expert support — before stepping onto the factory floor. Valmet × Since AI 2026 challenge entry.</p>
    ${kv("Scan", `${i.declared_vertex_count.toLocaleString()} splats · ${Math.round(i.contiguous_valid_fraction * 100)}% valid`)}${kv("Segmented object candidates", S.data.stats.n_objects)}${kv("Workbook assets linked", S.data.n_bound_assets)}
    ${kv("Drivable floor", `${n.walkable_area_m2} m²`)}${kv("Robot radius", `${n.robot_radius_m} m`)}${kv("Backend", api.isStatic ? "Static export (hosted): diagnoses pre-generated" : "Live Python API")}
    <div class="section"><div class="label">What this is — and what it is not</div>
      ${row("Objects", `${S.data.stats.n_objects} segmented candidates, each with a label and confidence.`, "Not 676 verified physical objects; see Scene understanding on the rail.")}
      ${row("Asset links", "Procedural matching to compatible objects, with a stated confidence.", "Not confirmed on site.")}
      ${row("Asset data", "Synthetic workbook from the challenge (telemetry, alarms, work orders, cases).", "Not live plant data.")}
      ${row("Diagnosis", api.isStatic ? "Generated by the LLM in advance, every citation checked." : api.llmDown ? "Live AI unavailable: the diagnosis pre-generated in advance is shown, every citation checked." : "Generated live by the LLM, every citation checked.", api.isStatic ? "Free questions get pre-generated answers or document search here, not live AI." : "Decision support only.")}
      ${row("X-Ray models", "Procedural teaching models per equipment type.", "Not manufacturer drawings, not reconstructed from the scan.")}
      ${row("Planning", "Approximate collision and clearance checks on boxes and the floor grid.", "Not a certified engineering clearance.")}
      ${row("Remote support", "Asynchronous hand-off: the context travels in a link or package.", "No live multi-user session in this prototype.")}
      ${row("Control", "Read-only: highlights, notes, plans and draft work orders.", "No connection to actuators, PLCs or plant controls.")}
      ${row("Value", "Calculator with editable, hypothetical inputs.", "No measured savings.")}</div>
    <div class="section"><div class="label">For engineers</div>
      <p class="p">PLY integrity check → canonical Y-up frame → RANSAC structure planes + recursive DBSCAN + gravity-aligned OBBs → vision-model labels with confidence and a review layer (team visual check, not field-verified) → class-aware asset mapping → 2.5D heightfield, clearance-aware A* with line-of-sight smoothing and validation → evidence engine (telemetry z-scores, events, work orders, cases) → LLM narration whose citations are checked against the evidence. The same code runs as a FastAPI service or as a static export with a JS port of the planner.</p></div>
    <div class="section"><div class="label">Keys</div>${kv("Ask", '<span class="kbd">/</span>')}${kv("Play / pause the robot", '<span class="kbd">Space</span>')}${kv("Focus (hide panels)", '<span class="kbd">F</span>')}${kv("Close panels", '<span class="kbd">Esc</span>')}${kv("Walk · turn · look", '<span class="kbd">W A S D</span> / arrows · <span class="kbd">Q E</span> · <span class="kbd">T G</span>')}${kv("Zoom · reset view", '<span class="kbd">+ −</span> · <span class="kbd">Home</span>')}${kv("Orbit · pan · zoom (mouse)", "Drag · right-drag · scroll")}${kv("No mouse?", "Use the move pad at the bottom left")}</div>
    <div class="section"><a class="link" href="#plan" onclick="setTimeout(()=>location.reload(),0)">Open the 2D floor plan view (works without 3D graphics) ${icon("arrow")}</a></div>`);
}


// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let down = null;
canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
// dragging or scrolling the view in Robot POV hands the camera to the user (Free); a plain click still picks
const leavePov = () => { if (S.cam === "pov" && sceneMode() && controls.enabled) { setCamera("free"); renderDock(); } };
canvas.addEventListener("pointermove", (e) => { if (S.cam === "pov" && down && e.buttons && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) leavePov(); });
canvas.addEventListener("wheel", leavePov, { passive: true });
canvas.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  if (APP.xo?.open) return;                 // the room is inert behind the X-Ray panel (its state is restored on close)
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (sceneMode()) {
    ray.setFromCamera(ndc, camera);
    if (APP.modes.get(S.mode)?.onPick?.(ray.ray, e)) return;
    const id = S.fac.pick(ray.ray);
    if (id) selectObject(S.data.objects.find((x) => x.id === id));
  } else {
    ray.setFromCamera(ndc, xCam);
    const hits = ray.intersectObjects(S.xray.pickables(), false);
    if (hits.length) selectComponent(hits[0].object.userData.componentId);
  }
});

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
const QA = new URLSearchParams(location.search).has("qa");
let lastQA = -1e9;
// ?capture: frames are rendered only on request with a fixed time step (window.__step), so a video can be recorded
// frame by frame on machines without a GPU (scripts/record-demo.cjs).
const CAPTURE = new URLSearchParams(location.search).has("capture");
let capT = 0;
if (CAPTURE) window.__step = (dt = 1 / 12) => { capT += dt; frame(dt, capT); };
else renderer.setAnimationLoop(() => {
  if (QA) { const now = performance.now(); if (now - lastQA < 2500) return; lastQA = now; }
  frame(QA ? 0.05 : Math.min(clock.getDelta(), 0.05), clock.elapsedTime);
});
function frame(dt, t) {
  updateTween(dt);
  if (!S.fac) return;
  if (!["xray", "learn", "practice"].includes(S.mode)) {
    updateRobot(dt, t);
    const pov = S.cam === "pov" && sceneMode();
    if (pov) povCamera(dt);
    povRobotVisibility(pov);
    povHud(dt, pov && !APP.xo?.open);
    emit("frame", dt, t);
    drawMinimap(dt);
    if (!S.robot.moving) S.fac.pulse(t, S.target.id);
    controls.update();
    renderer.render(fac, camera);
    labels.render(fac, camera);
    if (APP.xo?.open) APP.xo.render(dt, t);       // in-scene X-Ray panel: drawn only while it is open
  } else {
    povRobotVisibility(false); povHud(dt, false);
    S.xray.update(dt, t);
    xControls.update();
    renderer.render(S.xray.scene, xCam);
    labels.render(S.xray.scene, xCam);
  }
}

const TOUR_API = { S, $, X: APP, ask, diagnose: async (id) => { S.cardLock = true; S.diag = await api.diagnose(id); S.tab = "overview"; $("#right").classList.remove("min"); renderDiagnosis(); }, setMode, setCamera: (m) => { setCamera(m); renderDock(); }, pause: () => { S.robot.moving = false; renderDock(); }, dispatch: (id) => restart(id), blockAisle, enterXRay, openClass, flyHome: () => flyTo(S.home.pos, S.home.tgt), selectAsset, toast, renderDock,
  setFrames: (f) => { S.frames = f; S.fac.setShowMode(f); renderDock(); }, setRate: (r) => { S.robot.rate = r; renderDock(); } };
window.__xr = APP;
window.__app = S; window.__renderer = renderer; window.__decodeXq16 = decodeXq16;
Object.assign(window, { __dispatch: dispatch, __enterXRay: enterXRay, __setMode: setMode, __ask: ask, __block: blockAisle, __select: selectAsset });
boot();
