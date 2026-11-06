// Industrial X-Ray AI — app controller (facility → navigation → diagnosis → X-Ray → learn/practice).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { api } from "./api.js";
import { Facility } from "./facility.js";
import { XRay } from "./xray.js";
import { initTraining } from "./training.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (s) => String(s ?? "").replaceAll("_", " ").toLowerCase();
export const cites = (text) => esc(text).replace(/\[([^\[\]]{2,80})\]/g, (_, ids) =>
  ids.split(",").map((i) => `<span class="cite" data-doc="${i.trim()}">${i.trim()}</span>`).join(""));

// ------------------------------------------------------------------ DOM skeleton
$("#app").innerHTML = `
<canvas class="gl"></canvas>
<div class="labels"></div>
<div class="flash"></div>
<div class="topbar">
  <div class="brand"><div class="logo"></div><div>Industrial X-Ray AI<small>FROM FACTORY TO COMPONENT · VALMET × SINCE AI 2026</small></div></div>
  <div class="modes">
    <button data-mode="facility" class="on">FACILITY</button>
    <button data-mode="xray">X-RAY</button>
    <button data-mode="learn">LEARN</button>
    <button data-mode="practice">PRACTICE</button>
    <button data-mode="knowledge">KNOWLEDGE</button>
  </div>
  <div class="badges"><span class="badge warn" id="scanBadge">PARTIAL SCAN</span><span class="badge syn">SYNTHETIC ASSET DATA</span><span class="badge" id="llmBadge">AI</span></div>
</div>
<div class="banner hidden" id="banner"></div>
<div class="panel left" id="left"></div>
<div class="panel right" id="right"></div>
<div class="panel modal hidden" id="modal"></div>
<div class="cmd">
  <div class="answer hidden" id="answer"></div>
  <div class="sugg" id="sugg"></div>
  <div class="cmdbox"><span style="color:var(--accent);font-weight:700">⌘</span>
    <input id="cmdInput" placeholder="Ask the copilot — e.g. “Where is the faulty pump?”" autocomplete="off" />
    <button class="btn primary" id="cmdSend">Ask</button></div>
</div>
<div class="loading" id="loading"><div class="box"><div class="ring"></div>Loading 3D scan & scene intelligence…</div></div>`;

// ------------------------------------------------------------------ renderer + scenes
const canvas = $("canvas.gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const labels = new CSS2DRenderer({ element: $(".labels") });
labels.setSize(innerWidth, innerHeight);

const facScene = new THREE.Scene();
facScene.background = new THREE.Color(0x070b14);
facScene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.6));
const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(2, 4, 1); facScene.add(dl);
facScene.add(new SparkRenderer({ renderer }));
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.03, 80);
camera.position.set(-0.15, 1.85, -1.45);
const controls = new OrbitControls(camera, canvas);
controls.target.set(-2.6, 0.35, 0.25);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;

const xCam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.02, 60);
xCam.position.set(0.55, 1.35, 3.3);
const xControls = new OrbitControls(xCam, canvas);
xControls.target.set(-0.25, -0.05, 0);
xControls.enableDamping = true;
xControls.enabled = false;

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
  for (const c of [camera, xCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
});

// ------------------------------------------------------------------ state
export const S = {
  mode: "facility", data: null, fac: null, xray: null, kb: null,
  selected: null, target: null, diag: null, route: null, curve: null, prevRoute: null,
  robot: { moving: false, s: 0, speed: 0.45, len: 0 }, blocks: [], seen: new Map(), follow: true,
  showMode: "all", gridShown: false, placingBlock: false, xSelected: null,
};

// ------------------------------------------------------------------ boot
const boot = async () => {
  const [data, kb] = await Promise.all([api.scene(), api.xrayModel()]);
  S.data = data; S.kb = kb;
  S.fac = new Facility(facScene, data);
  S.xray = new XRay(kb);
  S.target = data.objects.find((o) => o.id === data.target_object_id);
  $("#scanBadge").textContent = `PARTIAL SCAN · ${(data.integrity.contiguous_valid_fraction * 100).toFixed(1)}% OF SPLATS VALID`;
  $("#scanBadge").title = `Records ${data.integrity.first_implausible_record.toLocaleString()}+ of the supplied PLY are corrupt (identical in PLY/RAR/ZIP). See data/processed/integrity_report.md`;
  fetch("/api/health").then((r) => r.json()).then((h) => { $("#llmBadge").textContent = h.llm_model ? `AI · ${h.llm_model}` : "AI · TEMPLATE MODE"; });
  renderLeft();
  renderRightIdle();
  renderSuggestions();
  initTraining(S, { $, esc, cites, setMode, renderRight: (h) => ($("#right").innerHTML = h), xCam, xControls, ask, toast });
  try { await S.fac.splat.initialized; } catch (e) { console.warn(e); }
  $("#loading").style.opacity = 0;
  setTimeout(() => $("#loading").remove(), 700);
};

// ------------------------------------------------------------------ left panel
function renderLeft() {
  const d = S.data;
  const assets = d.objects.filter((o) => o.asset).map((o) => o.asset);
  const order = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
  assets.sort((a, b) => (b.is_target - a.is_target) || order[a.condition_state] - order[b.condition_state] || a.health_score - b.health_score);
  const cats = {};
  for (const o of d.objects) if (o.kind === "object") cats[o.category] = (cats[o.category] || 0) + 1;
  const nav = d.navigation;
  $("#left").innerHTML = `
  <div class="ph"><h3>Scene intelligence</h3></div>
  <div class="pb">
    <div class="kpis">
      <div class="kpi"><b>${d.stats.n_objects}</b><span>3D-framed objects</span></div>
      <div class="kpi"><b>${d.n_bound_assets}</b><span>mapped assets</span></div>
      <div class="kpi"><b>${nav.walkable_area_m2}</b><span>m² walkable</span></div>
    </div>
    <div class="row" style="margin-top:8px">${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${k} ${v}</span>`).join("")}</div>
    <div class="note" style="margin-top:6px">Structure: floor, ceiling (${d.ceiling_y?.toFixed(2)} m), ${d.planes.filter((p) => p.label === "wall").length} wall plane · ${nav.levels.length} floor-height clusters detected</div>
    <div class="seg" style="margin-top:10px" id="showSeg">
      <button data-v="all" class="on">All frames</button><button data-v="assets">Assets only</button><button data-v="none">Hide</button></div>
    <div class="row" style="margin-top:8px">
      <button class="chip" id="gridBtn">Nav grid</button>
      <button class="chip on" id="followBtn">Follow cam</button>
      <button class="chip" id="resetCam">Overview</button>
    </div>
    <div class="legend" style="margin-top:10px">
      <span><i style="background:var(--ok)"></i>healthy</span><span><i style="background:var(--watch)"></i>watch</span>
      <span><i style="background:var(--warn)"></i>degraded</span><span><i style="background:var(--bad)"></i>attention</span>
      <span><i style="background:#60a5fa"></i>rotating</span><span><i style="background:#a78bfa"></i>valve</span>
      <span><i style="background:#94a3b8"></i>piping</span><span><i style="background:#22d3ee"></i>instrument</span>
    </div>
  </div>
  <div class="ph"><h3>Assets · priority order</h3></div>
  <div class="scroll pb" style="padding-top:6px" id="assetList">
    ${assets.map((a) => `<div class="asset" data-asset="${a.asset_id}">
      <span class="dot st-${a.condition_state}"></span>
      <div><b>${a.tag}</b>${a.is_target ? ' <span class="sus">TARGET</span>' : ""}<small>${fmt(a.asset_class)} · ${fmt(a.issue_code)}</small></div>
      <em class="st-${a.condition_state}" style="color:var(--st)">${a.health_score}</em></div>`).join("")}
  </div>`;
  $("#showSeg").onclick = (e) => {
    const v = e.target.dataset.v; if (!v) return;
    S.showMode = v; S.fac.setShowMode(v);
    [...$("#showSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  };
  $("#gridBtn").onclick = async (e) => {
    S.gridShown = !S.gridShown;
    e.target.classList.toggle("on", S.gridShown);
    if (S.gridShown) S.fac.showGrid(await api.grid());
    S.fac.gridGroup.visible = S.gridShown;
  };
  $("#followBtn").onclick = (e) => { S.follow = !S.follow; e.target.classList.toggle("on", S.follow); };
  $("#resetCam").onclick = () => flyTo(new THREE.Vector3(-0.15, 1.85, -1.45), new THREE.Vector3(-2.6, 0.35, 0.25));
  $("#assetList").onclick = (e) => {
    const el = e.target.closest("[data-asset]"); if (!el) return;
    selectAsset(el.dataset.asset, { fly: true });
  };
}

// ------------------------------------------------------------------ right panel
function renderRightIdle() {
  const t = S.target?.asset;
  $("#right").innerHTML = `
  <div class="ph"><h3>Field-service copilot</h3></div>
  <div class="pb">
    <div class="li" style="border-color:rgba(244,63,94,.45);background:rgba(244,63,94,.07);display:block">
      <div style="font:700 10px var(--mono);letter-spacing:.1em;color:#fda4af">SIMULATED FAULT</div>
      <div style="margin-top:3px"><b style="font-family:var(--mono)">${t?.tag}</b> · ${fmt(t?.asset_class)} — ${esc(t?.issue_summary)}</div>
      <div class="note">Health ${t?.health_score} · ${t?.criticality} · highest maintenance priority in the builder pack</div>
    </div>
    <div class="actions"><button class="btn primary" id="dispatch">▶ Dispatch inspection robot</button><button class="btn" id="locate">Locate</button></div>
    <div class="sec"><h4>How this works</h4>
      <div class="step"><b>1</b><div>Scan → ${S.data.stats.n_objects} objects segmented & 3D-framed (plane fitting + DBSCAN), labelled by a vision-language model, reviewed.</div></div>
      <div class="step"><b>2</b><div>Workbook assets mapped to compatible objects with explicit confidence.</div></div>
      <div class="step"><b>3</b><div>Robot plans a collision-free route on the walkable floor (A*, ${S.data.navigation.robot_radius_m} m radius) and frames assets within 1.2 m.</div></div>
      <div class="step"><b>4</b><div>On arrival the copilot diagnoses from telemetry, alarms, work orders & documents — every claim cited.</div></div>
    </div>
    <div class="sec"><h4>Proximity feed <span id="feedCount"></span></h4><div class="list feed" id="feed"><div class="note">Robot idle.</div></div></div>
  </div>`;
  $("#dispatch").onclick = () => dispatch(S.target.asset.asset_id);
  $("#locate").onclick = () => selectAsset(S.target.asset.asset_id, { fly: true });
}

function sparkline(series, w = 96, h = 28, color = "#38bdf8") {
  if (!series?.length) return "";
  const v = series.map((s) => s[1]);
  const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * w},${h - 2 - ((y - lo) / r) * (h - 4)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

function renderAssetCard(o, extra = "", showActions = true) {
  const a = o.asset;
  const head = a ? `<div class="hdr st-${a.condition_state}">
      <div class="gauge" style="--v:${a.health_score}"><span>${a.health_score}</span></div>
      <div><div class="title">${a.tag}</div><div class="sub">${fmt(a.asset_class)} · ${esc(a.area_name)} · ${esc(a.criticality)}</div>
      <span class="status">${fmt(a.condition_state)}</span> <span class="sub">${esc(a.issue_summary)}</span></div></div>` :
    `<div class="title" style="font-size:15px">${esc(o.label)}</div><div class="sub">No workbook asset mapped — scene object only</div>`;
  return `<div class="ph"><h3>${a ? "Asset" : "Scene object"} · ${o.id}</h3></div><div class="pb">${head}
    <div class="sec"><h4>3D identity</h4>
      <div class="li" style="display:block">Label <b>${esc(o.label)}</b> · ${Math.round(o.confidence * 100)}% · <code>${o.label_source}</code>
      ${o.heuristic_label ? `<div class="note">geometry heuristic proposed: ${esc(o.heuristic_label)}</div>` : ""}
      ${o.vlm_rationale ? `<div class="note">VLM: ${esc(o.vlm_rationale)}</div>` : ""}
      ${o.review_note ? `<div class="note">Human review: ${esc(o.review_note)}${o.auto_label ? ` (automatic label was “${esc(o.auto_label)}”)` : ""}${o.merged_from ? ` · merged ${o.merged_from.length} clusters` : ""}</div>` : ""}
      <div class="note">Frame ${o.size.map((v) => v.toFixed(2)).join(" × ")} m · centre (${o.center.map((v) => v.toFixed(2)).join(", ")}) · ${o.n_points} splats ${o.reachable ? "· reachable" : "· not reachable from walkable floor"}</div>
      ${a ? `<div class="note">Mapping: ${esc(a.mapping_method)} · confidence ${a.mapping_confidence}</div>` : ""}</div></div>
    ${extra}
    ${a && showActions ? `<div class="actions"><button class="btn primary" data-act="nav">▶ Send robot</button><button class="btn" data-act="diag">Diagnose</button>${a.asset_class === "PROCESS_PUMP" || a.asset_class === "ELECTRIC_MOTOR" ? '<button class="btn xray" data-act="xray">ENTER X-RAY MODE</button>' : ""}</div>` : ""}
  </div>`;
}

async function selectAsset(assetId, { fly = false } = {}) {
  const o = S.data.objects.find((x) => x.asset?.asset_id === assetId);
  if (!o) return;
  selectObject(o, { fly });
}

function selectObject(o, { fly = false } = {}) {
  S.selected = o;
  document.querySelectorAll(".asset").forEach((el) => el.classList.toggle("sel", el.dataset.asset === o.asset?.asset_id));
  S.fac.setHighlighted([...S.seen.keys()], { selected: o.id, target: S.target?.id });
  if (S.mode === "facility") {
    $("#right").innerHTML = renderAssetCard(o);
    bindCardActions(o);
  }
  if (fly) {
    const c = new THREE.Vector3(...o.center);
    const off = new THREE.Vector3(1.6, 1.3, 1.6);
    if (c.x < -2) off.set(1.8, 1.2, 0.6);
    flyTo(c.clone().add(off), c);
  }
}

function bindCardActions(o) {
  $("#right").onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "nav") dispatch(o.asset.asset_id);
    if (act === "diag") showDiagnosis(await api.diagnose(o.asset.asset_id));
    if (act === "xray") enterXRay();
    if (act === "wo") showWorkOrder(o.asset.asset_id);
    if (act === "learn") setMode("learn");
    if (act === "practice") setMode("practice");
  };
}

function showDiagnosis(d) {
  S.diag = d;
  const o = S.data.objects.find((x) => x.asset?.asset_id === d.asset.asset_id);
  const c = d.confidence;
  const sigs = d.telemetry.signals.map((s) => {
    const z = s.z_vs_peers ?? s.z_vs_own_baseline;
    const cls = Math.abs(z) >= 2 ? "hi" : Math.abs(z) >= 1 ? "mid" : "";
    return `<div class="sig"><div><b>${s.signal}</b><small>now ${s.recent_mean}${s.unit} · baseline ${s.baseline_mean} · peers ${s.peer_mean ?? "–"} · <span class="z ${cls}">z ${z}</span>${s.abnormal ? ' <span class="sus">ABNORMAL</span>' : ""}</small></div>${sparkline(s.series, 96, 28, cls === "hi" ? "#f43f5e" : cls === "mid" ? "#facc15" : "#38bdf8")}</div>`;
  }).join("");
  const extra = `
  <div class="sec"><h4>AI diagnosis <span class="note">${esc(d.narrative.mode)}</span></h4><div class="narr">${cites(d.narrative.text)}</div>
    ${d.narrative.invalid_citations?.length ? `<div class="note">Removed ${d.narrative.invalid_citations.length} unsupported citation(s): ${esc(d.narrative.invalid_citations.join(", "))}</div>` : `<div class="note">All citations verified against the evidence package.</div>`}</div>
  <div class="sec"><h4>Confidence <b style="font-family:var(--mono)">${c.overall}</b></h4><div class="bar"><i style="width:${c.overall * 100}%"></i></div>
    <div class="note" style="margin-top:4px">model ${c.model_confidence} · evidence support ${c.evidence_support} · data-quality penalty −${c.data_quality_penalty} · 3D mapping ${c.mapping_confidence}<br>${esc(c.explanation)}</div></div>
  <div class="sec"><h4>Telemetry evidence <span class="note">${esc(d.telemetry.source)}</span></h4>${sigs}</div>
  <div class="sec"><h4>Hypotheses</h4>${d.hypotheses.map((h) => `<div class="hyp ${h.rank === 1 ? "lead" : ""}"><div><b>${esc(h.hypothesis)}</b><div class="note">${h.status}</div></div>${h.components.length ? `<button class="btn" data-xcomp="${h.components.join(",")}">X-Ray ▸</button>` : ""}</div>`).join("")}</div>
  <div class="sec"><h4>Alarms & events</h4><div class="list">${d.events.slice(0, 5).map((e) => `<div class="li"><code>${e.event_id}</code><span class="sev-${e.severity}">${e.severity}</span><span>${fmt(e.event_type)} · ${e.event_code} · ${e.timestamp}</span></div>`).join("") || '<div class="note">none</div>'}</div></div>
  <div class="sec"><h4>Maintenance history</h4><div class="list">${d.work_orders.slice(0, 4).map((w) => `<div class="li"><code>${w.work_order_id}</code><span>${w.opened_at?.slice(0, 10)} · ${esc(w.action)} → ${fmt(w.result)}</span></div>`).join("") || '<div class="note">none</div>'}</div></div>
  <div class="sec"><h4>Similar service cases</h4><div class="list">${d.similar_cases.slice(0, 3).map((k) => `<div class="li"><code>${k.case_id}</code><span>${esc(k.historical_interpretation)} → ${esc(k.recommended_next_check)}</span></div>`).join("")}</div></div>
  <div class="sec"><h4>Data quality (lowers confidence)</h4><div class="row">${d.data_quality.map((q) => `<span class="chip">${q.issue_id} ${fmt(q.issue_type)}</span>`).join("") || '<span class="note">none</span>'}</div></div>
  <div class="sec"><h4>Recommended safe next steps</h4>${d.next_steps.map((s, i) => `<div class="step"><b>${i + 1}</b><div>${esc(s.step)} <span class="cite" data-doc="${s.source}">${s.source}</span></div></div>`).join("")}</div>
  <div class="sec"><h4>Sources</h4><div class="row">${d.documents.map((x) => `<span class="cite" data-doc="${x.id}">${x.id}</span>`).join("")}</div></div>
  <div class="actions"><button class="btn xray" data-act="xray">ENTER X-RAY MODE</button><button class="btn" data-act="wo">Draft work order</button><button class="btn" data-act="learn">Learn</button><button class="btn" data-act="practice">Practise</button></div>
  <div class="note" style="margin-top:8px">${esc(d.synthetic_notice)} Decision support only — no control actions.</div>`;
  $("#right").innerHTML = renderAssetCard(o, extra, false);
  bindCardActions(o);
  $("#right").scrollTop = 0;
}

async function showWorkOrder(assetId) {
  const w = await api.draftWO(assetId);
  openModal(`<button class="close" data-close>✕</button><h3>Work-order draft · ${w.draft_id}</h3>`, `
    <div class="li" style="display:block;border-color:rgba(250,204,21,.4)"><b>${w.status}</b> — ${w.control_actions}</div>
    <div class="sec"><h4>Asset</h4>${w.tag} (${w.asset_id}) · ${esc(w.area_name)}</div>
    <div class="sec"><h4>Problem</h4>${esc(w.problem)}</div>
    <div class="sec"><h4>Requested action</h4>${esc(w.action)} · ${w.maintenance_type} · priority ${w.priority} · role ${fmt(w.role)}</div>
    <div class="sec"><h4>Evidence</h4><div class="row">${w.evidence_ids.map((i) => `<span class="cite" data-doc="${i}">${i}</span>`).join("")} ${w.knowledge_doc_id ? `<span class="cite" data-doc="${w.knowledge_doc_id}">${w.knowledge_doc_id}</span>` : ""}</div></div>
    <div class="sec"><h4>Safety prerequisites</h4>${w.safety_prerequisites.map((s) => `<div class="gate">☐ ${esc(s)}</div>`).join("")}</div>
    <div class="sec"><h4>Copilot confidence</h4>${w.confidence}</div>`);
}

// ------------------------------------------------------------------ modal + citations
function openModal(head, body) {
  const m = $("#modal");
  m.innerHTML = `<div class="ph">${head}</div><div class="pb">${body}</div>`;
  m.classList.remove("hidden");
}
document.addEventListener("click", async (e) => {
  if (e.target.matches("[data-close]")) { $("#modal").classList.add("hidden"); if (S.mode === "knowledge") setMode(S.prevMode || "facility"); }
  const c = e.target.closest(".cite");
  if (c) {
    const id = c.dataset.doc;
    if (/^(EVT|WO|DQ)-/.test(id)) return toast(`${id} is shown in the diagnosis panel (events / work orders / data quality).`);
    if (id === "Telemetry_Sample_3d") return toast("Telemetry_Sample_3d — 30-min synthetic stream from the builder pack (see Telemetry evidence).");
    try { const d = await api.doc(id); showDoc(d); } catch { toast(`${id}: workbook record (see evidence panel)`); }
  }
  const xc = e.target.closest("[data-xcomp]");
  if (xc) { enterXRay(xc.dataset.xcomp.split(",")); }
});
function showDoc(d) {
  openModal(`<button class="close" data-close>✕</button><h3>${esc(d.id)}</h3>`,
    `<div class="title" style="font-size:15px">${esc(d.title)}</div><div class="note">${esc(d.kind)} · scope ${esc(d.scope)} · source: ${esc(d.source)}</div>
     <div class="narr" style="margin-top:10px">${esc(d.text)}</div>
     ${d.kind === "training_kb" ? '<div class="note" style="margin-top:6px">General training knowledge for the illustrative model — not an OEM manual.</div>' : ""}
     <div class="sec"><h4>Ask about this document</h4><div class="row"><input class="search" id="docQ" placeholder="Question…" style="flex:1"/><button class="btn primary" id="docAsk">Ask</button></div><div id="docA" style="margin-top:8px"></div></div>`);
  $("#docAsk").onclick = async () => {
    $("#docA").innerHTML = '<div class="note">Thinking…</div>';
    const a = await api.query(`${$("#docQ").value} (document ${d.id})`, d.asset_id || S.diag?.asset?.asset_id, d.component);
    $("#docA").innerHTML = `<div class="narr">${cites(a.text)}</div><div class="note">${esc(a.mode)}</div>`;
  };
}

let toastTimer;
export function toast(msg, ms = 4200) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; $("#app").appendChild(t); }
  t.innerHTML = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------------ navigation + robot
async function dispatch(assetId, { start = null } = {}) {
  const o = S.data.objects.find((x) => x.asset?.asset_id === assetId);
  if (!o) return;
  if (S.mode !== "facility") setMode("facility");
  S.navAsset = assetId;
  S.navObject = o;
  const st = start || [S.fac.robot.position.x, S.fac.robot.position.z];
  const res = await api.plan({ object_id: o.id, start: st, blocks: S.blocks });
  if (!res.ok) { toast(`⚠ ${esc(res.reason)}`); return null; }
  S.route = res;
  S.curve = S.fac.drawRoute(res.waypoints);
  if (S.prevRoute) S.fac.ghostRoute(S.prevRoute);
  S.robot.len = S.curve.getLength();
  S.robot.s = 0;
  S.robot.moving = true;
  S.seen.clear();
  const v = res.validation;
  toast(`Route ${res.length_m} m · A* ${res.compute_ms} ms · ${res.raw_cells} cells → ${res.waypoints.length} waypoints · ${v.collision_free ? "✔ collision-free" : "✖ collision"} (min clearance ${v.min_clearance_m} m ≥ ${v.robot_radius_m} m robot radius)`);
  if (S.mode === "facility") {
    renderRightIdle();
    $("#feed").innerHTML = "";
    $("#dispatch").textContent = "⏸ Robot en route…";
    $("#dispatch").disabled = true;
    const blockBtn = document.createElement("button");
    blockBtn.className = "btn danger"; blockBtn.textContent = "⛔ Block walkway";
    blockBtn.onclick = () => blockWalkway();
    $("#dispatch").parentElement.appendChild(blockBtn);
  }
  S.diagPromise = api.diagnose(assetId);
  return res;
}

async function blockWalkway() {
  if (!S.curve) return;
  // drop a barrier on the route ahead of the robot (≈ 0.9 m ahead or mid-route)
  const ahead = Math.min(S.robot.s + 0.9, S.robot.len * 0.8);
  const p = S.curve.getPointAt(Math.max(0, Math.min(1, ahead / S.robot.len)));
  const b = { x: +p.x.toFixed(2), z: +p.z.toFixed(2), w: 0.7, d: 0.5 };
  S.blocks.push(b);
  S.fac.setBlocks(S.blocks);
  S.prevRoute = S.route.waypoints;
  const t0 = performance.now();
  const res = await dispatch(S.navAsset, { start: [S.fac.robot.position.x, S.fac.robot.position.z] });
  if (res) toast(`⛔ Walkway blocked at (${b.x}, ${b.z}) → route recalculated in ${Math.round(performance.now() - t0)} ms: ${res.length_m} m, ${res.validation.collision_free ? "still collision-free ✔" : "✖"}`, 6000);
}

const _v = new THREE.Vector3();
function updateRobot(dt) {
  const R = S.robot, robot = S.fac.robot;
  robot.userData.lidar.rotation.z += dt * 4;
  robot.userData.ring.material.opacity = 0.35 + 0.25 * Math.sin(performance.now() / 300);
  if (!R.moving || !S.curve) return;
  R.s = Math.min(R.len, R.s + R.speed * dt);
  const t = R.s / R.len;
  const p = S.curve.getPointAt(t), tan = S.curve.getTangentAt(t);
  robot.position.set(p.x, 0, p.z);
  robot.rotation.y = Math.atan2(tan.x, tan.z);
  // proximity: assets/objects within 1.2 m of the robot get framed + listed
  const near = [];
  for (const o of S.data.objects) {
    if (o.kind !== "object") continue;
    const d = Math.hypot(o.center[0] - p.x, o.center[2] - p.z);
    if (d < 1.2) near.push([o, d]);
  }
  const nearIds = near.map(([o]) => o.id);
  S.fac.setHighlighted(nearIds, { selected: S.selected?.id, target: S.target?.id });
  for (const [o, d] of near) {
    if (!S.seen.has(o.id)) {
      S.seen.set(o.id, d);
      if (o.asset || S.seen.size < 400) addFeed(o, d);
    }
  }
  if (S.follow) {
    const back = new THREE.Vector3(-tan.x, 0, -tan.z).multiplyScalar(2.1);
    const side = new THREE.Vector3(tan.z, 0, -tan.x).multiplyScalar(0.5);
    _v.set(p.x + back.x + side.x, 1.8, p.z + back.z + side.z);
    camera.position.lerp(_v, Math.min(1, dt * 2.2));
    controls.target.lerp(new THREE.Vector3(p.x + tan.x * 0.8, 0.55, p.z + tan.z * 0.8), Math.min(1, dt * 3));
  }
  if (R.s >= R.len - 1e-3) { R.moving = false; arrive(); }
}

function addFeed(o, d) {
  const feed = $("#feed"); if (!feed) return;
  const a = o.asset;
  const el = document.createElement("div");
  el.className = "li";
  el.style.cursor = "pointer";
  el.innerHTML = a
    ? `<span class="dot st-${a.condition_state}" style="width:8px;height:8px;border-radius:50%;margin-top:4px;flex:none"></span><div><b style="font-family:var(--mono)">${a.tag}</b> ${fmt(a.condition_state)} · health ${a.health_score}<div class="note">${esc(o.label)} · ${d.toFixed(1)} m · ${esc(a.issue_code)}</div></div>`
    : `<code>${o.id}</code><span>${esc(o.label)} <span class="note">${Math.round(o.confidence * 100)}% · ${d.toFixed(1)} m</span></span>`;
  el.onclick = () => selectObject(o);
  if (a) feed.prepend(el); else feed.appendChild(el);
  while (feed.children.length > 60) feed.lastChild.remove();
  const assets = [...S.seen.keys()].filter((id) => S.data.objects.find((x) => x.id === id)?.asset).length;
  $("#feedCount").textContent = `${S.seen.size} framed · ${assets} assets`;
}

async function arrive() {
  toast(`✔ Arrived at ${S.navObject.asset.tag}. Running grounded diagnosis…`);
  const o = S.navObject;
  const c = new THREE.Vector3(...o.center);
  flyTo(new THREE.Vector3(c.x + 1.5, 1.35, c.z + 0.9), c);
  S.selected = o;
  S.fac.setHighlighted([...S.seen.keys()].filter((id) => S.data.objects.find((x) => x.id === id)?.asset), { selected: o.id, target: o.id });
  const d = await S.diagPromise;
  showDiagnosis(d);
}

// ------------------------------------------------------------------ camera tween
let tween = null;
function flyTo(pos, target, dur = 1.2, cam = camera, ctl = controls) {
  tween = { p0: cam.position.clone(), t0: ctl.target.clone(), p1: pos.clone(), t1: target.clone(), k: 0, dur, cam, ctl };
}
function updateTween(dt) {
  if (!tween) return;
  tween.k = Math.min(1, tween.k + dt / tween.dur);
  const e = tween.k < 0.5 ? 2 * tween.k * tween.k : 1 - Math.pow(-2 * tween.k + 2, 2) / 2;
  tween.cam.position.lerpVectors(tween.p0, tween.p1, e);
  tween.ctl.target.lerpVectors(tween.t0, tween.t1, e);
  if (tween.k >= 1) tween = null;
}

// ------------------------------------------------------------------ X-Ray
async function enterXRay(focus = null) {
  if (!S.diag && S.target) S.diag = await api.diagnose(S.target.asset.asset_id);
  const comps = focus || S.diag?.hypotheses?.flatMap((h) => h.components) || [];
  // transition: fly into the machine, scanline flash, swap scene
  if (S.mode === "facility") {
    const o = S.diag ? S.data.objects.find((x) => x.asset?.asset_id === S.diag.asset.asset_id) : S.target;
    const c = new THREE.Vector3(...o.center);
    flyTo(c.clone().add(new THREE.Vector3(0.35, 0.15, 0.25)), c, 0.9);
    await new Promise((r) => setTimeout(r, 700));
    $(".flash").classList.add("on");
    await new Promise((r) => setTimeout(r, 450));
  }
  setMode("xray");
  xCam.position.set(0.55, 1.35, 3.3); xControls.target.set(-0.25, -0.05, 0);
  S.xray.setExplode(0);
  S.xray.highlight(S.diag?.hypotheses?.[0]?.components || comps);
  setTimeout(() => { S.xray.setExplode(1); }, 900);
  setTimeout(() => $(".flash").classList.remove("on"), 120);
  renderXRayPanel(comps);
}

function renderXRayPanel(suspects = []) {
  const kb = S.kb;
  const lead = new Set(S.diag?.hypotheses?.[0]?.components || []);
  const alt = new Set((S.diag?.hypotheses || []).slice(1).flatMap((h) => h.components));
  const sel = S.xSelected ? kb.components.find((c) => c.id === S.xSelected) : null;
  const tel = Object.fromEntries((S.diag?.telemetry?.signals || []).map((s) => [s.signal, s]));
  $("#right").innerHTML = `
  <div class="ph"><h3>X-Ray inspection · ${S.diag ? S.diag.asset.tag : "pump"}</h3></div>
  <div class="pb">
    <div class="li" style="display:block;border-color:rgba(250,204,21,.4);background:rgba(250,204,21,.06)"><b style="color:#fde68a">Illustrative model</b><div class="note">${esc(kb.model.provenance)}</div></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="xExplode">${S.xray.target > 0.5 ? "⇤ Reassemble" : "⇹ Explode"}</button><button class="btn" id="xGhost">${S.xray.ghost ? "Solid casing" : "Ghost casing"}</button><button class="btn" id="xBack">← Facility</button></div>
    ${S.diag ? `<div class="sec"><h4>Linked diagnosis</h4><div class="li" style="display:block"><b>${S.diag.asset.tag}</b> · ${S.diag.asset.issue_code} · confidence ${S.diag.confidence.overall}<div class="note">Leading hypothesis: ${esc(S.diag.hypotheses[0].hypothesis)}. Red = components linked to the leading hypothesis${alt.size ? ", amber = alternatives" : ""}.</div></div></div>` : ""}
    <div class="sec"><h4>Components</h4>${kb.components.map((c) => `<div class="comp ${c.id === S.xSelected ? "sel" : ""}" data-comp="${c.id}"><span>${esc(c.name)} <span class="note">${c.group}</span></span>${lead.has(c.id) ? '<span class="sus">SUSPECTED</span>' : alt.has(c.id) ? '<span class="sus" style="color:#fde68a;border-color:rgba(250,204,21,.5);background:rgba(250,204,21,.12)">ALT</span>' : ""}</div>`).join("")}</div>
    ${sel ? `<div class="sec"><h4>${esc(sel.name)} <span class="cite" data-doc="KB-XRAY-PUMP#${sel.id}">KB-XRAY-PUMP#${sel.id}</span></h4>
      <div class="narr">${esc(sel.function)}</div>
      <div class="sec"><h4>Typical failure symptoms</h4>${sel.failure_symptoms.map((s) => `<div class="step"><b>•</b><div>${esc(s)}</div></div>`).join("")}</div>
      <div class="sec"><h4>Evidence signals ${S.diag ? `for ${S.diag.asset.tag}` : ""}</h4>${sel.evidence_signals.map((s) => { const t = tel[s]; return `<div class="sig"><div><b>${s}</b><small>${t ? `now ${t.recent_mean}${t.unit} · peers ${t.peer_mean} · z ${t.z_vs_peers}${t.abnormal ? " · ABNORMAL" : ""}` : "not measured on this asset"}</small></div>${t ? sparkline(t.series) : ""}</div>`; }).join("")}</div>
      <div class="sec"><h4>Ask the copilot about this component</h4><div class="row"><input class="search" id="xQ" value="What does the ${esc(sel.name.toLowerCase())} do and what evidence suggests it may be faulty?" style="flex:1"/><button class="btn primary" id="xAsk">Ask</button></div><div id="xA" style="margin-top:8px"></div></div>
    </div>` : `<div class="note" style="margin-top:10px">Click a part in 3D or in the list. <span class="kbd">drag</span> rotate · <span class="kbd">scroll</span> zoom.</div>`}
  </div>`;
  $("#xExplode").onclick = () => { S.xray.setExplode(S.xray.target > 0.5 ? 0 : 1); renderXRayPanel(suspects); };
  $("#xGhost").onclick = () => { S.xray.setGhost(!S.xray.ghost); renderXRayPanel(suspects); };
  $("#xBack").onclick = () => setMode("facility");
  $("#right").querySelectorAll("[data-comp]").forEach((el) => (el.onclick = () => selectComponent(el.dataset.comp)));
  if (sel) $("#xAsk").onclick = async () => {
    $("#xA").innerHTML = '<div class="note">Retrieving sources…</div>';
    const a = await api.query($("#xQ").value, S.diag?.asset?.asset_id, sel.id);
    $("#xA").innerHTML = `<div class="narr">${cites(a.text)}</div><div class="note">${esc(a.mode)} · ${a.sources.length} sources retrieved</div>`;
  };
}

function selectComponent(id) {
  S.xSelected = id;
  S.xray.highlight(S.diag?.hypotheses?.[0]?.components || [], { selected: id });
  const c = S.xray.partCenter(id);
  flyTo(c.clone().add(new THREE.Vector3(0.9, 0.55, 1.2)), c, 0.8, xCam, xControls);
  if (S.mode === "xray") renderXRayPanel();
  S.onComponentPick?.(id);
}

// ------------------------------------------------------------------ modes
export function setMode(mode) {
  if (mode === "knowledge") { S.prevMode = S.mode; openKnowledge(); }
  const xr = ["xray", "learn", "practice"].includes(mode);
  S.mode = mode;
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  controls.enabled = !xr; xControls.enabled = xr;
  $(".labels").style.display = xr ? "none" : "";
  $("#left").classList.toggle("hidden", xr);
  $("#banner").classList.toggle("hidden", !xr);
  $("#banner").textContent = mode === "practice" ? "EDUCATIONAL SIMULATION · not certified training · no connection to real controls" : "ILLUSTRATIVE PROCEDURAL MODEL · not captured by the scan · not an OEM drawing";
  if (mode === "facility") { $(".flash").classList.remove("on"); if (S.diag) showDiagnosis(S.diag); else renderRightIdle(); }
  if (mode === "xray") renderXRayPanel();
  if (mode === "learn") S.training.learn();
  if (mode === "practice") S.training.practice();
}
document.querySelector(".modes").onclick = (e) => {
  const m = e.target.dataset.mode; if (!m) return;
  if (m === "xray") enterXRay(); else setMode(m);
};

async function openKnowledge(q = "") {
  openModal(`<button class="close" data-close>✕</button><h3>Machine Knowledge Center</h3>`, `
    <input class="search" id="kq" placeholder="Search manuals, asset cards, service cases… e.g. 'fouling pump flow'" value="${esc(q)}"/>
    <div class="note" style="margin:6px 0 10px">Corpus: 8 Valmet knowledge docs · 30 asset cards (generated from workbook rows) · 50 historical service cases · 11 illustrative component notes. BM25 retrieval; answers cite IDs.</div>
    <div id="kres"></div>
    <div class="sec"><h4>Ask the knowledge base</h4><div class="row"><input class="search" id="kask" placeholder="e.g. What evidence suggests fouling?" style="flex:1"/><button class="btn primary" id="kgo">Ask</button></div><div id="kans" style="margin-top:8px"></div></div>`);
  const run = async () => {
    const res = await api.search($("#kq").value || "pump fouling flow current");
    $("#kres").innerHTML = res.map((d) => `<div class="doc" data-docid="${esc(d.id)}"><span class="k">${d.kind}</span><code>${esc(d.id)}</code> ${esc(d.title)}<div class="note">${esc(d.text.slice(0, 170))}…</div></div>`).join("") || '<div class="note">No results.</div>';
    $("#kres").querySelectorAll("[data-docid]").forEach((el) => (el.onclick = async () => showDoc(await api.doc(el.dataset.docid))));
  };
  $("#kq").onkeydown = (e) => e.key === "Enter" && run();
  $("#kgo").onclick = async () => {
    $("#kans").innerHTML = '<div class="note">Thinking…</div>';
    const a = await api.query($("#kask").value, S.diag?.asset?.asset_id);
    $("#kans").innerHTML = `<div class="narr">${cites(a.text)}</div><div class="note">${esc(a.mode)}</div>`;
  };
  run();
}

// ------------------------------------------------------------------ command bar
function renderSuggestions() {
  const s = ["Where is the faulty pump?", "Find the equipment with abnormal vibration", "Send a technician to inspect the faulty pump",
    "Show me the relevant manual", "Can I practise inspecting this equipment?"];
  $("#sugg").innerHTML = s.map((x) => `<button>${x}</button>`).join("");
  $("#sugg").onclick = (e) => { if (e.target.tagName === "BUTTON") { $("#cmdInput").value = e.target.textContent; ask(); } };
}
export async function ask(text) {
  const q = text ?? $("#cmdInput").value.trim();
  if (!q) return;
  const box = $("#answer");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="who">COPILOT</div><div class="note">Working on “${esc(q)}”…</div>`;
  try {
    const r = await api.command(q, S.selected?.asset?.asset_id || S.diag?.asset?.asset_id);
    box.innerHTML = `<button class="close" onclick="this.parentElement.classList.add('hidden')">✕</button><div class="who">COPILOT · ${r.intent === "command" ? "ACTION" : "ANSWER"}</div>${cites(r.text)}`;
    for (const a of r.actions || []) {
      if (a.type === "select" && a.asset_id) { if (S.mode !== "facility") setMode("facility"); await selectAsset(a.asset_id, { fly: !r.actions.some((x) => x.type === "navigate") }); }
      if (a.type === "navigate") await dispatch(a.asset_id);
      if (a.type === "xray") await enterXRay();
      if (a.type === "practice") setMode("practice");
      if (a.type === "learn") setMode("learn");
      if (a.type === "knowledge") setMode("knowledge");
    }
  } catch (e) {
    box.innerHTML = `<div class="who">COPILOT</div>Error: ${esc(e.message)}`;
  }
  $("#cmdInput").value = "";
}
$("#cmdSend").onclick = () => ask();
$("#cmdInput").onkeydown = (e) => e.key === "Enter" && ask();

// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (S.mode === "facility") {
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(S.fac.pickables(), false);
    if (hits.length) {
      // prefer the smallest frame under the cursor (nested objects)
      hits.sort((a, b) => {
        const sa = a.object.parent.scale, sb = b.object.parent.scale;
        return sa.x * sa.y * sa.z - sb.x * sb.y * sb.z;
      });
      const o = S.data.objects.find((x) => x.id === hits[0].object.userData.objectId);
      if (o) selectObject(o);
    }
  } else {
    ray.setFromCamera(ndc, xCam);
    const hits = ray.intersectObjects(S.xray.pickables(), false);
    if (hits.length) selectComponent(hits[0].object.userData.componentId);
  }
});

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
const QA = new URLSearchParams(location.search).has("qa");   // headless screenshots: throttle software rendering
let lastQA = -1e9;
renderer.setAnimationLoop(() => {
  if (QA) { const now = performance.now(); if (now - lastQA < 2500) return; lastQA = now; }
  const dt = QA ? 0.05 : Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  updateTween(dt);
  if (!S.fac) return;
  if (["xray", "learn", "practice"].includes(S.mode)) {
    S.xray.update(dt, t);
    xControls.update();
    renderer.render(S.xray.scene, xCam);
  } else {
    updateRobot(dt);
    if (S.target) S.fac.pulse(t, [S.target.id]);
    controls.update();
    renderer.render(facScene, camera);
    labels.render(facScene, camera);
  }
});

window.__app = S;
Object.assign(window, { __dispatch: dispatch, __enterXRay: enterXRay, __setMode: setMode, __ask: ask, __block: blockWalkway, __select: selectAsset });
boot();
