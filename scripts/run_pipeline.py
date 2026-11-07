"""One command from raw inputs to a running demo, for this room or any other.

    python scripts/run_pipeline.py                                  # uses config/project.json
    python scripts/run_pipeline.py --project config/my-site.json    # another site
    python scripts/run_pipeline.py --no-vlm --no-llm                # offline: geometry labels, template wording
    python scripts/run_pipeline.py --from 2                         # skip step 1 (scene already validated)

Steps (each one is also runnable on its own):
  1  scripts/step1_scene.py      validate the PLY, canonical frame, web splat + geometry cache
  2  scripts/step2_semantics.py  planes, objects, oriented frames, review annotations
  3  scripts/step3_vlm.py        vision-model labels for the objects (cached; skipped with --no-vlm)
  4  scripts/step2_semantics.py  re-run so the new labels are merged
  5  scripts/export_static.py    everything the hosted (serverless) demo needs, incl. LLM narration
  6  npm run build (web/)        scan chunks, manifest check, production bundle in web/dist
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(label: str, cmd: list[str], env: dict, cwd: Path = ROOT) -> None:
    print(f"\n=== {label}\n$ {' '.join(cmd)}", flush=True)
    t = time.time()
    r = subprocess.run(cmd, cwd=cwd, env=env)
    if r.returncode:
        sys.exit(f"step failed: {label} (exit {r.returncode})")
    print(f"--- {label}: {time.time() - t:.1f}s", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default="config/project.json", help="project file (site name, inputs, robot, LLM)")
    ap.add_argument("--from", dest="start", type=int, default=1, help="first step to run (1-6)")
    ap.add_argument("--no-vlm", action="store_true", help="skip vision-model labelling (geometry labels only)")
    ap.add_argument("--no-llm", action="store_true", help="template wording instead of LLM narration")
    ap.add_argument("--no-web", action="store_true", help="skip the web build")
    a = ap.parse_args()

    env = {**os.environ, "XRAY_PROJECT": str((ROOT / a.project).resolve() if not Path(a.project).is_absolute() else a.project)}
    if a.no_llm:
        env["XRAY_USE_LLM"] = "0"
    if not Path(env["XRAY_PROJECT"]).exists():
        sys.exit(f"project file not found: {env['XRAY_PROJECT']}")
    py = sys.executable
    steps = [
        (1, "1/6 scene: validate PLY, canonical frame, splat export", [py, "scripts/step1_scene.py"]),
        (2, "2/6 semantics: planes, objects, frames", [py, "scripts/step2_semantics.py"]),
        (3, "3/6 vision-model labels", [py, "scripts/step3_vlm.py"]),
        (4, "4/6 semantics again with the new labels", [py, "scripts/step2_semantics.py"]),
        (5, "5/6 static export for the hosted demo", [py, "scripts/export_static.py"] + (["--no-llm"] if a.no_llm else [])),
    ]
    for n, label, cmd in steps:
        if n < a.start or (a.no_vlm and n in (3, 4)):
            continue
        run(label, cmd, env)
    if not a.no_web and a.start <= 6:
        web = ROOT / "web"
        if not (web / "node_modules").exists():
            run("6/6 web: install", ["npm", "ci"], env, web)
        run("6/6 web: scan chunks, manifest check, build", ["npm", "run", "build"], env, web)
    print("\nDone. Serve it with:  cd backend && uvicorn xray.api:app --port 8000   → http://localhost:8000"
          "\n      or the serverless build:  cd web && npx vite preview")


if __name__ == "__main__":
    main()
