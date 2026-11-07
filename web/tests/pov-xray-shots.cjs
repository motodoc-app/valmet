// Screenshots WITH the scan (software GL: ~20–40 s per frame) of the Robot POV mid-route, the in-scene X-Ray panel
// over the facility and the arrival prompt. The page runs in ?capture mode: a frame renders only on window.__step(dt).
//   cd web && npm run build && npx vite preview --port 4537 --strictPort &
//   node tests/pov-xray-shots.cjs http://localhost:4537/ [out-dir]
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const BASE = process.argv[2] || "http://localhost:4537/";
const OUT = path.resolve(process.argv[3] || path.join(__dirname, "shots"));
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s]`, ...a);

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  p.setDefaultTimeout(600000);
  p.on("pageerror", (e) => console.warn("pageerror", e.message));
  await p.goto(BASE + "?capture&noguide&qa");
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.xo, null, { timeout: 180000, polling: 500 });
  // every chunk of the scan is in the scene (full-fidelity SPZ: one mesh per chunk), then a few seconds for the workers
  await p.waitForFunction(() => { const f = window.__app.fac, n = +(/(\d+) SPZ chunks/.exec(f.scanSource || "")?.[1] || 0); return n ? f.splats.length >= n && f.splats.every((m) => m.isInitialized) : f.previews.length > 2; },
    null, { timeout: 600000, polling: 1000 }).catch(() => log("scan still streaming"));
  await new Promise((r) => setTimeout(r, 8000));
  log("scan ready", await p.evaluate(() => `${window.__app.fac.scanSource} · ${window.__app.fac.splats.length} meshes`));
  await p.evaluate(() => window.__step(1 / 15));      // first frame uploads + sorts
  const step = async (dt, n = 1) => { for (let i = 0; i < n; i++) await p.evaluate((dt) => window.__step(dt), dt); };
  // the splat sort runs in a worker: give it real time between frames so the shot shows a sorted scan
  const settle = async (k = 3) => { for (let i = 0; i < k; i++) { await new Promise((r) => setTimeout(r, 2500)); await step(1 / 30); } };
  const clean = () => p.evaluate(() => { document.querySelector(".toast")?.remove(); document.querySelector(".np-hint")?.remove(); });
  const shot = async (name) => { await clean(); await p.screenshot({ path: path.join(OUT, name) }); log("wrote", name); };
  const scrub = (v) => p.evaluate((v) => { const s = document.querySelector("#scrub"); s.value = v; s.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  const tid = await p.evaluate(() => window.__app.target.asset.asset_id);

  // 1. Robot POV mid-route, driving
  await p.evaluate((id) => window.__dispatch(id), tid);
  await scrub(+(process.env.POV_AT || 520));
  await p.click('#dock [data-cam="pov"]');
  await p.evaluate(() => { const R = window.__app.robot; R.moving = true; R.dir = 1; R.v = 0.6; window.__xr.renderDock(); });
  await step(1.0); await settle();
  await shot("scan-pov-midroute.png");

  // 2. arrival prompt (chase camera flies in beside the robot)
  await p.click('#dock [data-cam="chase"]');
  await scrub(1000);
  await step(0.7, 2); await settle();
  await shot("scan-arrival-prompt.png");

  // 3. Inspect equipment → asset card + in-scene X-Ray panel over the room
  await p.click('#arrive [data-ap="inspect"]');
  await p.waitForFunction(() => window.__xr.xo.open, null, { timeout: 60000, polling: 200 });
  await new Promise((r) => setTimeout(r, 600));          // the explode starts on a short timer
  await step(0.8, 2); await settle(2);
  await shot("scan-xray-overlay.png");
  log("panel CPU ms", await p.evaluate(() => window.__xr.xo.stats.ms.toFixed(1)));
  await p.keyboard.press("Escape");
  await settle(2);
  await shot("scan-after-close.png");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
