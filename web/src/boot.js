// Entry point. Decides between the 3D app and the 2D floor plan BEFORE any WebGL code runs:
//   - no WebGL2 (blocked, disabled, old GPU, headless) -> 2D floor plan
//   - the 3D app throws while starting (renderer creation, driver error) -> 2D floor plan
//   - `#plan` in the URL forces the floor plan (handy on slow devices and for testing)
// The floor plan keeps the core job working: select assets, dispatch the inspection, watch the route, read the result.
function webgl2Available() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();   // release the probe context
    return true;
  } catch { return false; }
}

async function startPlan(reason) {
  const m = await import("./plan2d.js");
  await m.startPlan(reason);
}

const forced = location.hash.startsWith("#plan") || new URLSearchParams(location.search).get("view") === "plan";
if (forced) startPlan(location.hash === "#plan=lost" ? "The graphics driver stopped responding, so the app switched to the floor plan." : "You opened the floor plan view.");
else if (!webgl2Available()) startPlan("3D graphics (WebGL 2) are not available in this browser.");
else {
  import("./main.js").catch((e) => {
    console.error("3D app failed to start:", e);
    startPlan("The 3D view could not start on this device.");
  });
}
