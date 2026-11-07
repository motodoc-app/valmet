// Review labels end-to-end: open from the Scene understanding panel, review objects with every action (keyboard and
// buttons), 3D fly-to + outline, export the review layer (checked against the config/scene_annotations.json schema and
// applied with the real pipeline function), the precision-study CSV, the agreement statistics, persistence, phone sheet.
// Run after `npm run build`:  node tests/e2e-review.mjs        BASE=http://localhost:5173 node tests/e2e-review.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require("playwright"); } catch { return require("@playwright/test"); } })();

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.join(here, "..", "..");
const SHOTS = process.env.SHOTS || path.join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
const TMP = path.join(os.tmpdir(), `xr-review-${process.pid}`); mkdirSync(TMP, { recursive: true });
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4400 + Math.floor(Math.random() * 100);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe" });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
console.log("testing", BASE);
const waitFor = async (p, fn, arg, ms = 30000) => { try { await p.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; } catch { return false; } };

async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(BASE + "?scan=off&noguide");
  await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading"), null, 90000);
  await p.evaluate(() => document.querySelector(".toast")?.remove());
  return p;
}
const cur = (p) => p.evaluate(() => window.__review.R.cur);
const progress = (p) => p.evaluate(() => document.querySelector("#review .rv-prog-t")?.textContent.trim());
async function camNear(p, id) {     // the camera target arrives at the object centre
  return waitFor(p, (id) => {
    const o = window.__app.objById.get(id), t = window.__xr.controls.target;
    return Math.hypot(t.x - o.center[0], t.y - o.center[1], t.z - o.center[2]) < 0.05;
  }, id, 20000);
}
async function download(p, sel) {
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), p.click(sel)]);
  const f = path.join(TMP, d.suggestedFilename()); await d.saveAs(f); return f;
}

const browser = await chromium.launch({ args: GL });
try {
  // ---------------------------------------------------------------- desktop review
  const p = await open(browser);
  await p.evaluate(() => { try { localStorage.removeItem("xr.labelReview.v1"); } catch {} });
  await p.click('#rail [data-rail="x:quality"]');
  ok("quality panel has a Review labels button", await waitFor(p, () => document.querySelector("#sheet .q-body [data-q-review]")));
  await p.click("#sheet [data-q-review]");
  ok("review panel opens, sheet closes", await waitFor(p, () => document.querySelector("#review .rv-actions") && document.querySelector("#sheet").classList.contains("hidden")));
  const q = await p.evaluate(() => window.__review.queue().map((o) => ({ id: o.id, c: o.confidence, l: o.label })));
  const need = await p.evaluate(() => window.__app.data.objects.filter((o) => o.kind === "object" && (o.confidence < 0.7 || o.label === "other equipment")).length);
  ok("queue = low-confidence or 'other equipment' candidates", q.length === need && need > 100, `${q.length} in queue`);
  ok("queue sorted lowest confidence first", q.every((o, i) => !i || q[i - 1].c <= o.c));
  ok("progress bar text", /^0 of \d+ reviewed/.test(await progress(p)), await progress(p));
  const first = await cur(p);
  ok("first object = lowest confidence", first === q[0].id, first);
  ok("3D: camera flies to the object", await camNear(p, first));
  ok("3D: object highlighted + amber outline", await p.evaluate((id) => window.__app.fac.highlight.has(id) && window.__review.R.box?.visible, first));
  const shown = await p.evaluate(() => document.querySelector("#review .rv-body").textContent);
  ok("card shows label, confidence, source, size, linked asset", ["The AI proposed", "confidence", "Label source", "Size", "Linked asset"].every((s) => shown.includes(s)));
  await p.screenshot({ path: path.join(SHOTS, "review-desktop.png") });

  // reviewer name (summary tab), then back to the queue
  await p.click('#review [data-rv-tab="summary"]');
  await p.fill("#rvName", "Test Reviewer");
  await p.click('#review [data-rv-tab="item"]');
  await p.evaluate(() => document.activeElement?.blur());

  const ids = [];
  // 1. Y = correct as is
  ids.push(await cur(p)); await p.keyboard.press("y");
  ok("Y confirms and advances", await waitFor(p, (id) => window.__review.R.decisions[id]?.verdict === "agree" && window.__review.R.cur !== id, ids[0]));
  ok("progress counts the decision", /^1 of /.test(await progress(p)), await progress(p));
  // 2. R = rename (free text + category)
  ids.push(await cur(p)); await p.keyboard.press("r");
  ok("R opens the rename form with focus in the label", await waitFor(p, () => document.activeElement?.id === "rvLabel"));
  await p.fill("#rvLabel", "manual valve");
  await p.selectOption("#rvCat", "valve");
  await p.fill("#rvNote", "hand wheel visible");
  await p.focus("#rvLabel"); await p.keyboard.press("Enter");
  ok("rename stored", await waitFor(p, (id) => { const d = window.__review.R.decisions[id]; return d?.verdict === "rename" && d.new_label === "manual valve" && d.new_category === "valve"; }, ids[1]));
  // 3. N = not an object / fragment
  ids.push(await cur(p)); await p.keyboard.press("n");
  ok("N rejects", await waitFor(p, (id) => window.__review.R.decisions[id]?.verdict === "reject", ids[2]));
  // 4. → = skip (no decision)
  const sk = await cur(p); await p.keyboard.press("ArrowRight");
  ok("→ skips without a decision", await waitFor(p, (id) => window.__review.R.cur !== id && !window.__review.R.decisions[id], sk));
  // 5. buttons: ✓ and ✗ by mouse, then Undo
  ids.push(await cur(p)); await p.click("#review .rv-yes");
  ok("✓ button confirms", await waitFor(p, (id) => window.__review.R.decisions[id]?.verdict === "agree", ids[3]));
  const u = await cur(p); await p.click("#review .rv-no");
  await waitFor(p, (id) => window.__review.R.decisions[id], u);
  await p.click('#review [data-rv="undo"]');
  ok("Undo removes the last decision and returns to it", await waitFor(p, (id) => !window.__review.R.decisions[id] && window.__review.R.cur === id, u));
  ok("4 decisions after undo", await p.evaluate(() => Object.keys(window.__review.R.decisions).length) === 4);
  ok("camera arrived at the current object", await camNear(p, await cur(p)));

  // sort options
  await p.selectOption("#review [data-rv-sort]", "linked");
  const qa = await p.evaluate(() => window.__review.queue().slice(0, 3).map((o) => !!o.asset));
  ok("sort: linked-to-asset first", qa.every(Boolean));
  await p.selectOption("#review [data-rv-sort]", "size");
  const qs = await p.evaluate(() => window.__review.queue().slice(0, 20).map((o) => o.size[0] * o.size[1] * o.size[2]));
  ok("sort: largest first", qs.every((v, i) => !i || qs[i - 1] >= v));
  await p.selectOption("#review [data-rv-sort]", "conf");

  // ---------------------------------------------------------------- summary + stats
  await p.click('#review [data-rv-tab="summary"]');
  const st = await p.evaluate(() => window.__review.stats());
  ok("summary: 2 agreed / 1 renamed / 1 rejected", st.agreed === 2 && st.renamed === 1 && st.rejected === 1 && st.n === 4, JSON.stringify(st.ci));
  // Wilson 95% for 2/4: 15.0%–85.0%
  ok("Wilson 95% interval", Math.abs(st.ci[0] - 0.1500) < 0.002 && Math.abs(st.ci[1] - 0.8500) < 0.002, st.ci.map((x) => x.toFixed(4)).join("–"));
  const sumTxt = await p.evaluate(() => document.querySelector("#review .rv-body").textContent);
  ok("summary labelled 'your review' with rate + CI", /Your review/.test(sumTxt) && /50%/.test(sumTxt) && /95% Wilson 15%–85%/.test(sumTxt) && /not all/.test(sumTxt));
  await p.screenshot({ path: path.join(SHOTS, "review-summary.png") });

  // ---------------------------------------------------------------- export JSON: annotations schema + real pipeline merge
  const jf = await download(p, '#review [data-rv="json"]');
  const J = JSON.parse(readFileSync(jf, "utf8"));
  const A = JSON.parse(readFileSync(path.join(repo, "config", "scene_annotations.json"), "utf8"));
  // the export is a review layer: its keys are the config's review sections (the config may also carry settings such as demo_start)
  ok("JSON: review sections match config/scene_annotations.json", ["_doc", "merge_regions", "relabel_near"].every((k) => k in J && k in A) && Object.keys(J).every((k) => k in A), Object.keys(J).join(","));
  const keysA = JSON.stringify(Object.keys(A.relabel_near[0]).sort());
  ok("JSON: relabel_near entries have exactly point/label/category/note", J.relabel_near.length === 4 && J.relabel_near.every((r) => JSON.stringify(Object.keys(r).sort()) === keysA
    && r.point.length === 3 && r.point.every(Number.isFinite) && r.label && r.category));
  ok("JSON: notes say who and when", J.relabel_near.every((r) => /^(Confirmed|Renamed|Rejected) in review by Test Reviewer on \d{4}-\d{2}-\d{2}/.test(r.note)), J.relabel_near[0].note);
  const cen = await p.evaluate((ids) => ids.map((id) => window.__app.objById.get(id).center), ids);
  const sorted = [...ids].map((id, i) => [id, cen[i]]).sort((a, b) => a[0].localeCompare(b[0]));
  ok("JSON: point = object centre", sorted.every(([, c], i) => c.every((v, k) => Math.abs(v - J.relabel_near[i].point[k]) < 0.001)));
  ok("JSON: rename + reject carried", J.relabel_near.some((r) => r.label === "manual valve" && r.category === "valve" && /hand wheel/.test(r.note))
    && J.relabel_near.some((r) => r.label === "not an object / fragment"));
  // merge with scripts/merge_review.py into a copy of the config, then apply it with step2_semantics.apply_annotations
  const cfg = path.join(TMP, "scene_annotations.json"); copyFileSync(path.join(repo, "config", "scene_annotations.json"), cfg);
  const m = spawnSync("python3", ["scripts/merge_review.py", jf, "--into", cfg], { cwd: repo, encoding: "utf8" });
  ok("merge_review.py merges the export", m.status === 0 && /4 added/.test(m.stdout), (m.stdout + m.stderr).trim().split("\n")[0]);
  const py = `import sys, json; sys.path.insert(0, 'scripts'); from pathlib import Path; from step2_semantics import apply_annotations
objs = json.load(open('web/public/static/scene.json'))['objects']
out = {o['id']: o for o in apply_annotations(objs, Path(sys.argv[1]))}
print(json.dumps({i: [out[i]['label'], out[i]['label_source']] for i in sys.argv[2:]}))`;
  writeFileSync(path.join(TMP, "apply.py"), py);
  const r = spawnSync("python3", [path.join(TMP, "apply.py"), cfg, ...ids], { cwd: repo, encoding: "utf8" });
  let applied = {}; try { applied = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  const dec = await p.evaluate(() => window.__review.R.decisions);
  ok("pipeline applies every decision to the right object", ids.every((id) => applied[id]?.[1] === "review-corrected"
    && applied[id][0] === (dec[id].verdict === "agree" ? dec[id].label : dec[id].new_label)), r.status ? r.stderr.slice(-300) : JSON.stringify(applied));

  // ---------------------------------------------------------------- CSV
  const cf = await download(p, '#review [data-rv="csv"]');
  const lines = readFileSync(cf, "utf8").trim().split(/\r?\n/);
  const sampleHead = readFileSync(path.join(repo, "docs", "label_review_sample.csv"), "utf8").split(/\r?\n/)[0].split(",");
  const head = lines[0].split(",");
  ok("CSV: starts with the label_review_sample.csv columns", JSON.stringify(head.slice(0, sampleHead.length)) === JSON.stringify(sampleHead), lines[0]);
  ok("CSV: verdict, new_label, reviewer, time columns", ["verdict", "new_label", "reviewer", "time"].every((c) => head.includes(c)));
  ok("CSV: one row per decision", lines.length === 5 && lines.slice(1).every((l) => /Test Reviewer/.test(l)));
  ok("CSV: human_verdict agree/disagree", lines.slice(1).every((l) => /,(agree|disagree),/.test(l)));

  // ---------------------------------------------------------------- persistence + close
  await p.click('#review [data-rv="close"]');
  ok("close removes the panel and the outline", await waitFor(p, () => !document.querySelector("#review") && !window.__review.R.box.visible));
  await p.reload();
  await waitFor(p, () => window.__app?.fac && !document.querySelector("#loading"), null, 90000);
  await p.evaluate(() => window.__review.open({ threshold: 0.7 }));
  ok("decisions persist across reloads (localStorage)", await waitFor(p, () => window.__review.stats().n === 4 && /^4 of /.test(document.querySelector("#review .rv-prog-t").textContent)));
  ok("no page errors (desktop)", !p.errors.length, p.errors.slice(0, 3).join(" | "));
  await p.context().close();

  // ---------------------------------------------------------------- phone: bottom sheet, big buttons
  const m2 = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await m2.evaluate(() => { try { localStorage.removeItem("xr.labelReview.v1"); } catch {} });
  // phones reach the panel through Tools → Scene understanding
  await m2.evaluate(() => document.querySelector('#rail [data-rail="x:quality"]').click());
  await waitFor(m2, () => document.querySelector("#sheet [data-q-review]"));
  await m2.tap("#sheet [data-q-review]");
  ok("phone: review opens", await waitFor(m2, () => document.querySelector("#review .rv-actions")));
  const g = await m2.evaluate(() => {
    const r = document.querySelector("#review").getBoundingClientRect(), b = [...document.querySelectorAll("#review .rv-actions .btn")].map((x) => x.getBoundingClientRect());
    return { bottom: Math.round(r.bottom), left: r.left, w: r.width, h: r.height, vh: innerHeight, vw: innerWidth, minH: Math.min(...b.map((x) => x.height)), sw: document.documentElement.scrollWidth };
  });
  ok("phone: bottom sheet, full width", Math.abs(g.bottom - g.vh) <= 1 && g.left === 0 && Math.abs(g.w - g.vw) <= 1 && g.h <= g.vh * 0.6, JSON.stringify(g));
  ok("phone: big buttons (≥ 48 px)", g.minH >= 48, `${g.minH}px`);
  ok("phone: no horizontal scroll", g.sw <= g.vw);
  await m2.tap("#review .rv-yes");
  ok("phone: tap confirms", await waitFor(m2, () => window.__review.stats().agreed === 1));
  ok("phone: object framed above the sheet", await waitFor(m2, () => {
    const X = window.__xr, o = window.__app.objById.get(window.__review.R.cur);
    const v = new X.THREE.Vector3(...o.center).project(X.camera), y = (1 - v.y) / 2 * innerHeight;
    return y > 90 && y < document.querySelector("#review").getBoundingClientRect().top;
  }, null, 20000));
  await sleep(1500);
  await m2.screenshot({ path: path.join(SHOTS, "review-phone.png") });
  ok("no page errors (phone)", !m2.errors.length, m2.errors.slice(0, 3).join(" | "));
  await m2.context().close();
} catch (e) {
  ok("unexpected exception", false, e.stack);
} finally {
  await browser.close();
  server?.kill();
}
const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
