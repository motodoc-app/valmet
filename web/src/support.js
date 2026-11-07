// Remote Support mode: an ASYNCHRONOUS hand-off between a field technician and a remote expert.
// The technician pins notes on 3D locations, writes a question and shares a support package (link + code + file).
// The expert opens it, sees the same pins, asset context, camera view and plan, adds pins and a recommendation
// (optionally starting from a cited AI draft they must review), drafts a work order and sends a new package back.
// Everything travels inside the package: there is no server, no live session and no connection to plant controls.
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { APP, registerMode, on } from "./ext.js";
import { icon } from "./icons.js";
import { esc, kv, cites, header, toast, nice, plainSummary } from "./ui.js";
import "./support.css";

export const HONEST = "Asynchronous hand-off: the context travels in the link/package. No live multi-user session in this prototype. No connection to plant controls.";
const FORMAT = "industrial-xray-support/1";
const ROLE = { technician: "Technician", expert: "Expert" };
const OTHER = { technician: "expert", expert: "technician" };
const MAX_PINS = 40, MAX_TEXT = 600;

const rid = () => Math.random().toString(36).slice(2, 8);
const blank = () => ({ id: rid(), round: 0, role: "technician", from: null, received: false, example: false, assetId: null,
  question: "", rec: "", recAi: false, reviewed: false, wo: false, pins: [], log: [], camera: null, plan: null, snapshot: null, created: null });
const ST = blank();
// view-only state (never shared)
const V = { arm: false, editing: null, focus: null, out: null, ai: null, aiBusy: false, diag: new Map(), group: null, markers: [], showImport: false, prevSel: null };

const S = () => APP.S;
const objOf = (id) => S().objById?.get(id) || S().data.objects.find((o) => o.id === id);
const assetObj = (assetId) => S().data.objects.find((o) => o.asset?.asset_id === assetId);
const asset = () => assetObj(ST.assetId)?.asset || S().target.asset;
const inMode = () => S()?.mode === "support";
const r2 = (x) => Math.round(x * 100) / 100;
const hhmm = (ts) => { if (!ts) return ""; const d = new Date(ts), same = d.toDateString() === new Date().toDateString();
  return (same ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " ") + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
const clip = (s, n = MAX_TEXT) => String(s ?? "").slice(0, n);
const vec = (a) => new APP.THREE.Vector3(a[0], a[1], a[2]);

async function diagnosis(id) {
  if (!V.diag.has(id)) V.diag.set(id, APP.api.diagnose(id).catch((e) => { V.diag.delete(id); throw e; }));
  return V.diag.get(id);
}
const hasPlan = (p) => Array.isArray(p?.moves) && p.moves.length > 0;
function planState() {
  try { const p = APP.planning?.getState?.(); return hasPlan(p) ? JSON.parse(JSON.stringify(p)) : null; } catch (e) { console.warn("planning.getState", e); return null; }
}
function restorePlan(plan) {
  if (!hasPlan(plan)) return "none";                 // an empty plan changes nothing (and draws no planning overlays)
  const P = APP.planning, f = P?.setState || P?.loadState;
  if (!f) return "unavailable";
  try { f.call(P, plan); return "restored"; } catch (e) { console.warn("planning.setState", e); return "failed"; }
}

// ------------------------------------------------------------------ package: readable form, compact wire form, codec
export function getPackage({ snapshot = true } = {}) {
  const a = asset();
  return {
    format: FORMAT, id: ST.id, round: ST.round, from: ST.from || ST.role, created: ST.created || new Date().toISOString(), example: ST.example,
    asset: { asset_id: a.asset_id, tag: a.tag, object_id: a.object_id || null },
    question: ST.question, recommendation: { text: ST.rec, ai_assisted: ST.recAi, reviewed_by_expert: ST.reviewed },
    work_order_suggested: ST.wo,
    camera: ST.camera || camNow(),
    plan: ST.plan,
    pins: ST.pins.map((p) => ({ role: p.role, text: p.text, position: p.p, object_id: p.obj || null, object_label: p.obj ? objOf(p.obj)?.label || null : null,
      asset_tag: p.obj ? objOf(p.obj)?.asset?.tag || null : null, time: new Date(p.ts).toISOString(), example: !!p.ex })),
    log: ST.log.map((l) => ({ round: l.r, role: l.role, time: new Date(l.ts).toISOString(), pins: l.n, example: !!l.ex })),
    honesty: HONEST,
    ...(snapshot && ST.snapshot ? { snapshot_png: ST.snapshot } : {}),
  };
}
const toWire = (k) => ({ v: 1, i: k.id, r: k.round, f: k.from === "expert" ? 1 : 0, a: k.asset.asset_id, q: k.question, x: k.example ? 1 : 0,
  e: [k.recommendation.text, k.recommendation.ai_assisted ? 1 : 0, k.recommendation.reviewed_by_expert ? 1 : 0, k.work_order_suggested ? 1 : 0],
  c: [...k.camera.position, ...k.camera.target].map(r2), t: Math.round(Date.parse(k.created) / 6e4),
  p: k.pins.map((p) => [p.role === "expert" ? 1 : 0, p.text, ...p.position.map(r2), p.object_id || "", Math.round(Date.parse(p.time) / 6e4), p.example ? 1 : 0]),
  l: k.log.map((l) => [l.round, l.role === "expert" ? 1 : 0, Math.round(Date.parse(l.time) / 6e4), l.pins, l.example ? 1 : 0]),
  ...(k.plan != null ? { pl: k.plan } : {}) });
const fromWire = (w) => ({ format: FORMAT, id: w.i, round: w.r, from: w.f ? "expert" : "technician", example: !!w.x, created: new Date(w.t * 6e4).toISOString(),
  asset: { asset_id: w.a }, question: w.q, recommendation: { text: w.e?.[0] || "", ai_assisted: !!w.e?.[1], reviewed_by_expert: !!w.e?.[2] }, work_order_suggested: !!w.e?.[3],
  camera: { position: w.c.slice(0, 3), target: w.c.slice(3, 6) }, plan: w.pl ?? null,
  pins: (w.p || []).map((p) => ({ role: p[0] ? "expert" : "technician", text: p[1], position: [p[2], p[3], p[4]], object_id: p[5] || null, time: new Date(p[6] * 6e4).toISOString(), example: !!p[7] })),
  log: (w.l || []).map((l) => ({ round: l[0], role: l[1] ? "expert" : "technician", time: new Date(l[2] * 6e4).toISOString(), pins: l[3], example: !!l[4] })) });

const b64u = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (t) => { t = t.replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; const s = atob(t); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
/** Package -> short code: "1" + base64url(deflate-raw(JSON)) where compression exists, else "0" + base64url(JSON). */
export async function encode(pkg) {
  const raw = new TextEncoder().encode(JSON.stringify(toWire(pkg)));
  try { if (typeof CompressionStream === "function") return "1" + b64u(await pipe(raw, new CompressionStream("deflate-raw"))); } catch (e) { console.warn("compress", e); }
  return "0" + b64u(raw);
}
export async function decode(code) {
  const kind = code[0], bytes = unb64u(code.slice(1));
  const raw = kind === "1" ? await pipe(bytes, new DecompressionStream("deflate-raw")) : bytes;
  return fromWire(JSON.parse(new TextDecoder().decode(raw)));
}
/** Accepts a link, a bare code, package JSON text, or a package object (readable or wire form). */
async function parse(input) {
  if (input && typeof input === "object") return input.v === 1 ? fromWire(input) : input;
  const t = String(input || "").trim();
  if (!t) throw new Error("empty");
  if (t.startsWith("{")) { const o = JSON.parse(t); return o.v === 1 ? fromWire(o) : o; }
  const m = t.match(/support=([A-Za-z0-9_-]+)/);
  return decode(m ? m[1] : t.replace(/\s+/g, ""));
}
function linkFor(code) {
  const u = new URL(location.href);
  u.searchParams.delete("support");
  u.hash = "support=" + code;
  return u.toString();
}

/** Validate an untrusted package and load it into the view (the receiver takes the other role). */
export async function loadPackage(input, { as } = {}) {
  const k = await parse(input);
  if (!k || (k.format && k.format !== FORMAT) || !k.asset || !Array.isArray(k.pins)) throw new Error("not a support package");
  const num3 = (a) => Array.isArray(a) && a.length === 3 && a.every((x) => Number.isFinite(+x)) ? a.map(Number) : null;
  const known = assetObj(k.asset.asset_id);
  const from = k.from === "expert" ? "expert" : "technician";
  Object.assign(ST, blank(), {
    id: clip(k.id || rid(), 16), round: Math.max(0, Math.min(99, +k.round || 0)), from, role: as || OTHER[from], received: true, example: !!k.example,
    assetId: known ? k.asset.asset_id : S().target.asset.asset_id, question: clip(k.question, 1200), created: k.created || null,
    rec: clip(k.recommendation?.text, 4000), recAi: !!k.recommendation?.ai_assisted, reviewed: !!k.recommendation?.reviewed_by_expert, wo: !!k.work_order_suggested,
    camera: num3(k.camera?.position) && num3(k.camera?.target) ? { position: num3(k.camera.position), target: num3(k.camera.target) } : null,
    plan: hasPlan(k.plan) ? k.plan : null, snapshot: typeof k.snapshot_png === "string" && k.snapshot_png.startsWith("data:image/png;base64,") ? k.snapshot_png : null,
    pins: k.pins.slice(0, MAX_PINS).map((p) => ({ id: rid(), role: p.role === "expert" ? "expert" : "technician", text: clip(p.text), p: num3(p.position),
      obj: p.object_id && objOf(p.object_id) ? p.object_id : null, ts: Date.parse(p.time) || Date.now(), sent: true, ex: !!p.example })).filter((p) => p.p),
    log: (k.log || []).slice(0, 40).map((l) => ({ r: +l.round || 0, role: l.role === "expert" ? "expert" : "technician", ts: Date.parse(l.time) || Date.now(), n: +l.pins || 0, ex: !!l.example })),
  });
  if (!known) toast(`The package names an asset this scene does not have (${esc(k.asset.tag || k.asset.asset_id)}). Showing ${esc(asset().tag)} instead.`, 6000);
  Object.assign(V, { arm: false, editing: null, focus: null, out: null, ai: null, showImport: false, toTop: true, pinsOpen: false });
  if (!inMode()) APP.setMode("support"); else refreshAll();
  APP.selectAsset(ST.assetId);
  if (ST.camera) APP.flyTo(vec(ST.camera.position), vec(ST.camera.target), 1.2);
  const planRes = restorePlan(ST.plan);
  V.planRes = planRes;
  refreshAll();
  return getPackage({ snapshot: false });
}

// ------------------------------------------------------------------ scene: pins as CSS2D markers, picking, snapshot
function hitPoint(ray) {
  const T = APP.THREE, fac = S().fac, id = fac.pick(ray);
  if (id) {
    const f = fac.frames.get?.(id) || [...fac.frames.values()].find((x) => x.obj.id === id);
    if (f) {   // same oriented-box slab test as Facility.pick, but returning the entry point
      const o = f.obj, ox = ray.origin.x - o.center[0], oy = ray.origin.y - o.center[1], oz = ray.origin.z - o.center[2], d = ray.direction;
      const lo = [ox * f.cs + oz * f.sn, oy, -ox * f.sn + oz * f.cs], ld = [d.x * f.cs + d.z * f.sn, d.y, -d.x * f.sn + d.z * f.cs];
      let t0 = -Infinity, t1 = Infinity;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(ld[i]) < 1e-9) continue;
        let a = (-f.h[i] - lo[i]) / ld[i], b = (f.h[i] - lo[i]) / ld[i]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      const t = t0 > 0 ? t0 : t1;
      if (Number.isFinite(t) && t > 0) return { p: ray.at(t, new T.Vector3()), obj: id };
    }
    return { p: new T.Vector3(...objOf(id).center), obj: id };
  }
  if (ray.direction.y < -1e-4) { const t = -ray.origin.y / ray.direction.y; if (t > 0 && t < 60) return { p: ray.at(t, new T.Vector3()), obj: null }; }
  return null;
}
function clearMarkers() { for (const m of V.markers) { m.removeFromParent(); m.element.remove(); } V.markers = []; }
function renderPins() {
  clearMarkers();
  if (!inMode() || !V.group) return;
  ST.pins.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = `sup-pin ${p.role} ${p.ex ? "ex" : ""} ${V.focus === p.id ? "on" : ""}`;
    el.dataset.pin = p.id;
    el.title = `${ROLE[p.role]}: ${p.text}`;
    el.innerHTML = `<div class="b"><i>${i + 1}</i><span>${esc(p.text.length > 34 ? p.text.slice(0, 33) + "…" : p.text || "New pin")}</span>${p.ex ? "<em>Example</em>" : ""}</div>`;
    el.addEventListener("click", (e) => { e.stopPropagation(); focusPin(p.id); });
    const m = new CSS2DObject(el); m.position.set(...p.p); V.group.add(m); V.markers.push(m);
  });
}
function focusPin(id, fly = true) {
  const p = ST.pins.find((x) => x.id === id); if (!p) return;
  V.focus = id;
  if (fly) { const c = vec(p.p), off = APP.viewOffset(c); APP.flyTo(c.clone().add(off.multiplyScalar(0.85)), c, 0.9); }
  renderPins(); renderLeftCard();
}
/** PNG of the current 3D view, with the pins drawn in (render + read back in the same task). */
function capture() {
  const { renderer, scene, camera, canvas, THREE } = APP;
  renderer.render(scene, camera);
  const w = Math.min(1280, canvas.width), h = Math.round(canvas.height * (w / canvas.width));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(canvas, 0, 0, w, h);
  const v = new THREE.Vector3(), css = getComputedStyle(document.body);
  ST.pins.forEach((p, i) => {
    v.set(...p.p).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
    const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
    ctx.fillStyle = css.getPropertyValue(p.role === "expert" ? "--sup-exp" : "--sup-tech").trim() || "#fff";
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0a0b0d"; ctx.font = "600 12px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(i + 1), x, y + 0.5);
  });
  ctx.fillStyle = "rgba(10,11,13,.75)"; ctx.fillRect(0, h - 24, w, 24);
  ctx.fillStyle = "#a3a8b0"; ctx.font = "11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(`Industrial X-Ray · remote support · ${asset().tag} · ${new Date().toLocaleString()} · synthetic asset data`, 10, h - 12);
  ST.snapshot = c.toDataURL("image/png");
  return ST.snapshot;
}
const camNow = () => ({ position: APP.camera.position.toArray().map(r2), target: APP.controls.target.toArray().map(r2) });

// ------------------------------------------------------------------ actions
function newPin(hit) {
  if (ST.pins.length >= MAX_PINS) { toast(`A package holds up to ${MAX_PINS} pins.`); return; }
  const p = { id: rid(), role: ST.role, text: "", p: hit.p.toArray().map(r2), obj: hit.obj, ts: Date.now(), sent: false, ex: false };
  ST.pins.push(p); V.editing = p.id; V.focus = p.id; V.arm = false; V.out = null;
  refreshAll();
  setTimeout(() => { const t = document.getElementById("supPinText"); t?.focus(); t?.scrollIntoView({ block: "nearest" }); }, 0);
}
function armPin() {
  V.arm = !V.arm; APP.renderDock(); renderCard();
  if (V.arm) toast("Now click a machine or the floor to place the pin.", 2600);
}
/** Back to a fresh, empty hand-off (APP.support.reset; used by "Reset the whole demo"). */
function reset() {
  Object.assign(ST, blank());
  Object.assign(V, { arm: false, editing: null, focus: null, out: null, ai: null, aiBusy: false, showImport: false, planRes: null, toTop: true, pinsOpen: false });
  if (inMode()) { ST.assetId = S().target.asset.asset_id; refreshAll(); } else clearMarkers();
}
function savePin() {
  const p = ST.pins.find((x) => x.id === V.editing); if (!p) return;
  const t = document.getElementById("supPinText")?.value.trim() ?? p.text;
  if (!t) { ST.pins = ST.pins.filter((x) => x !== p); } else { p.text = clip(t); p.ts = Date.now(); }
  V.editing = null; V.out = null; refreshAll();
}
function deletePin(id) { ST.pins = ST.pins.filter((x) => x.id !== id); if (V.editing === id) V.editing = null; V.out = null; refreshAll(); }

async function share() {
  if (V.editing) savePin();
  const role = ST.role, mine = ST.pins.filter((p) => p.role === role && !p.sent).length;
  if (role === "technician" && !ST.question.trim() && !ST.pins.length) { toast("Add a pin or a question for the expert first."); return; }
  if (role === "expert" && !ST.rec.trim() && !mine) { toast("Add a recommendation or a pin before sending the package back."); return; }
  if (role === "expert" && ST.recAi && !ST.reviewed) { toast("Confirm that you reviewed the AI draft before sending it back."); document.getElementById("supRev")?.focus(); return; }
  ST.round += 1; ST.from = role; ST.received = false; ST.created = new Date().toISOString();
  ST.camera = camNow(); ST.plan = planState();
  ST.pins.forEach((p) => (p.sent = true));
  ST.log.push({ r: ST.round, role, ts: Date.now(), n: mine, ex: false });
  const pkg = getPackage({ snapshot: false });
  const code = await encode(pkg);
  V.out = { code, link: linkFor(code) };
  refreshAll();
  setTimeout(() => document.getElementById("supOut")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`, 2200); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand?.("copy"); ta.remove();
    toast(ok ? `${what} copied.` : `Copying is blocked here: select the ${what.toLowerCase()} and copy it by hand.`, 3200);
  }
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fileBase = () => `support-${asset().tag}-r${ST.round}`;
function markdown() {
  const a = asset(), d = V.diagNow, k = getPackage({ snapshot: false });
  const pin = (p, i) => `${i + 1}. **${ROLE[p.role]}${p.example ? " (example)" : ""}:** ${p.text}${p.object_id ? ` — on ${p.object_id} ${p.object_label || ""}${p.asset_tag ? ` (${p.asset_tag})` : ""}` : " — on the floor"} · at (${p.position.join(", ")}) · ${hhmm(Date.parse(p.time))}`;
  return [`# Remote support hand-off · ${a.tag} · round ${ST.round}`, "",
    `> ${HONEST}`, ...(ST.example ? ["", "> **Example:** this hand-off is a scripted example for the demo, not a real expert reply."] : []), "",
    `- **From:** ${ROLE[k.from]} · ${new Date(k.created).toLocaleString()}`,
    `- **Asset:** ${a.tag} (${a.asset_id}) · ${nice(a.asset_class)} · ${nice(a.condition_state)} · health ${a.health_score} · synthetic data`,
    `- **Open in Industrial X-Ray:** ${V.out?.link || "(share first to get a link)"}`,
    `- **Package code** (paste into Support → Import package): \`${V.out?.code || ""}\``, "",
    "## Question for the expert", "", ST.question || "_none_", "",
    "## Pins", "", ...(k.pins.length ? k.pins.map(pin) : ["_none_"]), "",
    "## Expert recommendation", "", ST.rec || "_not yet_", ...(ST.recAi ? ["", `_Started from an AI draft${ST.reviewed ? "; the expert confirmed they reviewed it" : "; not yet confirmed as reviewed"}._`] : []),
    ...(ST.wo ? ["", "The expert suggests a work-order draft (draft only, needs planner approval, no control actions)."] : []), "",
    ...(d ? ["## Copilot diagnosis (context)", "", plainSummary(d).replace(/<[^>]+>/g, ""), ""] : []),
    "## Hand-off log", "", ...k.log.map((l) => `- Round ${l.round}: ${ROLE[l.role]}${l.example ? " (example)" : ""} · ${new Date(l.time).toLocaleString()} · ${l.pins} new pin(s)`), "",
    ST.snapshot ? `Snapshot: ${fileBase()}.png (also embedded in ${fileBase()}.json)` : "", ""].join("\n");
}

async function aiDraft() {
  const a = asset();
  V.aiBusy = true; renderCard();
  try {
    const d = await diagnosis(a.asset_id);
    const q = (ST.question.trim() || `What should the technician check first on ${a.tag}?`) + ` ${a.tag} ${a.issue_summary}`;
    let r = null; try { r = await APP.api.query(q, a.asset_id); } catch (e) { console.warn("query", e); }
    const lead = d.hypotheses[0], alt = d.hypotheses[1];
    const lines = [];
    if (lead) lines.push(`Most likely cause: ${lead.hypothesis.replace(/\.$/, "")} (copilot confidence ${Math.round(d.confidence.overall * 100)}%).${alt ? ` Not excluded: ${alt.hypothesis.charAt(0).toLowerCase() + alt.hypothesis.slice(1).replace(/\.$/, "")}.` : ""}`);
    if (d.next_steps.length) lines.push("Recommended checks, in order:", ...d.next_steps.slice(0, 3).map((s, i) => `${i + 1}. ${s.step.replace(/\.$/, "")} [${s.source}]`));
    if (r && String(r.mode || "").startsWith("llm")) lines.push(`On the question: ${r.text}`);
    else if (r?.sources?.length) lines.push(`Relevant documents: ${r.sources.slice(0, 3).map((s) => `${s.title || s.id} [${s.id}]`).join("; ")}.`);
    lines.push("Before any work: work permit, isolation and lockout/tagout per site procedure.");
    V.ai = { text: lines.join("\n"), mode: r?.mode || "evidence engine" };
  } catch (e) { toast(`The AI draft could not be made: ${esc(e.message)}`); }
  V.aiBusy = false; renderCard();
}

function newHandoff() {
  Object.assign(ST, blank(), { assetId: S().selected?.asset?.asset_id || S().target.asset.asset_id });
  Object.assign(V, { arm: false, editing: null, focus: null, out: null, ai: null, showImport: false, planRes: null });
  refreshAll();
}

// ------------------------------------------------------------------ the example hand-off (scripted, clearly labelled)
async function exampleParts() {
  const o = S().target, a = o.asset, d = await diagnosis(a.asset_id).catch(() => null);
  const c = new APP.THREE.Vector3(...o.center), off = APP.viewOffset(c).setY(0).normalize();
  const top = [o.center[0], o.center[1] + o.size[1] / 2, o.center[2]].map(r2);
  const floor = [c.x + off.x * 1.1, 0, c.z + off.z * 1.1].map(r2);
  const side = [c.x + off.x * 0.35, o.center[1], c.z + off.z * 0.35].map(r2);
  const step = d?.next_steps?.find((x) => !/identity/i.test(x.step)) || d?.next_steps?.[0], lead = d?.hypotheses?.[0];
  const t0 = Date.now() - 50 * 6e4;
  return {
    a, o,
    question: `${a.tag} lost efficiency and the motor current is up. Can it keep running until the planned stop, and what should I check first?`,
    tech: [
      { role: "technician", text: "Casing warm on the drive end, faint rattle at full load", p: top, obj: o.id, ts: t0, ex: true },
      { role: "technician", text: "Service area: about 1 m clear in front of the pump", p: floor, obj: null, ts: t0 + 3 * 6e4, ex: true },
    ],
    expert: { role: "expert", text: step ? `Start here: ${step.step.replace(/\.$/, "")}` : "Start with the suction side", p: side, obj: o.id, ts: t0 + 40 * 6e4, ex: true },
    rec: [lead ? `Example reply. The evidence points to ${lead.hypothesis.charAt(0).toLowerCase() + lead.hypothesis.slice(1).replace(/\.$/, "")}.` : "Example reply.",
      ...(d?.next_steps || []).slice(0, 2).map((s, i) => `${i + 1}. ${s.step.replace(/\.$/, "")} [${s.source}]`),
      "Keep it running only while the readings stay inside the site limits; raise the work-order draft for the planned stop."].join("\n"),
  };
}
/** Add a scripted, clearly labelled example expert reply to the technician's current hand-off. */
async function exampleReply() {
  const x = await exampleParts();
  if (V.editing) savePin();
  if (!ST.round) { ST.round = 1; ST.log.push({ r: 1, role: "technician", ts: Date.now() - 40 * 6e4, n: ST.pins.length, ex: false }); }
  ST.pins.forEach((p) => (p.sent = true));
  ST.pins.push({ ...x.expert, id: rid(), sent: true, ts: Date.now() });
  ST.round += 1; ST.from = "expert"; ST.received = true; ST.example = true;
  ST.rec = x.rec; ST.recAi = false; ST.reviewed = false; ST.wo = true;
  ST.log.push({ r: ST.round, role: "expert", ts: Date.now(), n: 1, ex: true });
  V.out = null; refreshAll();
}
/** Enter Support mode with the complete example hand-off for P-005 (tour and demo video). Idempotent. */
async function demo() {
  const x = await exampleParts(), now = Date.now();
  const c = new APP.THREE.Vector3(...x.o.center), off = APP.viewOffset(c);
  const pos = c.clone().add(off.clone().multiplyScalar(1.45)).setY(2.1);
  const pkg = {
    format: FORMAT, id: "EXAMPLE", round: 2, from: "expert", example: true, created: new Date(now - 8 * 6e4).toISOString(),
    asset: { asset_id: x.a.asset_id, tag: x.a.tag }, question: x.question,
    recommendation: { text: x.rec, ai_assisted: false, reviewed_by_expert: false }, work_order_suggested: true,
    camera: { position: pos.toArray().map(r2), target: [c.x, 0.35, c.z].map(r2) }, plan: null,
    pins: [...x.tech, x.expert].map((p) => ({ role: p.role, text: p.text, position: p.p, object_id: p.obj, time: new Date(p.ts).toISOString(), example: true })),
    log: [{ round: 1, role: "technician", time: new Date(now - 45 * 6e4).toISOString(), pins: 2, example: true },
      { round: 2, role: "expert", time: new Date(now - 8 * 6e4).toISOString(), pins: 1, example: true }],
  };
  await loadPackage(pkg, { as: "technician" });
  document.getElementById("right")?.classList.remove("min");
  return getPackage({ snapshot: false });
}

// ------------------------------------------------------------------ UI: banner, left card, right card, dock
function banner() {
  let b = document.getElementById("supBanner");
  if (!inMode()) { b?.remove(); return; }
  if (!b) { b = document.createElement("div"); b.id = "supBanner"; b.className = "sup-banner"; b.setAttribute("role", "status"); document.getElementById("app").appendChild(b); }
  const who = ST.received ? `${ROLE[ST.role]} view · package from the ${ST.from}` : `${ROLE[ST.role]} view`;
  b.className = `sup-banner ${ST.role}`;
  b.innerHTML = `<span class="who">${who}</span>${ST.example ? '<span class="pill amber">Example</span>' : ""}<span class="t">Asynchronous hand-off · no live session · no plant controls</span>`;
}
function pinRows() {
  return ST.pins.map((p, i) => {
    const o = p.obj && objOf(p.obj), own = p.role === ST.role && !p.sent;
    return `<div class="list-row sup-row ${V.focus === p.id ? "on" : ""}" role="button" tabindex="0" data-spin="${p.id}">
      <span class="sup-num ${p.role}">${i + 1}</span>
      <span class="nm"><b>${esc(p.text || "New pin")}</b><small>${ROLE[p.role]}${p.ex ? " · example" : ""} · ${o ? esc(o.asset?.tag || o.label) : "floor"} · ${hhmm(p.ts)}${p.sent ? "" : " · not sent"}</small></span>
      ${own ? `<span class="sup-rowtools"><button class="link" data-sedit="${p.id}" title="Edit" aria-label="Edit pin">${icon("edit")}</button><button class="link" data-sdel="${p.id}" title="Delete" aria-label="Delete pin">${icon("close")}</button></span>` : "<span></span>"}</div>`;
  }).join("");
}
function leftHTML() {
  const rows = pinRows();
  return `<div class="card-h"><span class="t">Hand-off pins</span><span class="card-tools"><span class="note">${ST.pins.length}</span><button class="link" data-min-card title="Minimise" aria-label="Minimise">${icon("minus")}</button></span></div>
    <div class="card-b" style="padding:0 8px 8px">${rows || `<p class="note" style="padding:0 8px">No pins yet. Press <b>Pin a note</b>, then click a machine or the floor.</p>`}</div>
    <div class="card-f"><span><i class="sup-key technician"></i>Technician</span><span><i class="sup-key expert"></i>Expert</span><span>Thread <b>${esc(ST.id)}</b></span></div>`;
}
function renderLeftCard() {
  if (!inMode()) return;
  const l = document.getElementById("left"); l.classList.remove("tall"); l.innerHTML = leftHTML(); l.onclick = onLeft;
}
function onLeft(e) {
  const t = e.target;
  if (t.closest("[data-min-card]")) return;
  const ed = t.closest("[data-sedit]"); if (ed) { V.editing = ed.dataset.sedit; focusPin(V.editing, false); renderCard(); return; }
  const del = t.closest("[data-sdel]"); if (del) return deletePin(del.dataset.sdel);
  const row = t.closest("[data-spin]"); if (row) focusPin(row.dataset.spin);
}

function cardHTML() {
  const a = asset(), o = assetObj(a.asset_id), role = ST.role, d = V.diagNow?.asset?.asset_id === a.asset_id ? V.diagNow : null;
  const sel = S().selected, canSwitch = sel?.asset && sel.asset.asset_id !== a.asset_id;
  const editing = ST.pins.find((p) => p.id === V.editing);
  const techPins = ST.pins.filter((p) => p.role === "technician").length, expPins = ST.pins.length - techPins;
  const plan = ST.plan != null ? (V.planRes === "unavailable" ? "Included (Planning mode not loaded here)" : V.planRes === "failed" ? "Included (could not be restored)" : "Included")
    : APP.planning?.getState ? "Added when you share" : "No plan (Planning mode not available)";
  const lastLog = ST.log.at(-1);
  const out = V.out ? `<div class="section sup-out" id="supOut"><div class="label"><span>Support package · round ${ST.round}</span><span>${V.out.link.length} characters</span></div>
      <p class="note">Send the link to the ${OTHER[role]} (mail, chat, ticket). If links are stripped (embedded pages), send the code or the file: they open it under <b>Import package</b>.</p>
      <label class="sup-field"><span>Link</span><input class="search sup-mono" id="supLink" readonly value="${esc(V.out.link)}"/></label>
      <div class="row"><button class="btn" data-sa="copy-link">${icon("copy")}Copy link</button><a class="btn" href="${esc(V.out.link)}" target="_blank" rel="noopener">${icon("arrow")}Open</a></div>
      <label class="sup-field"><span>Code</span><textarea class="search sup-ta sup-mono" id="supCode" readonly rows="3">${esc(V.out.code)}</textarea></label>
      <div class="row"><button class="btn" data-sa="copy-code">${icon("copy")}Copy code</button><button class="btn" data-sa="dl-json">${icon("download")}Package .json</button><button class="btn" data-sa="dl-md">${icon("doc")}Summary .md</button>${ST.snapshot ? `<button class="btn" data-sa="dl-png">${icon("camera")}Snapshot .png</button>` : ""}</div>
      <p class="note">The .json file also carries the snapshot${ST.snapshot ? "" : " (none captured)"}; the link and code carry everything else.</p></div>` : "";
  const question = role === "technician" && !ST.received && !(ST.round && ST.from === "expert")
    ? `<textarea class="search sup-ta" id="supQ" rows="3" placeholder="What do you need from the expert? e.g. Can it run until the planned stop? What should I check first?">${esc(ST.question)}</textarea>`
    : ST.question ? `<div class="sup-quote technician">${esc(ST.question)}</div>` : '<p class="note">No question in this package.</p>';
  const recBlock = role === "expert"
    ? `<textarea class="search sup-ta" id="supRec" rows="5" placeholder="Your recommendation for the technician. Cite documents with [ID] where you can.">${esc(ST.rec)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" data-sa="ai" ${V.aiBusy ? "disabled" : ""}>${icon("spark")}${V.aiBusy ? "Drafting…" : "Draft recommendation with AI"}</button></div>
      ${V.ai ? `<div class="sup-ai"><div class="label"><span>AI draft — the expert must review</span><span>${esc(V.ai.mode)}</span></div><div class="narr">${cites(V.ai.text)}</div>
        <div class="row" style="margin-top:8px"><button class="btn" data-sa="use-ai">${icon("check")}Use as starting point</button><button class="link" data-sa="drop-ai">Discard</button></div></div>` : ""}
      ${ST.recAi ? `<label class="gate"><input type="checkbox" id="supRev" ${ST.reviewed ? "checked" : ""}/> I reviewed and edited the AI draft; this recommendation is mine.</label>` : ""}`
    : ST.rec ? `<div class="sup-quote expert">${cites(ST.rec).replace(/\n/g, "<br>")}</div>${ST.recAi ? `<p class="note">Started from an AI draft${ST.reviewed ? "; the expert confirmed they reviewed it." : "; not confirmed as reviewed."}</p>` : ""}${ST.example ? '<p class="note"><span class="pill amber">Example</span> Scripted for the demo, not a real expert reply.</p>' : ""}`
    : '<p class="note">No recommendation yet: the expert adds it after opening your package.</p>';
  const mine = ST.pins.filter((p) => p.role === role).length, sentByMe = ST.log.some((l) => l.role === role && !l.ex);
  const steps = role === "technician"
    ? [["Pin a note on the spot in the room", mine > 0], ["Write your question for the expert", !!ST.question.trim()], ["Share the link with the expert", sentByMe]]
    : [["Look at the pins and the question", ST.pins.length > 0 || !!ST.question], ["Write your recommendation (an AI draft can help)", !!ST.rec.trim()], ["Send it back to the technician", sentByMe]];
  const shareLabel = role === "expert" ? "Send back to the technician" : ST.round && ST.from === "technician" ? "Share again (new round)" : "Share with expert";
  return `${header("Remote support", `${esc(a.tag)} hand-off`, `<span class="tag syn">Synthetic</span>${ST.example ? '<span class="pill amber">Example</span>' : ""}`)}
    <div class="sub">${ROLE[role]} view · ${ST.round ? `round ${ST.round}` : "draft"}${lastLog ? ` · last sent by the ${lastLog.role} ${hhmm(lastLog.ts)}` : ""}</div>
    <div class="sup-actions"><button class="btn ${V.arm ? "on" : ""} sup-big" data-sa="pin" aria-pressed="${V.arm}">${icon("pin")}${V.arm ? "Now click the scene…" : "Pin a note"}</button>
      <button class="btn primary sup-big" data-sa="share">${icon("share")}${shareLabel}</button></div>
    ${V.arm ? '<p class="sup-armed">Click a machine or the floor in the 3D view to place your pin.</p>' : ""}
    <div class="sup-phone sup-row2"><div class="seg" role="group" aria-label="View as">${["technician", "expert"].map((r) => `<button data-srole="${r}" class="${role === r ? "on" : ""}">${ROLE[r]}</button>`).join("")}</div><button class="btn" data-sa="new">${icon("reset")}Start new</button></div>
    ${out}
    ${editing ? `<div class="section sup-edit"><div class="label"><span>${editing.sent ? "Pin" : "New pin"} ${ST.pins.indexOf(editing) + 1} · ${editing.obj ? esc(objOf(editing.obj)?.asset?.tag || objOf(editing.obj)?.label) : "floor"}</span><span>${ROLE[editing.role]}</span></div>
      <textarea class="search sup-ta" id="supPinText" rows="2" maxlength="${MAX_TEXT}" placeholder="What is here? e.g. Leak at the flange, noise, missing guard">${esc(editing.text)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-sa="pin-save">${icon("check")}Save pin</button><button class="btn" data-sa="pin-cancel">Cancel</button></div></div>` : ""}
    <ol class="sup-steps">${steps.map(([t, d], i) => `<li class="${d ? "done" : ""}"><span class="k">${d ? icon("check") : i + 1}</span><span>${t}</span></li>`).join("")}</ol>
    <div class="sup-honest">${icon("help")}<span>${HONEST}</span></div>
    ${ST.received ? `<div class="section sup-recv">${icon("inbox")}<span><b>${ROLE[ST.from]}'s package opened</b> · round ${ST.round}${ST.created ? ` · ${hhmm(Date.parse(ST.created))}` : ""}. Pins, asset${ST.camera ? ", camera view" : ""}${hasPlan(ST.plan) ? " and maintenance plan" : ""} are restored.</span></div>` : ""}
    <div class="section"><div class="label"><span>Shared asset context</span>${o ? `<button class="link" data-sa="locate">${icon("target")}Show</button>` : ""}</div>
      ${kv("Asset", `<b class="sup-mono">${esc(a.tag)}</b> · <span class="status s-${a.condition_state}">${nice(a.condition_state)}</span>`)}${kv("Health", a.health_score)}${kv("Issue", esc(nice(a.issue_code)))}
      ${kv("Camera view", ST.camera && ST.received ? "From the package" : "Saved when you share")}${kv("Maintenance plan", esc(plan))}
      ${d ? `<div class="plain">${plainSummary(d)}</div>` : '<p class="note">Loading the diagnosis…</p>'}
      ${canSwitch ? `<button class="btn block" style="margin-top:8px" data-sa="use-sel">${icon("target")}Make ${esc(sel.asset.tag)} the shared asset</button>` : ""}</div>
    <div class="section"><div class="label">Question for the expert</div>${question}</div>
    <div class="section"><div class="label"><span>Pins</span><span>${techPins} technician · ${expPins} expert</span></div>
      <p class="note">${V.arm ? "<b>Click a machine or the floor to place the pin.</b>" : "Press <b>Pin a note</b>, then click the scene. Pins are listed on the left and on the mini-map."}</p>
      ${ST.pins.length ? `<div class="sup-phone"><button class="btn block" data-sa="pins">${icon("pin")}${V.pinsOpen ? "Hide the pin list" : `Show the pin list (${ST.pins.length})`}</button>${V.pinsOpen ? `<div class="sup-pinlist">${pinRows()}</div>` : ""}</div>` : ""}</div>
    <div class="section"><div class="label">Expert recommendation</div>${recBlock}</div>
    ${role === "expert" || ST.wo ? `<div class="section"><div class="label">Work order</div>
      <button class="btn block" data-sa="wo">${icon("doc")}${role === "expert" ? "Create work-order draft" : "Open the suggested work-order draft"}</button>
      <p class="note" style="margin-top:6px">${ST.wo && role !== "expert" ? "The expert suggests this draft. " : ""}Draft only: needs planner approval, no control actions.</p></div>` : ""}
    <div class="section"><div class="label"><span>View snapshot</span>${ST.snapshot ? '<button class="link" data-sa="dl-png">Download</button>' : ""}</div>
      ${ST.snapshot ? `<img class="sup-shot" src="${ST.snapshot}" alt="Snapshot of the 3D view with the pins"/>` : ""}
      <button class="btn block" data-sa="capture">${icon("camera")}${ST.snapshot ? "Capture again" : "Capture view"}</button></div>
    ${role === "technician" && !ST.rec ? `<div class="section"><button class="btn block" data-sa="example">${icon("inbox")}Load example expert reply <span class="pill amber">Example</span></button></div>` : ""}
    <div class="section"><div class="label"><span>Received a package?</span><button class="link" data-sa="toggle-import">${V.showImport ? "Hide" : "Import package"}</button></div>
      ${V.showImport ? `<textarea class="search sup-ta sup-mono" id="supImport" rows="3" placeholder="Paste the link, the code or the package JSON"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-sa="import">${icon("inbox")}Open package</button><label class="btn sup-file">${icon("download")}From file<input type="file" id="supFile" accept=".json,application/json"/></label></div>` : '<p class="note">Open a link, or paste a code or package file from the other side.</p>'}</div>
    ${ST.log.length ? `<div class="section"><div class="label">Hand-off log</div>${ST.log.map((l) => kv(`Round ${l.r} · ${ROLE[l.role]}${l.ex ? " (example)" : ""}`, `${hhmm(l.ts)} · ${l.n} pin${l.n === 1 ? "" : "s"}`)).join("")}</div>` : ""}
  </div>
  <div class="card-f"><span>Async hand-off</span><span>No live session</span><span>No plant controls</span></div>`;
}
function renderCard() {
  if (!inMode()) return;
  const r = document.getElementById("right"), b = r.querySelector(".card-b"), top = V.toTop ? 0 : b?.scrollTop || 0;
  V.toTop = false;
  r.innerHTML = cardHTML();
  const nb = r.querySelector(".card-b"); if (nb) nb.scrollTop = top;
  if (top === 0) r.scrollTop = 0;
  const a = asset();
  if (V.diagNow?.asset?.asset_id !== a.asset_id) diagnosis(a.asset_id).then((d) => { const was = V.diagNow; V.diagNow = d; if (was !== d && asset().asset_id === a.asset_id) renderCard(); }).catch(() => {});
}
function refreshAll() { if (!inMode()) return; renderLeftCard(); renderCard(); renderPins(); banner(); APP.renderDock(); }

async function onCard(e) {
  if (!inMode()) return;
  const sr = e.target.closest("[data-srole]");
  if (sr) { if (ST.role !== sr.dataset.srole) { ST.role = sr.dataset.srole; V.ai = null; V.editing = null; V.out = null; refreshAll(); } return; }
  if (e.target.closest("[data-spin], [data-sedit], [data-sdel]")) return onLeft(e);
  const t = e.target.closest("[data-sa]"); if (!t) return;
  const a = t.dataset.sa;
  if (a === "pin") return armPin();
  if (a === "pins") { V.pinsOpen = !V.pinsOpen; return renderCard(); }
  if (a === "new") return newHandoff();
  if (a === "pin-save") savePin();
  if (a === "pin-cancel") { const p = ST.pins.find((x) => x.id === V.editing); if (p && !p.text) ST.pins = ST.pins.filter((x) => x !== p); V.editing = null; refreshAll(); }
  if (a === "share") await share();
  if (a === "copy-link") copy(V.out.link, "Link");
  if (a === "copy-code") copy(V.out.code, "Code");
  if (a === "dl-json") download(`${fileBase()}.json`, JSON.stringify(getPackage(), null, 2), "application/json");
  if (a === "dl-md") download(`${fileBase()}.md`, markdown(), "text/markdown");
  if (a === "dl-png" && ST.snapshot) download(`${fileBase()}.png`, await (await fetch(ST.snapshot)).blob());
  if (a === "capture") { capture(); renderCard(); toast("View captured. It goes into the package file.", 2400); }
  if (a === "ai") aiDraft();
  if (a === "use-ai" && V.ai) { ST.rec = (ST.rec.trim() ? ST.rec.trim() + "\n\n" : "") + V.ai.text; ST.recAi = true; ST.reviewed = false; V.ai = null; renderCard(); document.getElementById("supRec")?.focus(); }
  if (a === "drop-ai") { V.ai = null; renderCard(); }
  if (a === "wo") { ST.wo = ST.wo || ST.role === "expert"; APP.showWorkOrder(asset().asset_id); }
  if (a === "locate") { const o = assetObj(asset().asset_id); if (o) APP.selectObject(o, { fly: true }); }
  if (a === "use-sel") { ST.assetId = S().selected.asset.asset_id; V.ai = null; V.out = null; renderCard(); }
  if (a === "example") { await exampleReply(); toast("Example expert reply loaded. It is scripted for the demo and labelled as an example.", 4200); }
  if (a === "toggle-import") { V.showImport = !V.showImport; renderCard(); if (V.showImport) document.getElementById("supImport")?.focus(); }
  if (a === "import") {
    const v = document.getElementById("supImport")?.value;
    try { await loadPackage(v); toast(`Package opened: ${ROLE[ST.role].toLowerCase()} view.`); }
    catch (err) { console.warn(err); toast("That is not a support package. Paste the whole link, the code or the JSON file."); }
  }
}
function onCardInput(e) {
  if (!inMode()) return;
  const id = e.target.id;
  if (id === "supQ") { ST.question = clip(e.target.value, 1200); V.out = null; }
  if (id === "supRec") { ST.rec = clip(e.target.value, 4000); V.out = null; }
}
async function onCardChange(e) {
  if (!inMode()) return;
  if (e.target.id === "supRev") { ST.reviewed = e.target.checked; V.out = null; }
  if (e.target.id === "supFile" && e.target.files?.[0]) {
    try { await loadPackage(await e.target.files[0].text()); toast("Package file opened."); }
    catch (err) { console.warn(err); toast("That file is not a support package."); }
  }
}

function dockHTML() {
  const role = ST.role;
  return `<div class="grp"><button class="tool ${V.arm ? "on" : ""}" data-sd="pin" title="Then click a machine or the floor">${icon("pin")}${V.arm ? "Click the scene" : "Pin a note"}</button>
      <button class="tool" data-sd="capture">${icon("camera")}Capture view</button></div>
    <div class="grp"><button class="tool" data-sd="share">${icon("share")}${role === "expert" ? "Send back" : "Share"}</button>
      <button class="tool" data-sd="import">${icon("inbox")}Import</button><button class="tool" data-sd="new">${icon("reset")}New</button></div>
    <div class="grp"><div class="sup-seglbl">View as</div><div class="seg" role="group" aria-label="View as">${["technician", "expert"].map((r) => `<button data-srole="${r}" class="${role === r ? "on" : ""}">${ROLE[r]}</button>`).join("")}</div></div>`;
}
async function onDock(e) {
  const r = e.target.closest("[data-srole]");
  if (r) { if (ST.role !== r.dataset.srole) { ST.role = r.dataset.srole; V.ai = null; V.editing = null; V.out = null; refreshAll(); } return; }
  const d = e.target.closest("[data-sd]")?.dataset.sd;
  if (d === "pin") armPin();
  if (d === "capture") { capture(); renderCard(); toast("View captured. It goes into the package file.", 2400); }
  if (d === "share") await share();
  if (d === "import") { V.showImport = true; renderCard(); const t = document.getElementById("supImport"); t?.scrollIntoView({ block: "nearest" }); t?.focus(); }
  if (d === "new") newHandoff();
}

// ------------------------------------------------------------------ mode registration and hooks
registerMode({
  id: "support", label: "Support", after: "practice", scene: "facility", minimap: true, ownsCard: true,
  enter() {
    document.body.classList.add("support-on");
    V.toTop = true;
    if (!ST.assetId) ST.assetId = S().selected?.asset?.asset_id || S().target.asset.asset_id;
    // a moving robot would replace this card with its transit card: pause it while the hand-off is open
    const R = S().robot; if (R.moving) { R.moving = false; R.v = 0; toast("Robot paused while Support is open.", 2600); }
    if (!V.group) V.group = new APP.THREE.Group();
    APP.scene.add(V.group);
    refreshAll();
  },
  exit() {
    document.body.classList.remove("support-on");
    V.arm = false; clearMarkers(); V.group?.removeFromParent();
    document.getElementById("supBanner")?.remove();
  },
  left: () => leftHTML(),
  dock: () => dockHTML(),
  onDock,
  onPick(ray) {
    if (!V.arm) return false;
    const hit = hitPoint(ray);
    if (!hit) { toast("Click a machine or the floor."); return true; }
    newPin(hit);
    return true;
  },
});

on("minimap", (ctx, X, Z) => {
  if (!inMode()) return;
  const css = getComputedStyle(document.body);
  ST.pins.forEach((p, i) => {
    const x = X(p.p[0]), z = Z(p.p[2]);
    ctx.fillStyle = css.getPropertyValue(p.role === "expert" ? "--sup-exp" : "--sup-tech").trim() || "#fff";
    ctx.beginPath(); ctx.arc(x, z, V.focus === p.id ? 9 : 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0a0b0d"; ctx.font = "600 9px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(i + 1), x, z + 0.5);
  });
});
on("select", () => { if (inMode()) queueMicrotask(() => { renderLeftCard(); renderCard(); }); });

async function openFromLocation() {
  const m = location.hash.match(/support=([A-Za-z0-9_-]+)/) || location.search.match(/[?&]support=([A-Za-z0-9_-]+)/);
  if (!m) return;
  try {
    await loadPackage(m[1]);
    const msg = `<b>${ROLE[ST.role]} view</b> · the ${ST.from}'s package is open. ${esc(HONEST)}`;
    toast(msg, 7000);
    // main.js shows a "New here? Take the tour" toast ~1.5 s after boot; it would replace this one
    const t0 = Date.now(), mo = new MutationObserver(() => {
      if (Date.now() - t0 > 6000) return mo.disconnect();
      if (document.querySelector(".toast [data-tour]")) { mo.disconnect(); toast(msg, 6000); }
    });
    mo.observe(document.getElementById("app"), { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 6500);
  } catch (e) { console.warn("support package", e); toast("The support link could not be read. Ask the sender for the code or the package file."); }
  const u = new URL(location.href); u.searchParams.delete("support"); u.hash = "";
  history.replaceState(null, "", u.pathname + u.search);
}
on("boot", (A) => {
  A.support = { getPackage, loadPackage, demo, encode, decode, reset, state: () => ST };
  const r = document.getElementById("right");
  r.addEventListener("click", onCard); r.addEventListener("input", onCardInput); r.addEventListener("change", onCardChange);
  addEventListener("hashchange", () => { if (/support=/.test(location.hash)) openFromLocation(); });
  setTimeout(openFromLocation, 0);    // after main.js has rendered its default cards
});
