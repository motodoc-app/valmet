// Semantic categories shared by the 3D semantic view, the site map and the 2D floor plan (no three.js here).
// Colours avoid the condition palette (green / yellow / orange / red) so "what it is" never reads as "how it is".
export const CATEGORIES = [
  { id: "rotating", label: "Rotating equipment", short: "Rotating", color: "#4f8cff" },
  { id: "vessel", label: "Vessels, exchangers", short: "Vessels", color: "#7fd4ff" },
  { id: "valve", label: "Valves", short: "Valves", color: "#c08cff" },
  { id: "piping", label: "Piping", short: "Piping", color: "#46c6b8" },
  { id: "instrument", label: "Instruments", short: "Instruments", color: "#ff7eb6" },
  { id: "electrical", label: "Electrical", short: "Electrical", color: "#e2c46c" },
  { id: "structure", label: "Structure", short: "Structure", color: "#9aa0a8" },
  { id: "unknown", label: "Unidentified", short: "Unidentified", color: "#5c626b" },
];
export const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const CONDITION = { healthy: "#30d158", watch: "#ffd60a", degraded: "#ff9f0a", attention_required: "#ff453a" };
/** Objects below this label confidence, or labelled only as "other equipment", are "uncertain". */
export const UNCERTAIN_BELOW = 0.5;

export function catOf(o) {
  const c = o.category;
  if (c === "rotating" || c === "vessel" || c === "valve" || c === "piping" || c === "instrument" || c === "electrical") return c;
  if (c === "structure" || o.kind === "structure") return "structure";
  return "unknown";
}
export const isUncertain = (o) => o.kind === "object" && (o.confidence < UNCERTAIN_BELOW || o.label === "other equipment");
export const hexRGB = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
