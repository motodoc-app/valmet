// Build check: every file the app will fetch must exist, and every scan chunk must match its declared byte size
// (and checksum). Fails the build (exit 1) with a clear list instead of shipping a page that cannot load.
// Usage: node scripts/check-manifest.mjs [rootDir]   (default: public; pass dist to check a build output)
import { readFileSync, existsSync, statSync } from "node:fs";
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
