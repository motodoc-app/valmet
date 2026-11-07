// Maintenance Planning mode: move equipment as virtual proxies, check collisions, clearance and service access,
// and see how the robot route changes. The scan data is never modified: proxies are drawn on top of it, and the
// planner receives them as `blocks` (new footprints) and `clears` (old footprints become free floor).
//
// Game-like editing: press on any floor-standing object in the 3D view to pick it up (it lifts a few cm), drag it
// across the floor (live green / amber / red), turn it with the mouse wheel, R or Q / E, and let go (it settles and
// the route is re-planned). Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) and Reset all. No throwing or physics: a placement
// is only ever where the pointer put it, so plans stay realistic. Where the Gaussian splats are loaded, the scan
// inside the object's box moves with it (splatcut.js: an approximate cut-out, labelled as such).
//
// Public API (APP.planning): getState(), setState(state), reset(), demo(), summary(), undo(), redo(), view(kind)
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { APP, registerMode, on, withExtras } from "./ext.js";
import { edt } from "./static-api.js";
import { icon } from "./icons.js";
import { SplatCut } from "./splatcut.js";
import "./planning.css";
// UX layer (navigation pad, mode guides, readability, phone Tools sheet). Loaded from here so main.js needs no change;
// main.js could import them directly instead (see guide.js / navpad.js headers).
import "./guide.js";
import "./navpad.js";
import "./mobile.js";

// ------------------------------------------------------------------ constants
const DISCLAIMER = "Planning simulation · approximate geometry (oriented boxes + occupancy grid) · not an engineering clearance check";
const SUGGESTED = "OBJ-028";            // hand pallet truck parked in front of P-005 (review-corrected label)
const SNAP = 0.05;                      // metres
const CLEAR_PAD = 0.08;                 // old footprint padding: the scan points of the moved object itself
const TIGHT = 0.3;                      // below this clearance (m) the proxy is shown amber
const OBST_MIN = 0.12, OBST_MAX = 1.25; // same height band the navigation grid uses (config.py)
const ZONE_DEPTH = 1.0, ZONE_EXTRA = 0.8;  // assumed illustrative service zone: 1.0 m deep × pump width + 0.8 m (0.4 m side access each side)
const LIFT = 0.06;                      // picked-up objects float this high (m) while held: purely visual
const DROP_S = 0.26;                    // settle animation on release (s)
const MOUNTED_Y = 0.6;                  // objects whose box starts higher than this are wall / pipe mounted
const FIXED_CATS = new Set(["piping", "valve"]);   // part of the pipework: stays put in a plan
const INSTALL_M = 0.6;                   // fixed parts this close to the serviced equipment count as part of its installation
const CUT_NOTE = "Approximate cut-out of the scan inside the object's box — may include nearby fragments";
const COL = { ok: 0x30d158, tight: 0xff9f0a, bad: 0xff453a, ghost: 0xa3a8b0, route: 0x0a84ff };
const CSS = { ok: "#30d158", tight: "#ff9f0a", bad: "#ff453a" };
const ICON = {
  rotL: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>',
  rotR: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.6"/><path d="M20 4v4.6h-4.6"/>',
  turn: '<path d="M5 19V9a4 4 0 0 1 4-4h10"/><path d="m15 1 4 4-4 4"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  box: '<path d="M4 8h16v12H4z"/><path d="M8 8V5h8v3" stroke-dasharray="2 2"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
};
const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const gap = (d) => (d < 1 ? `${Math.round(d * 100)} cm` : `${f2(d)} m`);
const deg = (r) => Math.round((r * 180) / Math.PI);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const snap = (v) => Math.round(v / SNAP) * SNAP;
const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ state
const P = {
  ready: false, grid: null, objs: [], byId: new Map(), target: null, zone: null,
  moves: [],                  // [{ id, x, z, yaw }] proposed poses (the plan)
  active: null,               // id of the proxy being edited
  query: "", snap: true, compare: true,
  before: null, after: null, afterSeq: 0, routeBusy: false, routeMs: 0,
  occEff: null, clearMap: null, clearMask: null, dirtyField: true,
  three: null, drag: null, justDragged: false, cardTimer: 0, routeTimer: 0,
  editing: false,             // step 2 "Move it": keys and the move pad drive the active proxy
  hold: null,                 // press-and-hold on a move-pad button
  undo: [], redo: [], lastRec: { t: 0, kind: "" }, mute: 0,   // plan history: snapshots of { moves, active }
  hover: null, hoverEvt: null, hoverRaf: 0, wheelAcc: 0,
  cut: null, cutOn: !/[?&]cut=off\b/.test(location.search),   // scan cut-out (splatcut.js); ?cut=off = box proxies only
};
/** True while the keyboard belongs to the proxy (Plan mode, a proxy is being moved). navpad.js reads this. */
const keysOwned = () => APP.S?.mode === "plan" && !!P.active && P.editing;

// ------------------------------------------------------------------ geometry (2D oriented boxes on the floor, x/z)
/** Footprint of an object at a pose: { x, z, w, d, yaw } (same format as planner blocks). */
const footprint = (o, pose = null, pad = 0) => ({ x: pose ? pose.x : o.center[0], z: pose ? pose.z : o.center[2],
  w: o.size[0] + 2 * pad, d: o.size[2] + 2 * pad, yaw: pose ? pose.yaw : o.yaw });
function corners(b) {
  const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw), hx = b.w / 2, hz = b.d / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([lx, lz]) => [b.x + lx * cs - lz * sn, b.z + lx * sn + lz * cs]);
}
function overlap(a, b) {               // separating-axis test for two oriented rectangles
  const ca = corners(a), cb = corners(b);
  for (const r of [a, b]) for (const [ax, az] of [[Math.cos(r.yaw), Math.sin(r.yaw)], [-Math.sin(r.yaw), Math.cos(r.yaw)]]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of ca) { const p = x * ax + z * az; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
    for (const [x, z] of cb) { const p = x * ax + z * az; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
function boxDist(a, b) {
  if (overlap(a, b)) return 0;
  const ca = corners(a), cb = corners(b);
  let d = Infinity;
  for (let i = 0; i < 4; i++) for (const p of ca) d = Math.min(d, segDist(p, cb[i], cb[(i + 1) % 4]));
  for (let i = 0; i < 4; i++) for (const p of cb) d = Math.min(d, segDist(p, ca[i], ca[(i + 1) % 4]));
  return d;
}
function polyDist(b, pts) {            // footprint to polyline [[x,z],...]
  let d = Infinity;
  const cb = corners(b);
  for (let i = 1; i < pts.length; i++) {
    for (const p of cb) d = Math.min(d, segDist(p, pts[i - 1], pts[i]));
    for (let k = 0; k < 4; k++) for (const p of [pts[i - 1], pts[i]]) d = Math.min(d, segDist(p, cb[k], cb[(k + 1) % 4]));
  }
  return d;
}
/** Grid cells whose centre lies inside the footprint (same rule as the planners' rasterise). With `stats`, also counts
 *  the footprint cells that fall beyond the mapped grid (stats.outside). */
function cellsOf(b, stats = null) {
  const g = P.grid, out = [], cs = Math.cos(b.yaw), sn = Math.sin(b.yaw), hx = b.w / 2, hz = b.d / 2, rad = Math.hypot(hx, hz);
  let r0 = Math.floor((b.z - rad - g.z0) / g.res), r1 = Math.floor((b.z + rad - g.z0) / g.res);
  let c0 = Math.floor((b.x - rad - g.x0) / g.res), c1 = Math.floor((b.x + rad - g.x0) / g.res);
  const inside = (r, c) => { const dx = g.x0 + (c + 0.5) * g.res - b.x, dz = g.z0 + (r + 0.5) * g.res - b.z; return Math.abs(dx * cs + dz * sn) <= hx && Math.abs(-dx * sn + dz * cs) <= hz; };
  if (stats) {
    stats.outside = 0;
    if (r1 - r0 < 400 && c1 - c0 < 400) { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if ((r < 0 || r >= g.H || c < 0 || c >= g.W) && inside(r, c)) stats.outside++; }
    else stats.outside = Infinity;
  }
  r0 = Math.max(0, r0); r1 = Math.min(g.H - 1, r1); c0 = Math.max(0, c0); c1 = Math.min(g.W - 1, c1);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (inside(r, c)) out.push(r * g.W + c);
  return out;
}
const unpackHex = (hex, n) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (parseInt(hex.substr((i >> 3) * 2, 2), 16) >> (7 - (i & 7))) & 1; return o; };

// ------------------------------------------------------------------ data
async function init() {
  const S = APP.S;
  const g = await APP.api.grid();     // at boot no plan has run yet: occupancy = scan + object frames
  const n = g.W * g.H;
  P.grid = { W: g.W, H: g.H, x0: g.x0, z0: g.z0, res: g.res,
    floor: g.floor instanceof Uint8Array ? g.floor.slice() : unpackHex(g.floor, n),
    occ: g.occ instanceof Uint8Array ? g.occ.slice() : g.occupiedMask.slice() };
  P.objs = S.data.objects.filter((o) => o.kind === "object").map((o) => ({ o, fp: footprint(o), bottom: o.center[1] - o.size[1] / 2, top: o.center[1] + o.size[1] / 2 }));
  P.byId = new Map(P.objs.map((e) => [e.o.id, e]));
  P.target = S.target;
  P.zone = serviceZone(P.target);
  P.ready = true;
}

/** Assumed service zone in front of the pump: on the long side that faces its approach cell / open floor. */
function serviceZone(t) {
  const fp = footprint(t), long = fp.w >= fp.d;
  const ax = long ? [-Math.sin(fp.yaw), Math.cos(fp.yaw)] : [Math.cos(fp.yaw), Math.sin(fp.yaw)];   // normal of the long faces
  const half = long ? fp.d / 2 : fp.w / 2, width = (long ? fp.w : fp.d) + ZONE_EXTRA;
  // pick the face toward the room centre (where the robot and technicians come from)
  const b = APP.S.data.bounds, cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const s = (cx - fp.x) * ax[0] + (cz - fp.z) * ax[1] >= 0 ? 1 : -1;
  const off = half + ZONE_DEPTH / 2;
  return { x: fp.x + s * ax[0] * off, z: fp.z + s * ax[1] * off, w: long ? width : ZONE_DEPTH, d: long ? ZONE_DEPTH : width, yaw: fp.yaw };
}

const moveOf = (id) => P.moves.find((m) => m.id === id);
const objOf = (id) => P.byId.get(id)?.o;
const nameOf = (o) => (o.asset ? `${o.asset.tag} (${o.id})` : o.id === SUGGESTED ? `Hand pallet truck (${o.id})` : `${cap(o.label)} (${o.id})`);
const shortName = (o) => (o.asset ? o.asset.tag : o.id === SUGGESTED ? "Pallet truck" : cap(o.label));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** Can this object be picked up in the 3D view? Floor-standing equipment yes; the pump itself, pipework,
 *  wall / pipe mounted parts and tiny fragments no (moving those would not be a realistic plan). */
function movable(o) {
  if (!o || o.kind !== "object") return { ok: false, why: "Walls, floor and ceiling cannot be moved." };
  if (o.id === P.target?.id) return { ok: false, why: `${esc(P.target.asset?.tag || o.id)} is the equipment being serviced; move the things around it.` };
  const bottom = o.center[1] - o.size[1] / 2, big = Math.max(o.size[0], o.size[2]);
  if (FIXED_CATS.has(o.category) || o.label === "pipe label / tag") return { ok: false, why: `${esc(shortName(o))} (${o.id}) is part of the pipework, so it stays put in a plan.` };
  if (bottom > MOUNTED_Y) return { ok: false, why: `${esc(shortName(o))} (${o.id}) is mounted above the floor, so it stays put in a plan.` };
  if (big < 0.1) return { ok: false, why: `${o.id} is a small scan fragment, not a piece of equipment.` };
  if (big > 3) return { ok: false, why: `${esc(shortName(o))} (${o.id}) is too large to move in a plan.` };
  return { ok: true };
}

// ------------------------------------------------------------------ history (undo / redo)
const snapshot = () => ({ moves: P.moves.map((m) => ({ ...m })), active: P.active });
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Remember the plan before a change. `kind` coalesces bursts (key repeats, wheel steps) into one undo step. */
function record(kind = "edit", before = snapshot()) {
  if (P.mute) return;
  const now = performance.now();
  if (kind !== "edit" && kind === P.lastRec.kind && now - P.lastRec.t < 900) { P.lastRec.t = now; return; }
  P.lastRec = { t: now, kind };
  if (P.undo.length && sameSnap(P.undo.at(-1), before)) return;
  P.undo.push(before); if (P.undo.length > 100) P.undo.shift();
  P.redo = [];
}
function applySnap(s) {
  P.moves = s.moves.filter((m) => objOf(m.id)).map((m) => ({ ...m }));
  P.active = P.moves.some((m) => m.id === s.active) ? s.active : P.moves.at(-1)?.id || null;
  if (!P.active) P.editing = false;
  P.dirtyField = true; P.lastRec = { t: 0, kind: "" };
  refresh(); renderAll();
  if (P.moves.length) scheduleRoute(0);
  else { P.after = null; drawRoutes(); if (APP.S.curve && !APP.S.robot.done) APP.replan({ quiet: true }); }
}
function undo() {
  if (!P.undo.length) return false;
  if (P.drag) endDrag();
  P.redo.push(snapshot()); applySnap(P.undo.pop());
  APP.toast("Undone.", 1200);
  return true;
}
function redo() {
  if (!P.redo.length) return false;
  if (P.drag) endDrag();
  P.undo.push(snapshot()); applySnap(P.redo.pop());
  APP.toast("Redone.", 1200);
  return true;
}

/** Obstacle field for the active proxy: scan minus every moved object's old footprint, plus the other proxies. */
function buildField(forId = P.active) {
  const g = P.grid, n = g.W * g.H;
  const clearMask = new Uint8Array(n), proxyMask = new Uint8Array(n);
  for (const m of P.moves) {
    for (const i of cellsOf(footprint(objOf(m.id), null, CLEAR_PAD))) clearMask[i] = 1;
    if (m.id !== forId) for (const i of cellsOf(footprint(objOf(m.id), m))) proxyMask[i] = 1;
  }
  const occ = new Uint8Array(n);
  for (let i = 0; i < n; i++) occ[i] = (g.occ[i] & (1 - clearMask[i])) | proxyMask[i];
  P.clearMask = clearMask; P.proxyMask = proxyMask; P.occEff = occ;
  P.clearMap = edt(occ, g.W, g.H, g.res);
  P.dirtyField = false; P.fieldFor = forId;
}

/** Collisions, clearance and service-zone effect of one object at a proposed pose (cheap: runs on every drag move). */
function evaluate(id, pose) {
  if (P.dirtyField || P.fieldFor !== id) buildField(id);
  const o = objOf(id), fp = footprint(o, pose), g = P.grid;
  const bottom = o.center[1] - o.size[1] / 2, top = o.center[1] + o.size[1] / 2;
  // footprint cells beyond the mapped grid are off the scanned floor too
  const st = {}, cells = cellsOf(fp, st);
  let scanCells = 0, offFloor = Math.min(st.outside, 1e6), clearance = Infinity, minCell = -1;
  for (const i of cells) {
    if (g.occ[i] && !P.clearMask[i]) scanCells++;
    if (!g.floor[i]) offFloor++;
    if (P.clearMap[i] < clearance) { clearance = P.clearMap[i]; minCell = i; }
  }
  const moved = new Set(P.moves.map((m) => m.id)); moved.add(id);
  const hits = [], near = [];
  for (const e of P.objs) {
    if (moved.has(e.o.id)) continue;
    // thin labels on pipes and tiny fragments are not obstacles for a pallet truck or a cabinet
    if (e.o.label === "pipe label / tag" || Math.max(e.o.size[0], e.o.size[2]) < 0.08) continue;
    if (!(e.bottom < top - 0.02 && e.top > Math.max(bottom, OBST_MIN) && e.bottom < OBST_MAX)) continue;
    if (Math.hypot(e.fp.x - fp.x, e.fp.z - fp.z) > 4) continue;
    const d = boxDist(fp, e.fp);
    if (d === 0) hits.push(e.o); else near.push([d, e.o]);
  }
  for (const m of P.moves) if (m.id !== id && overlap(fp, footprint(objOf(m.id), m))) hits.push({ ...objOf(m.id), proxy: true });
  near.sort((a, b) => a[0] - b[0]);
  if (!cells.length) clearance = 0;
  const collision = hits.length > 0 || scanCells > 0;
  // the scan can only vouch for floor it mapped: a footprint that leaves it (even partly) is not a valid placement
  const offScan = offFloor > 0;
  const status = collision || offScan ? "bad" : clearance < TIGHT ? "tight" : "ok";
  // the nearest obstacle cell, to draw the clearance gauge
  let gauge = null;
  if (!collision && minCell >= 0 && isFinite(clearance)) {
    const r0 = (minCell / g.W) | 0, c0 = minCell % g.W, R = Math.ceil(clearance / g.res) + 1;
    let best = Infinity;
    for (let r = Math.max(0, r0 - R); r <= Math.min(g.H - 1, r0 + R); r++) for (let c = Math.max(0, c0 - R); c <= Math.min(g.W - 1, c0 + R); c++) {
      if (!P.occEff[r * g.W + c]) continue;
      const d = (r - r0) ** 2 + (c - c0) ** 2;
      if (d < best) { best = d; gauge = { from: [g.x0 + (c0 + 0.5) * g.res, g.z0 + (r0 + 0.5) * g.res], to: [g.x0 + (c + 0.5) * g.res, g.z0 + (r + 0.5) * g.res] }; }
    }
  }
  return { fp, cells: cells.length, scanCells, offFloor, offScan, hits, collision, status,
    clearance: isFinite(clearance) ? clearance : null, nearest: near[0] ? { o: near[0][1], d: near[0][0] } : null, gauge };
}

/** Service zone of the target: which footprints (proxies or unmoved objects) overlap it, and how much free floor is left. */
function zoneStatus(moves = P.moves) {
  const z = P.zone, g = P.grid, moved = new Set(moves.map((m) => m.id)), tfp = footprint(P.target);
  const obstructions = [];
  for (const e of P.objs) {
    if (e.o.id === P.target.id || moved.has(e.o.id)) continue;
    if (overlap(tfp, e.fp)) continue;         // frames touching the pump's own frame are parts of it (motor, fittings)
    // fixed or small fragments right next to the pump (its pipework, flanges, inlet valve) belong to the installation;
    // movable equipment there (a pallet truck, a cart) is what the plan is about (same 0.6 m as the robot's line of sight)
    if (boxDist(tfp, e.fp) <= INSTALL_M && (movable(e.o) || Math.max(e.o.size[0], e.o.size[2]) < 0.3)) continue;
    if (!(e.top > OBST_MIN && e.bottom < OBST_MAX)) continue;
    if (overlap(z, e.fp)) obstructions.push({ id: e.o.id, name: shortName(e.o), proxy: false });
  }
  const mask = new Uint8Array(g.W * g.H);
  for (const m of moves) {
    const fp = footprint(objOf(m.id), m);
    if (overlap(z, fp)) obstructions.push({ id: m.id, name: shortName(objOf(m.id)), proxy: true });
    for (const i of cellsOf(fp)) mask[i] = 1;
  }
  const clear = new Uint8Array(g.W * g.H);
  for (const m of moves) for (const i of cellsOf(footprint(objOf(m.id), null, CLEAR_PAD))) clear[i] = 1;
  let free = 0, total = 0;
  for (const i of cellsOf(z)) { if (!g.floor[i]) continue; total++; if (!((g.occ[i] && !clear[i]) || mask[i])) free++; }
  return { clear: obstructions.length === 0, obstructions, freePct: total ? Math.round((100 * free) / total) : 0 };
}

// ------------------------------------------------------------------ routes
const startXZ = () => [APP.S.data.start[0], APP.S.data.start[2]];
const planExtras = () => (P.moves.length ? {
  blocks: P.moves.map((m) => ({ ...rnd(footprint(objOf(m.id), m)), proxy: m.id })),
  clears: P.moves.map((m) => ({ ...rnd(footprint(objOf(m.id), null, CLEAR_PAD)), object_id: m.id })),
} : { blocks: [], clears: [] });
const rnd = (b) => ({ x: +b.x.toFixed(3), z: +b.z.toFixed(3), w: +b.w.toFixed(3), d: +b.d.toFixed(3), yaw: +b.yaw.toFixed(4) });
const routeInfo = (r, ms) => (r?.ok ? { ok: true, length_m: r.length_m, min_clearance_m: r.validation.min_clearance_m, collision_free: r.validation.collision_free,
  compute_ms: r.compute_ms ?? ms, waypoints: r.waypoints } : { ok: false, reason: r?.reason || "no route" });

async function beforeRoute() {
  if (P.before) return P.before;
  const t0 = performance.now();
  const r = await APP.api.plan({ object_id: P.target.id, start: startXZ(), blocks: [] });   // the scanned layout, no plan
  return (P.before = routeInfo(r, +(performance.now() - t0).toFixed(1)));
}
/** Route with the proposed layout. Uses withExtras(), the same path every robot route takes while a plan is active. */
async function computeAfter() {
  const seq = ++P.afterSeq;
  P.routeBusy = true; renderDock();
  await beforeRoute();
  let info = null;
  if (P.moves.length) {
    const t0 = performance.now();
    const r = await APP.api.plan(withExtras({ object_id: P.target.id, start: startXZ(), blocks: [] }));
    info = routeInfo(r, +(performance.now() - t0).toFixed(1));
    info.roundtrip_ms = +(performance.now() - t0).toFixed(1);
  }
  if (seq !== P.afterSeq) return P.after;
  P.after = info; P.routeBusy = false;
  drawRoutes(); renderDock(); renderCard(); renderLeft();
  // a robot run in progress follows the new layout (Explore mode keeps using it until Reset)
  if (APP.S.curve && !APP.S.robot.done) APP.replan({ quiet: true });
  return info;
}
const scheduleRoute = (ms = 0) => { clearTimeout(P.routeTimer); P.routeTimer = setTimeout(computeAfter, ms); };

// ------------------------------------------------------------------ 3D drawing (own objects in APP.scene; the scan is untouched)
function ensureThree() {
  if (P.three) return P.three;
  const root = new THREE.Group(); root.name = "planning";
  const proxies = new THREE.Group(), routes = new THREE.Group(), zone = new THREE.Group(), gauge = new THREE.Group();
  root.add(zone, proxies, routes, gauge);
  zone.visible = APP.S?.mode === "plan";      // the service zone is a Plan-mode overlay only
  APP.scene.add(root);
  P.three = { root, proxies, routes, zone, gauge, items: new Map() };
  buildZone();
  return P.three;
}
function tag(html, cls = "") {
  const el = document.createElement("div");
  el.className = `pl-tag ${cls}`; el.innerHTML = html;
  return new CSS2DObject(el);
}
function buildZone() {
  const T = P.three, z = P.zone;
  T.zone.clear();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(z.w, z.d), new THREE.MeshBasicMaterial({ color: COL.bad, transparent: true, opacity: 0.12, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  plane.rotation.x = -Math.PI / 2;
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(z.w, z.d)), new THREE.LineDashedMaterial({ color: COL.bad, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.9, depthTest: false }));
  edge.rotation.x = -Math.PI / 2; edge.computeLineDistances();
  plane.renderOrder = 3; edge.renderOrder = 4;
  const g = new THREE.Group(); g.add(plane, edge);
  g.position.set(z.x, 0.012, z.z); g.rotation.y = -z.yaw;
  const lab = tag(`<span class="d"></span>${esc(P.target.asset?.tag || "Target")} service zone<small>assumed</small>`, "zone");
  // at one end of the zone (not its centre), so it does not sit on top of the "Original position" tag of an object inside it
  const long = z.w >= z.d, ax = long ? [Math.cos(z.yaw), Math.sin(z.yaw)] : [-Math.sin(z.yaw), Math.cos(z.yaw)], half = Math.max(z.w, z.d) / 2;
  const ends = [1, -1].map((k) => [z.x + k * ax[0] * Math.max(0, half - 0.35), z.z + k * ax[1] * Math.max(0, half - 0.35)]);
  const sug = objOf(SUGGESTED), far = sug ? ends.sort((a, b) => Math.hypot(b[0] - sug.center[0], b[1] - sug.center[2]) - Math.hypot(a[0] - sug.center[0], a[1] - sug.center[2]))[0] : [z.x, z.z];
  lab.position.set(far[0], 0.05, far[1]);
  T.zone.add(g, lab);
  T.zoneParts = { plane, edge, lab };
}
function paintZone(st) {
  const T = P.three; if (!T?.zoneParts) return;
  const c = st.clear ? COL.ok : COL.bad;
  T.zoneParts.plane.material.color.setHex(c); T.zoneParts.edge.material.color.setHex(c);
  T.zoneParts.plane.material.opacity = st.clear ? 0.1 : 0.14;
  const el = T.zoneParts.lab.element;
  el.classList.toggle("ok", st.clear); el.classList.toggle("bad", !st.clear);
  el.querySelector("small").textContent = st.clear ? "clear · assumed" : "obstructed · assumed";
}

function proxyItem(id) {
  const T = ensureThree();
  let it = T.items.get(id);
  if (it) return it;
  const o = objOf(id), [w, h, d] = o.size.map((v) => Math.max(v, 0.04)), bottom = Math.max(0, o.center[1] - o.size[1] / 2);
  // ghost: dashed outline of the scanned (original) position
  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), new THREE.LineDashedMaterial({ color: COL.ghost, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.9 }));
  ghost.computeLineDistances();
  ghost.position.set(o.center[0], bottom + h / 2, o.center[2]); ghost.rotation.y = -o.yaw;
  const ghostFloor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: COL.ghost, transparent: true, opacity: 0.16, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  ghostFloor.renderOrder = 4;
  ghostFloor.rotation.x = -Math.PI / 2;
  const gf = new THREE.Group(); gf.add(ghostFloor); gf.position.set(o.center[0], 0.014, o.center[2]); gf.rotation.y = -o.yaw;
  const ghostTag = tag(`Original position<small>scan</small>`, "ghost");
  ghostTag.position.set(o.center[0], 0.04, o.center[2]);
  // proxy: translucent box + bright edges + footprint + grab ring
  const proxy = new THREE.Group();
  const fillMat = new THREE.MeshBasicMaterial({ color: COL.ok, transparent: true, opacity: 0.16, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: COL.ok, transparent: true });
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), fillMat); box.position.y = bottom + h / 2;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), edgeMat); edges.position.y = bottom + h / 2;
  const floorMat = new THREE.MeshBasicMaterial({ color: COL.ok, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat); fl.rotation.x = -Math.PI / 2; fl.position.y = 0.016;
  const rr = Math.hypot(w, d) / 2 + 0.1;
  const ringMat = new THREE.MeshBasicMaterial({ color: COL.ok, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(rr, rr + 0.018, 64), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.018;
  // heading tick on the ring shows the rotation
  const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.022), ringMat); tick.rotation.x = -Math.PI / 2; tick.position.set(rr + 0.06, 0.018, 0);
  fl.renderOrder = ring.renderOrder = tick.renderOrder = 6;
  proxy.add(box, edges, fl, ring, tick);
  const ptag = tag(`<span class="d"></span><b>Planning proxy</b><small>${esc(shortName(o))}</small>`, "proxy");
  ptag.position.set(0, bottom + h + 0.42, 0);   // above the scene's own label of the same object
  proxy.add(ptag);
  // displacement arrow on the floor (dashed)
  const arrow = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]),
    new THREE.LineDashedMaterial({ color: 0xf2f3f5, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.8, depthTest: false }));
  arrow.renderOrder = 6;
  const atag = tag("", "dist");
  T.proxies.add(ghost, gf, ghostTag, proxy, arrow, atag);
  it = { id, ghost, gf, ghostTag, proxy, box, edges, fl, ring, tick, ptag, arrow, atag, fillMat, edgeMat, floorMat, ringMat, h, bottom, w, d,
    vis: { x: o.center[0], z: o.center[2], yaw: o.yaw, lift: 0 }, anim: false, liftTo: 0, drop: null };
  T.items.set(id, it);
  return it;
}
/** Draw a proxy (and its scan cut-out) at its visual pose: eased while held, lifted, footprint kept on the floor. */
function applyVis(it) {
  const v = it.vis;
  it.proxy.position.set(v.x, v.lift, v.z); it.proxy.rotation.y = -v.yaw;
  it.fl.position.y = 0.016 - v.lift; it.ring.position.y = it.tick.position.y = 0.018 - v.lift;
  P.cut?.pose(it.id, v.x, v.z, v.yaw, v.lift);
}
const bounceOut = (t) => {          // settles with one small rebound (no physics: the end pose is exact)
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
/** Per frame: ease held proxies towards the pointer, lift / settle animation, cut-out visibility. */
function animate(dt) {
  if (!P.three) return;
  const k = 1 - Math.exp(-dt * 20);
  for (const [id, it] of P.three.items) {
    if (!it.anim) continue;
    const m = moveOf(id); if (!m) { it.anim = false; continue; }
    const v = it.vis, held = P.drag?.id === id;
    v.x += (m.x - v.x) * k; v.z += (m.z - v.z) * k; v.yaw += wrap(m.yaw - v.yaw) * k;
    if (held) v.lift += (LIFT - v.lift) * (1 - Math.exp(-dt * 16));
    else if (it.drop) {
      it.drop.t += dt;
      const t = Math.min(1, it.drop.t / DROP_S);
      v.lift = it.drop.from * (1 - bounceOut(t));
      if (t >= 1) it.drop = null;
    } else v.lift = 0;
    const done = !held && !it.drop && Math.hypot(m.x - v.x, m.z - v.z) < 0.002 && Math.abs(wrap(m.yaw - v.yaw)) < 0.002;
    if (done) { Object.assign(v, { x: m.x, z: m.z, yaw: m.yaw, lift: 0 }); it.anim = false; }
    applyVis(it);
  }
  P.cut?.update();
}
function removeItem(id) {
  const T = P.three, it = T?.items.get(id); if (!it) return;
  for (const k of ["ghost", "gf", "ghostTag", "proxy", "arrow", "atag"]) { T.proxies.remove(it[k]); it[k].element?.remove(); }
  it.ptag.element.remove();
  T.items.delete(id);
}
function poseItem(m, ev) {
  const it = proxyItem(m.id), o = objOf(m.id);
  if (!it.anim) { Object.assign(it.vis, { x: m.x, z: m.z, yaw: m.yaw, lift: 0 }); applyVis(it); }
  const c = COL[ev?.status || "ok"];
  for (const mat of [it.edgeMat, it.fillMat, it.floorMat, it.ringMat]) mat.color.setHex(c);
  // with the scan cut-out shown, the box is only a subtle outline around the real-looking object
  const cut = !!P.cut?.isCut(m.id);
  it.fillMat.opacity = cut ? 0.035 : 0.16; it.edgeMat.opacity = cut ? 0.55 : 1; it.floorMat.opacity = cut ? 0.07 : 0.3;
  it.fl.renderOrder = cut ? 1 : 6; it.floorMat.depthTest = cut;   // under the moved scan, not painted over it
  it.ptag.element.querySelector("small").textContent = cut ? `${shortName(o)} · scan cut-out` : shortName(o);
  it.ringMat.opacity = m.id === P.active ? 0.6 : 0.2;
  it.ptag.element.className = `pl-tag proxy ${ev?.status || "ok"} ${m.id === P.active ? "on" : ""}`;
  const a = new THREE.Vector3(o.center[0], 0.02, o.center[2]), b = new THREE.Vector3(m.x, 0.02, m.z), dist = a.distanceTo(b);
  it.arrow.geometry.setFromPoints([a, b]); it.arrow.computeLineDistances(); it.arrow.visible = dist > 0.08;
  it.atag.position.set((a.x + b.x) / 2, 0.03, (a.z + b.z) / 2); it.atag.visible = dist > 0.25;
  it.atag.element.textContent = `${f2(dist)} m`;
}
function drawGauge(ev) {
  const T = P.three; if (!T) return;
  T.gauge.clear();
  if (!ev?.gauge || APP.S.mode !== "plan") return;
  const { from, to } = ev.gauge;
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from[0], 0.03, from[1]), new THREE.Vector3(to[0], 0.03, to[1])]),
    new THREE.LineBasicMaterial({ color: COL[ev.status], transparent: true, opacity: 0.9, depthTest: false }));
  line.renderOrder = 7;
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.025, 16), new THREE.MeshBasicMaterial({ color: COL[ev.status], side: THREE.DoubleSide, depthTest: false }));
  dot.renderOrder = 7;
  dot.rotation.x = -Math.PI / 2; dot.position.set(to[0], 0.03, to[1]);
  const t = tag(`clearance ${f2(ev.clearance)} m`, "gauge");
  t.position.set(to[0], 0.08, to[1]);
  T.gauge.add(line, dot, t);
}
function tubeFor(wp, radius, color, opacity) {
  const path = new THREE.CurvePath();
  const pts = wp.map((p) => new THREE.Vector3(p[0], 0.035, p[2]));
  for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(pts[i - 1]) > 1e-4) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
  if (!path.curves.length) return null;
  return new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(32, Math.round(path.getLength() * 30)), radius, 6, false),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false }));
}
function drawRoutes() {
  const T = ensureThree();
  T.routes.clear();
  if (APP.S.mode !== "plan" || !P.compare) return;
  if (P.before?.ok) {
    // the original route as a dashed ribbon (thick enough to read over the scan): one instanced draw
    const wp = P.before.waypoints, dashes = [];
    for (let i = 1; i < wp.length; i++) {
      const dx = wp[i][0] - wp[i - 1][0], dz = wp[i][2] - wp[i - 1][2], L = Math.hypot(dx, dz);
      for (let s = 0; s + 0.08 <= L; s += 0.15) dashes.push([wp[i - 1][0] + (dx * (s + 0.04)) / L, wp[i - 1][2] + (dz * (s + 0.04)) / L, Math.atan2(dz, dx)]);
    }
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.08, 0.022), new THREE.MeshBasicMaterial({ color: 0xd8dce2, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide }), Math.max(1, dashes.length));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    dashes.forEach(([x, z, a], i) => mesh.setMatrixAt(i, m4.compose(v.set(x, 0.03, z), q.setFromEuler(e.set(-Math.PI / 2, 0, -a, "YXZ")), one)));
    mesh.count = dashes.length; mesh.renderOrder = 5;
    T.routes.add(mesh);
  }
  if (P.after?.ok) {
    const t = tubeFor(P.after.waypoints, 0.016, COL.route, 0.95); if (t) { t.renderOrder = 6; T.routes.add(t); }
    const end = P.after.waypoints.at(-1), ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.125, 40), new THREE.MeshBasicMaterial({ color: COL.route, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(end[0], 0.03, end[2]);
    T.routes.add(ring);
  }
}
/** Recolour, re-pose and re-check everything (no routing). */
function refresh() {
  if (!P.ready) return;
  ensureThree();
  for (const id of [...P.three.items.keys()]) if (!moveOf(id)) removeItem(id);
  syncCut();
  let act = null;
  // the active proxy last, so the obstacle field stays built for it while dragging
  P.evs = new Map();
  for (const m of [...P.moves].sort((a, b) => (a.id === P.active) - (b.id === P.active))) { const ev = evaluate(m.id, m); P.evs.set(m.id, ev); poseItem(m, ev); if (m.id === P.active) act = ev; }
  P.ev = act;
  P.zoneNow = zoneStatus();
  paintZone(P.zoneNow);
  drawGauge(act);
  highlight();
}
function highlight() {
  const S = APP.S;
  if (S.mode !== "plan" || !S.fac) return;
  const ids = P.moves.map((m) => m.id).filter((id) => id !== P.active);
  if (P.hover?.ok && !moveOf(P.hover.id)) ids.push(P.hover.id);
  S.fac.setHighlighted(ids, { selected: P.active || (S.selected?.kind === "object" ? S.selected.id : objOf(SUGGESTED) ? SUGGESTED : null), target: S.target.id });
}
/** Scan cut-outs follow the plan: one per moved object while the splats are loaded (box proxies only otherwise). */
function syncCut() {
  if (!P.cut && APP.S?.fac && APP.scene) P.cut = new SplatCut(APP.scene, APP.S.fac);
  if (!P.cut) return;
  P.cut.enabled = P.cutOn;
  try { P.cut.sync(P.moves.map((m) => m.id), objOf); } catch (e) { console.warn("scan cut-out unavailable", e); P.cut.enabled = false; P.cutOn = false; }
  for (const m of P.moves) { const it = P.three?.items.get(m.id); if (it) applyVis(it); }
}
const cutShown = () => !!P.cut && P.moves.some((m) => P.cut.isCut(m.id));

// ------------------------------------------------------------------ editing
function createProxy(id, { route = true, rec = true } = {}) {
  const o = objOf(id);
  if (!o) return APP.toast(`${esc(id)} cannot be moved in a plan.`);
  if (rec && (!moveOf(id) || P.active !== id)) record();
  if (!moveOf(id)) P.moves.push({ id, x: o.center[0], z: o.center[2], yaw: o.yaw });   // exactly where it is: "moved 0 m"
  P.active = id; P.dirtyField = true; P.editing = true; P.toTop = true;
  refresh(); renderAll();
  if (route) scheduleRoute(0);
}
function removeProxy(id) {
  record();
  P.moves = P.moves.filter((m) => m.id !== id);
  if (P.active === id) P.active = P.moves.at(-1)?.id || null;
  P.dirtyField = true; refresh(); renderAll();
  if (!P.moves.length) { P.after = null; drawRoutes(); if (APP.S.curve && !APP.S.robot.done) APP.replan({ quiet: true }); } else scheduleRoute(0);
}
function setPose(id, pose, { route = true, routeDelay = 0 } = {}) {
  const m = moveOf(id); if (!m) return;
  Object.assign(m, { x: +pose.x.toFixed(3), z: +pose.z.toFixed(3), yaw: +wrap(pose.yaw).toFixed(4) });
  refresh(); scheduleCard();
  if (route) scheduleRoute(routeDelay);
}
function rotate(dr) {
  const m = moveOf(P.active); if (!m) return;
  if (P.drag?.id === m.id) {                    // turning while held: part of the same pick-up, route on drop
    P.drag.rotated = true;
    const it = P.three?.items.get(m.id); if (it) it.anim = true;
    return setPose(m.id, { ...m, yaw: m.yaw + dr }, { route: false });
  }
  record("turn");
  setPose(m.id, { ...m, yaw: m.yaw + dr }, { routeDelay: 300 });
}
function nudge(dx, dz) { const m = moveOf(P.active); if (!m) return; record("nudge"); setPose(m.id, { ...m, x: m.x + dx, z: m.z + dz }, { routeDelay: 350 }); }
function reset({ quiet = false, rec = true } = {}) {
  if (rec && P.moves.length) record();
  if (P.drag) endDrag({ silent: true });
  P.moves = []; P.active = null; P.after = null; P.dirtyField = true; P.editing = false; P.query = ""; P.ev = null; P.zoneNow = null;
  stopHold();
  clearTimeout(P.routeTimer); P.afterSeq++; P.routeBusy = false;
  if (P.ready) { refresh(); drawRoutes(); }
  renderAll();
  if (APP.S?.curve && !APP.S.robot.done) APP.replan({ quiet: true });
  if (!quiet) APP.toast(`Original layout restored. The plan is cleared and robot routes use the scanned layout again.${P.undo.length ? " Undo (Ctrl+Z) brings it back." : ""}`);
}

// ------------------------------------------------------------------ pointer: drag the proxy on the floor
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _hit = new THREE.Vector3();
function rayFrom(e) {
  const r = APP.canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, APP.camera);
  return _ray.ray;
}
/** Ray against the proxy box (analytic, in the box frame) or its floor footprint. Returns the hit height or null. */
function hitProxy(ray, m) {
  const it = P.three?.items.get(m.id); if (!it) return null;
  return hitBox(ray, m.x, m.z, m.yaw, it.w, it.h, it.d, it.bottom, 0.06);
}
/** Ray against an oriented box standing at (x, z) (analytic, in the box frame). Returns the entry height or null. */
function hitBox(ray, x, z, yaw, w, hgt, d, bottom, pad = 0) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw), cy = bottom + hgt / 2;
  const ox = ray.origin.x - x, oy = ray.origin.y - cy, oz = ray.origin.z - z;
  const lo = [ox * cs + oz * sn, oy, -ox * sn + oz * cs], ld = [ray.direction.x * cs + ray.direction.z * sn, ray.direction.y, -ray.direction.x * sn + ray.direction.z * cs];
  const h = [w / 2 + pad, hgt / 2 + pad * 0.66, d / 2 + pad];
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-9) { if (Math.abs(lo[i]) > h[i]) return null; continue; }
    let a = (-h[i] - lo[i]) / ld[i], b = (h[i] - lo[i]) / ld[i]; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 <= t1 && t1 > 0) { const t = Math.max(t0, 0); return Math.max(0, Math.min(bottom + hgt, ray.origin.y + ray.direction.y * t)); }
  return null;
}
/** The scene object under the ray (Facility.pick), skipping the original boxes of objects that already have a proxy. */
function pickUnder(ray) {
  const fac = APP.S.fac, id = fac.pick(ray);
  if (!id || !moveOf(id)) return id;
  let best = null;                               // same rule as Facility.pick: the smallest box under the cursor
  for (const e of P.objs) {
    const o = e.o; if (moveOf(o.id)) continue;
    if (fac.cutaway && e.bottom > fac.cutY) continue;
    const [w, h, d] = o.size.map((v) => Math.max(v, 0.03));
    if (hitBox(ray, o.center[0], o.center[2], o.yaw, w, h, d, o.center[1] - h / 2) == null) continue;
    const vol = w * h * d;
    if (!best || vol < best.vol) best = { id: o.id, vol };
  }
  return best?.id ?? null;
}
function pickProxy(ray) {
  const order = [...P.moves].sort((a, b) => (b.id === P.active) - (a.id === P.active));
  for (const m of order) { const y = hitProxy(ray, m); if (y != null) return { m, y }; }
  return null;
}
/** Press on a proxy or on any movable object: pick it up at once (creating its proxy) and start dragging. */
function onPointerDown(e) {
  if (APP.S?.mode !== "plan" || e.button !== 0 || !P.ready || P.drag || e.isPrimary === false) return;
  const ray = rayFrom(e), before = snapshot();
  let id, y, created = false;
  const hit = pickProxy(ray);
  if (hit) { id = hit.m.id; y = hit.y; }
  else {
    const oid = pickUnder(ray), o = oid && objOf(oid);
    if (!o || !movable(o).ok) return;            // orbit as usual; a click explains why it stays put (onPick)
    const [w, h, d] = o.size.map((v) => Math.max(v, 0.04)), bottom = Math.max(0, o.center[1] - o.size[1] / 2);
    y = hitBox(ray, o.center[0], o.center[2], o.yaw, w, h, d, bottom) ?? bottom + h / 2;
    id = oid;
  }
  _plane.constant = -y;
  if (!ray.intersectPlane(_plane, _hit)) return;
  const at = _hit.clone();
  if (!moveOf(id)) { createProxy(id, { route: false, rec: false }); created = true; }
  else if (P.active !== id || !P.editing) { P.active = id; P.dirtyField = true; P.editing = true; refresh(); renderAll(); }
  const m = moveOf(id);
  P.drag = { id, pid: e.pointerId, y, off: [m.x - at.x, m.z - at.z], moved: false, rotated: false, created, before, x0: e.clientX, y0: e.clientY };
  const it = proxyItem(id); it.anim = true; it.drop = null;     // lifts a few cm while held
  APP.controls.enabled = false;               // OrbitControls ignores this pointer
  try { APP.canvas.setPointerCapture(e.pointerId); } catch {}
  APP.canvas.style.cursor = "grabbing";
  setHover(null);
  e.preventDefault();
}
function onPointerMove(e) {
  if (APP.S?.mode !== "plan") return;
  if (!P.drag) {                               // hover affordance (throttled to one pick per frame)
    if (e.target !== APP.canvas || e.buttons) { if (P.hover) setHover(null); return; }
    P.hoverEvt = { clientX: e.clientX, clientY: e.clientY, mouse: e.pointerType === "mouse" };
    if (!P.hoverRaf) P.hoverRaf = requestAnimationFrame(doHover);
    return;
  }
  if (e.pointerId !== P.drag.pid) return;
  if (!P.drag.moved && Math.hypot(e.clientX - P.drag.x0, e.clientY - P.drag.y0) <= 4) return;   // a click, not a drag
  P.drag.moved = true;
  _plane.constant = -P.drag.y;
  if (!rayFrom(e).intersectPlane(_plane, _hit)) return;
  let x = _hit.x + P.drag.off[0], z = _hit.z + P.drag.off[1];
  if (P.snap) { x = snap(x); z = snap(z); }
  const b = APP.S.data.bounds;
  x = Math.min(b.max[0], Math.max(b.min[0], x)); z = Math.min(b.max[2], Math.max(b.min[2], z));
  const m = moveOf(P.drag.id);
  if (m && (m.x !== x || m.z !== z)) setPose(m.id, { ...m, x, z }, { route: false });   // live checks; route on drop
}
function onPointerUp(e) {
  if (!P.drag || e.pointerId !== P.drag.pid) return;
  try { APP.canvas.releasePointerCapture(e.pointerId); } catch {}
  endDrag();
}
/** Let go: the object settles (short drop animation), the change becomes one undo step and the route is re-planned. */
function endDrag({ silent = false } = {}) {
  const d = P.drag; if (!d) return;
  P.drag = null;
  if (d.moved) { P.justDragged = true; setTimeout(() => (P.justDragged = false), 0); }
  APP.controls.enabled = true;
  APP.canvas.style.cursor = "grab";
  const it = P.three?.items.get(d.id);
  if (it) { it.anim = true; it.drop = { t: 0, from: it.vis.lift }; }
  if (silent) return;
  if (d.moved || d.rotated || d.created) record("edit", d.before);
  renderAll();
  if (d.moved || d.rotated || d.created) scheduleRoute(0);
}
function setHover(h) {
  const prev = P.hover;
  P.hover = h;
  const tip = hoverTip();
  if (!h || !h.mouse) tip.classList.add("hidden");
  else {
    tip.classList.remove("hidden");
    tip.innerHTML = h.ok ? `<b>${esc(h.name)}</b><span>${h.proxy ? "Drag to move · scroll or Q / E to turn" : "Drag to pick it up and move it"}</span>` : `<b>${esc(h.name)}</b><span>Stays put in a plan</span>`;
    tip.style.transform = `translate(${Math.round(h.x + 16)}px, ${Math.round(h.y + 18)}px)`;
  }
  if (!P.drag) APP.canvas.style.cursor = h?.ok ? "grab" : "";
  if ((prev?.id || null) !== (h?.id || null)) highlight();
}
function hoverTip() {
  let el = document.querySelector(".pl-hover");
  if (!el) { el = document.createElement("div"); el.className = "pl-hover hidden"; el.setAttribute("aria-hidden", "true"); document.body.appendChild(el); }
  return el;
}
function doHover() {
  P.hoverRaf = 0;
  const e = P.hoverEvt; if (!e || P.drag || APP.S?.mode !== "plan" || !P.ready) return;
  const ray = rayFrom(e), ph = pickProxy(ray);
  if (ph) return setHover({ id: ph.m.id, ok: true, proxy: true, name: shortName(objOf(ph.m.id)), x: e.clientX, y: e.clientY, mouse: e.mouse });
  const id = pickUnder(ray), o = id && objOf(id);
  if (!o) return setHover(null);
  setHover({ id, ok: movable(o).ok, proxy: false, name: shortName(o), x: e.clientX, y: e.clientY, mouse: e.mouse });
}
/** Mouse wheel turns the object while it is held, or while the pointer is over the selected proxy (else: zoom). */
function onWheel(e) {
  if (APP.S?.mode !== "plan" || !P.ready || !P.moves.length) return;
  let id = P.drag?.id;
  if (!id && P.active && P.editing) { const h = pickProxy(rayFrom(e)); if (h?.m.id === P.active) id = P.active; }
  if (!id) return;
  e.preventDefault(); e.stopImmediatePropagation();          // OrbitControls does not zoom for this wheel
  P.active = id;
  P.wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  if (Math.abs(P.wheelAcc) >= 50) { rotate(Math.sign(P.wheelAcc) * Math.PI / 12); P.wheelAcc = 0; }   // one notch = 15°
}
/** Screen-aligned floor directions (the camera's forward/right, snapped to the world axes). */
function screenDir(name) {
  const fwd = new THREE.Vector3(); APP.camera.getWorldDirection(fwd); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const ax = Math.abs(fwd.x) > Math.abs(fwd.z) ? [Math.sign(fwd.x), 0] : [0, Math.sign(fwd.z)];   // snap to world axes
  const rx = Math.abs(right.x) > Math.abs(right.z) ? [Math.sign(right.x), 0] : [0, Math.sign(right.z)];
  return { fwd: [ax[0], ax[1]], back: [-ax[0], -ax[1]], right: [rx[0], rx[1]], left: [-rx[0], -rx[1]] }[name];
}
const KEYDIR = { ArrowUp: "fwd", KeyW: "fwd", ArrowDown: "back", KeyS: "back", ArrowRight: "right", KeyD: "right", ArrowLeft: "left", KeyA: "left" };
function onKey(e) {
  if (APP.S?.mode !== "plan" || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
    e.preventDefault();
    return (e.code === "KeyY" || e.shiftKey) ? redo() : undo();
  }
  if (!P.active || e.ctrlKey || e.metaKey || e.altKey) return;
  const step = e.shiftKey ? 0.25 : SNAP;
  // arrows / W A S D move in screen-aligned directions while the proxy is being moved
  const dn = KEYDIR[e.code];
  if (dn && P.editing) { e.preventDefault(); const k = screenDir(dn); return nudge(k[0] * step, k[1] * step); }
  if (P.editing && (e.code === "KeyQ" || e.code === "KeyE")) { e.preventDefault(); return rotate((e.code === "KeyQ" ? -1 : 1) * (e.shiftKey ? Math.PI / 4 : Math.PI / 12)); }
  if (e.key === "Enter" && P.editing && !e.target.closest?.("button, a")) { e.preventDefault(); return done(); }
  if (e.key === "r" || e.key === "R") { e.preventDefault(); return rotate((e.shiftKey ? -1 : 1) * Math.PI / 2); }
  if (e.key === "[") return rotate(-Math.PI / 12);
  if (e.key === "]") return rotate(Math.PI / 12);
  if (e.key === "Delete") return removeProxy(P.active);
}

// ------------------------------------------------------------------ summary + export
export function summary() {
  const z0 = zoneStatus([]), z1 = P.zoneNow || zoneStatus();
  const moves = P.moves.map((m) => {
    const o = objOf(m.id), ev = evaluate(m.id, m);
    return { object_id: o.id, name: nameOf(o), label: o.label, label_source: o.label_source,
      original: { x: +o.center[0].toFixed(3), z: +o.center[2].toFixed(3), yaw_deg: deg(o.yaw) },
      proposed: { x: m.x, z: m.z, yaw_deg: deg(m.yaw) },
      displacement_m: +Math.hypot(m.x - o.center[0], m.z - o.center[2]).toFixed(2), rotation_deg: deg(wrap(m.yaw - o.yaw)),
      collisions: ev.hits.map((h) => ({ object_id: h.id, label: h.proxy ? "planning proxy" : h.label })),
      scan_cells_overlapped: ev.scanCells, off_floor_cells: ev.offFloor,
      clearance_m: ev.clearance == null ? null : +ev.clearance.toFixed(2),
      nearest_object: ev.nearest ? { object_id: ev.nearest.o.id, label: ev.nearest.o.label, distance_m: +ev.nearest.d.toFixed(2) } : null,
      status: ev.collision ? "collision" : ev.offScan ? "off scanned floor" : { ok: "clear", tight: "tight" }[ev.status] };
  });
  const r = (x) => (x ? (x.ok ? { ok: true, length_m: x.length_m, min_clearance_m: x.min_clearance_m, collision_free: x.collision_free, compute_ms: x.compute_ms } : { ok: false, reason: x.reason }) : null);
  const before = r(P.before), after = P.moves.length ? r(P.after) : before;
  // one verdict for the whole plan, computed from every move (same rule as the card)
  const problems = [
    ...(!moves.length ? ["no equipment moved"] : !movedAny() ? ["nothing has been moved from its scanned position yet"] : []),
    ...moves.filter((m) => m.status === "collision" || m.status === "off scanned floor").map((m) => `${m.name} ${m.status === "collision" ? "collides with known obstacles" : "is off the scanned floor"}`),
    ...(z1.clear ? [] : [`${P.target.asset?.tag || "target"} service zone still obstructed by ${z1.obstructions.map((o) => o.id).join(", ")}`]),
    ...(moves.length && !after ? ["route with the proposed layout not computed yet"] : after && !after.ok ? [`no robot route with the proposed layout (${after.reason})`] : after && after.collision_free === false ? ["robot route not collision-free"] : []),
  ];
  return {
    verdict: { fits: problems.length === 0, problems },
    title: `Service access for ${P.target.asset?.tag || P.target.id}`, disclaimer: DISCLAIMER,
    created: new Date().toISOString(), scan_modified: false,
    target: { object_id: P.target.id, tag: P.target.asset?.tag, asset_id: P.target.asset?.asset_id },
    service_zone: { assumption: `Assumed illustrative clearance requirement: ${ZONE_DEPTH.toFixed(1)} m deep × pump width + ${ZONE_EXTRA.toFixed(1)} m, on the side facing the open floor. Not a Valmet or OEM figure.`,
      rect: rnd(P.zone), before: { clear: z0.clear, obstructed_by: z0.obstructions.map((o) => o.id), free_floor_pct: z0.freePct },
      after: { clear: z1.clear, obstructed_by: z1.obstructions.map((o) => o.id), free_floor_pct: z1.freePct } },
    moves,
    collisions: moves.reduce((n, m) => n + m.collisions.length + (m.scan_cells_overlapped > 0 ? 1 : 0), 0),
    route: { start: startXZ().map((v) => +v.toFixed(3)), before, after,
      delta_m: before?.ok && after?.ok ? +(after.length_m - before.length_m).toFixed(2) : null },
    method: "Footprints are gravity-aligned oriented boxes from the scan segmentation; collisions = box overlap with known objects in the 0.12–1.25 m band plus occupied 5 cm grid cells; clearance = grid distance transform; routes = the same A* planner the robot uses, with the proposed footprints as obstacles and the old footprints as free floor.",
  };
}
function markdown(s) {
  const L = [`# Maintenance plan · ${s.title}`, "", `> ${s.disclaimer}.`, "> The scan data is unchanged; moved equipment is shown as virtual planning proxies. Verify on site before moving anything.",
    "> In the 3D view a moved object may be drawn as an approximate cut-out of the scan inside its box (it can include nearby fragments); collisions and clearance always use the oriented boxes.", "",
    `Created ${s.created}`, "", "## Verdict", s.verdict.fits ? "It fits (approximate check): no collisions with known obstacles, every footprint is on scanned floor, the service zone is clear and the robot has a collision-free route."
      : `Does NOT fit:\n${s.verdict.problems.map((p) => `- ${p}`).join("\n")}`, "", "## Proposed moves"];
  if (!s.moves.length) L.push("", "No equipment moved (original layout).");
  for (const m of s.moves) {
    L.push("", `### ${m.name}`, `- Label: ${m.label} (${m.label_source})`,
      `- Original: x ${m.original.x}, z ${m.original.z}, yaw ${m.original.yaw_deg}°`,
      `- Proposed: x ${m.proposed.x}, z ${m.proposed.z}, yaw ${m.proposed.yaw_deg}°`,
      `- Displacement: ${m.displacement_m} m, rotation ${m.rotation_deg > 0 ? "+" : ""}${m.rotation_deg}°`,
      `- Check: ${m.status}${m.off_floor_cells ? ` (${m.off_floor_cells} footprint cells outside the scanned floor)` : ""}`,
      `- Collisions with known obstacles: ${m.collisions.length || m.scan_cells_overlapped ? [...m.collisions.map((c) => `${c.object_id} (${c.label})`), ...(m.scan_cells_overlapped ? [`${m.scan_cells_overlapped} occupied scan cells`] : [])].join(", ") : "none"}`,
      `- Approximate clearance to the nearest obstacle: ${m.clearance_m == null ? "n/a" : m.clearance_m + " m"}${m.nearest_object ? ` (nearest known object ${m.nearest_object.object_id}, ${m.nearest_object.label}, ${m.nearest_object.distance_m} m)` : ""}`);
  }
  const z = s.service_zone, rt = s.route, ln = (x) => (x?.ok ? `${x.length_m} m, min clearance ${x.min_clearance_m} m, ${x.collision_free ? "collision-free" : "check"}, A* ${x.compute_ms} ms` : `no route (${x?.reason || "n/a"})`);
  L.push("", `## ${s.target.tag} service zone`, `- ${z.assumption}`,
    `- Before: ${z.before.clear ? "clear" : "obstructed by " + z.before.obstructed_by.join(", ")} (${z.before.free_floor_pct}% free floor)`,
    `- After: ${z.after.clear ? "clear" : "obstructed by " + z.after.obstructed_by.join(", ")} (${z.after.free_floor_pct}% free floor)`,
    "", `## Robot route to ${s.target.tag}`, `- Before (scanned layout): ${ln(rt.before)}`, `- After (proposed layout): ${ln(rt.after)}`,
    `- Change: ${rt.delta_m == null ? "n/a" : (rt.delta_m >= 0 ? "+" : "") + rt.delta_m + " m"}`, "", "## Method", s.method, "");
  return L.join("\n");
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok;
  }
}
function exportPlan(kind) {
  const s = summary(), base = `maintenance-plan-${(s.target.tag || "target").toLowerCase()}`;
  APP.planning.lastExport = { kind, summary: s, markdown: markdown(s) };
  if (kind === "md") download(`${base}.md`, markdown(s), "text/markdown");
  if (kind === "json") download(`${base}.json`, JSON.stringify(s, null, 2), "application/json");
  if (kind === "copy") return copyText(markdown(s)).then((ok) => APP.toast(ok ? "Plan summary copied as Markdown." : "Copy is blocked in this browser: use Download instead."));
  APP.toast(`Plan exported as ${kind === "md" ? "Markdown" : "JSON"}. It states that it is an approximate simulation.`);
}
async function draftWorkOrder() {
  const a = P.target.asset; if (!a) return;
  await APP.showWorkOrder(a.asset_id);
  const s = summary(), body = $("#sheet .card-b"); if (!body) return;
  const moves = s.moves.map((m) => `<div class="step"><span class="k">${icon("check")}</span><span>Move ${esc(m.name)} ${m.displacement_m} m to x ${m.proposed.x}, z ${m.proposed.z}${m.rotation_deg ? `, turned ${m.rotation_deg}°` : ""}. ${m.status === "clear" ? "No collision with known obstacles" : m.status === "tight" ? "Tight clearance" : m.status === "collision" ? "Collision: re-plan" : "Off the scanned floor: re-plan"}, ≈${m.clearance_m ?? "?"} m clearance.</span></div>`).join("");
  body.insertAdjacentHTML("beforeend", `<div class="section"><div class="label">Access preparation <span class="pill amber">Planning simulation</span></div>
    ${moves || '<p class="note">No layout change planned.</p>'}
    ${kv("Service zone", s.service_zone.after.clear ? '<span class="pl-ok">Clear (assumed 1.0 m zone)</span>' : `<span class="pl-bad">Obstructed by ${esc(s.service_zone.after.obstructed_by.join(", "))}</span>`)}
    ${kv("Robot route", s.route.after?.ok ? `${s.route.after.length_m} m · clearance ${s.route.after.min_clearance_m} m` : "No route")}
    ${kv("Plan check", s.verdict.fits ? '<span class="pl-ok">Fits (approximate check)</span>' : `<span class="pl-bad">Does not fit: ${esc(s.verdict.problems.join("; "))}</span>`)}
    <p class="note" style="margin-top:8px">${esc(DISCLAIMER)}. Confirm the new position on site.</p></div>`);
}

// ------------------------------------------------------------------ stages: 1 Pick → 2 Move → 3 Check
const stage = () => (!P.moves.length ? "pick" : P.editing ? "move" : "check");
const movedAny = () => P.moves.some((m) => { const o = objOf(m.id); return Math.hypot(m.x - o.center[0], m.z - o.center[2]) > 0.04 || Math.abs(wrap(m.yaw - o.yaw)) > 0.01; });
/** Moves that fail on their own (every move, not only the active one): collision or off the scanned floor. */
const evOf = (m) => P.evs?.get(m.id) || evaluate(m.id, m);
const failingMoves = () => P.moves.map((m) => ({ m, ev: evOf(m) })).filter(({ ev }) => ev.status === "bad")
  .map(({ m, ev }) => ({ id: m.id, name: shortName(objOf(m.id)), why: ev.collision ? "collides" : "is off the scanned floor", ev }));
const whyText = (f) => `${esc(f.name)} (${f.id}) ${f.why}`;
/** The plan is good: something moved, no move collides or leaves the scanned floor, the service zone is clear and the
 *  robot still has a collision-free route. The card, the stepper, the toast and the exports all use this one verdict. */
const planGood = () => {
  if (!P.moves.length || !P.after || P.routeBusy) return false;
  const z = P.zoneNow || zoneStatus();
  return movedAny() && !failingMoves().length && z.clear && P.after.ok && P.after.collision_free !== false;
};
function stepperHTML() {
  const st = stage(), good = planGood();
  const s = (n, label, key) => {
    const order = { pick: 0, move: 1, check: 2 }, i = order[key], cur = order[st];
    const state = key === "check" ? (st === "check" ? (good ? "done" : "cur") : "") : i < cur ? "done" : i === cur ? "cur" : "";
    return `<div class="pl-st ${state}"><span class="k">${state === "done" ? icon("check") : n}</span><span>${label}</span></div>`;
  };
  return `<div class="pl-stepper" aria-label="Steps">${s(1, "Pick", "pick")}<i></i>${s(2, "Move", "move")}<i></i>${s(3, "Check", "check")}</div>`;
}
// big move pad for the proxy: hold to keep moving (works with mouse, touch and keyboard focus)
const PADI = {
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>', left: '<path d="M19 12H5M11 6l-6 6 6 6"/>', right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const pi = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PADI[n]}</svg>`;
function movePadHTML() {
  const b = (mv, ico, label) => `<button type="button" class="pl-mv" data-pl-mv="${mv}" title="${label}" aria-label="${label}">${ico}</button>`;
  return `<div class="pl-pad" role="group" aria-label="Move the ${esc(shortName(objOf(P.active)))}">
      ${b("l15", ic("rotL"), "Turn 15° left (Q)")}${b("fwd", pi("up"), "Move away from you (↑ or W)")}${b("r15", ic("rotR"), "Turn 15° right (E)")}
      ${b("left", pi("left"), "Move left (← or A)")}${b("r90", ic("turn"), "Turn 90° (R)")}${b("right", pi("right"), "Move right (→ or D)")}
      <span></span>${b("back", pi("down"), "Move towards you (↓ or S)")}<span></span>
    </div>
    <p class="pl-padnote">Press and hold an arrow to keep moving. Or drag it in the 3D view (mouse wheel turns it while you hold it), or use the arrow keys / W A S D (Shift = bigger steps), Q E to turn.</p>`;
}
function padStep(mv, big = false) {
  if (!P.active) return;
  if (mv === "l15") return rotate(-Math.PI / 12);
  if (mv === "r15") return rotate(Math.PI / 12);
  if (mv === "r90") return rotate(Math.PI / 2);
  const k = screenDir(mv); if (!k) return;
  const s = big ? 0.25 : SNAP;
  nudge(k[0] * s, k[1] * s);
}
function stopHold() { if (P.hold) { clearTimeout(P.hold.t); P.hold = null; } }
function onPadDown(e) {
  const b = e.target.closest?.("[data-pl-mv]"); if (!b || e.button > 0 || APP.S?.mode !== "plan") return;
  e.preventDefault();
  stopHold();
  P.editing = true;
  const mv = b.dataset.plMv, pid = e.pointerId;
  padStep(mv);
  if (mv === "r90") return;                               // 90° is one step per press
  const tick = (n) => { if (!P.hold) return; padStep(mv); P.hold.t = setTimeout(() => tick(n + 1), n > 6 ? 60 : 110); };
  P.hold = { pid, t: setTimeout(() => tick(0), 380) };
}
function onPadUp(e) { if (P.hold && (e.type === "blur" || e.pointerId === P.hold.pid)) stopHold(); }
async function done() {
  stopHold();
  P.editing = false; P.toTop = true;
  clearTimeout(P.routeTimer);
  renderAll();
  if (P.moves.length) await computeAfter();
  const z = P.zoneNow || zoneStatus(), ev = P.ev;
  APP.toast(planGood() ? `It fits: no collisions, ${esc(P.target.asset?.tag)} can be reached and the robot still has a route.`
    : ev?.status === "bad" ? (ev.collision ? "It collides with something: press “Move it again” and find free floor." : "It is off the scanned floor: press “Move it again” and put it on mapped floor.")
    : failingMoves().length ? `Another moved object fails: ${failingMoves().map(whyText).join("; ")}.` : !z.clear ? `${esc(P.target.asset?.tag)} service zone is still blocked: move it further away.` : "Checked. See the result in the card.", 4200);
}
async function suggest() {
  if (!P.active || P.active === SUGGESTED || !moveOf(P.active)) return demo();
  const id = P.active, spot = await findSpot(id);
  if (!spot) return APP.toast("No free spot found nearby for this object. Try moving it by hand.");
  record();
  setPose(id, spot, { route: false });
  P.editing = false; P.toTop = true; clearTimeout(P.routeTimer);
  await computeAfter(); renderAll();
}

// ------------------------------------------------------------------ UI: left card (steps + object choice)
function step(n, label, state) { return `<div class="pl-step ${state}"><span class="k">${state === "done" ? icon("check") : n}</span><span>${label}</span></div>`; }
function leftHTML() {
  if (!P.ready) return `<div class="card-h"><span class="t">Maintenance planning</span></div><div class="card-b"><span class="note">Loading the floor map…</span></div>`;
  const st = stage(), good = planGood();
  const s1 = P.moves.length ? "done" : "cur", s2 = st === "move" ? "cur" : st === "check" ? "done" : "", s3 = st === "check" ? (good ? "done" : "cur") : "";
  const act = P.active && objOf(P.active);
  let body;
  if (act) {
    body = `<div class="section"><div class="label"><span>Moving</span><span class="pl-pill ${P.ev?.status || "ok"}">${P.ev?.status === "bad" && !P.ev.collision ? "Off scan" : { ok: "Clear", tight: "Tight", bad: "Collision" }[P.ev?.status || "ok"]}</span></div>
      <div class="pl-moving"><b>${esc(nameOf(act))}</b><small>${esc(act.label)} · ${act.label_source === "review-corrected" ? "review-corrected label" : Math.round(act.confidence * 100) + "% label confidence"}</small></div>
      <div class="pl-keys"><span>${ic("move")}Drag it on the floor in the 3D view, or use the arrow buttons in the card</span><span>Mouse wheel while holding it, <span class="kbd">Q</span> <span class="kbd">E</span> turn 15° · <span class="kbd">R</span> turn 90°</span><span><span class="kbd">←↑↓→</span> or <span class="kbd">W A S D</span> move 5 cm · <span class="kbd">Shift</span> 25 cm</span><span><span class="kbd">Ctrl</span> <span class="kbd">Z</span> undo · <span class="kbd">Ctrl</span> <span class="kbd">Shift</span> <span class="kbd">Z</span> redo</span></div></div>
      ${proxiesHTML()}
      <div class="section"><button class="link" data-pl-more>${icon("plus")}Move another object</button><p class="note" style="margin-top:4px">Or just click another object in the room.</p></div>`;
  } else body = choiceHTML();
  return `<div class="card-h"><span class="t">Maintenance planning</span><span class="card-tools"><span class="pill amber">Simulation</span><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b">
      <div class="pl-steps">${step(1, "Click any object in the room to pick it up", s1)}${step(2, "Drag it out of the way", s2)}${step(3, "Check the result", s3)}</div>
      ${body}
    </div>`;
}
function proxiesHTML() {
  return P.moves.length > 1 ? `<div class="section"><div class="label">Objects in this plan</div>${P.moves.map((m) => `<button class="list-row ${m.id === P.active ? "on" : ""}" data-pl-act="${m.id}"><span class="n">${ic("box")}</span><span class="nm"><b>${esc(shortName(objOf(m.id)))}</b><small>${m.id}</small></span><span class="link" data-pl-del="${m.id}" title="Remove from the plan">${icon("close")}</span></button>`).join("")}</div>` : "";
}
function choiceHTML(suffix = "") {
  const S = APP.S, sug = objOf(SUGGESTED), d = sug ? boxDist(footprint(sug), footprint(P.target)) : 0;
  const sel = S.selected && S.selected.kind === "object" && S.selected.id !== SUGGESTED ? S.selected : null;
  return `${!suffix ? leadHTML() : ""}${sug && !suffix ? `<div class="section"><div class="label">Suggested first move for ${esc(P.target.asset?.tag || "the target")} service</div>
      <button class="pl-sugg" data-pl-pick="${SUGGESTED}"><span class="pl-sugg-i">${ic("box")}</span><span class="nm"><b>Hand pallet truck</b><small>${SUGGESTED} · ${gap(d)} from ${esc(P.target.asset?.tag)} · in its service zone</small></span>${icon("chev")}</button></div>` : ""}
    ${sel ? `<div class="section"><button class="btn block" data-pl-pick="${sel.id}">${icon("target")}Use current selection · ${esc(shortName(sel))}</button></div>` : ""}
    <div class="section"><div class="label">Or search by name</div>
      <input class="search" id="plQ${suffix}" data-pl-q placeholder="Search label or ID, e.g. cart, cabinet, OBJ-010" value="${esc(P.query)}" autocomplete="off"/>
      <div id="plRes${suffix}" class="pl-res">${resultsHTML()}</div></div>`;
}
/** First thing in Plan: you can grab anything in the room, like in a game or a 3D modelling tool. */
const leadHTML = () => `<div class="pl-lead">${ic("move")}<span><b>Click any object in the room to pick it up</b>, drag it across the floor and let go. Mouse wheel or Q / E turns it. Ctrl+Z undoes.</span></div>`;
function resultsHTML() {
  const q = P.query.trim().toLowerCase();
  if (!q) return "";
  const res = P.objs.map((e) => e.o).filter((o) => `${o.id} ${o.label} ${o.category || ""} ${o.asset?.tag || ""}`.toLowerCase().includes(q))
    .sort((a, b) => (b.label_source === "review-corrected") - (a.label_source === "review-corrected") || b.confidence - a.confidence).slice(0, 8);
  return res.map((o) => `<button class="list-row" data-pl-pick="${o.id}"><span class="n">${ic("box")}</span><span class="nm"><b>${esc(shortName(o))}</b><small>${o.id} · ${o.size.map((v) => v.toFixed(2)).join(" × ")} m</small></span>${icon("chev")}</button>`).join("")
    || '<p class="note" style="padding:6px 0">No matching object.</p>';
}
function bindSearch(root) {
  root.querySelectorAll("[data-pl-q]").forEach((inp) => {
    const res = inp.nextElementSibling;
    inp.oninput = (e) => { P.query = e.target.value; res.innerHTML = resultsHTML(); };
  });
}
function renderLeft() {
  if (APP.S?.mode !== "plan") return;
  const el = $("#left"), q = document.activeElement?.id === "plQ";
  el.classList.remove("tall");
  el.innerHTML = leftHTML();
  el.onclick = onLeftClick;
  bindSearch(el);
  const inp = $("#plQ");
  if (inp && q) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}
/** Shared by the left card and the phone copy of it inside the bottom sheet. Returns true when handled. */
function onListClick(e) {
  const del = e.target.closest("[data-pl-del]"); if (del) { e.stopPropagation(); removeProxy(del.dataset.plDel); return true; }
  const a = e.target.closest("[data-pl-act]"); if (a) { P.active = a.dataset.plAct; P.dirtyField = true; P.editing = true; refresh(); renderAll(); return true; }
  if (e.target.closest("[data-pl-more]")) { P.active = null; P.editing = false; refresh(); renderAll(); return true; }
  const p = e.target.closest("[data-pl-pick]"); if (p) { pick(p.dataset.plPick); return true; }
  return false;
}
function onLeftClick(e) {
  if (e.target.closest("[data-min-card]")) return;
  onListClick(e);
}
function pick(id) {
  const o = objOf(id); if (!o) return;
  APP.S.selected = o;
  createProxy(id);
  frameView(0.9, "top");                                // a floor-plan view makes free floor obvious
}

// ------------------------------------------------------------------ UI: right card (actions first, then the summary)
const verdict = (ev, z, after) => {
  if (!ev) return "";
  if (ev.status === "bad" && !ev.collision) return `<div class="pl-verdict bad">${icon("close")}<span><b>Off the scanned floor.</b> ${ev.offFloor} footprint cells lie where the scan shows no floor, so it cannot confirm the spot. Move it onto mapped floor.</span></div>`;
  if (ev.status === "bad") return `<div class="pl-verdict bad">${icon("close")}<span><b>Collision</b> with ${ev.hits.length ? esc(ev.hits.slice(0, 2).map((h) => h.proxy ? `proxy ${h.id}` : `${h.id} (${h.label})`).join(", ")) : "scanned geometry"}${ev.hits.length > 2 ? ` +${ev.hits.length - 2}` : ""}. Move it to free floor.</span></div>`;
  const zt = z.clear ? `${esc(P.target.asset?.tag)} service zone clear` : `Service zone still blocked by ${esc(z.obstructions.map((o) => o.name).join(", "))}`;
  const rt = after && !after.ok ? " · <b>no robot route</b>" : "";
  return `<div class="pl-verdict ${ev.status === "tight" || !z.clear || rt ? "tight" : "ok"}">${icon(ev.status === "ok" && z.clear && !rt ? "check" : "help")}<span><b>${ev.status === "tight" ? "Fits, tight clearance" : "Fits"}</b> · no collisions · ${zt}${rt}</span></div>`;
};
function routeRow(label, r, cls = "") {
  if (!r) return `<div class="pl-rt ${cls}"><span>${label}</span><span class="note">${P.routeBusy ? "planning…" : "—"}</span></div>`;
  if (!r.ok) return `<div class="pl-rt ${cls}"><span>${label}</span><span class="pl-bad">No collision-free route</span></div>`;
  return `<div class="pl-rt ${cls}"><span>${label}</span><span><b>${f2(r.length_m)} m</b><small>clearance ${r.min_clearance_m} m · A* ${r.compute_ms} ms</small></span></div>`;
}
function resultHTML(ev, z) {
  if (P.routeBusy || !P.after) return `<div class="pl-result wait">${icon("spark")}<span><b>Checking the route…</b></span></div>`;
  if (planGood()) return `<div class="pl-result ok">${icon("check")}<span><b>It fits.</b> No collisions, the ${esc(P.target.asset?.tag)} service zone is clear and the robot can still reach it.</span></div>`;
  if (!movedAny()) return `<div class="pl-result tight">${icon("help")}<span><b>Nothing moved yet.</b> Press “Move it again” and use the arrows.</span></div>`;
  if (ev.status === "bad") return `<div class="pl-result bad">${icon("close")}<span><b>${ev.collision ? "It hits something." : "It is off the scanned floor."}</b> Move it to free, mapped floor.</span></div>`;
  const other = failingMoves();
  if (other.length) return `<div class="pl-result bad">${icon("close")}<span><b>Another moved object fails:</b> ${other.map(whyText).join("; ")}. Select it and move it again.</span></div>`;
  if (!z.clear) return `<div class="pl-result bad">${icon("close")}<span><b>Still in the way.</b> Part of it is inside the ${esc(P.target.asset?.tag)} service zone.</span></div>`;
  return `<div class="pl-result bad">${icon("close")}<span><b>The robot has no route</b> with this layout. Try another spot.</span></div>`;
}
/** How the moved object is drawn: the scan cut-out (with its honesty label) or the box proxy only, and why. */
function cutNoteHTML() {
  if (!P.moves.length) return "";
  if (cutShown()) return `<p class="pl-cut on">${ic("box")}<span><b>${esc(CUT_NOTE)}.</b> The dashed outline marks the original position; the thin box is what collisions are checked against.</span></p>`;
  const why = !P.cutOn ? "Scan cut-out is off: moved equipment is shown as a box proxy." : APP.S?.fac?.splatMode === "points" ? "The scan is shown as a point cloud here, so moved equipment is shown as a box proxy." : P.cut?.sources().length ? "Moved equipment is shown as a box proxy." : "The scan is not loaded, so moved equipment is shown as a box proxy.";
  return `<p class="pl-cut">${ic("box")}<span>${why}</span></p>`;
}
function cardHTML() {
  const t = P.target, a = t.asset;
  const head = `<div class="card-h" style="padding-bottom:0"><span class="eyebrow-row">Maintenance planning<span class="tag">Simulation</span></span><span class="card-tools"><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b"><div class="h1">Make room to service ${esc(a?.tag || t.id)}</div>`;
  const disc = `<p class="pl-disc">${esc(DISCLAIMER)}. Nothing real moves.</p>`;
  if (!P.ready) return `${head}<p class="note">Loading…</p></div>`;
  const z0 = zoneStatus([]);
  if (!P.moves.length) {
    const sug = objOf(SUGGESTED);
    return `${head}${stepperHTML()}
      ${leadHTML()}
      <div class="pl-actions">${sug ? `<button class="btn primary block pl-big" data-pl-pick="${SUGGESTED}">${ic("box")}Pick the pallet truck</button>` : ""}
        <button class="btn block" data-pl="demo">${icon("spark")}Suggest a good spot for me</button>
        ${P.undo.length ? `<button class="btn block" data-pl="undo">${ic("undo")}Undo</button>` : ""}</div>
      ${disc}
      <div class="plain"><b>Why:</b> ${sug ? `the hand pallet truck ${SUGGESTED} is the suggested first move: it is parked ${gap(boxDist(footprint(sug), footprint(t)))} from ${esc(a?.tag)}, inside the space a technician needs to work on it.` : ""} Pick it up (or anything else on the floor) and see at once whether it fits and whether the robot can still get to the pump.</div>
      <div class="section"><div class="label">${esc(a?.tag)} service zone now</div>
        ${kv("Status", z0.clear ? '<span class="pl-ok">Clear</span>' : `<span class="pl-bad">Obstructed by ${esc(z0.obstructions.map((o) => `${o.name} (${o.id})`).join(", "))}</span>`)}
        ${kv("Free floor in zone", `${z0.freePct}%`)}
        <p class="note" style="margin-top:8px">Assumed illustrative clearance requirement: ${ZONE_DEPTH.toFixed(1)} m deep × pump width + ${ZONE_EXTRA.toFixed(1)} m, on the side facing the open floor. The zone counts as clear only when nothing stands inside it. Not a Valmet or OEM figure.</p></div>
      <div class="section pl-phone">${choiceHTML("M")}</div>
      <div class="section"><div class="label">How it works</div>
        <div class="step"><span class="k">1</span><span>Click any floor-standing object in the room. It lifts and becomes a labelled planning proxy; the scan data itself never changes.</span></div>
        <div class="step"><span class="k">2</span><span>Drag it across the floor (or use the arrows and keys). Collisions with known objects and occupied floor are checked live: green fits, amber is tight, red collides. No throwing or physics: it stays exactly where you put it.</span></div>
        <div class="step"><span class="k">3</span><span>Let go: the robot planner re-routes with the new layout, and before and after are both drawn. Undo / Redo any step.</span></div></div></div>`;
  }
  const m = moveOf(P.active) || P.moves[0], o = objOf(m.id), ev = P.active === m.id && P.ev ? P.ev : evaluate(m.id, m), z = P.zoneNow || zoneStatus();
  const disp = Math.hypot(m.x - o.center[0], m.z - o.center[2]), rot = deg(wrap(m.yaw - o.yaw));
  const B = P.before, A = P.after, delta = B?.ok && A?.ok ? A.length_m - B.length_m : null;
  const collisions = ev.hits.length || ev.scanCells
    ? `${ev.hits.map((h) => `<span class="pill red">${esc(h.proxy ? `proxy ${h.id}` : `${h.id} · ${h.label}`)}</span>`).join("")}${ev.scanCells ? `<span class="pill red">${ev.scanCells} occupied scan cells (≈${f2(ev.scanCells * P.grid.res ** 2)} m²)</span>` : ""}`
    : '<span class="pl-ok">None with known obstacles</span>';
  const dl = delta == null ? (P.routeBusy ? "…" : "—") : Math.abs(delta) < 0.05 ? "±0.00 m" : `${delta > 0 ? "+" : "−"}${f2(Math.abs(delta))} m`;
  const tile = (k, v, sub, cls = "") => `<div class="pl-tile ${cls}"><small>${k}</small><b>${v}</b><span>${sub}</span></div>`;
  const top = stage() === "move" && P.active
    ? `<div class="pl-moving-h"><span>Moving: <b>${esc(shortName(o))}</b></span><span class="note">${f2(disp)} m${rot ? ` · ${rot > 0 ? "+" : ""}${rot}°` : ""}</span></div>
      ${movePadHTML()}
      <div class="pl-actions"><button class="btn primary block pl-big" data-pl="done">${icon("check")}Done – check the result</button>
        <button class="btn block" data-pl="suggest">${icon("spark")}Suggest a good spot</button></div>
      ${verdict(ev, z, A)}`
    : `${resultHTML(ev, z)}${ev.status === "bad" ? verdict(ev, z, A) : ""}
      <div class="pl-actions row2"><button class="btn ${planGood() ? "" : "primary"}" data-pl="again">${ic("move")}Move it again</button><button class="btn" data-pl="suggest">${icon("spark")}Suggest a spot</button></div>`;
  return `${head}${stepperHTML()}
    ${top}
    ${disc}
    ${cutNoteHTML()}
    <div class="pl-tiles">
      ${tile("Moved", `${f2(disp)} m`, rot ? `turned ${rot > 0 ? "+" : ""}${rot}°` : "same heading")}
      ${tile("Clearance", ev.collision ? "0 m" : ev.offScan ? "?" : `≈${f2(ev.clearance)} m`, ev.collision ? "collision" : ev.offScan ? "off the scanned floor" : ev.nearest ? `nearest object ${f2(ev.nearest.d)} m` : "to the nearest obstacle", ev.status)}
      ${tile(`${esc(a?.tag)} zone`, z.clear ? "Clear" : "Blocked", z.clear ? `${z.freePct}% free floor (was ${z0.freePct}%)` : `${esc(z.obstructions.map((x) => x.name).join(", "))} still inside`, z.clear ? "ok" : "bad")}
      ${tile("Robot route", A?.ok ? `${f2(A.length_m)} m` : A ? "None" : "…", B?.ok ? `was ${f2(B.length_m)} m · ${dl}` : "", A && !A.ok ? "bad" : "")}
    </div>
    <div class="section pl-phone">${proxiesHTML()}<button class="btn block" data-pl-more>${icon("plus")}Move another object</button></div>
    <div class="section"><div class="label"><span>Robot route to ${esc(a?.tag)}</span><span>${delta == null ? "" : Math.abs(delta) < 0.05 ? "unchanged" : dl}</span></div>
      ${routeRow('<i class="pl-sw before"></i><span>Before<small>scanned layout</small></span>', B)}${routeRow('<i class="pl-sw after"></i><span>After<small>proposed layout</small></span>', A)}
      <p class="note" style="margin-top:6px">Same A* planner as the robot, from its dock: proxy footprint as an obstacle, old footprint as free floor. Explore uses this layout until you reset.</p></div>
    <div class="section"><div class="label"><span>${esc(nameOf(o))}</span><span>${P.moves.length > 1 ? `${P.moves.length} proxies` : ""}</span></div>
      <div class="pl-pos"><div><small>Original · scan</small><b>${f2(o.center[0])}, ${f2(o.center[2])}</b><small>yaw ${deg(o.yaw)}°</small></div><span class="pl-arrow">${icon("chev")}</span>
        <div><small>Proposed · proxy</small><b>${f2(m.x)}, ${f2(m.z)}</b><small>yaw ${deg(m.yaw)}°</small></div></div></div>
    <div class="section"><div class="label">Collisions with known obstacles</div><div class="row">${collisions}</div>
      ${ev.offFloor ? `<p class="note" style="margin-top:6px">${ev.offFloor} footprint cells are outside the scanned floor: the scan cannot confirm that area.</p>` : ""}
      ${kv("Nearest obstacle · 5 cm grid", ev.collision ? '<span class="pl-bad">0 m</span>' : `<span class="pl-${ev.status}">${f2(ev.clearance)} m</span>`)}
      ${ev.nearest ? kv("Nearest known object", `${esc(ev.nearest.o.id)} · ${esc(ev.nearest.o.label)} · ${f2(ev.nearest.d)} m`) : ""}</div>
    <div class="section"><div class="label">${esc(a?.tag)} service zone</div>
      <div class="pl-zone"><span class="${z0.clear ? "pl-ok" : "pl-bad"}">${z0.clear ? "Clear" : `Obstructed by ${esc(z0.obstructions.map((x) => x.name).join(", "))}`}</span>${icon("chev")}<span class="${z.clear ? "pl-ok" : "pl-bad"}">${z.clear ? "Clear" : `Obstructed by ${esc(z.obstructions.map((x) => x.name).join(", "))}`}</span></div>
      <p class="note" style="margin-top:6px">Clear means no object stands inside the zone, however much floor is free. Assumed illustrative requirement: ${ZONE_DEPTH.toFixed(1)} m deep × pump width + ${ZONE_EXTRA.toFixed(1)} m in front of the pump. Not a Valmet or OEM figure.</p></div>
    <div class="section"><div class="label">View</div><div class="row">
      <button class="chip ${P.snap ? "on" : ""}" data-pl="snap" aria-pressed="${P.snap}">Snap to 5 cm</button><button class="chip ${P.compare ? "on" : ""}" data-pl="compare" aria-pressed="${P.compare}">Show routes</button>${P.cut?.sources().length ? `<button class="chip ${P.cutOn ? "on" : ""}" data-pl="cut" aria-pressed="${P.cutOn}" title="Move the scanned object itself (approximate cut-out) or show box proxies only">Move the scan with it</button>` : ""}</div></div>
    <div class="section stack">
      <div class="pl-btns"><button class="btn" data-pl="undo" ${P.undo.length ? "" : "disabled"} title="Undo (Ctrl+Z)">${ic("undo")}Undo</button><button class="btn" data-pl="redo" ${P.redo.length ? "" : "disabled"} title="Redo (Ctrl+Shift+Z)">${ic("redo")}Redo</button><button class="btn" data-pl="reset">${icon("reset")}Reset all</button></div>
      <div class="pl-btns"><button class="btn" data-pl="wo">${icon("doc")}Draft work order</button></div>
      <div class="pl-btns"><button class="btn" data-pl="md">${ic("dl")}Markdown</button><button class="btn" data-pl="json">${ic("dl")}JSON</button><button class="btn" data-pl="copy">${ic("copy")}Copy</button></div></div>
    <p class="note" style="margin-top:12px">The scan is unchanged. Proxies are virtual: nothing has been moved on site.</p></div>`;
}
function renderCard() {
  if (APP.S?.mode !== "plan") return;
  const el = $("#right"), body = el.querySelector(".card-b"), top = P.toTop ? 0 : body?.scrollTop || 0, focus = document.activeElement?.id === "plQM";
  P.toTop = false;
  el.innerHTML = cardHTML();
  const nb = el.querySelector(".card-b"); if (nb) nb.scrollTop = top;
  bindSearch(el);
  if (focus) { const i = $("#plQM"); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }
}
function scheduleCard() {
  if (P.cardTimer) return;
  P.cardTimer = setTimeout(() => { P.cardTimer = 0; renderCard(); renderDock(); if (!P.drag) renderLeft(); }, 90);
}
async function onCardClick(e) {
  if (APP.S?.mode !== "plan") return;
  const mv = e.target.closest("[data-pl-mv]");
  if (mv) { if (e.detail === 0) padStep(mv.dataset.plMv); return; }     // keyboard activation of a move-pad button
  if (onListClick(e)) return;
  const a = e.target.closest("[data-pl]")?.dataset.pl;
  if (a === "reset") reset();
  if (a === "undo") undo();
  if (a === "redo") redo();
  if (a === "cut") { P.cutOn = !P.cutOn; refresh(); renderAll(); }
  if (a === "md" || a === "json" || a === "copy") exportPlan(a);
  if (a === "wo") draftWorkOrder();
  if (a === "demo") demo();
  if (a === "suggest") suggest();
  if (a === "done") done();
  if (a === "again") { P.editing = true; P.toTop = true; if (!P.active) P.active = P.moves[0]?.id || null; P.dirtyField = true; refresh(); renderAll(); }
  if (a === "snap") { P.snap = !P.snap; renderCard(); renderDock(); }
  if (a === "compare") { P.compare = !P.compare; drawRoutes(); renderCard(); renderDock(); }
}

// ------------------------------------------------------------------ UI: dock
function dockHTML() {
  const has = !!P.active, B = P.before, A = P.after;
  const info = !P.moves.length ? `<small>Create a proxy to compare routes</small>` : P.routeBusy ? `<small>Planning the new route…</small>`
    : A?.ok ? `<small>A* ${A.compute_ms} ms · clearance ${A.min_clearance_m} m · ${A.collision_free ? "collision-free" : "check"}</small>` : A ? `<small class="pl-bad">No collision-free route with this layout</small>` : "<small>&nbsp;</small>";
  return `<div class="grp"><button class="tool ${has ? "on" : ""}" data-pd="proxy">${ic("box")}${has ? "Remove proxy" : "Pick truck"}</button></div>
    <div class="grp"><button class="tool" data-pd="l15" ${has ? "" : "disabled"} title="Turn 15° left ( [ )">${ic("rotL")}15°</button><button class="tool" data-pd="r15" ${has ? "" : "disabled"} title="Turn 15° right ( ] )">${ic("rotR")}15°</button><button class="tool" data-pd="r90" ${has ? "" : "disabled"} title="Turn 90° (R)">${ic("turn")}90°</button></div>
    <div class="grp"><div class="seg" role="group" aria-label="View">${[["top", "Top"], ["angled", "Angled"], ["eye", "Eye level"]].map(([k, l]) => `<button data-pd="view:${k}" class="${(P.view || "top") === k ? "on" : ""}" title="${{ top: "Look straight down, like a floor plan (best for moving things)", angled: "Look at the work area from above at an angle", eye: "Stand next to it at eye level" }[k]}">${l}</button>`).join("")}</div></div>
    <div class="grp"><button class="tool ${P.snap ? "on" : ""}" data-pd="snap"><span class="switch"></span>Snap 5 cm</button><button class="tool ${P.compare ? "on" : ""}" data-pd="compare"><span class="switch"></span>Routes</button></div>
    <div class="grp routeinfo"><div class="top"><span>Route to ${esc(P.target?.asset?.tag || "target")}</span><b>${B?.ok ? `${f2(B.length_m)} m` : "…"}${A?.ok ? ` → ${f2(A.length_m)} m` : ""}</b></div>${info}</div>
    <div class="grp"><button class="tool" data-pd="undo" ${P.undo.length ? "" : "disabled"} title="Undo (Ctrl+Z)" aria-label="Undo">${ic("undo")}Undo</button><button class="tool" data-pd="redo" ${P.redo.length ? "" : "disabled"} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${ic("redo")}Redo</button></div>
    <div class="grp"><button class="tool" data-pd="reset" ${P.moves.length ? "" : "disabled"} title="Reset all: back to the scanned layout">${icon("reset")}Reset all</button><button class="tool" data-pd="export" ${P.moves.length ? "" : "disabled"}>${ic("dl")}Export</button></div>`;
}
function renderDock() { if (APP.S?.mode === "plan") $("#dock").innerHTML = dockHTML(); }
function onDock(e) {
  const d = e.target.closest("[data-pd]")?.dataset.pd; if (!d) return;
  if (d.startsWith("view:")) return frameView(0.9, d.slice(5));
  if (d === "proxy") { if (P.active) removeProxy(P.active); else pick(APP.S.selected?.kind === "object" ? APP.S.selected.id : SUGGESTED); }
  if (d === "l15") rotate(-Math.PI / 12);
  if (d === "r15") rotate(Math.PI / 12);
  if (d === "r90") rotate(Math.PI / 2);
  if (d === "snap") { P.snap = !P.snap; renderDock(); }
  if (d === "compare") { P.compare = !P.compare; drawRoutes(); renderDock(); }
  if (d === "reset") reset();
  if (d === "undo") undo();
  if (d === "redo") redo();
  if (d === "export") exportPlan("md");
}
function renderAll() { renderLeft(); renderCard(); renderDock(); }

/** Share of a footprint where the loaded scan has something standing that no object box covers (0 with no splats).
 *  The original spots of moved objects do not count: their splats move with them. */
const SCAN_BUSY = 12, SCAN_BUSY_SHARE = 0.06;
function scanBusy(fp) {
  if (!P.cut?.available) return 0;
  let st; try { st = P.cut.standing(); } catch { return 0; }
  const own = P.moves.map((m) => footprint(objOf(m.id), null, 0.08));
  const cs = Math.cos(fp.yaw), sn = Math.sin(fp.yaw);
  let n = 0, busy = 0;
  for (let lx = -fp.w / 2 + 0.05; lx <= fp.w / 2; lx += 0.1) for (let lz = -fp.d / 2 + 0.05; lz <= fp.d / 2; lz += 0.1) {
    const x = fp.x + lx * cs - lz * sn, z = fp.z + lx * sn + lz * cs;
    n++;
    if (own.some((o) => overlap({ x, z, w: 0.01, d: 0.01, yaw: 0 }, o))) continue;
    if (st.at(x, z) > SCAN_BUSY) busy++;
  }
  return n ? busy / n : 0;
}

// ------------------------------------------------------------------ demo (guided tour, recorded video)
/** Deterministic search for a free, sensible spot outside the service zone that does not block the robot route. */
async function findSpot(id) {
  const o = objOf(id), B = await beforeRoute(), route = B.ok ? B.waypoints.map((p) => [p[0], p[2]]) : null;
  const saved = P.moves.map((m) => ({ ...m })), savedActive = P.active;
  P.moves = [{ id, x: o.center[0], z: o.center[2], yaw: o.yaw }]; P.active = id; P.dirtyField = true;
  let best = null;
  for (const relax of [false, true]) {
    for (const yaw of [o.yaw, wrap(o.yaw + Math.PI / 2)]) for (let dx = -2.5; dx <= 2.5001; dx += 0.1) for (let dz = -2.5; dz <= 2.5001; dz += 0.1) {
      const x = snap(o.center[0] + dx), z = snap(o.center[2] + dz), disp = Math.hypot(x - o.center[0], z - o.center[2]);
      if (disp < 0.5 || (best && disp > best.score)) continue;
      const pose = { x, z, yaw }, fp = footprint(o, pose);
      if (boxDist(fp, P.zone) < 0.15) continue;
      if (!relax && route && polyDist(fp, route) < 0.45) continue;
      const ev = evaluate(id, pose);
      if (ev.status !== "ok") continue;
      if (scanBusy(fp) > SCAN_BUSY_SHARE) continue;   // something unsegmented stands there in the scan
      const score = disp + (yaw === o.yaw ? 0 : 0.15);
      if (!best || score < best.score) best = { score, pose };
    }
    if (best) break;
  }
  P.moves = saved; P.active = savedActive; P.dirtyField = true;
  return best?.pose || null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function demo({ animate = true } = {}) {
  await waitReady();
  if (APP.S.mode !== "plan") APP.setMode("plan");
  record();                                    // the whole example is one undo step
  reset({ quiet: true, rec: false });
  const spot = await findSpot(SUGGESTED);
  createProxy(SUGGESTED, { rec: false });
  await sleep(animate ? 500 : 0);
  if (!spot) { APP.toast("No free spot found for the example plan."); return summary(); }
  const m = moveOf(SUGGESTED), from = { ...m };
  if (animate && !document.hidden) {
    const T = 1400, t0 = performance.now();
    for (;;) {
      const k = Math.min(1, (performance.now() - t0) / T), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      setPose(SUGGESTED, { x: from.x + (spot.x - from.x) * e, z: from.z + (spot.z - from.z) * e, yaw: from.yaw + wrap(spot.yaw - from.yaw) * e }, { route: false });
      if (k >= 1) break;
      await sleep(40);
    }
  }
  setPose(SUGGESTED, spot, { route: false });
  clearTimeout(P.routeTimer);
  P.editing = false;                           // straight to step 3: check the result
  frameView(0.9);
  await computeAfter();
  renderAll();
  return summary();
}
/** For other modules (asset card "Plan access"): enter Plan, make `id` the active movable object, Top view.
 *  The pump being serviced, pipework and wall-mounted parts are not picked up: Plan opens with a short note instead. */
async function pickObject(id) {
  if (APP.S.mode !== "plan") APP.setMode("plan");
  await waitReady();
  const o = objOf(id), mv = movable(o || APP.S.objById?.get(id));
  if (!mv.ok) { if (o) { APP.S.selected = o; highlight(); renderLeft(); } APP.toast(mv.why); frameView(0.9, "top"); return { ok: false, why: mv.why.replace(/<[^>]+>/g, ""), state: getState() }; }
  pick(id);
  return { ok: true, state: getState() };
}
async function waitReady() { for (let i = 0; i < 200 && !P.ready; i++) await sleep(50); }

// ------------------------------------------------------------------ state for shared links (Remote Support)
function getState() {
  return { v: 1, target: P.target?.id, moves: P.moves.map((m) => ({ id: m.id, x: +m.x.toFixed(3), z: +m.z.toFixed(3), yaw: +m.yaw.toFixed(4) })), active: P.active };
}
/** Imported plans (shared links, Remote Support, JSON) are untrusted: unknown or unmovable objects, duplicates,
 *  non-numeric or out-of-room poses are dropped and reported (APP.planning.lastImport), never applied. */
function sanitise(list) {
  const b = APP.S.data.bounds, seen = new Set(), ok = [], rejected = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = m?.id, o = objOf(id), x = +m?.x, z = +m?.z, yaw = +m?.yaw;
    const why = !o ? "unknown object" : seen.has(id) ? "duplicate" : !movable(o).ok ? "cannot be moved in a plan"
      : ![x, z, yaw].every(Number.isFinite) || m.x === null || m.z === null || m.yaw === null ? "invalid pose"
      : x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2] ? "outside the scanned room" : null;
    if (why) { rejected.push({ id: String(id ?? "?").slice(0, 40), why }); continue; }
    seen.add(id); ok.push({ id, x, z, yaw: wrap(yaw) });
  }
  return { ok, rejected };
}
async function setState(state) {
  await waitReady();
  const { ok: moves, rejected } = sanitise(state?.moves);
  P.lastImport = { applied: moves.map((m) => m.id), rejected };
  if (rejected.length) APP.toast(`Plan import: ${rejected.length} move${rejected.length > 1 ? "s" : ""} ignored (${esc(rejected.map((r) => `${r.id}: ${r.why}`).join("; "))}).`, 5200);
  if (P.drag) endDrag({ silent: true });
  record();
  P.moves = moves;
  P.active = moves.some((m) => m.id === state?.active) ? state.active : P.moves.at(-1)?.id || null;
  P.dirtyField = true; P.after = null; P.editing = false;
  refresh(); renderAll();
  if (P.moves.length) await computeAfter(); else { drawRoutes(); if (APP.S.curve && !APP.S.robot.done) APP.replan({ quiet: true }); }
  return getState();
}

// ------------------------------------------------------------------ mini-map
function drawMinimap(ctx, X, Z, k) {
  if (!P.ready || (APP.S.mode !== "plan" && !P.moves.length)) return;
  const poly = (b) => { const c = corners(b); ctx.beginPath(); c.forEach(([x, z], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(x), Z(z))); ctx.closePath(); };
  const zs = P.zoneNow || zoneStatus();
  if (APP.S.mode === "plan") {
    poly(P.zone); ctx.fillStyle = zs.clear ? "rgba(48,209,88,.16)" : "rgba(255,69,58,.18)"; ctx.fill();
    ctx.setLineDash([3, 3]); ctx.strokeStyle = zs.clear ? CSS.ok : CSS.bad; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    const line = (wp, col, dash, w) => { ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); wp.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Z(p[2]))); ctx.stroke(); ctx.setLineDash([]); };
    if (P.compare && P.before?.ok) line(P.before.waypoints, "rgba(199,204,211,.85)", [4, 3], 1.5);
    if (P.compare && P.after?.ok) line(P.after.waypoints, "#0a84ff", [], 2);
  }
  for (const m of P.moves) {
    const o = objOf(m.id), ev = m.id === P.active && P.ev ? P.ev : null;
    poly(footprint(o)); ctx.setLineDash([2, 2]); ctx.strokeStyle = "rgba(199,204,211,.95)"; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(X(o.center[0]), Z(o.center[2])); ctx.lineTo(X(m.x), Z(m.z)); ctx.strokeStyle = "rgba(242,243,245,.6)"; ctx.stroke();
    poly(footprint(o, m)); ctx.fillStyle = CSS[ev?.status || "ok"]; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ mode
function enter() {
  const S = APP.S;
  ensureThree();
  P.three.root.visible = true;
  // show where the floor is free (blue = drivable) while planning; restored on exit
  P.twinBefore = !!S.fac.twinOn;
  if (!S.fac.twinOn) Promise.resolve(S.fac.walkGrid || APP.api.grid()).then((g) => { if (APP.S.mode === "plan") { S.fac.setTwin(true, g); APP.renderRail?.(); } }).catch(() => {});
  S.cardLock = false;                          // the right card belongs to Plan now
  P.toTop = true;
  S.fac.routeGroup.visible = false;   // the comparison replaces the Explore route here
  refresh(); drawRoutes(); renderAll();
  beforeRoute().then(() => { drawRoutes(); renderCard(); renderDock(); });
  frameView();
}
/** Fly the camera so the target, its service zone, the originals and the proxies are all in view.
 *  kind: "top" (straight down, like a floor plan — easiest for moving things), "angled", or "eye" (eye level). */
function frameView(dur = 1.1, kind = P.view || "top") {
  P.view = kind;
  const pts = [[P.target.center[0], P.target.center[2]], ...corners(P.zone)];
  const ids = P.moves.length ? P.moves.map((m) => m.id) : objOf(SUGGESTED) ? [SUGGESTED] : [];
  for (const id of ids) { const o = objOf(id), m = moveOf(id); pts.push([o.center[0], o.center[2]]); if (m) pts.push([m.x, m.z]); }
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const r = Math.max(1.2, ...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cz)));
  const focus = new THREE.Vector3(cx, 0, cz), off = APP.viewOffset(focus).setY(0).normalize();
  const dist = r * 2.1 + 1.2;
  APP.S.cam = "free";                                   // no robot camera fighting the plan view
  APP.S.fac.setCutaway(kind !== "eye");                 // hide the ceiling and outside haze when looking down
  if (kind === "top") APP.flyTo(new THREE.Vector3(cx, Math.max(4.4, r * 2.4 + 2.4), cz + 0.02), focus, dur);
  else if (kind === "eye") APP.flyTo(new THREE.Vector3(cx + off.x * (r + 1.6), 1.55, cz + off.z * (r + 1.6)), new THREE.Vector3(cx, 0.5, cz), dur);
  else APP.flyTo(new THREE.Vector3(cx + off.x * dist * 0.62, dist * 0.85, cz + off.z * dist * 0.62), focus, dur);
  renderDock();
}
function exit() {
  const S = APP.S;
  S.fac.setCutaway(S.cam === "broadcast" || S.cam === "top");
  if (!P.twinBefore && S.fac.twinOn) { S.fac.setTwin(false); APP.renderRail?.(); }
  stopHold();
  if (P.drag) endDrag();
  setHover(null);
  APP.canvas.style.cursor = "";
  S.fac.routeGroup.visible = true;
  P.three?.routes.clear(); P.three?.gauge.clear();
  if (P.three) P.three.zone.visible = false;
  if (P.moves.length) APP.toast(`The proposed layout stays active: robot routes avoid the ${P.moves.length > 1 ? "proxies" : "proxy"}. Reset it in Plan.`, 5200);
}

registerMode({
  id: "plan", label: "Plan", after: "xray", scene: "facility", minimap: true, ownsCard: true,
  enter() { if (P.three) P.three.zone.visible = true; enter(); },
  exit,
  left: () => leftHTML(),
  dock: () => dockHTML(),
  onDock,
  onPick(ray) {
    if (P.justDragged || P.drag) return true;
    const hit = pickProxy(ray);
    if (hit) { if (P.active !== hit.m.id || !P.editing) { P.active = hit.m.id; P.dirtyField = true; P.editing = true; refresh(); renderAll(); } return true; }
    if (!P.ready) return true;
    const id = pickUnder(ray);
    if (id) {
      const o = APP.S.data.objects.find((x) => x.id === id), mv = movable(o);
      APP.S.selected = o;
      if (mv.ok) createProxy(o.id);
      else { highlight(); renderLeft(); APP.toast(mv.why); }
    }
    return true;
  },
});

on("boot", () => {
  init().then(() => { if (APP.S.mode === "plan") { refresh(); renderAll(); } }).catch((e) => console.warn("planning init", e));
  $("#right").addEventListener("click", onCardClick);
  APP.canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
  APP.canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });
  APP.canvas.addEventListener("pointerleave", () => { if (P.hover) setHover(null); });
  addEventListener("pointermove", onPointerMove);
  addEventListener("pointerup", onPointerUp);
  addEventListener("pointercancel", onPointerUp);
  addEventListener("keydown", onKey);
  $("#right").addEventListener("pointerdown", onPadDown);
  addEventListener("pointerup", onPadUp); addEventListener("pointercancel", onPadUp); addEventListener("blur", onPadUp);
  // main.js refreshes the default cards from the robot loop (transit card, arrival) without a mode check:
  // in Plan mode put the planning cards back, unless the user asked for another card (S.cardLock).
  const guard = (sel, mine, render) => new MutationObserver(() => {
    if (!P.ready || APP.S?.mode !== "plan" || APP.S.cardLock || $(sel).querySelector(mine)) return;
    queueMicrotask(() => { if (APP.S.mode === "plan" && !$(sel).querySelector(mine)) render(); });
  }).observe($(sel), { childList: true });
  guard("#right", ".pl-disc", renderCard);
  guard("#left", ".pl-steps", renderLeft);
  APP.planning = { view: (k) => frameView(0.9, k), getState, setState, reset: () => reset({ quiet: true }), demo, summary, keysOwned, done, suggest, stage, exportMarkdown: () => markdown(summary()), _findSpot: findSpot, _scanBusy: (id, pose) => scanBusy(footprint(objOf(id), pose)), _standing: (opt) => (P.cut?.available ? P.cut.standing(opt) : null), _evaluate: (id, pose) => evaluate(id, pose),
    lastImport: () => P.lastImport || null, undo, redo, history: () => ({ undo: P.undo.length, redo: P.redo.length }), pick: (id) => pick(id), pickObject, movable: (id) => movable(objOf(id) || APP.S.objById?.get(id)),
    cutStats: () => ({ available: !!P.cut?.available, enabled: P.cutOn, shown: P.moves.filter((m) => P.cut?.isCut(m.id)).map((m) => m.id), objects: P.moves.map((m) => ({ id: m.id, ...(P.cut?.stats(m.id) || {}) })), log: P.cut?.log || [] }),
    setCutout: (on) => { P.cutOn = !!on; P.dirtyField = true; refresh(); renderAll(); return P.cutOn; } };
});
let _cutKey = "", _cutT = 0;
on("frame", (dt) => {
  animate(dt);
  // the scan streams in after boot: once more splats are up, refresh the cut-outs of objects already moved
  if (P.moves.length && P.cut && (_cutT += dt) > 1) { _cutT = 0; const k = P.cut.srcKey(); if (k !== _cutKey) { _cutKey = k; refresh(); renderCard(); } }
});
on("planExtras", planExtras);
on("minimap", drawMinimap);
// selectObject() re-renders the default asset list after the hook: put the planning card back
on("select", () => { if (APP.S?.mode === "plan") queueMicrotask(() => { renderLeft(); highlight(); }); });
