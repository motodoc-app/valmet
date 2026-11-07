// Robot POV, in-scene X-Ray panel and arrival prompt, in a real (headless) Chromium. Run after `npm run build`:
//   node tests/e2e-pov-xray.mjs                       static build (starts its own vite preview)
//   BASE=http://localhost:4537/ node tests/e2e-pov-xray.mjs
// The page runs in ?capture&scan=off: frames render only on window.__step(dt) with a fixed time step, so camera and
// robot poses can be compared exactly, independent of the machine's speed.
// Covers: POV follows the robot's position and heading through a turn (smooth, above the floor, no NaN, small near
// plane, robot body hidden, HUD labelled as simulated); every camera mode mid-route / paused / reversing / scrubbed
// leaves progress and motion untouched; asset card → X-Ray panel opens the right class model (pump, motor, valve)
// over the still-rendered room; explode slider, list and click-to-select work; Esc / × restore the exact camera pose,
// mode, robot state and selection; the arrival prompt appears and opens the panel; phone layout; frame cost.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require("playwright"); } catch { return require("@playwright/test"); } })();

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || path.join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond, info]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4500 + Math.floor(Math.random() * 99);
  // static mode unless told otherwise: a stray API server on :8000 must not change what is tested
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe", env: { ...process.env, XRAY_API: process.env.XRAY_API || "http://127.0.0.1:9" } });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);

async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p.setDefaultNavigationTimeout(120000); p.setDefaultTimeout(60000);
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(BASE + "?capture&scan=off&noguide&qa", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.xo && !document.querySelector("#loading"), null, { timeout: 120000, polling: 250 });
  await p.evaluate(() => { document.querySelector(".toast")?.remove(); document.querySelector(".gd-coach")?.remove(); });
  return p;
}
const step = (p, n = 1, dt = 1 / 30) => p.evaluate(([n, dt]) => { for (let i = 0; i < n; i++) window.__step(dt); }, [n, dt]);
/** Step frames until fn() is true (or give up). */
const stepUntil = (p, fn, max = 900, dt = 1 / 30) => p.evaluate(([src, max, dt]) => {
  const f = new Function(`return (${src})()`);
  for (let i = 0; i < max; i++) { if (f()) return true; window.__step(dt); }
  return f();
}, [fn.toString(), max, dt]);
const pose = (p) => p.evaluate(() => {
  const A = window.__xr, S = A.S, c = A.camera, r = S.fac.robot, d = new A.THREE.Vector3(); c.getWorldDirection(d);
  return { cam: S.cam, p: c.position.toArray(), t: A.controls.target.toArray(), dir: d.toArray(), near: c.near, fov: c.fov,
    rp: r.position.toArray(), ry: r.rotation.y, s: S.robot.s, len: S.robot.len, moving: S.robot.moving, dir_: S.robot.dir, v: S.robot.v,
    bodyHidden: r.children.filter((m) => m.isMesh).every((m) => !m.visible), sel: S.selected?.id || null };
});
const ang = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const yawOf = (d) => Math.atan2(d[0], d[2]);
const near = (a, b, e = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) <= e);

// ------------------------------------------------------------------ 1. Robot POV
async function pov(browser) {
  const p = await open(browser);
  const cams = await p.$$eval("#dock [data-cam]", (bs) => bs.map((b) => [b.dataset.cam, b.textContent.trim()]));
  ok("Dock: camera modes Robot POV · Chase · Angled · Top · Free", JSON.stringify(cams) === JSON.stringify([["pov", "Robot POV"], ["chase", "Chase"], ["broadcast", "Angled"], ["top", "Top"], ["free", "Free"]]), JSON.stringify(cams));
  // idle at the dock
  await p.click('#dock [data-cam="pov"]');
  await step(p, 40);
  let q = await pose(p);
  const fwd = [Math.sin(q.ry), Math.cos(q.ry)];
  const off = [q.p[0] - q.rp[0], q.p[2] - q.rp[2]], along = off[0] * fwd[0] + off[1] * fwd[1];
  ok("POV at the dock: camera at the robot's sensor (front, ~0.95 m)", q.cam === "pov" && Math.abs(q.p[1] - 0.95) < 0.02 && along > 0.05 && along < 0.3 && Math.hypot(...off) < 0.3,
    `h ${q.p[1].toFixed(2)} m, ${along.toFixed(2)} m ahead`);
  ok("POV at the dock: looks along the heading, tilted slightly down", ang(yawOf(q.dir), q.ry) < 0.05 && q.dir[1] < -0.05 && q.dir[1] > -0.35, `pitch ${(Math.asin(q.dir[1]) * 57.3).toFixed(1)}°`);
  ok("POV: near plane avoids clipping, robot body hidden", q.near <= 0.05 && q.bodyHidden, `near ${q.near}`);
  const hud = await p.evaluate(() => { const h = document.querySelector("#povHud"); return { vis: !h.classList.contains("hidden"), text: h.textContent }; });
  ok("POV HUD: labelled as simulated, speed + distance", hud.vis && /Simulated robot camera — rendered from the 3D scan, not a live feed/.test(hud.text) && /Speed/.test(hud.text) && /To go/.test(hud.text), hud.text.replace(/\s+/g, " ").slice(0, 120));
  await p.screenshot({ path: `${SHOTS}/pov-dock.png` });
  // drive to P-005 at 1×, sampling every frame
  const tid = await p.evaluate(() => window.__app.target.asset.asset_id);
  await p.evaluate((id) => window.__dispatch(id), tid);
  ok("POV: route planned, robot drives", await stepUntil(p, () => window.__app.robot.moving && window.__app.robot.s > 0.05, 200));
  const samples = await p.evaluate(() => {
    const A = window.__xr, S = A.S, out = [], d = new A.THREE.Vector3();
    for (let i = 0; i < 4000 && S.robot.moving; i++) {
      window.__step(1 / 30);
      A.camera.getWorldDirection(d);
      const r = S.fac.robot;
      out.push([A.camera.position.x, A.camera.position.y, A.camera.position.z, d.x, d.y, d.z, r.position.x, r.position.z, r.rotation.y, S.robot.s]);
    }
    return out;
  });
  // departure: the robot first turns on the spot towards the route; the camera follows that with a rate limit, so
  // heading lag is checked once it is under way (after the first second), and turn smoothness over the whole drive
  let maxOff = 0, maxLag = 0, lag0 = 0, minY = 9, maxJump = 0, turn = 0, nan = 0, maxJerk = 0, flips = 0, prevW = 0;
  for (let i = 0; i < samples.length; i++) {
    const [x, y, z, dx, dy, dz, rx, rz, ry] = samples[i];
    if (![x, y, z, dx, dy, dz].every(Number.isFinite)) nan++;
    maxOff = Math.max(maxOff, Math.hypot(x - rx, z - rz)); minY = Math.min(minY, y);
    const lag = ang(Math.atan2(dx, dz), ry);
    if (i >= 30) maxLag = Math.max(maxLag, lag); else lag0 = Math.max(lag0, lag);
    if (i) {
      const yw = Math.atan2(dx, dz), y0 = Math.atan2(samples[i - 1][3], samples[i - 1][5]);
      const w = Math.atan2(Math.sin(yw - y0), Math.cos(yw - y0));
      maxJump = Math.max(maxJump, Math.abs(w)); turn += ang(samples[i][8], samples[i - 1][8]);
      if (i > 1) maxJerk = Math.max(maxJerk, Math.abs(w - prevW));
      if (Math.abs(w) > 0.004 && Math.abs(prevW) > 0.004 && Math.sign(w) !== Math.sign(prevW)) flips++;   // left-right wobble
      prevW = w;
    }
  }
  ok("POV: route includes a turn", turn > 0.6, `robot turned ${(turn * 57.3).toFixed(0)}° over ${samples.length} frames`);
  ok("POV: camera stays with the robot (≤ 0.3 m, at the front)", maxOff < 0.3, `max ${maxOff.toFixed(3)} m`);
  ok("POV: view follows the heading while driving (smoothed, never far behind)", maxLag < 0.45, `max lag ${(maxLag * 57.3).toFixed(1)}° (departure turn ${(lag0 * 57.3).toFixed(0)}°)`);
  ok("POV: no snapping or jitter through turns", maxJump < 0.08 && maxJerk < 0.035 && flips === 0, `max ${(maxJump * 57.3).toFixed(2)}°/frame, Δ ${(maxJerk * 57.3).toFixed(2)}°/frame², ${flips} wobbles`);
  ok("POV: no NaN, camera above the floor", nan === 0 && minY > 0.5, `min height ${minY.toFixed(2)} m`);
  // arrival in POV: the camera turns to the asset
  await step(p, 60);
  q = await pose(p);
  const o = await p.evaluate(() => window.__app.navObject.center);
  ok("POV: after arrival the camera faces the asset", ang(yawOf(q.dir), Math.atan2(o[0] - q.rp[0], o[2] - q.rp[2])) < 0.15, `${(ang(yawOf(q.dir), Math.atan2(o[0] - q.rp[0], o[2] - q.rp[2])) * 57.3).toFixed(1)}° off`);
  // the mini-map keeps drawing in POV
  ok("POV: mini-map still visible", await p.evaluate(() => !document.querySelector("#minimap").classList.contains("hidden")));
  // drag in the view hands the camera to the user
  await p.mouse.move(700, 450); await p.mouse.down(); await p.mouse.move(760, 460, { steps: 4 }); await p.mouse.up();
  ok("POV: dragging the view switches to Free", (await pose(p)).cam === "free");
  ok("POV: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 2. switching cameras never touches the robot
async function switching(browser) {
  const p = await open(browser);
  const tid = await p.evaluate(() => window.__app.target.asset.asset_id);
  await p.evaluate((id) => window.__dispatch(id), tid);
  await stepUntil(p, () => window.__app.robot.s / window.__app.robot.len > 0.35, 3000);
  const route0 = await p.evaluate(() => { window.__route0 = window.__app.route; window.__curve0 = window.__app.curve; return window.__app.route.length_m; });
  const modes = ["pov", "chase", "broadcast", "top", "free", "pov", "chase"];
  // moving
  let bad = [], last = (await pose(p)).s;
  for (const m of modes) {
    const a = await pose(p);
    await p.click(`#dock [data-cam="${m}"]`);
    const b = await pose(p);
    if (b.s !== a.s || !b.moving || b.cam !== m) bad.push(`${m}: ${a.s}→${b.s} ${b.moving} ${b.cam}`);
    await step(p, 8);
    const c = await pose(p);
    if (!(c.s > b.s) || c.s < last) bad.push(`${m}: did not continue (${b.s}→${c.s})`);
    last = c.s;
  }
  const same = await p.evaluate(() => window.__app.route === window.__route0 && window.__app.curve === window.__curve0);
  ok("Cameras mid-route: progress continues, no restart", bad.length === 0 && same, bad.join("; ") || `route ${route0} m kept`);
  // paused
  await p.click('#dock [data-d="play"]');
  bad = [];
  const s0 = (await pose(p)).s;
  for (const m of modes) { await p.click(`#dock [data-cam="${m}"]`); await step(p, 10); const c = await pose(p); if (c.s !== s0 || c.moving) bad.push(`${m}: ${c.s} ${c.moving}`); }
  ok("Cameras while paused: robot stays put and paused", bad.length === 0, bad.join("; "));
  // reversing
  await p.click('#dock [data-d="reverse"]');
  await step(p, 10);
  bad = [];
  for (const m of modes) {
    const a = await pose(p); await p.click(`#dock [data-cam="${m}"]`); await step(p, 6); const c = await pose(p);
    if (!(c.dir_ < 0 && c.moving && c.s < a.s)) bad.push(`${m}: dir ${c.dir_} moving ${c.moving} ${a.s}→${c.s}`);
  }
  ok("Cameras while reversing: keeps reversing", bad.length === 0, bad.join("; "));
  // scrubbed
  await p.click('#dock [data-d="reverse"]');
  await p.evaluate(() => { const s = document.querySelector("#scrub"); s.value = 620; s.dispatchEvent(new Event("input", { bubbles: true })); });
  const sc = (await pose(p)).s;
  bad = [];
  for (const m of modes) { await p.click(`#dock [data-cam="${m}"]`); await step(p, 6); const c = await pose(p); if (Math.abs(c.s - sc) > 1e-9 || c.moving) bad.push(`${m}: ${c.s}`); }
  ok("Cameras after scrubbing: position kept", bad.length === 0, bad.join("; ") || `${sc.toFixed(2)} m`);
  // navpad view buttons map onto the same modes and light up
  const pad = [];
  for (const [k, m] of [["robot", "pov"], ["angled", "broadcast"], ["top", "top"], ["eye", "free"]]) {
    const btn = await p.$(`#navpad [data-np-view="${k}"]`);
    if (!btn) { pad.push(`${k} missing`); continue; }
    await btn.click(); await step(p, 2);
    const st = await p.evaluate((k) => ({ cam: window.__app.cam, on: document.querySelector(`#navpad [data-np-view="${k}"]`).classList.contains("on"), dock: document.querySelector("#dock [data-cam].on")?.dataset.cam }), k);
    if (st.cam !== m || !st.on || st.dock !== m) pad.push(`${k}: ${JSON.stringify(st)}`);
  }
  ok("Navpad Robot / Angled / Top / Eye = dock camera modes, active one lit", pad.length === 0, pad.join("; "));
  ok("Cameras: robot never moved by a camera switch", Math.abs((await pose(p)).s - sc) < 1e-9);
  ok("Switching: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 3. in-scene X-Ray panel
async function overlay(browser) {
  const p = await open(browser);
  const ids = await p.evaluate(() => {
    const S = window.__app, by = (c) => S.data.objects.find((o) => o.asset?.asset_class === c && !o.asset.is_target)?.asset.asset_id;
    return { pump: S.target.asset.asset_id, motor: by("ELECTRIC_MOTOR"), valve: by("CONTROL_VALVE") };
  });
  for (const [kind, cls] of [["pump", "PROCESS_PUMP"], ["motor", "ELECTRIC_MOTOR"], ["valve", "CONTROL_VALVE"]]) {
    await p.evaluate((id) => window.__select(id, { fly: true }), ids[kind]);
    await step(p, 45);
    const acts = await p.$$eval("#right .actions-top [data-act]", (bs) => bs.map((b) => b.dataset.act));
    if (kind === "pump") ok("Asset card: Send robot · Explore internals (X-Ray) · What's wrong? · Plan access", ["dispatch-sel", "xo-sel", "diagnose-sel", "plan-sel"].every((a) => acts.includes(a)), acts.join(", "));
    const before = await pose(p);
    await p.click('#right [data-act="xo-sel"]');
    const opened = await p.waitForFunction((c) => window.__xr.xo.open && window.__app.xClass === c, cls, { timeout: 20000, polling: 100 }).then(() => true, () => false);
    await step(p, 40);
    const st = await p.evaluate(() => {
      const A = window.__xr, r = document.querySelector("#xo .xo-view").getBoundingClientRect();
      return { n: A.xo.stats.n, rect: [r.left, r.top, r.width, r.height], prov: document.querySelector("#xo").textContent.includes("Illustrative teaching model — not reconstructed from the scan"),
        tag: document.querySelector("#xoTitle").textContent, rows: document.querySelectorAll("#xoList [data-xo-comp]").length, sus: document.querySelectorAll("#xoList .pill.red").length, mode: A.S.mode };
    });
    ok(`X-Ray panel: ${kind} opens the ${cls} model over the room`, opened && st.n > 10 && st.mode === "facility" && st.rect[2] > 400 && st.rows > 3, `${st.rows} parts, ${st.n} panel frames, ${st.tag.replace(/\s+/g, " ").trim().slice(0, 60)}`);
    if (kind === "pump") {
      ok("X-Ray panel: labelled illustrative, suspected parts in red", st.prov && st.sus >= 1, `${st.sus} suspected`);
      // the room is still rendered around the panel: a pixel left of the panel is not the panel's studio backdrop
      await p.screenshot({ path: `${SHOTS}/xo-pump.png` });
      // explode slider
      await p.evaluate(() => { const s = document.querySelector("#xoExplode"); s.value = 20; s.dispatchEvent(new Event("input", { bubbles: true })); });
      await step(p, 60);
      const ex = await p.evaluate(() => ({ t: window.__app.xray.target, e: window.__app.xray.explode, pct: document.querySelector("#xoPct").textContent }));
      ok("X-Ray panel: explode slider drives the model", Math.abs(ex.t - 0.2) < 1e-6 && Math.abs(ex.e - 0.2) < 0.05 && ex.pct === "20%", JSON.stringify(ex));
      // list selection
      const comp = await p.evaluate(() => [...document.querySelectorAll("#xoList [data-xo-comp]")].map((b) => b.dataset.xoComp).find((id) => id !== window.__app.xSelected));
      await p.click(`#xoList [data-xo-comp="${comp}"]`);
      await step(p, 30);
      const sel = await p.evaluate(() => ({ s: window.__app.xSelected, x: window.__app.xray.selected, on: document.querySelector("#xoList .xo-row.on")?.dataset.xoComp, part: document.querySelector("#xoPart").textContent }));
      ok("X-Ray panel: select a component in the list (highlight + explanation)", sel.s === comp && sel.x === comp && sel.on === comp && sel.part.length > 60, comp);
      // click a part in the model
      await p.evaluate(() => { const s = document.querySelector("#xoExplode"); s.value = 80; s.dispatchEvent(new Event("input", { bubbles: true })); });
      await step(p, 80);
      const target = await p.evaluate(() => {
        const A = window.__xr, S = A.S, cam = A.xo.cam, r = document.querySelector("#xo .xo-view").getBoundingClientRect();
        for (const id of S.xray.order()) {
          if (id === S.xSelected) continue;
          const c = S.xray.partCenter(id).project(cam), x = r.left + ((c.x + 1) / 2) * r.width, y = r.top + ((1 - c.y) / 2) * r.height;
          if (x < r.left + 20 || x > r.right - 20 || y < r.top + 40 || y > r.bottom - 30) continue;
          const v = new A.THREE.Vector2(c.x, c.y), ray = new A.THREE.Raycaster(); ray.setFromCamera(v, cam);
          const hit = ray.intersectObjects(S.xray.pickables(), false)[0];
          if (hit && hit.object.userData.componentId !== S.xSelected) return { x, y, id: hit.object.userData.componentId };
        }
        return null;
      });
      if (target) { await p.mouse.click(target.x, target.y); await step(p, 4); }
      const picked = await p.evaluate(() => window.__app.xSelected);
      ok("X-Ray panel: click a part in the model selects it", !!target && picked === target.id, target ? `${target.id} → ${picked}` : "no clickable part found");
      // drag rotates the panel camera, not the room camera
      const r0 = await p.evaluate(() => [window.__xr.xo.cam.position.toArray(), window.__xr.camera.position.toArray()]);
      const vr = st.rect;
      await p.mouse.move(vr[0] + vr[2] * 0.5, vr[1] + vr[3] * 0.5); await p.mouse.down();
      await p.mouse.move(vr[0] + vr[2] * 0.5 + 90, vr[1] + vr[3] * 0.5 + 10, { steps: 5 }); await p.mouse.up();
      await step(p, 20);
      const r1 = await p.evaluate(() => [window.__xr.xo.cam.position.toArray(), window.__xr.camera.position.toArray()]);
      ok("X-Ray panel: drag turns the model, the room camera stays put", !near(r0[0], r1[0], 0.01) && near(r0[1], r1[1], 1e-9));
      // see-through + labels
      await p.click('#xo [data-xo="ghost"]'); await p.click('#xo [data-xo="labels"]'); await step(p, 10);
      const gl = await p.evaluate(() => ({ g: window.__app.xray.ghost, l: window.__app.xray.labelsOn, tags: document.querySelectorAll("#xo .xo-lbl .ptag").length }));
      ok("X-Ray panel: see-through and labels", gl.g && gl.l && gl.tags > 3, JSON.stringify(gl));
      await p.click('#xo [data-xo="ghost"]'); await p.click('#xo [data-xo="labels"]');
      // frame cost with the panel open vs closed (software GPU; relative numbers matter)
      const cost = await p.evaluate(() => {
        const t = () => { const t0 = performance.now(); for (let i = 0; i < 20; i++) window.__step(1 / 30); return (performance.now() - t0) / 20; };
        t(); const open = t(); const panel = window.__xr.xo.stats.ms;
        return { open, panel };
      });
      p.cost = cost;
    }
    // close (× for the pump, Esc for the others) → exact restore
    if (kind === "pump") await p.click('#xo [data-xo="close"]'); else await p.keyboard.press("Escape");
    const after = await pose(p);
    const closed = await p.evaluate(() => !window.__xr.xo.open && document.querySelector("#xo").classList.contains("hidden"));
    ok(`X-Ray panel (${kind}): ${kind === "pump" ? "×" : "Esc"} closes and restores the exact view`, closed && after.cam === before.cam && near(after.p, before.p) && near(after.t, before.t) && after.sel === before.sel && after.s === before.s,
      `${before.cam} ${before.p.map((x) => x.toFixed(3))}`);
    if (kind === "pump") {
      const cost = await p.evaluate(() => { const t0 = performance.now(); for (let i = 0; i < 20; i++) window.__step(1 / 30); return (performance.now() - t0) / 20; });
      const n0 = await p.evaluate(() => window.__xr.xo.stats.n); await step(p, 10);
      const n1 = await p.evaluate(() => window.__xr.xo.stats.n);
      ok("X-Ray panel: not rendered when closed", n1 === n0, `frame ${cost.toFixed(1)} ms closed · ${p.cost.open.toFixed(1)} ms open (panel ${p.cost.panel.toFixed(1)} ms CPU)`);
    }
  }
  // mid-route, chase camera: the room freezes while the panel is open and carries on exactly afterwards
  await p.click('#dock [data-cam="chase"]');
  await p.evaluate((id) => window.__dispatch(id), ids.pump);
  await stepUntil(p, () => window.__app.robot.s > 1.2, 3000);
  const b = await pose(p);
  await p.evaluate((id) => window.__xr.xo.show(id), ids.motor);
  await p.waitForFunction(() => window.__xr.xo.open, null, { timeout: 20000, polling: 100 });
  await step(p, 30);
  const mid = await pose(p);
  ok("X-Ray panel mid-route: robot holds still while open", !mid.moving && mid.s === b.s && near(mid.p, b.p, 1e-9), `${b.s.toFixed(3)} → ${mid.s.toFixed(3)}`);
  await p.keyboard.press("Escape");
  const a = await pose(p);
  ok("X-Ray panel mid-route: closing restores camera, mode and motion", a.moving && a.s === b.s && a.cam === "chase" && near(a.p, b.p) && near(a.t, b.t) && Math.abs(a.v - b.v) < 1e-9);
  await step(p, 10);
  ok("X-Ray panel mid-route: the route continues from the same point", (await pose(p)).s > b.s);
  // the full-screen X-Ray tab keeps working, and the panel offers it
  await p.evaluate((id) => window.__xr.xo.show(id), ids.valve);
  await p.waitForFunction(() => window.__xr.xo.open, null, { timeout: 20000, polling: 100 });
  await p.click('#xo [data-xo="full"]');
  const full = await p.waitForFunction(() => window.__app.mode === "xray" && window.__app.xClass === "CONTROL_VALVE" && !window.__xr.xo.open, null, { timeout: 20000, polling: 100 }).then(() => true, () => false);
  ok("X-Ray panel: 'Open full X-Ray view' opens the X-Ray tab on the same device", full);
  await p.click('.modes [data-mode="facility"]');
  ok("Overlay: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 4. arrival prompt
async function arrival(browser) {
  const p = await open(browser);
  const tid = await p.evaluate(() => window.__app.target.asset.asset_id);
  await p.evaluate((id) => window.__dispatch(id), tid);
  await stepUntil(p, () => window.__app.robot.s > 0.4, 600);
  await p.evaluate(() => { const s = document.querySelector("#scrub"); s.value = 1000; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await step(p, 20);
  const pr = await p.evaluate(() => { const e = document.querySelector("#arrive"); return e && !e.classList.contains("hidden") ? e.textContent.replace(/\s+/g, " ") : null; });
  ok("Arrival prompt: appears in the scene", !!pr && /You've arrived at P-005/.test(pr) && /Inspect equipment/.test(pr) && /See diagnosis/.test(pr), pr?.slice(0, 90));
  const inView = await p.evaluate(() => { const r = document.querySelector("#arrive .ap-card").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 60 && r.bottom <= innerHeight; });
  ok("Arrival prompt: on screen, clear of the edges", inView);
  ok("Arrival: diagnosis card still ready", await p.waitForFunction(() => /P-005 diagnosis/.test(document.querySelector("#right").textContent), null, { timeout: 20000 }).then(() => true, () => false));
  await p.screenshot({ path: `${SHOTS}/arrival-prompt.png` });
  await p.click('#arrive [data-ap="inspect"]');
  const opened = await p.waitForFunction(() => window.__xr.xo.open && window.__app.xClass === "PROCESS_PUMP", null, { timeout: 20000, polling: 100 }).then(() => true, () => false);
  const card = await p.evaluate(() => ({ t: document.querySelector("#right").textContent, x: !!document.querySelector('#right [data-act="xo-sel"]'), prim: document.querySelector('#right .actions-top .btn.primary')?.dataset.act }));
  ok("Arrival → Inspect equipment: asset card + X-Ray panel", opened && /P-005/.test(card.t) && card.x, `primary: ${card.prim}`);
  ok("Asset card at the destination: X-Ray is the primary action", card.prim === "xo-sel");
  await step(p, 30);
  await p.keyboard.press("Escape");
  ok("Arrival prompt: done once acted on", await p.evaluate(() => document.querySelector("#arrive").classList.contains("hidden")));
  // See diagnosis
  await p.evaluate((id) => window.__dispatch(id), tid);
  await step(p, 5);
  await p.evaluate(() => { const s = document.querySelector("#scrub"); s.value = 1000; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await step(p, 10);
  ok("Arrival prompt: shown again on the next arrival", await p.evaluate(() => !document.querySelector("#arrive").classList.contains("hidden")));
  await p.click("#right [data-close-card]").catch(() => {});
  await p.click('#arrive [data-ap="diag"]');
  ok("Arrival → See diagnosis", await p.waitForFunction(() => /P-005 diagnosis/.test(document.querySelector("#right").textContent), null, { timeout: 20000 }).then(() => true, () => false));
  // a new route hides it; arriving elsewhere names that asset; scrubbing away hides it, scrubbing back brings it back
  const mid = await p.evaluate(() => window.__app.data.objects.find((o) => o.asset?.asset_class === "ELECTRIC_MOTOR").asset.asset_id);
  await p.evaluate((id) => window.__dispatch(id), mid);
  await step(p, 5);
  const hid = await p.evaluate(() => document.querySelector("#arrive").classList.contains("hidden"));
  const scrub = (v) => p.evaluate((v) => { const s = document.querySelector("#scrub"); s.value = v; s.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  await scrub(1000); await step(p, 5);
  const t2 = await p.evaluate(() => { const e = document.querySelector("#arrive"); return e.classList.contains("hidden") ? "" : e.textContent; });
  await scrub(500); await step(p, 3);
  const away = await p.evaluate(() => document.querySelector("#arrive").classList.contains("hidden"));
  await scrub(1000); await step(p, 3);
  const back = await p.evaluate(() => !document.querySelector("#arrive").classList.contains("hidden"));
  ok("Arrival prompt: follows the route (new route, other asset, scrub away and back)", hid && /You've arrived at M-/.test(t2) && away && back, `${hid} ${t2.match(/arrived at [\w-]+/)?.[0]} ${away} ${back}`);
  ok("Arrival: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 4b. following cameras vs the walls (whole routes)
// The cut-away keeps the walls, so a camera standing behind a wall (or looking through one) would show the back of the
// wall instead of the robot. Chase is pulled inside the room; Angled swings up near the wall it watches across.
async function walls(browser) {
  const p = await open(browser);
  const targets = await p.evaluate(() => { const S = window.__app, ids = [S.target.asset.asset_id];
    for (const o of S.data.objects) if (o.asset && ids.length < 4 && !ids.includes(o.asset.asset_id) && ["ELECTRIC_MOTOR", "CENTRIFUGAL_PUMP"].includes(o.asset.asset_class)) ids.push(o.asset.asset_id);
    return ids; });
  await p.context().close();
  const agg = { chase: { n: 0, behind: 0, minClear: 9 }, broadcast: { n: 0, occluded: 0 } };
  for (const cam of ["chase", "broadcast"]) for (const id of targets) {
    const q = await open(browser);
    const r = await q.evaluate(async ([cam, id]) => {
      const A = window.__xr, S = window.__app, b = S.data.bounds, c0 = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
      const W = S.data.planes.filter((w) => w.label === "wall").map((w) => ({ n: w.normal, d: w.offset, s: Math.sign(w.normal[0] * c0[0] + w.normal[1] * c0[1] + w.normal[2] * c0[2] + w.offset) }));
      const f = (w, v) => (w.n[0] * v.x + w.n[1] * v.y + w.n[2] * v.z + w.d) * w.s;
      const R = A.renderer.render; A.renderer.render = () => {};
      A.setCamera(cam); for (let i = 0; i < 40; i++) window.__step(1 / 30);
      await window.__dispatch(id);
      let n = 0, behind = 0, occluded = 0, minClear = 9;
      for (let k = 0; k < 4000 && !S.robot.arrived; k++) {
        window.__step(1 / 30); n++;
        const cp = A.camera.position, rp = S.fac.robot.position.clone().setY(0.5);
        const cl = Math.min(...W.map((w) => f(w, cp))); minClear = Math.min(minClear, cl); if (cl < 0 && cp.y < 2.3) behind++;
        if (W.some((w) => { const a = f(w, cp), c = f(w, rp); if (a >= 0 || c < 0) return false; const t = a / (a - c); return cp.y + (rp.y - cp.y) * t < 1.6; })) occluded++;
      }
      A.renderer.render = R;
      return { n, behind, occluded, minClear, arrived: S.robot.arrived };
    }, [cam, id]);
    const g = agg[cam]; g.n += r.n;
    if (cam === "chase") { g.behind += r.behind; g.minClear = Math.min(g.minClear, +r.minClear.toFixed(2)); } else g.occluded += r.occluded;
    await q.context().close();
  }
  ok(`Chase: never behind a wall on ${targets.length} whole routes`, agg.chase.n > 300 && agg.chase.behind === 0, JSON.stringify(agg.chase));
  ok(`Angled: the near wall hides the robot in < 5 % of frames on ${targets.length} routes`, agg.broadcast.n > 300 && agg.broadcast.occluded < 0.05 * agg.broadcast.n, JSON.stringify(agg.broadcast));
}

// ------------------------------------------------------------------ 5. phone
async function phone(browser) {
  const p = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const tid = await p.evaluate(() => window.__app.target.asset.asset_id);
  await p.evaluate((id) => window.__select(id), tid);
  await step(p, 10);
  await p.tap('#right [data-act="xo-sel"]');
  await p.waitForFunction(() => window.__xr.xo.open, null, { timeout: 20000, polling: 100 });
  await step(p, 40);
  const r = await p.evaluate(() => { const a = document.querySelector("#xo").getBoundingClientRect(), v = document.querySelector("#xo .xo-view").getBoundingClientRect(); return { w: a.width, l: a.left, b: a.bottom, vh: v.height, close: !!document.querySelector('#xo [data-xo="close"]').getBoundingClientRect().width }; });
  ok("Phone: X-Ray panel is a full-width sheet with the model on top", Math.abs(r.w - 390) < 1 && Math.abs(r.l) < 1 && Math.abs(r.b - 844) < 1 && r.vh > 180 && r.close, JSON.stringify(r));
  await p.screenshot({ path: `${SHOTS}/xo-phone.png` });
  await p.tap('#xo [data-xo="close"]');
  ok("Phone: closes", await p.evaluate(() => !window.__xr.xo.open));
  ok("Phone: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

const browser = await chromium.launch({ args: GL });
const only = process.env.ONLY?.split(",");
try {
  for (const [n, f] of Object.entries({ pov, switching, overlay, arrival, walls, phone })) {
    if (only && !only.includes(n)) continue;
    try { await f(browser); } catch (e) { ok(`${n}: ran without exceptions`, false, e.message.split("\n")[0]); }
  }
} finally { await browser.close(); server?.kill(); }
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
