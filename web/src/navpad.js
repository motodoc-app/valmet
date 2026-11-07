// On-screen navigation pad + game-style keyboard control for people without a touch screen or a mouse.
//   Pad: walk forward/back/left/right (moves over the floor), turn left/right (360° around what you look at),
//        look up/down, zoom in/out, reset. Press and hold repeats smoothly (frame-rate independent).
//   Keys: W A S D / arrows walk · Q E turn · T G (or Page Up / Page Down) look up/down · + − zoom · Home reset.
//   In Plan mode, while the planning proxy is being moved, arrows / WASD / Q E drive the proxy instead
//   (APP.planning.keysOwned()), and the pad still moves the camera.
// Facility modes use APP.camera / APP.controls. X-Ray, Learn and Practice use the X-Ray camera: APP.xCam / APP.xControls
// when main.js exposes them, otherwise the OrbitControls instance that drives a camera other than APP.camera
// (found by wrapping OrbitControls.prototype.update, which main.js calls every frame for the active view).
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { APP, on, addRailButton } from "./ext.js";
import "./navpad.css";

const seenCtl = new Set();
const _upd = OrbitControls.prototype.update;
OrbitControls.prototype.update = function (...a) { seenCtl.add(this); return _upd.apply(this, a); };

const XMODES = ["xray", "learn", "practice"];
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const coarse = () => { try { return matchMedia("(pointer: coarse)").matches; } catch { return false; } };
const phone = () => innerWidth <= 820;

const SVG = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  up: SVG('<path d="M12 19V5M6 11l6-6 6 6"/>'), down: SVG('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  left: SVG('<path d="M19 12H5M11 6l-6 6 6 6"/>'), right: SVG('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  turnL: SVG('<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>'), turnR: SVG('<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.6"/><path d="M20 4v4.6h-4.6"/>'),
  lookU: SVG('<path d="m6 15 6-6 6 6"/>'), lookD: SVG('<path d="m6 9 6 6 6-6"/>'),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'), minus: SVG('<path d="M5 12h14"/>'),
  home: SVG('<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/>'), eye: SVG('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  pad: SVG('<circle cx="12" cy="12" r="9"/><path d="m12 6.5-2 2.2h4zM12 17.5l-2-2.2h4zM6.5 12l2.2-2v4zM17.5 12l-2.2-2v4z"/>'),
  close: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
};

// ------------------------------------------------------------------ camera rig
function rig() {
  const S = APP.S;
  if (!S?.fac || S.mode === "value") return null;
  if (!XMODES.includes(S.mode)) return { cam: APP.camera, ctl: APP.controls, fac: true };
  if (APP.xCam && APP.xControls) return { cam: APP.xCam, ctl: APP.xControls, fac: false };
  const c = [...seenCtl].find((x) => x.object !== APP.camera);
  return c ? { cam: c.object, ctl: c, fac: false } : null;
}
let steered = false;
/** The user takes the wheel: stop a running camera tween and leave the robot-follow cameras. */
function takeWheel(r) {
  if (steered) return;
  steered = true;
  APP.flyTo?.(r.cam.position.clone(), r.ctl.target.clone(), 0.001, r.cam, r.ctl);
  const S = APP.S;
  if (r.fac && (S.cam === "chase" || S.cam === "broadcast") && (S.robot.moving || S.robot.follow > 0)) {
    S.cam = "free"; S.robot.follow = 0;
    try { APP.renderDock(); } catch {}
  }
}
const V = () => new APP.THREE.Vector3();
/** Apply one continuous action for dt seconds. */
function act(name, dt) {
  const r = rig(); if (!r || (r.fac && APP.S.mode === "plan" && !r.ctl.enabled)) return false;
  takeWheel(r);
  const { cam, ctl } = r, T = APP.THREE, tgt = ctl.target;
  const off = V().subVectors(cam.position, tgt), dist = off.length();
  if (name === "turnL" || name === "turnR") {
    // turn left = the view swings left: the camera circles to its right around the target
    const a = (name === "turnL" ? 1 : -1) * 1.25 * dt;
    off.applyAxisAngle(new T.Vector3(0, 1, 0), a);
    cam.position.copy(tgt).add(off);
  } else if (name === "up" || name === "down") {
    const s = new T.Spherical().setFromVector3(off);
    const maxP = Math.min(ctl.maxPolarAngle ?? Math.PI, Math.PI * 0.495), minP = Math.max(ctl.minPolarAngle ?? 0, 0.06);
    s.phi = Math.max(minP, Math.min(maxP, s.phi + (name === "up" ? 1 : -1) * 0.8 * dt));   // look up = camera lower
    off.setFromSpherical(s); cam.position.copy(tgt).add(off);
  } else if (name === "in" || name === "out") {
    const k = Math.exp((name === "in" ? -1 : 1) * 1.1 * dt);
    const lo = Math.max(ctl.minDistance || 0, r.fac ? 0.35 : 0.5), hi = Math.min(ctl.maxDistance || Infinity, r.fac ? 30 : 12);
    const d = Math.max(lo, Math.min(hi, dist * k));
    off.setLength(d); cam.position.copy(tgt).add(off);
  } else {
    // walk over the floor: forward = where the camera looks, flattened
    const f = V().subVectors(tgt, cam.position).setY(0);
    if (f.lengthSq() < 1e-8) cam.getWorldDirection(f).setY(0);
    if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
    f.normalize();
    const right = new T.Vector3(-f.z, 0, f.x);
    const dir = { fwd: f, back: f.clone().negate(), right, left: right.clone().negate() }[name];
    if (!dir) return false;
    const speed = Math.max(0.5, Math.min(3, 0.35 * dist + 0.4));
    const step = dir.multiplyScalar(speed * dt);
    const nt = tgt.clone().add(step);
    if (r.fac) {
      const b = APP.S.data.bounds, m = 0.2;
      nt.x = Math.max(b.min[0] + m, Math.min(b.max[0] - m, nt.x)); nt.z = Math.max(b.min[2] + m, Math.min(b.max[2] - m, nt.z));
    } else {
      const h = APP.S.xray?.home?.tgt; if (h) { const d = nt.clone().sub(h); if (d.length() > 3) nt.copy(h).add(d.setLength(3)); }
    }
    const real = nt.sub(tgt);
    tgt.add(real); cam.position.add(real);
  }
  return true;
}
function resetView() {
  const r = rig(); if (!r) return;
  steered = false;
  if (r.fac) APP.flyTo(APP.S.home.pos, APP.S.home.tgt, 0.9);
  else { const h = APP.S.xray?.home; if (h) APP.flyTo(h.pos, h.tgt, 0.9, r.cam, r.ctl); }
}

// ------------------------------------------------------------------ hold loop (shared by pad and keys)
const held = new Map();   // action -> number of sources holding it
let raf = 0, last = 0;
function press(a) {
  held.set(a, (held.get(a) || 0) + 1);
  if (held.get(a) === 1) act(a, 0.12);          // a quick tap still moves a visible step
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
}
function release(a) { const n = (held.get(a) || 0) - 1; if (n > 0) held.set(a, n); else held.delete(a); }
function releaseAll() { held.clear(); }
function loop(t) {
  const dt = Math.min(0.05, Math.max(0, (t - last) / 1000)); last = t;
  for (const a of held.keys()) act(a, dt);
  if (held.size) raf = requestAnimationFrame(loop); else { raf = 0; steered = false; }
}

// ------------------------------------------------------------------ keyboard
const KEYS = {
  KeyW: "fwd", ArrowUp: "fwd", KeyS: "back", ArrowDown: "back", KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
  KeyQ: "turnL", KeyE: "turnR", KeyT: "up", PageUp: "up", KeyG: "down", PageDown: "down",
  Equal: "in", NumpadAdd: "in", Minus: "out", NumpadSubtract: "out",
};
const PROXY_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyQ", "KeyE"]);
const typing = (el) => el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable);
const keyHeld = new Map();
function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || typing(document.activeElement) || typing(e.target)) return;
  if (e.code === "Home") { e.preventDefault(); return resetView(); }
  const a = KEYS[e.code]; if (!a) return;
  if (APP.S?.mode === "plan" && PROXY_KEYS.has(e.code) && APP.planning?.keysOwned?.()) return;   // planning.js moves the proxy
  if (!rig()) return;
  e.preventDefault();
  if (keyHeld.has(e.code)) return;
  keyHeld.set(e.code, a); press(a); hint(false);
}
function onKeyUp(e) { const a = keyHeld.get(e.code); if (a) { keyHeld.delete(e.code); release(a); } }

// ------------------------------------------------------------------ pad UI
let el = null, openBtn = null;
const btn = (a, icon, label, key) => `<button type="button" class="np-btn" data-np-a="${a}" title="${label}${key ? ` (${key})` : ""}" aria-label="${label}">${icon}</button>`;
function padHTML() {
  // keyboard-style inverted-T clusters: two rows, so the pad stays small next to the cards
  return `<div class="np-h"><span>Move the view</span><span class="np-tools"><button type="button" class="np-link" data-np="reset" title="Reset view (Home)">${I.home}<span>Reset</span></button><button type="button" class="np-link" data-np="keys" title="Keyboard shortcuts">Keys</button><button type="button" class="np-link" data-np="hide" title="Hide the pad" aria-label="Hide the navigation pad">${I.close}</button></span></div>
    <div class="np-b">
      <div class="np-cl"><small>Walk</small><div class="np-grid">
        <i></i>${btn("fwd", I.up, "Walk forward", "W or ↑")}<i></i>
        ${btn("left", I.left, "Walk left", "A or ←")}${btn("back", I.down, "Walk back", "S or ↓")}${btn("right", I.right, "Walk right", "D or →")}</div></div>
      <div class="np-cl"><small>Turn &amp; look</small><div class="np-grid">
        <i></i>${btn("up", I.lookU, "Look up", "T")}<i></i>
        ${btn("turnL", I.turnL, "Turn left", "Q")}${btn("down", I.lookD, "Look down", "G")}${btn("turnR", I.turnR, "Turn right", "E")}</div></div>
      <div class="np-cl np-zoom"><small>Zoom</small><div class="np-col">${btn("in", I.plus, "Zoom in", "+")}${btn("out", I.minus, "Zoom out", "−")}</div></div>
    </div>`;
}
function isOpen() { return el && !el.classList.contains("hidden"); }
function setOpen(open, save = true) {
  if (!el) return;
  el.classList.toggle("hidden", !open);
  openBtn.classList.toggle("hidden", open || !rig());
  if (save) store.set("xr.navpad", open ? "1" : "0");
  place();
  try { APP.renderRail?.(); } catch {}
}
function build() {
  el = document.createElement("div");
  el.className = "np"; el.id = "navpad"; el.setAttribute("role", "group"); el.setAttribute("aria-label", "Move the view");
  el.innerHTML = padHTML();
  openBtn = document.createElement("button");
  openBtn.type = "button"; openBtn.className = "np-open hidden"; openBtn.id = "navpadOpen";
  openBtn.innerHTML = `${I.pad}<span>Move</span>`; openBtn.title = "Show the navigation pad"; openBtn.setAttribute("aria-label", "Show the navigation pad");
  const app = document.getElementById("app");
  app.append(el, openBtn);
  // press and hold (mouse, pen, touch); keyboard Enter/Space on a focused button gives one step
  el.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("[data-np-a]"); if (!b || e.button > 0) return;
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch {}
    const a = b.dataset.npA; b.classList.add("down"); press(a);
    const up = () => { b.classList.remove("down"); release(a); b.removeEventListener("pointerup", up); b.removeEventListener("pointercancel", up); b.removeEventListener("lostpointercapture", up); };
    b.addEventListener("pointerup", up); b.addEventListener("pointercancel", up); b.addEventListener("lostpointercapture", up);
  });
  el.addEventListener("click", (e) => {
    const k = e.target.closest("[data-np]")?.dataset.np;
    if (k === "reset") resetView();
    if (k === "hide") setOpen(false);
    if (k === "keys") hint(true, true);
    const b = e.target.closest("[data-np-a]");
    if (b && e.detail === 0) { act(b.dataset.npA, 0.3); steered = false; }    // keyboard activation
  });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  openBtn.onclick = () => setOpen(true);
  const saved = store.get("xr.navpad");
  setOpen(saved == null ? !(coarse() || phone()) : saved === "1", false);
}

// ------------------------------------------------------------------ placement: never on top of the other panels
function rectOf(sel) { const n = document.querySelector(sel); if (!n || n.classList.contains("hidden")) return null; const r = n.getBoundingClientRect(); return r.width && r.height ? r : null; }
function place() {
  if (!el) return;
  const show = !!rig() && !document.body.classList.contains("focus");
  el.style.display = show ? "" : "none";
  openBtn.style.display = show ? "" : "none";
  const left = document.getElementById("left");
  if (left) left.style.maxHeight = "";
  if (!show || phone()) { el.style.bottom = ""; openBtn.style.bottom = ""; return; }
  let bottom = 24;
  const mm = rectOf("#minimap");
  if (mm) bottom = innerHeight - mm.top + 10;
  el.style.bottom = bottom + "px"; openBtn.style.bottom = bottom + "px";
  const target = isOpen() ? el : openBtn;
  let r = target.getBoundingClientRect();
  const dock = rectOf("#dock");
  if (dock && r.right > dock.left && r.left < dock.right && r.bottom > dock.top && r.top < dock.bottom) {
    bottom = innerHeight - dock.top + 10;
    el.style.bottom = bottom + "px"; openBtn.style.bottom = bottom + "px";
    r = target.getBoundingClientRect();
  }
  // the left card gives way to the pad (it scrolls inside)
  if (left && getComputedStyle(left).display !== "none") {
    const top = left.getBoundingClientRect().top;
    left.style.maxHeight = Math.max(120, r.top - top - 12) + "px";
  }
}

// ------------------------------------------------------------------ one-time hint
let hintEl = null, hintTimer = 0;
function hint(show, force = false) {
  if (!show) { if (hintEl && !force) { hintEl.remove(); hintEl = null; } return; }
  if (!force && store.get("xr.navhint")) return;
  store.set("xr.navhint", "1");
  hintEl?.remove();
  hintEl = document.createElement("div");
  hintEl.className = "np-hint"; hintEl.setAttribute("role", "note");
  hintEl.innerHTML = `<b>Getting around</b>
    <span><span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> or arrow keys: walk</span>
    <span><span class="kbd">Q</span><span class="kbd">E</span>: turn around · <span class="kbd">T</span><span class="kbd">G</span>: look up / down</span>
    <span><span class="kbd">+</span><span class="kbd">−</span>: zoom · <span class="kbd">Home</span>: reset view</span>
    <span>Or press and hold the buttons on the pad${coarse() ? " · drag with one finger to turn, pinch to zoom" : " · drag the view with the mouse"}.</span>
    <button type="button" class="btn" data-np-hint>Got it</button>`;
  document.getElementById("app").appendChild(hintEl);
  const r = (isOpen() ? el : openBtn).getBoundingClientRect();
  if (!phone() && r.width) { hintEl.style.left = r.right + 12 + "px"; hintEl.style.bottom = Math.max(12, innerHeight - r.bottom) + "px"; }
  hintEl.querySelector("[data-np-hint]").onclick = () => { hintEl?.remove(); hintEl = null; };
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintEl?.remove(); hintEl = null; }, force ? 15000 : 11000);
}

// ------------------------------------------------------------------ wiring
addRailButton({ id: "navpad", icon: "target", title: "Navigation pad: move the view with buttons", onClick: () => setOpen(!isOpen()), isOn: () => isOpen() });
on("boot", () => {
  build();
  APP.navpad = { act, press, release, resetView, setOpen, isOpen, rig };
  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", () => { keyHeld.clear(); releaseAll(); });
  addEventListener("resize", () => requestAnimationFrame(place));
  // the dock and left card change size with every render: keep the pad clear of them
  const ro = new ResizeObserver(() => place());
  for (const id of ["dock", "minimap", "left"]) { const n = document.getElementById(id); if (n) ro.observe(n); }
  new MutationObserver(() => place()).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setTimeout(place, 0);
  const q = new URLSearchParams(location.search);
  // one-time keyboard hint (desktop): after the first coach card is closed, never on top of it
  let tries = 0;
  const later = () => { if (++tries > 60 || document.body.classList.contains("touring")) return; if (document.querySelector(".gd-coach") || !rig()) return setTimeout(later, 1000); hint(true); };
  if (!q.has("qa") && !q.has("capture") && !phone() && !coarse()) setTimeout(later, 2600);
});
on("modeChange", () => { releaseAll(); keyHeld.clear(); requestAnimationFrame(place); });
