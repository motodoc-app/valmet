// Scene list for tests/record-demo.cjs, driven by docs/video/timing.json (made by scripts/make_narration.py):
// every narration line becomes one scene that lasts exactly as long as its audio, with the line as an English
// subtitle. Motion is rendered frame by frame only where it matters (camera flights, robot, X-Ray); the rest are stills.
const fs = require("fs"), path = require("path");
const TIMING = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/video/timing.json"), "utf8"));

module.exports = async ({ hold, play, caption, js, sleep, QUICK }) => {
  const settle = (ms = 800) => sleep(ms);
  const title = (big, small) => js(([b, s]) => {
    let t = document.getElementById("rec-title");
    if (!t) { t = document.createElement("div"); t.id = "rec-title"; document.getElementById("app").appendChild(t);
      t.style.cssText = "position:absolute;inset:0;z-index:29;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:0 9%;background:linear-gradient(90deg,rgba(10,11,13,.94) 0%,rgba(10,11,13,.82) 55%,rgba(10,11,13,.35) 100%);color:#f2f3f5;font-family:-apple-system,Segoe UI,Inter,sans-serif"; }
    t.innerHTML = b ? `<div style="font-size:15px;letter-spacing:.32em;text-transform:uppercase;color:#7fb2ff;margin-bottom:18px">${s}</div><div style="font-size:46px;font-weight:600;line-height:1.15;max-width:760px">${b}</div>` : "";
    t.style.display = b ? "flex" : "none";
  }, [big, small]);
  const scenes = {
    title: async (i) => { await js(() => { const A = window.__xr; A.setMode("facility"); window.__app.fac.setShowMode("none"); });
      await title(i === 0 ? "The first visit to an unfamiliar plant is where the time goes." : "Find it. Understand it. Reach it. Get help.", "The problem"); return 0; },
    scan: async () => { await title(""); await js(() => { const A = window.__xr; A.flyHome?.() ?? A.flyTo(A.S.home.pos, A.S.home.tgt); }); return 1.2; },
    semantic: async () => { await js(() => window.__layers?.setSemantic?.(true)); return 0; },
    quality: async () => { await js(() => { window.__layers?.setSemantic?.(false); document.querySelector('#rail [data-rail="x:quality"]')?.click(); }); return 0; },
    find: async () => { await js(() => { document.querySelector("#sheet")?.classList.add("hidden"); window.__app.fac.setShowMode("assets"); return window.__ask("Where is P-005?"); }); return 1.4; },
    diagnosis: async () => { await js(async () => { document.querySelector("#pop")?.classList.add("hidden"); const A = window.__xr; A.S.diag = await A.api.diagnose(A.S.target.asset.asset_id); A.S.tab = "overview"; A.S.cardLock = true; A.renderDiagnosis(); }); return 0; },
    plan: async () => { await js(() => window.__xr.planning?.demo?.()); return 1.2; },
    robot: async () => { await js(() => { const A = window.__xr; A.setMode("facility"); document.querySelector('#dock [data-cam="broadcast"]')?.click(); A.S.robot.rate = 4; return A.restart(A.S.target.asset.asset_id); }); return QUICK ? 1 : 3; },
    xray: async () => { await js(() => window.__xr.enterXRay(null, window.__xr.S.target.asset.asset_id)); return 2.2; },
    support: async () => { await js(() => window.__xr.support?.demo?.()); return 0.6; },
    value: async (i) => { if (i === 11) await js(() => document.querySelector('.modes [data-mode="value"]').click()); return 0; },
    end: async () => { await title("Know the site before you set foot in it.", "Industrial X-Ray · the pre-visit copilot"); return 0; },
  };
  await js(() => document.querySelector(".toast")?.remove());
  for (const [i, line] of TIMING.lines.entries()) {
    const dur = line.duration + TIMING.gap;
    const motion = await scenes[line.scene](i);
    await settle();
    await js(() => document.querySelector(".toast")?.remove());
    await caption(line.text);
    const m = Math.min(motion, dur - 0.3);
    if (m > 0) await play(m);
    await hold(dur - Math.max(m, 0));
    process.stdout.write(` [${i} ${line.scene}]`);
  }
  await caption("");
};
