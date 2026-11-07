// The scanned plant room: splats, semantic 3D frames, route, robot and walkway blocks.
import * as THREE from "three";
import { SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } from "@sparkjsdev/spark";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { hazeMask, wallClip } from "./scanfilter.js";
import { CATEGORIES, CAT, CONDITION, catOf, isUncertain, hexRGB } from "./semantic.js";
import { buildMarkers, buildTwin } from "./twin.js";

export const STATUS = { healthy: 0x30d158, watch: 0xffd60a, degraded: 0xff9f0a, attention_required: 0xff453a };
const NEUTRAL = 0xc8ccd2;

// Polyline with circular-ish (quadratic) fillets at every corner. Unlike a Catmull-Rom spline it never overshoots
// the validated straight segments, so the drawn and driven path stays inside the checked corridor.
export function roundedPath(pts, radius, isSafe = () => true) {
  const path = new THREE.CurvePath();
  if (pts.length < 2) { path.add(new THREE.LineCurve3(pts[0], pts[0].clone().add(new THREE.Vector3(0.001, 0, 0)))); return path; }
  let cur = pts[0].clone();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    // largest fillet (≤ radius) whose whole arc stays on walkable floor (walkable already includes robot clearance)
    let r = Math.min(radius, a.distanceTo(b) / 2, b.distanceTo(c) / 2), p1, p2;
    for (; r > 0.02; r *= 0.7) {
      p1 = b.clone().add(a.clone().sub(b).setLength(r)); p2 = b.clone().add(c.clone().sub(b).setLength(r));
      const q = new THREE.QuadraticBezierCurve3(p1, b, p2);
      let ok = true;
      for (let k = 0; k <= 12 && ok; k++) { const v = q.getPoint(k / 12); ok = isSafe(v.x, v.z); }
      if (ok) break;
    }
    if (r <= 0.02) { if (cur.distanceTo(b) > 1e-4) path.add(new THREE.LineCurve3(cur, b.clone())); cur = b.clone(); continue; }
    if (cur.distanceTo(p1) > 1e-4) path.add(new THREE.LineCurve3(cur, p1));
    path.add(new THREE.QuadraticBezierCurve3(p1, b.clone(), p2));
    cur = p2;
  }
  if (cur.distanceTo(pts.at(-1)) > 1e-4) path.add(new THREE.LineCurve3(cur, pts.at(-1).clone()));
  return path;
}

// Compact hosted format (see scripts/export_static.py): columnar u16 xyz, u8 log-scale ×3, u8 rgba, u8 quaternion.
// Expanded here to standard 32-byte .splat records for the splat engine.
export function decodeXq16(b, n, m) {
  const out = new Uint8Array(n * 32), dv = new DataView(out.buffer);
  const src = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lo = m.lo, span = [m.hi[0] - m.lo[0], m.hi[1] - m.lo[1], m.hi[2] - m.lo[2]];
  const sMin = m.log_scale_min, sSpan = m.log_scale_span;
  const offS = 6 * n, offC = 9 * n, offR = 13 * n;
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    for (let a = 0; a < 3; a++) {
      dv.setFloat32(o + a * 4, lo[a] + (src.getUint16((a * n + i) * 2, true) / 65535) * span[a], true);
      dv.setFloat32(o + 12 + a * 4, Math.exp(sMin + (b[offS + a * n + i] / 255) * sSpan), true);
    }
    for (let a = 0; a < 4; a++) { out[o + 24 + a] = b[offC + a * n + i]; out[o + 28 + a] = b[offR + a * n + i]; }
  }
  return out;
}

// Split 32-byte .splat records into [["low", ...], ["high", ...]] at height `cut` (y is bytes 4..7).
export function splitByHeight(splat, cut) {
  const n = splat.length / 32, dv = new DataView(splat.buffer, splat.byteOffset, splat.byteLength);
  let lowN = 0;
  const isLow = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (dv.getFloat32(i * 32 + 4, true) <= cut) { isLow[i] = 1; lowN++; }
  const low = new Uint8Array(lowN * 32), high = new Uint8Array((n - lowN) * 32);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const rec = splat.subarray(i * 32, i * 32 + 32);
    if (isLow[i]) { low.set(rec, a * 32); a++; } else { high.set(rec, b * 32); b++; }
  }
  return [["low", low], ["high", high]];
}

/**
 * Partition 32-byte .splat records into up to six layers: below / above the cut-away height, each split into
 * "clean", "haze" and "outside" (beyond a wall plane; see scanfilter.js). Every layer becomes its own SplatMesh,
 * so the cut-away and the clean-scan filter are instant visibility flips instead of re-uploads.
 * Returns [{ layer, haze, outside, bytes }] and the counts.
 */
export function splitScan(splat, cut, bounds) {
  const n = splat.length / 32, dv = new DataView(splat.buffer, splat.byteOffset, splat.byteLength);
  const cls = bounds ? hazeMask(splat, bounds) : new Uint8Array(n);      // 0 clean, 1 haze, 2 outside
  const kind = new Uint8Array(n), count = [0, 0, 0, 0, 0, 0];            // kind = (low 0 / high 1) + 2 * class
  for (let i = 0; i < n; i++) { const k = (dv.getFloat32(i * 32 + 4, true) <= cut ? 0 : 1) + 2 * cls[i]; kind[i] = k; count[k]++; }
  const out = count.map((c) => new Uint8Array(c * 32)), at = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const k = kind[i]; out[k].set(splat.subarray(i * 32, i * 32 + 32), at[k]++ * 32); }
  return { parts: out.map((bytes, k) => ({ layer: k % 2 ? "high" : "low", haze: k >> 1 === 1, outside: k >> 1 === 2, bytes })), total: n, haze: count[2] + count[3] };
}

let _dot;
function dotTexture() {
  if (_dot) return _dot;
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d"); g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
  return (_dot = new THREE.CanvasTexture(c));
}

export class Facility {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.frames = new Map();
    this.highlight = new Set();
    this.showMode = "all";
    this.splats = [];
    this.previews = [];
    // Cut-away for high cameras (Top / Angled / overview). Gaussian splats: a soft horizontal cut (Spark SplatEdit,
    // render-time only) that fades out the ceiling and the overhead duct band between cutTop ± cutSoft/2, so walls and
    // tall equipment stay whole up to there instead of being sliced. The point-cloud fallback (no splat engine) can
    // only hide whole layers, so it cuts at layerY, the height the scan chunks are split at (build-hq-scan CUT_Y).
    this.layerY = 1.7;        // metres above the floor
    this.cutTop = 1.7;        // middle of the soft cut (splats)
    this.cutSoft = 0.3;       // fade band (m): fully shown below cutTop − cutSoft/2, gone above cutTop + cutSoft/2
    this.cutaway = false;     // the cut-away as drawn
    this.cutAsked = false;    // what the camera asks for (high cameras: Top, Angled, overview, Plan Top/Angled)
    this.cutUser = null;      // null = follow the camera; false = the user chose "Show full scan" (survives camera switches)
    this.cleanScan = false;   // hide haze splats (scanfilter.js)
    this.semantic = false;    // category-coloured boxes over a dimmed scan
    this.showUncertain = false;
    this.scanStats = { splats: 0, haze: 0 };
    this._buildFrames();
    this._buildRobot();
    // asset condition pins (twin.js): the condition reads at a glance without a box around every asset
    this.markers = buildMarkers(data.objects);
    this.root.add(this.markers);
    this.twin = null;         // clean-geometry overlay, built on first use (setTwin)
    this.routeGroup = new THREE.Group();
    this.blockGroup = new THREE.Group();
    this.gridGroup = new THREE.Group();
    this.gridGroup.visible = false;
    this.root.add(this.routeGroup, this.blockGroup, this.gridGroup);
  }

  /**
   * Streams the scan chunk by chunk (most visually important splats first).
   * Each chunk is shown at once as a cheap point cloud (no WASM, no workers), then upgraded to Gaussian splats.
   * If the splat engine is unavailable or does not finish within `timeoutMs`, the point cloud simply stays,
   * so the page can never hang on the scan. `onStatus({received, total, phase})` reports progress.
   */
  async loadScan(manifest, onStatus, { splats = true, timeoutMs = 45000, fallback = null, lite = false } = {}) {
    // full-fidelity SPZ chunks first (needs the splat engine); on any failure of the first chunk → classic chunks
    if (manifest.splat_format === "spz") {
      const classic = manifest.classic || fallback;
      if (splats && !new URLSearchParams(location.search).get("splat")) {
        try { return await this._loadHQ(manifest, onStatus, { timeoutMs: Math.max(timeoutMs, 90000), lite }); }
        catch (e) { console.warn("full-fidelity scan unavailable, using the classic scan:", e.message); this._dropHQ(); }
      }
      manifest = classic;
    }
    this.renderPath = "classic";
    try {
      return await this._loadScan(manifest, onStatus, { splats, timeoutMs, lite });
    } catch (e) {
      // a missing or broken chunk must not leave the room empty: retry once with the committed scene.splat
      if (!fallback || manifest === fallback || this.previews.length) throw e;
      console.warn("scan chunks unavailable, using the full scene file:", e.message);
      return this._loadScan(fallback, onStatus, { splats, timeoutMs, lite });
    }
  }

  /**
   * Full-fidelity scan: every splat of the supplied 3DGS model with its spherical harmonics, as SPZ chunks
   * (scripts/build-hq-scan.mjs). Splats stay in the scan's own frame; the canonical transform is the mesh matrix,
   * so they line up with scene.json exactly and view-dependent colour rotates correctly. Each chunk is one layer
   * (low/high × clean/haze) of one importance tier, so cut-away and clean-scan stay instant visibility flips.
   * Phones (lite) load tier 0 only. Throws if the first chunk cannot be shown (caller falls back to classic).
   */
  async _loadHQ(manifest, onStatus, { timeoutMs, lite }) {
    const chunks = manifest.chunks.filter((c) => !lite || c.tier === 0);
    this.renderPath = "hq";
    this.scanSource = `full-fidelity scan · ${chunks.length} SPZ chunks · SH ${manifest.max_sh}`;
    const M = new THREE.Matrix4().fromArray(manifest.transform).transpose();   // stored row-major
    const total = chunks.reduce((n, c) => n + c.bytes, 0);
    let received = 0;
    const report = (phase) => onStatus?.({ received, total, phase });
    const fetchChunk = async (c) => {
      const res = await fetch(c.url);
      if (!res.ok) throw new Error(`${c.url}: HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) { const b = new Uint8Array(await res.arrayBuffer()); received += b.length; report("download"); return b; }
      const out = new Uint8Array(c.bytes); let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > out.length) throw new Error(`${c.url}: larger than declared`);
        out.set(value, n); n += value.length; received += value.length; report("download");
      }
      if (n !== c.bytes) throw new Error(`${c.url}: ${n} of ${c.bytes} bytes`);
      return out;
    };
    const show = async (bytes, c) => {
      const m = new SplatMesh({ fileBytes: bytes, fileType: "spz", fileName: c.file });
      m.matrixAutoUpdate = false; m.matrix.copy(M);
      m.userData.layer = c.layer; m.userData.haze = !!c.haze; m.userData.outside = !!c.outside; m.userData.hq = true;
      m.visible = false;
      this._styleSplat(m);
      this.root.add(m); this.splats.push(m); this._applyCut();
      await Promise.race([m.initialized, new Promise((_, rej) => setTimeout(() => rej(new Error("splat engine timeout")), timeoutMs))]);
      m.visible = this._layerOn(m);
      this.scanStats.splats += c.count; if (c.haze) this.scanStats.haze += c.count;
      this.splatMode = "splats";
    };
    report("download");
    // the first chunk proves the path works (download + decode); the rest stream in parallel afterwards
    await show(await fetchChunk(chunks[0]), chunks[0]);
    report("render");
    const rest = await Promise.allSettled(chunks.slice(1).map(async (c) => show(await fetchChunk(c), c)));
    for (const r of rest) if (r.status === "rejected") console.warn("scan chunk skipped:", r.reason?.message);
    report("done");
  }

  _dropHQ() {
    for (const m of this.splats.filter((s) => s.userData.hq)) { this.root.remove(m); m.dispose?.(); }
    this.splats = this.splats.filter((s) => !s.userData.hq);
    this.scanStats = { splats: 0, haze: 0 };
    this.splatMode = undefined;
  }

  async _loadScan(manifest, onStatus, { splats, timeoutMs, lite }) {
    const qa = new URLSearchParams(location.search).get("splat");
    let chunks = qa ? [{ url: qa }] : manifest.chunks;
    this.scanSource = qa ? qa : manifest.fallback ? "data/scene.splat (fallback)" : `${chunks.length} streamed chunks`;
    if (lite && chunks.length > 2) chunks = chunks.slice(0, 2);   // phones: the most important ~730k splats
    const format = qa ? "splat" : manifest.splat_format;
    const total = chunks.reduce((n, c) => n + (c.bytes || 0), 0);
    let received = 0;
    const report = (phase) => onStatus?.({ received, total, phase });
    const fetchChunk = async (c) => {
      const res = await fetch(c.url);
      if (!res.ok) throw new Error(`${c.url}: HTTP ${res.status}`);
      if (!res.body || !total) { const b = new Uint8Array(await res.arrayBuffer()); received += b.length; report("download"); return b; }
      const reader = res.body.getReader(), parts = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); n += value.length; received += value.length; report("download");
      }
      const out = new Uint8Array(n); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    };
    // chunk 0 first (fast first picture), the rest in parallel afterwards
    const first = await fetchChunk(chunks[0]);
    // later chunks only add detail: if one fails, keep what we have rather than failing the scan
    const rest = Promise.allSettled(chunks.slice(1).map(fetchChunk));
    const show = async (bytes, c) => {
      const all = format === "xq16" ? decodeXq16(bytes, c.count, manifest) : bytes;
      // split each chunk at the cut-away height: the upper part (ceiling, overhead pipes) can be hidden so
      // high spectator cameras look straight into the room, like an architectural floor-plan cut
      // ...and partition out the haze (clean-scan filter) the same way
      const { parts, total: nAll, haze: nHaze } = splitScan(all, this.layerY, { ...this.data.bounds, walls: wallClip(this.data.planes, this.data.bounds) });
      this.scanStats.splats += nAll; this.scanStats.haze += nHaze;
      for (const { layer, haze, outside, bytes: splat } of parts) {
        if (!splat.length) continue;
        const preview = this._points(splat);
        preview.userData.layer = layer; preview.userData.haze = haze; preview.userData.outside = outside;
        preview.visible = this._layerOn(preview);
        this._stylePreview(preview);
        this.previews.push(preview);
        if (!splats) continue;
        try {
          const m = new SplatMesh({ fileBytes: splat, fileType: "splat", fileName: "scene.splat" });
          m.userData.layer = layer; m.userData.haze = haze; m.userData.outside = outside;
          m.visible = this._layerOn(m);
          this._styleSplat(m);
          this.root.add(m);
          this.splats.push(m); this._applyCut();
          await Promise.race([m.initialized, new Promise((_, rej) => setTimeout(() => rej(new Error("splat engine timeout")), timeoutMs))]);
          preview.userData.replaced = true;   // splats are up: drop the preview for this part
          preview.visible = false;
          m.visible = this._layerOn(m);       // toggles may have changed while this part was initialising
          this.splatMode = "splats";
        } catch (e) {
          console.warn("Gaussian splats unavailable, keeping point view:", e);
          this.splatMode = "points";
        }
      }
    };
    report("render");
    const firstShown = show(first, chunks[0]);
    const others = (await rest).map((r, i) => r.status === "fulfilled" ? show(r.value, chunks[i + 1]) : (console.warn("scan chunk skipped:", r.reason?.message), null)).filter(Boolean);
    await Promise.all([firstShown, ...others]);
    report("done");
  }

  // Lightweight point-cloud view of .splat records (used as instant preview and as the fallback renderer).
  _points(splat) {
    const n = splat.length / 32, dv = new DataView(splat.buffer, splat.byteOffset, splat.byteLength);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      if (splat[o + 27] < 60) continue;                  // skip faint splats in the preview
      pos[k * 3] = dv.getFloat32(o, true); pos[k * 3 + 1] = dv.getFloat32(o + 4, true); pos[k * 3 + 2] = dv.getFloat32(o + 8, true);
      col[k * 3] = splat[o + 24] / 255; col[k * 3 + 1] = splat[o + 25] / 255; col[k * 3 + 2] = splat[o + 26] / 255;
      k++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, k * 3), 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.028, vertexColors: true, sizeAttenuation: true, map: dotTexture(), alphaTest: 0.4, transparent: false }));
    pts.material.color.setScalar(1);
    pts.frustumCulled = false;
    this.root.add(pts);
    return pts;
  }

  colorFor(o) { return o.asset ? STATUS[o.asset.condition_state] ?? NEUTRAL : NEUTRAL; }

  // All 676 frames live in ONE LineSegments (one draw call) with per-vertex RGBA, so highlighting is a
  // cheap attribute write instead of hundreds of material/visibility changes per frame.
  _buildFrames() {
    const objs = this.data.objects.filter((o) => o.kind === "object");
    const corners = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const pos = new Float32Array(objs.length * 24 * 3), col = new Float32Array(objs.length * 24 * 4);
    const c = new THREE.Color();
    objs.forEach((o, k) => {
      const cs = Math.cos(o.yaw), sn = Math.sin(o.yaw), h = o.size.map((v) => Math.max(v, 0.03) / 2);
      const world = corners.map(([x, y, z]) => {
        const lx = x * h[0], lz = z * h[2];
        return [o.center[0] + lx * cs - lz * sn, o.center[1] + y * h[1], o.center[2] + lx * sn + lz * cs];
      });
      edges.forEach(([i, j], e) => { pos.set(world[i], (k * 24 + e * 2) * 3); pos.set(world[j], (k * 24 + e * 2 + 1) * 3); });
      c.set(this.colorFor(o));
      const base = o.asset ? 0.45 : 0.16;   // subtle: the condition pin (twin.js) carries the status
      for (let v = 0; v < 24; v++) col.set([c.r, c.g, c.b, base], (k * 24 + v) * 4);
      this.frames.set(o.id, { k, obj: o, base, cs, sn, h });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.colAttr = new THREE.BufferAttribute(col, 4);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", this.colAttr);
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.root.add(this.lines);
    // a small pool of translucent fills for the selected / target objects only
    this.fills = new Map();
    this.fillGeo = new THREE.BoxGeometry(1, 1, 1);
  }

  _alpha(f) {
    const o = f.obj, on = this.highlight.has(o.id) || o.id === this.sel || o.id === this.tgt;
    const above = this.cutaway && o.center[1] - o.size[1] / 2 > this.cutY;     // fully above the cut: hidden
    const visible = !above && (this.showMode === "all" || (this.showMode === "assets" && !!o.asset) || on);
    return !visible ? 0 : on ? 1 : f.base;
  }

  _writeAlpha(f) {
    const a = this._alpha(f), arr = this.colAttr.array, start = f.k * 24 * 4;
    if (arr[start + 3] === a) return false;
    for (let v = 0; v < 24; v++) arr[start + v * 4 + 3] = a;
    return true;
  }

  _commit(dirty) { if (dirty) this.colAttr.needsUpdate = true; }

  // analytic ray / oriented-box test (no per-object meshes needed for picking)
  pick(ray) {
    let best = null;
    const o3 = ray.origin, d3 = ray.direction;
    for (const f of this.frames.values()) {
      // every object stays clickable even when its frame is hidden (frames are only a visual aid);
      // only parts cut away for a high camera are skipped
      if (this.cutaway && f.obj.center[1] - f.obj.size[1] / 2 > this.cutY) continue;
      const o = f.obj, ox = o3.x - o.center[0], oy = o3.y - o.center[1], oz = o3.z - o.center[2];
      // rotate into the box frame (inverse of the yaw used when building)
      const lo = [ox * f.cs + oz * f.sn, oy, -ox * f.sn + oz * f.cs];
      const ld = [d3.x * f.cs + d3.z * f.sn, d3.y, -d3.x * f.sn + d3.z * f.cs];
      let t0 = -Infinity, t1 = Infinity;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(ld[i]) < 1e-9) { if (Math.abs(lo[i]) > f.h[i]) { t0 = Infinity; break; } continue; }
        let a = (-f.h[i] - lo[i]) / ld[i], b = (f.h[i] - lo[i]) / ld[i];
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      if (t0 <= t1 && t1 > 0) {
        const vol = f.h[0] * f.h[1] * f.h[2];
        if (!best || vol < best.vol) best = { id: o.id, vol };   // prefer the smallest frame under the cursor
      }
    }
    return best?.id ?? null;
  }

  /** Height above which things count as cut away (frames, picking, Plan): the middle of the soft cut with Gaussian
   *  splats, the layer split for the point-cloud fallback. */
  get cutY() { return this._softCut() ? this.cutTop : this.layerY; }
  /** True when the scan is drawn as Gaussian splats, which take the soft render-time cut. */
  _softCut() { return this.splats.length > 0 && this.splatMode !== "points"; }

  /** A high camera asks for the cut-away (ceiling and overhead ducts faded out, their frames hidden). The user's
   *  "Show full scan" choice (setCutUser) wins over it until the user switches the cut-away back on. */
  setCutaway(on) {
    on = !!on;
    this.robot.userData.tag.visible = on;
    this.cutAsked = on;
    this._setCut(on && this.cutUser !== false);
  }
  /** The user's override from the cut-away chip: false = always the full scan, null = follow the camera again. */
  setCutUser(v) {
    this.cutUser = v === false ? false : null;
    this._setCut(this.cutAsked && this.cutUser !== false);
  }
  _setCut(on) {
    if (this.cutaway === on) return;
    this.cutaway = on;
    this._applyCut();
    this._applyLayers();
    this.setShowMode(this.showMode);
    if (this.sem) this._semStyle();
  }

  // The soft cut: one global SplatEdit with a horizontal plane SDF that multiplies the opacity of every editable splat
  // above cutTop by 0 (linear fade over cutSoft). It is in the scene only while the cut-away is on. Spark applies it
  // in world space after the mesh transform, so it works for the SPZ meshes (scan frame + canonical matrix) and the
  // classic .splat meshes alike. The Plan cut-out copies are not editable, so moved equipment is never cut.
  _applyCut() {
    const want = this.cutaway && this._softCut();
    if (want && !this._cut) {
      const edit = new SplatEdit({ name: "cutaway-ceiling", rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: this.cutSoft });
      const sdf = new SplatEditSdf({ type: SplatEditSdfType.PLANE, opacity: 0, color: new THREE.Color(1, 1, 1) });
      sdf.rotation.x = Math.PI / 2;   // the plane's local +z points down: "inside" (distance < 0) is above the cut
      edit.add(sdf);
      this._cut = { edit, sdf };
    }
    if (!this._cut) return;
    this._cut.sdf.position.y = this.cutTop;
    this._cut.edit.softEdge = this.cutSoft;
    if (want && !this._cut.edit.parent) this.root.add(this._cut.edit);
    if (!want && this._cut.edit.parent) this._cut.edit.removeFromParent();
  }

  // ---------------------------------------------------------------- scan layers: cut-away, clean scan, semantic dimming
  // haze is hidden by the clean-scan filter and always in the semantic view (there the scan is only context);
  // high cameras (cut-away) also drop the haze: from above, the floaters outside the room are what reads as "unfinished".
  // The walls ("outside" = beyond a fitted wall plane: about half of every wall's splats lie 6–30 cm behind the plane,
  // because real walls are not flat) always stay: hiding them left the room without walls, with ragged holes along
  // the edges, in Top and Angled. The "high" layer (above layerY) is only hidden where there is no soft cut (points).
  _layerOn(m) {
    const u = m.userData, soft = m instanceof SplatMesh;
    return (u.layer === "low" || !this.cutaway || soft) && !(u.haze && (this.cleanScan || this.semantic || this.cutaway));
  }
  _applyLayers() {
    for (const m of this.splats) m.visible = this._layerOn(m);
    for (const p of this.previews) p.visible = !p.userData.replaced && this._layerOn(p);
  }
  // Semantic view: the scan becomes a faint grey ghost so the coloured objects carry the picture.
  _styleSplat(m) { m.opacity = this.semantic ? 0.14 : 1; m.recolor.setScalar(this.semantic ? 0.75 : 1); }
  _stylePreview(p) { p.material.color.setScalar(this.semantic ? 0.22 : 1); }

  /** Clean scan: hide the haze layer (faint fog, huge blobs, floaters outside the room, isolated speckle). */
  setCleanScan(on) {
    this.cleanScan = !!on;
    this._applyLayers();
  }

  /**
   * Digital-twin overlay (twin.js): drivable-floor tint + 0.5 m grid, room outline from the fitted planes and every
   * asset as a clean outline, all in the scan's canonical frame. `grid` (api.grid()) gives the drivable tint.
   */
  setTwin(on, grid = this.walkGrid) {
    if (on && !this.twin) { this.twin = buildTwin(this.data, grid); this.root.add(this.twin); }
    if (this.twin) this.twin.visible = !!on;
    this.twinOn = !!on;
    this._markerStyle();
  }
  // pins hide in the semantic view (it has floor rings) and where the asset's own label is already up
  _markerStyle() {
    for (const s of this.markers.children) {
      if (!s.isSprite) { s.visible = !this.semantic; continue; }
      const f = this.frames.get(s.userData.id);
      s.visible = !this.semantic && !f?.label?.visible;
    }
  }

  setShowMode(mode) {
    this.showMode = mode;
    let dirty = false;
    for (const f of this.frames.values()) dirty = this._writeAlpha(f) || dirty;
    this._commit(dirty);
  }

  ensureLabel(id) {
    const f = this.frames.get(id);
    if (!f) return null;
    if (f.label) return f.label;
    const o = f.obj, el = document.createElement("div");
    if (o.asset) {
      el.className = `tag3d asset s-${o.asset.condition_state}`;
      el.innerHTML = `<span class="dot s-${o.asset.condition_state}"></span><b>${o.asset.tag}</b><small>${o.asset.health_score}</small>`;
    } else {
      el.className = "tag3d";
      el.innerHTML = `${o.label}<small>${Math.round(o.confidence * 100)}%</small>`;
    }
    const lab = new CSS2DObject(el);
    lab.position.set(o.center[0], o.center[1] + o.size[1] / 2, o.center[2]);
    lab.visible = false;
    this.root.add(lab);
    return (f.label = lab);
  }

  _fill(id, on) {
    let m = this.fills.get(id);
    if (!on) { if (m) m.visible = false; return; }
    if (!m) {
      const f = this.frames.get(id); if (!f) return;
      m = new THREE.Mesh(this.fillGeo, new THREE.MeshBasicMaterial({ color: this.colorFor(f.obj), transparent: true, opacity: 0.1, depthWrite: false }));
      m.position.set(...f.obj.center); m.rotation.y = -f.obj.yaw; m.scale.set(...f.obj.size.map((v) => Math.max(v, 0.03)));
      this.root.add(m); this.fills.set(id, m);
    }
    m.visible = true;
  }

  // Only touches objects whose state actually changed.
  setHighlighted(ids, { selected = null, target = null } = {}) {
    const next = new Set(ids);
    const changed = new Set([...this.highlight, ...next, this.sel, this.tgt, selected, target].filter(Boolean));
    this.highlight = next; this.sel = selected; this.tgt = target;
    let dirty = false;
    for (const id of changed) {
      const f = this.frames.get(id); if (!f) continue;
      dirty = this._writeAlpha(f) || dirty;
      const o = f.obj, on = next.has(id) || id === selected || id === target;
      const worth = o.asset || id === selected || (o.confidence >= 0.7 && ["rotating", "valve", "instrument", "vessel", "electrical"].includes(catOf(o)));
      if (on && worth) this.ensureLabel(id).visible = true;
      else if (f.label) f.label.visible = false;
      this._fill(id, id === selected || id === target);
    }
    this._commit(dirty);
    this._markerStyle();
  }

  pulse(t, id) {
    const m = this.fills.get(id);
    if (m?.visible) m.material.opacity = 0.06 + 0.08 * (0.5 + 0.5 * Math.sin(t * 3));
  }

  // ---------------------------------------------------------------- semantic view: every object as a coloured box
  // ONE InstancedMesh for all objects + walls (one draw call). A tiny shader patch draws crisp screen-space edges
  // and diagonal hatching from the unit-box position, and a per-instance (strength, hatch) attribute lets a toggle
  // restyle all 680 boxes with a single attribute upload. Asset condition rings: one more InstancedMesh.
  _buildSemantic() {
    const list = this.data.objects.filter((o) => o.kind === "object" || o.kind === "structure");
    const n = list.length;
    // front faces only: one pass, half the overdraw (the silhouette edges still outline every box)
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = "attribute vec2 aStyle;\nvarying vec2 vStyle;\nvarying vec3 vBox;\n" +
        sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvBox = position; vStyle = aStyle;");
      sh.fragmentShader = "varying vec2 vStyle;\nvarying vec3 vBox;\n" + sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
        vec3 e = 0.5 - abs(vBox);
        vec3 px = e / max(fwidth(vBox), vec3(1e-5));
        if (e.x <= e.y && e.x <= e.z) px.x = 1e4; else if (e.y <= e.z) px.y = 1e4; else px.z = 1e4;
        float edge = 1.0 - smoothstep(0.4, 1.4, min(px.x, min(px.y, px.z)));
        float st = step(0.55, fract((gl_FragCoord.x + gl_FragCoord.y) / 7.0));
        float fill = 0.24 * mix(1.0, 0.3 + 1.6 * st, vStyle.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7 + 0.3, edge * 0.3);
        diffuseColor.a = vStyle.x * mix(fill, 0.95, edge);
        if (diffuseColor.a < 0.004) discard;`);
    };
    const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, n);
    const style = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    style.setUsage(THREE.DynamicDrawUsage);
    boxes.geometry.setAttribute("aStyle", style);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    const index = new Map();
    list.forEach((o, i) => {
      q.setFromAxisAngle(up, -o.yaw); p.set(...o.center); sc.set(...o.size.map((v) => Math.max(v, 0.03)));
      boxes.setMatrixAt(i, m4.compose(p, q, sc));
      boxes.setColorAt(i, c.setRGB(...hexRGB(CAT[catOf(o)].color), THREE.SRGBColorSpace));
      index.set(o.id, i);
    });
    boxes.frustumCulled = false;
    boxes.renderOrder = 2;
    // condition rings on the floor under every workbook asset
    const assets = list.filter((o) => o.asset);
    const rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }), Math.max(1, assets.length));
    assets.forEach((o, i) => {
      const r = Math.min(0.7, Math.max(o.size[0], o.size[2]) / 2 + 0.12);   // capped: a few frames are much larger than the machine
      rings.setMatrixAt(i, m4.compose(p.set(o.center[0], 0.02, o.center[2]), q.identity(), sc.set(r, 1, r)));
      rings.setColorAt(i, c.setRGB(...hexRGB(CONDITION[o.asset.condition_state] || "#c8ccd2"), THREE.SRGBColorSpace));
    });
    rings.count = assets.length;
    rings.frustumCulled = false;
    const g = new THREE.Group();
    g.add(boxes, rings);
    g.visible = false;
    this.root.add(g);
    this.sem = { group: g, boxes, rings, style, list, index };
  }

  /** Objects per semantic category (walls excluded) and the number of uncertain ones. */
  categoryCounts() {
    const out = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
    let uncertain = 0;
    for (const o of this.data.objects) { if (o.kind !== "object") continue; out[catOf(o)]++; if (isUncertain(o)) uncertain++; }
    return { ...out, uncertain };
  }

  _semStrength(o) {
    if (this.cutaway && o.center[1] - o.size[1] / 2 > this.cutY) return [0, 0];
    const unc = isUncertain(o);
    if (this.showUncertain && unc) return [1, 1];
    if (!this.semantic) return [0, 0];
    if (this.showUncertain) return [0.22, 0];
    if (o.kind === "structure") return [0.45, 0];
    return [catOf(o) === "unknown" ? 0.7 : 1, 0];
  }
  _semShown(o) { const i = this.sem?.index.get(o.id); return i !== undefined && this.sem.style.array[i * 2] > 0; }

  _semStyle() {
    const { list, style, boxes, rings, group } = this.sem, a = style.array, c = new THREE.Color();
    list.forEach((o, i) => {
      const [s, h] = this._semStrength(o);
      a[i * 2] = s; a[i * 2 + 1] = h;
      // uncertain objects read as one class (white hatch) while "Show uncertain" is on
      boxes.setColorAt(i, c.setRGB(...hexRGB(h ? "#f2f3f5" : CAT[catOf(o)].color), THREE.SRGBColorSpace));
    });
    style.needsUpdate = true;
    boxes.instanceColor.needsUpdate = true;
    rings.visible = this.semantic;
    group.visible = this.semantic || this.showUncertain;
  }

  /** Semantic view: dim the scan and show every recognised object as a translucent box coloured by category. */
  setSemantic(on) {
    this.semantic = !!on;
    if (!this.sem) this._buildSemantic();
    for (const m of this.splats) this._styleSplat(m);
    for (const p of this.previews) this._stylePreview(p);
    this._applyLayers();
    this._semStyle();
    this._markerStyle();
  }

  /** Show uncertain: hatch the objects whose label is a guess (low confidence or "other equipment"). */
  setShowUncertain(on) {
    this.showUncertain = !!on;
    if (!this.sem) this._buildSemantic();
    this._semStyle();
  }

  // ---------------------------------------------------------------- hover / selection outline (drawn on top)
  _outlineBox(color, opacity) {
    const geo = this._edgeGeo ||= new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
    l.renderOrder = 20; l.visible = false; l.frustumCulled = false;
    this.root.add(l);
    return l;
  }
  _placeBox(m, o, pad = 0.03) {
    m.position.set(o.center[0], o.center[1], o.center[2]); m.rotation.set(0, -o.yaw, 0);
    m.scale.set(Math.max(o.size[0], 0.03) + pad, Math.max(o.size[1], 0.03) + pad, Math.max(o.size[2], 0.03) + pad);
  }
  /** Outline + name tag for the object under the cursor (null clears). */
  setHover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this._hover ||= this._outlineBox(0xffffff, 0.7);
    if (!this._hoverTag) {
      const el = document.createElement("div"); el.className = "tag3d hover-tag";
      this._hoverTag = new CSS2DObject(el); this._hoverTag.visible = false; this.root.add(this._hoverTag);
    }
    const f = id && this.frames.get(id);
    this._hover.visible = this._hoverTag.visible = !!f && id !== this.outlineId;
    if (!f) return;
    const o = f.obj, cat = CAT[catOf(o)], unc = isUncertain(o);
    this._placeBox(this._hover, o, 0.02);
    this._hoverTag.position.set(o.center[0], o.center[1] + o.size[1] / 2, o.center[2]);
    this._hoverTag.element.innerHTML = o.asset
      ? `<span class="dot s-${o.asset.condition_state}"></span><b>${o.asset.tag}</b><small>${o.label}</small>`
      : `<span class="sw" style="background:${cat.color}"></span>${o.label}<small>${Math.round(o.confidence * 100)}%${unc ? " · uncertain" : ""}</small>`;
    if (f.label?.visible) this._hoverTag.visible = false;   // its own label is already up
  }
  /** Persistent outline for the selected object (null clears). */
  setOutline(id) {
    if (id === this.outlineId) return;
    this.outlineId = id;
    this._sel ||= this._outlineBox(0xffffff, 1);
    const f = id && this.frames.get(id);
    this._sel.visible = !!f;
    if (f) this._placeBox(this._sel, f.obj, 0.05);
    if (this._hover && id && id === this.hoverId) this._hover.visible = this._hoverTag.visible = false;
  }

  // ---------------------------------------------------------------- robot: compact, matte, one status light
  _buildRobot() {
    const r = new THREE.Group();
    const shell = new THREE.MeshStandardMaterial({ color: 0xe9ebee, roughness: 0.55, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.6 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.19, 0.2, 40), shell);
    base.position.y = 0.14;
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.04, 40), dark);
    skirt.position.y = 0.04;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.5, 16), dark);
    mast.position.y = 0.49;
    const head = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.1, 6, 16), shell);
    head.rotation.z = Math.PI / 2;
    head.position.y = 0.78;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshBasicMaterial({ color: 0x0a0b0d }));
    lens.position.set(0, 0.78, 0.051);
    const light = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.006, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    light.rotation.x = Math.PI / 2;
    light.position.y = 0.245;
    r.add(base, skirt, mast, head, lens, light);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.19, 1.2, 96),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    r.add(ring);
    r.position.set(...this.data.start);
    // spectator marker: shown in the high Broadcast / Top views so the robot is easy to follow
    const tagEl = document.createElement("div");
    tagEl.className = "robot-tag";
    tagEl.innerHTML = "<span></span>Inspection robot";
    const tag = new CSS2DObject(tagEl);
    tag.position.set(0, 1.15, 0);
    tag.visible = false;
    r.add(tag);
    r.userData = { light, ring, tag };
    this.robot = r;
    this.root.add(r);
  }

  // walkable mask of the current plan (includes blocks), used to keep corner fillets collision-free
  setWalkable(grid) { this.walkGrid = grid; }
  isWalkable(x, z) {
    const g = this.walkGrid; if (!g) return true;
    const r = Math.floor((z - g.z0) / g.res), c = Math.floor((x - g.x0) / g.res);
    return r >= 0 && r < g.H && c >= 0 && c < g.W && g.walkableMask[r * g.W + c] === 1;
  }

  // ---------------------------------------------------------------- route + blocks
  drawRoute(waypoints) {
    this.routeGroup.clear();
    if (!waypoints?.length) return null;
    const pts = waypoints.map((p) => new THREE.Vector3(p[0], 0.03, p[2]));
    const curve = roundedPath(pts, 0.35, (x, z) => this.isWalkable(x, z));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(120, Math.round(curve.getLength() * 40)), 0.012, 6, false),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    this.routeGroup.add(tube);
    const len = curve.getLength();
    // all route dots in one instanced draw
    const n = Math.max(0, Math.floor((len - 0.3) / 0.2));
    const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(0.025, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }), Math.max(n, 1));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) { const p = curve.getPointAt((0.2 + i * 0.2) / len); dots.setMatrixAt(i, m4.compose(new THREE.Vector3(p.x, 0.02, p.z), q, one)); }
    dots.count = n;
    this.routeGroup.add(dots);
    const end = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.13, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    end.rotation.x = -Math.PI / 2;
    end.position.set(pts.at(-1).x, 0.025, pts.at(-1).z);
    this.routeGroup.add(end);
    return curve;
  }

  ghostRoute(waypoints) {
    if (!waypoints?.length) return;
    const geo = new THREE.BufferGeometry().setFromPoints(waypoints.map((p) => new THREE.Vector3(p[0], 0.025, p[2])));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x8a9099, dashSize: 0.06, gapSize: 0.06, transparent: true, opacity: 0.8 }));
    line.computeLineDistances();
    this.routeGroup.add(line);
  }

  setBlocks(blocks) {
    this.blockGroup.clear();
    for (const b of blocks) {
      const g = new THREE.Group();
      const w = b.w ?? 0.6;
      const mat = new THREE.MeshStandardMaterial({ color: 0xff9f0a, roughness: 0.6 });
      const white = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.6 });
      for (const x of [-w / 2, w / 2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.75, 12), white);
        post.position.set(x, 0.375, 0);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.03, 20), white);
        foot.position.set(x, 0.015, 0);
        g.add(post, foot);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.02), mat);
      bar.position.y = 0.62;
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(w, b.d ?? 0.5),
        new THREE.MeshBasicMaterial({ color: 0xff9f0a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      zone.rotation.x = -Math.PI / 2;
      zone.position.y = 0.012;
      g.add(bar, zone);
      g.position.set(b.x, 0, b.z);
      g.rotation.y = -(b.yaw || 0);
      this.blockGroup.add(g);
    }
  }

  showGrid(grid) {
    this.gridGroup.clear();
    const canvas = document.createElement("canvas");
    canvas.width = grid.W; canvas.height = grid.H;
    const ctx = canvas.getContext("2d"), img = ctx.createImageData(grid.W, grid.H);
    for (let i = 0; i < grid.W * grid.H; i++) {
      const k = i * 4;
      if (grid.walkableMask[i]) img.data.set([255, 255, 255, 46], k);
      else if (grid.occupiedMask[i]) img.data.set([255, 69, 58, 40], k);
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    const w = grid.W * grid.res, h = grid.H * grid.res;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    plane.rotation.x = Math.PI / 2;
    plane.scale.y = -1;
    plane.position.set(grid.x0 + w / 2, 0.008, grid.z0 + h / 2);
    this.gridGroup.add(plane);
  }
}
