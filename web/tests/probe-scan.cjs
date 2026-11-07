// Dev probe (not part of the test suite): loads the full scan in software GL, moves the pallet truck and prints
// the cut-out state (meshes, splat counts, matrices, hide boxes). Optional: a small screenshot to tests/shots/probe.png.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const srv = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(__dirname, ".."), stdio: "ignore", detached: true });
  const BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: +(process.env.W || 640), height: +(process.env.H || 400) } });
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console:", m.text().slice(0, 300)); });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto(BASE + "?capture&noguide&qa" + (process.argv[2] || ""));
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.planning, null, { timeout: 120000 });
  await p.waitForFunction(() => { const f = window.__app.fac; return f.splatMode && f.splats.length && f.splats.every((m) => m.isInitialized) && document.querySelector("#scanStatus")?.classList.contains("hidden"); }, null, { timeout: 300000, polling: 1000 });
  await p.evaluate(() => { window.__xr.setMode("plan"); document.body.classList.add("focus"); });
  await sleep(1500);
  const MV = (process.env.MOVE || "OBJ-028,2.0,1.6,0.5").split(","); await p.evaluate((mv) => window.__xr.planning.setState({ moves: [{ id: mv[0], x: +mv[1], z: +mv[2], yaw: +mv[3] }] }), MV);
  for (let i = 0; i < +(process.env.STEPS || 3); i++) { await p.evaluate(() => window.__step(1 / 12)); await sleep(600); }
  console.log(await p.evaluate(() => {
    const A = window.__xr, g = A.scene.getObjectByName("splatcut");
    const ms = g.children.filter((c) => c.isSplatMesh || c.packedSplats);
    const edit = A.scene.getObjectByName("plan-hide-originals");
    const src = A.S.fac.splats[0];
    return JSON.stringify({ stats: A.planning.cutStats(), group: g.children.map((c) => c.type + ":" + (c.name || "") + ":" + (c.packedSplats?.numSplats ?? "")),
      first: ms[0] && { vis: ms[0].visible, init: ms[0].isInitialized, n: ms[0].numSplats, ctxN: ms[0].context?.numSplats?.value, mw: ms[0].matrixWorld.elements.map((v) => +v.toFixed(3)), sp0: ms[0].packedSplats.getSplat(0).center.toArray().map((v) => +v.toFixed(3)) },
      srcMw: src.matrixWorld.elements.map((v) => +v.toFixed(3)), srcEdits: src.rgbaDisplaceEdits ? { n: src.rgbaDisplaceEdits.numEdits, sdfs: src.rgbaDisplaceEdits.numSdfs } : null,
      edit: edit && { parent: edit.parent?.name, kids: edit.children.length, vis: edit.visible, sdf: edit.children[0] && { p: edit.children[0].position.toArray(), s: edit.children[0].scale.toArray(), type: edit.children[0].type } } });
  }));
  if (process.argv[3]) {
    const cam = (process.env.CAM || "2.6,2.0,0.9").split(",").map(Number), tgt = (process.env.TGT || "2.0,0.2,2.15").split(",").map(Number);
    await p.evaluate(([cam, tgt]) => { const A = window.__xr; A.S.cam = "free"; A.S.fac.setCutaway(true); A.S.fac.setTwin(false); A.S.fac.setShowMode("none"); A.flyTo(new A.THREE.Vector3(...cam), new A.THREE.Vector3(...tgt), 0.01); }, [cam, tgt]);
    for (let i = 0; i < +(process.env.STEPS || 3); i++) { await p.evaluate(() => window.__step(1 / 12)); await sleep(600); }
    await p.screenshot({ path: path.join(__dirname, "shots", process.argv[3]), timeout: 300000 });
    if (process.argv[4]) {                         // the same view with the plan reset (before)
      await p.evaluate(() => window.__xr.planning.reset());
      for (let i = 0; i < +(process.env.STEPS || 3); i++) { await p.evaluate(() => window.__step(1 / 12)); await sleep(600); }
      await p.screenshot({ path: path.join(__dirname, "shots", process.argv[4]), timeout: 300000 });
    }
  }
  await b.close(); try { process.kill(-srv.pid); } catch {}
})();
