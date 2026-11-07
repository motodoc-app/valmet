import { icon } from "./icons.js";
import { api } from "./api.js";
// Small DOM and formatting helpers shared by the 3D app (main.js) and the 2D floor plan (plan2d.js).
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const nice = (s) => { const t = String(s ?? "").replaceAll("_", " ").toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
export const pad = (n) => String(n).padStart(2, "0");
export const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
// [ID] citations in copilot text become clickable chips (the click handler opens the source document).
// [ASSET-017] opens the asset card DOC-ASSET-017 (a real document); the visible ID stays the same.
export const cites = (text) => esc(text).replace(/\*\*([^*]{1,200})\*\*/g, "<b>$1</b>").replace(/\[([^\[\]]{2,80})\]/g, (_, ids) =>
  ids.split(",").map((i) => `<span class="cite" data-doc="${esc(i.trim().replace(/^ASSET-(\d{3})$/, "DOC-ASSET-$1"))}">${esc(i.trim())}</span>`).join(""));
export const signalName = (s) => nice(String(s).replace(/_(mm_s|c|a|pct|bar|rpm)$/, ""));

export function sparkline(series, w = 88, h = 26, hot = false) {
  if (!series?.length) return "";
  const v = series.map((s) => (Array.isArray(s) ? s[1] : s)), lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
  const pts = v.map((y, i) => [(i / Math.max(1, v.length - 1)) * w, h - 3 - ((y - lo) / r) * (h - 6)]);
  const [ex, ey] = pts.at(-1);
  const col = hot ? "var(--bad)" : "var(--text-2)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${col}" stroke-width="1.25" points="${pts.map((p) => p.join(",")).join(" ")}"/><circle cx="${ex}" cy="${ey}" r="2" fill="${col}"/></svg>`;
}

// Copilot answers use labelled lines (Observation / Evidence / Hypothesis / Uncertainty / Next safe step).
export function narrative(text) {
  const parts = String(text).split(/\n+|(?=(?:Observation|Evidence|Hypothesis|Uncertainty|Next safe step):)/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => {
    const m = p.match(/^(Observation|Evidence|Hypothesis|Uncertainty|Next safe step):\s*(.*)$/s);
    return m ? `<div class="nblock"><div class="label">${m[1]}</div><div class="narr">${cites(m[2])}</div></div>` : `<div class="narr">${cites(p)}</div>`;
  }).join("");
}

let toastTimer;
export function toast(msg, ms = 4200) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); $("#app").appendChild(t); }
  t.innerHTML = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

// Phones and low-memory devices get a lighter scan and a lower pixel ratio.
export const LITE = (() => {
  try { return matchMedia("(max-width: 820px)").matches || (navigator.deviceMemory && navigator.deviceMemory <= 4) || false; } catch { return false; }
})();

// ------------------------------------------------------------------ cards shared by the 3D app and the floor plan
export function header(eyebrow, title, tags = "", closable = false) {
  return `<div class="card-h" style="padding-bottom:0"><span class="eyebrow-row">${eyebrow}${tags}</span><span class="card-tools"><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button>${closable ? `<button class="link" data-close-card title="Close" aria-label="Close">${icon("close")}</button>` : ""}</span></div>
  <div class="card-b"><div class="h1">${title}</div>`;
}

/** The arrival diagnosis (narrative, confidence, hypotheses, next steps / telemetry, events, work orders / sources). */
export function diagnosisHTML(d, tab = "overview", { xray = true, actions = "" } = {}) {
  const a = d.asset, c = d.confidence, checks = d.record_checks || [];
  const tabs = ["overview", "evidence", "sources"];
  const nWo = d.work_order_count ?? d.work_orders.length, shownWo = Math.min(4, d.work_orders.length);
  const body = {
    overview: `${narrative(d.narrative.text)}
      <p class="note" style="margin-top:8px">${d.narrative.invalid_citations?.length ? `${d.narrative.invalid_citations.length} unsupported citation(s) removed.` : "Every citation was checked against the evidence."} ${esc(narrativeSource(d.narrative))}.</p>
      ${checks.length ? `<div class="section"><div class="label">Record checks: where the workbook disagrees</div>${checks.map((x) => `<p class="note">${cites(`${x.text} [${x.source}]`)}</p>`).join("")}</div>` : ""}
      <div class="section"><div class="label"><span>Confidence</span><span style="color:var(--text)">${Math.round(c.overall * 100)}%</span></div>
        <div class="meter"><i style="width:${c.overall * 100}%"></i></div>
        ${kv("Model confidence", c.model_confidence)}${kv("Evidence support", c.evidence_support)}${kv("Data-quality penalty", "−" + c.data_quality_penalty)}${kv("3D mapping", c.mapping_confidence)}</div>
      <div class="section"><div class="label">Hypotheses</div>${d.hypotheses.map((h) => `<div class="hyp"><div>${esc(h.hypothesis)}<small>${h.rank === 1 ? "Leading" : "Alternative, not excluded"}</small></div>${xray && h.components.length ? `<button class="link" data-xcomp="${h.components.join(",")}">X-Ray ${icon("chev")}</button>` : ""}</div>`).join("")}</div>
      <div class="section"><div class="label">Next safe steps</div>${d.next_steps.map((s, i) => `<div class="step"><span class="k">${i + 1}</span><span>${esc(s.step)} <span class="cite" data-doc="${esc(s.source)}">${esc(s.source)}</span></span></div>`).join("")}</div>`,
    evidence: `<div class="label note" style="margin-bottom:4px">Last 12 h against own baseline and class peers</div>
      ${d.telemetry.signals.map((s) => { const z = s.z_vs_peers ?? s.z_vs_own_baseline; const hot = s.abnormal || Math.abs(z) >= 2;
        return `<div class="sig"><div><b>${signalName(s.signal)}</b><small>${s.recent_mean} ${s.unit} · peers ${s.peer_mean ?? "–"} · <span class="${hot ? "flag" : ""}">z ${z}</span></small></div>${sparkline(s.series, 88, 26, hot)}</div>`; }).join("")}
      <div class="section"><div class="label">Alarms and events</div>${d.events.slice(0, 5).map((e) => `<div class="ev"><code>${e.event_id}</code><span>${nice(e.event_type)} · ${esc(e.event_code)}</span><small>${e.timestamp} · ${e.severity}</small></div>`).join("") || '<div class="note">None</div>'}</div>
      <div class="section"><div class="label">Work orders${nWo > shownWo ? ` <span class="note">· latest ${shownWo} of ${nWo}</span>` : ""}</div>${d.work_orders.slice(0, 4).map((w) => `<div class="ev"><code>${w.work_order_id}</code><span>${esc(nice(w.action))}</span><small>${(w.opened_at || "").slice(0, 10)} · ${nice(w.result)}</small></div>`).join("") || '<div class="note">None</div>'}</div>
      <div class="section"><div class="label">Data quality</div><div class="row">${d.data_quality.map((q) => `<span class="pill">${q.issue_id} · ${nice(q.issue_type)}</span>`).join("") || '<span class="note">No issues</span>'}</div></div>`,
    sources: `${d.documents.map((x) => `<button class="doc" data-docid="${esc(x.id)}"><span class="k">${nice(x.kind)}</span><code>${esc(x.id)}</code><p>${esc(x.title)}</p></button>`).join("")}
      ${d.similar_cases.slice(0, 3).map((k) => `<button class="doc" data-docid="${k.case_id}"><span class="k">Service case</span><code>${k.case_id}</code><p>${esc(k.historical_interpretation)}</p></button>`).join("")}`,
  };
  return `${header(nice(a.asset_class), `${a.tag} diagnosis`, '<span class="tag syn">Synthetic</span>', true)}
    <div class="sub"><span class="status s-${a.condition_state}">${nice(a.condition_state)}</span> · health ${a.health_score} · ${esc(a.criticality)}</div>
    ${actions ? `<div class="actions-top">${actions}</div>` : ""}
    <div class="plain">${plainSummary(d)}</div>
    <div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" data-tab="${t}" class="${tab === t ? "on" : ""}">${nice(t)}</button>`).join("")}</div>
    ${body[tab]}`;
}

/** How the diagnosis text was produced: live (server), pre-generated at export time (hosted, or server fallback), template. */
export function narrativeSource(n) {
  const m = String(n?.mode || "");
  if (n?.fallback) return `Pre-generated by ${m.slice(4)} at export time (live AI unavailable)`;
  if (m.startsWith("llm")) return api.isStatic ? `Pre-generated by ${m.slice(4)} at export time (offline demo)` : `Written live by ${m.slice(4)}`;
  return "Template wording (no AI)";
}

/** One sentence anyone can read, before the engineering detail. */
export function plainSummary(d) {
  const a = d.asset, lead = d.hypotheses[0]?.hypothesis, step = d.next_steps[0]?.step;
  const pct = Math.round(d.confidence.overall * 100);
  const lc = (s) => esc(s.charAt(0).toLowerCase() + s.slice(1)).replace(/\.$/, "");
  const healthy = a.condition_state === "healthy";
  const state = { healthy: "running normally: the workbook shows no active fault", watch: "running, but shows early signs of a problem (watch)",
    degraded: "running in a degraded condition", attention_required: "not running as it should and needs attention" }[a.condition_state]
    || `in condition “${esc(String(a.condition_state).replaceAll("_", " "))}”`;
  const cause = !lead ? "" : healthy || /^no active fault/i.test(lead) ? "" : ` The most likely cause is ${lc(lead)}.`;
  const next = healthy ? ` Recommended: ${lc(String(a.recommended_next_check || "monitor"))}.` : step ? ` First, ${lc(step)}.` : "";
  const disagree = d.record_checks?.length ? ` Some workbook records disagree; the diagnosis lists them.` : "";
  return `<b>In plain words:</b> ${esc(a.tag)} is ${state}.${cause}${next}${disagree} The copilot is ${pct}% confident in this reading, and every claim links to its source.`;
}
