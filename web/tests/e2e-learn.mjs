// Equipment inspection, X-Ray (in-scene panel and full tab) for all five equipment classes, Learn, Practice, the
// Library and the Value calculator, in a real (headless) Chromium. Run after `npm run build`:
//   node tests/e2e-learn.mjs                         static build (starts its own vite preview)
//   BASE=http://localhost:4537/ node tests/e2e-learn.mjs      ONLY=xray,learn,practice,library,value,crawl,layout
// The page runs in ?capture&scan=off: frames render only on window.__step(dt), so the checks are mostly DOM + state
// and do not depend on the machine's speed.
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
  const port = 4600 + Math.floor(Math.random() * 99);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe", env: { ...process.env, XRAY_API: process.env.XRAY_API || "http://127.0.0.1:9" } });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);

async function open(browser, viewport = { width: 1440, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...extra });
  const p = await ctx.newPage();
  p.setDefaultNavigationTimeout(120000); p.setDefaultTimeout(90000);
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(BASE + "?capture&scan=off&noguide", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.xo && !document.querySelector("#loading"), null, { timeout: 120000, polling: 250 });
  await p.evaluate(() => { document.querySelector(".toast")?.remove(); document.querySelector(".gd-coach")?.remove(); });
  return p;
}
const step = (p, n = 1, dt = 1 / 30) => p.evaluate(([n, dt]) => { for (let i = 0; i < n; i++) window.__step(dt); }, [n, dt]);
const near = (a, b, e = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) <= e);
const CLASSES = ["PROCESS_PUMP", "ELECTRIC_MOTOR", "CONTROL_VALVE", "PRESSURE_TRANSMITTER", "VIBRATION_SENSOR"];
/** The asset X-Ray opens for a class: the demo target first, else the least healthy one (it has a suspected part). */
const assetOf = (p, cls) => p.evaluate((cls) => window.__app.data.objects.filter((o) => o.asset?.asset_class === cls).map((o) => o.asset)
  .sort((a, b) => (b.is_target - a.is_target) || a.health_score - b.health_score)[0], cls);
const roomState = (p) => p.evaluate(() => { const A = window.__xr, S = A.S, R = S.robot;
  return { cam: S.cam, p: A.camera.position.toArray(), t: A.controls.target.toArray(), ctl: A.controls.enabled, sel: S.selected?.id || null, s: R.s, moving: R.moving, v: R.v, dir: R.dir }; });

// ------------------------------------------------------------------ 1. inspection in context + X-Ray panel, every class
async function xray(browser) {
  const p = await open(browser);
  const P5 = await p.evaluate(() => { const o = window.__app.data.objects.find((x) => x.asset?.tag === "P-005"); return { id: o.id, a: o.asset.asset_id }; });
  // locate P-005 in the asset list, then select it by clicking it in 3D
  await p.click(`#left [data-asset="${P5.a}"]`);
  await step(p, 60);
  await p.evaluate(() => { window.__xr.S.selected = null; document.querySelector('#dock [data-cam="free"]').click(); });
  const xy = await p.evaluate((id) => { const A = window.__xr, o = A.S.data.objects.find((x) => x.id === id), v = new A.THREE.Vector3(...o.center).project(A.camera); return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight]; }, P5.id);
  await p.mouse.click(xy[0], xy[1]); await step(p, 5);
  const card = await p.evaluate(() => ({ sel: window.__xr.S.selected?.asset?.tag, t: document.querySelector("#right").innerText, xo: !!document.querySelector('#right [data-act="xo-sel"]') }));
  ok("Inspect: P-005 found in the asset list and selected by clicking it in 3D", card.sel === "P-005");
  ok("Inspect: asset card shows health, condition and the X-Ray action", /P-005/.test(card.t) && /Health\s*44/.test(card.t) && /Attention required/.test(card.t) && card.xo, card.t.slice(0, 90).replace(/\n+/g, " | "));
  await p.click('#right [data-act="diagnose-sel"]');
  ok("Inspect: 'What's wrong?' opens the cited diagnosis", await p.waitForFunction(() => /P-005 diagnosis/.test(document.querySelector("#right").textContent) && document.querySelectorAll("#right .cite").length > 2, null, { timeout: 30000 }).then(() => true, () => false));
  await p.evaluate((a) => window.__select(a), P5.a); await step(p, 5);

  for (const cls of CLASSES) {
    const a = await assetOf(p, cls);
    const before = await roomState(p);
    const opened = await p.evaluate((id) => window.__xr.xo.show(id), a.asset_id);
    await sleep(700);                          // the panel explodes the model 450 ms (wall clock) after opening
    await step(p, 45);
    const st = await p.evaluate(() => { const S = window.__xr.S, X = S.xray;
      return { cls: S.xClass, title: document.querySelector("#xoTitle").innerText, badge: document.querySelector("#xo .xo-badge").innerText, rows: document.querySelectorAll(".xo-row").length,
        sus: [...document.querySelectorAll(".xo-row")].filter((r) => r.querySelector(".pill.red")).map((r) => r.dataset.xoComp), lead: S.xDiag.hypotheses[0]?.components || [], flagged: [...X.flagged],
        sel: S.xSelected, part: document.querySelector("#xoPart").innerText, explode: X.target, parts: X.parts.size }; });
    const tag = cls.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
    ok(`X-Ray panel ${tag}: opens ${a.tag}'s model over the room, labelled illustrative`, opened && st.cls === cls && st.rows === st.parts && st.rows >= 7 && /Illustrative teaching model — not reconstructed from the scan/.test(st.badge) && st.title.includes(a.tag) && st.explode > 0.6,
      `${st.rows} parts, explode ${st.explode}`);
    ok(`X-Ray panel ${tag}: suspected parts in red match the diagnosis`, st.lead.length ? st.sus.length === st.lead.length && st.lead.every((c) => st.flagged.includes(c) && st.sus.includes(c)) : st.sus.length === 0,
      `${a.condition_state}: ${st.sus.join(", ") || "none"}`);
    if (st.lead.length) ok(`X-Ray panel ${tag}: suspected part selected and explained (function, failure signs, why)`, st.sel === st.lead[0] && st.part.length > 80 && /Typical failure signs/.test(st.part) && /Linked faults/.test(st.part) && /Suspected for/.test(st.part), st.sel);
    else ok(`X-Ray panel ${tag}: healthy asset: nothing singled out, said plainly (no fault placeholder)`, !st.sel && new RegExp(`No deviation for ${a.tag}`).test(st.part) && !/Unspecified deviation/.test(st.part), st.part.slice(0, 90).replace(/\n/g, " "));
    if (!st.sel) { await p.click(".xo-row"); await step(p, 2); }
    const part2 = await p.evaluate(() => document.querySelector("#xoPart").innerText);
    ok(`X-Ray panel ${tag}: component description (function, linked faults, failure signs)`, part2.length > 80 && /Typical failure signs/.test(part2) && /Linked faults/.test(part2));
    // click a part in the model
    const hit = await p.evaluate(() => { const A = window.__xr, X = A.S.xray, r = document.querySelector("#xoView").getBoundingClientRect(), ray = new A.THREE.Raycaster();
      for (const id of X.order().filter((x) => x !== A.S.xSelected)) { const c = X.partCenter(id).project(A.xo.cam), x = r.left + (c.x + 1) / 2 * r.width, y = r.top + (1 - c.y) / 2 * r.height;
        if (x < r.left + 4 || x > r.right - 4 || y < r.top + 30 || y > r.bottom - 30) continue;
        ray.setFromCamera(new A.THREE.Vector2(c.x, c.y), A.xo.cam); const h = ray.intersectObjects(X.pickables(), false)[0];
        if (h?.object.userData.componentId === id) return { id, x, y }; }
      return null; });
    if (hit) { await p.mouse.click(hit.x, hit.y); await step(p, 3); }
    const picked = await p.evaluate(() => window.__xr.S.xSelected);
    ok(`X-Ray panel ${tag}: clicking a part in the model selects it`, !!hit && picked === hit.id, hit ? `${hit.id} → ${picked}` : "no clickable part");
    // isolate, then pick another part: isolation follows the selection
    await p.click('#xoPart [data-xo="isolate"]'); await step(p, 2);
    const other = await p.evaluate(() => window.__xr.S.xray.order().find((x) => x !== window.__xr.S.xSelected));
    await p.click(`.xo-row[data-xo-comp="${other}"]`); await step(p, 2);
    const iso = await p.evaluate(() => { const X = window.__xr.S.xray, s = window.__xr.S.xSelected; return { s, vis: [...X.parts].filter(([, q]) => q.holder.visible).map(([id]) => id), btn: document.querySelector('#xoPart [data-xo="isolate"]').innerText }; });
    ok(`X-Ray panel ${tag}: "Show only this part" isolates, and follows the next selection`, iso.s === other && iso.vis.length === 1 && iso.vis[0] === other && /Show all parts/.test(iso.btn), JSON.stringify(iso));
    await p.click('#xoPart [data-xo="isolate"]');
    // assemble / explode toggle
    await p.click('#xo [data-xo="assemble"]'); const t0 = await p.evaluate(() => [window.__xr.S.xray.target, document.querySelector('#xo [data-xo="assemble"]').innerText]);
    await p.click('#xo [data-xo="assemble"]'); const t1 = await p.evaluate(() => [window.__xr.S.xray.target, document.querySelector('#xo [data-xo="assemble"]').innerText]);
    ok(`X-Ray panel ${tag}: assemble / explode`, t0[0] === 0 && /Explode/.test(t0[1]) && t1[0] > 0.6 && /Assemble/.test(t1[1]), JSON.stringify([t0, t1]));
    // close (× for the first two, Esc for the rest) restores the room exactly
    if (CLASSES.indexOf(cls) < 2) await p.click('#xo [data-xo="close"]'); else await p.keyboard.press("Escape");
    await step(p, 1);
    const after = await roomState(p);
    ok(`X-Ray panel ${tag}: ${CLASSES.indexOf(cls) < 2 ? "×" : "Esc"} closes and restores camera pose, mode, robot and selection`,
      !(await p.evaluate(() => window.__xr.xo.open)) && after.cam === before.cam && near(after.p, before.p) && near(after.t, before.t) && after.sel === before.sel && after.s === before.s && after.moving === before.moving && after.ctl === before.ctl);
  }

  // Robot POV: the panel opens over the robot's view and the POV pose comes back
  await p.click('#dock [data-cam="pov"]'); await step(p, 40);
  const bp = await roomState(p);
  await p.evaluate(() => window.__xr.xo.show(window.__xr.S.target.asset.asset_id)); await step(p, 30);
  const hud = await p.evaluate(() => document.querySelector("#povHud").classList.contains("hidden"));
  await p.keyboard.press("Escape"); await step(p, 1);
  const ap = await roomState(p); await step(p, 20); const ap2 = await roomState(p);
  ok("X-Ray panel in Robot POV: POV HUD hidden while open; Esc restores the POV pose", hud && ap.cam === "pov" && near(ap.p, bp.p) && near(ap.t, bp.t) && near(ap2.p, bp.p, 1e-6), `${bp.p.map((x) => x.toFixed(3))}`);

  // the panel's Diagnosis button opens the diagnosis of the panel's asset (not the one shown before, and never an error)
  const m6 = await assetOf(p, "ELECTRIC_MOTOR");
  await p.evaluate((id) => window.__xr.xo.show(id), m6.asset_id); await step(p, 5);
  await p.click('#xoPart [data-xo="diag"]');
  ok(`X-Ray panel: Diagnosis opens ${m6.tag}'s diagnosis (P-005's was open before)`, await p.waitForFunction((t) => !window.__xr.xo.open && new RegExp(`${t} diagnosis`).test(document.querySelector("#right").textContent), m6.tag, { timeout: 15000 }).then(() => true, () => false) && p.errors.length === 0, p.errors.slice(0, 1).join());

  // full X-Ray tab, every class: dock device switch, part card tabs, ask, isolate following the selection, assemble
  await p.click('.modes [data-mode="xray"]');
  await p.waitForFunction(() => window.__app.mode === "xray" && document.querySelector("#right [data-xtab]"), null, { timeout: 30000 });
  await sleep(1200);                           // entering X-Ray explodes the model 900 ms (wall clock) later
  for (const cls of CLASSES) {
    const tag = cls.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
    await p.click(`#dock [data-xclass="${cls}"]`);
    await p.waitForFunction((cls) => window.__app.xClass === cls && document.querySelector(`#dock [data-xclass="${cls}"]`)?.classList.contains("on"), cls, { timeout: 30000 });
    await step(p, 40);
    const st = await p.evaluate(() => { const S = window.__xr.S; return { left: document.querySelector("#left").innerText, rows: document.querySelectorAll("#left [data-comp]").length, sus: document.querySelectorAll("#left .pill.red").length,
      lead: (S.xDiag.hypotheses[0]?.components || []).length, flagged: S.xray.flagged.size, tagIll: /Illustrative/.test(document.querySelector("#right").innerText), dev: document.querySelector("#xDevice").value, asset: S.xAsset.asset_id }; });
    ok(`X-Ray tab ${tag}: model, component list, suspected parts, illustrative label`, st.rows >= 7 && st.sus === st.lead && st.flagged === st.lead && st.tagIll && st.dev === st.asset, `${st.rows} parts, ${st.sus} suspected`);
    if (!st.lead) await p.click("#left [data-comp]");      // a healthy asset opens with no part singled out
    const tabs = [];
    for (const t of ["evidence", "ask", "overview"]) { await p.click(`#right [data-xtab="${t}"]`); tabs.push(await p.evaluate(() => document.querySelector("#right .tabs .on")?.dataset.xtab)); }
    ok(`X-Ray tab ${tag}: Overview / Evidence / Ask tabs switch`, tabs.join() === "evidence,ask,overview", tabs.join());
    if (cls === "PROCESS_PUMP" || cls === "VIBRATION_SENSOR") {
      await p.click('#right [data-xtab="ask"]'); await p.click('#right [data-act="askpart"]');
      const ans = await p.waitForFunction(() => { const t = document.querySelector("#partA")?.innerText || ""; return !/Looking it up/.test(t) && t.length > 30 && t; }, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => "");
      ok(`X-Ray tab ${tag}: related question answered with sources`, /sources/.test(ans) && ans.length > 60, ans.slice(0, 80).replace(/\n/g, " "));
      await p.click('#right [data-xtab="overview"]');
    }
    const ids = await p.evaluate(() => window.__xr.S.xray.order());
    await p.click(`#left [data-comp="${ids[1]}"]`); await p.click('#right [data-act="isolate"]');
    await p.click(`#left [data-comp="${ids[2]}"]`);
    const iso = await p.evaluate(() => { const X = window.__xr.S.xray; return { s: window.__xr.S.xSelected, vis: [...X.parts].filter(([, q]) => q.holder.visible).map(([id]) => id), btn: document.querySelector('#right [data-act="isolate"]').innerText }; });
    ok(`X-Ray tab ${tag}: "Show only this part" follows the selection`, iso.s === ids[2] && iso.vis.join() === ids[2] && /Show all parts/.test(iso.btn), JSON.stringify(iso));
    await p.click('#right [data-act="isolate"]');
    await p.click('#dock [data-d="assemble"]'); const a0 = await p.evaluate(() => [window.__xr.S.xray.target, document.querySelector('#dock [data-d="assemble"]').innerText]);
    await p.click('#dock [data-d="assemble"]'); const a1 = await p.evaluate(() => [window.__xr.S.xray.target, document.querySelector('#dock [data-d="assemble"]').innerText, document.querySelector("#xpct").textContent]);
    ok(`X-Ray tab ${tag}: dock Assemble / Explode toggles (never a dead button)`, a0[0] === 0 && /Explode/.test(a0[1]) && a1[0] > 0.6 && /Assemble/.test(a1[1]), JSON.stringify([a0, a1]));
  }
  await p.click('#dock [data-d="labels"]'); await p.click('#dock [data-d="ghost"]'); await step(p, 40);
  const lg = await p.evaluate(() => ({ l: window.__xr.S.xray.labelsOn, g: window.__xr.S.xray.ghost, tags: [...document.querySelectorAll(".labels .ptag")].filter((e) => e.offsetParent && e.parentElement.style.display !== "none").length }));
  ok("X-Ray tab: labels and see-through", lg.l && lg.g && lg.tags >= 5, JSON.stringify(lg));
  await p.screenshot({ path: `${SHOTS}/learn-xray-tab.png` }).catch(() => {});
  ok("X-Ray: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 2. Learn: every lesson of every class
async function learn(browser) {
  const p = await open(browser);
  await p.click('.modes [data-mode="learn"]');
  await p.waitForFunction(() => /Lessons/.test(document.querySelector("#right").textContent), null, { timeout: 60000 });
  for (const cls of CLASSES) {
    const tag = cls.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
    const a = await assetOf(p, cls);
    await p.selectOption("#xDevice", a.asset_id);
    await p.waitForFunction((cls) => window.__app.xClass === cls && /Lessons/.test(document.querySelector("#right").textContent), cls, { timeout: 30000 });
    const def = await p.evaluate(() => window.__app.kb.classes[window.__app.xClass].learn_topics.map((t) => ({ id: t.id, steps: t.steps.map((s) => s.focus) })));
    const bad = [];
    for (const t of def) {
      await p.click(`#right [data-topic="${t.id}"]`);
      for (let i = 0; i < t.steps.length; i++) {
        const st = await p.evaluate(() => ({ sub: document.querySelector("#right .sub")?.textContent, hl: [...window.__app.xray.flagged], cites: [...document.querySelectorAll("#right .cite")].map((c) => c.dataset.doc || c.textContent),
          tag: document.querySelector("#right .tag")?.textContent, safety: /Real work needs authorisation, isolation and approved OEM or site procedures/.test(document.querySelector("#right").innerText), ghost: window.__app.xray.ghost, ex: window.__app.xray.target, slider: document.querySelector("#explode")?.value, prevDis: document.querySelector("#lPrev").disabled }));
        if (st.sub !== `Step ${i + 1} of ${t.steps.length}`) bad.push(`${t.id}#${i + 1} sub ${st.sub}`);
        if (JSON.stringify(st.hl.sort()) !== JSON.stringify([...t.steps[i]].sort())) bad.push(`${t.id}#${i + 1} highlight ${st.hl} ≠ ${t.steps[i]}`);
        if (!t.steps[i].every((f) => st.cites.includes(`KB-XRAY-${cls}#${f}`))) bad.push(`${t.id}#${i + 1} missing component citation`);
        if (st.tag !== "Conceptual" || !st.ghost || Math.abs(st.ex - 0.3) > 1e-9 || st.slider !== "30") bad.push(`${t.id}#${i + 1} tag/ghost/explode/slider ${st.tag}/${st.ghost}/${st.ex}/${st.slider}`);
        if (st.prevDis !== (i === 0)) bad.push(`${t.id}#${i + 1} back button`);
        if (!st.safety) bad.push(`${t.id}#${i + 1} no safety note`);
        if (i === 1) { await p.click("#lPrev"); const s0 = await p.evaluate(() => document.querySelector("#right .sub")?.textContent); if (s0 !== `Step 1 of ${t.steps.length}`) bad.push(`${t.id} back → ${s0}`); await p.click("#lNext"); }
        await p.click("#lNext");
      }
      if (!(await p.evaluate(() => /Lessons/.test(document.querySelector("#right").textContent) && document.querySelector("[data-topic]")))) bad.push(`${t.id}: Finish did not return to the lesson list`);
    }
    ok(`Learn ${tag}: ${def.length} lesson(s), ${def.reduce((n, t) => n + t.steps.length, 0)} steps: text, highlighted parts, citations, safety note, back/next/finish`, bad.length === 0, bad.slice(0, 3).join("; "));
  }
  // pump and motor lessons also carry an explicit isolation / lockout step
  const safe = await p.evaluate(() => ["PROCESS_PUMP", "ELECTRIC_MOTOR"].filter((k) => !window.__app.kb.classes[k].learn_topics.some((t) => t.steps.some((s) => /isolation|lockout/i.test(s.text)))));
  await p.click('#right [data-topic]');
  ok("Learn: every step carries the safety note; pump and motor lessons include an isolation step", safe.length === 0, safe.join(","));
  await p.click("#lAll");
  ok("Learn: 'All lessons' returns to the list", await p.evaluate(() => !!document.querySelector("[data-topic]")));
  ok("Learn: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 3. Practice: every class, wrong + right answers, score, retry
async function practice(browser) {
  const p = await open(browser);
  await p.click('.modes [data-mode="practice"]');
  await p.waitForFunction(() => document.querySelector("#pStart"), null, { timeout: 60000 });
  for (const cls of CLASSES) {
    const tag = cls.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
    const a = await assetOf(p, cls);
    await p.selectOption("#xDevice", a.asset_id);
    await p.waitForFunction((cls) => window.__app.xClass === cls && document.querySelector("#pStart"), cls, { timeout: 30000 });
    // safety gate: all three boxes are needed
    const gates = await p.$$("#right .g"), gate = [await p.evaluate(() => document.querySelector("#pStart").disabled)];
    for (const g of gates.slice(0, -1)) await g.check();
    gate.push(await p.evaluate(() => document.querySelector("#pStart").disabled));
    await gates.at(-1).check(); gate.push(await p.evaluate(() => document.querySelector("#pStart").disabled));
    await gates[0].uncheck(); gate.push(await p.evaluate(() => document.querySelector("#pStart").disabled)); await gates[0].check();
    ok(`Practice ${tag}: safety-check gate (3 boxes) unlocks Start`, gates.length === 3 && gate.join() === "true,true,false,true", gate.join());
    await p.click("#pStart");
    const sc = await p.evaluate(() => window.__app.kb.classes[window.__app.xClass].practice_scenarios[0]);
    const bad = []; let wrong = 0;
    for (let i = 0; i < sc.tasks.length; i++) {
      const t = sc.tasks[i];
      const sub = await p.evaluate(() => document.querySelector("#right .sub")?.textContent);
      if (!sub?.startsWith(`Task ${i + 1} of ${sc.tasks.length}`)) bad.push(`task ${i + 1} header ${sub}`);
      if (t.type === "select_component") {
        const w = await p.evaluate((ans) => window.__app.xray.order().find((x) => !ans.includes(x)), t.answer);
        await p.click(`#left [data-comp="${w}"]`); wrong++;
        const f1 = await p.evaluate(() => [document.querySelector("#fb .fb")?.className, !!document.querySelector("#nx")]);
        await p.click(`#left [data-comp="${t.answer[0]}"]`);
        const f2 = await p.evaluate(() => [document.querySelector("#fb .fb")?.className, !!document.querySelector("#nx")]);
        if (!/bad/.test(f1[0]) || f1[1] || !/ok/.test(f2[0]) || !f2[1]) bad.push(`select feedback ${f1} ${f2}`);
        await p.click("#nx");
      } else if (t.type === "choice") {
        const w = t.answer === 0 ? 1 : 0;
        await p.click(`.opt[data-i="${w}"]`); wrong++;
        const f1 = await p.evaluate(() => [document.querySelector("#fb .fb")?.className, !!document.querySelector("#nx")]);
        await p.click(`.opt[data-i="${t.answer}"]`);
        const f2 = await p.evaluate(() => [document.querySelector("#fb .fb")?.className, !!document.querySelector("#nx")]);
        if (!/bad/.test(f1[0]) || f1[1] || !/ok/.test(f2[0]) || !f2[1]) bad.push(`choice feedback ${f1} ${f2}`);
        await p.click("#nx");
      } else {
        const dis = t.type === "disassembly", sel = (id) => dis ? `#left [data-comp="${id}"]` : `#right [data-re="${id}"]`;
        await p.waitForSelector(dis ? "#left [data-comp]" : "#right [data-re]");
        if (dis && Math.abs(await p.evaluate(() => window.__app.xray.target) - 0.15) > 1e-9) bad.push("disassembly does not start assembled");
        await p.click(sel(t.order[1])); wrong++;
        const f1 = await p.evaluate(() => document.querySelector("#fb")?.innerText || "");
        if (!/Next is/.test(f1)) bad.push(`${t.type}: wrong order not explained (${f1.slice(0, 40)})`);
        for (let k = 0; k < t.order.length; k++) {
          await p.click(sel(t.order[k]));
          const hid = await p.evaluate(() => [...window.__app.xray.hidden].sort());
          const want = dis ? t.order.slice(0, k + 1).sort() : t.order.slice(k + 1).sort();
          if (JSON.stringify(hid) !== JSON.stringify(want)) bad.push(`${t.type} step ${k + 1}: hidden ${hid} ≠ ${want}`);
        }
        await p.waitForFunction((n) => document.querySelector("#right .sub")?.textContent.startsWith(`Task ${n}`) || /Exercise passed|Review recommended/.test(document.querySelector("#right").textContent), i + 2, { timeout: 10000 }).catch(() => bad.push(`${t.type}: did not advance`));
      }
    }
    const sum = await p.evaluate(() => ({ t: document.querySelector("#right").innerText, rows: document.querySelectorAll("#right .kv").length, hidden: window.__app.xray.hidden.size, slider: document.querySelector("#explode")?.value }));
    const right = sc.tasks.reduce((n, t) => n + (t.order ? t.order.length : 1), 0), total = right + wrong, pct = Math.round((100 * right) / total);
    ok(`Practice ${tag}: ${sc.tasks.length} tasks (pick, quiz, disassembly, reassembly) validate answers and order`, bad.length === 0, bad.slice(0, 3).join("; "));
    ok(`Practice ${tag}: score ${right} of ${total} (${pct}%) and attempt log in the summary`, sum.t.includes(`${right} of ${total} answers correct`) && sum.rows === total && (pct >= 80 ? /Exercise passed/ : /Review recommended/).test(sum.t) && sum.hidden === 0 && sum.slider === "50",
      sum.t.split("\n").slice(1, 3).join(" "));
    await p.click("#pAgain");
    const again = await p.evaluate(() => ({ start: document.querySelector("#pStart")?.disabled, checked: [...document.querySelectorAll("#right .g")].filter((g) => g.checked).length, hidden: window.__app.xray.hidden.size }));
    ok(`Practice ${tag}: Try again resets to the gated start`, again.start === true && again.checked === 0 && again.hidden === 0, JSON.stringify(again));
  }
  // leaving Practice mid-disassembly: the X-Ray tab shows every part again
  await p.$$eval("#right .g", (gs) => gs.forEach((g) => { g.checked = true; g.dispatchEvent(new Event("change")); }));
  await p.click("#pStart");
  const sc = await p.evaluate(() => window.__app.kb.classes[window.__app.xClass].practice_scenarios[0]);
  await p.evaluate((n) => { for (let i = 0; i < n; i++) document.querySelector("#nx") || 0; }, 0);
  // jump to the disassembly task through the real UI: answer the tasks before it
  for (const t of sc.tasks) {
    if (t.type === "select_component") { await p.click(`#left [data-comp="${t.answer[0]}"]`); await p.click("#nx"); }
    else if (t.type === "choice") { await p.click(`.opt[data-i="${t.answer}"]`); await p.click("#nx"); }
    else { await p.click(`#left [data-comp="${t.order[0]}"]`); break; }
  }
  await p.click('#dock [data-d="all"]');
  const keep = await p.evaluate(() => [window.__app.xray.hidden.size, document.querySelector('#dock [data-d="all"]').innerText]);
  ok("Practice: dock 'Reset view' keeps the removed parts removed", keep[0] === 1 && /Reset view/.test(keep[1]), JSON.stringify(keep));
  const mid = await p.evaluate(() => window.__app.xray.hidden.size);
  await p.click('.modes [data-mode="xray"]');
  await p.waitForFunction(() => window.__app.mode === "xray" && document.querySelector("#right [data-xtab]"), null, { timeout: 30000 });
  ok("Practice → X-Ray tab mid-disassembly: all parts shown again", mid === 1 && (await p.evaluate(() => window.__app.xray.hidden.size)) === 0 && /Show only this part/.test(await p.evaluate(() => document.querySelector('#right [data-act="isolate"]').innerText)));
  await p.click('.modes [data-mode="practice"]');
  await p.waitForFunction(() => document.querySelector("#right .sub") || document.querySelector("#pStart"), null, { timeout: 30000 });
  await p.click('#dock [data-xclass="PROCESS_PUMP"]');
  await p.waitForFunction(() => window.__app.xClass === "PROCESS_PUMP" && document.querySelector("#pStart"), null, { timeout: 30000 });
  ok("Practice: switching device starts that device's exercise", /Pump bearing|pump/i.test(await p.evaluate(() => document.querySelector("#right .h1").textContent)));
  ok("Practice: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 4. Library
async function library(browser) {
  const p = await open(browser);
  await p.click("#libBtn");
  await p.waitForFunction(() => document.querySelectorAll("#libRes .doc").length > 0, null, { timeout: 30000 });
  const head = await p.evaluate(() => ({ ph: document.querySelector("#libQ").placeholder, note: document.querySelector("#sheet .note").innerText, chips: [...document.querySelectorAll("#sheet [data-libkind]")].map((b) => b.textContent) }));
  ok("Library: no manufacturer manuals claimed; sources stated", !/manual/i.test(head.ph) && /No manufacturer manuals/.test(head.note) && /synthetic/.test(head.note), head.ph);
  await p.fill("#libQ", "bearing vibration");
  await p.press("#libQ", "Enter");
  await p.waitForFunction(() => [...document.querySelectorAll("#libRes .doc")].some((d) => /bearing/i.test(d.textContent)), null, { timeout: 10000 }).catch(() => {});
  const res = await p.evaluate(() => [...document.querySelectorAll("#libRes .doc")].map((d) => d.dataset.docid));
  ok("Library: search returns relevant documents", res.length >= 3, res.slice(0, 5).join(", "));
  const kinds = { knowledge_doc: /^DOC-[A-Z_]+-CORE$|^DOC-(FIELD|RAG|3D)/, asset_card: /^DOC-ASSET-/, service_case: /^CASE-/, training_kb: /^KB-XRAY-/, app_doc: /^DOC-APP-/ };
  const fbad = [];
  await p.fill("#libQ", "");
  for (const [k, re] of Object.entries(kinds)) {
    await p.click(`#sheet [data-libkind="${k}"]`);
    await p.waitForFunction(() => document.querySelector("#libRes").children.length > 0, null, { timeout: 10000 }).catch(() => {});
    await sleep(150);
    const ids = await p.evaluate(() => [...document.querySelectorAll("#libRes .doc")].map((d) => d.dataset.docid));
    if (!ids.length || !ids.every((id) => re.test(id))) fbad.push(`${k}: ${ids.length} ${ids.slice(0, 3)}`);
  }
  ok("Library: filters by kind (knowledge docs, asset cards, service cases, training notes, product docs)", head.chips.length === 6 && fbad.length === 0, fbad.join("; ") || head.chips.join(" · "));
  await p.click('#sheet [data-libkind="asset_card"]');
  await p.fill("#libQ", "P-005"); await p.press("#libQ", "Enter");
  await p.waitForFunction(() => document.querySelector('#libRes [data-docid="DOC-ASSET-017"]'), null, { timeout: 10000 }).catch(() => {});
  await p.click('#libRes [data-docid="DOC-ASSET-017"]');
  await p.waitForFunction(() => /Asset card P-005/.test(document.querySelector("#sheet").textContent), null, { timeout: 10000 }).catch(() => {});
  const doc = await p.evaluate(() => document.querySelector("#sheet").innerText);
  ok("Library: opening an asset card shows its text and its synthetic-data source", /Asset card P-005/.test(doc) && /synthetic challenge workbook/.test(doc), doc.slice(0, 80).replace(/\n/g, " | "));
  await p.click("#sheet [data-lib-asset]");
  await step(p, 5);
  ok("Library: 'Show P-005 in the scan' selects the asset", await p.evaluate(() => window.__app.selected?.asset?.tag === "P-005" && document.querySelector("#sheet").classList.contains("hidden")));
  // training note from the X-Ray part card + back to the library
  await p.evaluate(() => window.__xr.S && document.querySelector("#libBtn").click());
  await p.waitForFunction(() => document.querySelectorAll("#libRes .doc").length > 0);
  await p.click('#sheet [data-libkind="training_kb"]'); await sleep(300);
  await p.click("#libRes .doc");
  await p.waitForFunction(() => /training note/.test(document.querySelector("#sheet").textContent), null, { timeout: 10000 }).catch(() => {});
  const tn = await p.evaluate(() => document.querySelector("#sheet").innerText);
  ok("Library: training note labelled as not an OEM manual", /not an OEM manual/.test(tn));
  await p.click("#sheet [data-lib-back]");
  ok("Library: back from a document returns to the library", await p.waitForFunction(() => document.querySelector("#libQ") && document.querySelectorAll("#libRes .doc").length > 0, null, { timeout: 10000 }).then(() => true, () => false));
  // citations in the diagnosis open the cited document
  await p.keyboard.press("Escape");
  await p.evaluate(() => document.querySelector('#right [data-act="diagnose-sel"], #right [data-act="diagnose-target"]')?.click());
  await p.waitForFunction(() => document.querySelector("#right .cite[data-doc^='DOC-'], #right .cite[data-doc^='CASE-']"), null, { timeout: 30000 }).catch(() => {});
  const cid = await p.evaluate(() => { const c = document.querySelector("#right .cite[data-doc^='DOC-'], #right .cite[data-doc^='CASE-']"); c?.click(); return c?.dataset.doc; });
  ok("Library: a citation in the diagnosis opens that document", !!cid && await p.waitForFunction((id) => document.querySelector("#sheet:not(.hidden) .card-h")?.textContent.includes(id), cid, { timeout: 10000 }).then(() => true, () => false), cid);
  ok("Library: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 5. Value (ROI)
async function value(browser) {
  const p = await open(browser);
  await p.click('.modes [data-mode="value"]');
  const txt = await p.evaluate(() => document.querySelector("#value").innerText);
  const num = (id) => p.evaluate((id) => +document.getElementById(id).textContent.replace(/[€,]/g, "").replace("−", "-"), id);
  // by hand: 50 techs × 4 look-ups × 50 weeks × (30 − 10) min / 60 = 3,333.3 h × €50 = €166,667; onboarding 10 × 16 h × €50 = €8,000;
  // downtime 0 h → €0; gross €174,667; minus the €30,000 running cost → net €144,667
  const t0 = await num("roiTotal"), g0 = await num("roiGross"), l0 = await num("roiLookup"), o0 = await num("roiTrain"), c0 = await num("roiCost");
  ok("Value: default case matches the hand calculation (gross €166,667 + €8,000 = €174,667; net of €30,000 cost = €144,667)", l0 === 166667 && o0 === 8000 && g0 === 174667 && c0 === -30000 && t0 === 144667, `${l0} + ${o0} = ${g0}; ${c0} → ${t0}`);
  ok("Value: labelled hypothetical gross and net, not measured Valmet savings; downtime not counted by default", /hypothetical input/.test(txt) && /Nothing here is a measured Valmet saving/.test(txt) && /Illustrative/.test(txt) && /not counted/.test(txt) && /Net annual benefit \(hypothetical\)/.test(txt) && /Gross annual benefit \(hypothetical\)/.test(txt) && /running cost/i.test(txt));
  ok("Value: formulas shown, including gross − cost = net", (await p.evaluate(() => document.querySelectorAll("#roiF .formula").length)) === 5 && /50 technicians × 4 look-ups\/week × 50 weeks × \(30 − 10\) min ÷ 60 = 3,333 h/.test(txt) && /− €30,000 running cost = €144,667 net/.test(txt));
  const set = (k, v) => p.evaluate(([k, v]) => { const s = document.querySelector(`[data-roi="${k}"]`); s.value = v; s.dispatchEvent(new Event("input", { bubbles: true })); }, [k, v]);
  await set("techs", 20); await set("before", 25); await set("downH", 2); await set("cost", 50000);
  // 20 × 4 × 50 × 15 / 60 = 1,000 h × €50 = €50,000; + €8,000; + 2 h × €5,000 = €10,000 → gross €68,000; − €50,000 → net €18,000
  const t1 = await num("roiTotal"), g1 = await num("roiGross"), lbl = await p.evaluate(() => document.querySelector('[data-roiv="techs"]').textContent);
  ok("Value: inputs are editable and recompute (20 techs, 25 min, 2 h downtime, €50,000 cost → gross €68,000, net €18,000)", g1 === 68000 && t1 === 18000 && lbl === "20", `${g1} / ${t1}, label ${lbl}`);
  await set("after", 60);
  // 20 × 4 × 50 × (25 − 60) / 60 = −2,333 h × €50 = −€116,667; gross −€98,667; net −€148,667
  const l2 = await num("roiLookup"), t2 = await num("roiTotal"), shown = await p.evaluate(() => document.getElementById("roiTotal").textContent);
  ok("Value: slower look-ups give an honest negative value (not clamped to zero)", l2 === -116667 && t2 === -148667 && /^−€/.test(shown), `${l2}, net ${shown}`);
  await p.click("#value [data-mode-back]");
  ok("Value: × returns to the facility", await p.evaluate(() => window.__app.mode === "facility" && document.querySelector("#value").classList.contains("hidden")));
  ok("Value: no page errors", p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 6. crawler: every visible button in these views does something, no errors
async function crawl(browser) {
  const p = await open(browser);
  const report = [], errAt = []; let errN = 0;
  const views = {
    xray: async () => { if ((await p.evaluate(() => window.__app.mode)) !== "xray") { await p.click('.modes [data-mode="xray"]'); await p.waitForFunction(() => window.__app.mode === "xray" && document.querySelector("#right [data-xtab]"), null, { timeout: 30000 }); } },
    learn: async () => { await p.click('.modes [data-mode="learn"]'); await p.waitForFunction(() => window.__app.mode === "learn" && document.querySelector("#right [data-topic], #lNext"), null, { timeout: 30000 }); },
    practice: async () => { await p.click('.modes [data-mode="practice"]'); await p.waitForFunction(() => window.__app.mode === "practice" && document.querySelector("#right .card-b"), null, { timeout: 30000 }); },
    value: async () => { await p.click('.modes [data-mode="value"]'); },
    support: async () => { await p.evaluate(() => window.__setMode("support")); await p.waitForFunction(() => window.__app.mode === "support"); },
    overlay: async () => { await p.click('.modes [data-mode="facility"]'); await p.evaluate(() => window.__xr.xo.show(window.__xr.S.target.asset.asset_id)); await step(p, 5); },
  };
  for (const [name, enter] of Object.entries(views)) {
    await enter();
    const sel = name === "overlay" ? "#xo button" : name === "value" ? "#value button, #value input" : "#left button, #right button, #dock button, #left select";
    const n = await p.evaluate((s) => document.querySelectorAll(s).length, sel);
    let clicked = 0, dead = [];
    for (let i = 0; i < n; i++) {
      // re-enter the view if a click left it, then click the i-th control if it is still there
      if ((name === "overlay" && !(await p.evaluate(() => window.__xr.xo.open))) || (name !== "overlay" && (await p.evaluate(() => window.__app.mode)) !== name)) await enter();
      const info = await p.evaluate(([s, i]) => {
        const b = document.querySelectorAll(s)[i]; if (!b) return null;
        const r = b.getBoundingClientRect(); if (!r.width || !r.height || b.disabled || getComputedStyle(b).visibility === "hidden" || b.tagName === "INPUT" || b.tagName === "SELECT") return null;
        b.dataset.crawl = "1";
        const A = window.__app, X = A.xray;
        window.__sig = () => JSON.stringify([document.querySelector("#app").innerHTML.length, document.querySelector("#right")?.innerHTML, document.querySelector("#left")?.innerHTML, document.querySelector("#dock")?.innerHTML, document.querySelector("#sheet")?.className, document.querySelector("#xo")?.innerHTML,
          A.mode, A.xClass, A.xSelected, X.target, X.ghost, X.labelsOn, [...X.hidden].join(), window.__xr.xo.open, window.__xr.xCam.position.toArray().map((v) => v.toFixed(3)), window.__xr.xo.cam?.position.toArray().map((v) => v.toFixed(3)), document.querySelector(".toast")?.textContent, document.body.className]);
        window.__sig0 = window.__sig();
        return (b.textContent.trim() || b.title || b.getAttribute("aria-label") || b.className).slice(0, 30);
      }, [sel, i]);
      if (!info) continue;
      // a list re-rendered after marking (e.g. the panel refreshing on open) replaces the marked node: mark again once
      await p.click("[data-crawl]", { timeout: 30000 }).catch(async () => {
        await p.evaluate(([s, i]) => { const b = document.querySelectorAll(s)[i]; if (b) { b.dataset.crawl = "1"; window.__sig0 = window.__sig(); } }, [sel, i]);
        await p.click("[data-crawl]", { timeout: 30000 }).catch((e) => dead.push(`${info} (not clickable: ${e.message.split("\n")[0].slice(0, 40)})`));
      });
      await sleep(250); await step(p, 2);
      const changed = await p.evaluate(() => { document.querySelector("[data-crawl]")?.removeAttribute("data-crawl"); return window.__sig() !== window.__sig0 || /^(blob|data):/.test(document.activeElement?.href || ""); });
      clicked++;
      if (p.errors.length > errN) { errAt.push(`${name} → ${info}: ${p.errors.slice(errN).join(" | ").slice(0, 120)}`); errN = p.errors.length; }
      if (!changed) dead.push(info);
      await p.evaluate(() => { document.querySelector(".toast")?.remove(); document.querySelector("#sheet")?.classList.add("hidden"); document.querySelectorAll(".card.min").forEach((c) => c.classList.remove("min")); });
    }
    report.push(`${name}: ${clicked} clicked${dead.length ? `, no visible effect: ${dead.join(" | ")}` : ""}`);
    ok(`Crawler ${name}: every visible enabled button does something`, clicked >= (name === "value" ? 1 : 5) && dead.length === 0, `${clicked} clicked${dead.length ? " · dead: " + dead.join(" | ") : ""}`);
  }
  ok("Crawler: no page errors", p.errors.length === 0, errAt.slice(0, 3).join(" ; ") || p.errors.slice(0, 3).join(" | "));
  await p.context().close();
}

// ------------------------------------------------------------------ 7. layout at 1366×768, 1440×900, 390×844
async function layout(browser) {
  for (const [w, h] of [[1366, 768], [1440, 900], [390, 844]]) {
    const phone = w < 600;
    const p = await open(browser, { width: w, height: h }, phone ? { isMobile: true, hasTouch: true } : {});
    const rect = (s) => p.evaluate((s) => { const n = document.querySelector(s); if (!n || n.classList.contains("hidden") || getComputedStyle(n).display === "none") return null; const r = n.getBoundingClientRect(); return r.width && r.height ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; }, s);
    const inter = (a, b) => a && b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
    const inView = (a) => a && a.l >= -1 && a.t >= -1 && a.r <= w + 1 && a.b <= h + 1;
    const bad = [];
    // in-scene X-Ray panel: on screen, its close button, explode slider and tools are not covered
    await p.evaluate(() => window.__xr.xo.show(window.__xr.S.target.asset.asset_id)); await step(p, 20); await sleep(700);   // let the opening transition finish
    const xo = await rect("#xo");
    if (!inView(xo)) bad.push(`overlay off screen ${JSON.stringify(xo)}`);
    const cov = await p.evaluate(() => [...document.querySelectorAll('#xo [data-xo="close"], #xo [data-xo="full"], #xoExplode, #xo .xo-btns .tool, #xo .xo-row')].filter((b) => {
      b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(b === e || b.contains(e)); }).map((b) => b.dataset.xo || b.id || b.textContent.trim().slice(0, 20)));
    if (cov.length) bad.push(`overlay controls covered: ${cov.slice(0, 4).join(", ")}`);
    await p.screenshot({ path: `${SHOTS}/learn-layout-${w}x${h}-overlay.png` }).catch(() => {});
    await p.keyboard.press("Escape");
    for (const m of ["xray", "learn", "practice"]) {
      await p.evaluate((m) => m === "xray" ? window.__enterXRay() : window.__setMode(m), m);
      await p.waitForFunction((m) => window.__app.mode === m && document.querySelector("#right .card-b, #right .card-h"), m, { timeout: 60000 });
      await sleep(1200); await step(p, 3);      // capture mode: draw this view before measuring / the screenshot
      const L = await rect("#left"), R = await rect("#right"), D = await rect("#dock"), M = await rect(".modes");
      if (!inView(D)) bad.push(`${m}: dock off screen ${JSON.stringify(D)}`);
      if (!phone && (inter(R, D) || inter(L, D) || inter(L, R))) bad.push(`${m}: cards overlap ${JSON.stringify({ L, R, D })}`);
      if (inter(M, R) || inter(M, L)) bad.push(`${m}: mode bar covered`);
      const prim = await p.evaluate(() => { const b = document.querySelector("#right #lNext, #right [data-topic], #right #pStart, #right [data-act='isolate']"); if (!b) return "none"; b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return b.contains(e) || e === b ? "ok" : `covered by ${e?.className || e?.tagName}`; });
      if (prim !== "ok") bad.push(`${m}: main action ${prim}`);
      if (m === "xray") await p.screenshot({ path: `${SHOTS}/learn-layout-${w}x${h}-xray.png` }).catch(() => {});
    }
    await p.evaluate(() => window.__setMode("value")); await sleep(300);
    const V = await rect("#value"), vs = await p.evaluate(() => { const v = document.querySelector("#value"); return { sw: document.documentElement.scrollWidth, scroll: v.scrollHeight > v.clientHeight + 2 ? getComputedStyle(v).overflowY : "fits" }; });
    if (!inView(V) || vs.sw > w + 1 || vs.scroll === "visible") bad.push(`value: ${JSON.stringify({ V, vs })}`);
    const x = await p.evaluate(() => { const b = document.querySelector("#value [data-mode-back]").getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e?.closest("[data-mode-back]"); });
    if (!x) bad.push("value: close button covered");
    await p.evaluate(() => window.__setMode("facility"));
    await p.evaluate(() => document.querySelector("#libBtn").click()); await sleep(500);
    const Sh = await rect("#sheet");
    if (!inView(Sh)) bad.push(`library sheet off screen ${JSON.stringify(Sh)}`);
    await p.keyboard.press("Escape");
    ok(`Layout ${w}×${h}: X-Ray / Learn / Practice / Value / Library panels fit and leave the controls usable`, bad.length === 0, bad.slice(0, 3).join("; "));
    ok(`Layout ${w}×${h}: no page errors`, p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
    await p.context().close();
  }
}

const browser = await chromium.launch({ args: GL });
const only = process.env.ONLY?.split(",");
try {
  for (const [n, f] of Object.entries({ xray, learn, practice, library, value, crawl, layout })) {
    if (only && !only.includes(n)) continue;
    try { await f(browser); } catch (e) { ok(`${n}: ran without exceptions`, false, e.message.split("\n")[0]); }
  }
} finally { await browser.close(); server?.kill(); }
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
