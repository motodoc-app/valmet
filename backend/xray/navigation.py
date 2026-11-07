"""Obstacle-aware navigation on a 2.5-D occupancy grid derived from the splat scan.

walkable = observed floor  ∧  ¬ inflate(obstacles, robot radius)
obstacles = splats between OBSTACLE_MIN_H and OBSTACLE_MAX_H above the floor ∪ wall planes ∪ object frames
Path = A* (8-connected) with a clearance-aware cost, then line-of-sight smoothing that never reduces
clearance below the robot radius. Every path is re-validated against the raw obstacle grid and the
3D object frames before it is returned.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from . import config


@dataclass
class Grid:
    x0: float
    z0: float
    res: float
    W: int
    H: int

    def to_cell(self, x: float, z: float) -> tuple[int, int]:
        return int((z - self.z0) / self.res), int((x - self.x0) / self.res)

    def to_world(self, r: float, c: float) -> tuple[float, float]:
        return self.x0 + (c + 0.5) * self.res, self.z0 + (r + 0.5) * self.res


class NavMap:
    def __init__(self, scene_pts: np.ndarray, objects: list[dict],
                 bounds_min: np.ndarray, bounds_max: np.ndarray, res: float = config.NAV_CELL,
                 robot_radius: float = config.ROBOT_RADIUS, max_step: float = config.ROBOT_MAX_STEP):
        """scene_pts: splat centres (opacity-filtered) in the canonical frame."""
        self.res = res
        self.robot_radius = robot_radius
        self.max_step = max_step
        self.grid = Grid(float(bounds_min[0]), float(bounds_min[2]), res,
                         int(math.ceil((bounds_max[0] - bounds_min[0]) / res)),
                         int(math.ceil((bounds_max[2] - bounds_min[2]) / res)))
        self.height, floor = self._floor_heightfield(scene_pts)
        # obstacles relative to the *local* floor height (2.5-D: supports several floor levels)
        hf = self._fill_nearest(self.height, floor)
        g = self.grid
        r = ((scene_pts[:, 2] - g.z0) / g.res).astype(int)
        c = ((scene_pts[:, 0] - g.x0) / g.res).astype(int)
        k = (r >= 0) & (r < g.H) & (c >= 0) & (c < g.W)
        rel = scene_pts[k, 1] - hf[r[k], c[k]]
        band = (rel > config.OBSTACLE_MIN_H) & (rel < config.OBSTACLE_MAX_H)
        cnt = np.zeros((g.H, g.W), np.int32)
        np.add.at(cnt, (r[k][band], c[k][band]), 1)
        occ = ndimage.binary_closing(cnt >= 4, iterations=1)
        self.object_occ = np.zeros_like(occ)
        for o in objects:
            if o["kind"] == "structure":
                continue  # walls are already in the point evidence; keeps door openings open
            fp = np.zeros((g.H, g.W), bool)
            self._rasterise_box(o, fp, pad=0.1)
            if not fp.any():
                continue
            # dominant floor level under the footprint (robust to box-top spikes in the heightfield)
            local = float(np.median(hf[fp]))
            bottom = o["center"][1] - o["size"][1] / 2 - local
            top = o["center"][1] + o["size"][1] / 2 - local
            if bottom < config.OBSTACLE_MAX_H and top > config.OBSTACLE_MIN_H:
                self._rasterise_box(o, self.object_occ)
        self.occupied_raw = occ | self.object_occ
        self.floor = floor
        self.height_filled = hf
        self.levels = self._levels()
        self.blocked = np.zeros_like(occ)          # dynamic, user-introduced blockages
        self.cleared = np.zeros_like(occ)          # planning: footprints of equipment moved away (free floor again)
        self.rebuild()

    def _floor_heightfield(self, pts: np.ndarray, coarse: float = 0.1) -> tuple[np.ndarray, np.ndarray]:
        """Per-cell floor height = lowest densely supported thin slab (handles multiple levels/steps).

        Estimated on a coarser grid (robust to sparse splats) and resampled to the nav grid.
        """
        g = self.grid
        f = int(round(coarse / g.res))
        Hc, Wc = int(math.ceil(g.H / f)), int(math.ceil(g.W / f))
        m = (pts[:, 1] > -0.35) & (pts[:, 1] < 1.2)
        p = pts[m]
        r = ((p[:, 2] - g.z0) / coarse).astype(int)
        c = ((p[:, 0] - g.x0) / coarse).astype(int)
        k = (r >= 0) & (r < Hc) & (c >= 0) & (c < Wc)
        p, r, c = p[k], r[k], c[k]
        lin = r * Wc + c
        order = np.lexsort((p[:, 1], lin))
        lin_s, y_s = lin[order], p[order, 1]
        h = np.full(Hc * Wc, np.nan)
        starts = np.r_[0, np.nonzero(np.diff(lin_s))[0] + 1]
        ends = np.r_[starts[1:], len(lin_s)]
        for a, b in zip(starts, ends):
            ys = y_s[a:b]
            if len(ys) < 4:
                continue
            j = np.searchsorted(ys, ys + 0.05)
            dens = j - np.arange(len(ys))
            ok = np.nonzero(dens >= 4)[0]
            if len(ok):
                i = ok[0]
                h[lin_s[a]] = float(np.median(ys[i:j[i]]))
        h = h.reshape(Hc, Wc)
        valid = ~np.isnan(h)
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                med = ndimage.generic_filter(h, np.nanmedian, size=3, mode="constant", cval=np.nan)
        # reject isolated outliers (box tops, floaters) but keep consistent step/stair patches
        valid &= np.abs(h - med) < 0.12
        valid = ndimage.binary_closing(valid, iterations=2) | valid
        hfill = self._fill_nearest(np.where(valid, h, np.nan), valid & ~np.isnan(h))
        valid = ndimage.binary_fill_holes(valid)
        # upsample to the navigation grid
        rr = np.minimum(np.arange(g.H) // f, Hc - 1); cc = np.minimum(np.arange(g.W) // f, Wc - 1)
        hn = hfill[np.ix_(rr, cc)]; vn = valid[np.ix_(rr, cc)]
        hn = ndimage.median_filter(hn, size=3)
        return np.where(vn, hn, np.nan), vn

    @staticmethod
    def _fill_nearest(h: np.ndarray, valid: np.ndarray) -> np.ndarray:
        if not valid.any():
            return np.zeros_like(h)
        _, (ir, ic) = ndimage.distance_transform_edt(~valid, return_indices=True)
        return h[ir, ic]

    def _levels(self) -> list[dict]:
        hs = self.height[self.floor]
        if len(hs) == 0:
            return []
        hist, edges = np.histogram(hs, bins=np.arange(-0.4, 1.4, 0.05))
        peaks = [i for i in range(len(hist)) if hist[i] >= max(40, 0.05 * hist.max())
                 and hist[i] == hist[max(i - 2, 0):i + 3].max()]
        return [{"height_m": round(float((edges[i] + edges[i + 1]) / 2), 2), "cells": int(hist[i]),
                 "area_m2": round(float(hist[i] * self.res ** 2), 2)} for i in peaks]

    # -------------------------------------------------------------- grid building
    def _splat_count(self, pts: np.ndarray) -> np.ndarray:
        g = self.grid
        r = ((pts[:, 2] - g.z0) / g.res).astype(int)
        c = ((pts[:, 0] - g.x0) / g.res).astype(int)
        k = (r >= 0) & (r < g.H) & (c >= 0) & (c < g.W)
        cnt = np.zeros((g.H, g.W), np.int32)
        np.add.at(cnt, (r[k], c[k]), 1)
        return cnt

    def _rasterise_box(self, o: dict, out: np.ndarray, pad: float = 0.0) -> None:
        g = self.grid
        cx, _, cz = o["center"]; sx, _, sz = o["size"]; yaw = o["yaw"]
        cs, sn = math.cos(yaw), math.sin(yaw)
        hx, hz = sx / 2 + pad, sz / 2 + pad
        rad = math.hypot(hx, hz)
        r0, c0 = g.to_cell(cx - rad, cz - rad); r1, c1 = g.to_cell(cx + rad, cz + rad)
        r0, c0 = max(r0, 0), max(c0, 0); r1, c1 = min(r1 + 1, g.H), min(c1 + 1, g.W)
        if r0 >= r1 or c0 >= c1:
            return
        rr, cc = np.mgrid[r0:r1, c0:c1]
        wx = g.x0 + (cc + 0.5) * g.res - cx
        wz = g.z0 + (rr + 0.5) * g.res - cz
        lx = wx * cs + wz * sn
        lz = -wx * sn + wz * cs
        inside = (np.abs(lx) <= hx) & (np.abs(lz) <= hz)
        out[r0:r1, c0:c1] |= inside

    @property
    def occupied(self) -> np.ndarray:
        """Obstacles the planner uses: scan + frames, minus cleared footprints, plus user blockages."""
        return (self.occupied_raw & ~self.cleared) | self.blocked

    def rebuild(self) -> None:
        occ = self.occupied
        self.clearance = ndimage.distance_transform_edt(~occ) * self.res     # metres to nearest obstacle
        walk = self.floor & (self.clearance > self.robot_radius)
        # cells where the floor jumps by more than a step are borders between levels
        hf = self.height_filled
        gy = np.abs(np.diff(hf, axis=0, prepend=hf[:1])); gx = np.abs(np.diff(hf, axis=1, prepend=hf[:, :1]))
        self.step_edges = (np.maximum(gx, gy) > self.max_step) & self.floor
        walk_split = walk & ~self.step_edges
        lab, n = ndimage.label(walk_split)
        self.zone_labels = lab
        self.walkable = walk
        self.zones = []
        for z in range(1, n + 1):
            m = lab == z
            if m.sum() * self.res ** 2 < 0.3:
                continue
            self.zones.append({"zone": z, "area_m2": round(float(m.sum() * self.res ** 2), 2),
                               "floor_height_m": round(float(np.median(hf[m])), 2)})

    # -------------------------------------------------------------- dynamic obstacles
    @staticmethod
    def _box(b: dict) -> dict:
        return {"kind": "structure", "center": [b["x"], 0.5, b["z"]], "size": [b.get("w", 0.6), 1.0, b.get("d", 0.6)],
                "yaw": b.get("yaw", 0.0)}

    def set_blockages(self, blocks: list[dict], clears: list[dict] | None = None) -> None:
        """blocks: footprints {x, z, w, d, yaw} that become obstacles (barriers, planned equipment positions).
        clears: footprints of equipment moved away in a layout plan; their cells become free where floor exists."""
        self.blocked[:] = False
        self.cleared[:] = False
        for b in blocks:
            self._rasterise_box(self._box(b), self.blocked)
        for c in clears or []:
            self._rasterise_box(self._box(c), self.cleared)
        self.cleared &= self.floor
        self.rebuild()

    # -------------------------------------------------------------- queries
    def nearest_walkable(self, x: float, z: float, max_r: float = 3.0) -> tuple[int, int] | None:
        r, c = self.grid.to_cell(x, z)
        ys, xs = np.nonzero(self.walkable)
        if len(ys) == 0:
            return None
        d2 = (ys - r) ** 2 + (xs - c) ** 2
        i = int(np.argmin(d2))
        if math.sqrt(d2[i]) * self.res > max_r:
            return None
        return int(ys[i]), int(xs[i])

    def approach_cell(self, obj: dict) -> tuple[int, int] | None:
        """Walkable cell from which a technician can inspect the object (closest to its frame)."""
        mask = np.zeros_like(self.walkable)
        self._rasterise_box(obj, mask, pad=0.0)
        if not mask.any():
            r, c = self.grid.to_cell(obj["center"][0], obj["center"][2])
            mask[np.clip(r, 0, self.grid.H - 1), np.clip(c, 0, self.grid.W - 1)] = True
        dist = ndimage.distance_transform_edt(~mask) * self.res
        cand = self.walkable & (dist < 1.6)
        if not cand.any():
            return None
        score = np.where(cand, dist - 0.15 * np.minimum(self.clearance, 0.6), np.inf)
        r, c = np.unravel_index(int(np.argmin(score)), score.shape)
        return int(r), int(c)

    def farthest_from(self, cell: tuple[int, int]) -> tuple[int, int]:
        """Walkable cell with the largest step-respecting route distance from `cell` (Dijkstra/BFS on the grid)."""
        from collections import deque
        H, W = self.walkable.shape
        dist = np.full((H, W), -1, np.int32)
        dist[cell] = 0
        q = deque([cell])
        while q:
            r, c = q.popleft()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < H and 0 <= nc < W and dist[nr, nc] < 0 and self.walkable[nr, nc] \
                        and abs(self.height_filled[nr, nc] - self.height_filled[r, c]) <= self.max_step:
                    dist[nr, nc] = dist[r, c] + 1
                    q.append((nr, nc))
        r, c = np.unravel_index(int(np.argmax(dist)), dist.shape)
        return int(r), int(c)

    def astar(self, start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]] | None:
        H, W = self.walkable.shape
        walk = self.walkable
        hgt = self.height_filled
        # clearance-aware cost: prefer the middle of aisles
        pen = 1.0 + 1.5 / np.maximum(self.clearance / self.robot_radius, 1.0)
        nbrs = [(-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
                (-1, -1, 1.4142), (-1, 1, 1.4142), (1, -1, 1.4142), (1, 1, 1.4142)]
        gscore = {start: 0.0}
        came = {}
        h = lambda a: math.hypot(a[0] - goal[0], a[1] - goal[1])  # noqa: E731
        openq = [(h(start), 0.0, start)]
        closed = set()
        while openq:
            _, gcur, cur = heapq.heappop(openq)
            if cur == goal:
                path = [cur]
                while cur in came:
                    cur = came[cur]; path.append(cur)
                return path[::-1]
            if cur in closed:
                continue
            closed.add(cur)
            for dr, dc, w in nbrs:
                nr, nc = cur[0] + dr, cur[1] + dc
                if not (0 <= nr < H and 0 <= nc < W) or not walk[nr, nc]:
                    continue
                if dr and dc and not (walk[cur[0] + dr, cur[1]] and walk[cur[0], cur[1] + dc]):
                    continue  # no corner cutting
                if abs(hgt[nr, nc] - hgt[cur]) > self.max_step:
                    continue  # step too high: needs stairs/ramp
                ng = gcur + w * pen[nr, nc]
                if ng < gscore.get((nr, nc), 1e18):
                    gscore[(nr, nc)] = ng
                    came[(nr, nc)] = cur
                    heapq.heappush(openq, (ng + h((nr, nc)), ng, (nr, nc)))
        return None

    def _line_clear(self, a: tuple[int, int], b: tuple[int, int]) -> bool:
        n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) * 2 + 1
        rs = np.linspace(a[0], b[0], n).round().astype(int)
        cs = np.linspace(a[1], b[1], n).round().astype(int)
        return bool(self.walkable[rs, cs].all())

    def smooth(self, path: list[tuple[int, int]]) -> list[tuple[int, int]]:
        if len(path) < 3:
            return path
        out = [path[0]]
        i = 0
        while i < len(path) - 1:
            j = len(path) - 1
            while j > i + 1 and not self._line_clear(path[i], path[j]):
                j -= 1
            out.append(path[j]); i = j
        return out

    def validate(self, cells: list[tuple[int, int]]) -> dict:
        """Densely re-check the final polyline against raw obstacles and object frames."""
        samples, min_clear, hits = 0, 1e9, 0
        for a, b in zip(cells[:-1], cells[1:]):
            n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) * 2 + 1
            for t in np.linspace(0, 1, n):
                r = int(round(a[0] + (b[0] - a[0]) * t)); c = int(round(a[1] + (b[1] - a[1]) * t))
                samples += 1
                min_clear = min(min_clear, float(self.clearance[r, c]))
                if self.occupied[r, c] or not self.floor[r, c]:
                    hits += 1
        return {"samples": samples, "min_clearance_m": round(min_clear, 3), "collisions": hits,
                "robot_radius_m": self.robot_radius, "collision_free": hits == 0 and min_clear >= self.robot_radius - 1e-6}

    def plan(self, start_xz: tuple[float, float], target_obj: dict) -> dict:
        s = self.nearest_walkable(*start_xz)
        gcell = self.approach_cell(target_obj)
        if s is None or gcell is None:
            return {"ok": False, "reason": "start or goal not reachable on the walkable floor"}
        raw = self.astar(s, gcell)
        if raw is None:
            return {"ok": False, "reason": "no collision-free route (walkway blocked)"}
        sm = self.smooth(raw)
        val = self.validate(sm)
        pts = [self.grid.to_world(r, c) for r, c in sm]
        length = sum(math.dist(a, b) for a, b in zip(pts[:-1], pts[1:]))
        return {"ok": True, "waypoints": [[round(x, 3), 0.0, round(z, 3)] for x, z in pts],
                "raw_cells": len(raw), "length_m": round(length, 2), "validation": val,
                "goal_cell": list(gcell), "start_cell": list(s)}

    def export(self) -> dict:
        g = self.grid
        enc = lambda m: np.packbits(m.astype(np.uint8)).tobytes().hex()  # noqa: E731
        return {"x0": g.x0, "z0": g.z0, "res": g.res, "W": g.W, "H": g.H,
                "walkable": enc(self.walkable), "occupied": enc(self.occupied),
                "floor": enc(self.floor)}
