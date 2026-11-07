// Phones and small tablets (≤ 820 px): style.css hides the tool rail, so a "Tools" button in the top bar opens a
// sheet that lists every rail action (built-in and module buttons, including About) and clicks the hidden rail
// button for it, so behaviour stays identical to the desktop rail.
import { APP, on } from "./ext.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TOOLS = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>';
const HELP = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4M12 17h.01"/></svg>';

function railItems() {
  return [...document.querySelectorAll("#rail button[data-rail]")]
    .filter((b) => !b.classList.contains("hidden") && b.dataset.rail !== "minimap")
    .map((b) => ({ id: b.dataset.rail, title: (b.title || b.getAttribute("aria-label") || b.dataset.rail).replace(/\s*\(.*?\)\s*$/, ""), icon: b.querySelector("svg")?.outerHTML || "", on: b.classList.contains("on") }));
}
export function openTools() {
  const items = railItems();
  const row = (id, icon, title, on = false) => `<button type="button" class="mt-row ${on ? "on" : ""}" data-mt="${esc(id)}">${icon}<span>${esc(title)}</span>${on ? "<small>On</small>" : ""}</button>`;
  APP.sheet("Tools", `<div class="mt-list">${row("guide", HELP, "How to use this page")}${items.map((i) => row(i.id, i.icon, i.title, i.on)).join("")}</div>
    <p class="note" style="margin-top:10px">The same tools as the side rail on a computer screen.</p>`);
  const sheet = document.getElementById("sheet");
  sheet.querySelector(".mt-list").onclick = (e) => {
    const id = e.target.closest("[data-mt]")?.dataset.mt; if (!id) return;
    sheet.classList.add("hidden");
    if (id === "guide") return APP.guide?.open();
    document.querySelector(`#rail button[data-rail="${CSS.escape(id)}"]`)?.click();
  };
}
on("boot", () => {
  const top = document.querySelector(".topright"); if (!top || document.getElementById("toolsBtn")) return;
  const b = document.createElement("button");
  b.type = "button"; b.id = "toolsBtn"; b.className = "iconbtn mt-btn"; b.title = "Tools"; b.setAttribute("aria-label", "Tools");
  b.innerHTML = `${TOOLS}<span class="lbl">Tools</span>`;
  b.onclick = openTools;
  top.appendChild(b);
  APP.tools = { open: openTools, items: railItems };
});
