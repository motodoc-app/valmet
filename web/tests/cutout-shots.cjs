// Visual check of the Plan-mode scan cut-out WITH the full scan (software GL: slow, ~20-40 s per frame).
//   node tests/cutout-shots.cjs [extra query, e.g. "&render=classic"] [objects, e.g. "OBJ-028,OBJ-010"]
// Renders before / after frames with window.__step (?capture) and writes tests/shots/cut-<id>-{before,after}.png,
// then prints the extraction statistics (splats copied, ms per object).
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXTRA = process.argv[2] || "";
const IDS = (process.argv[3] || "OBJ-028,OBJ-010").split(",");
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
(async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const srv = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(__dirname, ".."), stdio: "ignore", detached: true });
  const BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.goto(BASE + "?capture&noguide&qa" + EXTRA);
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.planning, null, { timeout: 120000 });
  await p.waitForFunction(() => { const f = window.__app.fac; return f.splatMode && f.splats.length && f.splats.every((m) => m.isInitialized) && document.querySelector("#scanStatus")?.classList.contains("hidden"); }, null, { timeout: 300000, polling: 1000 });
  console.log("scan:", await p.evaluate(() => `${window.__app.fac.renderPath} · ${window.__app.fac.splats.length} meshes · ${window.__app.fac.scanStats.splats} splats`));
  await p.evaluate(() => { window.__xr.setMode("plan"); document.body.classList.add("focus"); document.querySelector(".toast")?.remove(); });
  await p.waitForFunction(() => window.__xr.planning.stage, null, { timeout: 60000 });
  await sleep(2000);
  // a clean look at the scan: no drivable-floor overlay, no object frames
  await p.evaluate(() => { const A = window.__xr; A.S.fac.setTwin(false); A.S.fac.setShowMode("none"); });
  // each __step renders one frame; the screenshot waits for the (software) GPU to finish it
  // Spark generates and sorts asynchronously and only swaps in the new splat set on a later frame: in software GL
  // the sort of 1.67 M splats takes seconds, so render until the sorter is idle and the displayed set is current.
  const step = async (n = 2) => {
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      await p.evaluate(() => window.__step(1 / 12));
      await sleep(700);
      const idle = await p.evaluate(() => { const s = window.__xr.scene.children.find((c) => c.accumulators); return !s || (!s.sorting && !s.sortDirty && s.display === s.current); });
      if (idle && i >= n) break;
    }
    await p.evaluate(() => window.__step(1 / 12));
    console.log(`  settled in ${Date.now() - t0} ms`);
  };
  // camera: look at the original and the new spot from the room side at 45°
  const look = (id, to) => p.evaluate(([id, to]) => {
    const A = window.__xr, o = A.S.data.objects.find((x) => x.id === id), V = A.THREE.Vector3;
    const a = new V(o.center[0], 0.35, o.center[2]), bb = to ? new V(to.x, 0.35, to.z) : a.clone(), c = a.clone().add(bb).multiplyScalar(0.5);
    const span = Math.max(1.6, a.distanceTo(bb) + Math.max(o.size[0], o.size[2]) + 0.8);
    const b = A.S.data.bounds, mid = new V((b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2);
    // look from the room side, across the move (perpendicular to it when there is one)
    let dir = mid.clone().sub(c).setY(0).normalize();
    if (to && a.distanceTo(bb) > 0.2) { const mv = bb.clone().sub(a).setY(0).normalize(), n = new V(-mv.z, 0, mv.x); dir = n.dot(dir) >= 0 ? n : n.negate(); dir.add(mid.clone().sub(c).setY(0).normalize().multiplyScalar(0.4)).normalize(); }
    // from above, slightly tilted, with the cut-away (ceiling and overhead pipes hidden): both spots unoccluded
    A.S.cam = "free"; A.S.fac.setCutaway(true);
    const h = 1.2 + span * 0.85;
    A.flyTo(c.clone().add(dir.multiplyScalar(h * 0.35)).setY(h), c.clone().setY(0.2), 0.01);
  }, [id, to]);
  const moves = [];
  const fixed = Object.fromEntries((process.env.SPOTS || "").split(";").filter(Boolean).map((s) => { const [id, x, z, yaw] = s.split(":"); return [id, { x: +x, z: +z, yaw: +yaw }]; }));
  for (const id of IDS) {
    const to = fixed[id] || await p.evaluate(async (id) => {
      const A = window.__xr; let spot = await A.planning._findSpot(id);
      const o = A.S.data.objects.find((x) => x.id === id);
      if (!spot) spot = { x: o.center[0] + 0.8, z: o.center[2], yaw: o.yaw };
      return spot;
    }, id);
    moves.length = 0;                          // one object at a time
    await p.evaluate(() => window.__xr.planning.reset());
    await look(id, to);
    await step(3);
    await p.screenshot({ path: path.join(SHOTS, `cut-${id}-before.png`), timeout: 300000 });
    moves.push({ id, x: to.x, z: to.z, yaw: to.yaw + (id === IDS[0] ? 0 : Math.PI / 6) });
    const t0 = Date.now();
    await p.evaluate((ms) => window.__xr.planning.setState({ moves: ms, active: ms.at(-1).id }), moves);
    console.log(`${id}: setState ${Date.now() - t0} ms`, JSON.stringify(await p.evaluate((id) => window.__xr.planning.cutStats().objects.find((o) => o.id === id), id)));
    await step(3);
    await p.screenshot({ path: path.join(SHOTS, `cut-${id}-after.png`), timeout: 300000 });
  }
  console.log("cut log:", JSON.stringify(await p.evaluate(() => window.__xr.planning.cutStats())));
  // undo restores the scan at the original spot
  await p.evaluate(() => window.__xr.planning.reset());
  await step(2);
  await p.screenshot({ path: path.join(SHOTS, `cut-reset.png`), timeout: 300000 });
  console.log("after reset shown:", JSON.stringify(await p.evaluate(() => window.__xr.planning.cutStats().shown)), "hide edit in scene:", await p.evaluate(() => !!window.__xr.scene.getObjectByName("plan-hide-originals")));
  console.log("errors:", errors.slice(0, 5));
  await b.close(); try { process.kill(-srv.pid); } catch {}
})();
