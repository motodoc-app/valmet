// Scan cut-out for Plan mode: when a piece of equipment is moved, the splats of the scan that lie inside its oriented
// box are copied into a small SplatMesh of their own that follows the planning proxy, and the same box is hidden at
// the original spot with a Spark SplatEdit (an SDF box at opacity 0). Nothing in the scan data is changed: the copy
// is made once per object from the loaded PackedSplats, the hide box is a render-time edit, and removing the move
// (undo, reset) simply takes both away again.
//
// It is an approximate cut-out: the box is the segmentation's oriented box, slightly expanded, with the floor slab
// trimmed off. Anything else inside the box (a hose, a fragment of a neighbour) moves along. The UI says so.
//
// Works with the full-fidelity SPZ meshes (scan frame + canonical transform, spherical harmonics copied verbatim)
// and the classic .splat meshes alike. With no Gaussian splats loaded (?scan=off, point-cloud fallback, engine
// failure) `available` is false and Plan shows the box proxy only.
import * as THREE from "three";
import { PackedSplats, SplatMesh, SplatEdit, SplatEditSdf, fromHalf } from "@sparkjsdev/spark";

export const CUT = {
  PAD: 0.05,        // horizontal expansion of the object box (m): the segmentation box is tight
  TOP: 0.04,        // extra above the box top (m)
  BELOW: 0.03,      // the segmentation box often starts a few cm above the floor (low forks, wheels): reach down
  FLOOR_Y: 0,       // floor height in the canonical frame (scene.json bounds: the floor plane is y = 0)
  FLOOR_TRIM: 0.02, // never take splats below FLOOR_Y + this (the floor slab under the object)
  MAX_SCALE: 0.25,  // splats bigger than this (m) are left out of the copy (floaters / haze blobs)
};

let HALF = null;  // float16 → float32 lookup (256 KB, built once)
const halfLUT = () => {
  if (HALF) return HALF;
  HALF = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) HALF[i] = fromHalf(i);
  return HALF;
};

const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _t = new THREE.Matrix4();

/** World matrix of a box at (x, y, z) turned by yaw (same convention as the planning proxy: rotation.y = -yaw). */
const boxMatrix = (x, y, z, yaw, out = new THREE.Matrix4()) => out.makeRotationY(-yaw).setPosition(x, y, z);

export class SplatCut {
  /** @param scene the facility THREE.Scene  @param fac the Facility (fac.splats = its SplatMesh list) */
  constructor(scene, fac) {
    this.fac = fac;
    this.group = new THREE.Group(); this.group.name = "splatcut";
    scene.add(this.group);
    this.edit = new SplatEdit({ name: "plan-hide-originals" });   // multiply rgba by (1,1,1,0) inside each box
    this.cache = new Map();   // id -> { box, meshes: [{ mesh, src }], count, ms, srcKey }
    this.active = new Map();  // id -> { entry, sdf }
    this.enabled = true;
    this.log = [];            // extraction timings (for the report / tests)
  }

  /** Splat meshes the cut-out can read (Gaussian splats with their packed data on the CPU). */
  sources() { return (this.fac?.splats || []).filter((m) => m.isInitialized && m.packedSplats?.packedArray && m.packedSplats.numSplats > 0); }
  get available() { return this.enabled && this.sources().length > 0; }
  srcKey() { const s = this.sources(); return `${s.length}:${s.reduce((n, m) => n + m.packedSplats.numSplats, 0)}`; }

  /** The cut box of an object in world space: oriented like the object, padded, floor slab removed. */
  boxOf(o) {
    const bottom = o.center[1] - o.size[1] / 2, top = o.center[1] + o.size[1] / 2;
    const y0 = Math.max(bottom - CUT.BELOW, CUT.FLOOR_Y + CUT.FLOOR_TRIM), y1 = Math.max(y0 + 0.02, top + CUT.TOP);
    return { cx: o.center[0], cz: o.center[2], yaw: o.yaw, y0, y1, cy: (y0 + y1) / 2,
      hx: o.size[0] / 2 + CUT.PAD, hy: (y1 - y0) / 2, hz: o.size[2] / 2 + CUT.PAD };
  }

  /** Copy the splats inside the object's box into new SplatMeshes (one per source mesh that has any). Once per object. */
  extract(o) {
    const key = this.srcKey(), old = this.cache.get(o.id);
    if (old && old.srcKey === key) return old;
    if (old) this._disposeEntry(old);
    const t0 = performance.now(), H = halfLUT(), box = this.boxOf(o);
    const toBox = boxMatrix(box.cx, box.cy, box.cz, box.yaw).invert();
    const meshes = [];
    let count = 0, scanned = 0, skippedBig = 0;
    for (const src of this.sources()) {
      const ps = src.packedSplats, arr = ps.packedArray, n = ps.numSplats;
      src.updateWorldMatrix(true, false);
      const e = _m.multiplyMatrices(toBox, src.matrixWorld).elements;   // splat (mesh local) → box frame
      const { hx, hy, hz } = box;
      const enc = ps.splatEncoding, lnMin = enc?.lnScaleMin ?? -12, lnStep = ((enc?.lnScaleMax ?? 9) - lnMin) / 254;
      // world scale of the mesh (uniform) so MAX_SCALE is in metres
      const s = Math.hypot(e[0], e[1], e[2]) || 1;
      const bigU = Math.max(1, Math.min(255, Math.round((Math.log(CUT.MAX_SCALE / s) - lnMin) / lnStep) + 1));
      const idx = [];
      scanned += n;
      for (let i = 0; i < n; i++) {
        const w1 = arr[i * 4 + 1], w2 = arr[i * 4 + 2];
        const x = H[w1 & 0xffff], y = H[w1 >>> 16], z = H[w2 & 0xffff];
        const bx = e[0] * x + e[4] * y + e[8] * z + e[12]; if (bx < -hx || bx > hx) continue;
        const bz = e[2] * x + e[6] * y + e[10] * z + e[14]; if (bz < -hz || bz > hz) continue;
        const by = e[1] * x + e[5] * y + e[9] * z + e[13]; if (by < -hy || by > hy) continue;
        const w3 = arr[i * 4 + 3];
        if ((w3 & 255) > bigU || ((w3 >>> 8) & 255) > bigU || ((w3 >>> 16) & 255) > bigU) { skippedBig++; continue; }
        idx.push(i);
      }
      if (!idx.length) continue;
      const mesh = this._copy(src, idx);
      meshes.push({ mesh, src });
      count += idx.length;
    }
    const ms = +(performance.now() - t0).toFixed(1);
    const entry = { id: o.id, box, meshes, count, ms, scanned, skippedBig, srcKey: key, origin: boxMatrix(box.cx, 0, box.cz, box.yaw).invert() };
    this.cache.set(o.id, entry);
    this.log.push({ id: o.id, splats: count, meshes: meshes.length, ms, scanned, skippedBig, path: this.fac.renderPath || "?" });
    return entry;
  }

  /** Verbatim copy of the packed words (and spherical-harmonics words) of `idx` into a new, non-editable SplatMesh. */
  _copy(src, idx) {
    const ps = src.packedSplats, n = idx.length;
    const out = new PackedSplats({ splatEncoding: ps.splatEncoding });
    const dst = out.ensureSplats(n), a = ps.packedArray;
    for (let k = 0; k < n; k++) { const i = idx[k] * 4, j = k * 4; dst[j] = a[i]; dst[j + 1] = a[i + 1]; dst[j + 2] = a[i + 2]; dst[j + 3] = a[i + 3]; }
    for (const [level, key, w] of [[1, "sh1", 2], [2, "sh2", 4], [3, "sh3", 4]]) {
      const sh = ps.extra?.[key]; if (!sh) break;
      const d = out.ensureSplatsSh(level, n);
      for (let k = 0; k < n; k++) for (let c = 0; c < w; c++) d[k * w + c] = sh[idx[k] * w + c];
    }
    out.numSplats = n; out.needsUpdate = true;
    // editable: false → the hide boxes (global SplatEdit) never apply to the moved copy
    const mesh = new SplatMesh({ packedSplats: out, splatEncoding: ps.splatEncoding, editable: false, raycastable: false });
    mesh.matrixAutoUpdate = false;
    mesh.userData = { ...src.userData, planCut: true };
    mesh.maxSh = src.maxSh;
    return mesh;
  }

  /** Make exactly `ids` cut out (hide at the original spot + show the copy); restore everything else. */
  sync(ids, objOf) {
    const want = new Set(this.available ? ids : []);
    for (const [id, a] of [...this.active]) if (!want.has(id) || a.entry.srcKey !== this.srcKey()) this._deactivate(id);
    for (const id of want) {
      if (this.active.has(id)) continue;
      const o = objOf(id); if (!o) continue;
      const entry = this.extract(o);
      if (!entry.count) { this.active.set(id, { entry, sdf: null }); continue; }
      const b = entry.box;
      const sdf = new SplatEditSdf({ type: "box", opacity: 0, color: new THREE.Color(1, 1, 1) });
      sdf.position.set(b.cx, b.cy, b.cz); sdf.rotation.y = -b.yaw; sdf.scale.set(b.hx, b.hy, b.hz);
      this.edit.add(sdf);
      for (const { mesh } of entry.meshes) this.group.add(mesh);
      this.active.set(id, { entry, sdf });
    }
    const any = [...this.active.values()].some((a) => a.sdf);
    if (any && !this.edit.parent) this.group.add(this.edit);
    if (!any && this.edit.parent) this.edit.removeFromParent();
  }

  _deactivate(id) {
    const a = this.active.get(id); if (!a) return;
    if (a.sdf) this.edit.remove(a.sdf);
    for (const { mesh } of a.entry.meshes) this.group.remove(mesh);
    this.active.delete(id);
  }

  _disposeEntry(entry) {
    for (const { mesh } of entry.meshes) { mesh.removeFromParent(); try { mesh.dispose(); } catch {} }
  }

  /** Place the copy of `id` at a pose (x, z, yaw) lifted by `lift` metres. */
  pose(id, x, z, yaw, lift = 0) {
    const a = this.active.get(id); if (!a) return;
    // world = T(pose) · R(-yaw) · origin⁻¹ · src.matrixWorld  (a rigid move of the whole cut-out about its box)
    const P = boxMatrix(x, lift, z, yaw, _t).multiply(a.entry.origin);
    for (const { mesh, src } of a.entry.meshes) { mesh.matrix.multiplyMatrices(P, src.matrixWorld); mesh.matrixWorldNeedsUpdate = true; }
  }

  /** Per frame: the copies follow their source layer (cut-away, clean scan, semantic dimming). */
  update() {
    for (const a of this.active.values()) for (const { mesh, src } of a.entry.meshes) {
      mesh.visible = src.visible && !!src.parent;
      if (mesh.opacity !== src.opacity) mesh.opacity = src.opacity;
      if (!mesh.recolor.equals(src.recolor)) mesh.recolor.copy(src.recolor);
    }
  }

  /** True if the object is currently shown as a moved scan cut-out. */
  isCut(id) { const a = this.active.get(id); return !!(a && a.sdf); }
  stats(id) { const e = this.cache.get(id); return e ? { splats: e.count, meshes: e.meshes.length, ms: e.ms, scanned: e.scanned, skipped_big: e.skippedBig } : null; }
  clear() { for (const id of [...this.active.keys()]) this._deactivate(id); this.edit.removeFromParent(); }
}
