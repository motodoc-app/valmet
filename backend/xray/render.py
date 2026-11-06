"""Tiny CPU point renderer used for QA images and for VLM crops of extracted objects."""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw


def topdown(xyz: np.ndarray, rgb: np.ndarray, bounds: tuple, res: float = 0.02,
            ymin: float = -1e9, ymax: float = 1e9) -> tuple[Image.Image, dict]:
    (x0, z0), (x1, z1) = bounds
    m = (xyz[:, 1] > ymin) & (xyz[:, 1] < ymax)
    p, c = xyz[m], rgb[m]
    W = int((x1 - x0) / res) + 1
    H = int((z1 - z0) / res) + 1
    u = ((p[:, 0] - x0) / res).astype(int)
    v = ((p[:, 2] - z0) / res).astype(int)
    k = (u >= 0) & (u < W) & (v >= 0) & (v < H)
    # painter: keep highest point per pixel
    order = np.argsort(p[k, 1])
    img = np.zeros((H, W, 3), np.uint8)
    img[v[k][order], u[k][order]] = (c[k][order] * 255).astype(np.uint8)
    return Image.fromarray(img), {"x0": x0, "z0": z0, "res": res, "W": W, "H": H}


def perspective(xyz: np.ndarray, rgb: np.ndarray, size: np.ndarray, eye: np.ndarray, target: np.ndarray,
                fov_deg: float = 55, W: int = 512, H: int = 512, bg=(18, 20, 24),
                highlight: np.ndarray | None = None) -> Image.Image:
    """Z-buffered splat-as-disc render (good enough for recognisable object crops)."""
    fwd = target - eye; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]);
    if np.linalg.norm(right) < 1e-6:
        right = np.array([1.0, 0, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    rel = xyz - eye
    zc = rel @ fwd
    xc = rel @ right
    yc = rel @ up
    f = (H / 2) / np.tan(np.radians(fov_deg) / 2)
    m = zc > 0.35
    u = (W / 2 + f * xc[m] / zc[m])
    v = (H / 2 - f * yc[m] / zc[m])
    r = np.clip(1.4 * f * size[m] / zc[m], 1, 5).astype(int)
    col = (rgb[m] * 255).astype(np.uint8)
    if highlight is not None:
        hl = highlight[m]
    z = zc[m]
    order = np.argsort(-z)  # far to near
    img = np.zeros((H, W, 3), np.uint8); img[:] = bg
    ui, vi = u.astype(int), v.astype(int)
    # z-buffer with square footprints of per-splat radius (far-to-near painter + depth test)
    zbuf = np.full((H, W), np.inf, np.float32)
    zs = z[order]; us = ui[order]; vs = vi[order]; rs = r[order]; cs = col[order]
    for rr in range(1, int(rs.max()) + 1 if len(rs) else 1):
        sel = rs >= rr
        if not sel.any():
            break
        for dx in (-(rr - 1), rr - 1) if rr > 1 else (0,):
            for dy in range(-(rr - 1), rr):
                for (ox, oy) in ((dx, dy), (dy, dx)):
                    uu, vv = us[sel] + ox, vs[sel] + oy
                    k = (uu >= 0) & (uu < W) & (vv >= 0) & (vv < H)
                    uu, vv, zz, cc = uu[k], vv[k], zs[sel][k], cs[sel][k]
                    closer = zz < zbuf[vv, uu]
                    zbuf[vv[closer], uu[closer]] = zz[closer]
                    img[vv[closer], uu[closer]] = cc[closer]
    out = Image.fromarray(img)
    return out


def draw_boxes_topdown(img: Image.Image, meta: dict, boxes: list[dict], color=(255, 200, 0)) -> Image.Image:
    d = ImageDraw.Draw(img)
    for b in boxes:
        c = np.array(b["center"]); s = np.array(b["size"]); yaw = b.get("yaw", 0.0)
        hx, hz = s[0] / 2, s[2] / 2
        corners = np.array([[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]])
        cs, sn = np.cos(yaw), np.sin(yaw)
        rot = corners @ np.array([[cs, -sn], [sn, cs]]).T
        pts = [((c[0] + px - meta["x0"]) / meta["res"], (c[2] + pz - meta["z0"]) / meta["res"]) for px, pz in rot]
        d.polygon(pts, outline=b.get("color", color))
    return img
