"""Export everything the web app needs to run without the Python server (for the hosted live demo).

The browser then: renders the scan, plans/validates routes with a JS port of navigation.py, and shows
diagnoses that were produced by the same backend (LLM narration generated here, at export time).
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from xray import config  # noqa: E402
from xray.copilot import LIBRARY  # noqa: E402
from xray.metadata import priority_score, telemetry_evidence  # noqa: E402
from xray.world import World  # noqa: E402

OUT = config.ROOT / "web" / "public" / "static"
CHUNK_BYTES = 15_000_000          # artifact hosting: ≤16 MB per file


def b64bits(m: np.ndarray) -> str:
    import base64
    return base64.b64encode(np.packbits(m.astype(np.uint8).ravel())).decode()


def main(with_llm: bool = True, scene_only: bool = False) -> None:
    """scene_only: re-export the scene, grid, approach goals and asset bindings after a review-layer change, keeping
    the pre-generated diagnoses, answers and corpus as they are (their object references are patched)."""
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "diag").mkdir(exist_ok=True)
    w = World()
    nav = w.nav
    scene = w.scene_payload()
    (OUT / "scene.json").write_text(json.dumps(scene))

    g = nav.grid
    import base64
    grid = {
        "x0": g.x0, "z0": g.z0, "res": g.res, "W": g.W, "H": g.H,
        "robot_radius": nav.robot_radius, "max_step": nav.max_step,
        "floor": b64bits(nav.floor), "occupied": b64bits(nav.occupied_raw),
        "height_mm": base64.b64encode(np.round(nav.height_filled * 1000).astype("<i2").tobytes()).decode(),
    }
    (OUT / "grid.json").write_text(json.dumps(grid))
    goals = {}
    for o in w.scene["objects"]:
        if o["kind"] == "object":
            c = nav.approach_cell(o)
            if c:
                goals[o["id"]] = list(c)
    (OUT / "goals.json").write_text(json.dumps(goals))

    assets = []
    for aid, a in w.assets_summary.items():
        tel = telemetry_evidence(w.pack, aid, a["asset_class"])
        assets.append({**a, "priority": priority_score(w.pack.asset(aid)),
                       "signals": [{k: s[k] for k in ("signal", "unit", "recent_mean", "peer_mean", "z_vs_peers")}
                                   for s in tel["signals"]]})
    (OUT / "assets.json").write_text(json.dumps(assets))

    if scene_only:
        for f in sorted((OUT / "diag").glob("ASSET-*.json")):
            d = json.loads(f.read_text())
            b = w.mapping["bindings"].get(f.stem)
            if b and d.get("binding") != b:
                d["binding"] = b
                f.write_text(json.dumps(d, default=str))
                print("diag binding updated", f.stem, b["object_id"])
        return

    config.USE_LLM = with_llm
    for aid in w.assets_summary:
        d = w.copilot.diagnose(aid)
        (OUT / "diag" / f"{aid}.json").write_text(json.dumps(d, default=str))
        print("diag", aid, d["narrative"]["mode"])

    # pre-answered component questions for EVERY device type (answered for that class's highest-priority asset),
    # so the hosted demo's X-Ray "Ask" works for any device, with the same citation checks as the live API
    from concurrent.futures import ThreadPoolExecutor
    by_class = {}
    for aid, a in sorted(w.assets_summary.items(), key=lambda kv: -priority_score(w.pack.asset(kv[0]))):
        by_class.setdefault(a["asset_class"], aid)
    jobs = [(cls, aid, c) for cls, aid in by_class.items() for c in LIBRARY["classes"].get(cls, {}).get("components", [])]

    def ask(job):
        cls, aid, c = job
        q = f"What does the {c['name'].lower()} do and what evidence suggests it may be faulty?"
        return f"{cls}#{c['id']}", w.copilot.answer(q, aid, c["id"])
    answers = {}
    with ThreadPoolExecutor(8) as ex:
        for k, v in ex.map(ask, jobs):
            answers[k] = v
    print("answers", len(answers))
    (OUT / "answers.json").write_text(json.dumps(answers, default=str))
    (OUT / "corpus.json").write_text(json.dumps(w.copilot.corpus.docs, default=str))
    (OUT / "xray.json").write_text(json.dumps(LIBRARY))

    # The streaming scan chunks (static/scan-*.wasm + static/scan.json) are generated from web/public/data/scene.splat
    # by the web build (web/scripts/scan-chunks.mjs, run automatically by `npm run dev` / `npm run build`).
    for old in OUT.glob("scene-*.wasm"):
        old.unlink()
    (OUT / "manifest.json").write_text(json.dumps({"llm": config.LLM_MODEL if with_llm else None,
                                                   "scan_manifest": "scan.json", "scan_fallback": "../data/scene.splat"}))



if __name__ == "__main__":
    main(with_llm="--no-llm" not in sys.argv, scene_only="--scene-only" in sys.argv)
