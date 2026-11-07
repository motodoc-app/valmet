"""Step 1: validate the PLY, build the canonical frame, export web splat + geometry cache."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from xray import config, ply_io  # noqa: E402
from xray.canonical import canonicalize  # noqa: E402
from xray.render import topdown  # noqa: E402


def main() -> None:
    out = config.DATA_OUT
    out.mkdir(parents=True, exist_ok=True)
    config.WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    print(f"[1/4] validating {config.PLY_PATH}")
    report, valid, hdr = ply_io.integrity_report(config.PLY_PATH)
    print(json.dumps({k: v for k, v in report.items() if k != "blocks"}, indent=1))

    print("[2/4] canonical frame")
    can = canonicalize(valid, hdr.properties)
    print("yaw", can["yaw_deg"], "bounds p1", can["bounds_geom_p1"], "p99", can["bounds_geom_p99"])
    report["canonical_transform"] = can["transform"].tolist()
    report["canonical_yaw_deg"] = can["yaw_deg"]
    report["canonical_bounds_p1"] = can["bounds_geom_p1"]
    report["canonical_bounds_p99"] = can["bounds_geom_p99"]
    span = np.array(can["bounds_geom_p99"]) - np.array(can["bounds_geom_p1"])
    report["scale_note"] = (
        f"Valid region spans ≈{span[0]:.1f} × {span[1]:.1f} × {span[2]:.1f} units (W×H×D). Ceiling height and the "
        "standard-size door in the scan are consistent with 1 unit ≈ 1 metre; scale is therefore treated as "
        "approximately metric (not surveyed)."
    )
    ply_io.report_json(report, out / "integrity_report.json")
    ply_io.write_report_md(report, out / "integrity_report.md", {
        "Same SHA-256 for direct .ply, the 2-part RAR extraction and the ZIP copy": "see README (verified 2026-11-06)",
        "Canonical frame": "Y up, floor at y=0, walls axis-aligned (yaw "
                           f"{can['yaw_deg']:.1f}°)",
        "Scale": report["scale_note"],
    })

    print("[3/4] exporting web splat (.splat, 32 B/splat)")
    # near-invisible or huge floater splats cost fill-rate but add nothing visible
    keep = (can["opacity"] > 0.06) & (np.exp(can["scale_log"]).max(1) < 0.5)
    ply_io.export_splat(config.WEB_PUBLIC / "scene.splat", can["xyz"][keep], can["scale_log"][keep],
                        can["quat"][keep], can["f_dc"][keep], can["op_logit"][keep])

    print("[4/4] geometry cache")
    g = can["geom_mask"]
    rgb = np.clip(0.5 + ply_io.SH_C0 * can["f_dc"], 0, 1)
    np.savez_compressed(out / "geometry.npz", xyz=can["xyz"][g], rgb=rgb[g].astype(np.float32),
                        size=np.exp(can["scale_log"][g]).max(1).astype(np.float32),
                        opacity=can["opacity"][g])
    r = can["opacity"] > 0.05
    np.savez_compressed(out / "render_cache.npz", xyz=can["xyz"][r], rgb=rgb[r].astype(np.float32),
                        size=np.exp(can["scale_log"][r]).max(1).astype(np.float32), opacity=can["opacity"][r])
    lo = np.array(can["bounds_geom_p1"]); hi = np.array(can["bounds_geom_p99"])
    img, _ = topdown(can["xyz"][g], rgb[g], ((lo[0] - .3, lo[2] - .3), (hi[0] + .3, hi[2] + .3)), res=0.015,
                     ymin=0.05, ymax=2.2)
    img.save(out / "qa_topdown.png")
    print("done:", len(can["xyz"]), "splats;", int(g.sum()), "geometry splats")


if __name__ == "__main__":
    main()
