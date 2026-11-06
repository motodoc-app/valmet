"""Open-vocabulary labelling of extracted 3D clusters ("2D foundation model lifted to 3D").

For every extracted object we render two views of the reconstructed splats from inside the room
(context + close-up) with the object's 3D frame drawn in, and ask a vision-language model to name the
framed object from an industrial taxonomy. Results are cached (vlm_labels.json) keyed by a geometry
signature so the demo never depends on a live API call. Labels keep their provenance and confidence.
"""
from __future__ import annotations

import base64
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from . import config
from .render import perspective

TAXONOMY = [
    "circulation pump", "centrifugal pump", "electric motor", "pump-motor unit", "control valve", "manual valve",
    "valve actuator", "pressure gauge", "pressure transmitter", "temperature sensor", "flow meter",
    "vibration sensor", "expansion vessel", "storage tank", "heat exchanger", "insulated pipe (vertical)",
    "insulated pipe (horizontal)", "pipe elbow / fitting", "pipe label / tag", "electrical cabinet",
    "control panel", "junction box", "cable tray", "cable / hose coil", "ventilation duct", "light fixture",
    "fire extinguisher", "door", "notice / poster", "wire mesh cage", "trolley / cart", "shelving",
    "crate / box", "bucket / container", "ladder", "wall-mounted board", "floor drain", "other equipment",
]

PROMPT = """You are labelling objects in a 3D Gaussian-splat scan of an industrial boiler / plant room.
Two renders are given: (1) context view, (2) close-up. The object of interest is outlined by a magenta 3D box.
Its measured size is {size} metres (width x height x depth), bottom at {bottom:.2f} m above floor.
Choose the best label from this list: {taxonomy}.
Reply with JSON only: {{"label": str, "category": one of ["rotating","valve","instrument","vessel","piping",
"electrical","structure","logistics","safety","other"], "confidence": 0..1, "rationale": "<=15 words"}}.
If the box mostly frames wall, floor or an unrecognisable fragment, use "other equipment" with low confidence."""


def _project(pts: np.ndarray, eye, target, W, H, fov=55):
    fwd = target - eye; fwd = fwd / np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    rel = pts - eye
    z = rel @ fwd
    f = (H / 2) / np.tan(np.radians(fov) / 2)
    return np.stack([W / 2 + f * (rel @ right) / z, H / 2 - f * (rel @ up) / z], 1), z


def box_corners(o: dict) -> np.ndarray:
    c = np.array(o["center"]); s = np.array(o["size"]) / 2; yaw = o["yaw"]
    cs, sn = np.cos(yaw), np.sin(yaw)
    ex = np.array([cs, 0, sn]); ez = np.array([-sn, 0, cs]); ey = np.array([0, 1.0, 0])
    out = []
    for dx in (-1, 1):
        for dy in (-1, 1):
            for dz in (-1, 1):
                out.append(c + dx * s[0] * ex + dy * s[1] * ey + dz * s[2] * ez)
    return np.array(out)


EDGES = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]


def render_object_views(o: dict, cache: dict, room_center: np.ndarray, W: int = 448, H: int = 448) -> list[Image.Image]:
    c = np.array(o["center"]); ext = float(max(o["size"]))
    d = room_center - c; d[1] = 0
    if np.linalg.norm(d) < 1e-3:
        d = np.array([0, 0, -1.0])
    d /= np.linalg.norm(d)
    views = []
    for dist, fov in ((max(1.6, ext * 2.4), 60), (max(0.6, ext * 1.4), 50)):
        eye = c + d * dist + np.array([0, 0.25, 0])
        eye[1] = np.clip(eye[1], 0.4, 1.9)
        # draw only splats in front of the camera and not too close
        img = perspective(cache["xyz"], cache["rgb"], cache["size"], eye, c, fov_deg=fov, W=W, H=H)
        uv, z = _project(box_corners(o), eye, c, W, H, fov)
        dr = ImageDraw.Draw(img)
        if (z > 0.05).all():
            for a, b in EDGES:
                dr.line([tuple(uv[a]), tuple(uv[b])], fill=(255, 0, 255), width=2)
        views.append(img)
    return views


def _b64(img: Image.Image) -> str:
    buf = io.BytesIO(); img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def ask_vlm(views: list[Image.Image], o: dict) -> dict:
    from openai import OpenAI
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "proxy-injected"))
    s = o["size"]
    content = [{"type": "text", "text": PROMPT.format(size=f"{s[0]:.2f} x {s[1]:.2f} x {s[2]:.2f}",
                                                      bottom=o["descriptors"].get("bottom_y", 0),
                                                      taxonomy=", ".join(TAXONOMY))}]
    for v in views:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{_b64(v)}"}})
    r = client.chat.completions.create(model=config.VLM_MODEL, messages=[{"role": "user", "content": content}],
                                       response_format={"type": "json_object"})
    out = json.loads(r.choices[0].message.content)
    if out.get("label") not in TAXONOMY:
        out["label_raw"] = out.get("label")
        out["label"] = "other equipment"
    return out


def label_all(scene: dict, out_dir: Path, workers: int = 8, limit: int | None = None,
              save_crops: bool = True) -> dict:
    cache_path = out_dir / "vlm_labels.json"
    labels = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    rc = np.load(out_dir / "render_cache.npz")
    rcache = {k: rc[k] for k in ("xyz", "rgb", "size")}
    objs = [o for o in scene["objects"] if o["kind"] == "object"]
    floor_pts = rcache["xyz"][np.abs(rcache["xyz"][:, 1]) < 0.05]
    room_center = np.median(floor_pts, axis=0) if len(floor_pts) else np.zeros(3)
    room_center[1] = 1.2
    crops = out_dir / "crops"; crops.mkdir(exist_ok=True)

    def sig(o):
        return f"{o['center'][0]:.2f},{o['center'][1]:.2f},{o['center'][2]:.2f}|{o['n_points']}"

    todo = [o for o in objs if labels.get(o["id"], {}).get("geometry_signature") != sig(o)]
    if limit:
        todo = todo[:limit]

    def work(o):
        try:
            views = render_object_views(o, rcache, room_center)
            if save_crops:
                both = Image.new("RGB", (views[0].width * 2, views[0].height))
                both.paste(views[0], (0, 0)); both.paste(views[1], (views[0].width, 0))
                both.save(crops / f"{o['id']}.jpg", quality=80)
            res = ask_vlm(views, o)
            res["geometry_signature"] = sig(o)
            res["model"] = config.VLM_MODEL
            return o["id"], res
        except Exception as e:  # noqa: BLE001
            return o["id"], {"error": str(e)[:200]}

    with ThreadPoolExecutor(workers) as ex:
        for oid, res in ex.map(work, todo):
            if "error" in res:
                print("  VLM error", oid, res["error"])
                continue
            labels[oid] = res
            print(f"  {oid}: {res['label']} ({res.get('confidence')}) — {res.get('rationale', '')}")
    cache_path.write_text(json.dumps(labels, indent=1))
    return labels
