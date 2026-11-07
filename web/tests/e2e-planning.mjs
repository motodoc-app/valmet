// End-to-end checks for Maintenance Planning mode (Plan tab) in headless Chromium. Run after `npm run build`:
//   node tests/e2e-planning.mjs              static build (hosted-demo mode)
//   BASE=http://localhost:5173 node tests/e2e-planning.mjs
// Covers: select equipment, create a labelled proxy, pointer drag + keyboard nudge/rotate, live collision and
// clearance, service zone, route before/after, Explore routes using the plan, export, reset, getState/setState,
// demo() idempotency. Exits non-zero on failure. Screenshots go to tests/shots/plan-*.png.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4600 + Math.floor(Math.random() * 300);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "ignore", detached: true });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);
const stopServer = () => { if (server) { try { process.kill(-server.pid); } catch { server.kill(); } } };

const strip = (s) => JSON.stringify({ ...s, created: 0, route: { ...s.route, before: { ...s.route.before, compute_ms: 0 }, after: { ...s.route.after, compute_ms: 0 } } });

const browser = await chromium.launch({ args: GL });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.goto(BASE + "?scan=off");
  await p.waitForFunction(() => window.__xr?.planning && window.__app?.fac, null, { timeout: 90000 });
  await p.evaluate(() => document.querySelector(".toast")?.remove());

  // 1-2: enter planning mode, select equipment
  ok("Plan tab is registered", await p.$('.modes [data-mode="plan"]'));
  await p.click('.modes [data-mode="plan"]');
  await p.waitForSelector("#left .pl-sugg", { timeout: 20000 });
  ok("Left card suggests the pallet truck first", /Hand pallet truck/.test(await p.textContent("#left .pl-sugg")));
  ok("Right card states the honest disclaimer", (await p.textContent("#right")).includes("not an engineering clearance check"));
  ok("Service zone starts obstructed by the pallet truck", /Obstructed by Pallet truck \(OBJ-028\)/.test(await p.textContent("#right")));
  await p.fill("#plQ", "cabinet");
  ok("Object search finds other equipment", (await p.$$("#plRes [data-pl-pick]")).length > 0);
  await sleep(1200);
  await p.screenshot({ path: path.join(SHOTS, "plan-1-start.png") });

  // 3: create the labelled proxy
  await p.click("#left .pl-sugg");
  await p.waitForFunction(() => window.__xr.planning.getState().moves.length === 1);
  const st0 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Proxy created for OBJ-028", st0.moves[0].id === "OBJ-028" && st0.active === "OBJ-028");
  const seen = (sel, re) => p.waitForFunction(([s, r]) => [...document.querySelectorAll(s)].some((e) => new RegExp(r).test(e.textContent) && e.offsetParent !== null), [sel, re], { timeout: 8000 }).then(() => true, () => false);
  ok("Proxy carries a visible 'Planning proxy' label", await seen(".labels .pl-tag.proxy", "Planning proxy"));
  ok("Original position is marked as a ghost", await seen(".labels .pl-tag.ghost", "Original position"));

  // 4: pointer drag on the floor (OrbitControls disabled while dragging)
  const scr = await p.evaluate(() => {
    const A = window.__xr, m = A.planning.getState().moves[0], V = A.THREE.Vector3;
    const pr = (x, y, z) => { const v = new V(x, y, z).project(A.camera); return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight]; };
    return { a: pr(m.x, 0.5, m.z), b: pr(m.x, 0.5, m.z - 0.8) };
  });
  await p.mouse.move(scr.a[0], scr.a[1]); await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(scr.a[0] + ((scr.b[0] - scr.a[0]) * i) / 10, scr.a[1] + ((scr.b[1] - scr.a[1]) * i) / 10); await sleep(40); }
  const dragging = await p.evaluate(() => window.__xr.controls.enabled === false);
  await p.mouse.up();
  await p.waitForFunction(() => window.__xr.planning.summary().route.after?.ok !== undefined && !document.querySelector("#dock")?.textContent.includes("Planning the new route"), null, { timeout: 20000 });
  const st1 = await p.evaluate(() => window.__xr.planning.getState()), m1 = st1.moves[0];
  ok("Pointer drag moves the proxy (orbit disabled while dragging)", dragging && Math.hypot(m1.x - 2.065, m1.z - 2.696) > 0.3, `now ${m1.x}, ${m1.z}`);
  ok("Drag snaps to 5 cm", Math.abs(m1.x / 0.05 - Math.round(m1.x / 0.05)) < 1e-6 && Math.abs(m1.z / 0.05 - Math.round(m1.z / 0.05)) < 1e-6);
  ok("Orbit controls re-enabled after the drop", await p.evaluate(() => window.__xr.controls.enabled));

  // keyboard nudge and rotation
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press("ArrowRight"); await sleep(50);
  const st2 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Arrow key nudges 5 cm", Math.abs(Math.hypot(st2.moves[0].x - m1.x, st2.moves[0].z - m1.z) - 0.05) < 1e-3);
  await p.keyboard.press("r"); await sleep(50);
  const st3 = await p.evaluate(() => window.__xr.planning.getState());
  ok("R turns the proxy 90°", Math.abs(Math.abs(Math.atan2(Math.sin(st3.moves[0].yaw - st2.moves[0].yaw), Math.cos(st3.moves[0].yaw - st2.moves[0].yaw))) - Math.PI / 2) < 1e-3);
  await p.click('#dock [data-pd="l15"]');
  const st4 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Dock rotates 15°", Math.abs(Math.abs(Math.atan2(Math.sin(st4.moves[0].yaw - st3.moves[0].yaw), Math.cos(st4.moves[0].yaw - st3.moves[0].yaw))) - Math.PI / 12) < 1e-3);

  // 6-7: collision with known obstacles (onto the electrical cabinet OBJ-010)
  await p.evaluate(() => { const c = window.__app.data.objects.find((o) => o.id === "OBJ-010").center; return window.__xr.planning.setState({ moves: [{ id: "OBJ-028", x: c[0] + 0.2, z: c[2], yaw: 0 }], active: "OBJ-028" }); });
  const col = await p.evaluate(() => window.__xr.planning.summary());
  ok("Collision detected against a known object", col.moves[0].status === "collision" && col.moves[0].collisions.some((c) => c.object_id === "OBJ-010"), JSON.stringify(col.moves[0].collisions.slice(0, 3)));
  ok("Collision shown in the summary card and on the proxy", (await p.$("#right .pl-verdict.bad")) && (await p.$(".pl-tag.proxy.bad")));
  await sleep(600);
  await p.screenshot({ path: path.join(SHOTS, "plan-2-collision.png") });

  // demo(): free spot, service zone clear, route recomputed, idempotent
  const t0 = Date.now();
  const d1 = await p.evaluate(() => window.__xr.planning.demo());
  const demoMs = Date.now() - t0;
  const d2 = await p.evaluate(() => window.__xr.planning.demo({ animate: false }));
  const mv = d1.moves[0];
  ok("demo(): pallet truck moved with no collisions", d1.collisions === 0 && mv.status === "clear" && mv.displacement_m > 0.4, `${mv.proposed.x}, ${mv.proposed.z} · ${mv.displacement_m} m · ${demoMs} ms`);
  ok("demo(): approximate clearance reported", mv.clearance_m >= 0.3 && mv.nearest_object, `${mv.clearance_m} m`);
  ok("Service zone obstructed before, clear after", !d1.service_zone.before.clear && d1.service_zone.before.obstructed_by.includes("OBJ-028") && d1.service_zone.after.clear);
  ok("Route before and after computed, both collision-free", d1.route.before.ok && d1.route.after.ok && d1.route.before.collision_free && d1.route.after.collision_free,
    `${d1.route.before.length_m} m → ${d1.route.after.length_m} m`);
  ok("demo() is idempotent", strip(d1) === strip(d2));
  ok("Summary card shows the before/after comparison", (await p.$$("#right .pl-rt")).length === 2 && /Clear/.test(await p.textContent("#right .pl-tiles")));
  ok("Both routes drawn in 3D", await p.evaluate(() => window.__xr.scene.getObjectByName("planning").children.some((g) => g.children.length >= 2 && g.children.some((c) => c.isInstancedMesh) && g.children.some((c) => c.geometry?.type === "TubeGeometry"))));
  await sleep(1500);
  await p.screenshot({ path: path.join(SHOTS, "plan-3-demo.png") });

  // 10: export (Markdown + JSON download, copy)
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click('#right [data-pl="md"]')]);
  const md = readFileSync(await dl.path(), "utf8");
  ok("Markdown export states it is an approximate simulation", md.includes("not an engineering clearance check") && md.includes("OBJ-028") && md.includes("Robot route"), dl.suggestedFilename());
  const [dj] = await Promise.all([p.waitForEvent("download"), p.click('#right [data-pl="json"]')]);
  const js = JSON.parse(readFileSync(await dj.path(), "utf8"));
  ok("JSON export carries the plan and scan_modified=false", js.scan_modified === false && js.moves[0].object_id === "OBJ-028" && js.disclaimer.includes("approximate"));
  await p.click('#right [data-pl="wo"]');
  await p.waitForSelector("#sheet:not(.hidden) .card-b .pill.amber", { timeout: 10000 });
  ok("Draft work order includes the access preparation", /Move Hand pallet truck/.test(await p.textContent("#sheet")));
  await p.click("#sheet [data-close-sheet]");

  // mini-map overlay is drawn by the minimap hook
  ok("Mini-map visible in Plan mode", await p.evaluate(() => !document.querySelector("#minimap").classList.contains("hidden")));

  // state for shared links
  const shared = await p.evaluate(() => window.__xr.planning.getState());
  await p.evaluate(() => window.__xr.planning.reset());
  ok("reset() clears the plan", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 0);
  await p.evaluate((s) => window.__xr.planning.setState(s), shared);
  ok("setState(getState()) restores the same plan", JSON.stringify(await p.evaluate(() => window.__xr.planning.getState())) === JSON.stringify(shared));

  // 8: every robot route uses the proposed layout, also in Explore
  await p.click('.modes [data-mode="facility"]');
  const ex = await p.evaluate(async () => { const S = window.__app; await window.__dispatch(S.target.asset.asset_id); return { clears: S.route.clears || [], blocks: S.route.blocks, len: S.route.length_m, ok: S.route.validation.collision_free }; });
  ok("Explore dispatch routes with the plan (blocks + clears)", ex.ok && ex.clears.some((c) => c.object_id === "OBJ-028") && ex.blocks.some((b) => b.proxy === "OBJ-028"), `${ex.len} m`);
  ok("Proxy stays visible in Explore while the plan is active", await seen(".labels .pl-tag.proxy", "Planning proxy"), await p.evaluate(() => document.querySelectorAll(".labels .pl-tag.proxy").length + " proxy labels"));
  await p.click('.modes [data-mode="plan"]');
  await p.waitForSelector('#right [data-pl="reset"]');
  await p.click('#right [data-pl="reset"]');
  await sleep(300);
  ok("Reset restores the original layout", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 0 && /Obstructed by Pallet truck/.test(await p.textContent("#right")));
  const ex2 = await p.evaluate(async () => { const S = window.__app; await window.__dispatch(S.target.asset.asset_id); return S.route; });
  ok("After reset, routes use the scanned layout (no clears)", !ex2.clears && !ex2.blocks.length);
  await p.click('.modes [data-mode="plan"]').catch(() => {});

  // ---- grab any object, game-like: hover, press = pick up (proxy created at once), drag, wheel turn, drop, undo / redo
  await p.evaluate(() => { window.__xr.planning.reset(); window.__xr.planning.view("top"); });
  await sleep(1600);
  ok("Plan card leads with 'Click any object in the room to pick it up'", /Click any object in the room to pick it up/.test(await p.textContent("#right .pl-lead")) && /Click any object/.test(await p.textContent("#left .pl-steps")));
  // a screen point where Facility.pick() returns the object (so the click really lands on it)
  const spotOf = (id) => p.evaluate((id) => {
    const A = window.__xr, o = A.S.data.objects.find((x) => x.id === id), V = A.THREE.Vector3, rc = new A.THREE.Raycaster(), r = A.canvas.getBoundingClientRect();
    const cs = Math.cos(o.yaw), sn = Math.sin(o.yaw), top = o.center[1] + o.size[1] / 2;
    for (const [fx, fz] of [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.3, 0.3], [-0.3, -0.3]]) {
      const lx = fx * o.size[0], lz = fz * o.size[2], w = new V(o.center[0] + lx * cs - lz * sn, top - 0.02, o.center[2] + lx * sn + lz * cs).project(A.camera);
      rc.setFromCamera({ x: w.x, y: w.y }, A.camera);
      if (A.S.fac.pick(rc.ray) === id) return [r.left + ((w.x + 1) / 2) * r.width, r.top + ((1 - w.y) / 2) * r.height];
    }
    return null;
  }, id);
  const OTHER = "OBJ-010";                     // electrical cabinet: not the suggested pallet truck
  const c0 = await spotOf(OTHER);
  ok("Another object (electrical cabinet) is clickable in the top view", !!c0);
  await p.mouse.move(c0[0] - 30, c0[1] - 30); await p.mouse.move(c0[0], c0[1]); await sleep(250);
  ok("Hover: grab cursor and a 'drag to pick it up' tip", await p.evaluate(() => window.__xr.canvas.style.cursor === "grab" && !document.querySelector(".pl-hover").classList.contains("hidden") && /pick it up/.test(document.querySelector(".pl-hover").textContent)));
  await p.mouse.down();
  const g0 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Pressing on it picks it up at once (proxy created, active)", g0.active === OTHER && g0.moves.some((m) => m.id === OTHER), JSON.stringify(g0.moves.map((m) => m.id)));
  const o10 = await p.evaluate((id) => window.__app.data.objects.find((x) => x.id === id).center, OTHER);
  const c1 = await p.evaluate(([x, z]) => { const A = window.__xr, v = new A.THREE.Vector3(x, 1.2, z).project(A.camera), r = A.canvas.getBoundingClientRect(); return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height]; }, [o10[0] - 0.7, o10[2]]);
  for (let i = 1; i <= 12; i++) { await p.mouse.move(c0[0] + ((c1[0] - c0[0]) * i) / 12, c0[1] + ((c1[1] - c0[1]) * i) / 12); await sleep(35); }
  await sleep(250);
  const held = await p.evaluate((id) => { const g = window.__xr.scene.getObjectByName("planning"); let y = 0; g.traverse((n) => { if (n.isGroup && n.children.some((c) => c.geometry?.type === "BoxGeometry") && n.position.y > y) y = n.position.y; }); return { lift: y, orbit: window.__xr.controls.enabled }; }, OTHER);
  ok("While held it is lifted a few cm and orbit is off", held.lift > 0.02 && held.lift < 0.1 && !held.orbit, `lift ${held.lift.toFixed(3)} m`);
  const yaw0 = (await p.evaluate(() => window.__xr.planning.getState())).moves.find((m) => m.id === OTHER).yaw;
  await p.mouse.wheel(0, 120); await sleep(120);
  const yaw1 = (await p.evaluate(() => window.__xr.planning.getState())).moves.find((m) => m.id === OTHER).yaw;
  ok("Mouse wheel turns it 15° while held", Math.abs(Math.abs(Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0))) - Math.PI / 12) < 1e-3);
  await p.mouse.up();
  await p.waitForFunction(() => !document.querySelector("#dock")?.textContent.includes("Planning the new route"), null, { timeout: 20000 });
  await sleep(600);
  const g1 = await p.evaluate(() => window.__xr.planning.getState()), m10 = g1.moves.find((m) => m.id === OTHER);
  ok("Dragging moves it on the floor", Math.hypot(m10.x - o10[0], m10.z - o10[2]) > 0.4, `${m10.x}, ${m10.z}`);
  ok("It settles back on the floor after the drop", await p.evaluate(() => { const g = window.__xr.scene.getObjectByName("planning"); let y = 0; g.traverse((n) => { if (n.isGroup && n.children.some((c) => c.geometry?.type === "BoxGeometry")) y = Math.max(y, n.position.y); }); return y < 1e-3; }));
  ok("Route re-planned on drop", await p.evaluate(() => !!window.__xr.planning.summary().route.after));
  ok("Undo is available after the move", (await p.evaluate(() => window.__xr.planning.history())).undo >= 1 && !(await p.$('#dock [data-pd="undo"][disabled]')));
  ok("Without the scan the object is a box proxy (cut-out unavailable, said so)", !(await p.evaluate(() => window.__xr.planning.cutStats().available)) && /box proxy/.test(await p.textContent("#right .pl-cut")));
  // a second object in the same plan: the pallet truck by keyboard after picking it in the card
  await p.evaluate(() => window.__xr.planning.pick("OBJ-028"));
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press("ArrowLeft"); await sleep(80);
  const g2 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Several objects can be moved in one plan", g2.moves.length === 2 && g2.moves.some((m) => m.id === OTHER) && g2.moves.some((m) => m.id === "OBJ-028"));
  await p.keyboard.press("Control+z"); await sleep(150);
  await p.keyboard.press("Control+z"); await sleep(150);
  const g3 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Ctrl+Z undoes step by step (nudge, then the pick)", g3.moves.length === 1 && g3.moves[0].id === OTHER && Math.abs(g3.moves[0].x - m10.x) < 1e-6, JSON.stringify(g3.moves));
  await p.keyboard.press("Control+z"); await sleep(400);
  ok("Ctrl+Z undoes the pick-up and drag of the cabinet", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 0);
  await p.keyboard.press("Control+Shift+z"); await sleep(400);
  const g4 = await p.evaluate(() => window.__xr.planning.getState());
  ok("Ctrl+Shift+Z redoes it", g4.moves.length === 1 && g4.moves[0].id === OTHER && Math.abs(g4.moves[0].x - m10.x) < 1e-6 && Math.abs(g4.moves[0].yaw - m10.yaw) < 1e-6);
  await p.click('#dock [data-pd="redo"]'); await sleep(300);
  ok("Redo button redoes the next step", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 2);
  await p.click('#dock [data-pd="undo"]'); await sleep(300);
  ok("Undo button undoes it", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 1);
  // touch: the same code path with pointer events of type "touch"
  const ct = await spotOf("OBJ-028");
  if (ct) {
    const tc = await p.evaluate(async ([x0, y0]) => {
      const cv = window.__xr.canvas, ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
      ev("pointerdown", x0, y0);
      for (let i = 1; i <= 10; i++) { ev("pointermove", x0 + i * 6, y0 + i * 3); await new Promise((r) => setTimeout(r, 30)); }
      ev("pointerup", x0 + 60, y0 + 30);
      await new Promise((r) => setTimeout(r, 200));
      const m = window.__xr.planning.getState().moves.find((q) => q.id === "OBJ-028"), o = window.__app.data.objects.find((q) => q.id === "OBJ-028").center;
      return m ? Math.hypot(m.x - o[0], m.z - o[2]) : -1;
    }, ct);
    ok("Touch (pointer events) picks up and drags too", tc > 0.1, `${tc.toFixed(2)} m`);
  } else ok("Touch (pointer events) picks up and drags too", false, "pallet truck not clickable");
  ok("Pipework and the pump itself stay put", !(await p.evaluate(() => window.__xr.planning.movable("OBJ-038").ok)) && !(await p.evaluate(() => window.__xr.planning.movable(window.__app.target.id).ok)) && (await p.evaluate(() => window.__xr.planning.movable("OBJ-028").ok)));
  await p.click('#dock [data-pd="reset"]'); await sleep(400);
  ok("Reset all restores the scanned layout", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 0 && /Obstructed by Pallet truck/.test(await p.textContent("#right")));
  await p.keyboard.press("Control+z"); await sleep(400);
  ok("Reset all can be undone", (await p.evaluate(() => window.__xr.planning.getState())).moves.length === 2);
  await p.evaluate(() => window.__xr.planning.reset());
  await p.screenshot({ path: path.join(SHOTS, "plan-4-grab.png") });

  // phone-ish width keeps the planning card usable
  await p.setViewportSize({ width: 900, height: 700 });
  await p.evaluate(() => window.__xr.setMode("plan"));
  await sleep(300);
  ok("Narrow viewport: summary card fits the screen", await p.evaluate(() => { const r = document.querySelector("#right").getBoundingClientRect(); return r.right <= innerWidth && r.width > 200; }));

  ok("No page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("Test run completed", false, e.message);
} finally {
  await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
