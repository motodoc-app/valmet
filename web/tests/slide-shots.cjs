// Still screenshots for the pitch deck, rendered with the full scan in ?capture mode (works without a GPU).
//   node tests/slide-shots.cjs http://localhost:4711/ out-dir [names...]
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const BASE = process.argv[2], OUT = path.resolve(process.argv[3] || "slide-shots"), ONLY = process.argv.slice(4);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  p.setDefaultTimeout(600000);
  p.on("pageerror", (e) => console.warn("pageerror", e.message));
  await p.goto(BASE + "?capture", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.setMode, null, { timeout: 180000 });
  await p.waitForFunction(() => window.__app.fac.splatMode === "splats", null, { timeout: 300000 });
  await p.evaluate(() => document.querySelector(".toast")?.remove());
  const frames = async (k = 1) => { for (let i = 0; i < k; i++) await p.evaluate(() => window.__step(1 / 12)); };
  const shot = async (name, fn, k = 30) => {
    if (ONLY.length && !ONLY.includes(name)) return;
    await p.evaluate(fn); await sleep(900); await frames(k); await p.evaluate(() => document.querySelector(".toast")?.remove());
    await frames(1); await p.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log("shot", name);
  };
  await shot("01-briefing", () => { window.__xr.setMode("facility"); window.__app.fac.setShowMode("assets"); });
  await shot("02-quality", () => document.querySelector('#rail [data-rail="x:quality"]').click(), 2);
  await shot("03-semantic", () => { document.querySelector("#sheet").classList.add("hidden"); document.querySelector('#rail [data-rail="x:semantic"]')?.click(); }, 4);
  await shot("04-sitemap", () => document.querySelector('#rail [data-rail="x:sitemap"]')?.click(), 2);
  await shot("05-diagnosis", async () => { document.querySelector("#sheet").classList.add("hidden"); window.__layers?.setSemantic?.(false);
    const A = window.__xr; A.selectObject(A.S.target, { fly: true }); A.S.diag = await A.api.diagnose(A.S.target.asset.asset_id); A.S.tab = "overview"; A.renderDiagnosis(); }, 24);
  await shot("06-plan", async () => { await window.__xr.planning?.demo?.(); }, 24);
  await shot("07-route", async () => { const A = window.__xr; A.setMode("facility"); document.querySelector('#dock [data-cam="broadcast"]')?.click(); A.S.robot.rate = 4; await A.restart(A.S.target.asset.asset_id); }, 40);
  await shot("08-xray", async () => { await window.__xr.enterXRay(null, window.__xr.S.target.asset.asset_id); }, 40);
  await shot("09-support", async () => { await window.__xr.support?.demo?.(); }, 24);
  await shot("10-value", () => document.querySelector('.modes [data-mode="value"]').click(), 2);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
