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
  // cut-away / clean scan are visibility flips on the per-layer chunks
  const flips = await p.evaluate(() => {
    const f = window.__app.fac; f.setCutaway(true);
    const hiOff = f.splats.filter((m) => m.userData.layer === "high" || m.userData.outside || m.userData.haze).every((m) => !m.visible);
    const lowOn = f.splats.filter((m) => m.userData.layer === "low" && !m.userData.outside && !m.userData.haze).every((m) => m.visible);
    f.setCutaway(false); f.setCleanScan(true);
    const hzOff = f.splats.filter((m) => m.userData.haze).every((m) => !m.visible) && f.splats.filter((m) => m.userData.outside).every((m) => m.visible);   // walls stay at eye level
    f.setCleanScan(false); const allOn = f.splats.every((m) => m.visible); return hiOff && lowOn && hzOff && allOn && f.splats.some((m) => m.userData.outside);
  });
  ok("HQ: cut-away hides ceiling, haze and outside-the-walls; clean scan hides haze only", flips);
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
  // one rendered frame must not throw
  await p.evaluate(() => window.__step(1 / 30));
  ok("HQ: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();

  // 2. ?render=classic
  p = await open(browser, "?capture&render=classic");
  ok("Classic: loads on request", await done(p));
  s = await info(p);
  ok("Classic: ?render=classic uses the xq16 chunks", s.path === "classic" && s.hq === 0 && /streamed chunks/.test(s.src), s.src);
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
} finally { await browser.close(); server?.kill(); }
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
