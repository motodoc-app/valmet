// End-to-end checks for the UX layer (navpad.js, guide.js, mobile.js, Plan move pad) in headless Chromium.
// Run after `npm run build`:  node tests/e2e-ux.mjs   (or BASE=http://localhost:5173 node tests/e2e-ux.mjs)
// Covers: the on-screen pad turns / walks / zooms the camera measurably (Explore and X-Ray), keyboard walking and
// turning, keys yield to the Plan proxy while it is being moved, coach cards show once per tab and reopen from
// "How to use", tab tooltips, Plan move buttons + Done, phone layout (Tools sheet, Plan/Support in the bottom
// sheet, no sideways scroll, 44 px targets). Screenshots go to tests/shots/ux-*.png. Exits non-zero on failure.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = (() => { try { return require("playwright"); } catch { return require("@playwright/test"); } })();
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || path.join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4800 + Math.floor(Math.random() * 190);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "ignore", detached: true });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);
const stopServer = () => { if (server) { try { process.kill(-server.pid); } catch { server.kill(); } } };

async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  p.setDefaultTimeout(60000);
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(BASE + "?scan=off");
  await p.waitForFunction(() => window.__xr?.navpad && window.__xr?.guide && window.__app?.fac && !document.querySelector("#loading"), null, { timeout: 120000 });
  return p;
}
const cam = (p, x = false) => p.evaluate((x) => { const A = window.__xr, c = x ? A.xCam : A.camera, t = x ? A.xControls.target : A.controls.target;
  return { p: c.position.toArray(), t: t.toArray(), yaw: Math.atan2(c.position.x - t.x, c.position.z - t.z), d: c.position.distanceTo(t) }; }, x);
const angle = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
async function hold(p, sel, ms) {
  const b = await p.$(sel); const r = await b.boundingBox();
  await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await p.mouse.down(); await sleep(ms); await p.mouse.up();
  await sleep(150);
}
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none"; }, sel);

const browser = await chromium.launch({ args: GL });
try {
  // ------------------------------------------------------------ desktop
  const p = await open(browser, { viewport: { width: 1440, height: 900 } });
  ok("Explore coach card shows on first visit", await p.waitForSelector('.gd-coach[data-mode="facility"]', { timeout: 10000 }).then(() => true, () => false));
  ok("Coach has three plain-language steps", (await p.$$(".gd-coach .gd-steps li")).length === 3);
  ok("Purpose strip under the tabs", /Look around the scanned room/.test(await p.textContent("#gdStrip")));
  ok("Every tab has a plain-language tooltip", await p.evaluate(() => [...document.querySelectorAll(".modes button[data-mode]")].every((b) => b.title.length > 20 && b.getAttribute("aria-label"))));
  await p.screenshot({ path: path.join(SHOTS, "ux-1-explore-coach.png") });
  await p.click(".gd-coach .btn.primary");
  ok("Coach closes with Got it", !(await p.$(".gd-coach")));
  ok("Navigation pad visible on desktop", await visible(p, "#navpad"));
  ok("Pad does not overlap the left card or the mini-map", await p.evaluate(() => {
    const a = document.querySelector("#navpad").getBoundingClientRect();
    return ["#left", "#minimap", "#dock", "#right"].every((s) => { const e = document.querySelector(s); if (!e || e.classList.contains("hidden")) return true; const b = e.getBoundingClientRect(); return a.right <= b.left || a.left >= b.right || a.bottom <= b.top + 1 || a.top >= b.bottom - 1; });
  }));
  await sleep(1300);   // let the initial fly-in finish
  let c0 = await cam(p);
  await hold(p, '#navpad [data-np-a="turnL"]', 700);
  let c1 = await cam(p);
  ok("Pad: hold Turn left orbits the camera", angle(c1.yaw, c0.yaw) > 0.3 && Math.abs(c1.d - c0.d) < 0.05, `${(angle(c1.yaw, c0.yaw) * 57.3).toFixed(0)}°`);
  // turn left = the view swings left: the target moves to the right on screen (camera circles to its right)
  {
    const f = [c0.t[0] - c0.p[0], c0.t[2] - c0.p[2]], right = [-f[1], f[0]];       // camera right on the floor
    ok("Pad: Turn left swings the view left (camera circles to its right)", (c1.p[0] - c0.p[0]) * right[0] + (c1.p[2] - c0.p[2]) * right[1] > 0);
  }
  c0 = await cam(p);
  await hold(p, '#navpad [data-np-a="fwd"]', 600);
  c1 = await cam(p);
  ok("Pad: hold Walk forward moves over the floor", dist2(c1.t, c0.t) > 0.25 && Math.abs(c1.t[1] - c0.t[1]) < 1e-6, `${dist2(c1.t, c0.t).toFixed(2)} m`);
  c0 = await cam(p);
  await hold(p, '#navpad [data-np-a="in"]', 500);
  c1 = await cam(p);
  ok("Pad: Zoom in moves closer", c1.d < c0.d * 0.85, `${c0.d.toFixed(2)} → ${c1.d.toFixed(2)} m`);
  c0 = await cam(p);
  await hold(p, '#navpad [data-np-a="up"]', 400);
  c1 = await cam(p);
  ok("Pad: Look up tilts the camera", c1.p[1] < c0.p[1] - 0.05, `${c0.p[1].toFixed(2)} → ${c1.p[1].toFixed(2)} m high`);
  const q0 = await cam(p);
  await p.click('#navpad [data-np-a="right"]');     // a quick tap still moves
  ok("Pad: a quick tap moves a visible step", dist2((await cam(p)).t, q0.t) > 0.05);

  // keyboard: walk and turn like a game
  await p.evaluate(() => document.activeElement?.blur());
  c0 = await cam(p);
  await p.keyboard.down("w"); await sleep(600); await p.keyboard.up("w"); await sleep(100);
  c1 = await cam(p);
  ok("Keys: W walks forward", dist2(c1.t, c0.t) > 0.25, `${dist2(c1.t, c0.t).toFixed(2)} m`);
  c0 = await cam(p);
  await p.keyboard.down("e"); await sleep(500); await p.keyboard.up("e"); await sleep(100);
  c1 = await cam(p);
  ok("Keys: E turns", angle(c1.yaw, c0.yaw) > 0.25);
  c0 = await cam(p);
  await p.keyboard.down("ArrowLeft"); await sleep(400); await p.keyboard.up("ArrowLeft"); await sleep(100);
  ok("Keys: arrows walk too", dist2((await cam(p)).t, c0.t) > 0.15);
  await p.focus("#ask"); c0 = await cam(p);
  await p.keyboard.press("w"); await p.keyboard.press("a"); await sleep(150);
  ok("Keys: typing in the ask field does not move the camera", dist2((await cam(p)).t, c0.t) < 1e-6 && (await p.inputValue("#ask")) === "wa");
  await p.fill("#ask", ""); await p.evaluate(() => document.activeElement.blur());
  await p.click('#navpad [data-np="reset"]'); await sleep(1300);
  ok("Pad: Reset view flies home", await p.evaluate(() => window.__xr.camera.position.distanceTo(window.__app.home.pos) < 0.05));
  await p.screenshot({ path: path.join(SHOTS, "ux-2-explore-pad.png") });

  // Plan: guide once, move pad, keys drive the proxy while moving, Done → check
  await p.click('.modes [data-mode="plan"]');
  ok("Plan coach card shows on first visit", await p.waitForSelector('.gd-coach[data-mode="plan"]', { timeout: 8000 }).then(() => true, () => false));
  await p.screenshot({ path: path.join(SHOTS, "ux-3-plan-coach.png") });
  await p.click(".gd-coach [data-gd-close]");
  await p.waitForSelector('#right [data-pl-pick="OBJ-028"]');
  ok("Plan: primary action comes before the explanation", await p.evaluate(() => { const b = document.querySelector('#right .pl-big'), t = document.querySelector("#right .plain"); return !!(b && t && (b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)); }));
  await p.click('#right [data-pl-pick="OBJ-028"]');
  await p.waitForSelector('#right [data-pl-mv="left"]');
  const s0 = await p.evaluate(() => window.__xr.planning.getState().moves[0]);
  const o = await p.evaluate(() => window.__app.data.objects.find((x) => x.id === "OBJ-028").center);
  ok("Plan: the proxy starts exactly at the original position (moved 0 m)", Math.hypot(s0.x - o[0], s0.z - o[2]) < 1e-6 && /0\.00 m/.test(await p.textContent("#right .pl-tile")));
  await p.click('#right [data-pl-mv="left"]'); await sleep(120);
  const s1 = await p.evaluate(() => window.__xr.planning.getState().moves[0]);
  ok("Plan: arrow button moves the proxy 5 cm", Math.abs(Math.hypot(s1.x - s0.x, s1.z - s0.z) - 0.05) < 1e-3);
  await hold(p, '#right [data-pl-mv="back"]', 1000);
  const s2 = await p.evaluate(() => window.__xr.planning.getState().moves[0]);
  ok("Plan: holding an arrow keeps moving", Math.hypot(s2.x - s1.x, s2.z - s1.z) > 0.15, `${Math.hypot(s2.x - s1.x, s2.z - s1.z).toFixed(2)} m`);
  await p.click('#right [data-pl-mv="r15"]');
  const s3 = await p.evaluate(() => window.__xr.planning.getState().moves[0]);
  ok("Plan: rotate button turns 15°", Math.abs(Math.abs(Math.atan2(Math.sin(s3.yaw - s2.yaw), Math.cos(s3.yaw - s2.yaw))) - Math.PI / 12) < 1e-3);
  await p.evaluate(() => document.activeElement?.blur());
  c0 = await cam(p);
  await p.keyboard.press("d"); await sleep(120);
  const s4 = await p.evaluate(() => window.__xr.planning.getState().moves[0]);
  ok("Plan: while moving, D moves the proxy and not the camera", Math.abs(Math.hypot(s4.x - s3.x, s4.z - s3.z) - 0.05) < 1e-3 && dist2((await cam(p)).t, c0.t) < 1e-6);
  await p.screenshot({ path: path.join(SHOTS, "ux-4-plan-move.png") });
  await p.click('#right [data-pl="done"]');
  await p.waitForFunction(() => window.__xr.planning.stage() === "check" && document.querySelector("#right .pl-result:not(.wait)"), null, { timeout: 20000 });
  ok("Plan: Done shows step 3 with a plain verdict", /It fits|Still in the way|It hits|Nothing moved|no route/.test(await p.textContent("#right .pl-result")));
  c0 = await cam(p);
  await p.keyboard.press("d"); await sleep(250);
  ok("Plan: after Done, keys walk the camera again", dist2((await cam(p)).t, c0.t) > 0.02);
  await p.click('#right [data-pl="suggest"]');
  await p.waitForFunction(() => /It fits/.test(document.querySelector("#right .pl-result")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
  ok("Plan: Suggest a good spot clears the service zone", (await p.evaluate(() => window.__xr.planning.summary().service_zone.after.clear)) && /It fits/.test(await p.textContent("#right .pl-result")));
  await sleep(800);
  await p.screenshot({ path: path.join(SHOTS, "ux-5-plan-check.png") });

  // coach shows once per tab, reopens on demand
  await p.click('.modes [data-mode="facility"]'); await sleep(700);
  ok("Coach does not come back on the second visit", !(await p.$(".gd-coach")));
  await p.click("#gdStrip [data-gd-open]");
  ok("“How to use” reopens the coach", !!(await p.$('.gd-coach[data-mode="facility"]')));
  await p.keyboard.press("Escape");

  // X-Ray: the pad drives the X-Ray camera
  await p.evaluate(() => window.__enterXRay());
  await p.waitForFunction(() => window.__app.mode === "xray", null, { timeout: 15000 });
  await p.evaluate(() => document.querySelector(".gd-coach [data-gd-close]")?.click());
  await sleep(1800);
  c0 = await cam(p, true);
  await hold(p, '#navpad [data-np-a="turnR"]', 700);
  c1 = await cam(p, true);
  ok("X-Ray: pad turns the X-Ray model view", angle(c1.yaw, c0.yaw) > 0.3, `${(angle(c1.yaw, c0.yaw) * 57.3).toFixed(0)}°`);
  await p.screenshot({ path: path.join(SHOTS, "ux-6-xray-pad.png") });
  ok("Desktop: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();

  // ------------------------------------------------------------ 1280 × 720: nothing collides
  const m = await open(browser, { viewport: { width: 1280, height: 720 } });
  await sleep(2500);
  await m.screenshot({ path: path.join(SHOTS, "ux-7-1280.png") });
  ok("1280×720: pad, coach and cards do not overlap", await m.evaluate(() => {
    const R = (s) => { const e = document.querySelector(s); if (!e || getComputedStyle(e).display === "none" || e.classList.contains("hidden")) return null; const r = e.getBoundingClientRect(); return r.width ? r : null; };
    const hit = (a, b) => a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const pad = R("#navpad"), coach = R(".gd-coach");
    return !["#left", "#minimap", "#dock", "#right"].some((s) => hit(pad, R(s)) || hit(coach, R(s))) && !hit(pad, coach);
  }));
  await m.context().close();

  // ------------------------------------------------------------ phone
  for (const dev of ["iPhone 13", "iPad Mini"]) {
    const ph = await open(browser, { ...devices[dev] });
    const tag = dev.replace(/\W/g, "");
    await sleep(2500);
    const lay = await ph.evaluate(() => ({ over: document.documentElement.scrollWidth > innerWidth + 1, tools: (() => { const r = document.querySelector("#toolsBtn").getBoundingClientRect(); return r.width >= 36 && r.right <= innerWidth; })() }));
    ok(`${dev}: no sideways scroll`, !lay.over);
    ok(`${dev}: Tools button in the top bar`, lay.tools);
    await ph.screenshot({ path: path.join(SHOTS, `ux-${tag}-1-home.png`) });
    await ph.evaluate(() => document.querySelector(".gd-coach [data-gd-close]")?.click());
    await ph.tap("#toolsBtn");
    await ph.waitForSelector("#sheet:not(.hidden) .mt-list");
    const items = await ph.$$eval("#sheet .mt-row", (r) => r.map((x) => x.textContent.trim()));
    ok(`${dev}: Tools sheet lists the rail actions incl. About`, items.length >= 8 && items.some((t) => /About/.test(t)) && items.some((t) => /Scene understanding/i.test(t)), `${items.length} tools`);
    ok(`${dev}: Tools rows are ≥ 44 px`, await ph.$$eval("#sheet .mt-row", (r) => r.every((x) => x.getBoundingClientRect().height >= 44)));
    await ph.screenshot({ path: path.join(SHOTS, `ux-${tag}-2-tools.png`) });
    await ph.tap('#sheet .mt-row[data-mt="help"]');
    ok(`${dev}: About opens from Tools`, await ph.waitForFunction(() => /About this prototype/.test(document.querySelector("#sheet:not(.hidden)")?.textContent || ""), null, { timeout: 5000 }).then(() => true, () => false));
    await ph.tap("#sheet [data-close-sheet]");
    // pad works with touch
    await ph.tap("#navpadOpen");
    ok(`${dev}: Move pad opens`, await visible(ph, "#navpad"));
    c0 = await cam(ph);
    await ph.tap('#navpad [data-np-a="turnL"]'); await sleep(150);
    ok(`${dev}: pad responds to touch`, angle((await cam(ph)).yaw, c0.yaw) > 0.05);
    ok(`${dev}: pad buttons ≥ 44 px`, await ph.$$eval("#navpad .np-btn", (b) => b.every((x) => x.getBoundingClientRect().width >= 44)));
    await ph.screenshot({ path: path.join(SHOTS, `ux-${tag}-3-pad.png`) });
    await ph.tap('#navpad [data-np="hide"]');
    // Plan in the bottom sheet
    await ph.tap('.modes [data-mode="plan"]');
    await ph.waitForSelector('#right [data-pl-pick="OBJ-028"]');
    await ph.evaluate(() => document.querySelector(".gd-coach [data-gd-close]")?.click());
    ok(`${dev}: Plan object search reachable in the sheet`, await visible(ph, "#plQM"));
    await ph.tap('#right [data-pl-pick="OBJ-028"]');
    await ph.waitForSelector('#right [data-pl-mv="fwd"]');
    const t0 = await ph.evaluate(() => window.__xr.planning.getState().moves[0]);
    await ph.tap('#right [data-pl-mv="fwd"]'); await sleep(100);
    const t1 = await ph.evaluate(() => window.__xr.planning.getState().moves[0]);
    ok(`${dev}: Plan move pad works by tap`, Math.hypot(t1.x - t0.x, t1.z - t0.z) > 0.04);
    ok(`${dev}: Plan move buttons ≥ 44 px`, await ph.$$eval("#right .pl-mv", (b) => b.every((x) => x.getBoundingClientRect().width >= 44)));
    ok(`${dev}: Plan card fits the screen, no sideways scroll`, await ph.evaluate(() => { const r = document.querySelector("#right").getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; }));
    await ph.screenshot({ path: path.join(SHOTS, `ux-${tag}-4-plan.png`) });
    await ph.evaluate(() => window.__xr.planning.reset());
    // Support in the bottom sheet
    await ph.tap('.modes [data-mode="support"]');
    await ph.waitForSelector('#right [data-sa="pin"]');
    await ph.evaluate(() => document.querySelector(".gd-coach [data-gd-close]")?.click());
    ok(`${dev}: Support primary buttons first and ≥ 44 px`, await ph.evaluate(() => { const b = [...document.querySelectorAll('#right .sup-actions .btn')]; const h = document.querySelector("#right .sup-honest");
      return b.length === 2 && b.every((x) => x.getBoundingClientRect().height >= 44) && !!(b[0].compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    ok(`${dev}: Support view-as switch reachable in the sheet`, await visible(ph, '#right .sup-row2 [data-srole="expert"]'));
    await ph.tap('#right [data-sa="pin"]');
    ok(`${dev}: Pin a note arms from the card`, await ph.evaluate(() => /Click the room/.test(document.querySelector('#right [data-sa="pin"]').textContent)));
    await ph.screenshot({ path: path.join(SHOTS, `ux-${tag}-5-support.png`) });
    ok(`${dev}: no page errors`, ph.errors.length === 0, ph.errors.slice(0, 3).join(" | "));
    await ph.context().close();
  }
} catch (e) {
  ok("Test run completed", false, e.message.split("\n").slice(0, 6).join(" / "));
} finally {
  await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
