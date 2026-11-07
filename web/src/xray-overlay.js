// In-scene X-Ray: the exploded teaching model of a scene asset in a panel ON TOP of the facility view, plus the
// arrival prompt that leads there. The facility keeps rendering full-frame behind the panel; the X-Ray scene of
// xray.js (S.xray, the same instance the full X-Ray tab uses) is drawn into the panel's rectangle with a scissor and
// its own camera + OrbitControls bound to the panel, so the room's controls stay inert while you turn the model.
// Nothing is drawn while the panel is closed (main.js calls render() only when APP.xo.open).
//   APP.xo.show(assetId, { focus })  open for an asset (loads its class model + diagnosis through main.prepareXRay)
//   APP.xo.close()                   close; the room camera pose/mode, robot state and selection come back exactly
//   APP.arrival.show(object)         contextual "You've arrived" prompt anchored to the asset in the scene
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { APP, on } from "./ext.js";
import { icon } from "./icons.js";
import { esc, nice, pad, kv, signalName } from "./ui.js";
import "./xray-overlay.css";

const PROV = "Illustrative teaching model — not reconstructed from the scan";
const XO = { open: false, token: 0, cam: null, ctl: null, el: null, view: null, lbl: null, lsize: [0, 0], saved: null, assetId: null,
  stats: { ms: 0, n: 0 } };
const phone = () => innerWidth <= 820;

// ------------------------------------------------------------------ DOM
function build() {
  if (XO.el) return;
  const el = document.createElement("section");
  el.className = "xo hidden"; el.id = "xo";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "X-Ray: inside the equipment");
  el.innerHTML = `
    <header class="xo-h"><div class="xo-title" id="xoTitle"></div>
      <div class="xo-tools"><button type="button" class="btn xo-full" data-xo="full" title="Leave the room and open the full X-Ray studio">${icon("expand")}<span>Open full X-Ray view</span></button>
        <button type="button" class="xo-x" data-xo="close" title="Close (Esc)" aria-label="Close X-Ray">${icon("close")}</button></div></header>
    <div class="xo-main">
      <div class="xo-view" id="xoView" aria-label="Exploded model: drag to rotate, scroll to zoom, click a part">
        <div class="xo-lbl"></div>
        <div class="xo-badge">${icon("layers")}<span>${PROV}</span></div>
        <div class="xo-legend"><span><i class="sus"></i>Suspected</span><span><i class="alt"></i>Alternative</span><span><i class="sel"></i>Selected</span></div>
        <div class="xo-hint">Drag to rotate · scroll to zoom · click a part</div>
      </div>
      <aside class="xo-side"><div class="xo-list" id="xoList"></div><div class="xo-part" id="xoPart"></div></aside>
    </div>
    <footer class="xo-f">
      <div class="xo-slider"><div class="top"><span>Explode</span><span id="xoPct"></span></div><input type="range" id="xoExplode" min="0" max="100" aria-label="Explode the model"/></div>
      <div class="xo-btns">
        <button type="button" class="tool" data-xo="assemble">${icon("cube")}Assemble</button>
        <button type="button" class="tool" data-xo="ghost"><span class="switch"></span>See-through</button>
        <button type="button" class="tool" data-xo="labels"><span class="switch"></span>Labels</button>
        <button type="button" class="tool" data-xo="home">${icon("reset")}Reset view</button></div>
    </footer>`;
  document.getElementById("app").appendChild(el);
  XO.el = el; XO.view = el.querySelector("#xoView");
  // labels of the X-Ray scene for this panel (the full-screen view has its own renderer in main.js)
  XO.lbl = new CSS2DRenderer({ element: el.querySelector(".xo-lbl") });
  XO.cam = new THREE.PerspectiveCamera(38, 1.4, 0.02, 60);
  XO.ctl = new OrbitControls(XO.cam, XO.view);
  Object.assign(XO.ctl, { enableDamping: true, minDistance: 0.9, maxDistance: 12, maxPolarAngle: Math.PI * 0.48, enabled: false });
  el.addEventListener("click", onClick);
  el.querySelector("#xoExplode").addEventListener("input", (e) => { APP.S.xray.setExplode(e.target.value / 100); footer(); });
  // click (not drag) on the model selects a part
  let down = null;
  XO.view.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  XO.view.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const r = XO.view.getBoundingClientRect(), ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, XO.cam);
    const hit = ray.intersectObjects(APP.S.xray.pickables(), false)[0];
    if (hit) pick(hit.object.userData.componentId, { fly: false });
  });
  XO.view.addEventListener("contextmenu", (e) => e.preventDefault());
}

function onClick(e) {
  const S = APP.S, X = S.xray;
  const c = e.target.closest("[data-xo-comp]"); if (c) return pick(c.dataset.xoComp);
  const a = e.target.closest("[data-xo]")?.dataset.xo; if (!a) return;
  if (a === "close") return close();
  if (a === "full") { const id = XO.assetId, f = S.xSelected; close(); return APP.enterXRay(f ? [f] : null, id); }
  if (a === "assemble") { X.setExplode(X.target > 0.05 ? 0 : 0.65); footer(); }
  if (a === "ghost") { X.setGhost(!X.ghost); footer(); }
  if (a === "labels") { X.setLabels(!X.labelsOn); footer(); }
  if (a === "home") { X.isolate(null); const h = home(); APP.flyTo(h.pos, h.tgt, 0.9, XO.cam, XO.ctl); side(); }
  if (a === "isolate") { X.isolate(X.hidden.size === 0 ? S.xSelected : null); side(); }
  if (a === "diag") { close(); APP.S.cardLock = true; APP.renderDiagnosis?.(); document.getElementById("right")?.classList.remove("min"); }
}

const xDef = () => APP.S.kb.classes[APP.S.xClass];
function title() {
  const S = APP.S, a = S.xAsset, d = xDef();
  document.getElementById("xoTitle").innerHTML = `<div class="xo-eyebrow"><span>X-Ray · <b>${esc(a.tag)}</b> · ${esc(d.label)}</span>
      <span class="status s-${a.condition_state}">${nice(a.condition_state)}</span></div>
    <div class="xo-name">${esc(d.model_title || d.label)}</div>`;
}
function side() {
  const S = APP.S, D = S.xDiag, X = S.xray;
  const lead = new Set(D?.hypotheses?.[0]?.components || []), alt = new Set((D?.hypotheses || []).slice(1).flatMap((h) => h.components));
  const list = X.order().map((id, i) => {
    const c = xDef().components.find((x) => x.id === id); if (!c) return "";
    return `<button type="button" class="xo-row ${S.xSelected === id ? "on" : ""}" data-xo-comp="${id}"><span class="n">${pad(i + 1)}</span><span class="nm">${esc(c.name)}</span>
      ${lead.has(id) ? '<span class="pill red">Suspected</span>' : alt.has(id) ? '<span class="pill amber">Alternative</span>' : ""}</button>`;
  }).join("");
  const L = document.getElementById("xoList"), top = L.scrollTop;
  L.innerHTML = `<div class="xo-lh"><span>Components</span><span>${X.order().length}</span></div>${list}`;
  L.scrollTop = top;
  const on = L.querySelector(".xo-row.on");
  if (on && (on.offsetTop < L.scrollTop || on.offsetTop + on.offsetHeight > L.scrollTop + L.clientHeight)) L.scrollTop = on.offsetTop - L.clientHeight / 2 + on.offsetHeight / 2;
  document.getElementById("xoPart").innerHTML = partHTML();
  document.getElementById("xoPart").scrollTop = 0;
}
/** Compact component explanation (the same library data as the full X-Ray part card). */
function partHTML() {
  const S = APP.S, D = S.xDiag, c = xDef().components.find((x) => x.id === S.xSelected);
  const lead = D?.hypotheses?.[0];
  // a healthy asset has no fault hypothesis worth showing (the engine's placeholder reads "Unspecified deviation")
  const healthy = S.xAsset?.condition_state === "healthy" || S.xAsset?.issue_code === "NORMAL";
  if (!c) return `<p class="p">${esc(xDef().function)}</p>${lead?.components?.length ? "" : `<p class="note">${healthy ? `No deviation for ${esc(S.xAsset.tag)} in the synthetic data, so no part is singled out.` : esc(lead?.hypothesis || "No component is singled out by the evidence.")}</p>`}<p class="note">Select a part in the model or the list.</p>`;
  const sus = (lead?.components || []).includes(c.id);
  const tel = Object.fromEntries((D?.telemetry?.signals || []).map((s) => [s.signal, s]));
  const sig = c.evidence_signals.map((s) => tel[s]).filter(Boolean)
    .map((t) => { const hot = t.abnormal || Math.abs(t.z_vs_peers ?? 0) >= 1.5; return `<span class="xo-sig ${hot ? "hot" : ""}">${esc(signalName(t.signal))} <b>z ${t.z_vs_peers}</b></span>`; }).join("");
  return `<div class="xo-ph"><small>${nice(c.group)}</small><b>${esc(c.name)}</b>${sus ? `<span class="pill red">Suspected for ${esc(D.asset.tag)}</span>` : ""}</div>
    <p class="p">${esc(c.function)}</p>
    ${sus && lead?.hypothesis ? `<p class="xo-why">${icon("spark")}<span>${esc(lead.hypothesis)}</span></p>` : ""}
    ${kv("Linked faults", c.issue_codes.map(nice).join(", ") || "–")}
    <div class="label xo-l">Typical failure signs</div><ul class="xo-signs">${c.failure_symptoms.slice(0, 3).map((s) => `<li>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</li>`).join("")}</ul>
    ${sig ? `<div class="label xo-l">Signals on ${esc(D.asset.tag)}</div><div class="xo-sigs">${sig}</div>` : ""}
    <div class="xo-acts"><button type="button" class="btn" data-xo="isolate">${icon("target")}${S.xray.hidden.size ? "Show all parts" : "Show only this part"}</button>
      <button type="button" class="btn" data-xo="diag">${icon("doc")}Diagnosis</button></div>`;
}
function footer() {
  const X = APP.S.xray, pct = Math.round(X.target * 100), el = XO.el;
  el.querySelector("#xoPct").textContent = `${pct}%`;
  const sl = el.querySelector("#xoExplode"); if (document.activeElement !== sl) sl.value = pct;
  el.querySelector('[data-xo="ghost"]').classList.toggle("on", X.ghost);
  el.querySelector('[data-xo="labels"]').classList.toggle("on", X.labelsOn);
  el.querySelector('[data-xo="assemble"]').innerHTML = `${icon(X.target > 0.05 ? "cube" : "expand")}${X.target > 0.05 ? "Assemble" : "Explode"}`;
}

// ------------------------------------------------------------------ camera framing in the panel
function home() {
  const h = APP.S.xray.home || { pos: new THREE.Vector3(2.4, 2.1, 4.4), tgt: new THREE.Vector3(0, 0.5, 0) };
  const r = XO.view.getBoundingClientRect(), aspect = r.width && r.height ? r.width / r.height : 1.4;
  // xray.js frames the model for a full screen; a narrower panel needs a step back to keep it all in view
  const k = Math.max(0.82, 1.12 / aspect);
  return { pos: h.tgt.clone().add(h.pos.clone().sub(h.tgt).multiplyScalar(k)), tgt: h.tgt.clone() };
}
function focusPart(id) {
  const X = APP.S.xray; if (!X.parts.has(id)) return;
  const c = X.partCenter(id), h = home(), dir = h.pos.clone().sub(h.tgt).normalize();
  APP.flyTo(c.clone().addScaledVector(dir, h.pos.distanceTo(h.tgt) * 0.62), c, 0.9, XO.cam, XO.ctl);
}
function pick(id, { fly = true } = {}) {
  const X = APP.S.xray;
  if (X.hidden.size && X.parts.has(id)) X.isolate(id);   // "Show only this part" follows the selection (never select a hidden part)
  APP.selectComponent(id);                 // shared selection logic (S.xSelected, model highlight, Learn/Practice hooks)
  side();
  if (fly) focusPart(id);
}

// ------------------------------------------------------------------ open / close
/** Open the panel for an asset. Returns true when it opened. */
async function show(assetId, { focus = null } = {}) {
  const A = APP, S = A.S;
  if (!S?.fac || !A.sceneMode()) return false;
  const tok = ++XO.token;
  if (!(await A.prepareXRay(assetId))) return false;
  if (tok !== XO.token || !A.sceneMode()) return false;
  build();
  if (!XO.open) save();
  XO.open = true; XO.assetId = S.xAsset.asset_id;
  const lead = S.xDiag.hypotheses[0]?.components || [];
  S.xSelected = focus && S.xray.parts.has(focus) ? focus : lead[0] || null; S.xray.selected = S.xSelected;
  S.xray.isolate(null);
  XO.el.classList.remove("hidden"); document.body.classList.add("xo-open");
  XO.ctl.enabled = true;
  title(); side(); footer();
  // fly in from further out while the model assembles, then explode it (same choreography as the full X-Ray)
  const h = home();
  XO.cam.position.copy(h.pos).sub(h.tgt).multiplyScalar(1.35).add(h.tgt); XO.ctl.target.copy(h.tgt);
  A.flyTo(h.pos, h.tgt, 1.1, XO.cam, XO.ctl);
  S.xray.explode = 0; S.xray.setExplode(0);
  setTimeout(() => { if (XO.open && tok === XO.token) { S.xray.setExplode(0.65); footer(); } }, 450);
  if (focus) setTimeout(() => { if (XO.open && tok === XO.token && S.xSelected) focusPart(S.xSelected); }, 1500);
  footer();
  hideArrival();
  XO.el.querySelector('[data-xo="close"]').focus({ preventScroll: true });
  return true;
}
/** Freeze the room while the panel is open: camera pose + mode, robot motion, selection. */
function save() {
  const A = APP, S = A.S, R = S.robot;
  XO.saved = { cam: S.cam, pos: A.camera.position.clone(), tgt: A.controls.target.clone(), ctl: A.controls.enabled, selected: S.selected,
    robot: { moving: R.moving, v: R.v, s: R.s, dir: R.dir, follow: R.follow, curve: S.curve } };
  A.cancelTween();
  A.controls.enabled = false;
  if (R.moving) { R.moving = false; A.renderDock(); }
  R.follow = 0;
}
function close({ restore = true } = {}) {
  if (!XO.open) return;
  const A = APP, S = A.S, R = S.robot, v = XO.saved;
  XO.open = false; XO.token++;
  XO.ctl.enabled = false;
  XO.el.classList.add("hidden"); document.body.classList.remove("xo-open");
  holes(null);
  S.xray.isolate(null);
  if (v) {
    if (restore) {
      S.cam = v.cam; A.cancelTween();
      A.camera.position.copy(v.pos); A.controls.target.copy(v.tgt); A.camera.lookAt(v.tgt);
      A.controls.enabled = v.ctl;
      S.selected = v.selected;
    }
    // the robot carries on exactly as before, unless the user drove it from the dock in the meantime
    if (S.curve === v.robot.curve && !R.moving && Math.abs(R.s - v.robot.s) < 1e-9) Object.assign(R, { moving: v.robot.moving, v: v.robot.v, dir: v.robot.dir });
    R.follow = v.robot.follow;
    try { if (A.sceneMode()) A.renderDock(); } catch (e) { console.warn(e); }
  }
  XO.saved = null;
  refreshArrival();
}

// ------------------------------------------------------------------ rendering (called by main.js after the room)
const _sz = new THREE.Vector2();
function render(dt, t) {
  const r = XO.view.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return;
  const t0 = performance.now(), S = APP.S, R = APP.renderer;
  const aspect = r.width / r.height;
  if (Math.abs(XO.cam.aspect - aspect) > 1e-3) { XO.cam.aspect = aspect; XO.cam.updateProjectionMatrix(); }
  S.xray.update(dt, t);
  XO.ctl.update();
  R.getSize(_sz);
  const y = _sz.y - r.bottom;
  R.setScissorTest(true); R.setScissor(r.left, y, r.width, r.height); R.setViewport(r.left, y, r.width, r.height);
  R.render(S.xray.scene, XO.cam);
  R.setScissorTest(false); R.setViewport(0, 0, _sz.x, _sz.y);
  if (XO.lsize[0] !== r.width || XO.lsize[1] !== r.height) { XO.lsize = [r.width, r.height]; XO.lbl.setSize(r.width, r.height); }
  holes(r);
  XO.lbl.render(S.xray.scene, XO.cam);
  const ms = performance.now() - t0;
  XO.stats.ms = XO.stats.n ? XO.stats.ms * 0.9 + ms * 0.1 : ms; XO.stats.n++;
}

/** The model is drawn into the canvas UNDER the page's DOM layers, so the room's own overlays (asset labels, vignette)
 *  get a hole cut where the panel's view is; cards that could sit under it are hidden by CSS (body.xo-open). */
let holeKey = "";
function holes(r) {
  const key = r ? `${r.left|0},${r.top|0},${r.width|0},${r.height|0},${innerWidth},${innerHeight}` : "";
  if (key === holeKey) return;
  holeKey = key;
  const clip = r ? `path(evenodd, "M0 0H${innerWidth}V${innerHeight}H0Z M${r.left} ${r.top}h${r.width}v${r.height}h${-r.width}Z")` : "";
  for (const sel of [".labels", ".vignette"]) { const n = document.querySelector(sel); if (n) n.style.clipPath = clip; }
}

// ------------------------------------------------------------------ arrival prompt (anchored to the asset in the scene)
const AR = { el: null, obj: null, at: null };
function buildArrival() {
  if (AR.el) return;
  AR.el = document.createElement("div");
  AR.el.className = "arrive hidden"; AR.el.id = "arrive"; AR.el.setAttribute("role", "dialog"); AR.el.setAttribute("aria-label", "Robot arrived");
  document.getElementById("app").appendChild(AR.el);
  AR.el.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-ap]")?.dataset.ap; if (!a) return;
    const A = APP, S = A.S, o = AR.obj;
    hideArrival(true);
    if (a === "inspect") {
      S.selected = o; S.cardLock = false;
      A.selectObject(o);
      S.fac.setHighlighted([], { selected: o.id, target: o.id });     // calm room behind the panel: just this asset
      if (!A.modes.get(S.mode)?.ownsCard) { A.renderAssetCard(o); document.getElementById("right")?.classList.remove("min"); }
      if (S.kb.classes[o.asset.asset_class]) await show(o.asset.asset_id);
    }
    if (a === "diag") {
      S.cardLock = true;
      if (S.diagPromise && !S.diag) S.diag = await S.diagPromise;
      S.tab = "overview"; A.renderDiagnosis(); const rc = document.getElementById("right"); rc?.classList.remove("min"); rc?.classList.add("flash"); setTimeout(() => rc?.classList.remove("flash"), 900);
    }
  });
}
/** Show "You've arrived at …" for the destination. Returns false when the prompt does not apply (caller toasts). */
function showArrival(o) {
  const S = APP.S;
  if (!o?.asset || APP.modes.get(S.mode)?.ownsCard || !APP.sceneMode()) return false;
  buildArrival();
  AR.obj = o; AR.at = S.curve; AR.dismissed = false;
  const a = o.asset, model = !!S.kb.classes[a.asset_class];
  AR.el.innerHTML = `<div class="ap-card">
      <button type="button" class="ap-x" data-ap="close" title="Dismiss" aria-label="Dismiss">${icon("close")}</button>
      <div class="ap-eye"><i></i>Robot arrived · ${S.robot.len ? S.robot.len.toFixed(1) + " m driven" : "on site"}</div>
      <div class="ap-t">You've arrived at ${esc(a.tag)}</div>
      <div class="ap-sub">${esc(nice(a.asset_class))} · <span class="status s-${a.condition_state}">${nice(a.condition_state)}</span> · health ${a.health_score}</div>
      <div class="ap-acts"><button type="button" class="btn primary" data-ap="inspect">${icon(model ? "layers" : "target")}Inspect equipment</button>
        <button type="button" class="btn" data-ap="diag">${icon("spark")}See diagnosis</button></div></div><div class="ap-stem"></div>`;
  AR.el.classList.remove("hidden");
  AR.rc = null; place();
  return true;
}
function hideArrival(dismiss = false) { if (!AR.el) return; AR.el.classList.add("hidden"); if (dismiss) AR.dismissed = true; }
/** After the X-Ray panel closes: bring the prompt back if the robot is still standing at the destination. */
function refreshArrival() { if (AR.el && AR.obj && !AR.dismissed && valid()) { AR.el.classList.remove("hidden"); place(); } }
function valid() {
  const S = APP.S, R = S.robot;
  return !!(AR.obj && S.curve && S.curve === AR.at && R.arrived && R.s >= R.len - 0.05 && APP.sceneMode() && !APP.modes.get(S.mode)?.ownsCard && !XO.open);
}
const _p = new THREE.Vector3();
function rectOf(id) { const n = document.getElementById(id); if (!n || n.classList.contains("hidden") || getComputedStyle(n).display === "none") return null; const r = n.getBoundingClientRect(); return r.width && r.height ? r : null; }
/** Keep the prompt next to the asset on screen, clear of the cards; dock it top-centre when the asset is out of view. */
function place() {
  if (!AR.el || AR.el.classList.contains("hidden")) return;
  const A = APP, o = AR.obj, cam = A.camera, now = performance.now();
  // layout reads (style + rects) at 4 Hz; the projection itself every frame, so the prompt sticks to the asset
  if (!AR.rc || now - AR.rc.t > 250) AR.rc = { t: now, L: rectOf("left"), Rc: rectOf("right"), D: rectOf("dock"), H: rectOf("povHud"), w: AR.el.offsetWidth || 320, h: AR.el.offsetHeight || 150 };
  const { L, Rc, D, H, w, h } = AR.rc;
  // free area: between the cards, below the mode bar + guide strip + toasts, above the dock and the POV HUD
  let x0 = 16, x1 = innerWidth - 16, y0 = 132, y1 = innerHeight - 16;
  if (phone()) { y0 = D ? D.bottom + 10 : 150; if (Rc) y1 = Rc.top - 10; }
  else { if (L) x0 = L.right + 16; if (Rc) x1 = Rc.left - 16; if (D) y1 = D.top - 12; x1 = Math.min(x1, innerWidth - 60); }
  if (H) y1 = Math.min(y1, H.top - 10);
  _p.set(o.center[0], o.center[1] + o.size[1] / 2 + 0.12, o.center[2]).project(cam);
  let anchored = _p.z > -1 && _p.z < 1;
  let x = ((_p.x + 1) / 2) * innerWidth, y = ((1 - _p.y) / 2) * innerHeight - 30;     // clear of the asset's own tag
  // asset off screen or behind a card: park the prompt low in the free area, where nothing else lives
  if (!anchored || x < x0 || x > x1 || y < y0 + h * 0.5 || y > y1 + 40) { anchored = false; x = (x0 + x1) / 2; y = y1; }
  x = Math.max(x0 + w / 2, Math.min(x1 - w / 2, x));
  y = Math.max(y0 + h, Math.min(y1, y));
  if (x1 - x0 < w) x = innerWidth / 2;
  AR.el.style.transform = `translate(${Math.round(x - w / 2)}px, ${Math.round(y - h)}px)`;
  AR.el.classList.toggle("anchored", anchored);
}

// ------------------------------------------------------------------ wiring
on("boot", (A) => {
  A.xo = { show, close, render, get open() { return XO.open; }, get cam() { return XO.cam; }, get ctl() { return XO.ctl; }, stats: XO.stats, home };
  A.arrival = { show: showArrival, hide: hideArrival, get visible() { return !!AR.el && !AR.el.classList.contains("hidden"); } };
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (XO.open) { e.stopImmediatePropagation(); close(); } else if (AR.el && !AR.el.classList.contains("hidden")) hideArrival(true);
  }, true);
  addEventListener("resize", () => { if (XO.open) { const h = home(); A.flyTo(h.pos, h.tgt, 0.3, XO.cam, XO.ctl); } });
});
on("modeChange", () => { if (XO.open) close({ restore: false }); if (AR.el && !valid()) hideArrival(); });
on("frame", () => {
  // the prompt stays with the destination: hidden while the robot is scrubbed away or the panel is open, back on return
  if (!AR.el || !AR.obj || AR.dismissed) return;
  const hidden = AR.el.classList.contains("hidden");
  if (!valid()) { if (!hidden) hideArrival(); return; }
  if (hidden) AR.el.classList.remove("hidden");
  place();
});
