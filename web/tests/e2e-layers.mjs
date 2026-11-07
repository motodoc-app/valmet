// Scene layers end-to-end: semantic view, clean scan, site map, hover / selection outline, show uncertain.
// Run after `npm run build`:  node tests/e2e-layers.mjs        (SCAN=0 skips the part that loads the 1.2 M-splat scan)
//   BASE=http://localhost:5173 node tests/e2e-layers.mjs        against a running server
// Exits non-zero on any failure. Screenshots go to tests/shots/layers-*.png.
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
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
const ok = (name, cond, info = "") => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4600 + Math.floor(Math.random() * 300);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe" });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);
const waitFor = async (p, fn, arg, ms = 30000) => { try { await p.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; } catch { return false; } };

async function open(browser, query) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(BASE + query);
  await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading"), null, 60000);
  await p.evaluate(() => document.querySelector(".toast")?.remove());
  return p;
}
/** Average frame interval over `ms` (requestAnimationFrame, includes the app's own render). */
const frameTime = (p, ms = 3000) => p.evaluate((ms) => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res((performance.now() - t0) / n); };
  requestAnimationFrame(f);
}), ms);

// ------------------------------------------------------------------ 1. interactions (no scan)
async function interactions(browser) {
  const p = await open(browser, "?scan=off");
  for (const id of ["semantic", "clean", "sitemap"]) ok(`rail button ${id}`, await p.$(`#rail [data-rail="x:${id}"]`));
  const ft0 = await frameTime(p);
  const calls0 = await p.evaluate(() => window.__renderer.info.render.calls);
  // semantic view
  await p.click('#rail [data-rail="x:semantic"]');
  ok("semantic: on", await waitFor(p, () => window.__app.fac.semantic && !document.querySelector(".sem-legend").classList.contains("hidden")));
  ok("semantic: rail button lit", await p.evaluate(() => document.querySelector('#rail [data-rail="x:semantic"]').classList.contains("on")));
  const sem = await p.evaluate(() => { const s = window.__app.fac.sem; return { inst: s.boxes.isInstancedMesh, n: s.boxes.count, objs: window.__app.data.objects.length }; });
  ok("semantic: one InstancedMesh for every object", sem.inst && sem.n === sem.objs, `${sem.n} instances`);
  await sleep(600);
  const calls1 = await p.evaluate(() => window.__renderer.info.render.calls);
  ok("semantic: at most 3 extra draw calls", calls1 - calls0 <= 3, `${calls0} → ${calls1}`);
  const ft1 = await frameTime(p);
  ok("semantic: frame time measured", ft1 > 0, `frame ${ft0.toFixed(1)} ms → ${ft1.toFixed(1)} ms (software GL, scan off)`);
  const tog = await p.evaluate(() => { const f = window.__app.fac, t = performance.now(); for (let i = 0; i < 10; i++) { f.setSemantic(false); f.setSemantic(true); } return (performance.now() - t) / 20; });
  ok("semantic: toggle is instant", tog < 20, `${tog.toFixed(2)} ms per toggle`);
  const legend = await p.evaluate(() => document.querySelector(".sem-legend").textContent);
  ok("semantic: legend lists categories", /Rotating/.test(legend) && /Valves/.test(legend) && /Piping/.test(legend), legend.replace(/\s+/g, " ").slice(0, 90));
  await p.screenshot({ path: `${SHOTS}/layers-semantic.png` });
  // picking still works with frames hidden (semantic boxes are pickable)
  const pick = await p.evaluate(() => {
    const A = window.__xr, T = A.THREE, f = A.S.fac; f.setShowMode("none");
    const o = A.S.data.objects.find((x) => x.kind === "object" && !x.asset && x.category === "valve" && x.center[1] - x.size[1] / 2 < 1.5);
    const id = f.pick(new T.Ray(new T.Vector3(o.center[0], 3.0, o.center[2]), new T.Vector3(0, -1, 0)));
    f.setSemantic(false); const off = f.pick(new T.Ray(new T.Vector3(o.center[0], 3.0, o.center[2]), new T.Vector3(0, -1, 0)));
    f.setSemantic(true); f.setShowMode(A.S.frames);
    return { want: o.id, id, off };
  });
  ok("semantic: OBB picking finds non-asset objects", !!pick.id && pick.off === null, `${pick.id} (frames hidden, semantic off → ${pick.off})`);
  // show uncertain
  await p.click(".sem-legend [data-unc]");
  const unc = await p.evaluate(() => { const f = window.__app.fac, a = f.sem.style.array; let h = 0; for (let i = 1; i < a.length; i += 2) h += a[i]; return { h, n: f.categoryCounts().uncertain, on: f.showUncertain }; });
  ok("show uncertain: hatched objects = uncertain count", unc.on && unc.h === unc.n, `${unc.h} of ${unc.n}`);
  await p.screenshot({ path: `${SHOTS}/layers-uncertain.png` });
  await p.click(".sem-legend [data-unc]");
  // hover: move the mouse onto the projected centre of the faulty pump
  const tgt = await p.evaluate(() => {
    const A = window.__xr, T = A.THREE, o = A.S.target, v = new T.Vector3(...o.center).project(A.camera);
    return { id: o.id, x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, inView: Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9 && v.z < 1 };
  });
  await p.evaluate(() => document.body.classList.add("focus"));     // no panels over the scene
  await p.mouse.move(tgt.x - 30, tgt.y - 30); await p.mouse.move(tgt.x, tgt.y, { steps: 3 });
  ok("hover: outline + tag on the object under the cursor", tgt.inView && await waitFor(p, () => !!window.__app.fac.hoverId && window.__app.fac._hover.visible, null, 15000),
    await p.evaluate(() => window.__app.fac.hoverId + " · " + (window.__app.fac._hoverTag?.element.textContent || "")));
  await p.screenshot({ path: `${SHOTS}/layers-hover.png` });
  await p.evaluate(() => document.body.classList.remove("focus"));
  // selection outline
  await p.evaluate(() => window.__select(window.__app.target.asset.asset_id));
  ok("select: outline follows the selection", await waitFor(p, () => window.__app.fac.outlineId === window.__app.target.id && window.__app.fac._sel.visible, null, 15000));
  // clean scan with no scan loaded: harmless
  await p.click('#rail [data-rail="x:clean"]');
  ok("clean scan: toggles without a scan", await p.evaluate(() => window.__app.fac.cleanScan === true));
  await p.click('#rail [data-rail="x:clean"]');
  // site map
  await p.click('#rail [data-rail="x:sitemap"]');
  ok("site map: sheet with canvas", await waitFor(p, () => !document.querySelector("#sheet").classList.contains("hidden") && document.querySelector("#sheet canvas.sitemap")?.width > 300));
  const ink = await p.evaluate(() => { const c = document.querySelector("canvas.sitemap"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; const set = new Set(); for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4)); return set.size; });
  ok("site map: drawn (many colours)", ink > 30, `${ink} distinct colours`);
  await p.mouse.move(10, 10);
  await p.screenshot({ path: `${SHOTS}/layers-sitemap.png` });
  // download PNG
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }).catch(() => null), p.click("#sheet [data-sm-png]")]);
  let pngBytes = 0;
  if (dl) { const f = path.join(SHOTS, "layers-sitemap-download.png"); await dl.saveAs(f); pngBytes = statSync(f).size; }
  ok("site map: Download PNG", pngBytes > 30000, `${dl?.suggestedFilename()} ${(pngBytes / 1024).toFixed(0)} KB`);
  // click-to-fly: click a valve footprint on the map → the sheet closes and the object is selected
  await p.evaluate(() => window.__select(null));
  const spot = await p.evaluate(() => {
    const v = window.__layers.L.mapView, o = window.__app.data.objects.find((x) => x.asset && x.asset.tag === "CV-003") || window.__app.target;
    const r = document.querySelector("canvas.sitemap").getBoundingClientRect();
    return { id: o.id, x: r.left + v.ox + (o.center[0] - v.x0) * v.k, y: r.top + v.oy + (o.center[2] - v.z0) * v.k };
  });
  await p.mouse.click(spot.x, spot.y);
  ok("site map: click flies to the object", await waitFor(p, (id) => document.querySelector("#sheet").classList.contains("hidden") && window.__app.selected?.id === id, spot.id, 10000), spot.id);
  // other modes: legend hides in X-Ray, comes back in Explore
  await p.click('.modes [data-mode="xray"]');
  ok("x-ray: legend hidden", await waitFor(p, () => document.querySelector(".sem-legend").classList.contains("hidden"), null, 15000));
  await p.click('.modes [data-mode="facility"]');
  ok("explore: legend back", await waitFor(p, () => !document.querySelector(".sem-legend").classList.contains("hidden"), null, 15000));
  ok("no page errors (interactions)", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 2. with the real scan: clean-scan layer, semantic dimming
async function withScan(browser) {
  const p = await open(browser, "?qa=1");
  ok("scan: loaded", await waitFor(p, () => window.__app.fac.splats.length > 0 && document.querySelector("#scanStatus").classList.contains("hidden"), null, 240000),
    await p.evaluate(() => `${window.__app.fac.splatMode} · ${window.__app.fac.splats.length} meshes`));
  const st = await p.evaluate(() => window.__app.fac.scanStats);
  const frac = st.haze / st.splats;
  ok("clean scan: haze fraction 2–20 %", frac > 0.02 && frac < 0.2, `${st.haze.toLocaleString()} of ${st.splats.toLocaleString()} splats (${(frac * 100).toFixed(1)} %)`);
  const t = await p.evaluate(() => {
    const f = window.__app.fac, t0 = performance.now(); f.setCleanScan(true); const dt = performance.now() - t0;
    const hazeOn = f.splats.filter((m) => m.userData.haze).some((m) => m.visible), cleanOn = f.splats.filter((m) => !m.userData.haze && m.userData.layer === "low").every((m) => m.visible);
    return { dt, hazeOn, cleanOn };
  });
  ok("clean scan: instant, hides only the haze layer", t.dt < 5 && !t.hazeOn && t.cleanOn, `${t.dt.toFixed(2)} ms`);
  await p.evaluate(() => window.__app.fac.setCleanScan(false));
  await p.evaluate(() => window.__xr.setMode("facility"));
  await p.evaluate(() => window.__app.fac.setSemantic(true));
  ok("semantic: scan dimmed", await p.evaluate(() => window.__app.fac.splats.every((m) => m.opacity < 0.3)));
  await p.evaluate(() => window.__app.fac.setSemantic(false));
  ok("semantic off: scan restored", await p.evaluate(() => window.__app.fac.splats.every((m) => m.opacity === 1)));
  ok("no page errors (scan)", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

const browser = await chromium.launch({ args: GL });
try {
  await interactions(browser);
  if (process.env.SCAN !== "0") await withScan(browser);
} catch (e) { ok("test run", false, e.message); }
await browser.close();
server?.kill();
const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
