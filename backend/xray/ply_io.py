"""Gaussian-splat PLY reading, integrity validation and .splat export."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814


@dataclass
class PlyHeader:
    vertex_count: int
    properties: list[str]
    header_bytes: int
    fmt: str

    @property
    def stride(self) -> int:
        return 4 * len(self.properties)


def read_header(path: Path) -> PlyHeader:
    with open(path, "rb") as fh:
        head = fh.read(16384)
    end = head.index(b"end_header\n") + len(b"end_header\n")
    lines = head[:end].decode("ascii").splitlines()
    count, props, fmt = 0, [], ""
    for ln in lines:
        parts = ln.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[:2] == ["element", "vertex"]:
            count = int(parts[2])
        elif parts[0] == "property":
            if parts[1] != "float":
                raise ValueError(f"Unsupported property type {parts[1]}")
            props.append(parts[2])
    if fmt != "binary_little_endian":
        raise ValueError(f"Unsupported PLY format {fmt}")
    return PlyHeader(count, props, end, fmt)


def load_raw(path: Path) -> tuple[PlyHeader, np.ndarray]:
    """Return header and an (N, P) float32 array of every *complete* record."""
    hdr = read_header(path)
    raw = np.fromfile(path, dtype=np.uint8, offset=hdr.header_bytes)
    n_complete = raw.size // hdr.stride
    arr = raw[: n_complete * hdr.stride].view("<f4").reshape(n_complete, len(hdr.properties))
    return hdr, arr


def plausible_mask(arr: np.ndarray, props: list[str]) -> np.ndarray:
    """Physically plausible Gaussian records (finite, bounded position/scale/opacity)."""
    idx = {p: i for i, p in enumerate(props)}
    with np.errstate(all="ignore"):
        ok = np.isfinite(arr).all(axis=1)
        xyz = arr[:, [idx["x"], idx["y"], idx["z"]]]
        sc = arr[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]]
        ok &= (np.abs(xyz) < 1e3).all(axis=1)
        ok &= (sc > -20).all(axis=1) & (sc < 5).all(axis=1)
        ok &= np.abs(arr[:, idx["opacity"]]) < 50
        rot = arr[:, [idx["rot_0"], idx["rot_1"], idx["rot_2"], idx["rot_3"]]]
        qn = np.linalg.norm(rot, axis=1)
        ok &= (qn > 1e-6) & (qn < 1e3)
        dc = arr[:, [idx["f_dc_0"], idx["f_dc_1"], idx["f_dc_2"]]]
        ok &= (np.abs(dc) < 50).all(axis=1)
    return ok


def integrity_report(path: Path) -> tuple[dict, np.ndarray, PlyHeader]:
    """Full-file validation. Returns (report, contiguous-valid records, header)."""
    hdr, arr = load_raw(path)
    size = path.stat().st_size
    expected = hdr.header_bytes + hdr.vertex_count * hdr.stride
    ok = plausible_mask(arr, hdr.properties)
    first_bad = int(np.argmax(~ok)) if (~ok).any() else len(ok)
    tail = ok[first_bad:]
    blocks = []
    step = 100_000
    for s in range(0, len(ok), step):
        blocks.append({"start": s, "end": min(s + step, len(ok)), "plausible_fraction": round(float(ok[s:s + step].mean()), 4)})
    sha = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 24), b""):
            sha.update(chunk)
    valid = arr[:first_bad].copy()
    idx = {p: i for i, p in enumerate(hdr.properties)}
    xyz = valid[:, [idx["x"], idx["y"], idx["z"]]]
    report = {
        "file": path.name,
        "sha256": sha.hexdigest(),
        "file_bytes": size,
        "header_bytes": hdr.header_bytes,
        "declared_vertex_count": hdr.vertex_count,
        "properties": len(hdr.properties),
        "record_stride_bytes": hdr.stride,
        "expected_file_bytes": expected,
        "size_matches_header": size == expected,
        "complete_records": int(len(arr)),
        "plausible_records_total": int(ok.sum()),
        "first_implausible_record": first_bad,
        "contiguous_valid_records": first_bad,
        "contiguous_valid_fraction": round(first_bad / hdr.vertex_count, 4),
        "tail_records": int(len(tail)),
        "tail_plausible_fraction": round(float(tail.mean()) if len(tail) else 1.0, 4),
        "tail_interpretation": (
            "Records after the first invalid record are statistically random bytes (only a tiny fraction pass "
            "plausibility checks by chance, consistent with noise). They are excluded, not repaired."
            if len(tail) and tail.mean() < 0.05 else "n/a"
        ),
        "valid_bounds_min": np.round(xyz.min(0), 3).tolist() if len(xyz) else None,
        "valid_bounds_max": np.round(xyz.max(0), 3).tolist() if len(xyz) else None,
        "valid_bounds_p0.5": np.round(np.percentile(xyz, 0.5, axis=0), 3).tolist() if len(xyz) else None,
        "valid_bounds_p99.5": np.round(np.percentile(xyz, 99.5, axis=0), 3).tolist() if len(xyz) else None,
        "blocks": blocks,
    }
    return report, valid, hdr


def write_report_md(report: dict, out: Path, extra: dict | None = None) -> None:
    extra = extra or {}
    lines = [
        f"# Scan integrity report — {report['file']}",
        "",
        f"* SHA-256: `{report['sha256']}`",
        f"* File size: {report['file_bytes']:,} bytes (header {report['header_bytes']} B, "
        f"{report['properties']} float properties = {report['record_stride_bytes']} B/record)",
        f"* Declared splats: {report['declared_vertex_count']:,}; size matches header: **{report['size_matches_header']}**",
        f"* First invalid record: **#{report['first_implausible_record']:,}**",
        f"* Usable contiguous splats: **{report['contiguous_valid_records']:,} "
        f"({report['contiguous_valid_fraction']*100:.1f}% of declared)**",
        f"* Remaining {report['tail_records']:,} records: plausible fraction "
        f"{report['tail_plausible_fraction']*100:.2f}% → {report['tail_interpretation']}",
        "",
        "## Plausibility by block of 100k records",
        "",
        "| records | plausible |",
        "|---|---|",
    ]
    for b in report["blocks"]:
        lines.append(f"| {b['start']:,}–{b['end']:,} | {b['plausible_fraction']*100:.1f}% |")
    if extra:
        lines += ["", "## Cross-checks", ""]
        for k, v in extra.items():
            lines.append(f"* {k}: {v}")
    lines += [
        "",
        "## Consequence for the demo",
        "",
        "Only the contiguous valid prefix is used. The pipeline never treats it as the complete room: the "
        "UI and API label the scene as a *partial scan*, and every stage (segmentation, navigation, mapping) "
        "re-runs unchanged when a repaired PLY is dropped into `data/raw/`.",
    ]
    out.write_text("\n".join(lines) + "\n")


def export_splat(path: Path, xyz: np.ndarray, scales_log: np.ndarray, quat_wxyz: np.ndarray,
                 f_dc: np.ndarray, opacity_logit: np.ndarray) -> None:
    """antimatter15 .splat format (32 B/splat), sorted by importance (size*opacity)."""
    n = len(xyz)
    sc = np.exp(scales_log).astype(np.float32)
    op = 1.0 / (1.0 + np.exp(-opacity_logit))
    order = np.argsort(-(sc.prod(axis=1) * op))
    rgb = np.clip((0.5 + SH_C0 * f_dc) * 255, 0, 255)
    rgba = np.concatenate([rgb, (op * 255)[:, None]], axis=1).astype(np.uint8)
    q = quat_wxyz / np.linalg.norm(quat_wxyz, axis=1, keepdims=True)
    qb = np.clip(q * 128 + 128, 0, 255).astype(np.uint8)
    rec = np.zeros(n, dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
    rec["p"] = xyz[order]
    rec["s"] = sc[order]
    rec["c"] = rgba[order]
    rec["r"] = qb[order]
    rec.tofile(path)


def report_json(report: dict, out: Path) -> None:
    out.write_text(json.dumps(report, indent=2))
