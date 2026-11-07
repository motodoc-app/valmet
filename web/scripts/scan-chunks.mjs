// Builds the streaming scan chunks from the committed public/data/scene.splat.
// Runs automatically before `npm run dev` and `npm run build` (see package.json), so a fresh checkout always
// has the files that public/static/scan.json names. Format "xq16" (17 bytes per splat, ~0.1 mm precision):
//   columnar u16 x, y, z quantised to the scene bounds | u8 log-scale ×3 | u8 r,g,b,a | u8 quaternion ×4
// The .splat file is sorted by visual importance, so chunk 0 alone already shows a recognisable room.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WEB, "public/data/scene.splat");
const OUT = join(WEB, "public/static");
const MANIFEST = join(OUT, "scan.json");
const BOUNDS = [0, 300_000, 730_000];            // chunk starts; last chunk runs to the end
const LOG_MIN = -12, LOG_SPAN = 12;

if (!existsSync(SRC)) {
  console.error(`scan-chunks: ${SRC} is missing. Run scripts/step1_scene.py (or restore the file from git).`);
  process.exit(1);
}
const src = readFileSync(SRC);
if (src.length % 32) { console.error("scan-chunks: scene.splat size is not a multiple of 32 bytes"); process.exit(1); }
const n = src.length / 32;
const srcHash = createHash("sha256").update(src).digest("hex");

// up to date? (same source hash and every chunk present with its declared size)
if (existsSync(MANIFEST)) {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const ok = m.source?.sha256 === srcHash && m.chunks.every((c) => existsSync(join(OUT, c.file)) && statSync(join(OUT, c.file)).size === c.bytes);
    if (ok) { console.log(`scan-chunks: up to date (${m.chunks.length} chunks, ${n.toLocaleString()} splats)`); process.exit(0); }
  } catch { /* rebuild */ }
}

const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
  const v = dv.getFloat32(i * 32 + a * 4, true);
  if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
}
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^scan-\d+\.wasm$/.test(f) || /^scene-\d+\.wasm$/.test(f)) unlinkSync(join(OUT, f));

const starts = [...BOUNDS.filter((b) => b < n), n];
const chunks = [];
for (let k = 0; k < starts.length - 1; k++) {
  const s0 = starts[k], cnt = starts[k + 1] - s0;
  const out = Buffer.alloc(cnt * 17);
  for (let i = 0; i < cnt; i++) {
    const o = (s0 + i) * 32;
    for (let a = 0; a < 3; a++) {
      const v = dv.getFloat32(o + a * 4, true);
      out.writeUInt16LE(Math.round(((v - lo[a]) / (hi[a] - lo[a])) * 65535), (a * cnt + i) * 2);
      const s = Math.max(dv.getFloat32(o + 12 + a * 4, true), 1e-6);
      out[6 * cnt + a * cnt + i] = Math.max(0, Math.min(255, Math.round(((Math.log(s) - LOG_MIN) / LOG_SPAN) * 255)));
    }
    for (let a = 0; a < 4; a++) { out[9 * cnt + a * cnt + i] = src[o + 24 + a]; out[13 * cnt + a * cnt + i] = src[o + 28 + a]; }
  }
  const file = `scan-${k}.wasm`;      // served as a binary type by static hosts; content is the format above
  writeFileSync(join(OUT, file), out);
  chunks.push({ file, count: cnt, bytes: out.length, sha256: createHash("sha256").update(out).digest("hex") });
}
writeFileSync(MANIFEST, JSON.stringify({
  splat_format: "xq16", lo, hi, log_scale_min: LOG_MIN, log_scale_span: LOG_SPAN, total: n, chunks,
  source: { file: "data/scene.splat", bytes: src.length, sha256: srcHash },
}, null, 1));
console.log(`scan-chunks: wrote ${chunks.length} chunks (${(chunks.reduce((a, c) => a + c.bytes, 0) / 1e6).toFixed(1)} MB) from ${n.toLocaleString()} splats`);
