// Scene layers for understanding an unfamiliar site before arriving: semantic view, clean scan, site map,
// hover / selection outlines and "show uncertain". Registers itself through ext.js; the visuals are Facility methods.
import "./layers.css";
import { addRailButton, on, APP } from "./ext.js";
import { CATEGORIES, catOf, isUncertain, UNCERTAIN_BELOW } from "./semantic.js";
import { drawSiteMap, pickSiteMap } from "./sitemap.js";

const L = { tick: 0, legend: null, grid: null, hoverNdc: null, hoverDirty: false, mapView: null, mapHover: null };
const fac = () => APP.S?.fac;
const toast = (m, ms) => APP.toast?.(m, ms);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0");

// ------------------------------------------------------------------ rail buttons
addRailButton({ id: "semantic", icon: "layers", sceneOnly: true, title: "Semantic view: every object coloured by type",
  isOn: () => !!fac()?.semantic,
  onClick: () => { setSemantic(!fac().semantic); } });
addRailButton({ id: "clean", icon: "spark", sceneOnly: true, title: "Clean scan: hide haze and floating specks",
  isOn: () => !!fac()?.cleanScan,
  onClick: () => {
    const f = fac(); f.setCleanScan(!f.cleanScan);
    const st = f.scanStats;
    toast(f.cleanScan
      ? (st.splats ? `Clean scan: <b>${pct(st.haze, st.splats)}%</b> of the splats hidden (haze, floaters, specks).` : "Clean scan on. It applies as the scan loads.")
      : "Full scan shown.", 2600);
  } });
addRailButton({ id: "sitemap", icon: "map", sceneOnly: true, title: "Site map: overhead floor plan by object type", isOn: () => !!L.mapOpen, onClick: () => openSiteMap() });

// a distinct icon for the site map (icons.js has no floor-plan glyph; main.js renders the rail before boot)
const PLAN_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v16H3z"/><path d="M3 11h7v9M14 4v6h7M10 15h4"/></svg>';

function setSemantic(on) {
  const f = fac(); f.setSemantic(on);
  renderLegend();
  APP.renderRail?.();
}
function setUncertain(on) {
  const f = fac(); f.setShowUncertain(on);
  renderLegend();
  if (on) { const n = f.categoryCounts().uncertain; toast(`<b>${n}</b> objects have an uncertain label (below ${Math.round(UNCERTAIN_BELOW * 100)}% or only "other equipment"). Hatched in white.`, 4200); }
}

// ------------------------------------------------------------------ semantic legend (above the dock)
function renderLegend() {
  const f = fac(), show = f && (f.semantic || f.showUncertain) && APP.sceneMode?.();
  if (!L.legend) {
    L.legend = document.createElement("div"); L.legend.className = "sem-legend hidden"; L.legend.setAttribute("aria-label", "Semantic view legend");
    L.legend.addEventListener("click", (e) => {
      if (e.target.closest("[data-unc]")) setUncertain(!fac().showUncertain);
      if (e.target.closest("[data-sem-off]")) { setSemantic(false); if (fac().showUncertain) setUncertain(false); }
    });
    document.querySelector("#app").appendChild(L.legend);
  }
  L.legend.classList.toggle("hidden", !show);
  if (!show) return;
  const n = f.categoryCounts();
  L.legend.innerHTML = (f.semantic ? CATEGORIES.filter((c) => n[c.id]).map((c) => `<span class="it"><span class="sw" style="background:${c.color}"></span>${c.short}<small>${n[c.id]}</small></span>`).join("")
    + '<span class="sep"></span><span class="it" title="Ring on the floor: asset condition"><span class="ring"></span>Asset condition</span>' : "")
    + `<span class="sep"></span><button class="it ${f.showUncertain ? "on" : ""}" data-unc title="Highlight objects whose label is a guess"><span class="hatch"></span>Show uncertain<small>${n.uncertain}</small></button>`
    + '<button class="it" data-sem-off title="Back to the plain scan" aria-label="Close semantic view">✕</button>';
  placeLegend();
}
function placeLegend() {
  if (!L.legend || L.legend.classList.contains("hidden")) return;
  // centred over the dock, inside the gap between the left and right cards
  const vis = (el) => el && getComputedStyle(el).display !== "none" && !el.classList.contains("hidden") && el.getBoundingClientRect().height > 0;
  const d = document.querySelector("#dock"), lc = document.querySelector("#left"), rc = document.querySelector("#right");
  const r = vis(d) ? d.getBoundingClientRect() : null;
  const x0 = vis(lc) ? lc.getBoundingClientRect().right + 12 : 24, x1 = vis(rc) ? rc.getBoundingClientRect().left - 12 : innerWidth - 64;
  const cx = r ? (r.left + r.right) / 2 : (x0 + x1) / 2, half = Math.max(160, Math.min(cx - x0, x1 - cx));
  Object.assign(L.legend.style, { bottom: r ? `${Math.round(innerHeight - r.top + 10)}px` : "24px", left: `${Math.round(cx)}px`, maxWidth: `${Math.round(2 * half)}px` });
}
addEventListener("resize", placeLegend);

// ------------------------------------------------------------------ site map sheet
async function openSiteMap() {
  const A = APP, f = fac();
  L.grid ||= await A.api.grid().catch(() => null);
  L.mapOpen = true;
  A.sheet("Site map", `<div class="sitemap-bar"><span class="note">Seen from above. Colour = what it is, dot = asset condition. Click anything to fly there.</span>
      <span class="row" style="display:flex;gap:6px"><button class="chip ${f.showUncertain ? "on" : ""}" data-sm-unc>Show uncertain</button>
      <button class="chip" data-sm-png>Download PNG</button></span></div>
    <canvas class="sitemap" aria-label="Overhead floor plan of the scanned room, coloured by object type"></canvas>
    <div class="sitemap-info" id="smInfo">&nbsp;</div>`);
  const sheet = document.querySelector("#sheet"), cv = sheet.querySelector("canvas.sitemap");
  if (innerWidth > 820) Object.assign(sheet.style, { width: "min(760px, calc(100% - 48px))", maxHeight: "calc(100% - 108px)" });   // a plan needs room
  const draw = () => {
    if (!cv.isConnected) return;
    const w = cv.clientWidth || 600, b = A.S.data.bounds, h = Math.round(Math.min(innerHeight - 268, Math.max(380, (w - 214) * ((b.max[2] - b.min[2]) / (b.max[0] - b.min[0])) + 56)));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L.mapView = drawSiteMap(ctx, { data: A.S.data, grid: L.grid, w, h, hover: L.mapHover, showUncertain: fac().showUncertain });
  };
  draw();
  const at = (e) => { const r = cv.getBoundingClientRect(); return pickSiteMap(A.S.data, L.mapView, e.clientX - r.left, e.clientY - r.top); };
  cv.onpointermove = (e) => {
    const o = at(e);
    if (o === L.mapHover) return;
    L.mapHover = o; draw();
    const info = sheet.querySelector("#smInfo");
    info.innerHTML = o ? (o.asset ? `<code>${o.asset.tag}</code> · ${o.label} · <span class="status s-${o.asset.condition_state}">${o.asset.condition_state.replace("_", " ")}</span>`
      : `<b>${o.label}</b> · ${CATEGORIES.find((c) => c.id === catOf(o)).label} · ${Math.round(o.confidence * 100)}%${isUncertain(o) ? " · uncertain" : ""}`) : "&nbsp;";
  };
  cv.onpointerleave = () => { if (L.mapHover) { L.mapHover = null; draw(); } };
  cv.onclick = (e) => {
    const o = at(e); if (!o) return;
    sheet.classList.add("hidden"); L.mapHover = null;
    A.S.cam = "free"; A.renderDock?.();
    A.selectObject(o, { fly: true });
  };
  sheet.querySelector("[data-sm-unc]").onclick = (e) => { setUncertain(!fac().showUncertain); e.currentTarget.classList.toggle("on", fac().showUncertain); draw(); };
  sheet.querySelector("[data-sm-png]").onclick = () => downloadPNG();
  // the sheet is shared (library, documents): notice when it closes or is replaced
  L.mapObserver?.disconnect();
  L.mapObserver = new MutationObserver(() => {
    if (!sheet.classList.contains("hidden") && cv.isConnected) return;
    L.mapOpen = false; L.mapObserver.disconnect(); sheet.style.width = sheet.style.maxHeight = ""; A.renderRail?.();
  });
  L.mapObserver.observe(sheet, { attributes: true, attributeFilter: ["class"], childList: true });
}

/** Self-contained PNG (title, legend, scale bar) at print resolution. */
export function siteMapCanvas(scale = 2) {
  const w = 980, b = APP.S.data.bounds, h = Math.round((w - 214) * ((b.max[2] - b.min[2]) / (b.max[0] - b.min[0])) + 110);
  const c = document.createElement("canvas"); c.width = w * scale; c.height = h * scale;
  const ctx = c.getContext("2d"); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawSiteMap(ctx, { data: APP.S.data, grid: L.grid, w, h, showUncertain: fac().showUncertain, title: true });
  return c;
}
function downloadPNG() {
  const c = siteMapCanvas(2), name = (APP.S.data.site?.name || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  c.toBlob((blob) => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name}-site-map.png`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}

// ------------------------------------------------------------------ hover + selection outline
on("boot", (A) => {
  const b = document.querySelector('#rail [data-rail="x:sitemap"]'); if (b) b.innerHTML = PLAN_ICON;
  A.canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons) { if (L.hoverNdc) { L.hoverNdc = null; L.hoverDirty = true; } return; }
    (L.hoverNdc ||= { x: 0, y: 0 }).x = (e.clientX / innerWidth) * 2 - 1; L.hoverNdc.y = -(e.clientY / innerHeight) * 2 + 1;
    L.hoverDirty = true;
  });
  A.canvas.addEventListener("pointerleave", () => { L.hoverNdc = null; L.hoverDirty = true; });
  A.canvas.addEventListener("pointerdown", () => { L.hoverNdc = null; L.hoverDirty = true; });
  L.ray = new A.THREE.Raycaster(); L.ndc = new A.THREE.Vector2();
});
// picking at most once per rendered frame, only after the mouse moved (no allocations per frame)
on("frame", () => {
  const f = fac(), A = APP; if (!f) return;
  if (++L.tick % 30 === 0 && L.legend && !L.legend.classList.contains("hidden")) placeLegend();   // the dock changes height
  const sel = A.S.selected?.id ?? null;
  if (sel !== f.outlineId) f.setOutline(sel);
  if (!L.hoverDirty) return;
  L.hoverDirty = false;
  if (!L.hoverNdc || A.S.robot?.moving) return f.setHover(null);
  L.ray.setFromCamera(L.ndc.set(L.hoverNdc.x, L.hoverNdc.y), A.camera);
  const id = f.pick(L.ray.ray);
  f.setHover(id);
  A.canvas.style.cursor = id ? "pointer" : "";
});
window.__layers = { L, siteMapCanvas, setSemantic, setUncertain, openSiteMap };   // tests
on("modeChange", (mode) => {
  const f = fac(); if (!f) return;
  if (!APP.sceneMode?.(mode)) { f.setHover(null); f.setOutline(null); }
  renderLegend();
});
