// Copilot conversation checks in a real (headless) Chromium. Run after `npm run build`:
//   node tests/e2e-copilot.mjs                 static build (hosted demo: pre-generated answers / document search)
//   BASE=http://localhost:5173/ node tests/e2e-copilot.mjs    against a dev server with the API (live AI)
// Asks 20 realistic questions in one conversation (with follow-ups that rely on the previous turn), and checks that
// every answer is sensible, carries a mode label, cites sources and is not a raw document dump. Also: follow-up
// chips, citation click, X-Ray / dispatch actions, and the panel on a phone.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, devices } = (() => { try { return require("playwright"); } catch { return require("@playwright/test"); } })();

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || path.join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null, BASE = process.env.BASE;
if (!BASE) {
  const port = 4900 + Math.floor(Math.random() * 90);
  server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: "pipe" });
  BASE = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
}
const URL = BASE + (BASE.includes("?") ? "&" : "?") + "scan=off&noguide";
console.log("testing", URL);

const last = (p) => p.evaluate(() => {
  const t = document.querySelector("#pop .cp-last");
  return { text: t?.querySelector(".cp-a")?.innerText || "", mode: t?.querySelector(".cp-mode")?.innerText || "", modeCls: t?.querySelector(".cp-mode")?.className || "",
    cites: t ? t.querySelectorAll(".cp-a .cite").length : 0, chips: [...(t?.querySelectorAll(".cp-fu .chip") || [])].map((c) => c.textContent),
    turns: document.querySelectorAll("#pop .cp-turn").length, open: !document.querySelector("#pop").classList.contains("hidden"),
    sel: window.__app.selected?.asset?.tag || null, mode3d: window.__app.mode, moving: !!window.__app.robot?.moving, route: !!window.__app.route?.ok,
    diag: window.__app.diag?.asset?.tag || null, xAsset: window.__app.xAsset?.tag || null };
});
// "raw dump": very long, or workbook codes / snake_case outside the citation chips, or a record pasted verbatim
const rawDump = (txt) => {
  const prose = txt.replace(/\b(DOC|KB|CASE|EVT|WO|DQ|ASSET|FAQ)-[A-Za-z0-9_#-]+/g, "").replace(/Telemetry_Sample_3d/g, "");
  return txt.length > 1100 || /\b[A-Z]+_[A-Z_]+\b/.test(prose) || /synthetic_record|safe_evidence_workflow|\{"/.test(txt);
};

const isStatic = !process.env.BASE;
const LIVE = /Live AI/, PRE = /Pre-generated/, DOC = /Document search/, RULE = /Rule-based/;
// what a free question should produce: pre-generated (static), live AI (server); a server without LLM quota falls back
// to the pre-generated answer or document search and must say so
const ANSWER = isStatic ? PRE : process.env.EXPECT_LIVE ? LIVE : /Live AI|live AI unavailable/;
const QUESTIONS = [
  // [question, label regex, check(answer) → bool, description]
  ["What's wrong with P-005?", isStatic ? PRE : process.env.EXPECT_LIVE ? LIVE : /Live AI|Rule-based/, (a) => /foul/i.test(a.text) && a.sel === "P-005" && a.diag === "P-005", "fouling, P-005 selected + diagnosis"],
  ["and what should I check first?", ANSWER, (a) => /hydraulic/i.test(a.text), "follow-up keeps P-005: hydraulic path"],
  ["Is it safe to keep running?", ANSWER, (a) => /cannot|can't|site procedure|qualified|lockout/i.test(a.text) && /P-005|ASSET-017|pump/i.test(a.text), "no safety verdict, defers to site procedures"],
  ["What evidence supports this?", ANSWER, (a) => a.cites >= 2, "evidence with ≥2 citations"],
  ["Which parts of P-005 are suspect?", RULE, (a) => /impeller/i.test(a.text) && a.mode3d === "xray", "impeller, X-Ray opened"],
  ["Which motor is overheating?", RULE, (a) => a.sel === "M-006" && /M-006/.test(a.text), "M-006 selected"],
  ["What should I check first?", ANSWER, (a) => /cool|load|M-006/i.test(a.text), "follow-up on M-006"],
  ["When was P-004 last serviced?", ANSWER, (a) => /P-004/.test(a.text), "P-004 history"],
  ["Is CV-003 safe to keep running?", ANSWER, (a) => /CV-003|ASSET-003|valve/i.test(a.text), "named tag beats selection"],
  ["Which assets need attention first?", ANSWER, (a) => /P-005|ASSET-017/.test(a.text), "P-005 first"],
  ["How were the objects in the scan labelled?", ANSWER, (a) => /vision|cluster|DBSCAN/i.test(a.text), "segmentation + VLM"],
  ["how does the robot find its path", ANSWER, (a) => /A\*|clearance|grid/i.test(a.text), "A*, clearance"],
  ["Is any of this real plant data?", ANSWER, (a) => /synthetic/i.test(a.text), "synthetic labelled"],
  ["What would a pilot measure?", ANSWER, (a) => /precision|time to|recall/i.test(a.text), "pilot KPIs"],
  ["Can it connect to OPC UA?", ANSWER, (a) => /read-only|OPC|not built|design/i.test(a.text), "read-only design"],
  ["Can the app control plant equipment?", ANSWER, (a) => /\bno\b|not|read-only/i.test(a.text), "no control"],
  ["What does Plan mode do?", ANSWER, (a) => /proxy|layout|collision/i.test(a.text), "planning"],
  ["What does Support mode do?", ANSWER, (a) => /asynchronous|expert|package/i.test(a.text), "support hand-off"],
  ["Where is P-002?", RULE, (a) => a.sel === "P-002", "rule: select P-002"],
  ["zebra crossing paint colours", isStatic ? DOC : /./, (a) => a.text.length > 20, "no match → honest document search"],
];

async function run() {
  const browser = await chromium.launch({ args: GL });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(60000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.goto(URL);
  await p.waitForFunction(() => window.__app?.fac && !document.querySelector("#loading"), null, { timeout: 120000 });
  await p.evaluate(() => document.querySelector(".toast")?.remove());
  // the panel opens with suggestions
  await p.click("#ask");
  ok("panel opens with suggestions", await p.evaluate(() => document.querySelectorAll("#pop .cp-sugg .sugg").length >= 5));
  ok("panel shows the run mode", /Offline demo|Live AI/.test(await p.innerText("#pop .cp-head")));
  for (const [q, label, check, what] of QUESTIONS) {
    await p.evaluate(() => document.querySelector("#sheet")?.classList.add("hidden"));
    if (q === "Is it safe to keep running?") {          // typed in the field like a person would
      await p.fill("#ask", q); await p.press("#ask", "Enter");
      await p.waitForFunction(() => document.querySelector("#pop .cp-last .cp-mode"), null, { timeout: 60000 });
    } else await p.evaluate((q) => window.__ask(q), q);
    await sleep(300);
    const a = await last(p);
    const good = label.test(a.mode) && a.text.length > 30 && !rawDump(a.text) && !/went wrong/.test(a.text) && check(a);
    ok(`“${q}”`, good, `${what} · [${a.mode.slice(0, 70)}] ${a.text.replace(/\s+/g, " ").slice(0, 120)}`);
    if (q === "What's wrong with P-005?") {
      ok("follow-up chips: 3 fitting P-005", a.chips.length === 3 && a.chips.some((c) => /check first|suspect|robot/i.test(c)), a.chips.join(" | "));
      await p.screenshot({ path: `${SHOTS}/copilot-conversation.png` });
    }
    if (q === "What evidence supports this?") {
      // a click on a citation opens the document
      await p.click("#pop .cp-last .cp-a .cite");
      await sleep(400);
      const opened = await p.evaluate(() => !document.querySelector("#sheet").classList.contains("hidden") || !!document.querySelector(".toast"));
      ok("citation click opens the source", opened);
      await p.evaluate(() => document.querySelector("#sheet")?.classList.add("hidden"));
    }
  }
  // a follow-up chip runs its question (and its actions): Send the robot
  await p.evaluate(() => window.__ask("What's wrong with M-006?"));
  await sleep(300);
  const chip = await p.$('#pop .cp-last .cp-fu .chip:text-matches("robot", "i")');
  if (chip) { await chip.click(); await p.waitForFunction(() => window.__app.route?.ok, null, { timeout: 30000 }).catch(() => {}); }
  const after = await last(p);
  ok("chip “Send the robot” dispatches", !!chip && after.route && /Dispatching/.test(after.text), after.text.slice(0, 80));
  const turns = after.turns;
  ok("conversation keeps the turns", turns >= 10, `${turns} turns on screen`);
  await p.click("#pop [data-cp-clear]");
  ok("New clears the conversation", await p.evaluate(() => !document.querySelector("#pop .cp-turn") && !!document.querySelector("#pop .cp-sugg")));
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
}

async function phone() {
  const browser = await chromium.launch({ args: GL });
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const p = await ctx.newPage();
  await p.goto(URL);
  await p.waitForFunction(() => window.__app?.fac && !document.querySelector("#loading"), null, { timeout: 120000 });
  await p.evaluate(() => document.querySelector(".toast")?.remove());
  await p.tap("#ask");
  await p.fill("#ask", "What should I check first on P-005?");
  await p.press("#ask", "Enter");
  await p.waitForFunction(() => document.querySelector("#pop .cp-last .cp-mode"), null, { timeout: 60000 });
  const box = await p.evaluate(() => { const r = document.querySelector("#pop").getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight }; });
  ok("phone: panel fits the screen", box.l >= 0 && box.r <= box.w + 0.5 && box.b <= box.h + 0.5 && box.t >= 40, JSON.stringify(box));
  const a = await last(p);
  ok("phone: answer + label + chips", a.text.length > 30 && a.mode && a.chips.length === 3, a.chips.join(" | "));
  ok("phone: no horizontal overflow", await p.evaluate(() => document.querySelector("#pop .cp-conv").scrollWidth <= document.querySelector("#pop .cp-conv").clientWidth + 1));
  await p.screenshot({ path: `${SHOTS}/copilot-phone.png` });
  await browser.close();
}

try { await run(); await phone(); } catch (e) { ok("suite ran", false, e.message); }
server?.kill();
const failed = results.filter(([, g]) => !g).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
