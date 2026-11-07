// End-to-end check of the Remote Support hand-off, standalone. Run after `npm run build`:
//   node tests/e2e-support.mjs            (starts `vite preview` on a random port)
//   BASE=http://localhost:5173/ node tests/e2e-support.mjs
// Round trip: technician pins two notes + asks a question + captures the view -> share link ->
// a NEW page opens the link as the expert (pins, question, camera restored) -> expert pins, drafts with AI
// (must confirm review), opens a work-order draft, sends back -> a third page opens the reply as the technician.
// Also: import by pasted code, package .json download (with snapshot), the scripted example (APP.support.demo()).
// Exits non-zero on any failure. Screenshots go to tests/shots/support-*.png.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  return p;
}
const waitFor = async (p, fn, arg, ms = 60000) => { try { await p.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; } catch { return false; } };
const booted = (p) => waitFor(p, () => window.__xr?.S?.fac && window.__xr.support && !document.querySelector("#loading"));
const st = (p) => p.evaluate(() => { const s = window.__xr.support.state(); return { role: s.role, from: s.from, round: s.round, pins: s.pins.map((x) => ({ role: x.role, text: x.text, obj: x.obj, ex: x.ex })), question: s.question, rec: s.rec, recAi: s.recAi, reviewed: s.reviewed, wo: s.wo, received: s.received, snapshot: !!s.snapshot }; });

/** Screen point in the free middle of the view whose click ray hits an object frame ("object") or only the floor ("floor"). */
const screenPoint = (p, kind, objectId = null) => p.evaluate(([kind, objectId]) => {
  const A = window.__xr, T = A.THREE, rc = new T.Raycaster(), v = new T.Vector2();
  const free = (x, y) => { const el = document.elementFromPoint(x, y); return el === A.canvas; };
  if (objectId) {   // project the object's centre first, then search around it
    const o = A.S.objById.get(objectId), c = new T.Vector3(...o.center).project(A.camera);
    const cx = (c.x + 1) / 2 * innerWidth, cy = (1 - c.y) / 2 * innerHeight;
    for (let r = 0; r < 120; r += 6) for (let a = 0; a < 6.28; a += 0.5) {
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (!free(x, y)) continue;
      v.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); rc.setFromCamera(v, A.camera);
      if (A.S.fac.pick(rc.ray) === objectId) return [x, y];
    }
    return null;
  }
  for (let y = innerHeight * 0.85; y > innerHeight * 0.3; y -= 12) for (let x = innerWidth * 0.3; x < innerWidth * 0.68; x += 14) {
    if (!free(x, y)) continue;
    v.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); rc.setFromCamera(v, A.camera);
    const hit = A.S.fac.pick(rc.ray);
    if ((kind === "floor") === !hit && rc.ray.direction.y < -0.05) return [x, y];
  }
  return null;
}, [kind, objectId]);

async function placePin(p, kind, text, objectId) {
  await p.click('#dock [data-sd="pin"]');
  const pt = await screenPoint(p, kind, objectId);
  if (!pt) return false;
  await p.mouse.click(pt[0], pt[1]);
  if (!(await waitFor(p, () => !!document.getElementById("supPinText"), null, 5000))) return false;
  await p.fill("#supPinText", text);
  await p.click('#right [data-sa="pin-save"]');
  return true;
}

const browser = await chromium.launch({ args: GL });
try {
  // ------------------------------------------------------------ 1. technician
  const A = await newPage(browser);
  await A.goto(BASE + "?scan=off");
  ok("tech: app boots with APP.support", await booted(A));
  await A.evaluate(() => document.querySelector(".toast")?.remove());
  await A.click('.modes [data-mode="support"]');
  ok("tech: Support mode is on", await waitFor(A, () => window.__xr.S.mode === "support" && document.querySelector("#supBanner"), null, 5000));
  const honest = "Asynchronous hand-off: the context travels in the link/package. No live multi-user session in this prototype. No connection to plant controls.";
  ok("tech: persistent honesty label", (await A.textContent("#right")).includes(honest));
  ok("tech: banner says no live session", /no live session/i.test(await A.textContent("#supBanner")));
  const target = await A.evaluate(() => ({ obj: window.__xr.S.target.id, tag: window.__xr.S.target.asset.tag, aid: window.__xr.S.target.asset.asset_id }));
  ok("tech: P-005 is the shared asset by default", (await A.textContent("#right .h1")).includes(target.tag), target.tag);
  await A.evaluate((id) => window.__xr.selectAsset(id, { fly: true }), target.aid);
  await sleep(1600);
  ok("tech: pin 1 on the pump", await placePin(A, "object", "Casing warm, rattle at full load", target.obj));
  ok("tech: pin 2 on the floor", await placePin(A, "floor", "Service area in front of the pump"));
  let s = await st(A);
  ok("tech: two pins, first linked to the pump", s.pins.length === 2 && s.pins[0].obj === target.obj && s.pins[1].obj === null, JSON.stringify(s.pins.map((x) => x.obj)));
  ok("tech: pins drawn as 3D markers", await waitFor(A, () => document.querySelectorAll(".labels .sup-pin").length === 2, null, 10000));
  ok("tech: pins listed on the left", (await A.locator("#left [data-spin]").count()) === 2);
  await A.fill("#supQ", "Can it run until the weekend stop? What should I check first?");
  await A.click('#dock [data-sd="capture"]');
  ok("tech: view captured as PNG", (await st(A)).snapshot && (await A.locator("#right img.sup-shot").count()) === 1);
  await A.click('#right [data-sa="share"]');
  ok("tech: share produces a link", await waitFor(A, () => document.getElementById("supLink")?.value.includes("#support="), null, 5000));
  const link1 = await A.inputValue("#supLink"), code1 = await A.inputValue("#supCode");
  ok("tech: link is short enough to paste", link1.length < 2000, `${link1.length} chars`);
  await A.screenshot({ path: `${SHOTS}/support-1-technician.png` });
  const [dl] = await Promise.all([A.waitForEvent("download"), A.click('#right [data-sa="dl-json"]')]);
  const pkg = JSON.parse(readFileSync(await dl.path(), "utf8"));
  ok("tech: package .json has pins, question, honesty and the snapshot", pkg.format === "industrial-xray-support/1" && pkg.pins.length === 2 && pkg.question && pkg.honesty === honest && pkg.snapshot_png?.startsWith("data:image/png"), dl.suggestedFilename());
  const [dm] = await Promise.all([A.waitForEvent("download"), A.click('#right [data-sa="dl-md"]')]);
  const md = readFileSync(await dm.path(), "utf8");
  ok("tech: summary .md has the link and the honesty note", md.includes(link1) && md.includes(honest));

  // ------------------------------------------------------------ 2. expert opens the link in a new page
  const B = await newPage(browser);
  await B.goto(link1);
  ok("expert: app boots", await booted(B));
  ok("expert: opens in Support as the expert", await waitFor(B, () => window.__xr.S.mode === "support" && window.__xr.support.state().role === "expert" && window.__xr.support.state().pins.length === 2, null, 10000));
  ok("expert: banner says Expert view", /Expert view/.test(await B.textContent("#supBanner")));
  ok("expert: the technician's question is shown", (await B.textContent("#right .sup-quote")).includes("weekend stop"));
  ok("expert: pins restored as markers", await waitFor(B, () => document.querySelectorAll(".labels .sup-pin.technician").length === 2, null, 10000));
  ok("expert: hash cleared after loading", !(await B.evaluate(() => location.hash)));
  // the camera tween advances at most 50 ms per rendered frame: on a software GPU that takes a few seconds
  ok("expert: camera view restored", await waitFor(B, () => { const a = window.__xr.controls.target.toArray(), b = window.__xr.support.state().camera.target; return a.every((x, i) => Math.abs(x - b[i]) < 0.05); }, null, 20000),
    JSON.stringify(await B.evaluate(() => [window.__xr.controls.target.toArray(), window.__xr.support.state().camera.target])));
  ok("expert: pin on the pump", await placePin(B, "object", "Check the suction strainer first", target.obj));
  await B.click('#right [data-sa="ai"]');
  ok("expert: AI draft appears, labelled for review", await waitFor(B, () => /AI draft — the expert must review/.test(document.querySelector("#right .sup-ai")?.textContent || ""), null, 15000));
  ok("expert: AI draft has citations", (await B.locator("#right .sup-ai .cite").count()) > 0);
  await B.screenshot({ path: `${SHOTS}/support-2-expert-ai.png` });
  await B.click('#right [data-sa="use-ai"]');
  ok("expert: draft copied into the recommendation", (await B.inputValue("#supRec")).length > 40 && (await st(B)).recAi);
  await B.click('#right [data-sa="share"]');
  ok("expert: cannot send an AI draft before confirming review", !(await B.locator("#supLink").count()));
  await B.check("#supRev");
  await B.click('#right [data-sa="wo"]');
  ok("expert: work-order draft opens (draft only)", await waitFor(B, () => !document.getElementById("sheet").classList.contains("hidden") && /Work order draft/.test(document.getElementById("sheet").textContent) && /no control actions/.test(document.getElementById("sheet").textContent), null, 8000));
  await B.click("#sheet [data-close-sheet]");
  await B.click('#right [data-sa="share"]');
  ok("expert: send back produces a new link", await waitFor(B, () => document.getElementById("supLink")?.value.includes("#support="), null, 5000));
  const link2 = await B.inputValue("#supLink"), code2 = await B.inputValue("#supCode");
  s = await st(B);
  ok("expert: round 2 from the expert", s.round === 2 && s.from === "expert" && s.reviewed && s.wo, JSON.stringify({ r: s.round, f: s.from }));
  await B.screenshot({ path: `${SHOTS}/support-3-expert-sent.png` });

  // ------------------------------------------------------------ 3. technician opens the reply
  const C = await newPage(browser);
  await C.goto(link2);
  ok("reply: opens as the technician", await booted(C) && await waitFor(C, () => window.__xr.support.state().role === "technician" && window.__xr.support.state().received, null, 10000));
  s = await st(C);
  ok("reply: 3 pins incl. the expert's", s.pins.length === 3 && s.pins.filter((x) => x.role === "expert").length === 1);
  ok("reply: recommendation shown with citations", (await C.locator("#right .sup-quote.expert .cite").count()) > 0);
  ok("reply: AI assistance disclosed", /Started from an AI draft; the expert confirmed they reviewed it/.test(await C.textContent("#right")));
  ok("reply: suggested work-order draft can be opened", (await C.locator('#right [data-sa="wo"]').count()) === 1);
  await C.screenshot({ path: `${SHOTS}/support-4-technician-reply.png` });

  // ------------------------------------------------------------ 4. import by code (links stripped in an iframe)
  await A.click('#dock [data-sd="import"]');
  await A.fill("#supImport", code2);
  await A.click('#right [data-sa="import"]');
  ok("import: pasted code opens the reply", await waitFor(A, () => window.__xr.support.state().round === 2 && window.__xr.support.state().pins.length === 3, null, 5000));
  await A.click('#dock [data-sd="import"]');
  await A.fill("#supImport", "not a package");
  await A.click('#right [data-sa="import"]');
  ok("import: junk is rejected politely", (await st(A)).round === 2 && /not a support package/.test(await A.textContent(".toast")));
  const roundTrip = await A.evaluate(async (c) => { const k = await window.__xr.support.decode(c); return k.pins.length === 2 && k.question.includes("weekend"); }, code1);
  ok("codec: code decodes to the same package", roundTrip);

  // ------------------------------------------------------------ 5. scripted example (tour / demo video)
  const D = await newPage(browser);
  await D.goto(BASE + "?scan=off");
  await booted(D);
  await D.evaluate(() => document.querySelector(".toast")?.remove());
  await D.evaluate(async () => { await window.__xr.support.demo(); await window.__xr.support.demo(); });
  s = await st(D);
  ok("demo: idempotent, 2 technician + 1 expert pin, all examples", s.pins.length === 3 && s.pins.filter((x) => x.role === "technician").length === 2 && s.pins.every((x) => x.ex), JSON.stringify(s.pins.map((x) => x.role)));
  ok("demo: labelled Example in 3D, card and banner", await waitFor(D, () => document.querySelectorAll(".labels .sup-pin.ex em").length === 3, null, 10000) && /Example/.test(await D.textContent("#supBanner")) && /Scripted for the demo/.test(await D.textContent("#right")));
  await waitFor(D, () => { const a = window.__xr.controls.target.toArray(), b = window.__xr.support.state().camera.target; return a.every((x, i) => Math.abs(x - b[i]) < 0.05); }, null, 20000);
  await D.screenshot({ path: `${SHOTS}/support-5-demo.png` });
  await D.click('.modes [data-mode="facility"]');
  ok("exit: pins and banner removed outside Support", (await D.locator(".labels .sup-pin").count()) === 0 && !(await D.locator("#supBanner").count()));

  for (const [n, p] of [["technician", A], ["expert", B], ["reply", C], ["demo", D]]) ok(`${n}: no page errors`, !p.errors.length, p.errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("support suite crashed", false, e.message.split("\n").slice(0, 8).join(" / "));
} finally {
  await browser.close();
  server?.kill();
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
