// Friendly mode guides: every tab says what it is for in plain words, and the first time a tab is opened a small
// "How to use this page" coach card shows three steps. The coach can be reopened with "How to use" (under the tabs)
// or the "?" in the tab bar on phones. Also loads ux.css (readability + touch sizes) after style.css.
import { APP, on } from "./ext.js";
import "./ux.css";
import "./guide.css";

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const SVG = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  facility: SVG('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  xray: SVG('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  plan: SVG('<path d="M4 8h16v12H4z"/><path d="M12 2v4M9 4l3-2 3 2"/>'),
  learn: SVG('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/>'),
  practice: SVG('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  support: SVG('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8"/>'),
  value: SVG('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  help: SVG('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4M12 17h.01"/>'),
  close: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
};

/** Plain-language purpose and three steps for each tab. Written for someone who has never used the app. */
export const GUIDES = {
  facility: { name: "Explore", short: "Look around", purpose: "Look around the scanned room and find equipment.",
    steps: ["Look around: drag the view, or use the Move pad (bottom left) or the W A S D keys.",
      "Click a machine, or pick one from the list on the left, to see what it is and how healthy it is.",
      "Press “Send robot here” and watch the robot drive there and check the machine for you."] },
  xray: { name: "X-Ray", short: "See inside", purpose: "See inside a machine and find the part that is probably faulty.",
    steps: ["Turn the model with the Move pad, the Q E keys, or by dragging it.",
      "Red parts are the ones the evidence points to. Click any part to read what it does.",
      "Use the Explode slider at the bottom to pull the machine apart or put it back together."] },
  plan: { name: "Plan", short: "Make room", purpose: "Try moving things to make room for the repair — safely, nothing real moves.",
    steps: ["Press “Pick the pallet truck”: it is parked where the repair needs space.",
      "Move it with the big arrow buttons, the arrow keys, or by dragging it on the floor.",
      "Press “Done – check the result”. Green means it fits and the pump can be reached."] },
  learn: { name: "Learn", short: "Short lessons", purpose: "Short lessons about the fault, with the parts lit up as you read.",
    steps: ["Choose a lesson on the right. The one marked “matches the current fault” is the most useful.",
      "Read each short step: the parts it talks about light up in the model.",
      "Press Next until the lesson is done. Change the machine type in the list on the left."] },
  practice: { name: "Practice", short: "Get a score", purpose: "Practise the job on a model and get a score.",
    steps: ["Read the case and tick the three safety checks, then press “Start exercise”.",
      "Answer each task: click the right part in the model or pick an answer.",
      "At the end you get a score and the points to review."] },
  support: { name: "Support", short: "Ask an expert", purpose: "Ask an expert for help and share exactly what you see.",
    steps: ["Press “Pin a note”, then click the spot in the room you want to talk about.",
      "Write your question for the expert in the box.",
      "Press “Share with expert” and send them the link. They reply the same way."] },
  value: { name: "Value", short: "Example savings", purpose: "What this could save — example numbers you can change.",
    steps: ["Move the sliders to match your site.",
      "The total updates at once. Every number is an example, not a measured saving.",
      "Read “How it is calculated” to see the arithmetic."] },
};
const guideFor = (m) => GUIDES[m] || (APP.modes.get(m) ? { name: APP.modes.get(m).label, purpose: APP.modes.get(m).purpose || "", steps: APP.modes.get(m).steps || [] } : null);
const seenKey = (m) => `xr.guide.${m}`;
const quiet = () => { const q = new URLSearchParams(location.search); return q.has("qa") || q.has("capture") || q.has("noguide"); };

// ------------------------------------------------------------------ tabs: tooltips, labels, purpose strip, "?" button
function decorateTabs() {
  const nav = document.querySelector(".modes"); if (!nav) return;
  nav.querySelectorAll("button[data-mode]").forEach((b) => {
    const g = guideFor(b.dataset.mode); if (!g) return;
    b.title = `${g.name}: ${g.purpose}`;
    b.setAttribute("aria-label", `${g.name}: ${g.purpose}`);
    if (!b.querySelector(".gd-ti")) b.insertAdjacentHTML("afterbegin", `<span class="gd-ti">${ICON[b.dataset.mode] || ""}</span>`);
  });
  phoneHelp();
}
/** Phones have no purpose strip: a "?" at the end of the tab bar reopens the guide. Only present on phones. */
function phoneHelp() {
  const nav = document.querySelector(".modes"), b = document.getElementById("guideBtn");
  if (innerWidth > 820) { b?.remove(); return; }
  if (b || !nav) return;
  nav.insertAdjacentHTML("beforeend", `<button type="button" id="guideBtn" class="gd-q" title="How to use this page" aria-label="How to use this page">${ICON.help}</button>`);
  document.getElementById("guideBtn").addEventListener("click", (e) => { e.stopPropagation(); openCoach(APP.S.mode, true); });
}
function strip(mode) {
  let el = document.getElementById("gdStrip");
  if (!el) {
    el = document.createElement("div"); el.id = "gdStrip"; el.className = "gd-strip"; el.setAttribute("role", "note");
    document.getElementById("app").appendChild(el);
    el.addEventListener("click", (e) => { if (e.target.closest("[data-gd-open]")) openCoach(APP.S.mode, true); });
  }
  const g = guideFor(mode);
  el.classList.toggle("hidden", !g || mode === "value");
  if (!g) return;
  el.innerHTML = `<span class="gd-si">${ICON[mode] || ICON.help}</span><span class="gd-st"><b>${g.name}</b> ${g.purpose}</span><button type="button" class="gd-how" data-gd-open>${ICON.help}How to use</button>`;
}

// ------------------------------------------------------------------ coach card
let coach = null;
function closeCoach() { coach?.remove(); coach = null; }
function openCoach(mode, force = false) {
  const g = guideFor(mode); if (!g) return;
  if (!force && (store.get(seenKey(mode)) || quiet() || document.body.classList.contains("touring"))) return;
  store.set(seenKey(mode), "1");
  closeCoach();
  coach = document.createElement("div");
  coach.className = "gd-coach"; coach.setAttribute("role", "dialog"); coach.setAttribute("aria-label", `How to use ${g.name}`);
  coach.dataset.mode = mode;
  coach.innerHTML = `<div class="gd-ch"><span class="gd-si">${ICON[mode] || ICON.help}</span><span><small>How to use this page</small><b>${g.name}</b></span>
      <button type="button" class="gd-x" data-gd-close title="Close" aria-label="Close">${ICON.close}</button></div>
    <p class="gd-purpose">${g.purpose}</p>
    <ol class="gd-steps">${g.steps.map((s, i) => `<li><span class="k">${i + 1}</span><span>${s}</span></li>`).join("")}</ol>
    <div class="gd-cf"><button type="button" class="link" data-tour>Take the 1-minute tour instead</button><button type="button" class="btn primary" data-gd-close>Got it</button></div>`;
  document.getElementById("app").appendChild(coach);
  document.querySelector(".toast [data-tour]")?.closest(".toast")?.remove();   // the coach offers the tour itself
  coach.addEventListener("click", (e) => { if (e.target.closest("[data-gd-close], [data-tour]")) closeCoach(); });
  placeCoach();
  if (force) coach.querySelector(".btn.primary")?.focus({ preventScroll: true });
}
function visRect(sel) { const n = document.querySelector(sel); if (!n || n.classList.contains("hidden") || getComputedStyle(n).display === "none") return null; const r = n.getBoundingClientRect(); return r.width && r.height ? r : null; }
function placeCoach() {
  if (!coach) return;
  if (innerWidth <= 820) { coach.style.cssText = ""; return; }
  let lo = 24, hi = innerWidth - 24;
  for (const s of ["#left", "#navpad", "#navpadOpen", "#minimap"]) { const r = visRect(s); if (r && r.right < innerWidth / 2) lo = Math.max(lo, r.right + 12); }
  const right = visRect("#right"); if (right && right.left > innerWidth / 2) hi = Math.min(hi, right.left - 12);
  const w = Math.max(280, Math.min(440, hi - lo));
  const dock = visRect("#dock");
  const bottom = dock ? innerHeight - dock.top + 12 : 24;
  coach.style.left = Math.round(lo + Math.max(0, (hi - lo - w) / 2)) + "px";
  coach.style.width = w + "px";
  coach.style.bottom = bottom + "px";
  coach.style.maxHeight = Math.max(200, innerHeight - bottom - 104) + "px";
}

// ------------------------------------------------------------------ wiring
on("boot", () => {
  decorateTabs();
  strip(APP.S.mode);
  document.body.classList.add(`ux-mode-${APP.S.mode}`);
  APP.guide = { open: (m = APP.S.mode) => openCoach(m, true), close: closeCoach, GUIDES };
  addEventListener("resize", () => requestAnimationFrame(() => { placeCoach(); phoneHelp(); }));
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeCoach(); });
  // the tour explains everything itself: no coach cards on top of it
  new MutationObserver(() => { if (document.body.classList.contains("touring")) closeCoach(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setTimeout(() => { if (APP.S.mode === "facility" && !document.querySelector(".tour")) openCoach("facility"); }, 1200);
  // main.js shows a "New here? Take the tour" toast after boot: while a coach card is open it would only repeat it
  new MutationObserver(() => { if (coach) document.querySelector(".toast [data-tour]")?.closest(".toast")?.remove(); })
    .observe(document.getElementById("app"), { childList: true });
});
on("modeChange", (mode) => {
  document.body.className = document.body.className.replace(/\bux-mode-\S+/g, "").trim();
  document.body.classList.add(`ux-mode-${mode}`);
  strip(mode);
  if (coach && coach.dataset.mode !== mode) closeCoach();
  setTimeout(() => { if (APP.S.mode === mode) openCoach(mode); }, 450);
  const b = document.querySelector(`.modes button[data-mode="${mode}"]`);
  if (innerWidth <= 820 && b) { const n = b.parentElement; n.scrollTo({ left: b.offsetLeft - (n.clientWidth - b.offsetWidth) / 2, behavior: "smooth" }); }
});
