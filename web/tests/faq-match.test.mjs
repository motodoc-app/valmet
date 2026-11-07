// Unit checks for the hosted-demo FAQ matcher (no browser): node tests/faq-match.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { indexFaq, matchFaq, detectIntent, compose } from "../src/faq-match.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const faq = JSON.parse(readFileSync(path.join(here, "../public/static/faq.json"), "utf8"));
const idx = indexFaq(faq);
let fails = 0;
const ok = (name, cond, info = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  · " + info : ""}`); };

ok("FAQ: 250+ entries", faq.faq.length >= 250, String(faq.faq.length));
ok("FAQ: every asset entry has citations", faq.faq.filter((f) => f.tag).every((f) => /\[[A-Z]/.test(f.text)));
ok("FAQ: ≤ 3 MB", readFileSync(path.join(here, "../public/static/faq.json")).length < 3e6);

const cases = [
  // [question, context, expected (tag|intent) or general question prefix, or null for "no match"]
  ["Is P-005 safe to keep running?", {}, "P-005|safe"],
  ["is it safe to keep it running", { contextTag: "P-005" }, "P-005|safe"],
  ["and what should I check first?", { contextTag: "M-006" }, "M-006|check"],
  ["What should I do first on CV-003", {}, "CV-003|check"],
  ["what evidence supports this", { contextTag: "P-005" }, "P-005|evidence"],
  ["when was P-004 last serviced?", {}, "P-004|history"],
  ["how sure are you about M-006", {}, "M-006|confidence"],
  ["any data quality problems with VS-002?", {}, "VS-002|dq"],
  ["What's going on with P-002, any problem?", {}, "P-002|wrong"],
  ["how does the robot find its path", {}, "How does the robot plan routes?"],
  ["how were the objects recognised", {}, "How were the objects in the scan labelled?"],
  ["is any of this real plant data", {}, "What data is real and what is synthetic?"],
  ["what would you measure in a pilot", {}, "What would a pilot measure?"],
  ["can it connect to OPC UA", {}, "How would it connect to real plant data?"],
  ["what should I look at first", {}, "Which assets need attention first?"],
  ["what does plan mode do", {}, "What does Plan mode do?"],
  ["purple elephants dancing", {}, null],
];
for (const [q, ctx, want] of cases) {
  const tag = q.match(/\b([a-z]{1,3}-\d{3})\b/i)?.[1]?.toUpperCase() || null;
  const m = matchFaq(idx, q, { tag, ...ctx });
  const got = m ? (m.entry.tag ? `${m.entry.tag}|${m.entry.intent}` : m.entry.q) : null;
  ok(`match “${q}”`, want === null ? got === null : got === want || (got && got.startsWith(want)), `${got} (${m?.how ?? "-"} ${m?.score?.toFixed?.(2) ?? ""})`);
}
// a named tag never borrows another asset's answer
const m = matchFaq(idx, "Is M-001 safe to keep running?", { tag: "M-001", contextTag: "P-005" });
ok("named tag wins over the selection", m?.entry.tag === "M-001");
ok("intent: safe", detectIntent("should we shut it down?") === "safe");
const text = compose([{ id: "DOC-X", title: "T", text: "One. Two. Three. Four." }]);
ok("compose: two sentences + citation", text === "T: One. Two. [DOC-X]", text);
process.exit(fails ? 1 : 0);
