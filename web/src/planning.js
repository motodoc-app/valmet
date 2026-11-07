// Maintenance Planning mode: move equipment as virtual proxies, check collisions, clearance and service access,
// and see how the robot route changes. The scan is never modified: proxies are drawn on top of it, and the
// planner receives them as `blocks` (new footprints) and `clears` (old footprints become free floor).
//
// Public API (APP.planning): getState(), setState(state), reset(), demo(), summary()
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { APP, registerMode, on, withExtras } from "./ext.js";
import { edt } from "./static-api.js";
import { icon } from "./icons.js";
import "./planning.css";

// ------------------------------------------------------------------ constants
const DISCLAIMER = "Planning simulation · approximate geometry (oriented boxes + occupancy grid) · not an engineering clearance check";
const SUGGESTED = "OBJ-028";            // hand pallet truck parked in front of P-005 (review-corrected label)
const SNAP = 0.05;                      // metres
const CLEAR_PAD = 0.08;                 // old footprint padding: the scan points of the moved object itself
const TIGHT = 0.3;                      // below this clearance (m) the proxy is shown amber
const OBST_MIN = 0.12, OBST_MAX = 1.25; // same height band the navigation grid uses (config.py)
const ZONE_DEPTH = 1.0, ZONE_EXTRA = 0.4;  // assumed illustrative service zone: 1.0 m deep × pump width + 0.4 m
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
};

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
/** Grid cells whose centre lies inside the footprint (same rule as the planners' rasterise). */
function cellsOf(b) {
  const g = P.grid, out = [], cs = Math.cos(b.yaw), sn = Math.sin(b.yaw), hx = b.w / 2, hz = b.d / 2, rad = Math.hypot(hx, hz);
  const r0 = Math.max(0, Math.floor((b.z - rad - g.z0) / g.res)), r1 = Math.min(g.H - 1, Math.floor((b.z + rad - g.z0) / g.res));
  const c0 = Math.max(0, Math.floor((b.x - rad - g.x0) / g.res)), c1 = Math.min(g.W - 1, Math.floor((b.x + rad - g.x0) / g.res));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const dx = g.x0 + (c + 0.5) * g.res - b.x, dz = g.z0 + (r + 0.5) * g.res - b.z;
    if (Math.abs(dx * cs + dz * sn) <= hx && Math.abs(-dx * sn + dz * cs) <= hz) out.push(r * g.W + c);
  }
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
  const cells = cellsOf(fp);
  let scanCells = 0, offFloor = 0, clearance = Infinity, minCell = -1;
  for (const i of cells) {
    if (g.occ[i] && !P.clearMask[i]) scanCells++;
    if (!g.floor[i]) offFloor++;
    if (P.clearMap[i] < clearance) { clearance = P.clearMap[i]; minCell = i; }
  }
  const moved = new Set(P.moves.map((m) => m.id)); moved.add(id);
  const hits = [], near = [];
  for (const e of P.objs) {
    if (moved.has(e.o.id)) continue;
    if (!(e.bottom < top - 0.02 && e.top > Math.max(bottom, OBST_MIN) && e.bottom < OBST_MAX)) continue;
    if (Math.hypot(e.fp.x - fp.x, e.fp.z - fp.z) > 4) continue;
    const d = boxDist(fp, e.fp);
    if (d === 0) hits.push(e.o); else near.push([d, e.o]);
  }
  for (const m of P.moves) if (m.id !== id && overlap(fp, footprint(objOf(m.id), m))) hits.push({ ...objOf(m.id), proxy: true });
  near.sort((a, b) => a[0] - b[0]);
  if (!cells.length) clearance = 0;
  const collision = hits.length > 0 || scanCells > 0;
  const status = collision ? "bad" : clearance < TIGHT || offFloor > 0 ? "tight" : "ok";
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
  return { fp, cells: cells.length, scanCells, offFloor, hits, collision, status,
    clearance: isFinite(clearance) ? clearance : null, nearest: near[0] ? { o: near[0][1], d: near[0][0] } : null, gauge };
}

/** Service zone of the target: which footprints (proxies or unmoved objects) overlap it, and how much free floor is left. */
function zoneStatus(moves = P.moves) {
  const z = P.zone, g = P.grid, moved = new Set(moves.map((m) => m.id)), tfp = footprint(P.target);
  const obstructions = [];
  for (const e of P.objs) {
    if (e.o.id === P.target.id || moved.has(e.o.id)) continue;
    if (overlap(tfp, e.fp)) continue;         // frames touching the pump's own frame are parts of it (motor, fittings)
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
  lab.position.set(z.x, 0.05, z.z);
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
  const edgeMat = new THREE.LineBasicMaterial({ color: COL.ok });
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
  ptag.position.set(0, bottom + h + 0.1, 0);
  proxy.add(ptag);
  // displacement arrow on the floor (dashed)
  const arrow = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]),
    new THREE.LineDashedMaterial({ color: 0xf2f3f5, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.8, depthTest: false }));
  arrow.renderOrder = 6;
  const atag = tag("", "dist");
  T.proxies.add(ghost, gf, ghostTag, proxy, arrow, atag);
  it = { id, ghost, gf, ghostTag, proxy, box, edges, fl, ring, tick, ptag, arrow, atag, fillMat, edgeMat, floorMat, ringMat, h, bottom, w, d };
  T.items.set(id, it);
  return it;
}
function removeItem(id) {
  const T = P.three, it = T?.items.get(id); if (!it) return;
  for (const k of ["ghost", "gf", "ghostTag", "proxy", "arrow", "atag"]) { T.proxies.remove(it[k]); it[k].element?.remove(); }
  it.ptag.element.remove();
  T.items.delete(id);
}
function poseItem(m, ev) {
  const it = proxyItem(m.id), o = objOf(m.id);
  it.proxy.position.set(m.x, 0, m.z); it.proxy.rotation.y = -m.yaw;
  const c = COL[ev?.status || "ok"];
  for (const mat of [it.edgeMat, it.fillMat, it.floorMat, it.ringMat]) mat.color.setHex(c);
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
  let act = null;
  // the active proxy last, so the obstacle field stays built for it while dragging
  for (const m of [...P.moves].sort((a, b) => (a.id === P.active) - (b.id === P.active))) { const ev = evaluate(m.id, m); poseItem(m, ev); if (m.id === P.active) act = ev; }
  P.ev = act;
  P.zoneNow = zoneStatus();
  paintZone(P.zoneNow);
  drawGauge(act);
  highlight();
}
function highlight() {
  const S = APP.S;
  if (S.mode !== "plan" || !S.fac) return;
  S.fac.setHighlighted(P.moves.map((m) => m.id).filter((id) => id !== P.active), { selected: P.active || (S.selected?.kind === "object" ? S.selected.id : objOf(SUGGESTED) ? SUGGESTED : null), target: S.target.id });
}

// ------------------------------------------------------------------ editing
function createProxy(id) {
  const o = objOf(id);
  if (!o) return APP.toast(`${esc(id)} cannot be moved in a plan.`);
  if (!moveOf(id)) P.moves.push({ id, x: snap(o.center[0]), z: snap(o.center[2]), yaw: o.yaw });
  P.active = id; P.dirtyField = true;
  refresh(); renderAll();
  scheduleRoute(0);
}
function removeProxy(id) {
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
function rotate(dr) { const m = moveOf(P.active); if (m) setPose(m.id, { ...m, yaw: m.yaw + dr }, { routeDelay: 300 }); }
function nudge(dx, dz) { const m = moveOf(P.active); if (m) setPose(m.id, { ...m, x: m.x + dx, z: m.z + dz }, { routeDelay: 350 }); }
function reset({ quiet = false } = {}) {
  P.moves = []; P.active = null; P.after = null; P.dirtyField = true;
  clearTimeout(P.routeTimer); P.afterSeq++;
  if (P.ready) { refresh(); drawRoutes(); }
  renderAll();
  if (APP.S?.curve && !APP.S.robot.done) APP.replan({ quiet: true });
  if (!quiet) APP.toast("Original layout restored. The plan is cleared and robot routes use the scanned layout again.");
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
  const cs = Math.cos(m.yaw), sn = Math.sin(m.yaw), cy = it.bottom + it.h / 2;
  const ox = ray.origin.x - m.x, oy = ray.origin.y - cy, oz = ray.origin.z - m.z;
  const lo = [ox * cs + oz * sn, oy, -ox * sn + oz * cs], ld = [ray.direction.x * cs + ray.direction.z * sn, ray.direction.y, -ray.direction.x * sn + ray.direction.z * cs];
  const h = [it.w / 2 + 0.06, it.h / 2 + 0.04, it.d / 2 + 0.06];
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-9) { if (Math.abs(lo[i]) > h[i]) return null; continue; }
    let a = (-h[i] - lo[i]) / ld[i], b = (h[i] - lo[i]) / ld[i]; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 <= t1 && t1 > 0) { const t = Math.max(t0, 0); return Math.max(0, Math.min(it.bottom + it.h, ray.origin.y + ray.direction.y * t)); }
  return null;
}
function pickProxy(ray) {
  const order = [...P.moves].sort((a, b) => (b.id === P.active) - (a.id === P.active));
  for (const m of order) { const y = hitProxy(ray, m); if (y != null) return { m, y }; }
  return null;
}
function onPointerDown(e) {
  if (APP.S?.mode !== "plan" || e.button !== 0 || !P.moves.length) return;
  const hit = pickProxy(rayFrom(e));
  if (!hit) return;
  _plane.constant = -hit.y;
  if (!_ray.ray.intersectPlane(_plane, _hit)) return;
  if (P.active !== hit.m.id) { P.active = hit.m.id; P.dirtyField = true; refresh(); renderAll(); }
  P.drag = { id: hit.m.id, pid: e.pointerId, y: hit.y, off: [hit.m.x - _hit.x, hit.m.z - _hit.z], moved: false, x0: e.clientX, y0: e.clientY };
  APP.controls.enabled = false;               // OrbitControls ignores this pointer
  try { APP.canvas.setPointerCapture(e.pointerId); } catch {}
  APP.canvas.style.cursor = "grabbing";
  e.preventDefault();
}
function onPointerMove(e) {
  if (APP.S?.mode !== "plan") return;
  if (!P.drag) {                               // hover affordance
    if (e.target === APP.canvas && P.moves.length && !e.buttons) APP.canvas.style.cursor = pickProxy(rayFrom(e)) ? "grab" : "";
    return;
  }
  if (e.pointerId !== P.drag.pid) return;
  _plane.constant = -P.drag.y;
  if (!rayFrom(e).intersectPlane(_plane, _hit)) return;
  let x = _hit.x + P.drag.off[0], z = _hit.z + P.drag.off[1];
  if (P.snap) { x = snap(x); z = snap(z); }
  const b = APP.S.data.bounds;
  x = Math.min(b.max[0], Math.max(b.min[0], x)); z = Math.min(b.max[2], Math.max(b.min[2], z));
  if (Math.hypot(e.clientX - P.drag.x0, e.clientY - P.drag.y0) > 3) P.drag.moved = true;
  const m = moveOf(P.drag.id);
  if (m && (m.x !== x || m.z !== z)) setPose(m.id, { ...m, x, z }, { route: false });   // live checks; route on drop
}
function onPointerUp(e) {
  if (!P.drag || e.pointerId !== P.drag.pid) return;
  const moved = P.drag.moved;
  P.drag = null; P.justDragged = true; setTimeout(() => (P.justDragged = false), 0);
  APP.controls.enabled = true;
  APP.canvas.style.cursor = "grab";
  try { APP.canvas.releasePointerCapture(e.pointerId); } catch {}
  renderAll();
  if (moved) scheduleRoute(0);
}
function onKey(e) {
  if (APP.S?.mode !== "plan" || !P.active || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const step = e.shiftKey ? 0.25 : SNAP;
  // arrows move in screen-aligned directions (the camera's forward/right on the floor)
  const fwd = new THREE.Vector3(); APP.camera.getWorldDirection(fwd); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const ax = Math.abs(fwd.x) > Math.abs(fwd.z) ? [Math.sign(fwd.x), 0] : [0, Math.sign(fwd.z)];   // snap to world axes
  const rx = Math.abs(right.x) > Math.abs(right.z) ? [Math.sign(right.x), 0] : [0, Math.sign(right.z)];
  const k = { ArrowUp: [ax[0], ax[1]], ArrowDown: [-ax[0], -ax[1]], ArrowRight: [rx[0], rx[1]], ArrowLeft: [-rx[0], -rx[1]] }[e.key];
  if (k) { e.preventDefault(); return nudge(k[0] * step, k[1] * step); }
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
      status: { ok: "clear", tight: "tight", bad: "collision" }[ev.status] };
  });
  const r = (x) => (x ? (x.ok ? { ok: true, length_m: x.length_m, min_clearance_m: x.min_clearance_m, collision_free: x.collision_free, compute_ms: x.compute_ms } : { ok: false, reason: x.reason }) : null);
  const before = r(P.before), after = r(P.after) || before;
  return {
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
  const L = [`# Maintenance plan · ${s.title}`, "", `> ${s.disclaimer}.`, "> The scan data is unchanged; moved equipment is shown as virtual planning proxies. Verify on site before moving anything.", "",
    `Created ${s.created}`, "", "## Proposed moves"];
  if (!s.moves.length) L.push("", "No equipment moved (original layout).");
  for (const m of s.moves) {
    L.push("", `### ${m.name}`, `- Label: ${m.label} (${m.label_source})`,
      `- Original: x ${m.original.x}, z ${m.original.z}, yaw ${m.original.yaw_deg}°`,
      `- Proposed: x ${m.proposed.x}, z ${m.proposed.z}, yaw ${m.proposed.yaw_deg}°`,
      `- Displacement: ${m.displacement_m} m, rotation ${m.rotation_deg > 0 ? "+" : ""}${m.rotation_deg}°`,
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
  const moves = s.moves.map((m) => `<div class="step"><span class="k">${icon("check")}</span><span>Move ${esc(m.name)} ${m.displacement_m} m to x ${m.proposed.x}, z ${m.proposed.z}${m.rotation_deg ? `, turned ${m.rotation_deg}°` : ""}. ${m.status === "clear" ? "No collision with known obstacles" : m.status === "tight" ? "Tight clearance" : "Collision: re-plan"}, ≈${m.clearance_m ?? "?"} m clearance.</span></div>`).join("");
  body.insertAdjacentHTML("beforeend", `<div class="section"><div class="label">Access preparation <span class="pill amber">Planning simulation</span></div>
    ${moves || '<p class="note">No layout change planned.</p>'}
    ${kv("Service zone", s.service_zone.after.clear ? '<span class="pl-ok">Clear (assumed 1.0 m zone)</span>' : `<span class="pl-bad">Obstructed by ${esc(s.service_zone.after.obstructed_by.join(", "))}</span>`)}
    ${kv("Robot route", s.route.after?.ok ? `${s.route.after.length_m} m · clearance ${s.route.after.min_clearance_m} m` : "No route")}
    <p class="note" style="margin-top:8px">${esc(DISCLAIMER)}. Confirm the new position on site.</p></div>`);
}

// ------------------------------------------------------------------ UI: left card (steps + object choice)
function step(n, label, state) { return `<div class="pl-step ${state}"><span class="k">${state === "done" ? icon("check") : n}</span><span>${label}</span></div>`; }
function leftHTML() {
  if (!P.ready) return `<div class="card-h"><span class="t">Maintenance planning</span></div><div class="card-b"><span class="note">Loading the floor map…</span></div>`;
  const has = P.moves.length > 0, moved = P.moves.some((m) => { const o = objOf(m.id); return Math.hypot(m.x - o.center[0], m.z - o.center[2]) > 0.04 || Math.abs(wrap(m.yaw - o.yaw)) > 0.01; });
  const routed = !!P.after;
  const st = (i) => { const done = [has, has, moved, moved && routed]; return done[i] ? "done" : done.findIndex((d) => !d) === i ? "cur" : ""; };
  const act = P.active && objOf(P.active);
  let body;
  if (act) {
    body = `<div class="section"><div class="label"><span>Moving</span><span class="pl-pill ${P.ev?.status || "ok"}">${{ ok: "Clear", tight: "Tight", bad: "Collision" }[P.ev?.status || "ok"]}</span></div>
      <div class="pl-moving"><b>${esc(nameOf(act))}</b><small>${esc(act.label)} · ${act.label_source === "review-corrected" ? "review-corrected label" : Math.round(act.confidence * 100) + "% label confidence"}</small></div>
      <div class="pl-keys"><span>${ic("move")}Drag the proxy on the floor</span><span><span class="kbd">←↑↓→</span> nudge 5 cm · <span class="kbd">Shift</span> 25 cm</span><span><span class="kbd">R</span> turn 90° · <span class="kbd">[</span> <span class="kbd">]</span> 15°</span></div></div>
      ${P.moves.length > 1 ? `<div class="section"><div class="label">Proxies in this plan</div>${P.moves.map((m) => `<button class="list-row ${m.id === P.active ? "on" : ""}" data-pl-act="${m.id}"><span class="n">${ic("box")}</span><span class="nm"><b>${esc(shortName(objOf(m.id)))}</b><small>${m.id}</small></span><span class="link" data-pl-del="${m.id}" title="Remove proxy">${icon("close")}</span></button>`).join("")}</div>` : ""}
      <div class="section"><button class="link" data-pl-more>${icon("plus")}Move another object</button></div>`;
  } else body = choiceHTML();
  return `<div class="card-h"><span class="t">Maintenance planning</span><span class="card-tools"><span class="pill amber">Simulation</span><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b">
      <div class="pl-steps">${step(1, "Choose equipment", st(0))}${step(2, "Create a planning proxy", st(1))}${step(3, "Move it to the new spot", st(2))}${step(4, "Review route and export", st(3))}</div>
      ${body}
    </div>`;
}
function choiceHTML() {
  const S = APP.S, sug = objOf(SUGGESTED), d = sug ? boxDist(footprint(sug), footprint(P.target)) : 0;
  const sel = S.selected && S.selected.kind === "object" && S.selected.id !== SUGGESTED ? S.selected : null;
  return `${sug ? `<div class="section"><div class="label">Suggested for ${esc(P.target.asset?.tag || "the target")} service</div>
      <button class="pl-sugg" data-pl-pick="${SUGGESTED}"><span class="pl-sugg-i">${ic("box")}</span><span class="nm"><b>Hand pallet truck</b><small>${SUGGESTED} · ${gap(d)} from ${esc(P.target.asset?.tag)} · in its service zone</small></span>${icon("chev")}</button></div>` : ""}
    ${sel ? `<div class="section"><button class="btn block" data-pl-pick="${sel.id}">${icon("target")}Use current selection · ${esc(shortName(sel))}</button></div>` : ""}
    <div class="section"><div class="label">Or find any object</div>
      <input class="search" id="plQ" placeholder="Search label or ID, e.g. cart, valve, OBJ-068" value="${esc(P.query)}" autocomplete="off"/>
      <div id="plRes" class="pl-res">${resultsHTML()}</div>
      <p class="note" style="margin-top:6px">You can also click an object in the 3D view.</p></div>`;
}
function resultsHTML() {
  const q = P.query.trim().toLowerCase();
  if (!q) return "";
  const res = P.objs.map((e) => e.o).filter((o) => `${o.id} ${o.label} ${o.category || ""} ${o.asset?.tag || ""}`.toLowerCase().includes(q))
    .sort((a, b) => (b.label_source === "review-corrected") - (a.label_source === "review-corrected") || b.confidence - a.confidence).slice(0, 8);
  return res.map((o) => `<button class="list-row" data-pl-pick="${o.id}"><span class="n">${ic("box")}</span><span class="nm"><b>${esc(shortName(o))}</b><small>${o.id} · ${o.size.map((v) => v.toFixed(2)).join(" × ")} m</small></span>${icon("chev")}</button>`).join("")
    || '<p class="note" style="padding:6px 0">No matching object.</p>';
}
function renderLeft() {
  if (APP.S?.mode !== "plan") return;
  const el = $("#left"), q = document.activeElement?.id === "plQ";
  el.classList.remove("tall");
  el.innerHTML = leftHTML();
  el.onclick = onLeftClick;
  const inp = $("#plQ");
  if (inp) { inp.oninput = (e) => { P.query = e.target.value; $("#plRes").innerHTML = resultsHTML(); }; if (q) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
}
function onLeftClick(e) {
  if (e.target.closest("[data-min-card]")) return;
  const del = e.target.closest("[data-pl-del]"); if (del) { e.stopPropagation(); return removeProxy(del.dataset.plDel); }
  const a = e.target.closest("[data-pl-act]"); if (a) { P.active = a.dataset.plAct; P.dirtyField = true; refresh(); return renderAll(); }
  if (e.target.closest("[data-pl-more]")) { P.active = null; refresh(); return renderAll(); }
  const p = e.target.closest("[data-pl-pick]"); if (p) return pick(p.dataset.plPick);
}
function pick(id) {
  const o = objOf(id); if (!o) return;
  APP.S.selected = o;
  createProxy(id);
}

// ------------------------------------------------------------------ UI: right card (plan summary)
const verdict = (ev, z, after) => {
  if (!ev) return "";
  if (ev.status === "bad") return `<div class="pl-verdict bad">${icon("close")}<span><b>Collision</b> with ${ev.hits.length ? esc(ev.hits.slice(0, 2).map((h) => h.proxy ? `proxy ${h.id}` : `${h.id} (${h.label})`).join(", ")) : "scanned geometry"}${ev.hits.length > 2 ? ` +${ev.hits.length - 2}` : ""}. Move it to free floor.</span></div>`;
  const zt = z.clear ? `${esc(P.target.asset?.tag)} service zone clear` : `Service zone still obstructed by ${esc(z.obstructions.map((o) => o.name).join(", "))}`;
  const rt = after && !after.ok ? " · <b>no robot route</b>" : "";
  return `<div class="pl-verdict ${ev.status === "tight" || !z.clear || rt ? "tight" : "ok"}">${icon(ev.status === "ok" && z.clear && !rt ? "check" : "help")}<span><b>${ev.status === "tight" ? "Fits, tight clearance" : "Fits"}</b> · no collisions · ${zt}${rt}</span></div>`;
};
function routeRow(label, r, cls = "") {
  if (!r) return `<div class="pl-rt ${cls}"><span>${label}</span><span class="note">${P.routeBusy ? "planning…" : "—"}</span></div>`;
  if (!r.ok) return `<div class="pl-rt ${cls}"><span>${label}</span><span class="pl-bad">No collision-free route</span></div>`;
  return `<div class="pl-rt ${cls}"><span>${label}</span><span><b>${f2(r.length_m)} m</b><small>clearance ${r.min_clearance_m} m · A* ${r.compute_ms} ms</small></span></div>`;
}
function cardHTML() {
  const S = APP.S, t = P.target, a = t.asset;
  const head = `<div class="card-h" style="padding-bottom:0"><span class="eyebrow-row">Maintenance planning<span class="tag">Simulation</span></span><span class="card-tools"><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b"><div class="h1">Service access for ${esc(a?.tag || t.id)}</div><p class="pl-disc">${esc(DISCLAIMER)}</p>`;
  if (!P.ready) return `${head}<p class="note">Loading…</p></div>`;
  const z0 = zoneStatus([]);
  if (!P.moves.length) {
    const sug = objOf(SUGGESTED);
    return `${head}
      <div class="plain"><b>Scenario:</b> a technician is preparing to service ${esc(a?.tag)}. ${sug ? `The hand pallet truck ${SUGGESTED} is parked ${gap(boxDist(footprint(sug), footprint(t)))} from the pump frame, inside its service zone.` : ""} Move it as a virtual proxy and check collisions, clearance, service access and the robot route before anyone touches it.</div>
      <div class="section"><div class="label">${esc(a?.tag)} service zone now</div>
        ${kv("Status", z0.clear ? '<span class="pl-ok">Clear</span>' : `<span class="pl-bad">Obstructed by ${esc(z0.obstructions.map((o) => `${o.name} (${o.id})`).join(", "))}</span>`)}
        ${kv("Free floor in zone", `${z0.freePct}%`)}
        <p class="note" style="margin-top:8px">Assumed illustrative clearance requirement: ${ZONE_DEPTH.toFixed(1)} m deep × pump width + ${ZONE_EXTRA.toFixed(1)} m, on the side facing the open floor. Not a Valmet or OEM figure.</p></div>
      <div class="section stack">${sug ? `<button class="btn primary block" data-pl-pick="${SUGGESTED}">${ic("box")}Plan: move the pallet truck</button>` : ""}
        <button class="btn block" data-pl="demo">${icon("play")}Run the example plan</button></div>
      <div class="section"><div class="label">How it works</div>
        <div class="step"><span class="k">1</span><span>Pick equipment. A labelled planning proxy appears; the scan itself never changes.</span></div>
        <div class="step"><span class="k">2</span><span>Drag the proxy. Collisions with known objects and occupied floor cells are checked live.</span></div>
        <div class="step"><span class="k">3</span><span>On release, the robot planner re-routes with the new layout: before and after are both drawn.</span></div></div></div>`;
  }
  const m = moveOf(P.active) || P.moves[0], o = objOf(m.id), ev = P.active === m.id && P.ev ? P.ev : evaluate(m.id, m), z = P.zoneNow || zoneStatus();
  const disp = Math.hypot(m.x - o.center[0], m.z - o.center[2]), rot = deg(wrap(m.yaw - o.yaw));
  const B = P.before, A = P.after, delta = B?.ok && A?.ok ? A.length_m - B.length_m : null;
  const collisions = ev.hits.length || ev.scanCells
    ? `${ev.hits.map((h) => `<span class="pill red">${esc(h.proxy ? `proxy ${h.id}` : `${h.id} · ${h.label}`)}</span>`).join("")}${ev.scanCells ? `<span class="pill red">${ev.scanCells} occupied scan cells (≈${f2(ev.scanCells * P.grid.res ** 2)} m²)</span>` : ""}`
    : '<span class="pl-ok">None with known obstacles</span>';
  const dl = delta == null ? (P.routeBusy ? "…" : "—") : Math.abs(delta) < 0.05 ? "±0.00 m" : `${delta > 0 ? "+" : "−"}${f2(Math.abs(delta))} m`;
  const tile = (k, v, sub, cls = "") => `<div class="pl-tile ${cls}"><small>${k}</small><b>${v}</b><span>${sub}</span></div>`;
  return `${head}
    ${verdict(ev, z, A)}
    <div class="pl-tiles">
      ${tile("Moved", `${f2(disp)} m`, rot ? `turned ${rot > 0 ? "+" : ""}${rot}°` : "same heading")}
      ${tile("Clearance", ev.collision ? "0 m" : `≈${f2(ev.clearance)} m`, ev.collision ? "collision" : ev.nearest ? `nearest object ${f2(ev.nearest.d)} m` : "to the nearest obstacle", ev.status)}
      ${tile(`${esc(a?.tag)} zone`, z.clear ? "Clear" : "Blocked", `${z0.freePct}% → ${z.freePct}% free floor`, z.clear ? "ok" : "bad")}
      ${tile("Robot route", A?.ok ? `${f2(A.length_m)} m` : A ? "None" : "…", B?.ok ? `was ${f2(B.length_m)} m · ${dl}` : "", A && !A.ok ? "bad" : "")}
    </div>
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
      <p class="note" style="margin-top:6px">Assumed illustrative requirement: ${ZONE_DEPTH.toFixed(1)} m deep × pump width + ${ZONE_EXTRA.toFixed(1)} m in front of the pump. Not a Valmet or OEM figure.</p></div>
    <div class="section stack">
      <div class="pl-btns"><button class="btn" data-pl="reset">${icon("reset")}Reset layout</button><button class="btn" data-pl="wo">${icon("doc")}Draft work order</button></div>
      <div class="pl-btns"><button class="btn" data-pl="md">${ic("dl")}Markdown</button><button class="btn" data-pl="json">${ic("dl")}JSON</button><button class="btn" data-pl="copy">${ic("copy")}Copy</button></div></div>
    <p class="note" style="margin-top:12px">The scan is unchanged. Proxies are virtual: nothing has been moved on site.</p></div>`;
}
function renderCard() {
  if (APP.S?.mode !== "plan") return;
  const el = $("#right"), top = el.scrollTop;
  el.innerHTML = cardHTML(); el.scrollTop = top;
}
function scheduleCard() {
  if (P.cardTimer) return;
  P.cardTimer = setTimeout(() => { P.cardTimer = 0; renderCard(); renderDock(); if (!P.drag) renderLeft(); }, 90);
}
async function onCardClick(e) {
  if (APP.S?.mode !== "plan") return;
  const p = e.target.closest("[data-pl-pick]"); if (p) return pick(p.dataset.plPick);
  const a = e.target.closest("[data-pl]")?.dataset.pl;
  if (a === "reset") reset();
  if (a === "md" || a === "json" || a === "copy") exportPlan(a);
  if (a === "wo") draftWorkOrder();
  if (a === "demo") demo();
}

// ------------------------------------------------------------------ UI: dock
function dockHTML() {
  const has = !!P.active, B = P.before, A = P.after;
  const info = !P.moves.length ? `<small>Create a proxy to compare routes</small>` : P.routeBusy ? `<small>Planning the new route…</small>`
    : A?.ok ? `<small>A* ${A.compute_ms} ms · clearance ${A.min_clearance_m} m · ${A.collision_free ? "collision-free" : "check"}</small>` : A ? `<small class="pl-bad">No collision-free route with this layout</small>` : "<small>&nbsp;</small>";
  return `<div class="grp"><button class="tool ${has ? "on" : ""}" data-pd="proxy">${ic("box")}${has ? "Remove proxy" : "Create proxy"}</button></div>
    <div class="grp"><button class="tool" data-pd="l15" ${has ? "" : "disabled"} title="Turn 15° left ( [ )">${ic("rotL")}15°</button><button class="tool" data-pd="r15" ${has ? "" : "disabled"} title="Turn 15° right ( ] )">${ic("rotR")}15°</button><button class="tool" data-pd="r90" ${has ? "" : "disabled"} title="Turn 90° (R)">${ic("turn")}90°</button></div>
    <div class="grp"><button class="tool ${P.snap ? "on" : ""}" data-pd="snap"><span class="switch"></span>Snap 5 cm</button><button class="tool ${P.compare ? "on" : ""}" data-pd="compare"><span class="switch"></span>Routes</button></div>
    <div class="grp routeinfo"><div class="top"><span>Route to ${esc(P.target?.asset?.tag || "target")}</span><b>${B?.ok ? `${f2(B.length_m)} m` : "…"}${A?.ok ? ` → ${f2(A.length_m)} m` : ""}</b></div>${info}</div>
    <div class="grp"><button class="tool" data-pd="reset" ${P.moves.length ? "" : "disabled"}>${icon("reset")}Reset</button><button class="tool" data-pd="export" ${P.moves.length ? "" : "disabled"}>${ic("dl")}Export</button></div>`;
}
function renderDock() { if (APP.S?.mode === "plan") $("#dock").innerHTML = dockHTML(); }
function onDock(e) {
  const d = e.target.closest("[data-pd]")?.dataset.pd; if (!d) return;
  if (d === "proxy") { if (P.active) removeProxy(P.active); else pick(APP.S.selected?.kind === "object" ? APP.S.selected.id : SUGGESTED); }
  if (d === "l15") rotate(-Math.PI / 12);
  if (d === "r15") rotate(Math.PI / 12);
  if (d === "r90") rotate(Math.PI / 2);
  if (d === "snap") { P.snap = !P.snap; renderDock(); }
  if (d === "compare") { P.compare = !P.compare; drawRoutes(); renderDock(); }
  if (d === "reset") reset();
  if (d === "export") exportPlan("md");
}
function renderAll() { renderLeft(); renderCard(); renderDock(); }

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
  reset({ quiet: true });
  const spot = await findSpot(SUGGESTED);
  createProxy(SUGGESTED);
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
  frameView(0.9);
  await computeAfter();
  renderAll();
  return summary();
}
async function waitReady() { for (let i = 0; i < 200 && !P.ready; i++) await sleep(50); }

// ------------------------------------------------------------------ state for shared links (Remote Support)
function getState() {
  return { v: 1, target: P.target?.id, moves: P.moves.map((m) => ({ id: m.id, x: +m.x.toFixed(3), z: +m.z.toFixed(3), yaw: +m.yaw.toFixed(4) })), active: P.active };
}
async function setState(state) {
  await waitReady();
  const moves = (state?.moves || []).filter((m) => objOf(m.id) && [m.x, m.z, m.yaw].every(Number.isFinite));
  P.moves = moves.map((m) => ({ id: m.id, x: +m.x, z: +m.z, yaw: +m.yaw }));
  P.active = moves.some((m) => m.id === state.active) ? state.active : P.moves.at(-1)?.id || null;
  P.dirtyField = true; P.after = null;
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
  S.cardLock = false;                          // the right card belongs to Plan now
  S.fac.routeGroup.visible = false;   // the comparison replaces the Explore route here
  refresh(); drawRoutes(); renderAll();
  beforeRoute().then(() => { drawRoutes(); renderCard(); renderDock(); });
  frameView();
}
/** Fly the camera so the target, its service zone, the originals and the proxies are all in view. */
function frameView(dur = 1.1) {
  const pts = [[P.target.center[0], P.target.center[2]], ...corners(P.zone)];
  const ids = P.moves.length ? P.moves.map((m) => m.id) : objOf(SUGGESTED) ? [SUGGESTED] : [];
  for (const id of ids) { const o = objOf(id), m = moveOf(id); pts.push([o.center[0], o.center[2]]); if (m) pts.push([m.x, m.z]); }
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const r = Math.max(1.2, ...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cz)));
  const focus = new THREE.Vector3(cx, 0, cz), off = APP.viewOffset(focus).setY(0).normalize();
  const dist = r * 2.1 + 1.2;
  APP.flyTo(new THREE.Vector3(cx + off.x * dist * 0.62, dist * 0.85, cz + off.z * dist * 0.62), focus, dur);
}
function exit() {
  const S = APP.S;
  if (P.drag) { P.drag = null; APP.controls.enabled = true; }
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
    if (hit) { if (P.active !== hit.m.id) { P.active = hit.m.id; P.dirtyField = true; refresh(); renderAll(); } return true; }
    const id = APP.S.fac.pick(ray);
    if (id) {
      const o = APP.S.data.objects.find((x) => x.id === id);
      APP.S.selected = o;
      if (o.kind === "object" && o.id !== P.target.id) createProxy(o.id);
      else { highlight(); renderLeft(); APP.toast(o.id === P.target.id ? `${esc(P.target.asset?.tag)} is the equipment being serviced; choose what to move around it.` : "Structures (walls, floor) cannot be moved."); }
    }
    return true;
  },
});

on("boot", () => {
  init().then(() => { if (APP.S.mode === "plan") { refresh(); renderAll(); } }).catch((e) => console.warn("planning init", e));
  $("#right").addEventListener("click", onCardClick);
  APP.canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
  addEventListener("pointermove", onPointerMove);
  addEventListener("pointerup", onPointerUp);
  addEventListener("pointercancel", onPointerUp);
  addEventListener("keydown", onKey);
  // main.js refreshes the default cards from the robot loop (transit card, arrival) without a mode check:
  // in Plan mode put the planning cards back, unless the user asked for another card (S.cardLock).
  const guard = (sel, mine, render) => new MutationObserver(() => {
    if (!P.ready || APP.S?.mode !== "plan" || APP.S.cardLock || $(sel).querySelector(mine)) return;
    queueMicrotask(() => { if (APP.S.mode === "plan" && !$(sel).querySelector(mine)) render(); });
  }).observe($(sel), { childList: true });
  guard("#right", ".pl-disc", renderCard);
  guard("#left", ".pl-steps", renderLeft);
  APP.planning = { getState, setState, reset: () => reset({ quiet: true }), demo, summary, exportMarkdown: () => markdown(summary()), _findSpot: findSpot, _evaluate: (id, pose) => evaluate(id, pose) };
});
on("planExtras", planExtras);
on("minimap", drawMinimap);
// selectObject() re-renders the default asset list after the hook: put the planning card back
on("select", () => { if (APP.S?.mode === "plan") queueMicrotask(() => { renderLeft(); highlight(); }); });
