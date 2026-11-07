// Records the demo video frame by frame, so it works on machines without a GPU (software GL renders the scan at
// well under 1 fps, far too slow for screen recording). The page runs in ?capture mode: nothing animates until
// window.__step(dt) renders one frame. Still shots are captured once and held; motion is captured at FPS.
//
//   cd web && npm run build && npx vite preview --port 4710 --strictPort &
//   node tests/record-demo.cjs http://localhost:4710/ out-dir        → out-dir/industrial-x-ray-demo.mp4
//
// Needs a global Playwright and ffmpeg. Captions are drawn into the page, so the video needs no extra editing.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const BASE = process.argv[2] || "http://localhost:4710/";
const OUT = path.resolve(process.argv[3] || "demo-recording");
const FPS = +(process.env.FPS || 12), W = +(process.env.W || 1280), H = +(process.env.H || 720);
const QUICK = !!process.env.QUICK;             // QUICK=1: scan off, for rehearsing the script fast
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });

let n = 0;
const list = [];                                // ffconcat entries: [file, seconds]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => console.warn("pageerror", e.message));
  await p.goto(BASE + "?capture" + (QUICK ? "&scan=off" : ""));
  await p.waitForFunction(() => window.__app?.fac && window.__xr?.setMode, null, { timeout: 120000 });
  if (!QUICK) await p.waitForFunction(() => window.__app.fac.splatMode === "splats" || window.__app.fac.previews.length > 2, null, { timeout: 240000 });
  await p.evaluate(() => { document.querySelector(".toast")?.remove(); const c = document.createElement("div"); c.id = "rec-caption";
    c.style.cssText = "position:absolute;left:50%;bottom:118px;transform:translateX(-50%);z-index:30;max-width:860px;padding:10px 16px;border-radius:10px;background:rgba(10,11,13,.86);border:1px solid rgba(255,255,255,.14);color:#f2f3f5;font:500 16px/1.4 -apple-system,Segoe UI,Inter,sans-serif;text-align:center;display:none";
    document.getElementById("app").appendChild(c); });

  const step = (dt) => p.evaluate((dt) => window.__step(dt), dt);
  const shot = async () => { const f = `f${String(n++).padStart(5, "0")}.png`; await p.screenshot({ path: path.join(OUT, "frames", f) }); return f; };
  /** Render one frame and hold it for `sec` seconds of video. */
  const hold = async (sec) => { await step(1 / FPS); list.push([await shot(), sec]); };
  /** Render `sec` seconds of motion at FPS. */
  const play = async (sec) => { const k = Math.round(sec * FPS); for (let i = 0; i < k; i++) { await step(1 / FPS); list.push([await shot(), 1 / FPS]); } process.stdout.write(`.${n}`); };
  /** Advance app time without capturing (e.g. skip the middle of a long drive). */
  const skip = async (sec) => { const k = Math.round(sec * FPS); for (let i = 0; i < k; i++) await step(1 / FPS); };
  const caption = (t) => p.evaluate((t) => { const c = document.getElementById("rec-caption"); c.textContent = t; c.style.display = t ? "block" : "none"; }, t);
  const js = (fn, arg) => p.evaluate(fn, arg);

  const scenes = require(process.env.SCRIPT || "./record-script.cjs");
  await scenes({ p, hold, play, skip, caption, js, step, sleep, QUICK });

  // assemble: concat demuxer with per-frame durations, then a constant 24 fps H.264 file
  const cat = list.map(([f, d]) => `file 'frames/${f}'\nduration ${d.toFixed(4)}`).join("\n") + `\nfile 'frames/${list.at(-1)[0]}'\n`;
  fs.writeFileSync(path.join(OUT, "frames.ffconcat"), "ffconcat version 1.0\n" + cat);
  const total = list.reduce((s, [, d]) => s + d, 0);
  console.log(`\n${n} frames, ${total.toFixed(1)} s of video`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(OUT, "frames.ffconcat"),
    "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", path.join(OUT, "industrial-x-ray-demo.mp4")], { stdio: "inherit" });
  console.log("wrote", path.join(OUT, "industrial-x-ray-demo.mp4"));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
