#!/usr/bin/env bash
# Source-only ZIP for the hackathon submission form (limit 100 MB, no datasets or dependencies).
# Includes: code, tests, docs, config and the web app's own data (the full-fidelity scan chunks in
# web/public/static/hq and the classic fallback web/public/data/scene.splat), so the static demo builds and runs
# after `cd web && npm ci && npm run build && npx vite preview`.
# Excludes: raw challenge files (data/raw: PLY + workbook), derived pipeline datasets (data/processed), QA-only
# splats, node_modules, build output and agent worktrees. Run from the repository root.
set -euo pipefail
out="${1:-industrial-xray-source.zip}"
rm -f "$out"
git ls-files -z \
  | grep -zv -E '^(data/raw/[^R]|data/processed/|web/public/data/qa\.splat|\.claude/)' \
  | xargs -0 zip -q -9 "$out"
ls -l "$out" | awk '{printf "%s  %.1f MB\n", $9, $5/1e6}'
unzip -l "$out" | tail -1
