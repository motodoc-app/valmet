// End-to-end checks in a real (headless) Chromium. Run after `npm run build`:
//   node tests/e2e.mjs                 static build (hosted-demo mode, no Python server)
//   BASE=http://localhost:5173 node tests/e2e.mjs     against a running dev server (server mode if the API is up)
// Scenarios: 3D journey (dispatch, block aisle, scrub, reverse, arrival diagnosis, X-Ray for every device type),
// copilot commands, WebGL disabled → 2D floor plan journey, GPU context loss → floor plan, missing scan chunks →
// scene.splat fallback, phone viewport layout. Screenshots go to tests/shots/.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
// Playwright is not a dependency of the app: use a global install (npm i -g playwright && npx playwright install chromium)
const require = createRequire(import.meta.url);
const { chromium, devices } = (() => { try { return require("playwright"); } catch { return require("@playwright/test"); } })();

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || path.join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const NO_GL = ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis", "--disable-gpu"];
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond, info]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4180 + Math.floor(Math.random() * 400);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe" });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);

async function page(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p.setDefaultNavigationTimeout(120000); p.setDefaultTimeout(60000);   // generous: CI boxes and shared CPUs are slow
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  return p;
}
const waitFor = async (p, fn, arg, ms = 60000) => { try { await p.waitForFunction(fn, arg, { timeout: ms, polling: 250 }); return true; } catch { return false; } };

// ------------------------------------------------------------------ 1. 3D journey
async function threeD() {
  const browser = await chromium.launch({ args: GL });
  const p = await page(browser);
  await p.goto(BASE);
  ok("3D: app boots", await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading")));
  ok("3D: not the floor plan", !(await p.evaluate(() => document.body.classList.contains("plan-mode"))));
  ok("3D: scan loads", await waitFor(p, () => window.__app.fac.previews.length > 0 || window.__app.fac.splats.length > 0, null, 90000),
    await p.evaluate(() => window.__app.fac.scanSource));
  await p.screenshot({ path: `${SHOTS}/3d-home.png` });
  // Interactions run without the 1.2 M-splat scan: a software GPU renders it at < 1 fps, which would only test patience.
  await p.goto(BASE + "?scan=off", { waitUntil: "domcontentloaded" });
  await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading"));
  await p.evaluate(() => document.querySelector(".toast")?.remove());
  // Learn / Practice straight from a cold start (before X-Ray was ever opened)
  for (const m of ["learn", "practice"]) {
    await p.click(`.modes [data-mode="${m}"]`);
    ok(`3D: ${m} works from a cold start`, await waitFor(p, (m) => window.__app.mode === m && window.__app.xClass && document.querySelector("#left [data-comp]") && !/Loading/.test(document.querySelector("#right").textContent), m, 15000));
    await p.click('.modes [data-mode="facility"]');
  }
  // dispatch
  await p.click('#right [data-act="dispatch"]');
  ok("3D: route planned", await waitFor(p, () => window.__app.route?.ok && window.__app.robot.moving));
  const v = await p.evaluate(() => window.__app.route.validation);
  ok("3D: route collision-free", v.collision_free && v.collisions === 0, `min clearance ${v.min_clearance_m} m`);
  ok("3D: robot moves", await waitFor(p, () => window.__app.robot.s > 0.3, null, 30000));
  // block aisle → detour
  const len0 = await p.evaluate(() => window.__app.route.length_m);
  await p.click('#dock [data-d="block"]');
  ok("3D: block aisle reroutes", await waitFor(p, () => window.__app.blocks.length === 1 && !!window.__app.prevRoute, null, 15000), `before ${len0} m`);
  // pause, reverse, scrub
  await p.click('#dock [data-d="play"]');
  ok("3D: pause", await waitFor(p, () => !window.__app.robot.moving, null, 5000));
  await p.evaluate(() => { const s = document.querySelector("#scrub"); s.value = 500; s.dispatchEvent(new Event("input", { bubbles: true })); });
  const mid = await p.evaluate(() => window.__app.robot.s / window.__app.robot.len);
  ok("3D: scrub to middle", Math.abs(mid - 0.5) < 0.01, mid.toFixed(3));
  const seenMid = await p.evaluate(() => window.__app.seen.size);
  await p.click('#dock [data-d="reverse"]');
  ok("3D: reverse plays backwards", await waitFor(p, () => window.__app.robot.dir < 0 && window.__app.robot.s / window.__app.robot.len < 0.45, null, 30000));
  await p.click('#dock [data-d="reverse"]');
  const seenBack = await p.evaluate(() => window.__app.seen.size);
  ok("3D: proximity follows scrubbing", seenBack <= seenMid, `${seenMid} → ${seenBack} objects`);
  await p.screenshot({ path: `${SHOTS}/3d-route.png` });
  // scrub to the end → arrival → diagnosis
  await p.evaluate(() => { const s = document.querySelector("#scrub"); s.value = 1000; s.dispatchEvent(new Event("input", { bubbles: true })); });
  ok("3D: arrival diagnosis", await waitFor(p, () => /P-005 diagnosis/.test(document.querySelector("#right").textContent), null, 20000));
  const diag = await p.evaluate(() => document.querySelector("#right").innerText);
  ok("3D: plain-language summary", /In plain words/.test(diag));
  ok("3D: citations rendered", await p.evaluate(() => document.querySelectorAll("#right .cite").length >= 3));
  await p.click('#right [data-tab="evidence"]');
  ok("3D: evidence tab shows telemetry", await p.evaluate(() => document.querySelectorAll("#right .sig").length >= 3));
  await p.click('#right [data-tab="overview"]');
  await p.screenshot({ path: `${SHOTS}/3d-diagnosis.png` });
  // minimise + focus
  await p.click("#right [data-min-card]");
  ok("3D: card minimises", await p.evaluate(() => document.querySelector("#right").classList.contains("min")));
  await p.click("#right [data-min-card]");
  await p.keyboard.press("f");
  ok("3D: focus mode hides panels", await p.evaluate(() => getComputedStyle(document.querySelector("#right")).display === "none"));
  await p.screenshot({ path: `${SHOTS}/3d-focus.png` });
  await p.keyboard.press("Escape");
  // camera modes
  for (const c of ["broadcast", "top", "free", "chase"]) { await p.click(`#dock [data-cam="${c}"]`); await sleep(300); }
  ok("3D: camera modes", (await p.evaluate(() => window.__app.cam)) === "chase");
  // X-Ray for every device type
  await p.click('#right [data-act="xray"]');
  ok("3D: X-Ray opens", await waitFor(p, () => window.__app.mode === "xray" && window.__app.xClass === "PROCESS_PUMP", null, 15000));
  await sleep(1200);
  await p.screenshot({ path: `${SHOTS}/3d-xray-pump.png` });
  for (const cls of ["ELECTRIC_MOTOR", "CONTROL_VALVE", "PRESSURE_TRANSMITTER", "VIBRATION_SENSOR"]) {
    await p.click(`#dock [data-xclass="${cls}"]`);
    const good = await waitFor(p, (c) => window.__app.xClass === c && window.__app.xray.pickables().length > 3, cls, 15000);
    ok(`3D: X-Ray ${cls}`, good, `${await p.evaluate(() => window.__app.xray.pickables().length)} parts`);
    await sleep(900);
    await p.screenshot({ path: `${SHOTS}/3d-xray-${cls.toLowerCase()}.png` });
  }
  // Learn, Practice, Value
  for (const m of ["learn", "practice", "value", "facility"]) { await p.click(`.modes [data-mode="${m}"]`); await sleep(800); }
  ok("3D: modes cycle", (await p.evaluate(() => window.__app.mode)) === "facility");
  ok("3D: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await browser.close();
}

// ------------------------------------------------------------------ 2. copilot commands (both views share the router)
async function copilot() {
  const browser = await chromium.launch({ args: GL });
  const p = await page(browser);
  await p.goto(BASE + "#plan");
  await waitFor(p, () => window.__plan?.data);
  const cases = [
    ["Where is the faulty pump?", (a) => a.selected === "P-005"],
    ["Find the equipment with abnormal vibration", (a) => !!a.selected],
    ["Send a technician to inspect the faulty pump", (a) => a.route && a.nav === "P-005"],
    ["Explain the electric motor", (a) => /motor/i.test(a.text)],
    ["Where are the control valves?", (a) => /Found \d+ object/.test(a.text)],
    ["Show me the relevant manual", (a) => a.sheet && !/Found \d+ object/.test(a.text)],
    ["What does the impeller do?", (a) => /impeller/i.test(a.text) && /KB-XRAY-PROCESS_PUMP#impeller|\[/.test(a.text)],
    ["How do I inspect the positioner?", (a) => /positioner/i.test(a.text)],
    ["Send the robot to M-006", (a) => a.route && a.nav === "M-006"],
    ["Why is it losing flow?", (a) => !/Mapped to scene object/.test(a.text) && a.text.length > 40],
    ["asdfgh", (a) => a.text.length > 5],
    ["What's wrong with P-005?", (a) => /P-005 diagnosis/.test(a.card)],
    ["Which motor is overheating?", (a) => a.selected === "M-006"],
    ["Where is the vibration sensor?", (a) => /Found \d+ object/.test(a.text)],
    ["Can I practise inspecting this equipment?", (a) => !/went wrong/.test(a.text) && /Practice/.test(a.text)],
  ];
  for (const [q, check] of cases) {
    await p.evaluate(() => { const s = document.querySelector("#sheet"); s.classList.add("hidden"); });
    await p.evaluate((q) => window.__ask(q), q);
    await sleep(400);
    const a = await p.evaluate(() => ({ text: document.querySelector("#pop").innerText, selected: window.__plan.selected?.asset?.tag, route: !!window.__plan.route,
      nav: window.__plan.navObject?.asset?.tag, card: document.querySelector("#right").textContent, sheet: !document.querySelector("#sheet").classList.contains("hidden") }));
    ok(`Copilot: “${q}”`, check(a) && !/went wrong/.test(a.text), a.text.replace(/\s+/g, " ").slice(0, 110));
  }
  ok("Copilot: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await browser.close();
}

// ------------------------------------------------------------------ 3. WebGL disabled → floor plan; a judge can dispatch and read the result
async function noWebGL() {
  const browser = await chromium.launch({ args: NO_GL });
  const p = await page(browser);
  await p.goto(BASE);
  ok("No WebGL: WebGL really is off", await p.evaluate(() => !document.createElement("canvas").getContext("webgl2") && !document.createElement("canvas").getContext("webgl")));
  ok("No WebGL: floor plan opens", await waitFor(p, () => document.body.classList.contains("plan-mode") && window.__plan?.data && !document.querySelector("#loading"), null, 30000));
  ok("No WebGL: banner explains why", /WebGL 2/.test(await p.textContent(".plan-banner")));
  ok("No WebGL: assets selectable in the list", (await p.$$("#left [data-asset]")).length >= 20);
  await p.screenshot({ path: `${SHOTS}/plan-home.png` });
  // select by clicking a dot on the map
  const pos = await p.evaluate(() => { const P = window.__plan, o = P.data.objects.find((x) => x.asset?.tag === "M-012") || P.data.objects.find((x) => x.asset && !x.asset.is_target);
    return [P.view.ox + (o.center[0] - P.grid.x0) * P.view.k, P.view.oy + (o.center[2] - P.grid.z0) * P.view.k, o.asset.tag]; });
  await p.mouse.click(pos[0], pos[1]);
  ok("No WebGL: click a dot selects the asset", (await p.evaluate(() => window.__plan.selected?.asset?.tag)) === pos[2], pos[2]);
  await p.click('#right [data-close-card]');
  ok("No WebGL: closing the card returns to the overview", !!(await p.$('#right [data-act="dispatch"]')));
  await p.click('#right [data-act="dispatch"]');
  ok("No WebGL: route shown", await waitFor(p, () => window.__plan.path && window.__plan.robot.playing));
  ok("No WebGL: route collision-free", await p.evaluate(() => window.__plan.route.validation.collision_free));
  await sleep(2500);
  await p.click('#dock [data-d="block"]');
  ok("No WebGL: block aisle reroutes", await waitFor(p, () => window.__plan.blocks.length === 1, null, 15000));
  await p.screenshot({ path: `${SHOTS}/plan-route.png` });
  await p.click('#dock [data-rate="4"]');
  ok("No WebGL: robot arrives, P-005 diagnosis shown", await waitFor(p, () => /P-005 diagnosis/.test(document.querySelector("#right").textContent), null, 90000));
  const text = await p.innerText("#right");
  ok("No WebGL: result readable (summary, confidence, next steps)", /In plain words/.test(text) && /Confidence/.test(text) && /Next safe steps/.test(text));
  await p.screenshot({ path: `${SHOTS}/plan-diagnosis.png` });
  await p.click('#right [data-tab="evidence"]');
  ok("No WebGL: P-005 evidence (telemetry, events)", (await p.$$("#right .sig")).length >= 3 && /Alarms and events/.test(await p.innerText("#right")));
  await p.screenshot({ path: `${SHOTS}/plan-evidence.png` });
  await p.click('#right [data-tab="sources"]');
  await p.click("#right .doc");
  ok("No WebGL: source document opens", await waitFor(p, () => !document.querySelector("#sheet").classList.contains("hidden"), null, 5000));
  await p.click("[data-close-sheet]");
  await p.click('#right [data-tab="overview"]');
  await p.click('#right [data-act="wo"]');
  ok("No WebGL: work order draft", await waitFor(p, () => /Work order draft/.test(document.querySelector("#sheet").textContent), null, 5000));
  await p.click("[data-close-sheet]");
  await p.click('#right [data-act="parts"]');
  ok("No WebGL: component list instead of X-Ray", await waitFor(p, () => /Suspected/.test(document.querySelector("#right").textContent), null, 5000));
  // reverse + scrub in the floor plan
  await p.click('#dock [data-d="reverse"]');
  ok("No WebGL: reverse playback", await waitFor(p, () => window.__plan.robot.s < window.__plan.path.len * 0.9, null, 15000));
  ok("No WebGL: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await browser.close();
}

// ------------------------------------------------------------------ 4. GPU context lost at runtime → floor plan
async function contextLoss() {
  const browser = await chromium.launch({ args: GL });
  const p = await page(browser);
  await p.goto(BASE + "?qa=1");
  await waitFor(p, () => window.__app?.fac);
  await p.evaluate(() => window.__renderer.getContext().getExtension("WEBGL_lose_context").loseContext());
  ok("Context loss: switches to floor plan", await waitFor(p, () => document.body.classList.contains("plan-mode") && window.__plan?.data, null, 20000),
    await p.evaluate(() => document.querySelector(".plan-banner")?.textContent?.slice(0, 80) || ""));
  await browser.close();
}

// ------------------------------------------------------------------ 5. chunks missing → committed scene.splat
async function chunkFallback() {
  const browser = await chromium.launch({ args: GL });
  const p = await page(browser);
  await p.route(/static\/(hq\/)?scan(\.json|-hq\.json|-\d+\.wasm)/, (r) => r.fulfill({ status: 404, body: "missing" }));   // classic + full-fidelity chunks
  let full = false;
  p.on("request", (r) => { if (/data\/scene\.splat/.test(r.url())) full = true; });
  await p.goto(BASE + "?qa=1");
  await waitFor(p, () => window.__app?.fac);
  const src = await waitFor(p, () => /fallback/.test(window.__app.fac.scanSource || ""), null, 20000);
  const hosted = await p.evaluate(async () => (await fetch("./data/scene.splat", { method: "HEAD" })).ok);
  ok("Chunks missing: falls back to data/scene.splat", src && full, hosted ? "scene.splat served" : "scene.splat not served here (hosted artifact ships chunks only)");
  if (hosted) ok("Chunks missing: scan still renders", await waitFor(p, () => window.__app.fac.previews.length > 0, null, 120000));
  await browser.close();
}

// ------------------------------------------------------------------ 6. phone layout (3D and floor plan)
async function phone() {
  const browser = await chromium.launch({ args: GL });
  for (const [name, url] of [["3D", BASE + "?scan=off"], ["plan", BASE + "#plan"]]) {
    const p = await page(browser, { ...devices["iPhone 13"] });
    await p.goto(url);
    await waitFor(p, () => (window.__app?.fac || window.__plan?.data) && !document.querySelector("#loading"), null, 60000);
    await sleep(1500);
    const m = await p.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      right: (() => { const r = document.querySelector("#right").getBoundingClientRect(); return r.width > 0 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1; })(),
      dock: (() => { const r = document.querySelector("#dock").getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; })(),
      ask: document.querySelector("#ask").getBoundingClientRect().width > 80,
    }));
    ok(`Phone ${name}: no sideways scroll`, !m.overflowX);
    ok(`Phone ${name}: card and dock on screen`, m.right && m.dock, JSON.stringify(m));
    ok(`Phone ${name}: ask field usable`, m.ask);
    await p.screenshot({ path: `${SHOTS}/phone-${name}.png` });
    if (name === "plan") {
      await p.tap('#right [data-act="dispatch"]');
      ok("Phone plan: dispatch by tap", await waitFor(p, () => window.__plan.route?.ok, null, 15000));
    }
    ok(`Phone ${name}: no page errors`, p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
    await p.context().close();
  }
  await browser.close();
}

// ------------------------------------------------------------------ 7. top bar reachable on tablet and laptop widths
async function topbar() {
  const browser = await chromium.launch({ args: GL });
  for (const [name, opts] of [["iPad Mini", devices["iPad Mini"]], ["1280x720", { viewport: { width: 1280, height: 720 } }], ["900x700", { viewport: { width: 900, height: 700 } }]]) {
    const p = await page(browser, opts);
    await p.goto(BASE + "?scan=off", { waitUntil: "domcontentloaded" });
    await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading"));
    const blocked = await p.evaluate(() => [...document.querySelectorAll(".modes button, #tourBtn, #libBtn, #ask")].filter((b) => {
      const r = b.getBoundingClientRect(); if (!r.width) return true;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(hit === b || b.contains(hit) || hit?.closest("label")?.contains(b));
    }).map((b) => b.dataset.mode || b.id));
    ok(`Top bar ${name}: every control reachable`, blocked.length === 0, blocked.join(", "));
    await p.screenshot({ path: `${SHOTS}/topbar-${name.replace(/\W/g, "")}.png` });
    await p.context().close();
  }
  await browser.close();
}

// ------------------------------------------------------------------ 8. guided tour runs end to end
async function tour() {
  const browser = await chromium.launch({ args: GL });
  const p = await page(browser);
  await p.goto(BASE + "?scan=off", { waitUntil: "domcontentloaded" });
  await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading"));
  await p.click("#tourBtn");
  const n = +(await p.textContent(".tour .h span")).match(/of (\d+)/)[1];
  for (let i = 1; i < n; i++) { await sleep(i === 5 || i === 6 ? 6000 : 2500); await p.click(".tour [data-tour-n]"); }
  await sleep(2500);
  ok("Tour: reaches the last step", /Why it matters/.test(await p.textContent(".tour")), `${n} steps`);
  await p.screenshot({ path: `${SHOTS}/tour-last.png` });
  await p.click(".tour [data-tour-n]");
  ok("Tour: closes", !(await p.$(".tour")));
  ok("Tour: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await browser.close();
}

const only = process.argv.slice(2);
const suites = { threeD, copilot, noWebGL, contextLoss, chunkFallback, phone, topbar, tour };
try {
  for (const [k, f] of Object.entries(suites)) if (!only.length || only.includes(k)) { console.log(`\n— ${k}`); try { await f(); } catch (e) { ok(`${k}: crashed`, false, e.message.split("\n").slice(0, 12).join(" / ")); } }
} finally { server?.kill(); }
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
