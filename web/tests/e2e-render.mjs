// Scan render paths and the twin layer. Run after `npm run build`:  node tests/e2e-render.mjs
// Pages run in ?capture mode (nothing renders unless asked), so loading is tested without waiting for a software GPU
// to draw 1.7 M splats. Checks: full-fidelity SPZ scan by default (every chunk, aligned transform), phone = tier 0,
// ?render=classic, automatic fallback to the classic chunks when the SPZ scan is missing or broken, picking on the
// analytic boxes, asset condition pins and the Twin overlay.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, devices } = (() => { try { return require("playwright"); } catch { return require("@playwright/test"); } })();

const here = path.dirname(fileURLToPath(import.meta.url));
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond, info]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hq = JSON.parse(readFileSync(path.join(here, "../dist/static/hq/scan-hq.json"), "utf8"));

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4580 + Math.floor(Math.random() * 300);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe" });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);
const waitFor = async (p, fn, arg, ms = 120000) => { try { await p.waitForFunction(fn, arg, { timeout: ms, polling: 250 }); return true; } catch { return false; } };
const done = (p) => waitFor(p, () => window.__app?.fac && document.querySelector("#scanStatus")?.classList.contains("hidden") && window.__app.fac.splatMode, null, 240000);
async function open(browser, url, { route, device } = {}) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(120000);
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  if (route) await p.route(route, (r) => r.fulfill({ status: 404, body: "missing" }));
  await p.goto(BASE + url);
  return p;
}
const info = (p) => p.evaluate(() => { const f = window.__app.fac; return { path: f.renderPath, src: f.scanSource, n: f.scanStats.splats, meshes: f.splats.length, hq: f.splats.filter((m) => m.userData.hq).length }; });

const browser = await chromium.launch({ args: GL });
try {
  // 1. default: full-fidelity SPZ scan, every chunk, canonical transform on every mesh
  let p = await open(browser, "?capture");
  ok("HQ: scan loads", await done(p));
  let s = await info(p);
  ok("HQ: full-fidelity path is the default", s.path === "hq", s.src);
  ok("HQ: every splat of the manifest is loaded", s.n === hq.total && s.hq === hq.chunks.length, `${s.n} splats in ${s.hq} meshes`);
  const aligned = await p.evaluate((t) => window.__app.fac.splats.every((m) => m.matrix.elements.every((v, i) => Math.abs(v - t[(i % 4) * 4 + Math.floor(i / 4)]) < 1e-6)), hq.transform);
  ok("HQ: chunks carry the canonical transform (aligned with scene.json)", aligned);
  // picking uses the analytic boxes, independent of the render path
  const pick = await p.evaluate(() => {
    const X = window.__xr, S = window.__app, T = X.THREE, o = S.target;
    const ray = new T.Ray(new T.Vector3(o.center[0], 3, o.center[2]), new T.Vector3(0, -1, 0));
    return S.fac.pick(ray);
  });
  ok("HQ: object picking (analytic boxes) still finds objects", !!pick, pick);
  // cut-away: the haze layer is hidden, walls and everything below the soft cut stay; the ceiling and overhead ducts
  // are faded out by one render-time SplatEdit (plane SDF), so nothing is sliced at a layer boundary
  const flips = await p.evaluate(() => {
    const f = window.__app.fac, S = window.__xr.scene; f.setCutaway(true);
    const edit = S.getObjectByName("cutaway-ceiling"), sdf = edit?.children[0];
    const sdfOk = !!edit && edit.softEdge > 0 && sdf?.type === "plane" && sdf.opacity === 0 && Math.abs(sdf.position.y - f.cutTop) < 1e-9;
    // the plane's local +z must point down (inside = above the cut)
    const down = sdf && new window.__xr.THREE.Vector3(0, 0, 1).applyQuaternion(sdf.getWorldQuaternion(new window.__xr.THREE.Quaternion())).y < -0.99;
    const hzOff = f.splats.filter((m) => m.userData.haze).every((m) => !m.visible);
    const restOn = f.splats.filter((m) => !m.userData.haze).every((m) => m.visible);   // walls + high layer kept
    const cutY = f.cutY === f.cutTop;
    f.setCutaway(false); const editGone = !S.getObjectByName("cutaway-ceiling");
    f.setCleanScan(true);
    const cleanOk = f.splats.filter((m) => m.userData.haze).every((m) => !m.visible) && f.splats.filter((m) => m.userData.outside).every((m) => m.visible);   // walls stay at eye level
    f.setCleanScan(false); const allOn = f.splats.every((m) => m.visible);
    return { sdfOk, down, hzOff, restOn, cutY, editGone, cleanOk, allOn, outside: f.splats.some((m) => m.userData.outside) };
  });
  ok("HQ: cut-away = soft ceiling cut (SplatEdit plane) + haze hidden, walls and tall equipment kept; clean scan hides haze only", Object.values(flips).every(Boolean), JSON.stringify(flips));
  // cut-away chip: labelled whenever an overhead camera cuts; "Show full scan" survives camera switches until undone
  const chip = await p.evaluate(() => {
    const X = window.__xr, S = window.__app, f = S.fac, st = () => { window.__step(1 / 30); const c = document.querySelector("#cutChip"); return { cut: f.cutaway, shown: !!c && !c.classList.contains("hidden"), text: c?.textContent || "" }; };
    const r = {};
    X.setCamera("top"); r.top = st();
    document.querySelector('#cutChip [data-cut="full"]').click(); r.full = st();
    X.setCamera("broadcast"); r.angled = st();
    X.setCamera("chase"); r.chase = st();
    X.setCamera("top"); r.top2 = st();
    document.querySelector('#cutChip [data-cut="auto"]').click(); r.back = st();
    X.setCamera("chase"); r.chase2 = st();
    X.cancelTween();                 // setCamera("chase") flies home; the next check places the camera itself
    return r;
  });
  ok("Cut-away chip: labelled in Top (what is hidden, no-data note)", chip.top.cut && chip.top.shown && /Cut-away/.test(chip.top.text) && /faded out from 1\.55 m/.test(chip.top.text) && /no scan data/.test(chip.top.text), chip.top.text);
  ok("Cut-away chip: 'Show full scan' turns it off and survives Top → Angled → Chase → Top", !chip.full.cut && chip.full.shown && /Full scan/.test(chip.full.text) && !chip.angled.cut && !chip.chase.shown && !chip.top2.cut && chip.top2.shown, JSON.stringify({ full: chip.full.cut, angled: chip.angled.cut, top2: chip.top2.cut }));
  ok("Cut-away chip: 'Cut-away' restores it; eye-level views have no chip", chip.back.cut && !chip.chase2.cut && !chip.chase2.shown);
  // markers + twin overlay
  const tw = await p.evaluate(async () => {
    const f = window.__app.fac, pins = f.markers.children.filter((c) => c.isSprite).length;
    const grid = await window.__xr.api.grid(); f.setTwin(true, grid);
    const r = { pins, twin: !!f.twin?.visible, floor: !!f.twin?.userData.floor, walls: f.twin?.userData.outline.geometry.attributes.position.count };
    f.setSemantic(true); r.pinsHiddenInSemantic = f.markers.children.every((c) => !c.visible); f.setSemantic(false);
    f.setTwin(false); r.off = !f.twin.visible; return r;
  });
  ok("Twin: a condition pin per asset that is not healthy", tw.pins > 0 && tw.pins === (await p.evaluate(() => window.__app.data.objects.filter((o) => o.asset && o.asset.condition_state !== "healthy").length)), `${tw.pins} pins`);
  ok("Twin: overlay builds and toggles", tw.twin && tw.floor && tw.walls >= 8 && tw.off, JSON.stringify(tw));
  ok("Twin: pins step aside for the semantic view", tw.pinsHiddenInSemantic);
  // look.js: studio backdrop + floor plate; no adaptive resolution while capturing
  const look = await p.evaluate(() => ({ bg: !!window.__xr.scene.background?.isTexture, plate: !!window.__xr.scene.getObjectByName("floor-plate"), adapt: window.__look.adapt }));
  ok("Look: backdrop gradient and floor plate", look.bg && look.plate, JSON.stringify(look));
  ok("Look: ?capture keeps a fixed pixel ratio", look.adapt === false);
  // free camera above the ceiling cuts the ceiling away; back below restores it
  const auto = await p.evaluate(() => {
    const X = window.__xr, S = window.__app; S.cam = "free"; S.fac.setCutaway(false);
    X.camera.position.set(0, 6, 4); window.__step(1 / 30); const up = S.fac.cutaway;
    X.camera.position.set(0, 1.6, 1); window.__step(1 / 30); return { up, down: S.fac.cutaway };
  });
  ok("Look: auto cut-away above the ceiling (free camera)", auto.up === true && auto.down === false, JSON.stringify(auto));
  // one rendered frame must not throw
  await p.evaluate(() => window.__step(1 / 30));
  ok("HQ: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();

  // 2. ?render=classic
  p = await open(browser, "?capture&render=classic");
  ok("Classic: loads on request", await done(p));
  s = await info(p);
  ok("Classic: ?render=classic uses the xq16 chunks", s.path === "classic" && s.hq === 0 && /streamed chunks/.test(s.src), s.src);
  const ccut = await p.evaluate(() => {
    const f = window.__app.fac; f.setCutaway(true);
    const r = { edit: !!window.__xr.scene.getObjectByName("cutaway-ceiling"), highOn: f.splats.filter((m) => m.userData.layer === "high" && !m.userData.haze).every((m) => m.visible),
      // a point-cloud preview (no splat engine) cannot take the soft cut: it still hides the layer above layerY, never the walls
      pointsHigh: f._layerOn({ userData: { layer: "high" } }), pointsLowWall: f._layerOn({ userData: { layer: "low", outside: true } }) };
    f.setCutaway(false); window.__step(1 / 30); return r;
  });
  ok("Classic: soft cut-away on the classic splats; point fallback hides only the high layer", ccut.edit && ccut.highOn && !ccut.pointsHigh && ccut.pointsLowWall && p.errors.length === 0, JSON.stringify(ccut));
  await p.context().close();

  // 3. SPZ chunk broken → automatic fallback to the classic chunks
  p = await open(browser, "?capture", { route: /static\/hq\/scan-0\.wasm/ });
  ok("Fallback: loads when the first SPZ chunk is missing", await done(p));
  s = await info(p);
  ok("Fallback: SPZ chunk missing → classic chunks, no HQ meshes left", s.path === "classic" && s.hq === 0 && s.n > 1e6, s.src);
  await p.context().close();

  // 4. SPZ manifest missing → classic
  p = await open(browser, "?capture", { route: /static\/hq\/scan-hq\.json/ });
  ok("Fallback: loads without the SPZ manifest", await done(p));
  s = await info(p);
  ok("Fallback: SPZ manifest missing → classic chunks", s.path === "classic", s.src);
  await p.context().close();

  // 5. phone: tier 0 only
  p = await open(browser, "?capture", { device: "iPhone 13" });
  ok("Phone: scan loads", await done(p));
  s = await info(p);
  const t0 = hq.chunks.filter((c) => c.tier === 0);
  ok("Phone: loads tier 0 only", s.path === "hq" && s.hq === t0.length && s.n === t0.reduce((a, c) => a + c.count, 0), `${s.n} splats`);
  await p.context().close();

  // 6. adaptive resolution on a 2x desktop screen (scan off: only the UI and overlays render)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message));
    await p.goto(BASE + "?scan=off");
    await waitFor(p, () => window.__app?.fac && window.__look);
    await sleep(2000);
    // the view renders on demand: frame times are measured while the user interacts with the 3D view
    for (let i = 0; i < 60; i++) { await p.mouse.move(500 + (i % 20) * 10, 380 + (i % 7) * 6); await sleep(100); }
    const d = await p.evaluate(() => ({ ...window.__look, plate: undefined, pr: window.__renderer.getPixelRatio() }));
    ok("Adaptive resolution: active on desktop, bounded to [1, 2]", d.adapt && d.dprMax === 2 && d.pr >= 1 && d.pr <= 2 && d.frameMs > 0, `pixel ratio ${d.pr}, ${d.frameMs} ms/frame, ${d.changes} changes`);
    await ctx.close();
  }
  // 7. establishing shot: starts above the room with the cut-away, then flies home
  {
    p = await open(browser, "?render=classic");
    const s0 = await waitFor(p, () => window.__app?.intro?.stage === "hold" && window.__xr.camera.position.y > 5, null, 60000);
    const cut = s0 && await p.evaluate(() => window.__app.fac.cutaway);
    ok("Intro: starts with the whole room from above (cut-away)", s0 && cut);
    ok("Intro: flies to the eye-level home view once the scan is up", await waitFor(p, () => !window.__app.intro || window.__app.intro.stage === "fly", null, 240000));
    ok("Intro: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
    await p.context().close();
  }
  // 8. phones keep pixel ratio 1
  p = await open(browser, "?scan=off", { device: "iPhone 13" });
  await waitFor(p, () => window.__app?.fac && window.__look);
  const ph = await p.evaluate(() => ({ adapt: window.__look.adapt, max: window.__look.dprMax, pr: window.__renderer.getPixelRatio() }));
  ok("Phone: fixed pixel ratio 1, no adaptation", !ph.adapt && ph.max === 1 && ph.pr === 1, JSON.stringify(ph));
  await p.context().close();
} finally { await browser.close(); server?.kill(); }
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
