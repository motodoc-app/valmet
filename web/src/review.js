// "Review labels": a person confirms, renames or rejects the vision model's object labels, one object at a time.
// The AI proposed, a person confirms. Decisions stay in this browser (localStorage) and are EXPORTED as a review layer
// in exactly the config/scene_annotations.json format (relabel_near entries), plus a CSV for the precision study that
// keeps the columns of docs/label_review_sample.csv. Nothing is written to the server: the hosted demo is static.
// Opened from the Scene understanding panel (quality.js). Uses only APP (ext.js); no edits to main.js.
import "./review.css";
import { APP } from "./ext.js";
import { icon } from "./icons.js";

const STORE = "xr.labelReview.v1";
const REJECT_LABEL = "not an object / fragment";
const OTHER = "other equipment";
const CROP_DIR = "data/processed/crops";
// the taxonomy of category values used in scene.json (VLM + review layer)
const CATS = [
  ["rotating", "Rotating (pumps, motors)"], ["piping", "Piping"], ["valve", "Valves"], ["instrument", "Instruments"],
  ["electrical", "Electrical"], ["vessel", "Vessels, exchangers"], ["logistics", "Logistics (carts, pallets)"],
  ["structure", "Structure"], ["other", "Other / unidentified"],
];
const SORTS = { conf: "Lowest confidence first", linked: "Linked to an asset first", size: "Largest first" };
const SCOPES = { needs: "Needs review", all: "All candidates" };

const R = {
  open: false, tab: "item", cur: null, renaming: false, history: [],
  sort: "conf", scope: "needs", reviewer: "", decisions: {},   // persisted
  T: 0.7, flags: {}, box: null,
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pc = (x, d = 0) => `${(100 * x).toFixed(d)}%`;
const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
const today = () => new Date().toISOString().slice(0, 10);
const $p = () => document.getElementById("review");

// ------------------------------------------------------------------ persistence (per browser; never required)
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (s && typeof s === "object") {
      R.decisions = s.decisions && typeof s.decisions === "object" ? s.decisions : {};
      R.reviewer = typeof s.reviewer === "string" ? s.reviewer : "";
      if (SORTS[s.sort]) R.sort = s.sort;
      if (SCOPES[s.scope]) R.scope = s.scope;
      if (typeof s.cur === "string") R.cur = s.cur;
    }
  } catch { /* private window / blocked storage: the review still works for this session */ }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ decisions: R.decisions, reviewer: R.reviewer, sort: R.sort, scope: R.scope, cur: R.cur })); } catch {}
}

// ------------------------------------------------------------------ queue
const objects = () => (APP.S?.data?.objects || []).filter((o) => o.kind === "object");
const byId = (id) => APP.S?.objById?.get?.(id) || objects().find((o) => o.id === id);
const needsReview = (o) => o.confidence < R.T || o.label === OTHER;
const vol = (o) => o.size[0] * o.size[1] * o.size[2];
function queue() {
  const list = objects().filter((o) => R.scope === "all" || needsReview(o));
  const conf = (a, b) => a.confidence - b.confidence || (b.label === OTHER) - (a.label === OTHER) || a.id.localeCompare(b.id);
  const cmp = {
    conf,
    linked: (a, b) => !!b.asset - !!a.asset || conf(a, b),
    size: (a, b) => vol(b) - vol(a) || a.id.localeCompare(b.id),
  }[R.sort];
  return list.sort(cmp);
}
const done = (q) => q.filter((o) => R.decisions[o.id]).length;
/** Next undecided object after `fromId` in queue order (wraps); null when everything is reviewed. */
function nextOpen(q, fromId, skipSelf = true) {
  let i0 = q.findIndex((o) => o.id === fromId);
  if (i0 < 0) { i0 = 0; skipSelf = false; }
  for (let k = skipSelf ? 1 : 0; k <= q.length; k++) {
    const o = q[(i0 + k) % q.length];
    if (o && !R.decisions[o.id]) return o;
  }
  return null;
}

// ------------------------------------------------------------------ statistics (the reviewer's own check)
/** Wilson score interval, 95 %. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export function stats() {
  const ds = Object.values(R.decisions);
  const n = ds.length, agreed = ds.filter((d) => d.verdict === "agree").length;
  const renamed = ds.filter((d) => d.verdict === "rename").length, rejected = ds.filter((d) => d.verdict === "reject").length;
  const split = (hi) => { const s = ds.filter((d) => (d.confidence >= R.T) === hi); const a = s.filter((d) => d.verdict === "agree").length; return { n: s.length, agree: a, ci: wilson(a, s.length) }; };
  return { n, agreed, renamed, rejected, rate: n ? agreed / n : 0, ci: wilson(agreed, n), high: split(true), low: split(false) };
}

// ------------------------------------------------------------------ decisions
function decide(verdict, extra = {}) {
  const o = byId(R.cur); if (!o) return;
  R.decisions[o.id] = {
    id: o.id, verdict, label: o.label, category: o.category, confidence: o.confidence, label_source: o.label_source,
    point: o.center.map((v) => +v.toFixed(3)), time: new Date().toISOString(), reviewer: R.reviewer.trim(),
    ...(verdict === "rename" ? { new_label: extra.label, new_category: extra.category, comment: extra.comment || "" } : {}),
    ...(verdict === "reject" ? { new_label: REJECT_LABEL, new_category: "other" } : {}),
  };
  R.history.push(o.id);
  R.renaming = false;
  advance();
}
function advance() {
  const q = queue(), n = nextOpen(q, R.cur);
  save();
  if (n) show(n.id);
  else { R.tab = "summary"; render(); APP.toast?.("Queue reviewed. Download the review layer from the summary.", 3500); }
}
function skip() {
  const q = queue(); if (!q.length) return;
  const i = q.findIndex((o) => o.id === R.cur);
  // the next object in queue order that is still open (skipped objects stay open and come round again)
  for (let k = 1; k <= q.length; k++) { const o = q[(i + k) % q.length]; if (!R.decisions[o.id] || k === q.length) return show(o.id); }
}
function back() {
  const q = queue(), i = q.findIndex((o) => o.id === R.cur);
  if (i > 0) show(q[i - 1].id);
}
function undo() {
  const id = R.history.pop(); if (!id) return;
  delete R.decisions[id]; save(); show(id);
}

// ------------------------------------------------------------------ 3D: fly to the object and outline it
function focus3D(o) {
  const A = APP, S = A.S, f = S?.fac; if (!f || !o) return;
  try { if (A.sceneMode && !A.sceneMode()) A.setMode?.("facility"); } catch (e) { console.warn(e); }
  f.setHighlighted([o.id], { selected: S.selected?.id ?? null, target: S.target?.id ?? null });
  try {
    if (!R.box && f._outlineBox) R.box = f._outlineBox(0xffd60a, 1);   // amber: "under review", distinct from the white selection
    if (R.box && f._placeBox) { f._placeBox(R.box, o, 0.06); R.box.visible = true; }
  } catch (e) { console.warn("review outline", e); }
  const T = A.THREE, c = new T.Vector3(...o.center), off = A.viewOffset ? A.viewOffset(c) : new T.Vector3(1.9, 1.15, 0);
  const k = Math.min(2.6, Math.max(0.6, Math.max(...o.size) / 1.1));     // stand back for big frames, step in for tags
  // phones: the bottom sheet covers the lower half, so step back (narrow portrait view) and frame the object in the band above it
  const pr = $p()?.getBoundingClientRect(), H = innerHeight, sheet = pr && pr.width > innerWidth * 0.9 && pr.top > H * 0.3;
  const kk = sheet ? k * 1.5 : k;
  const pos = c.clone().add(new T.Vector3(off.x * kk, Math.max(0.45, off.y * kk * 0.85), off.z * kk)), tgt = c.clone();
  if (sheet) {
    const top = Math.min(H * 0.3, document.getElementById("dock")?.getBoundingClientRect().bottom || 100);   // top bar + dock
    const px = H / 2 - (top + pr.top) / 2;
    const fwd = c.clone().sub(pos).normalize(), up = new T.Vector3().crossVectors(new T.Vector3().crossVectors(fwd, new T.Vector3(0, 1, 0)).normalize(), fwd);
    const s = (px / (H / 2)) * pos.distanceTo(c) * Math.tan(((A.camera?.fov || 50) * Math.PI) / 360);
    pos.addScaledVector(up, -s); tgt.addScaledVector(up, -s);
  }
  A.flyTo(pos, tgt, 0.9);
}
function clear3D() {
  const S = APP.S, f = S?.fac; if (!f) return;
  if (R.box) R.box.visible = false;
  f.setHighlighted([], { selected: S.selected?.id ?? null, target: S.target?.id ?? null });
}

// ------------------------------------------------------------------ rendering
function show(id) {
  R.cur = id; R.tab = "item"; R.renaming = false; save();
  render();
  focus3D(byId(id));
}
const size = (o) => o.size.map((v) => (v < 1 ? `${Math.round(v * 100)} cm` : `${v.toFixed(2)} m`)).join(" × ");
const FLAG = { fragment: "fragment of a larger object?", possible_overmerge: "possibly several objects in one frame", tiny: "tiny (< 15 cm)",
  flat: "flat (< 4 cm)", low_points: "few scan points", label_size_mismatch: "size does not fit the label", nested: "inside a larger frame" };
const labelsUsed = () => [...new Set(objects().map((o) => o.label))].filter((l) => l !== REJECT_LABEL).sort();
function catFor(label) {
  const c = {}; for (const o of objects()) if (o.label === label) c[o.category] = (c[o.category] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function verdictText(d) {
  if (!d) return "";
  const who = d.reviewer ? ` by ${esc(d.reviewer)}` : "";
  if (d.verdict === "agree") return `You confirmed this label${who}.`;
  if (d.verdict === "reject") return `You marked this as not an object / fragment${who}.`;
  return `You renamed this to <b>${esc(d.new_label)}</b> (${esc(d.new_category)})${who}.`;
}

function itemHTML(q) {
  const o = byId(R.cur);
  if (!o) return `<p class="p">Nothing to review in this queue.</p>`;
  const i = q.findIndex((x) => x.id === o.id), d = R.decisions[o.id], fl = R.flags[o.id] || [];
  const confCls = o.confidence >= R.T ? "hi" : o.confidence >= 0.5 ? "mid" : "lo";
  const a = o.asset;
  const rename = R.renaming ? `
    <form class="rv-rename" data-rv-form>
      <label class="rv-f"><span>New label</span><input id="rvLabel" list="rvLabels" autocomplete="off" required value="${esc(o.label === OTHER ? "" : o.label)}" placeholder="e.g. control valve"/></label>
      <datalist id="rvLabels">${labelsUsed().map((l) => `<option value="${esc(l)}"></option>`).join("")}</datalist>
      <label class="rv-f"><span>Category</span><select id="rvCat">${CATS.map(([v, t]) => `<option value="${v}"${v === o.category ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="rv-f"><span>Comment (optional)</span><input id="rvNote" autocomplete="off" placeholder="what you saw, e.g. 'small hand valve on the return line'"/></label>
      <div class="rv-row"><button type="submit" class="btn primary">Save rename <span class="kbd">Enter</span></button>
        <button type="button" class="btn" data-rv="cancel">Cancel <span class="kbd">Esc</span></button></div>
    </form>` : `
    <div class="rv-actions">
      <button class="btn rv-yes" data-rv="agree"><span class="rv-g">✓</span>Correct as is <span class="kbd">Y</span></button>
      <button class="btn rv-ren" data-rv="rename"><span class="rv-g">✎</span>Rename <span class="kbd">R</span></button>
      <button class="btn rv-no" data-rv="reject"><span class="rv-g">✗</span>Not an object <span class="kbd">N</span></button>
      <button class="btn rv-skip" data-rv="skip">Skip <span class="kbd">→</span></button>
    </div>`;
  return `
    <div class="rv-pos"><span>${i + 1} / ${q.length} in queue · <code>${esc(o.id)}</code></span>
      <span><button class="link" data-rv="back" ${i > 0 ? "" : "disabled"}>← Back</button>
      <button class="link" data-rv="undo" ${R.history.length ? "" : "disabled"}>Undo</button></span></div>
    <div class="rv-ai">The AI proposed</div>
    <div class="rv-label">${esc(o.label)}</div>
    <div class="rv-conf ${confCls}"><span class="meter"><i style="width:${pc(o.confidence)}"></i></span><span>${pc(o.confidence)} confidence</span></div>
    ${d ? `<p class="note rv-done">${verdictText(d)} Choose again to change it.</p>` : ""}
    ${rename}
    <div class="rv-facts">
      ${kv("Label source", esc(o.label_source))}
      ${kv("Category", esc(o.category))}
      ${kv("Size (w × h × d)", size(o))}
      ${kv("Linked asset", a ? `<b>${esc(a.tag)}</b> · ${esc(a.asset_class.toLowerCase().replace(/_/g, " "))}` : "none")}
      ${fl.length ? kv("Data-quality hints", fl.map((x) => esc(FLAG[x] || x)).join("; ")) : ""}
      ${o.vlm_rationale ? `<p class="note rv-why">Model's reason: “${esc(o.vlm_rationale)}”</p>` : ""}
      ${o.review_note ? `<p class="note rv-why">Earlier review: ${esc(o.review_note)}</p>` : ""}
    </div>`;
}

function summaryHTML() {
  const s = stats(), w = (ci) => `${pc(ci[0])}–${pc(ci[1])}`;
  const name = R.reviewer.trim();
  return `
    <label class="rv-f"><span>Reviewer name (goes into every exported note)</span>
      <input id="rvName" autocomplete="name" value="${esc(R.reviewer)}" placeholder="e.g. A. Virtanen, site engineer"/></label>
    <div class="section"><div class="label"><span>Your review</span><span>a human check in the 3D view</span></div>
      <div class="rv-tally">
        <div><b>${s.agreed}</b><span>agreed</span></div><div><b>${s.renamed}</b><span>renamed</span></div>
        <div><b>${s.rejected}</b><span>rejected</span></div><div><b>${s.n}</b><span>reviewed</span></div></div>
      ${s.n ? `${kv("Observed agreement with the AI label", `<b>${pc(s.rate)}</b> <span class="q-ci">(95% Wilson ${w(s.ci)}, n = ${s.n})</span>`)}
        ${s.high.n ? kv(`Confidence ≥ ${R.T.toFixed(2)}`, `${s.high.agree}/${s.high.n} <span class="q-ci">(${w(s.high.ci)})</span>`) : ""}
        ${s.low.n ? kv(`Confidence < ${R.T.toFixed(2)}`, `${s.low.agree}/${s.low.n} <span class="q-ci">(${w(s.low.ci)})</span>`) : ""}` : `<p class="note">No decisions yet.</p>`}
      <p class="note" style="margin-top:8px">This is <b>your review</b>: a person judged each object, unlike the AI second-opinion audit in the
      Scene understanding panel. The queue puts uncertain objects first, so the rate describes the objects you reviewed, not all ${objects().length} candidates.</p></div>
    <div class="section"><div class="label"><span>Export</span><span>download only: the hosted demo cannot write files</span></div>
      <div class="rv-row">
        <button class="btn primary" data-rv="json" ${s.n ? "" : "disabled"}>Review layer (.json)</button>
        <button class="btn" data-rv="csv" ${s.n ? "" : "disabled"}>Precision study (.csv)</button></div>
      ${s.n && !name ? `<p class="note q-warn" style="margin-top:8px">Add your name above so the notes say who confirmed each label.</p>` : ""}
      <p class="note" style="margin-top:8px">The JSON is in the <code>config/scene_annotations.json</code> format (one <code>relabel_near</code> entry per decision,
      point = object centre). Merge it with <code>python scripts/merge_review.py &lt;file&gt;</code>, then re-run
      <code>python scripts/run_pipeline.py --from 2</code>. See <code>docs/REPLICATE.md</code>.</p></div>
    <div class="section"><button class="link" data-rv="reset" ${s.n ? "" : "disabled"}>Clear all decisions in this browser</button></div>`;
}

function render() {
  let p = $p();
  if (!p) {
    p = document.createElement("section");
    p.id = "review"; p.className = "card rv-panel"; p.setAttribute("role", "dialog"); p.setAttribute("aria-label", "Review labels");
    const sheet = document.getElementById("sheet");
    (sheet?.parentNode || document.body).insertBefore(p, sheet?.nextSibling || null);
    p.addEventListener("click", onClick);
    p.addEventListener("submit", onSubmit);
    p.addEventListener("change", onChange);
    p.addEventListener("input", (e) => { if (e.target.id === "rvName") { R.reviewer = e.target.value; save(); } });
  }
  const q = queue(), n = done(q), all = Object.keys(R.decisions).length;
  if (R.tab === "item" && (!R.cur || !q.some((o) => o.id === R.cur))) R.cur = (nextOpen(q, q[0]?.id, false) || q[0])?.id || null;
  p.innerHTML = `
    <div class="card-h"><span class="t">Review labels · the AI proposed, you confirm</span>
      <button class="link" data-rv="close" aria-label="Close review">${icon("close")}</button></div>
    <div class="card-b">
      <div class="rv-prog"><div class="rv-prog-t"><b>${n}</b> of ${q.length} reviewed${all > n ? ` <span class="q-ci">(${all} in total)</span>` : ""}</div>
        <span class="q-bar"><i style="width:${q.length ? (100 * n) / q.length : 0}%"></i></span></div>
      <div class="rv-opts">
        <select data-rv-scope aria-label="Queue">${Object.entries(SCOPES).map(([k, t]) => `<option value="${k}"${k === R.scope ? " selected" : ""}>${t} (${k === "all" ? objects().length : objects().filter(needsReview).length})</option>`).join("")}</select>
        <select data-rv-sort aria-label="Order">${Object.entries(SORTS).map(([k, t]) => `<option value="${k}"${k === R.sort ? " selected" : ""}>${t}</option>`).join("")}</select>
      </div>
      <div class="tabs"><button class="${R.tab === "item" ? "on" : ""}" data-rv-tab="item">Review</button>
        <button class="${R.tab === "summary" ? "on" : ""}" data-rv-tab="summary">Summary &amp; export</button></div>
      <div class="rv-body">${R.tab === "item" ? itemHTML(q) : summaryHTML()}</div>
    </div>`;
  if (R.renaming) setTimeout(() => document.getElementById("rvLabel")?.focus(), 0);
}

// ------------------------------------------------------------------ export
function note(d, name, date) {
  const was = `The vision model proposed '${d.label}' (${d.confidence.toFixed(2)}).`;
  if (d.verdict === "agree") return `Confirmed in review by ${name} on ${date}. ${was}`;
  if (d.verdict === "reject") return `Rejected in review by ${name} on ${date}: not an object / fragment. ${was}`;
  return `Renamed in review by ${name} on ${date}. ${was}${d.comment ? ` ${d.comment}` : ""}`;
}
export function exportJSON() {
  const name = R.reviewer.trim() || "an unnamed reviewer", ds = Object.values(R.decisions).sort((a, b) => a.id.localeCompare(b.id));
  return {
    _doc: `Review layer exported from the Industrial X-Ray 'Review labels' panel (${ds.length} decisions by ${name}, ${today()}). ` +
      "A person checked each object in the 3D view: 'Confirmed' keeps the vision-model label, 'Renamed' corrects it, 'Rejected' marks a " +
      `fragment or non-object (label '${REJECT_LABEL}'). Points are object centres in the canonical scene frame (metres, +Y up); ` +
      "step2_semantics.py relabels the nearest candidate within 0.3 m. Merge into config/scene_annotations.json " +
      "(python scripts/merge_review.py <this file>) and re-run python scripts/run_pipeline.py --from 2.",
    merge_regions: [],
    relabel_near: ds.map((d) => {
      const date = d.time.slice(0, 10), who = d.reviewer || name;
      const label = d.verdict === "agree" ? d.label : d.new_label, category = d.verdict === "agree" ? d.category : d.new_category;
      return { point: d.point, label, category, note: note(d, who, date) };
    }),
  };
}
const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// first eight columns = docs/label_review_sample.csv (human_verdict: agree | disagree), then the review's own columns
export function exportCSV() {
  const head = ["id", "label", "confidence", "stratum", "crop_path", "human_verdict", "human_correct_label", "notes", "verdict", "new_label", "reviewer", "time"];
  const V = { agree: "confirmed", rename: "renamed", reject: "rejected" };
  const rows = Object.values(R.decisions).sort((a, b) => a.id.localeCompare(b.id)).map((d) => [
    d.id, d.label, d.confidence, d.label !== OTHER ? d.label : "other-equipment check", `${CROP_DIR}/${d.id}.jpg`,
    d.verdict === "agree" ? "agree" : "disagree", d.verdict === "agree" ? "" : d.new_label,
    d.verdict === "reject" ? "not an object / fragment" : d.comment || "", V[d.verdict], d.verdict === "agree" ? "" : d.new_label,
    d.reviewer || R.reviewer.trim(), d.time]);
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";   // CRLF like the Python csv writer
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const slug = () => (R.reviewer.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "review");

// ------------------------------------------------------------------ events
function startRename() { R.renaming = true; render(); }
function onClick(e) {
  const t = e.target.closest("[data-rv],[data-rv-tab]"); if (!t || t.disabled) return;
  if (t.dataset.rvTab) { R.tab = t.dataset.rvTab; R.renaming = false; render(); if (R.tab === "item" && R.cur) focus3D(byId(R.cur)); return; }
  const a = t.dataset.rv;
  if (a === "close") return close();
  if (a === "agree") return decide("agree");
  if (a === "reject") return decide("reject");
  if (a === "rename") return startRename();
  if (a === "cancel") { R.renaming = false; return render(); }
  if (a === "skip") return skip();
  if (a === "back") return back();
  if (a === "undo") return undo();
  if (a === "json") { download(`scene_annotations.${slug()}-${today()}.json`, JSON.stringify(exportJSON(), null, 2) + "\n", "application/json"); return APP.toast?.("Review layer downloaded. Merge it into config/scene_annotations.json.", 3500); }
  if (a === "csv") return download(`label_review.${slug()}-${today()}.csv`, exportCSV(), "text/csv");
  if (a === "reset") {
    if (!confirm("Clear every review decision stored in this browser?")) return;
    R.decisions = {}; R.history = []; save(); render();
  }
}
function onSubmit(e) {
  if (!e.target.matches("[data-rv-form]")) return;
  e.preventDefault();
  const label = document.getElementById("rvLabel").value.trim(); if (!label) return;
  decide("rename", { label, category: document.getElementById("rvCat").value, comment: document.getElementById("rvNote").value.trim() });
}
function onChange(e) {
  if (e.target.id === "rvLabel") { const c = catFor(e.target.value.trim()); if (c) document.getElementById("rvCat").value = c; }
  if (e.target.matches("[data-rv-sort]")) { R.sort = e.target.value; save(); render(); }
  if (e.target.matches("[data-rv-scope]")) { R.scope = e.target.value; R.cur = null; save(); R.tab = "item"; render(); if (R.cur) focus3D(byId(R.cur)); }
}
// capture phase on window: runs before the navigation pad's arrow keys and main.js's shortcuts while the review is open
addEventListener("keydown", (e) => {
  if (!R.open || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement, typing = el && /INPUT|TEXTAREA|SELECT/.test(el.tagName);
  if (R.renaming) { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); R.renaming = false; render(); } return; }
  if (typing || R.tab !== "item") { if (e.key === "Escape" && !typing) { e.stopImmediatePropagation(); close(); } return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const act = { y: () => decide("agree"), r: startRename, n: () => decide("reject"), ArrowRight: skip, ArrowLeft: back, u: undo, Escape: close }[k];
  if (!act) return;
  e.preventDefault(); e.stopImmediatePropagation();
  act();
}, true);

// ------------------------------------------------------------------ open / close
export async function openReview(opts = {}) {
  if (!APP.S?.fac) return;
  load();
  if (opts.threshold) R.T = opts.threshold;
  if (opts.flags) R.flags = opts.flags;
  R.open = true; R.tab = "item"; R.renaming = false;
  document.getElementById("sheet")?.classList.add("hidden");
  document.body.classList.add("rv-on");
  render();
  if (R.cur) focus3D(byId(R.cur));
}
export function close() {
  R.open = false; R.renaming = false;
  $p()?.remove();
  document.body.classList.remove("rv-on");
  clear3D();
}

window.__review = { R, open: openReview, close, exportJSON, exportCSV, stats, wilson, queue };   // tests
