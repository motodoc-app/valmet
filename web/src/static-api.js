// Serverless backend for the hosted demo. Mirrors backend/xray/api.py using data exported by
// scripts/export_static.py. Routes are planned live with a JS port of backend/xray/navigation.py.
import { indexFaq, matchFaq, compose, detectIntent, TAG_RE } from "./faq-match.js";
const base = "./static/";
const get = async (p) => (await fetch(base + p)).json();
let cache = {};
const once = (k, f) => (cache[k] ??= f());

// ------------------------------------------------------------------ navigation (port of navigation.py)
function bits(b64, n) {
  const s = atob(b64), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (s.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  return out;
}
// exact Euclidean distance transform (Felzenszwalb & Huttenlocher), returns metres
export function edt(occ, W, H, res) {
  const INF = 1e12, f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
  const g = new Float64Array(W * H);
  const pass = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) { s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); if (s <= z[k]) k--; else break; }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let c = 0; c < W; c++) { for (let r = 0; r < H; r++) f[r] = occ[r * W + c] ? 0 : INF; pass(H); for (let r = 0; r < H; r++) g[r * W + c] = d[r]; }
  const out = new Float64Array(W * H);   // float64 like scipy: a clearance of exactly the robot radius is not walkable
  for (let r = 0; r < H; r++) { for (let c = 0; c < W; c++) f[c] = g[r * W + c]; pass(W); for (let c = 0; c < W; c++) out[r * W + c] = Math.sqrt(d[c]) * res; }
  return out;
}

class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

class Nav {
  constructor(g) {
    Object.assign(this, g);
    const n = g.W * g.H;
    this.floor = bits(g.floor, n);
    this.occ = bits(g.occupied, n);
    const hb = Uint8Array.from(atob(g.height_mm), (c) => c.charCodeAt(0));
    this.height = new Int16Array(hb.buffer);
    this.blocked = new Uint8Array(n);
    this.cleared = new Uint8Array(n);     // planning: footprints of equipment moved away (free floor again)
    this.rebuild();
  }
  idx(r, c) { return r * this.W + c; }
  /** Obstacles the planner uses: scan + frames, minus cleared footprints, plus user blockages (navigation.py NavMap.occupied). */
  obstacle(i) { return (this.occ[i] & (1 - this.cleared[i])) | this.blocked[i]; }
  toCell(x, z) { return [Math.floor((z - this.z0) / this.res), Math.floor((x - this.x0) / this.res)]; }
  toWorld(r, c) { return [this.x0 + (c + 0.5) * this.res, this.z0 + (r + 0.5) * this.res]; }
  rebuild() {
    const n = this.W * this.H, occ = new Uint8Array(n);
    for (let i = 0; i < n; i++) occ[i] = this.obstacle(i);
    this.clear = edt(occ, this.W, this.H, this.res);
    this.walk = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.walk[i] = this.floor[i] && this.clear[i] > this.robot_radius ? 1 : 0;
  }
  rasterise(b, out) {
    const cs = Math.cos(b.yaw || 0), sn = Math.sin(b.yaw || 0), hx = (b.w ?? 0.6) / 2, hz = (b.d ?? 0.6) / 2;
    const rad = Math.hypot(hx, hz);
    const [r0, c0] = this.toCell(b.x - rad, b.z - rad), [r1, c1] = this.toCell(b.x + rad, b.z + rad);
    for (let r = Math.max(0, r0); r <= Math.min(this.H - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(this.W - 1, c1); c++) {
      const [wx, wz] = this.toWorld(r, c), dx = wx - b.x, dz = wz - b.z;
      if (Math.abs(dx * cs + dz * sn) <= hx && Math.abs(-dx * sn + dz * cs) <= hz) out[this.idx(r, c)] = 1;
    }
  }
  /** blocks become obstacles; clears (footprints of equipment moved in a layout plan) become free where floor exists. */
  setBlocks(blocks, clears = []) {
    this.blocked.fill(0); this.cleared.fill(0);
    for (const b of blocks) this.rasterise(b, this.blocked);
    for (const c of clears) this.rasterise(c, this.cleared);
    for (let i = 0; i < this.cleared.length; i++) this.cleared[i] &= this.floor[i];
    this.rebuild();
  }
  /** Walkable cell from which the object can be inspected, closest to its frame (navigation.py approach_cell). */
  approachCell(o) {
    const n = this.W * this.H, mask = new Uint8Array(n);
    this.rasterise({ x: o.center[0], z: o.center[2], w: o.size[0], d: o.size[2], yaw: o.yaw }, mask);
    if (!mask.some((v) => v)) { const [r, c] = this.toCell(o.center[0], o.center[2]); mask[this.idx(Math.min(Math.max(r, 0), this.H - 1), Math.min(Math.max(c, 0), this.W - 1))] = 1; }
    const dist = edt(mask, this.W, this.H, this.res);
    let best = -1, bs = Infinity;
    for (let i = 0; i < n; i++) {
      if (!this.walk[i] || !(dist[i] < 1.6)) continue;
      const s = dist[i] - 0.15 * Math.min(this.clear[i], 0.6);
      if (s < bs) { bs = s; best = i; }
    }
    return best < 0 ? null : [(best / this.W) | 0, best % this.W];
  }
  nearestWalkable(x, z) {
    const [r, c] = this.toCell(x, z); let best = null, bd = Infinity;
    for (let i = 0; i < this.walk.length; i++) if (this.walk[i]) { const rr = (i / this.W) | 0, cc = i % this.W, d = (rr - r) ** 2 + (cc - c) ** 2; if (d < bd) { bd = d; best = [rr, cc]; } }
    return best;
  }
  astar(s, g) {
    const W = this.W, H = this.H, walk = this.walk, hgt = this.height, maxStep = this.max_step * 1000;
    const gs = new Float64Array(W * H).fill(Infinity), came = new Int32Array(W * H).fill(-1), closed = new Uint8Array(W * H);
    const si = this.idx(...s), gi = this.idx(...g);
    const h = (i) => Math.hypot(((i / W) | 0) - g[0], (i % W) - g[1]);
    const nb = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, 1.4142], [-1, 1, 1.4142], [1, -1, 1.4142], [1, 1, 1.4142]];
    gs[si] = 0; const q = new Heap(); q.push([h(si), si]);
    while (q.size) {
      const [, cur] = q.pop();
      if (cur === gi) { const path = [cur]; let k = cur; while (came[k] >= 0) { k = came[k]; path.push(k); } return path.reverse().map((i) => [(i / W) | 0, i % W]); }
      if (closed[cur]) continue; closed[cur] = 1;
      const r = (cur / W) | 0, c = cur % W;
      for (const [dr, dc, w] of nb) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        const ni = nr * W + nc;
        if (!walk[ni]) continue;
        if (dr && dc && !(walk[(r + dr) * W + c] && walk[r * W + c + dc])) continue;
        if (Math.abs(hgt[ni] - hgt[cur]) > maxStep) continue;
        const pen = 1 + 1.5 / Math.max(this.clear[ni] / this.robot_radius, 1);
        const ng = gs[cur] + w * pen;
        if (ng < gs[ni]) { gs[ni] = ng; came[ni] = cur; q.push([ng + h(ni), ni]); }
      }
    }
    return null;
  }
  lineClear(a, b) {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2 + 1;
    for (let k = 0; k < n; k++) { const t = n === 1 ? 0 : k / (n - 1); if (!this.walk[this.idx(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t))]) return false; }
    return true;
  }
  smooth(p) {
    if (p.length < 3) return p;
    const out = [p[0]]; let i = 0;
    while (i < p.length - 1) { let j = p.length - 1; while (j > i + 1 && !this.lineClear(p[i], p[j])) j--; out.push(p[j]); i = j; }
    return out;
  }
  validate(cells) {
    let samples = 0, minc = 1e9, hits = 0;
    for (let k = 0; k < cells.length - 1; k++) {
      const a = cells[k], b = cells[k + 1], n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2 + 1;
      for (let s = 0; s < n; s++) {
        const t = n === 1 ? 0 : s / (n - 1), i = this.idx(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t));
        samples++; minc = Math.min(minc, this.clear[i]); if (this.obstacle(i) || !this.floor[i]) hits++;
      }
    }
    return { samples, min_clearance_m: +minc.toFixed(3), collisions: hits, robot_radius_m: this.robot_radius, collision_free: hits === 0 && minc >= this.robot_radius - 1e-6 };
  }
}

// ------------------------------------------------------------------ retrieval (BM25, port of copilot.Corpus)
const tok = (s) => (String(s).toLowerCase().match(/[a-z0-9_]+/g) || []).filter((w) => w.length > 2);
function bm25(docs) {
  const tf = docs.map((d) => { const m = new Map(); for (const w of tok(`${d.title} ${d.text} ${d.scope ?? ""}`)) m.set(w, (m.get(w) || 0) + 1); return m; });
  const dl = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0)), avg = dl.reduce((a, b) => a + b, 0) / dl.length;
  const df = new Map(); tf.forEach((m) => m.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
  const idf = (w) => Math.log(1 + (docs.length - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
  return (q, k = 6, scope) => tok(q).length === 0 ? [] : docs.map((d, i) => {
    let s = 0; for (const w of tok(q)) { const f = tf[i].get(w); if (f) s += idf(w) * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * dl[i] / avg)); }
    if (scope && (d.scope === scope || d.scope === "ALL")) s *= 1.3;
    return { ...d, score: +s.toFixed(3) };
  }).filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

// ------------------------------------------------------------------ public API (same shape as api.js)
const ctx = () => once("ctx", async () => {
  const [scene, grid, goals, assets, corpus, answers, manifest] = await Promise.all(
    ["scene.json", "grid.json", "goals.json", "assets.json", "corpus.json", "answers.json", "manifest.json"].map(get));
  return { scene, nav: new Nav(grid), goals, assets, corpus, search: bm25(corpus), answers, manifest };
});

// pre-generated copilot answers (scripts/export_faq.py); optional: without it free questions use document search
const faqIdx = () => once("faq", async () => {
  try { const r = await fetch(base + "faq.json"); if (!r.ok) return null; return indexFaq(await r.json()); } catch { return null; }
});
const QUESTION = /^(what|what's|why|how|is|are|should|can|could|does|do|did|has|have|which|when|who|tell|list|give|any)\b|\?\s*$/;
const FEATURE_WORDS = /robot|route|path|\bplan\b|support|\bapp\b|copilot|label|scan|\bdata\b|pilot|\bmode\b|\bai\b/;   // questions about the prototype, not the selected asset
const COMMAND_WORDS = /send|go to|navigate|dispatch|\broute\b|drive|walk|\bwhere\b|locate|\bfind\b|show me|x-?ray|explode|inside|internal|practi[cs]e|exercise|rehears|learn|tutorial|teach|manual|document|\bdocs?\b|knowledge|procedure|explain|what does|what is this|how does/;
const SIGNAL_WORDS = { vibration: "vibration_mm_s", temperature: "bearing_temp_c", temp: "bearing_temp_c", current: "motor_current_a", pressure: "process_pressure_bar", flow: "process_flow_pct", stiction: "stiction_index", position: "position_actual_pct", overheat: "bearing_temp_c" };
const ANOMALY = /abnormal|high|unusual|anomal|elevated|highest|find|overheat|hot\b|worst|most/, XRAY_WORDS = /x-?ray|explode|inside|internal|component|parts/;
const COND_RANK = { attention_required: 0, degraded: 1, watch: 2, healthy: 3 };
const byCondition = (a, b) => (COND_RANK[a.condition_state] ?? 9) - (COND_RANK[b.condition_state] ?? 9) || b.priority - a.priority;
const STATUS_WORDS = /wrong|why|flag|status|health|condition|issue|diagnos|problem|fault/;
const STOP = new Set(["the", "where", "is", "are", "find", "show", "me", "a", "an", "all", "of", "in", "this", "room", "please", "locate", "which"]);
function findObjects(c, phrase) {
  const words = (phrase.toLowerCase().match(/[a-z0-9-]+/g) || []).filter((w) => !STOP.has(w));
  if (!words.length) return [];
  const A = Object.fromEntries(c.assets.map((a) => [a.object_id, a]));
  const out = [];
  for (const o of c.scene.objects) {
    if (o.kind !== "object") continue;
    const a = A[o.id];
    const hay = `${o.label} ${o.category || ""} ${a ? `${a.tag} ${a.asset_class.replaceAll("_", " ")}` : ""}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w) || (w.endsWith("s") && hay.includes(w.slice(0, -1)))).length;
    if (score) out.push([score + o.confidence + (a ? 0.5 : 0), o]);
  }
  out.sort((x, y) => y[0] - x[0]);
  return out.filter(([sc]) => sc >= (out[0]?.[0] ?? 0) - 0.6).map(([, o]) => o);
}
const CLASS_WORDS = { pump: "PROCESS_PUMP", motor: "ELECTRIC_MOTOR", valve: "CONTROL_VALVE", transmitter: "PRESSURE_TRANSMITTER", sensor: "VIBRATION_SENSOR" };

export const staticApi = {
  isStatic: true,
  health: async () => { const c = await ctx(); return { ok: true, llm_model: c.manifest.llm, static: true }; },
  scene: async () => (await ctx()).scene,
  grid: async () => { const c = await ctx(); const n = c.nav; return { ...n, walkableMask: n.walk, occupiedMask: Uint8Array.from(n.occ, (v, i) => n.obstacle(i)) }; },
  async plan({ object_id, start, blocks = [], clears = [] }) {
    const c = await ctx(), nav = c.nav, t0 = performance.now();
    nav.setBlocks(blocks, clears);
    const s = nav.nearestWalkable(start[0], start[1]);
    let g = c.goals[object_id];
    // a layout plan changes the floor around equipment: recompute the inspection spot like the server does
    if (clears.length) { const o = c.scene.objects.find((x) => x.id === object_id); if (o) g = nav.approachCell(o) || g; }
    if (g && !nav.walk[nav.idx(...g)]) { const [x, z] = nav.toWorld(...g); g = nav.nearestWalkable(x, z); }
    if (!s || !g) return { ok: false, reason: "start or goal not reachable on the walkable floor" };
    const raw = nav.astar(s, g);
    if (!raw) return { ok: false, reason: "no collision-free route (walkway blocked)" };
    const sm = nav.smooth(raw), pts = sm.map(([r, cc]) => nav.toWorld(r, cc));
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { ok: true, waypoints: pts.map(([x, z]) => [+x.toFixed(3), 0, +z.toFixed(3)]), raw_cells: raw.length, length_m: +len.toFixed(2),
      validation: nav.validate(sm), compute_ms: +(performance.now() - t0).toFixed(1), blocks, ...(clears.length ? { clears } : {}), object_id };
  },
  diagnose: (id) => once("d" + id, () => get(`diag/${id}.json`)),
  async query(question, asset_id, component) {
    const c = await ctx();
    const cls0 = c.assets.find((a) => a.asset_id === asset_id)?.asset_class;
    const pre = component && (c.answers[`${component}|${asset_id}`] || c.answers[`${cls0}#${component}`]);
    if (pre && /what does|evidence/i.test(question)) return pre;
    const scope = c.assets.find((a) => a.asset_id === asset_id)?.asset_class;
    const hits = c.search(question + (component ? " " + component : ""), 6, scope);
    if (component) { const kb = c.corpus.find((d) => d.id === `KB-XRAY-${scope}#${component}`); if (kb && !hits.some((h) => h.id === kb.id)) hits.unshift(kb); }
    return { text: compose(hits) || "No supporting document found in the builder pack.", sources: hits, mode: "docsearch" };
  },
  /** Free question in the hosted demo: the closest pre-generated answer (same asset, same intent or a similar
   *  question), otherwise a short answer composed from document search. Never a live LLM. */
  async answer(question, asset_id, history = []) {
    const c = await ctx(), idx = await faqIdx();
    const tagM = question.match(TAG_RE), named = tagM && c.assets.find((a) => a.tag.toLowerCase() === tagM[1].toLowerCase());
    const ctxAsset = named || c.assets.find((a) => a.asset_id === asset_id) || null;
    const m = matchFaq(idx, question, { tag: named?.tag || null, contextTag: ctxAsset?.tag || null });
    if (m) return { text: m.entry.text, sources: m.entry.sources, mode: "faq", matched_q: m.entry.q, faq_id: m.entry.id,
      score: +m.score.toFixed(2), asset_id: m.entry.asset_id || ctxAsset?.asset_id || null };
    const prev = history?.length && question.split(/\s+/).length <= 7 ? ` ${history.at(-1).q}` : "";
    const hits = c.search(question + prev, 5, ctxAsset?.asset_class);
    // weak matches (one rare word of four) are not answers: require most of the question's words in the top source
    const QSTOP = new Set(["what", "how", "does", "the", "this", "that", "with", "for", "are", "can", "should", "which", "when", "where", "why", "who", "about", "there", "any", "you", "tell"]);
    const qw = tok(question).filter((w) => !QSTOP.has(w)), top = hits[0] ? tok(`${hits[0].title} ${hits[0].text}`) : [];
    const covered = qw.filter((w) => top.some((x) => x === w || x.startsWith(w.slice(0, 5)))).length;
    if (hits.length && qw.length && covered < 2 && covered / qw.length < 0.5) hits.length = 0;
    if (!hits.length) return { text: `Nothing in the builder pack or the product documentation matches “${question}”. Try naming an asset (“What should I check first on P-005?”), a symptom (“Which motor is overheating?”) or a feature (“How does the robot plan routes?”).`, sources: [], mode: "docsearch", asset_id: ctxAsset?.asset_id ?? null };
    let lead = "";
    if (ctxAsset && (named || detectIntent(question) || /\b(it|this|that)\b/i.test(question))) {
      const d = await staticApi.diagnose(ctxAsset.asset_id), a = d.asset, nxt = d.next_steps[1];
      lead = `${a.tag}: ${a.condition_state.replaceAll("_", " ")}, health ${a.health_score}, ${String(a.issue_summary).replace(/\.$/, "")} [${a.asset_id}]. ` +
        `Leading hypothesis: ${d.hypotheses[0].hypothesis}. Recommended next check: ${nxt.step} [${nxt.source}]`;
    }
    const rest = compose(hits.filter((h) => !lead || h.id !== `DOC-ASSET-${ctxAsset.asset_id.slice(-3)}`), lead ? 2 : 3);
    return { text: [lead, rest].filter(Boolean).join("\n") || "No supporting document found in the builder pack or the product documentation.",
      sources: hits, mode: "docsearch", asset_id: ctxAsset?.asset_id ?? null };
  },
  search: async (q) => (await ctx()).search(q || "pump fouling flow current", 8),
  doc: async (id) => { const d = (await ctx()).corpus.find((x) => x.id === id); if (!d) throw new Error("not found"); return d; },
  xrayModel: () => once("xray", () => get("xray.json")),
  async draftWO(asset_id) {
    const d = await staticApi.diagnose(asset_id), a = d.asset;
    return { draft_id: `WO-DRAFT-${a.tag}`, status: "Draft · needs planner approval", asset_id, tag: a.tag, area_name: a.area_name, maintenance_type: "inspection",
      priority: a.urgency === "high" ? "high" : "medium", action: a.recommended_next_check, role: "field_technician", problem: `${a.issue_code}: ${a.issue_summary}`,
      evidence_ids: [...d.events.slice(0, 5).map((e) => e.event_id), ...d.similar_cases.slice(0, 2).map((c) => c.case_id)],
      knowledge_doc_id: d.documents.find((x) => x.kind === "knowledge_doc")?.id, safety_prerequisites: ["Work permit", "Isolation and lockout/tagout per site procedure", "OEM or site-approved procedure", "Qualified personnel"],
      confidence: d.confidence.overall, control_actions: "none (draft only)" };
  },
  async command(text, selected, history = []) {
    const c = await ctx(), t = text.toLowerCase(), A = Object.fromEntries(c.assets.map((a) => [a.asset_id, a]));
    history = (history || []).slice(-3);
    // follow-ups ("and what should I check first?") keep the asset of the previous turn when nothing is selected
    const histAsset = [...history].reverse().map((h) => h.asset_id).find((id) => A[id]) || null;
    const cls = Object.entries(CLASS_WORDS).find(([w]) => t.includes(w))?.[1];
    const sig = Object.entries(SIGNAL_WORDS).find(([w]) => t.includes(w))?.[1];
    let asset_id = selected, reason = "";
    // an asset named by tag ("send the robot to M-006") wins over the current selection
    const tagM = t.match(/\b([a-z]{1,3}-\d{3})\b/), named = tagM && c.assets.find((x) => x.tag.toLowerCase() === tagM[1])?.asset_id;
    if (named) {
      asset_id = named;
      // "what's wrong with P-005?" / "why is P-005 flagged?": show its diagnosis
      if (STATUS_WORDS.test(t) && !/send|go to|navigate|dispatch/.test(t) && !XRAY_WORDS.test(t)) {
        const a = A[named], ans = await staticApi.answer(text, named, history);
        const canned = `${a.tag}: ${a.issue_summary}. Condition ${a.condition_state.replaceAll("_", " ")}, health ${a.health_score}, criticality ${a.criticality} [${a.asset_id}]. Opening its diagnosis with the evidence.`;
        const pre = ans.mode === "faq";
        return { intent: "command", asset_id: named, actions: [{ type: "select", asset_id: named, object_id: a.object_id }, { type: "diagnose", asset_id: named }],
          text: pre ? ans.text : canned, sources: pre ? ans.sources : [], mode: pre ? "faq" : "rules", matched_q: ans.matched_q };
      }
    }
    // "which parts of P-005 are suspect?" / "show the suspect parts": the diagnosis' leading hypothesis on the X-Ray model
    const focusId = asset_id || histAsset;
    if (focusId && /\b(parts?|components?)\b/.test(t) && /suspect|faulty|broken|likely|which|affected|implicated/.test(t)) {
      const d = await staticApi.diagnose(focusId), a = d.asset, h0 = d.hypotheses[0], lib = (await staticApi.xrayModel()).classes[a.asset_class] || { components: [] };
      const names = Object.fromEntries(lib.components.map((x) => [x.id, x.name.toLowerCase()])), comps = (h0.components || []).filter((x) => names[x]);
      const alts = d.hypotheses.slice(1, 3).map((x) => x.hypothesis).join("; ");
      const txt = comps.length
        ? `${a.tag}'s leading hypothesis is “${h0.hypothesis}” [${a.asset_id}], which points at the ${comps.map((x) => names[x]).join(" and ")} of the ${String(lib.label || "").toLowerCase()} teaching model ${comps.map((x) => `[KB-XRAY-${a.asset_class}#${x}]`).join("")}.` +
          (alts ? ` Alternatives are not excluded: ${alts}.` : "") + " Opening the X-Ray view with those parts highlighted (illustrative model, not from the scan)."
        : `${a.tag} is ${a.condition_state.replaceAll("_", " ")} with no fault hypothesis linked to a component [${a.asset_id}]. Opening the X-Ray view of its equipment type.`;
      const acts = focusId !== selected ? [{ type: "select", asset_id: focusId, object_id: A[focusId].object_id }] : [];
      acts.push({ type: "xray", asset_id: focusId, ...(comps.length ? { focus: comps } : {}) });
      return { intent: "command", asset_id: focusId, actions: acts, text: txt, mode: "rules" };
    }
    const actions = [];
    // a question about a named component ("what does the impeller do?"): answer it for that device type and show the part
    const lib = await staticApi.xrayModel(), selCls = A[selected]?.asset_class;
    let hits = [];
    for (const [k, cl] of Object.entries(lib.classes)) for (const p of cl.components) {
      const n = p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${n}s?\\b`).test(t)) hits.push([n.length, k === selCls, k, p]);
    }
    if (cls) hits = hits.filter((h) => h[2] === cls);
    hits.sort((x, y) => y[0] - x[0] || y[1] - x[1]);
    if (hits.length && /what (does|is|are)|what's|explain|how (does|do i|to)|inspect|fail|faulty|evidence|purpose|why/.test(t) && !/\bwhere\b/.test(t)) {
      const [, , ccls, comp] = hits[0];
      if (A[asset_id]?.asset_class !== ccls) asset_id = c.assets.filter((a) => a.asset_class === ccls).sort(byCondition)[0]?.asset_id;
      const ans = await staticApi.query(text, asset_id, comp.id);
      return { intent: "component", text: ans.text, sources: ans.sources, actions: asset_id ? [{ type: "xray", asset_id, focus: [comp.id] }] : [], asset_id, component: comp.id, mode: ans.mode };
    }
    // a question that names a tag but is not a command ("is P-005 safe to keep running?"): answer it about that asset
    if (named && QUESTION.test(t) && !COMMAND_WORDS.test(t)) {
      const ans = await staticApi.answer(text, named, history);
      return { intent: "question", ...ans, actions: named === selected ? [] : [{ type: "select", asset_id: named, object_id: A[named].object_id }], asset_id: named };
    }
    const sigQ = !!(sig && ANOMALY.test(t));       // "where is the vibration sensor?" names a device, not a symptom
    if (sigQ) {
      let best = null;
      for (const a of c.assets) { if (cls && a.asset_class !== cls) continue; const s = a.signals.find((x) => x.signal === sig && x.z_vs_peers != null); if (s && (!best || s.z_vs_peers > best[1].z_vs_peers)) best = [a, s]; }
      if (best) { asset_id = best[0].asset_id; const s = best[1]; reason = `${best[0].tag} has the most abnormal ${sig}: ${s.recent_mean} ${s.unit} against a peer mean of ${s.peer_mean} ${s.unit} (z = ${s.z_vs_peers}) [Telemetry_Sample_3d].`; }
    } else if (/fault|faulty|broken|worst|priority|critical|problem|alarm/.test(t)) {
      const cand = c.assets.filter((a) => !cls || a.asset_class === cls).sort((a, b) => b.priority - a.priority);
      if (cand.length) { const a = cand[0]; asset_id = a.asset_id; reason = `${a.tag} has the highest maintenance priority${cls ? " among " + cls.replace("_", " ").toLowerCase() + "s" : ""}: ${a.condition_state.replace("_", " ")}, health ${a.health_score}, ${a.issue_code} (${a.criticality}) [${a.asset_id}].`; }
    }
    if (cls && !reason && (!asset_id || A[asset_id]?.asset_class !== cls) && /explain|what does|how does|component|parts|x-?ray|inside|practi|learn|this/.test(t)) {
      const same = c.assets.filter((a) => a.asset_class === cls).sort(byCondition);
      if (same.length) asset_id = same[0].asset_id;
    }
    let m = t.match(/(?:where(?:'s| is| are)|locate|find|show me)\s+(?:the\s+|all\s+|a\s+)?(.+?)[?.!]*$/);
    if (m && (/manual|document|\bdocs?\b|knowledge|procedure|guide/.test(m[1]) || XRAY_WORDS.test(t) || /^(how (does|is|are|was|were|did)|why)\b/.test(t))) m = null;   // library / X-Ray requests are not scene searches
    // "where are the control valves?" names what to look for: the current selection must not answer it
    if (m && !reason && !sigQ && !/\b(it|this|that|here|selected)\b/.test(m[1])) asset_id = null;
    if (!asset_id && m && !sigQ) {
      const tag = t.match(/\b([a-z]{1,2}-\d{3})\b/);
      if (tag) { const hit = c.assets.find((a) => a.tag.toLowerCase() === tag[1]); if (hit) { asset_id = hit.asset_id; reason = `${hit.tag} is ${/^[aeio]/i.test(hit.asset_class) ? "an" : "a"} ${hit.asset_class.replaceAll("_", " ").toLowerCase()} in ${hit.area_name} [${hit.asset_id}].`; } }
      else {
        const found = findObjects(c, m[1]);
        if (found.length) {
          const best = found[0], b = c.assets.find((a) => a.object_id === best.id);
          actions.push({ type: "select_object", object_id: best.id, matches: found.slice(0, 40).map((o) => o.id), asset_id: b?.asset_id ?? null });
          asset_id = b?.asset_id ?? null;
          reason = `Found ${found.length} object${found.length === 1 ? "" : "s"} labelled like “${m[1]}” in the scan. Highlighting ${found.length > 1 ? "them" : "it"}; the closest match is ${best.id} (${best.label}, ${Math.round(best.confidence * 100)}% confidence, ${best.label_source}).` + (b ? ` It is mapped to workbook asset ${b.tag} [${b.asset_id}].` : "");
        }
      }
    }
    if (/manual|document|\bdocs?\b|knowledge|procedure|guide/.test(t) && !reason && !/send|go to|navigate|dispatch|x-?ray|explode|inside|explain/.test(t)) {
      const a = A[asset_id], q = a ? `${a.asset_class.replaceAll("_", " ").toLowerCase()} ${a.issue_code.replaceAll("_", " ").toLowerCase()}` : "";
      return { intent: "command", actions: [{ type: "knowledge", query: q }], asset_id, text: `Opening the library${a ? ` with the documents for ${a.tag} (${q})` : ""}. Every document has an ID you can cite.` };
    }
    // select only what the question picked; an inherited selection just scopes the answer
    if (asset_id && (asset_id !== selected || reason || named) && !actions.some((x) => x.type === "select_object")) {
      const a = A[asset_id]; actions.push({ type: "select", asset_id, object_id: a.object_id });
      if (!reason) reason = `${a.tag} is ${/^[aeio]/i.test(a.asset_class) ? "an" : "a"} ${a.asset_class.replaceAll("_", " ").toLowerCase()} in ${a.area_name}, ${a.condition_state.replaceAll("_", " ")}, health ${a.health_score} [${a.asset_id}].`;
      if (a.object_id) { const o = c.scene.objects.find((x) => x.id === a.object_id); reason += ` Mapped to scene object ${a.object_id} (${o.label}, ${o.label_source}), mapping confidence ${a.mapping_confidence}.`; }
    }
    if (/send|go to|navigate|inspect|dispatch|walk|drive|route/.test(t) && asset_id && !/practi[cs]e|learn|train|rehears|how do i|how to|how (does|is|are|was|were)|what (is|are|does)|why/.test(t)) { actions.push({ type: "navigate", asset_id }); reason += " Dispatching the inspection robot on a collision-free route."; }
    if (/x-?ray|explode|inside|internal|component|parts/.test(t)) actions.push({ type: "xray", asset_id });
    if (/explain|what does|what is this|how does/.test(t) && asset_id && (named || cls || /\b(this|it|that|selected)\b/.test(t) || !FEATURE_WORDS.test(t))) {
      const a = A[asset_id], lib = (await staticApi.xrayModel()).classes[a.asset_class];
      if (lib) reason = `${a.tag} is ${/^[aeiou]/i.test(lib.label) ? "an" : "a"} ${lib.label.toLowerCase()}. ${lib.function} Its main components: ${lib.components.slice(0, 8).map((x) => x.name.toLowerCase()).join(", ")}. Current condition: ${a.condition_state.replaceAll("_", " ")}, health ${a.health_score} [${a.asset_id}]. ` + reason;
    }
    if (/practi[cs]e|exercise|train|rehears/.test(t)) actions.push({ type: "practice" });
    if (/learn|tutorial|teach/.test(t)) actions.push({ type: "learn" });
    if (/manual|document|doc|knowledge|procedure/.test(t)) actions.push({ type: "knowledge" });
    if (!reason && !actions.length) {
      const tag = t.match(/\b([a-z]{1,3}-\d{3})\b/), named = tag && c.assets.find((x) => x.tag.toLowerCase() === tag[1])?.asset_id;
      const scope = named || selected || histAsset, a = await staticApi.answer(text, scope, history);
      return { intent: "question", ...a, actions: [], asset_id: a.asset_id ?? scope ?? null }; }
    if (!reason) reason = actions.map((a) => ({ xray: "Opening the X-Ray view.", practice: "Opening Practice: a fictional case, with a safety check first.", learn: "Opening the guided lessons.", knowledge: "Opening the library." }[a.type] || "")).join(" ");
    return { intent: "command", text: reason.trim(), actions, asset_id };
  },
};
