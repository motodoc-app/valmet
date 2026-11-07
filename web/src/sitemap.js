// Site map: an overhead semantic floor plan drawn on a 2D canvas (no WebGL). Used by the "Site map" sheet in the
// 3D app (layers.js) and for the downloadable PNG. Orientation matches the Top camera and the mini-map:
// screen right = +x, screen down = +z, so "up" on the plan is the scan's -z axis.
import { CATEGORIES, CAT, CONDITION, catOf, isUncertain } from "./semantic.js";

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const OVERHEAD = 1.7;            // metres: objects whose underside is above this are drawn as dashed outlines

const rgba = (hex, a) => { const v = parseInt(hex.slice(1), 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; };
const overhead = (o) => o.center[1] - o.size[1] / 2 > OVERHEAD;
const corners = (o) => {
  const c = Math.cos(o.yaw || 0), s = Math.sin(o.yaw || 0), hx = Math.max(o.size[0], 0.03) / 2, hz = Math.max(o.size[2], 0.03) / 2;
  // same yaw convention as the 3D frames: world = centre + (lx·c − lz·s, lx·s + lz·c)
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => [o.center[0] + x * c - z * s, o.center[2] + x * s + z * c]);
};

let _floor = null;
function floorImage(grid) {
  if (_floor?.grid === grid) return _floor.c;
  const c = document.createElement("canvas"); c.width = grid.W; c.height = grid.H;
  const g = c.getContext("2d"), img = g.createImageData(grid.W, grid.H);
  for (let i = 0; i < grid.W * grid.H; i++) {
    if (grid.walkableMask[i]) img.data.set([226, 232, 240, 34], i * 4);
    else if (grid.occupiedMask[i]) img.data.set([120, 128, 140, 40], i * 4);
  }
  g.putImageData(img, 0, 0);
  _floor = { grid, c };
  return c;
}

/**
 * Draw the plan into `ctx` in CSS pixels (the caller sets any device-pixel scale).
 * opt: { data, grid, w, h, hover, showUncertain, title }  → returns the view transform used by pickSiteMap().
 */
export function drawSiteMap(ctx, opt) {
  const { data, grid, w, h, hover = null, showUncertain = false, title = false } = opt;
  const legendW = w >= 560 ? 186 : 0, top = title ? 54 : 12, bottom = 44;
  const b = data.bounds, rw = b.max[0] - b.min[0], rh = b.max[2] - b.min[2];
  const mapW = w - legendW - 28, mapH = h - top - bottom;
  const k = Math.min(mapW / rw, mapH / rh);
  const ox = 14 + (mapW - rw * k) / 2, oy = top + (mapH - rh * k) / 2;
  const X = (x) => ox + (x - b.min[0]) * k, Y = (z) => oy + (z - b.min[2]) * k;
  const view = { k, ox, oy, x0: b.min[0], z0: b.min[2] };

  ctx.save();
  ctx.fillStyle = "#0d0e11"; ctx.fillRect(0, 0, w, h);
  if (title) {
    ctx.fillStyle = "#f2f3f5"; ctx.font = `500 15px ${FONT}`; ctx.fillText(`${data.site?.name || "Equipment room"} · semantic floor plan`, 16, 26);
    ctx.fillStyle = "#6c727b"; ctx.font = `11px ${FONT}`;
    ctx.fillText(`${data.stats?.n_objects ?? ""} objects recognised in the scan · asset data synthetic · generated ${new Date().toISOString().slice(0, 10)}`, 16, 43);
  }
  // drivable floor and occupied cells from the navigation grid
  if (grid) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(floorImage(grid), X(grid.x0), Y(grid.z0), grid.W * grid.res * k, grid.H * grid.res * k);
  }
  ctx.strokeStyle = "rgba(255,255,255,.10)"; ctx.lineWidth = 1; ctx.strokeRect(X(b.min[0]), Y(b.min[2]), rw * k, rh * k);
  const poly = (o) => { const p = corners(o); ctx.beginPath(); p.forEach(([x, z], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(x), Y(z))); ctx.closePath(); };
  // walls
  for (const o of data.objects) {
    if (o.kind !== "structure") continue;
    poly(o); ctx.fillStyle = "#c9ced6"; ctx.fill();
    ctx.strokeStyle = "#c9ced6"; ctx.lineWidth = 2.5; ctx.stroke();
  }
  // footprints: big first so small parts stay on top; overhead parts as dashed outlines
  const objs = data.objects.filter((o) => o.kind === "object").sort((a, c) => c.size[0] * c.size[2] - a.size[0] * a.size[2]);
  for (const o of objs) {
    if (!overhead(o)) continue;
    const col = CAT[catOf(o)].color;
    poly(o); ctx.setLineDash([3, 3]); ctx.strokeStyle = rgba(col, 0.4); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  for (const o of objs) {
    if (overhead(o)) continue;
    const unc = showUncertain && isUncertain(o), col = unc ? "#f2f3f5" : CAT[catOf(o)].color;
    poly(o);
    ctx.fillStyle = rgba(col, unc ? 0.16 : catOf(o) === "unknown" ? 0.28 : 0.42); ctx.fill();
    ctx.strokeStyle = rgba(col, unc ? 0.9 : 0.85); ctx.lineWidth = 1; if (unc) ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
  }
  if (hover) { poly(hover); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
  // robot dock (start position)
  const [sx, sy] = [X(data.start[0]), Y(data.start[2])];
  ctx.strokeStyle = "#f2f3f5"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#f2f3f5"; ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.font = `10px ${FONT}`; ctx.fillStyle = "#a3a8b0"; ctx.fillText("Robot dock", sx + 9, sy + 3.5);
  // assets: condition dots and tags (target first, then by priority; tags never overlap)
  const tgt = data.objects.find((o) => o.id === data.target_object_id);
  const RANK = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
  const assets = data.objects.filter((o) => o.asset).sort((a, c) => (c === tgt) - (a === tgt) || RANK[a.asset.condition_state] - RANK[c.asset.condition_state]);
  const placed = [[sx + 6, sy - 6, sx + 70, sy + 8]];
  for (const o of assets) {
    const x = X(o.center[0]), y = Y(o.center[2]);
    ctx.fillStyle = CONDITION[o.asset.condition_state] || "#ccc"; ctx.strokeStyle = "#0d0e11"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, o === tgt ? 5.5 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    placed.push([x - 5, y - 5, x + 5, y + 5]);
  }
  for (const o of assets) {
    const x = X(o.center[0]), y = Y(o.center[2]), isT = o === tgt;
    if (isT) { ctx.strokeStyle = "#ff453a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke(); }
    const text = isT ? `${o.asset.tag} · simulated fault` : o.asset.tag;
    ctx.font = `500 ${isT ? 11 : 9.5}px ${MONO}`;
    const tw = ctx.measureText(text).width + 10, th = isT ? 18 : 15;
    // try right, left, above, below
    const spots = [[x + 9, y - th / 2], [x - 9 - tw, y - th / 2], [x - tw / 2, y - 12 - th], [x - tw / 2, y + 12]];
    const mapR = w - legendW - 6;
    const spot = spots.find(([l, t]) => l >= 4 && l + tw <= mapR && t >= top - 8 && !placed.some((q) => l < q[2] && l + tw > q[0] && t < q[3] && t + th > q[1]));
    if (!spot && !isT) continue;
    const [l, t] = spot || spots[2];
    placed.push([l, t, l + tw, t + th]);
    ctx.fillStyle = isT ? "rgba(255,69,58,.95)" : "rgba(12,13,16,.86)";
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(l, t, tw, th, 4) : ctx.rect(l, t, tw, th); ctx.fill();
    ctx.fillStyle = isT ? "#fff" : "#d6d9de"; ctx.fillText(text, l + 5, t + th - (isT ? 5 : 4.2));
  }
  // scale bar (0 · 1 · 2 m) and north arrow
  const by = h - bottom + 22, bx = ox;
  ctx.strokeStyle = "#a3a8b0"; ctx.fillStyle = "#a3a8b0"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + 2 * k, by); ctx.stroke();
  ctx.font = `10px ${FONT}`;
  for (let m = 0; m <= 2; m++) { ctx.beginPath(); ctx.moveTo(bx + m * k, by - 4); ctx.lineTo(bx + m * k, by + 1); ctx.stroke(); ctx.fillText(m === 2 ? "2 m" : String(m), bx + m * k - 3, by + 13); }
  ctx.fillStyle = "#6c727b"; ctx.fillText(`Room ${rw.toFixed(1)} × ${rh.toFixed(1)} m`, bx + 2 * k + 22, by + 4);
  const nx = ox + rw * k - 14, ny = oy + 8;
  ctx.fillStyle = "#f2f3f5"; ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(nx + 6, ny + 16); ctx.lineTo(nx, ny + 12); ctx.lineTo(nx - 6, ny + 16); ctx.closePath(); ctx.fill();
  ctx.font = `600 10px ${FONT}`; ctx.fillText("N", nx - 3.5, ny + 28);
  ctx.font = `9px ${FONT}`; ctx.fillStyle = "#6c727b"; ctx.fillText("scan −z", nx - 16, ny + 39);
  // legend
  if (legendW) {
    let lx = w - legendW + 4, ly = top + 6;
    const head = (t) => { ctx.fillStyle = "#6c727b"; ctx.font = `10px ${FONT}`; ctx.fillText(t.toUpperCase(), lx, ly + 8); ly += 18; };
    const row = (draw, label, n) => {
      draw(lx, ly); ctx.fillStyle = "#c9ced6"; ctx.font = `11px ${FONT}`; ctx.fillText(label, lx + 20, ly + 9);
      if (n !== undefined) { ctx.fillStyle = "#6c727b"; ctx.textAlign = "right"; ctx.fillText(String(n), w - 14, ly + 9); ctx.textAlign = "left"; }
      ly += 17;
    };
    const counts = {}; let unc = 0;
    for (const o of objs) { counts[catOf(o)] = (counts[catOf(o)] || 0) + 1; if (isUncertain(o)) unc++; }
    head("What it is");
    for (const c of CATEGORIES) {
      if (!counts[c.id]) continue;
      row((x, y) => { ctx.fillStyle = rgba(c.color, 0.45); ctx.fillRect(x, y, 12, 10); ctx.strokeStyle = c.color; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, 11, 9); }, c.label, counts[c.id]);
    }
    if (showUncertain) row((x, y) => { ctx.setLineDash([2, 2]); ctx.strokeStyle = "#f2f3f5"; ctx.strokeRect(x + 0.5, y + 0.5, 11, 9); ctx.setLineDash([]); }, "Uncertain label", unc);
    ly += 8; head("Condition (assets)");
    for (const [s, col] of Object.entries(CONDITION)) row((x, y) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 6, y + 5, 4, 0, Math.PI * 2); ctx.fill(); }, s === "attention_required" ? "Attention required" : s[0].toUpperCase() + s.slice(1));
    ly += 8; head("Symbols");
    row((x, y) => { ctx.fillStyle = "rgba(226,232,240,.3)"; ctx.fillRect(x, y, 12, 10); }, "Drivable floor");
    row((x, y) => { ctx.fillStyle = "#c9ced6"; ctx.fillRect(x, y + 3, 12, 4); }, "Wall");
    row((x, y) => { ctx.setLineDash([3, 3]); ctx.strokeStyle = "#a3a8b0"; ctx.strokeRect(x + 0.5, y + 0.5, 11, 9); ctx.setLineDash([]); }, `Overhead (> ${OVERHEAD} m)`);
    row((x, y) => { ctx.strokeStyle = "#ff453a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + 6, y + 5, 5, 0, Math.PI * 2); ctx.stroke(); }, "Simulated fault");
    row((x, y) => { ctx.strokeStyle = "#f2f3f5"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x + 6, y + 5, 4.5, 0, Math.PI * 2); ctx.stroke(); }, "Robot dock");
  }
  ctx.restore();
  return view;
}

/** Object under a canvas point: asset dots first (10 px), then the smallest footprint containing the point. */
export function pickSiteMap(data, view, sx, sy) {
  const X = (x) => view.ox + (x - view.x0) * view.k, Y = (z) => view.oy + (z - view.z0) * view.k;
  let best = null, bd = 10;
  for (const o of data.objects) {
    if (!o.asset) continue;
    const d = Math.hypot(X(o.center[0]) - sx, Y(o.center[2]) - sy);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) return best;
  const wx = view.x0 + (sx - view.ox) / view.k, wz = view.z0 + (sy - view.oy) / view.k;
  let hit = null, score = Infinity;
  for (const o of data.objects) {
    if (o.kind !== "object") continue;
    const dx = wx - o.center[0], dz = wz - o.center[2], c = Math.cos(o.yaw || 0), s = Math.sin(o.yaw || 0);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;          // inverse of the yaw used in corners()
    if (Math.abs(lx) > Math.max(o.size[0], 0.03) / 2 + 0.02 || Math.abs(lz) > Math.max(o.size[2], 0.03) / 2 + 0.02) continue;
    const a = o.size[0] * o.size[2] * (overhead(o) ? 4 : 1);      // prefer what stands on the floor
    if (a < score) { score = a; hit = o; }
  }
  return hit;
}
