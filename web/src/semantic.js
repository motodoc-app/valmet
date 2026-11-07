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

// Label → family: the SAME grouping as scripts/scene_quality.py FAMILY (quality panel "By type"), so the legend, the
// site map, the floor plan and the quality panel all show identical counts. The per-object VLM `category` is
// inconsistent across objects, so it is not used. Pipe tags count as piping; logistics / boards / racks as structure.
export const FAMILY = {
  "pump-motor unit": "rotating", "circulation pump": "rotating", "centrifugal pump": "rotating", "electric motor": "rotating",
  "control valve": "valve", "manual valve": "valve", "valve actuator": "valve",
  "temperature sensor": "instrument", "pressure gauge": "instrument", "pressure transmitter": "instrument",
  "flow meter": "instrument", "vibration sensor": "instrument",
  "insulated pipe (horizontal)": "piping", "insulated pipe (vertical)": "piping", "pipe elbow / fitting": "piping", "pipe label / tag": "piping",
  "electrical cabinet": "electrical", "control panel": "electrical", "junction box": "electrical", "cable tray": "electrical",
  "heat exchanger": "vessel", "expansion vessel": "vessel", "storage tank": "vessel",
  "trolley / cart": "structure", "wall-mounted board": "structure", "shelving / rack": "structure",
  "other equipment": "unknown", "not an object / fragment": "unknown",   // rejected in the in-app label review
};
export function catOf(o) {
  if (o.kind === "structure") return "structure";
  return FAMILY[o.label] || (o.label ? "structure" : "unknown");
}
export const isUncertain = (o) => o.kind === "object" && (o.confidence < UNCERTAIN_BELOW || o.label === "other equipment");
export const hexRGB = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
