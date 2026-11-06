"""Semantic 3D extraction from Gaussian splat centres.

Pipeline (all unsupervised, deterministic):
  1. structural planes  – floor, ceiling and walls by constrained RANSAC
  2. object candidates  – voxel down-sampling + DBSCAN on non-structural splats
  3. recursive refinement – over-sized clusters are re-clustered with tighter radius and
                            colour-aware features (splits pipes from the devices they feed)
  4. oriented 3D frames – PCA-yaw oriented bounding boxes around each object (gravity-aligned)
  5. geometric descriptors + heuristic class proposal (later refined by VLM, see vlm_labeler.py)
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree
from sklearn.cluster import DBSCAN

from .canonical import ransac_plane


@dataclass
class SceneObject:
    id: str
    kind: str                      # "structure" | "object"
    label: str
    label_source: str              # "geometry-heuristic" | "vlm" | "plane-fit"
    confidence: float
    center: list[float]
    size: list[float]              # extents along local x, y(up), z
    yaw: float                     # rotation about +Y (radians)
    n_points: int
    color_rgb: list[float]
    descriptors: dict = field(default_factory=dict)
    alt_labels: list = field(default_factory=list)

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        return d


def voxel_downsample(p: np.ndarray, c: np.ndarray, voxel: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    key = np.floor(p / voxel).astype(np.int64)
    key -= key.min(0)
    dims = key.max(0) + 1
    lin = (key[:, 0] * dims[1] + key[:, 1]) * dims[2] + key[:, 2]
    uniq, inv, counts = np.unique(lin, return_inverse=True, return_counts=True)
    ps = np.zeros((len(uniq), 3)); cs = np.zeros((len(uniq), 3))
    np.add.at(ps, inv, p); np.add.at(cs, inv, c)
    return ps / counts[:, None], cs / counts[:, None], counts


def oriented_box(p: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Gravity-aligned OBB: yaw from 2-D PCA of the XZ footprint, robust (2–98 %) extents."""
    xz = p[:, [0, 2]]
    c2 = xz.mean(0)
    if len(p) >= 5:
        cov = np.cov((xz - c2).T)
        w, v = np.linalg.eigh(cov)
        major = v[:, np.argmax(w)]
        yaw = float(np.arctan2(major[1], major[0]))
    else:
        yaw = 0.0
    # snap near-axis-aligned boxes to the wall grid (scene is yaw-aligned)
    for snap in (0.0, np.pi / 2, -np.pi / 2, np.pi, -np.pi):
        if abs(yaw - snap) < np.radians(12):
            yaw = snap
    cs, sn = np.cos(yaw), np.sin(yaw)
    R = np.array([[cs, sn], [-sn, cs]])          # world->local
    loc = (xz - c2) @ R.T
    lo2, hi2 = np.percentile(loc, 2, axis=0), np.percentile(loc, 98, axis=0)
    ylo, yhi = np.percentile(p[:, 1], 2), np.percentile(p[:, 1], 98)
    mid_local = (lo2 + hi2) / 2
    mid_world = c2 + mid_local @ R           # local->world (R orthonormal)
    size = np.array([hi2[0] - lo2[0], yhi - ylo, hi2[1] - lo2[1]])
    size = np.maximum(size, 0.04)
    center = np.array([mid_world[0], (ylo + yhi) / 2, mid_world[1]])
    return center, size, yaw


def describe(p: np.ndarray, c: np.ndarray, size: np.ndarray) -> dict:
    s = np.sort(size)
    hsv_sat = float(np.mean(c.max(1) - c.min(1)))
    mean = c.mean(0)
    hue = "neutral"
    if hsv_sat > 0.12:
        r, g, b = mean
        if r >= g and r >= b:
            hue = "red/orange" if g < 0.75 * r else "yellow"
        elif g >= r and g >= b:
            hue = "green"
        else:
            hue = "blue"
    vol = float(size.prod())
    return {
        "elongation": float(s[2] / max(s[1], 1e-3)),
        "flatness": float(s[0] / max(s[1], 1e-3)),
        "height": float(size[1]),
        "max_extent": float(s[2]),
        "min_extent": float(s[0]),
        "volume_m3": vol,
        "density_pts_m3": float(len(p) / max(vol, 1e-4)),
        "bottom_y": float(np.percentile(p[:, 1], 2)),
        "top_y": float(np.percentile(p[:, 1], 98)),
        "saturation": hsv_sat,
        "dominant_hue": hue,
        "vertical": bool(size[1] >= max(size[0], size[2]) * 2.5),
    }


def heuristic_label(d: dict) -> tuple[str, float, list]:
    """Rule-based class proposal from geometry + colour. Returns (label, confidence, alternatives)."""
    e, h, mx, mn = d["elongation"], d["height"], d["max_extent"], d["min_extent"]
    floor_contact = d["bottom_y"] < 0.15
    ceiling_zone = d["bottom_y"] > 1.6
    hue = d["dominant_hue"]
    if e > 5 and mn < 0.25:
        if d["vertical"]:
            return "vertical pipe", 0.6, ["support column", "conduit"]
        return ("overhead pipe run" if ceiling_zone else "horizontal pipe"), 0.6, ["cable tray", "duct"]
    if hue == "red/orange" and h > 0.6 and mn > 0.3:
        return "expansion vessel / tank", 0.55, ["fire equipment", "boiler shell"]
    if hue == "blue" and h > 0.6 and mn > 0.3:
        return "storage tank", 0.5, ["pressure vessel", "filter housing"]
    if floor_contact and 0.25 < mx < 1.2 and h < 1.0 and mn > 0.15:
        return "pump / motor unit", 0.45, ["equipment skid", "crate"]
    if d["flatness"] < 0.35 and h > 0.5 and mx > 0.4 and not floor_contact:
        return "electrical cabinet / panel", 0.45, ["notice board", "wall panel"]
    if floor_contact and h > 1.2 and mn > 0.3:
        return "tall equipment / rack", 0.4, ["shelving", "cabinet"]
    if mx < 0.35 and not floor_contact:
        if hue == "red/orange":
            return "circulation pump", 0.4, ["valve actuator", "fire alarm"]
        if hue == "green":
            return "pipe label / tag", 0.35, ["valve handle"]
        return "valve / fitting", 0.4, ["gauge", "sensor", "junction box"]
    if floor_contact and mx < 0.6:
        return "floor item (box / bucket)", 0.35, ["small pump", "drain"]
    if ceiling_zone:
        return "ceiling fixture / duct", 0.35, ["light", "pipe bracket"]
    return "equipment (unclassified)", 0.25, []


def extract_structure(p: np.ndarray, rng: np.random.Generator) -> tuple[list[dict], np.ndarray]:
    """Floor, ceiling, walls. Returns plane descriptors and a mask of structural points."""
    struct = np.zeros(len(p), bool)
    planes = []
    # floor: frame already puts it at y = 0
    fl = np.abs(p[:, 1]) < 0.05
    struct |= fl
    planes.append({"label": "floor", "normal": [0, 1, 0], "offset": 0.0, "n_points": int(fl.sum())})
    # ceiling: highest dense horizontal plane
    top = p[p[:, 1] > np.percentile(p[:, 1], 90)]
    if len(top) > 500:
        try:
            n, d, _ = ransac_plane(top[rng.choice(len(top), min(30000, len(top)), replace=False)],
                                   normal_hint=np.array([0, 1.0, 0]), thresh=0.04, rng=rng)
            cy = float(-d / n[1])
            ce = np.abs(p[:, 1] - cy) < 0.05
            if ce.sum() > 1500:
                struct |= ce
                planes.append({"label": "ceiling", "normal": [0, -1, 0], "offset": cy, "n_points": int(ce.sum())})
        except RuntimeError:
            pass
    # walls: iterative vertical RANSAC with large-extent requirement
    rest = ~struct & (p[:, 1] > 0.1)
    failures = 0
    rejected = np.zeros(len(p), bool)
    for _ in range(14):
        idx = np.where(rest)[0]
        if len(idx) < 3000:
            break
        sub = idx[rng.choice(len(idx), min(40000, len(idx)), replace=False)]
        best = None
        for hint in (np.array([1.0, 0, 0]), np.array([0, 0, 1.0])):
            try:
                n, d, _ = ransac_plane(p[sub], normal_hint=hint, thresh=0.035, max_angle_deg=8, iters=300, rng=rng)
            except RuntimeError:
                continue
            inl = np.abs(p[idx] @ n + d) < 0.035
            if best is None or inl.sum() > best[2].sum():
                best = (n, d, inl)
        if best is None:
            break
        n, d, inl = best
        P = p[idx[inl]]
        tang = np.cross(n, [0, 1, 0]); tang /= np.linalg.norm(tang)
        t = P @ tang
        width = np.percentile(t, 98) - np.percentile(t, 2)
        height = np.percentile(P[:, 1], 98) - np.percentile(P[:, 1], 2)
        # a wall must be large, tall and densely supported
        near_existing = any(
            abs(np.dot(n, w["normal"])) > 0.97 and abs(abs(d) - abs(w["offset"])) < 0.4
            for w in planes if w["label"] == "wall")
        if near_existing or width < 1.0 or height < 1.0 or inl.sum() < 1200 or \
                (inl.sum() / max(width * height, 1e-3)) < 120:
            failures += 1
            if failures >= 4:
                break
            # make the rejected support unavailable for the next hypothesis but keep it as objects
            rest[idx[inl]] = False
            rejected[idx[inl]] = True
            continue
        struct[idx[inl]] = True
        rest[idx[inl]] = False
        planes.append({"label": "wall", "normal": np.round(n, 4).tolist(), "offset": float(d),
                       "n_points": int(inl.sum()), "width": float(width), "height": float(height),
                       "t_range": [float(np.percentile(t, 2)), float(np.percentile(t, 98))],
                       "y_range": [float(np.percentile(P[:, 1], 2)), float(np.percentile(P[:, 1], 98))]})
    return planes, struct


def cluster_objects(p: np.ndarray, c: np.ndarray, eps: float = 0.075, min_samples: int = 6,
                    max_extent: float = 1.6, depth: int = 0) -> list[np.ndarray]:
    """Recursive DBSCAN. Returns list of index arrays into p."""
    if len(p) < min_samples:
        return []
    feats = np.concatenate([p, c * (0.08 if depth > 0 else 0.0)], axis=1)
    lab = DBSCAN(eps=eps, min_samples=min_samples, n_jobs=-1).fit_predict(feats)
    out = []
    for k in range(lab.max() + 1):
        idx = np.where(lab == k)[0]
        if len(idx) < 12:
            continue
        ext = np.percentile(p[idx], 98, axis=0) - np.percentile(p[idx], 2, axis=0)
        srt = np.sort(ext)
        pipe_like = srt[2] / max(srt[1], 1e-3) > 6 and srt[1] < 0.3
        if srt[2] > max_extent and not pipe_like and depth < 3:
            subs = cluster_objects(p[idx], c[idx], eps=eps * 0.72, min_samples=min_samples,
                                   max_extent=max_extent, depth=depth + 1)
            if len(subs) <= 1 and depth >= 1:
                # still one blob: split spatially into compact chunks so frames stay meaningful
                k_parts = int(np.ceil(srt[2] / max_extent))
                axis = int(np.argmax(ext))
                q = np.quantile(p[idx, axis], np.linspace(0, 1, k_parts + 1))
                for a, b in zip(q[:-1], q[1:]):
                    part = idx[(p[idx, axis] >= a) & (p[idx, axis] <= b)]
                    if len(part) >= 12:
                        out.append(part)
            else:
                out.extend(idx[s] for s in subs)
        else:
            out.append(idx)
    return out


def extract(xyz: np.ndarray, rgb: np.ndarray, bounds_lo: np.ndarray, bounds_hi: np.ndarray,
            voxel: float = 0.03) -> dict:
    rng = np.random.default_rng(7)
    inside = (xyz >= bounds_lo).all(1) & (xyz <= bounds_hi).all(1)
    p0, c0 = xyz[inside], rgb[inside]
    p, c, cnt = voxel_downsample(p0, c0, voxel)
    # remove isolated voxels (floaters)
    tree = cKDTree(p)
    nn = tree.query_ball_point(p, r=voxel * 2.5, return_length=True)
    keep = nn >= 4
    p, c, cnt = p[keep], c[keep], cnt[keep]

    planes, struct = extract_structure(p, rng)
    obj_mask = ~struct & (p[:, 1] > 0.04)
    ceiling = next((pl["offset"] for pl in planes if pl["label"] == "ceiling"), None)
    if ceiling is not None:
        obj_mask &= p[:, 1] < ceiling - 0.04
    op, oc = p[obj_mask], c[obj_mask]
    clusters = cluster_objects(op, oc)

    clusters = merge_pipe_fragments(op, clusters)
    walls = [pl for pl in planes if pl["label"] == "wall"]

    objects: list[SceneObject] = []
    for pl in walls:
        n = np.array(pl["normal"]); tang = np.cross(n, [0, 1, 0]); tang /= np.linalg.norm(tang)
        tmid = sum(pl["t_range"]) / 2
        center = -pl["offset"] * n + tang * tmid
        center[1] = sum(pl["y_range"]) / 2
        yaw = float(np.arctan2(tang[2], tang[0]))
        size = [pl["width"], pl["height"], 0.08]
        objects.append(SceneObject(f"S-WALL-{len(objects)+1:02d}", "structure", "wall", "plane-fit", 0.9,
                                   np.round(center, 3).tolist(), size, yaw, pl["n_points"], [0.6, 0.6, 0.6]))
    kept_clusters = []
    rejected = {"too_small": 0, "wall_surface_detail": 0}
    cnt_obj = cnt[obj_mask]
    for idx in sorted(clusters, key=lambda ix: -len(ix)):
        pts, col = op[idx], oc[idx]
        center, size, yaw = oriented_box(pts)
        if size.max() < 0.08 or len(idx) < 18:
            rejected["too_small"] += 1
            continue
        if _is_wall_detail(pts, size, walls):
            rejected["wall_surface_detail"] += 1
            continue
        d = describe(pts, col, size)
        label, conf, alts = heuristic_label(d)
        kept_clusters.append(idx)
        objects.append(SceneObject(
            id=f"OBJ-{len(objects)+1:03d}", kind="object", label=label, label_source="geometry-heuristic",
            confidence=conf, center=np.round(center, 3).tolist(), size=np.round(size, 3).tolist(),
            yaw=round(yaw, 4), n_points=int(cnt_obj[idx].sum()),
            color_rgb=np.round(col.mean(0), 3).tolist(), descriptors=d, alt_labels=alts))
    obj_ids = [o.id for o in objects if o.kind == "object"]
    assign = -np.ones(len(op), int)
    for j, idx in enumerate(kept_clusters):
        assign[idx] = j
    return {"planes": planes, "objects": objects, "obj_points": op, "obj_colors": oc, "obj_assign": assign,
            "obj_ids": obj_ids, "struct_points": p[struct], "ceiling_y": ceiling, "rejected": rejected,
            "n_raw_clusters": len(clusters)}


def _is_wall_detail(pts: np.ndarray, size: np.ndarray, walls: list[dict]) -> bool:
    """Thin fragments lying within a few cm of a wall plane are wall texture, not assets."""
    if min(size[0], size[2]) > 0.07:
        return False
    for w in walls:
        n = np.array(w["normal"]); dist = np.abs(pts @ n + w["offset"])
        if np.median(dist) < 0.07:
            return True
    return False


def _pca_axis(p: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
    c = p.mean(0)
    _, sv, vt = np.linalg.svd(p - c, full_matrices=False)
    a = vt[0]
    t = (p - c) @ a
    return c, a, float(t.min()), float(t.max())


def merge_pipe_fragments(p: np.ndarray, clusters: list[np.ndarray]) -> list[np.ndarray]:
    """Union collinear, end-to-end pipe-like fragments (DBSCAN splits long pipes at gaps/occlusions)."""
    info = []
    for i, idx in enumerate(clusters):
        if len(idx) < 10:
            info.append(None); continue
        ext = np.sort(np.percentile(p[idx], 98, 0) - np.percentile(p[idx], 2, 0))
        if ext[2] / max(ext[1], 1e-3) < 3.5 or ext[1] > 0.3:
            info.append(None); continue
        info.append(_pca_axis(p[idx]))
    parent = list(range(len(clusters)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(len(clusters)):
        if info[i] is None:
            continue
        ci, ai, lo_i, hi_i = info[i]
        for j in range(i + 1, len(clusters)):
            if info[j] is None:
                continue
            cj, aj, lo_j, hi_j = info[j]
            if abs(ai @ aj) < 0.97:
                continue
            d = cj - ci
            perp = np.linalg.norm(d - (d @ ai) * ai)
            if perp > 0.08:
                continue
            tj = d @ ai  # centre of j along i's axis
            half_j = (hi_j - lo_j) / 2
            gap = max(lo_i - (tj + half_j), (tj - half_j) - hi_i, 0.0)
            if gap < 0.25:
                parent[find(j)] = find(i)
    groups: dict[int, list[np.ndarray]] = {}
    for i, idx in enumerate(clusters):
        groups.setdefault(find(i), []).append(idx)
    return [np.concatenate(g) for g in groups.values()]
