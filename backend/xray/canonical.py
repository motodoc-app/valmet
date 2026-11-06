"""Establish a canonical metric-like scene frame.

Output frame (matches three.js): +Y up, floor plane at y = 0, dominant walls aligned to X/Z.
All later stages (segmentation, navigation, web viewer) share this frame.
"""
from __future__ import annotations

import numpy as np

from . import config


def _rot_to_quat(R: np.ndarray) -> np.ndarray:
    """3x3 rotation -> quaternion (w, x, y, z)."""
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(R)))
        if i == 0:
            s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
            w = (R[2, 1] - R[1, 2]) / s; x = 0.25 * s
            y = (R[0, 1] + R[1, 0]) / s; z = (R[0, 2] + R[2, 0]) / s
        elif i == 1:
            s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
            w = (R[0, 2] - R[2, 0]) / s; x = (R[0, 1] + R[1, 0]) / s
            y = 0.25 * s; z = (R[1, 2] + R[2, 1]) / s
        else:
            s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
            w = (R[1, 0] - R[0, 1]) / s; x = (R[0, 2] + R[2, 0]) / s
            y = (R[1, 2] + R[2, 1]) / s; z = 0.25 * s
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """a ⊗ b for a (4,) and b (N,4), wxyz."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ], axis=1)


def _rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def ransac_plane(pts: np.ndarray, iters: int = 400, thresh: float = 0.02,
                 normal_hint: np.ndarray | None = None, max_angle_deg: float = 20,
                 rng: np.random.Generator | None = None) -> tuple[np.ndarray, float, np.ndarray]:
    """Return (normal, d, inlier_mask) for plane n·p + d = 0."""
    rng = rng or np.random.default_rng(0)
    best = (None, 0.0, np.zeros(len(pts), bool))
    cos_lim = np.cos(np.radians(max_angle_deg))
    for _ in range(iters):
        s = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n /= nn
        if normal_hint is not None:
            if abs(n @ normal_hint) < cos_lim:
                continue
            if n @ normal_hint < 0:
                n = -n
        d = -n @ s[0]
        inl = np.abs(pts @ n + d) < thresh
        if inl.sum() > best[2].sum():
            best = (n, d, inl)
    n, d, inl = best
    if n is None:
        raise RuntimeError("RANSAC failed to find a plane")
    # least-squares refine on inliers
    P = pts[inl]
    c = P.mean(0)
    _, _, vt = np.linalg.svd(P - c, full_matrices=False)
    n2 = vt[-1]
    if normal_hint is not None and n2 @ normal_hint < 0:
        n2 = -n2
    d2 = -n2 @ c
    return n2, d2, np.abs(pts @ n2 + d2) < thresh


def canonicalize(arr: np.ndarray, props: list[str]) -> dict:
    idx = {p: i for i, p in enumerate(props)}
    xyz = arr[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float64)
    quat = arr[:, [idx["rot_0"], idx["rot_1"], idx["rot_2"], idx["rot_3"]]].astype(np.float64)
    scale_log = arr[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]]
    f_dc = arr[:, [idx["f_dc_0"], idx["f_dc_1"], idx["f_dc_2"]]]
    op_logit = arr[:, idx["opacity"]]
    opacity = 1 / (1 + np.exp(-op_logit))
    smax = np.exp(scale_log).max(axis=1)
    geom = (opacity >= config.GEOM_MIN_OPACITY) & (smax <= config.GEOM_MAX_SCALE)

    # 1) Coarse: COLMAP/3DGS convention is y-down -> flip to y-up (rotate 180° about X).
    R0 = np.diag([1.0, -1.0, -1.0])
    p = xyz @ R0.T
    g = p[geom]
    lo, hi = np.percentile(g, 1, axis=0), np.percentile(g, 99, axis=0)
    inside = (g >= lo).all(1) & (g <= hi).all(1)
    g = g[inside]

    # 2) Floor = dominant near-horizontal plane in the lowest 25 % of the height range.
    ylow = np.percentile(g[:, 1], 25)
    cand = g[g[:, 1] <= ylow]
    rng = np.random.default_rng(42)
    sub = cand[rng.choice(len(cand), min(60000, len(cand)), replace=False)]
    n, d, _ = ransac_plane(sub, normal_hint=np.array([0, 1.0, 0]), thresh=0.025, rng=rng)
    R1 = _rotation_between(n, np.array([0, 1.0, 0]))
    p1 = p @ R1.T
    floor_y = float(np.median((sub @ R1.T)[np.abs(sub @ n + d) < 0.025][:, 1]))

    # 3) Yaw: choose rotation about Y that makes wall/pipe structure axis-aligned
    #    (maximises histogram sharpness of X and Z coordinates).
    gg = (g @ R1.T)
    band = gg[(gg[:, 1] > floor_y + 0.3) & (gg[:, 1] < floor_y + 2.0)]
    band = band[rng.choice(len(band), min(150000, len(band)), replace=False)]
    best_a, best_s = 0.0, -1.0
    for a in np.radians(np.arange(0, 90, 0.5)):
        c, s = np.cos(a), np.sin(a)
        x = band[:, 0] * c + band[:, 2] * s
        z = -band[:, 0] * s + band[:, 2] * c
        hx, _ = np.histogram(x, bins=400)
        hz, _ = np.histogram(z, bins=400)
        sharp = float((hx.astype(float) ** 2).sum() + (hz.astype(float) ** 2).sum())
        if sharp > best_s:
            best_s, best_a = sharp, a
    c, s = np.cos(best_a), np.sin(best_a)
    R2 = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])

    R = R2 @ R1 @ R0
    p_final = xyz @ R.T
    t = np.array([0.0, -floor_y, 0.0])
    gfin = p_final[geom] + t
    # centre the scene horizontally on its robust bounding box
    cx = float(np.median(gfin[:, 0])); cz = float(np.median(gfin[:, 2]))
    t += np.array([-cx, 0.0, -cz])
    p_final = p_final + t
    qR = _rot_to_quat(R)
    q_final = quat_mul(qR, quat / np.linalg.norm(quat, axis=1, keepdims=True))

    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = t
    gp = p_final[geom]
    return {
        "xyz": p_final.astype(np.float32),
        "quat": q_final.astype(np.float32),
        "scale_log": scale_log.astype(np.float32),
        "f_dc": f_dc.astype(np.float32),
        "op_logit": op_logit.astype(np.float32),
        "opacity": opacity.astype(np.float32),
        "geom_mask": geom,
        "transform": T,
        "yaw_deg": float(np.degrees(best_a)),
        "floor_normal_raw": n.tolist(),
        "bounds_geom_p1": np.percentile(gp, 1, axis=0).tolist(),
        "bounds_geom_p99": np.percentile(gp, 99, axis=0).tolist(),
    }
