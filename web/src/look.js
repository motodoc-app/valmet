// Presentation of the 3D room ("look"): studio backdrop, soft floor plate under the scan, adaptive resolution and an
// automatic cut-away when the free camera rises above the ceiling. Everything here is cosmetic and cheap: two
// textures made once, one plane, and a few numbers per frame. Nothing changes the scan itself.
//   · backdrop: a dark vertical gradient instead of a flat black void, so high views read like a product render
//   · floor plate: a soft-edged slab just under the room footprint; from above the room sits on it, at eye level it
//     only shows through gaps in the scanned floor (dark grey instead of black)
//   · adaptive resolution (desktop only): pixel ratio between 1 and min(devicePixelRatio, 2), stepped by 0.25 from the
//     measured frame time (down when > 24 ms on average, up when < 14 ms for 3 s). Phones (LITE) stay at 1;
//     ?capture (frame-by-frame recording) and ?dpr=<n> (fixed) are left alone.
//   · auto cut-away: orbiting the free / chase camera above the ceiling hides the ceiling, haze and the wall skins
//     (the same layers the Broadcast / Top cameras hide); coming back down restores them.
import * as THREE from "three";
import { APP, on } from "./ext.js";
import { LITE } from "./ui.js";

const Q = new URLSearchParams(location.search);
export const LOOK = { dpr: null, dprMax: 1, frameMs: 0, adapt: !LITE && !Q.has("capture") && !Q.has("dpr"), autoCut: false, changes: 0 };

function gradientTexture() {
  const c = document.createElement("canvas"); c.width = 2; c.height = 256;
  const g = c.getContext("2d"), grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#07080a"); grd.addColorStop(0.55, "#111317"); grd.addColorStop(1, "#1c1f25");
  g.fillStyle = grd; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// rounded slab with a soft edge, a little lighter than the backdrop, and a faint darker contact zone under the room
function plateTexture(w, d, margin) {
  const px = 40, W = Math.ceil((w + 2 * margin) * px), H = Math.ceil((d + 2 * margin) * px);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const m = margin * px;
  g.filter = `blur(${Math.round(m * 0.45)}px)`;
  g.fillStyle = "rgba(50,55,63,1)";
  g.beginPath(); g.roundRect(m * 0.55, m * 0.55, W - m * 1.1, H - m * 1.1, m * 0.6); g.fill();
  g.filter = `blur(${Math.round(m * 0.25)}px)`;
  g.fillStyle = "rgba(14,16,19,0.85)";
  g.beginPath(); g.roundRect(m, m, W - 2 * m, H - 2 * m, m * 0.2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildBackdrop(A) {
  const scene = A.scene, b = A.S.data.bounds;
  scene.background = gradientTexture();
  const w = b.max[0] - b.min[0], d = b.max[2] - b.min[2], margin = 0.9;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(w + 2 * margin, d + 2 * margin).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: plateTexture(w, d, margin), transparent: true, depthWrite: false, toneMapped: false }));
  plate.position.set((b.min[0] + b.max[0]) / 2, -0.04, (b.min[2] + b.max[2]) / 2);
  plate.renderOrder = -10;          // before the splats: the scan composites over it
  plate.name = "floor-plate";
  scene.add(plate);
  LOOK.plate = plate;
}

on("boot", (A) => {
  try { buildBackdrop(A); } catch (e) { console.warn("backdrop", e); }
  const r = A.renderer;
  LOOK.dprMax = LITE ? 1 : Math.min(devicePixelRatio || 1, 2);
  if (Q.has("dpr")) r.setPixelRatio(Math.max(0.5, Math.min(3, +Q.get("dpr") || 1)));
  LOOK.dpr = r.getPixelRatio();
});

let last = 0, acc = 0, n = 0, calm = 0;
on("frame", () => {
  const A = APP, S = A.S; if (!S?.fac) return;
  // ---- auto cut-away for the free / chase camera above the ceiling (spectator and Plan cameras manage their own)
  if ((S.cam === "free" || S.cam === "chase") && S.mode !== "plan") {
    const high = A.camera.position.y > (S.data.ceiling_y || 2.05) + 0.25;
    if (high) { if (!S.fac.cutaway) S.fac.setCutaway(true); LOOK.autoCut = true; }
    else if (!high && LOOK.autoCut) { S.fac.setCutaway(false); LOOK.autoCut = false; }
  } else LOOK.autoCut = false;
  // ---- adaptive pixel ratio
  if (!LOOK.adapt || document.hidden) { last = 0; return; }
  const now = performance.now();
  if (last) { const dt = now - last; if (dt < 250) { acc += dt; n++; } }   // ignore stalls (tab switch, alerts)
  last = now;
  if (acc < 1000 || !n) return;
  const ms = acc / n; acc = 0; n = 0; LOOK.frameMs = Math.round(ms * 10) / 10;
  const r = A.renderer, pr = r.getPixelRatio();
  let next = pr;
  if (ms > 24 && pr > 1) { next = Math.max(1, pr - 0.25); calm = 0; }
  else if (ms < 14) { if (++calm >= 3 && pr < LOOK.dprMax) { next = Math.min(LOOK.dprMax, pr + 0.25); calm = 0; } }
  else calm = 0;
  if (next !== pr) { r.setPixelRatio(next); r.setSize(innerWidth, innerHeight); LOOK.dpr = next; LOOK.changes++; }
});
window.__look = LOOK;
