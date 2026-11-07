// Industrial X-Ray — app controller.
// Journey: facility → ask / dispatch → route + proximity → arrival diagnosis → X-Ray → Learn / Practice.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { api, connect } from "./api.js";
import { Facility } from "./facility.js";
import { XRay } from "./xray.js";
import { initTraining } from "./training.js";
import { icon } from "./icons.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nice = (s) => { const t = String(s ?? "").replaceAll("_", " ").toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
export const cites = (text) => esc(text).replace(/\[([^\[\]]{2,80})\]/g, (_, ids) =>
  ids.split(",").map((i) => `<span class="cite" data-doc="${esc(i.trim())}">${esc(i.trim())}</span>`).join(""));
const pad = (n) => String(n).padStart(2, "0");

// ------------------------------------------------------------------ skeleton
$("#app").innerHTML = `
<canvas class="gl"></canvas>
<div class="vignette"></div>
<div class="labels"></div>
<div class="fade"></div>
<div class="wordmark"><div class="eyebrow">Industrial X-Ray</div><div class="name">Equipment Room</div></div>
<nav class="modes" aria-label="Mode">
  <button data-mode="facility" class="on">Facility</button><button data-mode="xray">X-Ray</button>
  <button data-mode="learn">Learn</button><button data-mode="practice">Practice</button>
</nav>
<div class="topright">
  <div class="ask">
    <label class="field">${icon("search")}<input id="ask" placeholder="Ask about the plant" autocomplete="off" aria-label="Ask the copilot"/><span class="kbd">/</span></label>
    <div class="pop hidden" id="pop"></div>
  </div>
  <button class="iconbtn" id="libBtn" title="Library">${icon("book")}</button>
</div>
<aside class="card left" id="left"></aside>
<aside class="card right" id="right"></aside>
<div class="card sheet hidden" id="sheet"></div>
<div class="dock" id="dock"></div>
<div class="rail" id="rail">
  <button data-rail="in" title="Zoom in">${icon("plus")}</button><button data-rail="out" title="Zoom out">${icon("minus")}</button>
  <button data-rail="reset" title="Reset view">${icon("reset")}</button><hr>
  <button data-rail="full" title="Full screen">${icon("full")}</button><button data-rail="help" title="About this demo">${icon("help")}</button>
</div>
<div class="loading" id="loading"><div class="box">Loading the scan<div class="bar"><i></i></div><div id="loadPct" style="margin-top:10px"></div></div></div>`;

// ------------------------------------------------------------------ renderer, scenes, cameras
const canvas = $("canvas.gl");
// Splats are already soft-edged: MSAA buys nothing but costs fill-rate. Cap the pixel ratio for steady frame times.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const labels = new CSS2DRenderer({ element: $(".labels") });
labels.setSize(innerWidth, innerHeight);

const fac = new THREE.Scene();
fac.background = new THREE.Color(0x0a0b0d);
fac.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(2, 4, 1); fac.add(sun);
fac.add(new SparkRenderer({ renderer }));
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
const XHOME = { pos: new THREE.Vector3(2.4, 2.1, 4.4), tgt: new THREE.Vector3(-0.1, 0.45, 0) };

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
  for (const c of [camera, xCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
});

// ------------------------------------------------------------------ state
export const S = {
  mode: "facility", data: null, fac: null, xray: null, kb: null, home: null,
  selected: null, target: null, diag: null, curve: null, route: null, prevRoute: null,
  robot: { moving: false, s: 0, speed: 0.45, len: 0 }, blocks: [], seen: new Map(),
  follow: true, frames: "all", grid: false, tab: "overview", xSelected: null, xTab: "overview",
};

// ------------------------------------------------------------------ boot
async function boot() {
  await connect();
  const [data, kb, manifest] = await Promise.all([api.scene(), api.xrayModel(), api.manifest()]);
  S.data = data; S.kb = kb;
  S.fac = new Facility(fac, data);
  S.xray = new XRay(kb, renderer);
  S.target = data.objects.find((o) => o.id === data.target_object_id);
  S.home = homeView();
  camera.position.copy(S.home.pos); controls.target.copy(S.home.tgt);
  xCam.position.copy(XHOME.pos); xControls.target.copy(XHOME.tgt);
  initTraining(S, { $, esc, cites, setMode, card: (h) => ($("#right").innerHTML = h), xCam, xControls, toast, icon, focusPart });
  renderLeft(); renderOverviewCard(); renderDock();
  try {
    await S.fac.loadSplats(manifest.splat_urls, (p) => ($("#loadPct").textContent = `${Math.round(p * 100)}%`));
  } catch (e) { console.warn(e); }
  $("#loading").style.opacity = 0;
  setTimeout(() => $("#loading")?.remove(), 700);
}

function homeView() {
  // Corner-to-corner view under the ceiling: from the room corner nearest the robot, looking across the room.
  const b = S.data.bounds, s = S.data.start;
  const x = s[0] < (b.min[0] + b.max[0]) / 2 ? b.min[0] + 0.9 : b.max[0] - 0.9;
  const z = s[2] < (b.min[2] + b.max[2]) / 2 ? b.min[2] + 0.9 : b.max[2] - 0.9;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  return { pos: new THREE.Vector3(x, 1.85, z), tgt: new THREE.Vector3(cx + (cx - x) * 0.25, 0.2, cz + (cz - z) * 0.25) };
}

// ------------------------------------------------------------------ left card: assets (facility) / components (x-ray)
function renderLeft() {
  if (["xray", "learn", "practice"].includes(S.mode)) return renderComponents();
  const assets = S.data.objects.filter((o) => o.asset).map((o) => o.asset);
  const rank = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
  assets.sort((a, b) => (b.is_target - a.is_target) || rank[a.condition_state] - rank[b.condition_state] || a.health_score - b.health_score);
  const nav = S.data.navigation;
  $("#left").innerHTML = `
    <div class="card-h"><span class="t">Assets by priority</span><span class="note">${assets.length}</span></div>
    <div class="card-b" style="padding:0 8px 8px">${assets.map((a, i) => `
      <button class="list-row ${S.selected?.asset?.asset_id === a.asset_id ? "on" : ""}" data-asset="${a.asset_id}">
        <span class="n">${pad(i + 1)}</span>
        <span class="nm"><b>${a.tag}</b><small>${nice(a.asset_class)} · ${a.is_target ? "Simulated fault" : nice(a.issue_code)}</small></span>
        <span class="health s-${a.condition_state}">${a.health_score}</span></button>`).join("")}</div>
    <div class="card-f"><span><b>${S.data.stats.n_objects}</b> objects</span><span><b>${nav.walkable_area_m2}</b> m² drivable</span><span><b>${(S.data.integrity.declared_vertex_count / 1e6).toFixed(1)}M</b> splats</span></div>`;
  $("#left").onclick = (e) => { const r = e.target.closest("[data-asset]"); if (r) selectAsset(r.dataset.asset, { fly: true }); };
}

function renderComponents() {
  const lead = new Set(S.diag?.hypotheses?.[0]?.components || []);
  const alt = new Set((S.diag?.hypotheses || []).slice(1).flatMap((h) => h.components));
  $("#left").innerHTML = `
    <div class="card-h"><span class="t">Components</span><button class="link" data-close-x title="Back to facility">${icon("close")}</button></div>
    <div class="card-b" style="padding:0 8px 8px">${S.xray.order().map((id, i) => {
      const c = S.kb.components.find((x) => x.id === id);
      return `<button class="list-row ${S.xSelected === id ? "on" : ""}" data-comp="${id}"><span class="n">${pad(i + 1)}</span>
        <span class="nm"><b>${esc(c.name)}</b></span>${lead.has(id) ? '<span class="pill red">Suspected</span>' : alt.has(id) ? '<span class="pill amber">Alternative</span>' : S.xSelected === id ? icon("chev") : ""}</button>`;
    }).join("")}</div>`;
  $("#left").onclick = (e) => {
    if (e.target.closest("[data-close-x]")) return setMode("facility");
    const r = e.target.closest("[data-comp]"); if (r) selectComponent(r.dataset.comp);
  };
}

// ------------------------------------------------------------------ right card
function card(html) { $("#right").innerHTML = html; $("#right").scrollTop = 0; }
function header(eyebrow, title, tags = "", closable = false) {
  return `<div class="card-h" style="padding-bottom:0"><span class="eyebrow-row">${eyebrow}${tags}</span>${closable ? `<button class="link" data-close-card title="Close">${icon("close")}</button>` : ""}</div>
  <div class="card-b"><div class="h1">${title}</div>`;
}
const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;

function renderOverviewCard() {
  const t = S.target.asset;
  card(`${header("Simulated fault", t.tag, '<span class="tag syn">Synthetic</span>')}
    <div class="sub">${nice(t.asset_class)} · ${esc(t.area_name)}</div>
    <p class="p" style="margin-top:12px">${esc(t.issue_summary)}. It has the highest maintenance priority in the builder pack, so the inspection robot is sent to it.</p>
    ${kv("Condition", `<span class="status s-${t.condition_state}">${nice(t.condition_state)}</span>`)}${kv("Health", t.health_score)}${kv("Criticality", esc(t.criticality))}
    ${kv("Mapped to", `${S.target.label} · ${Math.round(t.mapping_confidence * 100)}%`)}
    <div class="section stack"><button class="btn primary block" data-act="dispatch">${icon("play")}Send inspection robot</button>
      <button class="btn block" data-act="locate">${icon("target")}Show in scan</button></div>
    <div class="section"><div class="label">How it works</div>
      <div class="step"><span class="k">1</span><span>The scan is split into ${S.data.stats.n_objects} objects, each framed and named with a confidence.</span></div>
      <div class="step"><span class="k">2</span><span>Workbook assets are matched to compatible objects.</span></div>
      <div class="step"><span class="k">3</span><span>The robot plans a collision-free route on the drivable floor and reads every asset within 1.2 m.</span></div>
      <div class="step"><span class="k">4</span><span>On arrival, the copilot explains the fault with cited evidence.</span></div></div>
  </div>`);
}

function renderTransitCard() {
  const assets = [...S.seen.keys()].map((id) => S.data.objects.find((o) => o.id === id)).filter((o) => o?.asset);
  const others = S.seen.size - assets.length;
  card(`${header("En route", S.navObject.asset.tag, "")}
    <div class="sub">${S.route.length_m} m · ${S.route.validation.collision_free ? "collision-free" : "check route"} · min clearance ${S.route.validation.min_clearance_m} m</div>
    <div class="section"><div class="label"><span>Assets read along the way</span><span>${assets.length}</span></div>
      <div class="feed">${assets.map((o) => `<button class="list-row" data-obj="${o.id}"><span class="dot s-${o.asset.condition_state}"></span>
        <span class="nm"><b style="font-family:var(--mono)">${o.asset.tag}</b><small>${nice(o.asset.condition_state)} · ${nice(o.asset.issue_code)}</small></span><span class="health s-${o.asset.condition_state}">${o.asset.health_score}</span></button>`).join("") || '<div class="note">Nothing in range yet.</div>'}</div></div>
    <div class="section note"><span id="otherCount">${S.seen.size}</span> objects framed within 1.2 m so far.</div></div>`);
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
    <div class="section">${kv("Health", a.health_score)}${kv("Criticality", esc(a.criticality))}${kv("Area", esc(a.area_name))}</div>
    <div class="section"><div class="label">3D identity</div>${identityRows(o)}</div>
    <div class="section stack"><button class="btn primary block" data-act="dispatch-sel">${icon("play")}Send robot here</button>
      <button class="btn block" data-act="diagnose-sel">${icon("spark")}Diagnose now</button></div></div>`);
}

function identityRows(o) {
  return `${kv("Label", `${esc(o.label)} · ${Math.round(o.confidence * 100)}%`)}${kv("Source", { "vlm+geometry": "Vision model + geometry", "human-verified": "Human verified", "geometry-heuristic": "Geometry rules" }[o.label_source] || o.label_source)}
    ${kv("Frame", `${o.size.map((v) => v.toFixed(2)).join(" × ")} m`)}${o.asset ? kv("Mapping", `${Math.round(o.asset.mapping_confidence * 100)}%`) : ""}
    ${o.review_note ? `<p class="note" style="margin-top:8px">${esc(o.review_note)}</p>` : o.vlm_rationale ? `<p class="note" style="margin-top:8px">${esc(o.vlm_rationale)}</p>` : ""}`;
}

function sparkline(series, w = 88, h = 26, hot = false) {
  if (!series?.length) return "";
  const v = series.map((s) => s[1]), lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * w, h - 3 - ((y - lo) / r) * (h - 6)]);
  const d = pts.map((p) => p.join(",")).join(" ");
  const [ex, ey] = pts.at(-1);
  const col = hot ? "var(--bad)" : "var(--text-2)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${col}" stroke-width="1.25" points="${d}"/><circle cx="${ex}" cy="${ey}" r="2" fill="${col}"/></svg>`;
}

function narrative(text) {
  // Render the copilot's labelled lines (Observation / Evidence / Hypothesis / Uncertainty / Next safe step) as blocks.
  const parts = String(text).split(/\n+|(?=(?:Observation|Evidence|Hypothesis|Uncertainty|Next safe step):)/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => {
    const m = p.match(/^(Observation|Evidence|Hypothesis|Uncertainty|Next safe step):\s*(.*)$/s);
    return m ? `<div class="nblock"><div class="label">${m[1]}</div><div class="narr">${cites(m[2])}</div></div>` : `<div class="narr">${cites(p)}</div>`;
  }).join("");
}

function renderDiagnosis() {
  const d = S.diag, a = d.asset, c = d.confidence;
  const tabs = ["overview", "evidence", "sources"];
  const body = {
    overview: `${narrative(d.narrative.text)}
      <p class="note" style="margin-top:8px">${d.narrative.invalid_citations?.length ? `${d.narrative.invalid_citations.length} unsupported citation(s) removed.` : "Every citation was checked against the evidence."} ${esc(d.narrative.mode.startsWith("llm") ? "Written by " + d.narrative.mode.slice(4) : "Template wording")}.</p>
      <div class="section"><div class="label"><span>Confidence</span><span style="color:var(--text)">${Math.round(c.overall * 100)}%</span></div>
        <div class="meter"><i style="width:${c.overall * 100}%"></i></div>
        ${kv("Model confidence", c.model_confidence)}${kv("Evidence support", c.evidence_support)}${kv("Data-quality penalty", "−" + c.data_quality_penalty)}${kv("3D mapping", c.mapping_confidence)}</div>
      <div class="section"><div class="label">Hypotheses</div>${d.hypotheses.map((h) => `<div class="hyp"><div>${esc(h.hypothesis)}<small>${h.rank === 1 ? "Leading" : "Alternative, not excluded"}</small></div>${h.components.length ? `<button class="link" data-xcomp="${h.components.join(",")}">X-Ray ${icon("chev")}</button>` : ""}</div>`).join("")}</div>
      <div class="section"><div class="label">Next safe steps</div>${d.next_steps.map((s, i) => `<div class="step"><span class="k">${i + 1}</span><span>${esc(s.step)} <span class="cite" data-doc="${s.source}">${s.source}</span></span></div>`).join("")}</div>`,
    evidence: `<div class="label note" style="margin-bottom:4px">Last 12 h against own baseline and class peers</div>
      ${d.telemetry.signals.map((s) => { const z = s.z_vs_peers ?? s.z_vs_own_baseline; const hot = s.abnormal || Math.abs(z) >= 2;
        return `<div class="sig"><div><b>${nice(s.signal.replace(/_(mm_s|c|a|pct|bar|rpm)$/, ""))}</b><small>${s.recent_mean} ${s.unit} · peers ${s.peer_mean ?? "–"} · <span class="${hot ? "flag" : ""}">z ${z}</span></small></div>${sparkline(s.series, 88, 26, hot)}</div>`; }).join("")}
      <div class="section"><div class="label">Alarms and events</div>${d.events.slice(0, 5).map((e) => `<div class="ev"><code>${e.event_id}</code><span>${nice(e.event_type)} · ${e.event_code}</span><small>${e.timestamp} · ${e.severity}</small></div>`).join("") || '<div class="note">None</div>'}</div>
      <div class="section"><div class="label">Work orders</div>${d.work_orders.slice(0, 4).map((w) => `<div class="ev"><code>${w.work_order_id}</code><span>${esc(nice(w.action))}</span><small>${(w.opened_at || "").slice(0, 10)} · ${nice(w.result)}</small></div>`).join("") || '<div class="note">None</div>'}</div>
      <div class="section"><div class="label">Data quality</div><div class="row">${d.data_quality.map((q) => `<span class="pill">${q.issue_id} · ${nice(q.issue_type)}</span>`).join("") || '<span class="note">No issues</span>'}</div></div>`,
    sources: `${d.documents.map((x) => `<button class="doc" data-docid="${x.id}"><span class="k">${nice(x.kind)}</span><code>${x.id}</code><p>${esc(x.title)}</p></button>`).join("")}
      ${d.similar_cases.slice(0, 3).map((k) => `<button class="doc" data-docid="${k.case_id}"><span class="k">Service case</span><code>${k.case_id}</code><p>${esc(k.historical_interpretation)}</p></button>`).join("")}`,
  };
  card(`${header(nice(a.asset_class), `${a.tag} diagnosis`, '<span class="tag syn">Synthetic</span>', true)}
    <div class="sub"><span class="status s-${a.condition_state}">${nice(a.condition_state)}</span> · health ${a.health_score} · ${esc(a.criticality)}</div>
    <div class="tabs">${tabs.map((t) => `<button data-tab="${t}" class="${S.tab === t ? "on" : ""}">${nice(t)}</button>`).join("")}</div>
    ${body[S.tab]}
    <div class="section stack"><button class="btn primary block" data-act="xray">${icon("layers")}Open X-Ray view</button>
      <button class="btn block" data-act="wo">${icon("doc")}Draft work order</button></div>
    <p class="note" style="margin-top:10px;text-align:center">Decision support only. No control actions.</p></div>`);
}

$("#right").addEventListener("click", async (e) => {
  const t = e.target;
  const tab = t.closest("[data-tab]"); if (tab) { S.tab = tab.dataset.tab; return renderDiagnosis(); }
  const xt = t.closest("[data-xtab]"); if (xt) { S.xTab = xt.dataset.xtab; return renderPartCard(); }
  if (t.closest("[data-close-card]")) { S.selected = null; S.fac.setHighlighted([], { target: S.target.id }); renderLeft(); return S.diag ? renderDiagnosis() : renderOverviewCard(); }
  const row = t.closest("[data-obj]"); if (row) return selectObject(S.data.objects.find((o) => o.id === row.dataset.obj));
  const act = t.closest("[data-act]")?.dataset.act;
  if (act === "dispatch") dispatch(S.target.asset.asset_id);
  if (act === "locate") selectObject(S.target, { fly: true });
  if (act === "dispatch-sel") dispatch(S.selected.asset.asset_id);
  if (act === "diagnose-sel") { S.diag = await api.diagnose(S.selected.asset.asset_id); S.tab = "overview"; renderDiagnosis(); }
  if (act === "xray") enterXRay();
  if (act === "wo") showWorkOrder(S.diag.asset.asset_id);
  if (act === "isolate") { const on = S.xray.hidden.size === 0; S.xray.isolate(on ? S.xSelected : null); renderPartCard(); }
  if (act === "askpart") askPart();
});

// ------------------------------------------------------------------ selection
function selectAsset(id, opts) { const o = S.data.objects.find((x) => x.asset?.asset_id === id); if (o) selectObject(o, opts); }
function selectObject(o, { fly = false } = {}) {
  if (!o) return;
  S.selected = o;
  S.fac.setHighlighted([...S.seen.keys()], { selected: o.id, target: S.target.id });
  renderLeft();
  if (!S.robot.moving) renderAssetCard(o);
  if (fly) { const c = new THREE.Vector3(...o.center); flyTo(c.clone().add(viewOffset(c)), c); }
}
function viewOffset(c) {
  // stand on the walkable side: toward the room centre
  const centre = new THREE.Vector3((S.data.bounds.min[0] + S.data.bounds.max[0]) / 2, 0, (S.data.bounds.min[2] + S.data.bounds.max[2]) / 2);
  const d = centre.sub(c).setY(0).normalize();
  return new THREE.Vector3(d.x * 1.9, 1.15, d.z * 1.9);
}

// ------------------------------------------------------------------ dock
function renderDock() {
  const x = ["xray", "learn", "practice"].includes(S.mode);
  if (x) {
    const pct = Math.round(S.xray.target * 100);
    $("#dock").innerHTML = `
      <div class="grp"><button class="tool" data-d="assemble">${icon("cube")}Assemble</button></div>
      <div class="grp slider"><div class="top"><span>Explode</span><span id="xpct">${pct}%</span></div><input type="range" id="explode" min="0" max="100" value="${pct}" aria-label="Explode"/></div>
      <div class="grp"><button class="tool" data-d="all">${icon("expand")}All parts</button><button class="tool ${S.xray.ghost ? "on" : ""}" data-d="ghost"><span class="switch"></span>See-through</button><button class="tool ${S.xray.labelsOn ? "on" : ""}" data-d="labels"><span class="switch"></span>Labels</button></div>`;
    $("#explode").oninput = (e) => { S.xray.setExplode(e.target.value / 100); $("#xpct").textContent = `${e.target.value}%`; };
    return;
  }
  const r = S.route;
  $("#dock").innerHTML = `
    <div class="grp"><button class="tool" data-d="dispatch" ${S.robot.moving ? "disabled" : ""}>${icon("play")}${S.route && !S.robot.moving ? "Restart" : "Dispatch"}</button>
      <button class="tool" data-d="block" ${S.robot.moving ? "" : "disabled"}>${icon("barrier")}Block aisle</button></div>
    <div class="grp routeinfo"><div class="top"><span>Route</span><b id="rLen">${r ? r.length_m + " m" : "Not planned"}</b></div><div class="bar"><i id="rBar"></i></div>
      <small id="rMeta">${r ? `A* ${r.compute_ms} ms · min clearance ${r.validation.min_clearance_m} m · ${r.validation.collisions} collisions` : `Robot radius ${S.data.navigation.robot_radius_m} m · step limit ${S.data.navigation.max_step_m} m`}</small></div>
    <div class="grp"><div class="seg" role="group" aria-label="Frames">${["all", "assets", "none"].map((v) => `<button data-frames="${v}" class="${S.frames === v ? "on" : ""}">${{ all: "All frames", assets: "Assets", none: "Off" }[v]}</button>`).join("")}</div></div>
    <div class="grp"><button class="tool ${S.grid ? "on" : ""}" data-d="grid"><span class="switch"></span>Floor map</button><button class="tool ${S.follow ? "on" : ""}" data-d="follow"><span class="switch"></span>Follow</button></div>`;
}
$("#dock").addEventListener("click", async (e) => {
  const f = e.target.closest("[data-frames]");
  if (f) { S.frames = f.dataset.frames; S.fac.setShowMode(S.frames); return renderDock(); }
  const d = e.target.closest("[data-d]")?.dataset.d;
  if (!d) return;
  if (d === "dispatch") { S.blocks = []; S.fac.setBlocks([]); S.prevRoute = null; S.fac.robot.position.set(...S.data.start); dispatch((S.selected?.asset || S.target.asset).asset_id); }
  if (d === "block") blockAisle();
  if (d === "grid") { S.grid = !S.grid; if (S.grid) S.fac.showGrid(await api.grid()); S.fac.gridGroup.visible = S.grid; renderDock(); }
  if (d === "follow") { S.follow = !S.follow; renderDock(); }
  if (d === "assemble") { S.xray.setExplode(0); renderDock(); }
  if (d === "all") { S.xray.isolate(null); flyTo(XHOME.pos, XHOME.tgt, 1, xCam, xControls); if (S.xSelected) renderPartCard(); }
  if (d === "ghost") { S.xray.setGhost(!S.xray.ghost); renderDock(); }
  if (d === "labels") { S.xray.setLabels(!S.xray.labelsOn); renderDock(); }
});

// ------------------------------------------------------------------ rail
$("#rail").addEventListener("click", (e) => {
  const r = e.target.closest("[data-rail]")?.dataset.rail;
  const x = S.mode !== "facility", cam = x ? xCam : camera, ctl = x ? xControls : controls;
  if (r === "in" || r === "out") { const v = cam.position.clone().sub(ctl.target).multiplyScalar(r === "in" ? 0.8 : 1.25); flyTo(ctl.target.clone().add(v), ctl.target.clone(), 0.4, cam, ctl); }
  if (r === "reset") x ? flyTo(XHOME.pos, XHOME.tgt, 1, xCam, xControls) : flyTo(S.home.pos, S.home.tgt);
  if (r === "full") document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.().catch(() => {});
  if (r === "help") showAbout();
});

// ------------------------------------------------------------------ navigation + robot
async function applyRoute(res, { keepSpeed = true } = {}) {
  S.route = res;
  S.fac.setWalkable(await api.grid());      // grid reflects the blocks used for this plan
  // start the drawn/driven curve exactly where the robot is (the plan starts at the centre of its grid cell,
  // a few cm away), so a reroute never makes the robot jump
  const r = S.fac.robot.position, w0 = res.waypoints[0];
  const pts = Math.hypot(r.x - w0[0], r.z - w0[2]) > 0.005 ? [[r.x, 0, r.z], ...res.waypoints] : res.waypoints;
  S.curve = S.fac.drawRoute(pts);
  if (S.prevRoute) S.fac.ghostRoute(S.prevRoute);
  Object.assign(S.robot, { len: S.curve.getLength(), s: 0, moving: true, v: keepSpeed ? S.robot.v : 0 });
  renderDock();
}

async function dispatch(assetId, { start = null, quiet = false } = {}) {
  const o = S.data.objects.find((x) => x.asset?.asset_id === assetId);
  if (!o) return null;
  if (S.mode !== "facility") setMode("facility");
  S.navObject = o;
  const p = S.fac.robot.position;
  const res = await api.plan({ object_id: o.id, start: start || [p.x, p.z], blocks: S.blocks });
  if (!res.ok) { toast(esc(res.reason)); return null; }
  await applyRoute(res, { keepSpeed: quiet });
  S.seen.clear();
  S.diag = null;
  S.diagPromise = api.diagnose(assetId);
  if (!quiet) toast(`Route planned: <b>${res.length_m} m</b> in ${res.compute_ms} ms. Collision-free, minimum clearance ${res.validation.min_clearance_m} m.`);
  renderDock(); renderTransitCard();
  return res;
}

async function blockAisle() {
  if (!S.curve || !S.robot.moving) return;
  // Drop the barrier on the route ahead. If that spot cuts the only corridor, try further along, so the demo
  // shows a real detour; if no placement leaves a safe route, the robot stops instead of driving through.
  const prev = S.route, prevCurve = S.curve, prevLeft = S.route.length_m - S.robot.s;
  const p0 = S.fac.robot.position, start = [p0.x, p0.z];
  for (const ahead of [0.9, 1.5, 2.2, 3.0, 3.8, 4.6]) {
    const s = S.robot.s + ahead;
    if (s > S.robot.len - 0.6) break;
    const u = s / S.robot.len, p = prevCurve.getPointAt(u), tan = prevCurve.getTangentAt(u);
    const b = { x: +p.x.toFixed(2), z: +p.z.toFixed(2), w: 0.9, d: 0.35, yaw: Math.atan2(tan.z, tan.x) + Math.PI / 2 };
    const res = await api.plan({ object_id: S.navObject.id, start, blocks: [...S.blocks, b] });
    if (!res.ok) continue;
    S.blocks.push(b);
    S.fac.setBlocks(S.blocks);
    S.prevRoute = prev.waypoints;
    await applyRoute(res);
    toast(`Aisle blocked. New route in <b>${res.compute_ms} ms</b>: ${res.length_m} m instead of ${prevLeft.toFixed(1)} m, still collision-free.`, 6000);
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
  if (!R.moving || !S.curve) return;
  // trapezoidal speed profile: accelerate away, cruise, brake into the goal
  const remain = R.len - R.s;
  R.v = Math.min(CRUISE, (R.v ?? 0) + ACCEL * dt, Math.sqrt(2 * ACCEL * Math.max(remain, 0)) + 0.04);
  R.s = Math.min(R.len, R.s + R.v * dt);
  const u = R.s / R.len, p = S.curve.getPointAt(u);
  const ahead = S.curve.getPointAt(Math.min(1, (R.s + 0.35) / R.len));
  robot.position.set(p.x, 0, p.z);
  if (ahead.distanceToSquared(p) > 1e-6) {
    const want = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    let dy = want - robot.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    robot.rotation.y += dy * damp(7, dt);
  }
  // proximity at 10 Hz is plenty for a robot moving < 1 m/s, and keeps the frame budget for rendering
  proxClock += dt;
  if (proxClock > 0.1) {
    proxClock = 0;
    const near = [];
    for (const o of S.data.objects) if (o.kind === "object" && Math.hypot(o.center[0] - p.x, o.center[2] - p.z) < 1.2) near.push(o.id);
    for (const id of near) if (!S.seen.has(id)) { S.seen.set(id, true); if (S.data.objects.find((o) => o.id === id)?.asset) transitDirty = true; }
    S.fac.setHighlighted(near, { selected: S.selected?.id, target: S.target.id });
    const bar = $("#rBar"); if (bar) bar.style.width = `${u * 100}%`;
    const other = $("#otherCount"); if (other) other.textContent = S.seen.size;
  }
  transitClock += dt;
  if (transitDirty && transitClock > 0.4) { transitDirty = false; transitClock = 0; renderTransitCard(); }
  if (S.follow) {
    // chase camera follows a damped heading, so corners turn the view gently instead of snapping
    const yaw = robot.rotation.y;
    if (camYaw === null) camYaw = yaw;
    let d = yaw - camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * damp(2.2, dt);
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    _v.set(p.x - fx * 2.6 + fz * 0.7, 1.9, p.z - fz * 2.6 - fx * 0.7);
    camera.position.lerp(_v, damp(3, dt));
    controls.target.lerp(_t.set(p.x + fx * 1.0, 0.5, p.z + fz * 1.0), damp(4, dt));
  }
  if (R.s >= R.len - 1e-3) { R.moving = false; R.v = 0; camYaw = null; arrive(); }
}

async function arrive() {
  const o = S.navObject, c = new THREE.Vector3(...o.center), r = S.fac.robot.position.clone();
  const dir = c.clone().sub(r).setY(0).normalize();
  flyTo(r.clone().addScaledVector(dir, -1.3).setY(1.55), c.clone().setY(Math.max(0.35, c.y)));
  S.selected = o;
  S.fac.setHighlighted([], { selected: o.id, target: o.id });
  renderDock(); renderLeft();
  toast(`Arrived at <b>${o.asset.tag}</b>. Diagnosis ready.`);
  S.diag = await S.diagPromise; S.tab = "overview";
  renderDiagnosis();
}

// ------------------------------------------------------------------ camera tween
let tween = null;
function flyTo(pos, target, dur = 1.1, cam = camera, ctl = controls) {
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

// ------------------------------------------------------------------ X-Ray
async function enterXRay(focus = null) {
  if (!S.diag) S.diag = await api.diagnose(S.target.asset.asset_id);
  if (S.mode === "facility") {
    const o = S.data.objects.find((x) => x.asset?.asset_id === S.diag.asset.asset_id) || S.target;
    const c = new THREE.Vector3(...o.center);
    flyTo(c.clone().add(new THREE.Vector3(0.3, 0.1, 0.3)), c, 0.8);
    await wait(500); $(".fade").classList.add("on"); await wait(500);
  }
  setMode("xray");
  xCam.position.copy(XHOME.pos).multiplyScalar(1.25); xControls.target.copy(XHOME.tgt);
  flyTo(XHOME.pos, XHOME.tgt, 1.4, xCam, xControls);
  S.xray.setExplode(0);
  const lead = S.diag.hypotheses[0]?.components || [];
  S.xray.highlight(lead, { alt: S.diag.hypotheses.slice(1).flatMap((h) => h.components) });
  $(".fade").classList.remove("on");
  setTimeout(() => { S.xray.setExplode(0.65); renderDock(); }, 900);
  S.xSelected = (focus && focus[0]) || lead[0] || null;
  renderComponents(); renderPartCard();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function renderPartCard() {
  if (S.mode !== "xray") return;
  const c = S.kb.components.find((x) => x.id === S.xSelected);
  if (!c) return card(`${header("Illustrative model", "Centrifugal pump", '<span class="tag">Illustrative</span>')}
    <p class="p" style="margin-top:12px">${esc(S.kb.model.provenance)}</p><p class="note">Select a component on the left or in the model.</p></div>`);
  const lead = new Set(S.diag?.hypotheses?.[0]?.components || []);
  const tel = Object.fromEntries((S.diag?.telemetry?.signals || []).map((s) => [s.signal, s]));
  const isolated = S.xray.hidden.size > 0;
  const tabs = { overview: "Overview", evidence: "Evidence", ask: "Ask" };
  const body = {
    overview: `<p class="p">${esc(c.function)}</p>${kv("Group", nice(c.group))}${kv("Linked faults", c.issue_codes.map(nice).join(", "))}
      ${lead.has(c.id) ? kv("Status", `<span style="color:var(--bad)">Suspected for ${S.diag.asset.tag}</span>`) : ""}
      <div class="section"><div class="label">Typical failure signs</div>${c.failure_symptoms.map((s, i) => `<div class="step"><span class="k">${i + 1}</span><span>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</span></div>`).join("")}</div>`,
    evidence: `<div class="label note" style="margin-bottom:4px">Signals for ${S.diag?.asset?.tag ?? "the target"}</div>${c.evidence_signals.map((s) => { const t = tel[s]; const hot = t && (t.abnormal || Math.abs(t.z_vs_peers ?? 0) >= 1.5);
      return `<div class="sig"><div><b>${nice(s.replace(/_(mm_s|c|a|pct|bar|rpm)$/, ""))}</b><small>${t ? `${t.recent_mean} ${t.unit} · peers ${t.peer_mean} · <span class="${hot ? "flag" : ""}">z ${t.z_vs_peers}</span>` : "Not measured on this asset"}</small></div>${t ? sparkline(t.series, 88, 26, hot) : ""}</div>`; }).join("")}`,
    ask: `<input class="search" id="partQ" value="What does the ${esc(c.name.toLowerCase())} do and what evidence suggests it may be faulty?"/>
      <div class="section"><button class="btn block" data-act="askpart">${icon("spark")}Ask the copilot</button></div><div id="partA" class="section"></div>`,
  };
  card(`${header(nice(c.group), esc(c.name), '<span class="tag">Illustrative</span>')}
    <div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-xtab="${k}" class="${S.xTab === k ? "on" : ""}">${v}</button>`).join("")}</div>
    ${body[S.xTab]}
    <div class="section"><button class="btn block" data-act="isolate">${icon("target")}${isolated ? "Show all parts" : "Isolate component"}</button></div>
    <div class="section" style="text-align:center"><button class="link" data-docid="KB-XRAY-PUMP#${c.id}">Training note ${icon("arrow")}</button></div></div>`);
}

async function askPart() {
  $("#partA").innerHTML = '<div class="note">Looking it up…</div>';
  const a = await api.query($("#partQ").value, S.diag?.asset?.asset_id, S.xSelected);
  $("#partA").innerHTML = `<div class="narr">${cites(a.text)}</div><p class="note" style="margin-top:6px">${esc(a.mode)} · ${a.sources?.length ?? 0} sources</p>`;
}

export function focusPart(id, dist = 1.6) {
  const c = S.xray.partCenter(id);
  const dir = XHOME.pos.clone().sub(XHOME.tgt).normalize();
  flyTo(c.clone().addScaledVector(dir, dist), c, 0.9, xCam, xControls);
}
function selectComponent(id) {
  S.xSelected = id;
  S.xray.selected = id;
  if (S.mode === "xray") { renderComponents(); renderPartCard(); focusPart(id); }
  S.onComponentPick?.(id);
}

// ------------------------------------------------------------------ modes
export function setMode(mode) {
  const x = ["xray", "learn", "practice"].includes(mode);
  if (mode === "xray" && S.mode === "facility" && !S.diag) return enterXRay();
  S.mode = mode;
  $$(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  controls.enabled = !x; xControls.enabled = x;
  $(".labels").innerHTML = "";
  $("#left").classList.toggle("hidden", mode !== "facility" && mode !== "xray");
  S.onComponentPick = null;
  if (mode === "facility") { S.xray.selected = null; renderLeft(); S.diag ? renderDiagnosis() : (S.robot.moving ? renderTransitCard() : renderOverviewCard()); }
  if (mode === "xray") { renderComponents(); renderPartCard(); }
  if (mode === "learn") S.training.learn();
  if (mode === "practice") S.training.practice();
  renderDock();
}
$(".modes").onclick = (e) => { const m = e.target.closest("[data-mode]")?.dataset.mode; if (m) m === "xray" ? enterXRay() : setMode(m); };

// ------------------------------------------------------------------ ask
const SUGG = ["Where is the faulty pump?", "Find the equipment with abnormal vibration", "Send a technician to inspect the faulty pump", "Show me the relevant manual", "Can I practise inspecting this equipment?"];
const pop = $("#pop"), askIn = $("#ask");
function showSuggestions() {
  pop.innerHTML = SUGG.map((s) => `<button class="sugg" data-q="${esc(s)}">${icon("search")}${esc(s)}</button>`).join("");
  pop.classList.remove("hidden");
}
askIn.addEventListener("focus", () => { if (!pop.dataset.answer) showSuggestions(); });
askIn.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(askIn.value); if (e.key === "Escape") { pop.classList.add("hidden"); askIn.blur(); } });
pop.addEventListener("click", (e) => { const s = e.target.closest("[data-q]"); if (s) ask(s.dataset.q); if (e.target.closest("[data-pop-close]")) { pop.classList.add("hidden"); delete pop.dataset.answer; } });
document.addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement !== askIn && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); askIn.focus(); } });
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".ask")) pop.classList.add("hidden"); });

export async function ask(q) {
  q = (q || "").trim(); if (!q) return;
  askIn.value = q;
  pop.dataset.answer = "1";
  pop.innerHTML = `<div class="reply"><div class="who"><span>Copilot</span></div><span class="note">Working…</span></div>`;
  pop.classList.remove("hidden");
  try {
    const r = await api.command(q, S.selected?.asset?.asset_id || S.diag?.asset?.asset_id);
    pop.innerHTML = `<div class="reply"><div class="who"><span>Copilot</span><button class="link" data-pop-close>${icon("close")}</button></div>${cites(r.text)}</div>`;
    for (const a of r.actions || []) {
      if (a.type === "select") { if (S.mode !== "facility") setMode("facility"); selectAsset(a.asset_id, { fly: !r.actions.some((x) => x.type === "navigate") }); }
      if (a.type === "navigate") { S.blocks = []; S.fac.setBlocks([]); S.prevRoute = null; await dispatch(a.asset_id); }
      if (a.type === "xray") await enterXRay();
      if (a.type === "practice") setMode("practice");
      if (a.type === "learn") setMode("learn");
      if (a.type === "knowledge") openLibrary();
    }
  } catch (e) { pop.innerHTML = `<div class="reply">Something went wrong: ${esc(e.message)}</div>`; }
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
    <p class="note" style="margin:8px 0 4px">8 knowledge documents, 30 asset cards, 50 service cases and 11 training notes. Answers cite the document IDs.</p><div id="libRes"></div>`);
  const run = async () => {
    const res = await api.search($("#libQ").value);
    $("#libRes").innerHTML = res.map((d) => `<button class="doc" data-docid="${esc(d.id)}"><span class="k">${nice(d.kind)}</span><code>${esc(d.id)}</code><p>${esc(d.title)} · ${esc(d.text.slice(0, 120))}…</p></button>`).join("") || '<p class="note">No matches.</p>';
  };
  $("#libQ").onkeydown = (e) => e.key === "Enter" && run();
  run();
}
async function showDoc(id) {
  if (/^(EVT|WO|DQ)-/.test(id)) return toast(`${esc(id)} is listed under Evidence in the diagnosis.`);
  if (id === "Telemetry_Sample_3d") return toast("Telemetry_Sample_3d is the 30-minute synthetic telemetry stream in the builder pack.");
  try {
    const d = await api.doc(id);
    sheet(esc(d.id), `<div class="h1" style="font-size:17px">${esc(d.title)}</div><div class="sub">${nice(d.kind)} · ${esc(d.source)}</div>
      <p class="p" style="margin-top:12px;color:var(--text)">${esc(d.text)}</p>${d.kind === "training_kb" ? '<p class="note">General training knowledge for the illustrative model, not an OEM manual.</p>' : ""}`);
  } catch { toast(`${esc(id)} is a workbook record.`); }
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".cite, [data-docid]"); if (c) showDoc(c.dataset.doc || c.dataset.docid);
  const x = e.target.closest("[data-xcomp]"); if (x) enterXRay(x.dataset.xcomp.split(","));
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
  sheet("About this demo", `<div class="h1" style="font-size:17px">Industrial X-Ray</div><p class="p">Valmet × Since AI 2026 challenge entry: semantic 3D scene understanding and an autonomous field-service copilot.</p>
    ${kv("Scan", `${i.declared_vertex_count.toLocaleString()} splats · ${Math.round(i.contiguous_valid_fraction * 100)}% valid`)}${kv("Objects framed", S.data.stats.n_objects)}${kv("Assets mapped", S.data.n_bound_assets)}
    ${kv("Drivable floor", `${n.walkable_area_m2} m²`)}${kv("Robot radius", `${n.robot_radius_m} m`)}${kv("Backend", api.isStatic ? "Static export (hosted)" : "Live Python API")}
    <div class="section"><div class="label">What is real and what is illustrative</div>
      <div class="step"><span class="k">1</span><span>The room, object frames, labels and routes come from the supplied scan.</span></div>
      <div class="step"><span class="k">2</span><span>Asset data is synthetic and mapped to objects with stated confidence.</span></div>
      <div class="step"><span class="k">3</span><span>The X-Ray pump is a procedural teaching model, not captured by the scan and not an OEM drawing.</span></div></div>
    <div class="section"><div class="label">Keys</div>${kv("Ask", '<span class="kbd">/</span>')}${kv("Orbit · pan · zoom", "Drag · right-drag · scroll")}</div>`);
}

let toastTimer;
export function toast(msg, ms = 4200) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); $("#app").appendChild(t); }
  t.innerHTML = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let down = null;
canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (S.mode === "facility") {
    ray.setFromCamera(ndc, camera);
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
renderer.setAnimationLoop(() => {
  if (QA) { const now = performance.now(); if (now - lastQA < 2500) return; lastQA = now; }
  const dt = QA ? 0.05 : Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  updateTween(dt);
  if (!S.fac) return;
  if (S.mode === "facility") {
    updateRobot(dt, t);
    if (!S.robot.moving) S.fac.pulse(t, S.target.id);
    controls.update();
    renderer.render(fac, camera);
    labels.render(fac, camera);
  } else {
    S.xray.update(dt, t);
    xControls.update();
    renderer.render(S.xray.scene, xCam);
    labels.render(S.xray.scene, xCam);
  }
});

window.__app = S; window.__renderer = renderer;
Object.assign(window, { __dispatch: dispatch, __enterXRay: enterXRay, __setMode: setMode, __ask: ask, __block: blockAisle, __select: selectAsset });
boot();
