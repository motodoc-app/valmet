// Scene list for tests/record-demo.cjs: "A technician preparing to service pump P-005", about 3 minutes.
// hold(s) = still shot held s seconds (cheap); play(s) = s seconds of real motion (one rendered frame per 1/FPS).
module.exports = async ({ p, hold, play, skip, caption, js, sleep, QUICK }) => {
  const settle = (ms = 700) => sleep(ms);
  const ui = (fn, arg) => js(fn, arg).then(() => settle());

  // 1 · Arriving virtually
  await ui(() => { const A = window.__xr; A.setMode("facility"); window.__app.fac.setShowMode("none"); });
  await caption("Industrial X-Ray — prepare a maintenance visit before you travel. This is a real 3D scan of an equipment room.");
  await hold(5);
  await ui(() => window.__app.fac.setShowMode("all"));
  await caption("676 segmented object candidates, each with a box, a name and a confidence. Not all of them are verified objects.");
  await hold(4);
  await ui(() => document.querySelector('#rail [data-rail="x:quality"]')?.click());
  await caption("Scene understanding: candidates → specific type → confident → review-corrected → linked to records.");
  await hold(6);
  await ui(() => { document.querySelector("#sheet")?.classList.add("hidden"); window.__app.fac.setShowMode("assets"); });

  // 2 · Find P-005 and understand the problem
  await caption("The technician asks: “Where is P-005?”");
  await ui(() => window.__ask("Where is P-005?"));
  await play(1.4);
  await hold(3);
  await ui(() => { document.querySelector("#pop")?.classList.add("hidden"); document.querySelector('#right [data-act="diagnose-target"]')?.click() || window.__xr.renderOverviewCard(); });
  await ui(async () => { const A = window.__xr; A.S.diag = await A.api.diagnose(A.S.target.asset.asset_id); A.S.tab = "overview"; A.renderDiagnosis(); });
  await caption("The copilot explains the likely fault, its confidence and the first safe step. Every grey tag opens its source. Data: synthetic workbook.");
  await hold(7);
  await ui(() => document.querySelector('#right [data-tab="evidence"]')?.click());
  await caption("Evidence: telemetry against the pump's own baseline and its peers, alarms and work orders.");
  await hold(5);

  // 3 · Plan access
  const hasPlan = await js(() => !!window.__xr.planning?.demo);
  if (hasPlan) {
    await caption("Plan mode: a pallet truck is parked in the pump's service area. Move a virtual stand-in — the scan is never changed.");
    await js(() => window.__xr.planning.demo());
    await settle(1500);
    await play(1.2);
    await hold(7);
    await caption("Collisions, clearance and the robot route are re-checked. Approximate geometry — not an engineering clearance check.");
    await hold(5);
  }

  // 4 · Check the way in (robot)
  await ui(() => { const A = window.__xr; A.setMode("facility"); A.S.robot.rate = 4; });
  await caption("The inspection robot checks the way in: a collision-free route, reading every asset it passes.");
  await js(() => { document.querySelector('#dock [data-cam="broadcast"]')?.click(); return window.__xr.restart(window.__xr.S.target.asset.asset_id); });
  await settle(800);
  await play(QUICK ? 1 : 3.5);
  await skip(1.5);
  await play(QUICK ? 1 : 2.5);
  await js(async () => { for (let i = 0; i < 200 && !window.__app.robot.arrived; i++) window.__step(1 / 12); });
  await settle(1500);
  await hold(4);

  // 5 · Rehearse
  await caption("X-Ray: an illustrative teaching model of the pump. Red parts are where the evidence points.");
  await js(() => window.__xr.enterXRay(null, window.__xr.S.target.asset.asset_id));
  await settle(1200);
  await play(2.5);
  await hold(4);
  await ui(() => document.querySelector('.modes [data-mode="practice"]').click());
  await caption("Practice: a scored exercise behind a safety check. Training only — not a certified procedure.");
  await hold(5);

  // 6 · Remote support
  const hasSupport = await js(() => !!window.__xr.support?.demo);
  if (hasSupport) {
    await js(() => window.__xr.support.demo());
    await settle(1500);
    await caption("Remote support: pins, the question, the plan and the evidence go to an expert as a link or package. This reply is a labelled example.");
    await play(1);
    await hold(7);
  }

  // 7 · Value
  await ui(() => document.querySelector('.modes [data-mode="value"]').click());
  await caption("Proposed value with editable, hypothetical inputs. A pilot would measure: time to find equipment, time to prepare a visit, planning issues caught.");
  await hold(7);
  await caption("Industrial X-Ray — explore the site, understand the equipment, plan the work, practise, get expert support. Before stepping onto the floor.");
  await hold(5);
  await caption("");
};
