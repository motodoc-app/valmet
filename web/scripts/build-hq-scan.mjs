// Full-fidelity scan build: the supplied 3D Gaussian Splatting model, every splat, with its view-dependent colour
// (spherical harmonics), packed as SPZ chunks of at most 14.5 MB for the static host.
//
//   node scripts/build-hq-scan.mjs [path/to/equipment_room.ply] [--sh 3]
//
// The raw PLY is NOT in git (≈ 396 MB), so this is a one-off step whose OUTPUT is committed:
//   public/static/hq/scan-hq.json   manifest (chunk list, sha256, canonical transform, layer of every chunk)
//   public/static/hq/scan-<k>.wasm  SPZ (gzip) chunks. ".wasm" only so static hosts serve them as binary,
//                                   like the xq16 chunks; the content is a standard .spz file.
// A fresh checkout therefore renders the full scan without the PLY; `npm run build` verifies the chunks
// (scripts/check-manifest.mjs). If they are missing the app falls back to the xq16 chunks / data/scene.splat.
//
// What is kept vs the classic export (scripts/step1_scene.py → scene.splat):
//   · all splats with opacity ≥ 1/255 (classic dropped the 511 k splats with opacity ≤ 0.06: in 3DGS many faint
//     splats stack into walls and floor, so dropping them leaves holes and speckle)
//   · colour without clipping (SPZ stores the DC term with head-room; .splat clips to 0..255 per splat)
//   · spherical harmonics up to --sh (default 3; SPZ quantises the higher bands, most of their bytes compress away)
// Splats stay in the scan's own frame; the canonical Y-up transform (data/processed/integrity_report.json, the
// same one scene.json uses) is applied by the viewer as the mesh transform, so the SH rotate with it exactly.
// Each chunk holds one layer (below/above the cut-away height × clean/haze/outside-the-walls, src/scanfilter.js) of one
// importance tier, so the viewer keeps instant cut-away and clean-scan toggles and phones can load tier 0 only.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hazeMask, wallClip } from "../src/scanfilter.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PLY = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) || join(ROOT, "data/raw/equipment_room.ply"));
const MAX_SH = +opt("--sh", 3);
const OUT = resolve(opt("--out", join(WEB, "public/static/hq")));
const CUT_Y = 1.7;                       // must match Facility.cutY
const TIERS = [730_000, 1_200_000];      // importance tiers: tier 0 alone ≈ the classic phone scan
const MAX_BYTES = 14.5e6;                // hosting limit is 15 MB per file

const spark = await import(join(WEB, "node_modules/@sparkjsdev/spark/dist/spark.module.js"));

// ---------------------------------------------------------------- read the PLY by property name
const buf = readFileSync(PLY);
const hEnd = buf.indexOf("end_header\n") + 11;
const header = buf.subarray(0, hEnd).toString("latin1");
const props = [...header.matchAll(/^property float (\S+)$/gm)].map((m) => m[1]);
if (!/format binary_little_endian/.test(header) || !/^element vertex \d+$/m.test(header) || header.split("property").length - 1 !== props.length) throw new Error("expected a binary little-endian PLY with float properties only");
const N = +header.match(/element vertex (\d+)/)[1], P = props.length, stride = P * 4;
const body = buf.subarray(hEnd, hEnd + N * stride);
if (body.length !== N * stride) throw new Error(`PLY body is ${body.length} bytes, expected ${N * stride}`);
const f = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
const I = Object.fromEntries(props.map((p, i) => [p, i]));
for (const k of ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"]) if (I[k] === undefined) throw new Error(`PLY lacks ${k}`);
const shRest = props.filter((p) => p.startsWith("f_rest_")).length;
console.log(`build-hq-scan: ${N.toLocaleString()} splats, ${P} properties, SH rest ${shRest} (degree ${Math.round(Math.sqrt(shRest / 3 + 1) - 1)})`);

// ---------------------------------------------------------------- canonical frame (same transform as scene.json)
const rep = JSON.parse(readFileSync(join(ROOT, "data/processed/integrity_report.json"), "utf8"));
const T = rep.canonical_transform;                         // 4×4 row-major: p' = R p + t
const R = [T[0].slice(0, 3), T[1].slice(0, 3), T[2].slice(0, 3)], t = [T[0][3], T[1][3], T[2][3]];
const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
if (Math.abs(det - 1) > 1e-3) throw new Error(`canonical transform is not a rotation (det ${det})`);
const scene = JSON.parse(readFileSync(join(WEB, "public/static/scene.json"), "utf8"));

// 32-byte canonical .splat records, only to classify each splat exactly as the classic viewer does
const sig = (x) => 1 / (1 + Math.exp(-x));
const rec = new Uint8Array(N * 32), dv = new DataView(rec.buffer);
const importance = new Float32Array(N), alive = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const o = i * P, x = f[o + I.x], y = f[o + I.y], z = f[o + I.z];
  for (let a = 0; a < 3; a++) dv.setFloat32(i * 32 + a * 4, R[a][0] * x + R[a][1] * y + R[a][2] * z + t[a], true);
  const s = [Math.exp(f[o + I.scale_0]), Math.exp(f[o + I.scale_1]), Math.exp(f[o + I.scale_2])];
  for (let a = 0; a < 3; a++) dv.setFloat32(i * 32 + 12 + a * 4, s[a], true);
  const op = sig(f[o + I.opacity]);
  rec[i * 32 + 27] = Math.round(op * 255);
  alive[i] = op >= 1 / 255 ? 1 : 0;
  const ss = s.sort((p, q) => q - p);
  importance[i] = op * ss[0] * ss[1];                     // visible footprint: what fills the picture first
}
const haze = hazeMask(rec, { ...scene.bounds, walls: wallClip(scene.planes, scene.bounds) });
const kind = new Uint8Array(N);                            // (low 0 / high 1) + 2 × class (0 clean, 1 haze, 2 outside), as splitScan
for (let i = 0; i < N; i++) kind[i] = (dv.getFloat32(i * 32 + 4, true) <= CUT_Y ? 0 : 1) + 2 * haze[i];

const order = Array.from({ length: N }, (_, i) => i).filter((i) => alive[i]).sort((a, b) => importance[b] - importance[a]);
const tierOf = new Uint8Array(N);
order.forEach((i, r) => { tierOf[i] = r < TIERS[0] ? 0 : r < TIERS[1] ? 1 : 2; });

// ---------------------------------------------------------------- write SPZ chunks
mkdirSync(OUT, { recursive: true });
for (const fn of readdirSync(OUT)) if (/^scan-\d+\.wasm$/.test(fn)) unlinkSync(join(OUT, fn));
const LAYERS = [["low", 0], ["high", 0], ["low", 1], ["high", 1], ["low", 2], ["high", 2]];   // [layer, class]
const plyOf = (ids) => {
  const h = Buffer.from(header.replace(/element vertex \d+/, `element vertex ${ids.length}`), "latin1");
  const out = new Uint8Array(h.length + ids.length * stride);
  out.set(h, 0);
  for (let k = 0; k < ids.length; k++) out.set(body.subarray(ids[k] * stride, ids[k] * stride + stride), h.length + k * stride);
  return out;
};
const chunks = [];
const emit = async (ids, tier, k) => {
  const { fileBytes } = await spark.transcodeSpz({ inputs: [{ fileBytes: plyOf(ids), fileType: "ply" }], maxSh: MAX_SH, fractionalBits: 12 });
  if (fileBytes.length > MAX_BYTES && ids.length > 1) {         // too big for the host: split in two
    const mid = ids.length >> 1;
    await emit(ids.slice(0, mid), tier, k); await emit(ids.slice(mid), tier, k);
    return;
  }
  const file = `scan-${chunks.length}.wasm`;
  writeFileSync(join(OUT, file), fileBytes);
  const [layer, cls] = LAYERS[k], hz = cls === 1, out = cls === 2;
  chunks.push({ file, tier, layer, haze: hz, outside: out, count: ids.length, bytes: fileBytes.length, sha256: createHash("sha256").update(fileBytes).digest("hex") });
  console.log(`  ${file}: tier ${tier} ${layer}${hz ? " haze" : out ? " outside" : ""} ${ids.length.toLocaleString()} splats, ${(fileBytes.length / 1e6).toFixed(2)} MB`);
};
for (let tier = 0; tier < 3; tier++) for (let k = 0; k < 6; k++) {
  const ids = order.filter((i) => tierOf[i] === tier && kind[i] === k);
  if (ids.length) await emit(ids, tier, k);
}
const total = chunks.reduce((a, c) => a + c.count, 0), bytes = chunks.reduce((a, c) => a + c.bytes, 0);
writeFileSync(join(OUT, "scan-hq.json"), JSON.stringify({
  splat_format: "spz", max_sh: MAX_SH, total, bytes, cut_y: CUT_Y,
  // three.js Matrix4.set order (row-major): raw scan frame → canonical Y-up frame of scene.json
  transform: T.flat(),
  dropped: { transparent: N - total, note: "opacity < 1/255 (never visible)" },
  chunks,
  source: { file: "data/raw/equipment_room.ply", splats: N, bytes: buf.length, sha256: rep.sha256 || rep.integrity?.sha256 || null },
}, null, 1));
console.log(`build-hq-scan: ${chunks.length} chunks, ${total.toLocaleString()} splats, ${(bytes / 1e6).toFixed(1)} MB (SH ${MAX_SH})`);
