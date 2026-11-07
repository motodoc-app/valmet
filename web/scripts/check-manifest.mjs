// Build check: every file the app will fetch must exist, and every scan chunk must match its declared byte size
// (and checksum). Fails the build (exit 1) with a clear list instead of shipping a page that cannot load.
// Usage: node scripts/check-manifest.mjs [rootDir]   (default: public; pass dist to check a build output)
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, process.argv[2] || "public");
const problems = [];
const need = (rel, why) => { if (!existsSync(join(ROOT, rel))) problems.push(`missing ${rel} (${why})`); };

const scanPath = join(ROOT, "static/scan.json");
if (!existsSync(scanPath)) problems.push("missing static/scan.json (run `node scripts/scan-chunks.mjs`)");
else {
  const m = JSON.parse(readFileSync(scanPath, "utf8"));
  let total = 0;
  for (const c of m.chunks || []) {
    const p = join(ROOT, "static", c.file);
    total += c.count;
    if (!existsSync(p)) { problems.push(`missing static/${c.file} (listed in scan.json)`); continue; }
    const size = statSync(p).size;
    if (size !== c.bytes) problems.push(`static/${c.file}: ${size} bytes on disk, scan.json declares ${c.bytes}`);
    if (c.bytes !== c.count * 17) problems.push(`static/${c.file}: ${c.bytes} bytes cannot hold ${c.count} splats at 17 B each`);
    if (c.sha256 && size === c.bytes && createHash("sha256").update(readFileSync(p)).digest("hex") !== c.sha256) problems.push(`static/${c.file}: checksum mismatch`);
  }
  if (total !== m.total) problems.push(`scan.json: chunk counts sum to ${total}, total says ${m.total}`);
}
// full-fidelity SPZ scan (optional: the app falls back to the classic chunks without it; see build-hq-scan.mjs)
const hqPath = join(ROOT, "static/hq/scan-hq.json");
if (existsSync(hqPath)) {
  const m = JSON.parse(readFileSync(hqPath, "utf8"));
  let total = 0;
  if (m.splat_format !== "spz") problems.push("static/hq/scan-hq.json: splat_format must be spz");
  if (m.transform?.length !== 16) problems.push("static/hq/scan-hq.json: transform must be a 4×4 matrix");
  for (const c of m.chunks || []) {
    const p = join(ROOT, "static/hq", c.file);
    total += c.count;
    if (!existsSync(p)) { problems.push(`missing static/hq/${c.file} (listed in scan-hq.json)`); continue; }
    const b = readFileSync(p);
    if (b.length !== c.bytes) problems.push(`static/hq/${c.file}: ${b.length} bytes on disk, scan-hq.json declares ${c.bytes}`);
    else if (createHash("sha256").update(b).digest("hex") !== c.sha256) problems.push(`static/hq/${c.file}: checksum mismatch`);
    if (b[0] !== 0x1f || b[1] !== 0x8b) problems.push(`static/hq/${c.file}: not a gzip SPZ file`);
    if (!["low", "high"].includes(c.layer) || ![0, 1, 2].includes(c.tier)) problems.push(`static/hq/${c.file}: bad layer/tier`);
  }
  if (!m.chunks?.some((c) => c.tier === 0)) problems.push("static/hq/scan-hq.json: no tier-0 chunk (phones would load nothing)");
  if (total !== m.total) problems.push(`scan-hq.json: chunk counts sum to ${total}, total says ${m.total}`);
}
// static hosting limit: no single file above 15 MB
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
for (const sub of ["static", "data"]) if (existsSync(join(ROOT, sub))) for (const p of walk(join(ROOT, sub))) {
  const s = statSync(p).size;
  if (s > 15e6 && !p.endsWith("scene.splat")) problems.push(`${p.slice(ROOT.length + 1)}: ${(s / 1e6).toFixed(1)} MB exceeds the 15 MB hosting limit`);
}
// hosted-mode data
for (const f of ["scene.json", "grid.json", "goals.json", "assets.json", "corpus.json", "answers.json", "xray.json", "manifest.json"]) need(`static/${f}`, "hosted mode data");
if (existsSync(join(ROOT, "static/assets.json"))) {
  for (const a of JSON.parse(readFileSync(join(ROOT, "static/assets.json"), "utf8"))) need(`static/diag/${a.asset_id}.json`, `diagnosis for ${a.tag}`);
}
need("data/scene.splat", "fallback scan when chunks are unavailable");

if (problems.length) {
  console.error(`check-manifest: ${problems.length} problem(s) in ${ROOT}:\n  - ` + problems.join("\n  - "));
  process.exit(1);
}
console.log(`check-manifest: OK (${ROOT})`);
