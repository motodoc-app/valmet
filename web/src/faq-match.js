// Hosted-demo copilot: match a typed question to the pre-generated FAQ (scripts/export_faq.py), or compose a short
// cited answer from retrieved documents. Pure functions (no DOM, no fetch) so they run in Node tests too.
//
// Matching rules (honest by construction):
//   * a tag named in the question (P-005) must be the entry's tag; an asset question never borrows another asset;
//   * an asset question (named tag, or the selected / previous asset) with a recognised intent ("what should I check
//     first", "is it safe to keep running", ...) maps to that asset's entry for the intent;
//   * otherwise token similarity (stop words removed, synonyms folded, light stemming, IDF-weighted cosine) against
//     every entry's question and paraphrases, above a threshold. Below it, nothing is matched.

// Per-asset intents, in priority order (first match wins). Keys match ASSET_QS in scripts/export_faq.py.
export const INTENTS = [
  ["safe", /\bsafe\b|keep (it |them )?(running|operating|going|on)|shut (it )?down|switch (it )?off|turn (it )?off|stop (it|the)|continue (to )?(run|operat)|danger|\brisky?\b|run to failure/],
  ["check", /check first|first (thing|step|check)|what (should|do|must|can) i (check|do|look|inspect|verify|test)|where (do|should) i (start|begin)|next (safe )?step|what to (check|do|look)|look at first|start with|on arrival|when i (get|arrive)|todo|to-do/],
  ["evidence", /evidence|supports?\b|supporting|proof|how do (you|we) know|why do (you|we) think|based on what|what (data|signals?) (shows?|says?)|justify/],
  ["history", /history|past (work|maintenance|service|repairs?)|work orders?|previous(ly)? (service|maintenance|repairs?|work)|last (service|serviced|maintenance|repair)|maintenance (record|log)|been (serviced|repaired)|when was .* serviced/],
  ["confidence", /confiden|how sure|certain(ty)?|reliable|trust (the|this|that|it)|accurate is (the|this) diagnos/],
  ["dq", /data.?quality|missing data|stale|bad data|data (issue|problem|gap)|timestamp|jitter|duplicate/],
  ["flagged", /\bflag|why (is|was|does) .*\b(attention|alarm|degraded|watch|red|priority|marked|highlighted|target|selected|listed)|why .*(attention|degraded)/],
  ["telemetry", /telemetry|signals?\b|readings?|trends?\b|sensor data|measurements?|vibration|temperature|\bcurrent\b|pressure|\bflow\b|\bz.?score/],
  ["wrong", /wrong|problem|\bissues?\b|fault|status|condition|health|matter|diagnos|broken|what'?s up|state of|how is .* doing|ok\b|okay|fine\b/],
];
export function detectIntent(q) {
  const t = String(q).toLowerCase();
  return INTENTS.find(([, re]) => re.test(t))?.[0] || null;
}

const STOPW = new Set(("a an the is are was were be been am do does did doing of in on at to for from by with about into over and or but if then so " +
  "this that these those it its it's i me my we our you your they them their he she what's whats which who whom when where why how what " +
  "can could should would will shall may might must please tell show give explain let us know any some there here just also really " +
  "very much many more most get got have has had not no yes than too up out as").split(" "));
const SYN = {
  broken: "fault", faulty: "fault", faults: "fault", problem: "fault", problems: "fault", issue: "fault", issues: "fault", wrong: "fault", failing: "fault", failure: "fault", bad: "fault", worst: "fault",
  overheating: "hot", overheat: "hot", overheated: "hot", temperature: "hot", hottest: "hot", heat: "hot",
  route: "route", routes: "route", path: "route", paths: "route", navigate: "route", navigation: "route", routing: "route", drive: "route", plan: "plan", planning: "plan", planned: "route",
  label: "label", labels: "label", labelled: "label", labeled: "label", labelling: "label", labeling: "label", recognised: "label", recognized: "label", recognition: "label", detected: "label", detection: "label", identified: "label", classified: "label", named: "label", segmentation: "label", segmented: "label",
  objects: "object", things: "object", items: "object",
  synthetic: "synthetic", fake: "synthetic", simulated: "synthetic", real: "synthetic", genuine: "synthetic", made: "synthetic",
  urgent: "priority", urgency: "priority", attention: "priority", prioritise: "priority", prioritize: "priority", priorities: "priority", first: "priority",
  equipment: "asset", assets: "asset", machines: "asset", machine: "asset", devices: "asset", device: "asset", equipments: "asset",
  pumps: "pump", motors: "motor", valves: "valve", sensors: "sensor", transmitters: "transmitter",
  measure: "measure", measured: "measure", metrics: "measure", metric: "measure", kpi: "measure", kpis: "measure", validate: "measure", evaluate: "measure",
  connect: "connect", connection: "connect", integration: "connect", integrate: "connect", connected: "connect", plug: "connect",
  ai: "copilot", assistant: "copilot", chatbot: "copilot", llm: "copilot",
  hallucinate: "ground", hallucination: "ground", invent: "ground", grounded: "ground", citations: "ground", cite: "ground", trust: "ground",
  remote: "support", expert: "support", helpdesk: "support",
  manuals: "document", manual: "document", docs: "document", documents: "document", documentation: "document", library: "document",
  safety: "safe", safely: "safe", loto: "lockout", lockout: "lockout", tagout: "lockout",
  scan: "scan", scanned: "scan", splat: "scan", splats: "scan", gaussian: "scan", pointcloud: "scan",
  serviced: "service", servicing: "service", maintenance: "service", maintained: "service", overdue: "service",
};
const stem = (w) => (w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export function toks(s) {
  const out = [];
  for (const raw of String(s).toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9][a-z0-9'-]*/g) || []) {
    const w = raw.replace(/'s$/, "");
    if (STOPW.has(w) || w.length < 2) continue;
    out.push(SYN[w] || stem(w));
  }
  return out;
}
export const TAG_RE = /\b([a-z]{1,3}-\d{3})\b/i;

/** Index the FAQ once: token sets per entry (question + paraphrases) and IDF weights. */
export function indexFaq(faq) {
  const entries = (faq?.faq || []).map((f) => ({ ...f, variants: [f.q, ...(f.alts || [])].map((v) => new Set(toks(v.replace(TAG_RE, "")))) }));
  const df = new Map();
  for (const e of entries) for (const w of new Set(e.variants.flatMap((v) => [...v]))) df.set(w, (df.get(w) || 0) + 1);
  const N = entries.length || 1, idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
  return { entries, idf, byKey: new Map(entries.filter((e) => e.tag).map((e) => [`${e.tag}|${e.intent}`, e])) };
}

function cosine(a, b, idf) {
  let dot = 0, na = 0, nb = 0;
  for (const w of a) { const x = idf(w) ** 2; na += x; if (b.has(w)) dot += x; }
  for (const w of b) nb += idf(w) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Find the FAQ entry for a question.
 * @param idx    indexFaq() result
 * @param q      the typed question
 * @param ctx    { tag: tag named in the question or null, contextTag: selected / previous asset tag or null }
 * @returns { entry, score, how } or null. how: "intent" (asset + intent) or "similar" (token similarity)
 */
export function matchFaq(idx, q, { tag = null, contextTag = null } = {}, threshold = 0.5) {
  if (!idx?.entries?.length) return null;
  const intent = detectIntent(q);
  const assetTag = tag || contextTag;
  // 1. an asset question with a recognised intent → that asset's entry ("is it safe to keep running?" with P-005 selected)
  //    A question without a tag only borrows the selection when it refers to it ("it", "this") or is clearly about one asset.
  const refersToAsset = tag || /\b(it|its|this|that|the (pump|motor|valve|sensor|transmitter|asset|equipment|machine|device)|first|safe|running)\b/i.test(q);
  if (assetTag && intent && refersToAsset) {
    const e = idx.byKey.get(`${assetTag.toUpperCase()}|${intent}`);
    if (e) return { entry: e, score: 1, how: "intent" };
  }
  // 2. token similarity. Entries about a specific asset only qualify for that asset; general entries always qualify,
  //    but a general entry that names a tag (e.g. "Why is P-005 the target…") needs that tag in the question.
  const qt = new Set(toks(q.replace(TAG_RE, "")));
  if (!qt.size) return null;
  let best = null;
  for (const e of idx.entries) {
    if (e.tag && e.tag !== (assetTag || "").toUpperCase()) continue;
    const eTag = !e.tag && e.q.match(TAG_RE)?.[1]?.toUpperCase();
    if (eTag && eTag !== (tag || "").toUpperCase()) continue;
    let s = Math.max(...e.variants.map((v) => cosine(qt, v, idx.idf)));
    if (e.tag && intent && e.intent === intent) s += 0.15;
    if (e.tag && intent && e.intent !== intent) s -= 0.15;
    if (!best || s > best.score) best = { entry: e, score: s, how: "similar" };
  }
  return best && best.score >= threshold ? best : null;
}

/** Readable answer from retrieved documents: one or two sentences per source, each with its [ID] (no raw dumps). */
export function compose(hits, n = 3) {
  const out = [];
  for (const h of hits.slice(0, n)) {
    const sents = String(h.text).trim().split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
    let body = sents.slice(0, 2).join(" ").trim().replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (w) => w.toLowerCase().replaceAll("_", " ")).replace(/ 00:00/g, "");
    if (body.length > 320) body = body.slice(0, 300).replace(/\s+\S*$/, "") + "…";
    out.push(`${h.title}: ${body} [${h.id}]`);
  }
  return out.join("\n");
}
