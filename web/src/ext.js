// Extension points for feature modules (planning, remote support, layers, scene quality).
// main.js fills APP with the live app objects at boot; modules register modes, rail buttons and hooks at import time,
// so a new feature lives in its own file and never needs to edit main.js.
//
// Mode definition (registerMode):
//   { id, label, after: "xray",            // tab position (inserted after that mode id)
//     scene: "facility",                   // renders the facility scene with the facility camera
//     enter(prevMode), exit(nextMode),     // set up / tear down; render your own right card in enter()
//     left() -> html | null,               // left card content (null = default asset list)
//     dock() -> html, onDock(event),       // bottom dock content and its click handler
//     onPick(ray, event) -> true if handled // facility click picking (THREE.Ray in world space)
//     minimap: true,                       // keep the mini-map visible in this mode
//     ownsCard: true }                     // selecting an object does not replace this mode's right card
// Hooks (on(name, fn)):
//   boot(APP)              after the scene data and Facility exist
//   frame(dt, t)           every rendered facility frame
//   select(object)         a scene object was selected
//   minimap(ctx, X, Z, k)  draw on the mini-map (X/Z map world metres to canvas pixels, k = px per metre)
//   planExtras() -> { blocks: [], clears: [] }   merged into every route request (planning proxies etc.)
//   modeChange(mode, prev)
// Rail buttons (addRailButton): { id, icon, title, sceneOnly, onClick(APP), isOn() }
export const APP = { modes: new Map(), rail: [], hooks: { boot: [], frame: [], select: [], minimap: [], planExtras: [], modeChange: [] } };
export function registerMode(def) { APP.modes.set(def.id, def); }
export function addRailButton(def) { APP.rail.push(def); }
export const on = (name, fn) => { (APP.hooks[name] ||= []).push(fn); };
export const emit = (name, ...args) => { for (const f of APP.hooks[name] || []) { try { f(...args); } catch (e) { console.warn(`hook ${name}`, e); } } };
/** Merge every module's planExtras into a route request body. */
export function withExtras(body) {
  const blocks = [...(body.blocks || [])], clears = [...(body.clears || [])];
  for (const f of APP.hooks.planExtras) { try { const x = f() || {}; blocks.push(...(x.blocks || [])); clears.push(...(x.clears || [])); } catch (e) { console.warn("planExtras", e); } }
  return clears.length ? { ...body, blocks, clears } : { ...body, blocks };
}
