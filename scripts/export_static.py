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
from xray.copilot import KB_PUMP  # noqa: E402
from xray.metadata import priority_score, telemetry_evidence  # noqa: E402
from xray.world import World  # noqa: E402

OUT = config.ROOT / "web" / "public" / "static"
CHUNK_BYTES = 15_000_000          # artifact hosting: ≤16 MB per file


def b64bits(m: np.ndarray) -> str:
    import base64
    return base64.b64encode(np.packbits(m.astype(np.uint8).ravel())).decode()


def main(with_llm: bool = True) -> None:
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

    config.USE_LLM = with_llm
    for aid in w.assets_summary:
        d = w.copilot.diagnose(aid)
        (OUT / "diag" / f"{aid}.json").write_text(json.dumps(d, default=str))
        print("diag", aid, d["narrative"]["mode"])

    # pre-answered component questions for the target (shown with the same citation checks)
    tgt = w.mapping["target_asset_id"]
    answers = {}
    for c in KB_PUMP["components"]:
        q = f"What does the {c['name'].lower()} do and what evidence suggests it may be faulty?"
        answers[f"{c['id']}|{tgt}"] = w.copilot.answer(q, tgt, c["id"])
        print("answer", c["id"])
    (OUT / "answers.json").write_text(json.dumps(answers, default=str))
    (OUT / "corpus.json").write_text(json.dumps(w.copilot.corpus.docs, default=str))
    (OUT / "xray.json").write_text(json.dumps(KB_PUMP))

    # split the web splat into ≤15 MB chunks (records are 32 B)
    src = config.WEB_PUBLIC / "scene.splat"
    raw = np.fromfile(src, dtype=np.uint8)
    per = CHUNK_BYTES // 32 * 32
    names = []
    for i in range(0, len(raw), per):
        name = f"scene-{len(names)}.wasm"   # served as a binary type by the host; content is .splat records
        raw[i:i + per].tofile(OUT / name)
        names.append(name)
    (OUT / "manifest.json").write_text(json.dumps({"splat_chunks": names, "splat_format": "splat",
                                                   "llm": config.LLM_MODEL if with_llm else None}))
    print("chunks", names)


if __name__ == "__main__":
    main(with_llm="--no-llm" not in sys.argv)
