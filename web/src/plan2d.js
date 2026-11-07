// 2D floor plan: the no-WebGL version of the app. Loaded by boot.js when WebGL 2 is missing, when the 3D app
// fails to start, when the GPU context is lost, or when the URL has #plan.
// It uses the same API as the 3D app (server or static), so every result is identical:
// select an asset, dispatch the robot, watch the collision-free route and the proximity reads, block an aisle,
// and read the arrival diagnosis with its cited evidence.
import { createCopilot } from "./copilot-ui.js";   // [copilot-ui]
import { api, connect } from "./api.js";
import { $, $$, esc, nice, pad, kv, cites, toast, header, diagnosisHTML } from "./ui.js";
import { icon } from "./icons.js";
import { CATEGORIES, CAT, catOf } from "./semantic.js";

const STATUS = { healthy: "#30d158", watch: "#ffd60a", degraded: "#ff9f0a", attention_required: "#ff453a" };
const RANK = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
const CRUISE = 0.6, ACCEL = 0.45;          // m/s, m/s², same as the 3D app
let COPILOT = null;                          // [copilot-ui] conversation panel (created in bind())
let NEAR = 1.2;                             // proximity radius (m); the scene payload overrides it (config/project.json)

const P = {
  data: null, grid: null, base: null, view: { k: 1, ox: 0, oy: 0 }, fitted: false,
  selected: null, hover: null, target: null, navObject: null,
  route: null, path: null, prevRoute: null, blocks: [], firstSeen: null, seenBefore: new Set(),
  robot: { x: 0, z: 0, yaw: 0, s: 0, v: 0, playing: false, dir: 1, rate: 1, done: true, arrived: false },
  diag: null, diagPromise: null, tab: "overview", lib: null,
};

export async function startPlan(reason) {
  document.body.classList.add("plan-mode");
  $("#app").innerHTML = `
<canvas class="plan" aria-label="Floor plan of the scanned room. Coloured dots are workbook assets; click one to select it."></canvas>
<div class="wordmark"><div class="eyebrow">Industrial X-Ray</div><div class="name" id="siteName">Equipment Room</div></div>
<div class="plan-banner" role="note">${icon("grid")}<span><b>Floor plan view.</b><span class="long"> ${esc(reason)} Finding equipment, the robot route and the diagnosis work here; Plan, Support, X-Ray and training need 3D graphics.</span></span><button class="link" id="try3d">Try 3D ${icon("arrow")}</button></div>
<div class="topright">
  <div class="ask">
    <label class="field">${icon("search")}<input id="ask" placeholder="Ask about the plant" autocomplete="off" aria-label="Ask the copilot"/><span class="kbd">/</span></label>
    <div class="pop hidden" id="pop"></div>
  </div>
  <button class="iconbtn" id="libBtn" title="Library" aria-label="Library">${icon("book")}</button>
</div>
<aside class="card left" id="left"></aside>
<aside class="card right" id="right"></aside>
<div class="card sheet hidden" id="sheet"></div>
<div class="dock" id="dock"></div>
<div class="plan-legend">${Object.entries(STATUS).map(([k, c]) => `<span><i style="background:${c}"></i>${nice(k)}</span>`).join("")}<span><i class="sq"></i>Drivable floor</span>${CATEGORIES.filter((c) => c.id !== "structure").map((c) => `<span><i style="border-radius:2px;background:${c.color}"></i>${c.short}</span>`).join("")}</div>
<div class="loading" id="loading"><div class="box">Starting the floor plan<div class="bar"><i></i></div></div></div>`;

  $("#try3d").onclick = () => { history.replaceState(null, "", location.pathname); location.reload(); };
  try {
    await connect();
    const [data, grid] = await Promise.all([api.scene(), api.grid()]);
    P.data = data; P.grid = grid; NEAR = data.proximity_m ?? NEAR;
    if (data.site?.name) $("#siteName").textContent = data.site.name;
    P.target = data.objects.find((o) => o.id === data.target_object_id);
    P.robot.x = data.start[0]; P.robot.z = data.start[2];
    buildBase();
    renderLeft(); renderOverview(); renderDock();
    bind();
    requestAnimationFrame(loop);
    $("#loading").style.opacity = 0; setTimeout(() => $("#loading")?.remove(), 600);
    if (/support=/.test(location.hash + location.search)) toast("This support hand-off link needs 3D graphics to open the pins and plan. Open it on a device with WebGL; the diagnosis is available here.", 9000);
    window.__plan = P;
    Object.assign(window, { __dispatch: dispatch, __block: blockAisle, __select: selectAsset, __ask: ask });
  } catch (e) {
    console.error(e);
    $("#loading .box").innerHTML = `The plant data could not be loaded.<br><span class="note">${esc(e.message)}</span>`;
  }
}

// ------------------------------------------------------------------ geometry
const cv = () => $("canvas.plan");
const W2S = (x, z) => [P.view.ox + (x - P.grid.x0) * P.view.k, P.view.oy + (z - P.grid.z0) * P.view.k];
const S2W = (sx, sy) => [P.grid.x0 + (sx - P.view.ox) / P.view.k, P.grid.z0 + (sy - P.view.oy) / P.view.k];

function buildBase() {
  const g = P.grid, c = document.createElement("canvas");
  c.width = g.W; c.height = g.H;
  const ctx = c.getContext("2d"), img = ctx.createImageData(g.W, g.H);
  for (let i = 0; i < g.W * g.H; i++) {
    const o = i * 4;
    if (g.walkableMask[i]) img.data.set([226, 232, 240, 92], o);          // drivable floor
    else if (g.occupiedMask[i]) img.data.set([74, 80, 90, 150], o);    // equipment / structure
  }
  ctx.putImageData(img, 0, 0);
  P.base = c;
}

/** Fit the room into the screen area that the cards leave free. */
function fit() {
  const c = cv(), dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  const vis = (el) => el && getComputedStyle(el).display !== "none" && !el.classList.contains("hidden");
  const L = $("#left"), R = $("#right"), D = $("#dock");
  const mobile = innerWidth <= 820;
  let x0 = 16, x1 = innerWidth - 16, y0 = mobile ? 150 : 128, y1 = innerHeight - 16;
  if (!mobile) {
    if (vis(L)) x0 = L.getBoundingClientRect().right + 16;
    if (vis(R)) x1 = R.getBoundingClientRect().left - 16;
    if (vis(D)) y1 = D.getBoundingClientRect().top - 16;
  } else {
    if (vis(R)) y1 = R.getBoundingClientRect().top - 10;
    const B = $(".plan-banner"); if (vis(B)) y1 = Math.min(y1, B.getBoundingClientRect().top - 28);
    const D2 = $("#dock"); if (vis(D2)) y0 = D2.getBoundingClientRect().bottom + 12;
  }
  const g = P.grid, wm = g.W * g.res, hm = g.H * g.res;
  const k = Math.max(4, Math.min((x1 - x0) / wm, (y1 - y0) / hm));
  P.view = { k, ox: (x0 + x1) / 2 - (wm * k) / 2, oy: (y0 + y1) / 2 - (hm * k) / 2 };
  P.fitted = true;
}

// route as a polyline with cumulative arc length
function makePath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum.at(-1) };
}
function at(path, s) {
  s = Math.max(0, Math.min(path.len, s));
  let i = 1; while (i < path.cum.length - 1 && path.cum[i] < s) i++;
  const a = path.pts[i - 1], b = path.pts[i], seg = path.cum[i] - path.cum[i - 1] || 1, u = (s - path.cum[i - 1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, yaw: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
/** For every object: the arc length at which it first comes within 1.2 m. Makes forward and reverse playback exact. */
function firstContact(path) {
  const out = new Map(), step = 0.05;
  for (let s = 0; s <= path.len + 1e-6; s += step) {
    const p = at(path, s);
    for (const o of P.data.objects) {
      if (o.kind !== "object" || out.has(o.id)) continue;
      if (Math.hypot(o.center[0] - p.x, o.center[2] - p.z) < NEAR) out.set(o.id, s);
    }
  }
  return out;
}
const seenIds = () => {
  const s = new Set(P.seenBefore);
  if (P.firstSeen) for (const [id, s0] of P.firstSeen) if (s0 <= P.robot.s) s.add(id);
  return s;
};

// ------------------------------------------------------------------ drawing
let last = performance.now(), proxClock = 0, lastSeenCount = -1;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (!P.fitted) fit();
  step(dt);
  draw(now / 1000);
  requestAnimationFrame(loop);
}

function step(dt) {
  const R = P.robot;
  if (!P.path || !R.playing) return;
  const remain = R.dir > 0 ? P.path.len - R.s : R.s;
  const cruise = CRUISE * R.rate, acc = ACCEL * R.rate;
  R.v = Math.min(cruise, R.v + acc * dt, Math.sqrt(2 * acc * Math.max(remain, 0)) + 0.04 * R.rate);
  R.s = Math.max(0, Math.min(P.path.len, R.s + R.dir * R.v * dt));
  pose();
  proxClock += dt;
  if (proxClock > 0.1) { proxClock = 0; progressUI(); }
  if (R.dir > 0 && R.s >= P.path.len - 1e-3) { R.playing = false; R.v = 0; R.done = true; progressUI(); renderDock(); if (!R.arrived) arrive(); }
  if (R.dir < 0 && R.s <= 1e-3) { R.playing = false; R.v = 0; progressUI(); renderDock(); }
}
function pose() {
  const p = at(P.path, P.robot.s);
  P.robot.x = p.x; P.robot.z = p.z;
  const ah = at(P.path, P.robot.s + 0.3);
  if (Math.hypot(ah.x - p.x, ah.z - p.z) > 1e-4) P.robot.yaw = Math.atan2(ah.z - p.z, ah.x - p.x);
}
function progressUI() {
  const u = P.path ? P.robot.s / (P.path.len || 1) : 0;
  const sc = $("#scrub"); if (sc && document.activeElement !== sc) sc.value = Math.round(u * 1000);
  const t = $("#rProg"); if (t) t.textContent = P.path ? `${P.robot.s.toFixed(1)} of ${P.path.len.toFixed(1)} m` : "";
  const n = seenIds().size;
  if (n !== lastSeenCount) { lastSeenCount = n; if (!P.cardLock && (!P.diag || !P.robot.done)) renderTransit(); }   // never replace a card the user opened
}

function draw(t) {
  const c = cv(), ctx = c.getContext("2d"), g = P.grid, k = P.view.k;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  // floor: drivable (light), occupied (grey)
  ctx.imageSmoothingEnabled = false;
  const [bx, by] = W2S(g.x0, g.z0);
  ctx.drawImage(P.base, bx, by, g.W * g.res * k, g.H * g.res * k);
  const b = P.data.bounds, [rx0, rz0] = W2S(b.min[0], b.min[2]), [rx1, rz1] = W2S(b.max[0], b.max[2]);
  ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 1; ctx.strokeRect(rx0, rz0, rx1 - rx0, rz1 - rz0);
  // 1 m scale bar
  ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fillRect(rx0, rz1 + 10, k, 2);
  ctx.font = "11px -apple-system, Segoe UI, sans-serif"; ctx.fillText("1 m", rx0 + k + 6, rz1 + 15);

  const seen = seenIds(), near = new Set();
  if (P.path) for (const o of P.data.objects) if (o.kind === "object" && Math.hypot(o.center[0] - P.robot.x, o.center[2] - P.robot.z) < NEAR) near.add(o.id);
  // object footprints (oriented frames seen from above)
  for (const o of P.data.objects) {
    if (o.kind !== "object") continue;
    const hot = o.id === P.selected?.id || o.id === P.hover?.id, isNear = near.has(o.id);
    if (!hot && !isNear && !o.asset && k < 40 && o.size[0] * o.size[2] < 0.01) continue;
    const [sx, sy] = W2S(o.center[0], o.center[2]);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(o.yaw || 0);
    // colour = what it is (same palette as the 3D semantic view and the site map)
    const col = CAT[catOf(o)].color, faint = o.center[1] - o.size[1] / 2 > 1.7 ? 0.45 : 1;   // overhead parts quieter
    if (!hot && !isNear) { ctx.fillStyle = hexA(col, 0.16 * faint); ctx.fillRect((-o.size[0] / 2) * k, (-o.size[2] / 2) * k, o.size[0] * k, o.size[2] * k); }
    ctx.strokeStyle = hot ? "rgba(255,255,255,.95)" : isNear ? "rgba(10,132,255,.9)" : hexA(col, (o.asset ? 0.75 : 0.5) * faint);
    ctx.lineWidth = hot ? 1.6 : 1;
    ctx.strokeRect((-o.size[0] / 2) * k, (-o.size[2] / 2) * k, o.size[0] * k, o.size[2] * k);
    ctx.restore();
  }
  // routes
  const line = (pts, style, w, dash) => { ctx.setLineDash(dash || []); ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineJoin = ctx.lineCap = "round"; ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = W2S(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]); };
  if (P.prevRoute) line(P.prevRoute, "rgba(160,166,176,.6)", 1.6, [5, 5]);
  if (P.path) {
    line(P.path.pts, "rgba(255,255,255,.28)", 3);
    const done = []; for (let i = 0; i < P.path.pts.length && P.path.cum[i] <= P.robot.s; i++) done.push(P.path.pts[i]);
    done.push([P.robot.x, P.robot.z]);
    line(done, "#fff", 3);
  }
  // barriers
  for (const bl of P.blocks) {
    const [sx, sy] = W2S(bl.x, bl.z);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(bl.yaw);
    ctx.fillStyle = "rgba(255,159,10,.85)"; ctx.fillRect((-bl.w / 2) * k, (-bl.d / 2) * k, bl.w * k, bl.d * k);
    ctx.restore();
  }
  // assets as status dots, target ring pulses; tags never overlap (important ones are placed first)
  const placed = [], later = [];
  for (const o of P.data.objects) {
    if (!o.asset) continue;
    const [sx, sy] = W2S(o.center[0], o.center[2]), tgt = o.id === P.target.id, sel = o.id === P.selected?.id;
    ctx.globalAlpha = seen.has(o.id) || tgt || sel || !P.path ? 1 : 0.6;
    ctx.fillStyle = STATUS[o.asset.condition_state] || "#ccc";
    ctx.beginPath(); ctx.arc(sx, sy, tgt ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    if (tgt) { ctx.strokeStyle = `rgba(255,69,58,${0.5 + 0.4 * Math.sin(t * 3)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 11 + 2 * Math.sin(t * 3), 0, Math.PI * 2); ctx.stroke(); }
    if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.stroke(); }
    if (tgt || sel || o.id === P.hover?.id) tagLabel(ctx, sx, sy, o.asset.tag, tgt, placed, true);
    else if (P.path && seen.has(o.id) && k > 34) later.push([sx, sy, o.asset.tag]);
  }
  for (const [x, y, tag] of later) tagLabel(ctx, x, y, tag, false, placed);
  // robot: proximity ring + heading arrow
  const [px, py] = W2S(P.robot.x, P.robot.z);
  ctx.strokeStyle = "rgba(10,132,255,.55)"; ctx.fillStyle = "rgba(10,132,255,.08)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(px, py, NEAR * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.translate(px, py); ctx.rotate(P.robot.yaw);
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-7, 6.5); ctx.lineTo(-4, 0); ctx.lineTo(-7, -6.5); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function hexA(hex, a) { const v = parseInt(hex.slice(1), 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; }
function tagLabel(ctx, x, y, text, hot, placed, force = false) {
  ctx.font = "500 11px ui-monospace, SF Mono, Menlo, monospace";
  const w = ctx.measureText(text).width + 12, r = [x - w / 2, y - 30, x + w / 2, y - 12];
  if (!force && placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) return;
  placed.push(r);
  ctx.fillStyle = hot ? "rgba(255,69,58,.95)" : "rgba(12,13,16,.9)";
  ctx.beginPath(); ctx.roundRect?.(x - w / 2, y - 30, w, 18, 5) ?? ctx.rect(x - w / 2, y - 30, w, 18); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(text, x - w / 2 + 6, y - 17);
}

// ------------------------------------------------------------------ picking, pan, zoom
function pickAt(sx, sy) {
  let best = null, bd = 14;
  for (const o of P.data.objects) {
    if (!o.asset) continue;
    const [x, y] = W2S(o.center[0], o.center[2]), d = Math.hypot(x - sx, y - sy);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) return best;
  const [wx, wz] = S2W(sx, sy);
  let hit = null, area = Infinity;
  for (const o of P.data.objects) {
    if (o.kind !== "object") continue;
    const dx = wx - o.center[0], dz = wz - o.center[2], c = Math.cos(-(o.yaw || 0)), s = Math.sin(-(o.yaw || 0));
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) <= o.size[0] / 2 && Math.abs(lz) <= o.size[2] / 2 && o.size[0] * o.size[2] < area) { area = o.size[0] * o.size[2]; hit = o; }
  }
  return hit;
}
function bind() {
  const c = cv(), pts = new Map();
  let down = null, pinch = null;
  c.addEventListener("pointerdown", (e) => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); down = { x: e.clientX, y: e.clientY, ox: P.view.ox, oy: P.view.oy, moved: false };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: P.view.k, ox: P.view.ox, oy: P.view.oy, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }; } });
  c.addEventListener("pointermove", (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; zoomAt(pinch.cx, pinch.cy, (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d), pinch); down && (down.moved = true); return; }
    if (down && pts.size === 1) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 5) down.moved = true;
      if (down.moved) { P.view.ox = down.ox + dx; P.view.oy = down.oy + dy; }
      return;
    }
    const h = pickAt(e.clientX, e.clientY); P.hover = h; c.style.cursor = h ? "pointer" : "grab";
  });
  const up = (e) => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (down && !down.moved && pts.size === 0) { const o = pickAt(e.clientX, e.clientY); if (o) selectObject(o); }
    if (pts.size === 0) down = null;
  };
  c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  c.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  c.addEventListener("dblclick", () => fit());
  addEventListener("resize", () => fit());

  $("#left").addEventListener("click", (e) => {
    if (e.target.closest("[data-min-card]")) return;
    const r = e.target.closest("[data-asset]"); if (r) selectAsset(r.dataset.asset);
  });
  $("#right").addEventListener("click", onCard);
  $("#dock").addEventListener("click", onDock);
  $("#dock").addEventListener("input", (e) => {
    if (e.target.id !== "scrub" || !P.path) return;
    P.robot.playing = false; P.robot.v = 0;
    P.robot.s = (e.target.value / 1000) * P.path.len; pose(); progressUI(); renderDock(true);
    if (P.robot.s >= P.path.len - 1e-3 && !P.robot.arrived) { P.robot.done = true; arrive(); }
  });
  document.addEventListener("click", (e) => {
    const m = e.target.closest("[data-min-card]"); if (m) { m.closest(".card").classList.toggle("min"); setTimeout(fit, 0); return; }
    const c2 = e.target.closest(".cite, [data-docid]"); if (c2) showDoc(c2.dataset.doc || c2.dataset.docid);
    if (e.target.closest("[data-close-sheet]")) $("#sheet").classList.add("hidden");
    if (e.target.closest("[data-xcomp]")) toast("The X-Ray view needs 3D graphics. The component list is shown instead.");
  });
  $("#libBtn").onclick = () => openLibrary();
  // ask
  const pop = $("#pop"), askIn = $("#ask");
  // [copilot-ui] conversation panel shared with the 3D view (copilot-ui.js); this file only runs the actions
  COPILOT = createCopilot({ pop, input: askIn, api: () => api, selected: () => P.selected?.asset || P.diag?.asset,
    assetById: (id) => id && P.data?.objects.find((o) => o.asset?.asset_id === id)?.asset, run: runAskActions });
  document.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === "/") { e.preventDefault(); askIn.focus(); }
    if (e.key === " " && P.path) { e.preventDefault(); togglePlay(); }
    if (e.key === "Escape") { $("#sheet").classList.add("hidden"); pop.classList.add("hidden"); }
  });
}
function zoomAt(sx, sy, f, base = null) {
  const v = base || P.view, k = Math.max(4, Math.min(400, v.k * f)), r = k / v.k;
  P.view = { k, ox: sx - (sx - v.ox) * r, oy: sy - (sy - v.oy) * r };
}

// ------------------------------------------------------------------ cards
const card = (html) => { $("#right").innerHTML = html; $("#right").querySelector(".card-b")?.scrollTo?.(0, 0); };
function renderLeft() {
  const assets = P.data.objects.filter((o) => o.asset).map((o) => o.asset)
    .sort((a, b) => (b.is_target - a.is_target) || RANK[a.condition_state] - RANK[b.condition_state] || a.health_score - b.health_score);
  $("#left").innerHTML = `
    <div class="card-h"><span class="t">Assets by priority</span><span class="card-tools"><span class="note">${assets.length}</span><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b" style="padding:0 8px 8px">${assets.map((a, i) => `
      <button class="list-row ${P.selected?.asset?.asset_id === a.asset_id ? "on" : ""}" data-asset="${a.asset_id}">
        <span class="n">${pad(i + 1)}</span>
        <span class="nm"><b>${a.tag}</b><small>${nice(a.asset_class)} · ${a.is_target ? "Simulated fault" : nice(a.issue_code)}</small></span>
        <span class="health s-${a.condition_state}">${a.health_score}</span></button>`).join("")}</div>`;
}
const withMin = (html) => html;          // header() already carries the minimise button

function renderOverview() {
  const t = P.target.asset;
  card(withMin(`${header("Simulated fault", t.tag, '<span class="tag syn">Synthetic</span>')}
    <div class="sub">${nice(t.asset_class)} · ${esc(t.area_name)}</div>
    <p class="p" style="margin-top:12px">${esc(t.issue_summary)}. Prepare the visit before you travel: find the pump, check the route in, and read the cited diagnosis.</p>
    ${kv("Condition", `<span class="status s-${t.condition_state}">${nice(t.condition_state)}</span>`)}${kv("Health", t.health_score)}${kv("Criticality", esc(t.criticality))}
    ${kv("Mapped to", `${esc(P.target.label)} · ${Math.round(t.mapping_confidence * 100)}% (procedural link)`)}
    <div class="section stack"><button class="btn primary block" data-act="dispatch">${icon("play")}Send inspection robot</button></div>
    <div class="section"><div class="label">How to read the plan</div>
      <div class="step"><span class="k">1</span><span>You are looking down on the scanned room. Light grey is floor the robot can drive on; darker grey is equipment.</span></div>
      <div class="step"><span class="k">2</span><span>Outlines are the ${P.data.stats.n_objects} object candidates found in the scan. Coloured dots are workbook assets; the pulsing ring is the faulty one.</span></div>
      <div class="step"><span class="k">3</span><span>The white arrow is the robot. The blue circle is the ${NEAR} m range in which it reads nearby assets.</span></div></div>
  </div>`));
}
function renderTransit() {
  if (!P.path || !P.navObject) return;
  const seen = seenIds(), assets = [...seen].map((id) => P.data.objects.find((o) => o.id === id)).filter((o) => o?.asset);
  const v = P.route.validation;
  card(withMin(`${header(P.robot.done && P.robot.arrived ? "Arrived" : "En route", P.navObject.asset.tag, "")}
    <div class="sub">${P.route.length_m} m · ${v.collision_free ? "collision-free" : "check route"} · min clearance ${v.min_clearance_m} m</div>
    <div class="section"><div class="label"><span>Assets read along the way</span><span>${assets.length}</span></div>
      <div class="feed">${assets.map((o) => `<button class="list-row" data-obj="${o.id}"><span class="dot s-${o.asset.condition_state}"></span>
        <span class="nm"><b style="font-family:var(--mono)">${o.asset.tag}</b><small>${nice(o.asset.condition_state)} · ${nice(o.asset.issue_code)}</small></span><span class="health s-${o.asset.condition_state}">${o.asset.health_score}</span></button>`).join("") || '<div class="note">Nothing in range yet.</div>'}</div></div>
    <div class="section note">${seen.size} objects framed within ${NEAR} m so far.</div>
    ${P.diag ? `<div class="section"><button class="btn block" data-act="result">${icon("spark")}Show the diagnosis</button></div>` : ""}</div>`));
}
function renderAsset(o) {
  const a = o.asset;
  const ident = `${kv("Label", `${esc(o.label)} · ${Math.round(o.confidence * 100)}%`)}${kv("Source", { "vlm+geometry": "Vision model + geometry", "review-corrected": "Review-corrected (team visual check, not field-verified)", "geometry-heuristic": "Geometry rules" }[o.label_source] || esc(o.label_source))}${kv("Frame", `${o.size.map((v) => v.toFixed(2)).join(" × ")} m`)}`;
  if (!a) return card(withMin(`${header(nice(o.category), esc(o.label), "", true)}<div class="sub">Scene object · not linked to a workbook asset</div><div class="section">${ident}</div></div>`));
  card(withMin(`${header(nice(a.asset_class), a.tag, '<span class="tag syn">Synthetic</span>', true)}
    <div class="sub"><span class="status s-${a.condition_state}">${nice(a.condition_state)}</span> · ${esc(a.issue_summary)}</div>
    <div class="section">${kv("Health", a.health_score)}${kv("Criticality", esc(a.criticality))}${kv("Area", esc(a.area_name))}</div>
    <div class="section"><div class="label">3D identity</div>${ident}${kv("Link to workbook asset", `${Math.round(a.mapping_confidence * 100)}% · procedural, not field-verified`)}</div>
    <div class="section stack"><button class="btn primary block" data-act="dispatch-sel">${icon("play")}Send robot here</button>
      <button class="btn block" data-act="diagnose-sel">${icon("spark")}Diagnose now</button>
      <button class="btn block" data-act="parts-sel">${icon("layers")}List its components</button></div></div>`));
}
function renderDiagnosis() {
  card(withMin(`${diagnosisHTML(P.diag, P.tab, { xray: false, actions: `<button class="btn primary" data-act="wo">${icon("doc")}Draft work order</button><button class="btn" data-act="parts">${icon("layers")}Suspect parts</button>` })}
    <p class="note" style="margin-top:10px;text-align:center">Decision support only. No control actions.</p></div>`));
}
async function renderParts(assetId) {
  P.cardLock = true;
  P.lib = P.lib || (await api.xrayModel());
  const o = P.data.objects.find((x) => x.asset?.asset_id === assetId), a = o.asset, lib = P.lib.classes[a.asset_class];
  if (!lib) return toast(`No component model for ${nice(a.asset_class)} yet.`);
  const d = P.diag?.asset?.asset_id === assetId ? P.diag : await api.diagnose(assetId);
  const lead = new Set(d.hypotheses[0]?.components || []), alt = new Set(d.hypotheses.slice(1).flatMap((h) => h.components));
  card(withMin(`${header("Components", esc(lib.label), '<span class="tag">Illustrative</span>', true)}
    <div class="sub">${a.tag} · ${nice(a.condition_state)}</div><p class="p" style="margin-top:10px">${esc(lib.function)}</p>
    ${lib.components.map((c, i) => `<div class="step"><span class="k">${i + 1}</span><span><b style="color:var(--text);font-weight:500">${esc(c.name)}</b>
      ${lead.has(c.id) ? '<span class="pill red">Suspected</span>' : alt.has(c.id) ? '<span class="pill amber">Alternative</span>' : ""}<br>${esc(c.function)}
      <span class="cite" data-doc="KB-XRAY-${a.asset_class}#${c.id}">Training note</span></span></div>`).join("")}
    <p class="note">The exploded 3D model needs WebGL. ${esc(P.lib.provenance || "")}</p></div>`));
}
async function onCard(e) {
  const t = e.target;
  const tab = t.closest("[data-tab]"); if (tab) { P.tab = tab.dataset.tab; return renderDiagnosis(); }
  if (t.closest("[data-close-card]")) { P.cardLock = false; P.selected = null; renderLeft(); return P.diag && P.robot.arrived ? renderDiagnosis() : P.path ? renderTransit() : renderOverview(); }
  const row = t.closest("[data-obj]"); if (row) return selectObject(P.data.objects.find((o) => o.id === row.dataset.obj));
  const act = t.closest("[data-act]")?.dataset.act;
  if (act === "dispatch") restart(P.target.asset.asset_id);
  if (act === "dispatch-sel") restart(P.selected.asset.asset_id);
  if (act === "diagnose-sel") { P.cardLock = true; P.diag = await api.diagnose(P.selected.asset.asset_id); P.tab = "overview"; renderDiagnosis(); }
  if (act === "parts-sel") renderParts(P.selected.asset.asset_id);
  if (act === "parts") renderParts(P.diag.asset.asset_id);
  if (act === "result") renderDiagnosis();
  if (act === "wo") showWorkOrder(P.diag.asset.asset_id);
}

// ------------------------------------------------------------------ selection
function selectAsset(id) { const o = P.data.objects.find((x) => x.asset?.asset_id === id); if (o) selectObject(o); }
function selectObject(o) {
  if (!o) return;
  P.selected = o; renderLeft();
  if (!P.robot.playing) renderAsset(o);
}

// ------------------------------------------------------------------ dock: dispatch, block, play / reverse / scrub, speed
function renderDock(keepScrub = false) {
  const R = P.robot, r = P.route, active = !!P.path;
  if (keepScrub && $("#scrub")) { $("#playBtn").innerHTML = `${icon(R.playing ? "pause" : "play")}${R.playing ? "Pause" : "Play"}`; return; }
  $("#dock").innerHTML = `
    <div class="grp"><button class="tool" data-d="dispatch">${icon("play")}${active ? "Restart" : "Dispatch"}</button>
      <button class="tool" data-d="block" ${active && !R.done ? "" : "disabled"}>${icon("barrier")}Block aisle</button></div>
    <div class="grp"><button class="tool" id="playBtn" data-d="play" ${active ? "" : "disabled"}>${icon(R.playing ? "pause" : "play")}${R.playing ? "Pause" : "Play"}</button>
      <button class="tool ${R.dir < 0 && R.playing ? "on" : ""}" data-d="reverse" ${active ? "" : "disabled"}>${icon("rewind")}Reverse</button></div>
    <div class="grp routeinfo"><div class="top"><span>Route</span><b>${r ? r.length_m + " m" : "Not planned"}</b></div>
      <input type="range" id="scrub" min="0" max="1000" value="${active ? Math.round((R.s / P.path.len) * 1000) : 0}" ${active ? "" : "disabled"} aria-label="Route progress"/>
      <small>${r ? `<span id="rProg"></span> · A* ${r.compute_ms} ms · clearance ${r.validation.min_clearance_m} m · ${r.validation.collisions} collisions` : `Robot radius ${P.data.navigation.robot_radius_m} m · step limit ${P.data.navigation.max_step_m} m`}</small></div>
    <div class="grp"><div class="seg" role="group" aria-label="Speed">${[1, 2, 4].map((v) => `<button data-rate="${v}" class="${R.rate === v ? "on" : ""}">${v}×</button>`).join("")}</div></div>`;
  progressUI();
}
function togglePlay() {
  const R = P.robot;
  if (!P.path) return;
  if (!R.playing && R.dir > 0 && R.s >= P.path.len - 1e-3) R.s = 0;        // replay from the start
  R.playing = !R.playing; if (R.playing) { R.done = false; }
  renderDock();
}
async function onDock(e) {
  const rt = e.target.closest("[data-rate]"); if (rt) { P.robot.rate = +rt.dataset.rate; return renderDock(); }
  const d = e.target.closest("[data-d]")?.dataset.d; if (!d) return;
  const R = P.robot;
  if (d === "dispatch") restart((P.selected?.asset || P.target.asset).asset_id);
  if (d === "block") blockAisle();
  if (d === "play") { R.dir = 1; togglePlay(); }
  if (d === "reverse") { if (R.playing && R.dir < 0) R.playing = false; else { R.dir = -1; R.playing = R.s > 1e-3; R.done = false; } renderDock(); }
}

// ------------------------------------------------------------------ navigation
function restart(assetId) {
  P.blocks = []; P.prevRoute = null; P.seenBefore = new Set();
  P.robot.x = P.data.start[0]; P.robot.z = P.data.start[2];
  return dispatch(assetId);
}
async function applyRoute(res) {
  P.route = res;
  P.grid = await api.grid(); buildBase();          // the grid now includes any barriers
  const w0 = res.waypoints[0], pts = res.waypoints.map((w) => [w[0], w[2]]);
  if (Math.hypot(P.robot.x - w0[0], P.robot.z - w0[2]) > 0.005) pts.unshift([P.robot.x, P.robot.z]);
  P.path = makePath(pts);
  P.firstSeen = firstContact(P.path);
  Object.assign(P.robot, { s: 0, playing: true, dir: 1, done: false });
  lastSeenCount = -1;
  renderDock();
}
export async function dispatch(assetId) {
  const o = P.data.objects.find((x) => x.asset?.asset_id === assetId);
  if (!o) return null;
  P.navObject = o; P.diag = null; P.cardLock = false; P.robot.arrived = false; P.robot.v = 0;
  const res = await api.plan({ object_id: o.id, start: [P.robot.x, P.robot.z], blocks: P.blocks });
  if (!res.ok) { toast(esc(res.reason)); return null; }
  await applyRoute(res);
  P.diagPromise = api.diagnose(assetId);
  toast(`Route planned: <b>${res.length_m} m</b> in ${res.compute_ms} ms. Collision-free, minimum clearance ${res.validation.min_clearance_m} m.`);
  renderTransit();
  return res;
}
async function blockAisle() {
  if (!P.path || P.robot.done) return;
  const prev = P.path, prevLeft = prev.len - P.robot.s, start = [P.robot.x, P.robot.z];
  const v = P.robot.v; P.robot.playing = false;                    // hold still while re-planning
  let best = null;
  for (const ahead of [0.9, 1.5, 2.2, 3.0, 3.8, 4.6]) {
    const s = P.robot.s + ahead;
    if (s > prev.len - 0.6) break;
    const p = at(prev, s);
    const b = { x: +p.x.toFixed(2), z: +p.z.toFixed(2), w: 0.9, d: 0.35, yaw: p.yaw + Math.PI / 2 };
    const res = await api.plan({ object_id: P.navObject.id, start, blocks: [...P.blocks, b] });
    if (res.ok && (!best || res.length_m > best.res.length_m)) best = { b, res };
    if (best && best.res.length_m - prevLeft > 0.8) break;
  }
  if (best) {
    P.blocks.push(best.b);
    const res = await api.plan({ object_id: P.navObject.id, start, blocks: P.blocks });
    P.prevRoute = prev.pts;
    P.seenBefore = seenIds();
    await applyRoute(res); P.robot.v = v;
    renderTransit();
    const extra = res.length_m - prevLeft;
    toast(`Aisle blocked. New collision-free route in <b>${res.compute_ms} ms</b>: ${res.length_m} m to go${extra > 0.05 ? `, a ${extra.toFixed(1)} m detour` : ", squeezing past the barrier"}.`, 6000);
    return;
  }
  P.robot.playing = false;
  toast("No safe detour exists from here. The robot has stopped and is waiting.", 6000);
  renderDock();
}
async function arrive() {
  P.robot.arrived = true;
  P.selected = P.navObject; renderLeft();
  toast(`Arrived at <b>${P.navObject.asset.tag}</b>. Diagnosis ready.`);
  P.diag = await P.diagPromise; P.tab = "overview";
  $("#right").classList.remove("min");
  renderDiagnosis();
}

// ------------------------------------------------------------------ ask
export function ask(q) { return COPILOT?.ask(q); }
async function runAskActions(r) {
    for (const a of r.actions || []) {
      if (a.type === "select") selectAsset(a.asset_id);
      if (a.type === "select_object") selectObject(P.data.objects.find((o) => o.id === a.object_id));
      if (a.type === "navigate") await restart(a.asset_id);
      if (a.type === "xray") await renderParts(a.asset_id || P.selected?.asset?.asset_id || P.target.asset.asset_id);
      if (a.type === "knowledge") openLibrary(a.query || "");
      if (a.type === "diagnose") { P.cardLock = true; P.diag = await api.diagnose(a.asset_id); P.tab = "overview"; $("#right").classList.remove("min"); renderDiagnosis(); }
      if (a.type === "learn" || a.type === "practice") toast("Learn and Practice use the 3D model. Try the 3D view on a device with WebGL.");
    }
}

// ------------------------------------------------------------------ library, documents, work order
function sheet(head, body) {
  $("#sheet").innerHTML = `<div class="card-h"><span class="t">${head}</span><button class="link" data-close-sheet aria-label="Close">${icon("close")}</button></div><div class="card-b">${body}</div>`;
  $("#sheet").classList.remove("hidden");
}
async function openLibrary(q = "") {
  sheet("Library", `<input class="search" id="libQ" placeholder="Search manuals, asset cards and service cases" value="${esc(q)}"/><div id="libRes" style="margin-top:8px"></div>`);
  const run = async () => {
    const res = await api.search($("#libQ").value);
    $("#libRes").innerHTML = res.map((d) => `<button class="doc" data-docid="${esc(d.id)}"><span class="k">${nice(d.kind)}</span><code>${esc(d.id)}</code><p>${esc(d.title)} · ${esc(d.text.slice(0, 120))}…</p></button>`).join("") || '<p class="note">No matches.</p>';
  };
  $("#libQ").onkeydown = (e) => e.key === "Enter" && run();
  run();
}
async function showDoc(id) {
  if (/^(EVT|WO|DQ)-/.test(id)) return toast(`${esc(id)} is listed under Evidence in the diagnosis.`);
  if (id === "Telemetry_Sample_3d") return toast("Telemetry_Sample_3d is the 30-minute synthetic telemetry stream in the builder pack.");
  try {
    const d = await api.doc(id);
    sheet(esc(d.id), `<div class="h1" style="font-size:17px">${esc(d.title)}</div><div class="sub">${nice(d.kind)} · ${esc(d.source)}</div><p class="p" style="margin-top:12px;color:var(--text)">${esc(d.text)}</p>`);
  } catch { toast(`${esc(id)} is a workbook record.`); }
}
async function showWorkOrder(id) {
  const w = await api.draftWO(id);
  sheet("Work order draft", `<div class="h1" style="font-size:17px">${w.tag} · ${esc(nice(w.action))}</div><div class="sub">${esc(w.status)} · no control actions</div>
    <div class="section">${kv("Problem", esc(w.problem))}${kv("Type", nice(w.maintenance_type))}${kv("Priority", nice(w.priority))}${kv("Role", nice(w.role))}${kv("Confidence", Math.round(w.confidence * 100) + "%")}</div>
    <div class="section"><div class="label">Evidence</div><div class="row">${w.evidence_ids.map((i) => `<span class="cite" data-doc="${i}">${i}</span>`).join("")}</div></div>
    <div class="section"><div class="label">Before any work</div>${w.safety_prerequisites.map((s) => `<label class="gate"><input type="checkbox"/> ${esc(s)}</label>`).join("")}</div>`);
}
