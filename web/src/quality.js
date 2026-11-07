// Scene-understanding quality panel: an honest breakdown of what the segmented candidates actually are.
// Data: web/public/static/quality.json, produced by scripts/scene_quality.py from the same scene.json the app shows.
import { addRailButton } from "./ext.js";
import "./quality.css";

let Q = null;            // quality.json (loaded on first open)
let active = null;       // tier id currently highlighted in 3D, or null
let app = null;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pc = (x, d = 0) => `${(100 * x).toFixed(d)}%`;
const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;

async function load() {
  if (Q) return Q;
  const r = await fetch("./static/quality.json");
  if (!r.ok) throw new Error(`quality.json ${r.status}`);
  return (Q = await r.json());
}

function highlight(tier) {
  const S = app?.S;
  if (!S?.fac) return;
  active = tier;
  const ids = tier ? Q.tier_ids[tier] || [] : [];
  S.fac.setHighlighted(ids, { selected: S.selected?.id ?? null, target: S.target?.id ?? null });
  // keep the view readable: with hundreds of frames lit, only asset / selected / target names stay as labels
  if (tier) {
    for (const [id, f] of S.fac.frames) {
      if (f.label && !f.obj.asset && id !== S.selected?.id && id !== S.target?.id) f.label.visible = false;
    }
  }
  app.renderRail?.();
}

function funnel() {
  const n0 = Q.tiers[0].n;
  return Q.tiers.map((t) => `
    <button class="q-tier${active === t.id ? " on" : ""}" data-q-tier="${t.id}" title="${esc(t.rule)}">
      <span class="q-tier-top"><span class="q-tier-n">${t.n}</span><span class="q-tier-name">${esc(t.name)}</span>
        <span class="q-tier-pc">${pc(t.n / n0, t.n / n0 < 0.1 ? 1 : 0)}</span>
        <span class="pill${active === t.id ? " on" : ""}">${active === t.id ? "shown in 3D" : "show"}</span></span>
      <span class="q-bar"><i style="width:${Math.max(0.6, (100 * t.n) / n0)}%"></i></span>
      <span class="q-rule">${esc(t.rule)}</span>
    </button>`).join("");
}

function histogram() {
  const max = Math.max(...Q.histogram.map((h) => h.specific + h.other));
  const T = Q.threshold;
  return `<div class="q-hist" role="img" aria-label="Confidence histogram">
    ${Q.histogram.map((h) => `<div class="q-col${h.lo >= T - 1e-9 ? " hi" : ""}" title="${h.lo.toFixed(1)}–${h.hi.toFixed(1)}: ${h.specific} specific, ${h.other} other equipment">
      <div class="q-stack" style="height:${(100 * (h.specific + h.other)) / max}%">
        <i class="o" style="flex:${h.other}"></i><i class="s" style="flex:${h.specific}"></i></div>
      <span>${h.lo.toFixed(1)}</span></div>`).join("")}
  </div>
  <div class="q-legend"><span><i class="s"></i>specific type</span><span><i class="o"></i>“other equipment”</span>
    <span class="q-thr">confident ≥ ${T.toFixed(2)}</span></div>`;
}

function familyTable() {
  return `<table class="q-table"><thead><tr><th>Type family</th><th>Count</th><th>≥ ${Q.threshold.toFixed(2)}</th><th>Mean conf.</th></tr></thead><tbody>
    ${Q.by_family.map((r) => `<tr><td>${esc(r.family)}</td><td>${r.count}</td><td>${r.confident}</td><td>${r.mean_confidence.toFixed(2)}</td></tr>`).join("")}
  </tbody></table>`;
}

function labelTable() {
  return `<table class="q-table"><thead><tr><th>Label</th><th>Count</th><th>≥ ${Q.threshold.toFixed(2)}</th><th>Mean</th><th>Linked</th><th>Source</th></tr></thead><tbody>
    ${Q.by_label.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.count}</td><td>${r.confident}</td><td>${r.mean_confidence.toFixed(2)}</td><td>${r.linked || ""}</td>
      <td class="q-src">${Object.entries(r.sources).map(([k, v]) => `${esc(k)}${Object.keys(r.sources).length > 1 ? ` ${v}` : ""}`).join(", ")}</td></tr>`).join("")}
  </tbody></table>`;
}

function dataQuality() {
  const d = Q.data_quality, c = d.counts;
  const names = { fragment: "Fragments (same label, touching)", possible_overmerge: "Possibly over-merged (very large)", tiny: "Tiny (< 15 cm)",
    flat: "Flat (< 4 cm thick)", low_points: "Low support (< 50 splats)", label_size_mismatch: "Label vs. size mismatch", nested: "Nested inside a larger frame" };
  return `${Object.keys(names).map((k) => `<div class="kv" title="${esc(d.rules[k])}"><span>${names[k]}</span><span>${c[k]}</span></div>`).join("")}
    <p class="note" style="margin-top:8px">${d.any_flag} of ${Q.tiers[0].n} candidates trip at least one rule (rules overlap). ${d.fragment_groups} fragment groups hold
    ${d.objects_in_fragment_groups} candidates; merging them would remove ${d.excess_if_merged}. Of ${d.pipe_tags.n} “pipe label / tag” candidates,
    ${d.pipe_tags.longer_than_mismatch} are at least 0.6 m long, which is longer than a tag. Hover a row for the exact rule.</p>`;
}

function audit() {
  const a = Q.audit;
  if (!a.complete) return `<p class="note">Audit pending: ${a.pending} of ${a.n} sampled objects not yet reviewed.</p>`;
  const w = (x) => `${pc(x[0])}–${pc(x[1])}`;
  const hi = a.by_confidence[a.by_confidence.length - 1];
  return `<p class="note q-warn">A second AI model looked at the same crop renders. This is a cross-check, <b>not human ground truth</b>.</p>
    ${kv("Sample", `${a.n} stratified by label (seed fixed)`)}
    ${kv("Agree · disagree · can’t tell", `${a.agree} · ${a.disagree} · ${a.cant_tell}`)}
    ${kv("Agreement, all sampled", `${pc(a.agree_rate_all)} <span class="q-ci">(95% CI ${w(a.wilson95_all)})</span>`)}
    ${kv("Agreement, decidable only", `${pc(a.agree_rate_decided)} <span class="q-ci">(${w(a.wilson95_decided)})</span>`)}
    ${kv(`Confidence ≥ ${Q.threshold.toFixed(2)} only`, `${hi.agree}/${hi.n} <span class="q-ci">(${w(hi.wilson_all)})</span>`)}
    <p class="note" style="margin-top:8px">Pipes are usually right; small devices and pumps often are not, or cannot be judged from the render.
    The same sample is in <code>docs/label_review_sample.csv</code> with an empty column for a human check.</p>`;
}

function body() {
  const lk = Q.linking, hr = Q.human_review, st = Q.structure;
  return `
    <div class="h1" style="font-size:17px">What the scan understanding really contains</div>
    <p class="p" style="margin-top:6px">${esc(Q.caveat)}</p>
    <div class="section"><div class="label"><span>From candidates to linked assets</span><span>click a tier to light it up in 3D</span></div>
      <div class="q-funnel">${funnel()}</div>
      ${active ? `<button class="btn block" data-q-clear style="margin-top:8px">Clear 3D highlight</button>` : ""}</div>
    <div class="section"><div class="label"><span>Vision-model confidence</span><span>self-reported, not calibrated</span></div>${histogram()}
      <p class="note" style="margin-top:6px">${esc(Q.threshold_why)}</p></div>
    <div class="section"><div class="label">By type</div>${familyTable()}
      <details class="q-more"><summary>All ${Q.by_label.length} labels</summary>${labelTable()}</details></div>
    <div class="section"><div class="label"><span>Data-quality flags</span><span>review hints, not verdicts</span></div>${dataQuality()}</div>
    <div class="section"><div class="label">Label audit (AI second opinion)</div>${audit()}</div>
    <div class="section"><div class="label">Review and linking</div>
      ${kv("Human-verified (review layer)", `${hr.n} <span class="q-ci">(${hr.specific_after_review} with a specific type)</span>`)}
      ${kv("Linked to workbook assets", `${lk.n} of ${lk.workbook_assets}`)}
      ${kv("Mapping confidence ≥ " + Q.threshold.toFixed(2), `${lk.mapping_confidence_ge_T} of ${lk.n}`)}
      ${kv("Structure (not counted)", `${Object.entries(st.planes).map(([k, v]) => `${v} ${k}`).join(", ")}`)}
      <p class="note" style="margin-top:8px">${esc(lk.note)}</p></div>
    <p class="note" style="margin-top:14px">Generated by <code>scripts/scene_quality.py</code>; full definitions in <code>docs/SCENE_QUALITY.md</code>.</p>`;
}

function render() {
  const sc = document.querySelector("#sheet .card-b")?.scrollTop ?? 0;
  const again = !!document.querySelector("#sheet:not(.hidden) .q-body");
  app.sheet("Scene understanding", `<div class="q-body">${body()}</div>`);
  if (again) { const b = document.querySelector("#sheet .card-b"); if (b) b.scrollTop = sc; }   // keep place when toggling
}

addRailButton({
  id: "quality", icon: "check", title: "Scene understanding: what was recognised", sceneOnly: true,
  isOn: () => !!active,
  async onClick(A) {
    app = A;
    try { await load(); } catch (e) { A.toast?.("Scene quality report not available.", 3000); console.warn(e); return; }
    render();
  },
});

// one delegated listener for the shared sheet (its close button is handled by main.js)
document.addEventListener("click", (e) => {
  if (!Q || !e.target.closest?.("#sheet .q-body")) return;
  const t = e.target.closest("[data-q-tier]");
  if (t) {
    const id = active === t.dataset.qTier ? null : t.dataset.qTier;
    highlight(id);
    if (!id) { render(); return; }
    // get the sheet out of the way so the lit frames are visible; the rail button stays "on" while a tier is shown
    document.getElementById("sheet")?.classList.add("hidden");
    const tier = Q.tiers.find((x) => x.id === id);
    app.toast?.(`<b>${tier.n}</b> ${esc(tier.name.toLowerCase())} shown as bright 3D frames. Open the ✓ panel again to change or clear.`, 5000);
    return;
  }
  if (e.target.closest("[data-q-clear]")) { highlight(null); render(); }
});
