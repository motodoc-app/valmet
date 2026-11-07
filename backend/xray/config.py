"""Central paths and tunable parameters for the Industrial X-Ray AI pipeline.

Every site-specific value lives in one project file (default: config/project.json; another one with
XRAY_PROJECT=config/my-site.json). Environment variables still override single values (XRAY_PLY, XRAY_XLSX,
XRAY_LLM_MODEL, ...). Nothing else in the code base needs to change to run the pipeline on a new room.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"
PROJECT_FILE = Path(os.environ.get("XRAY_PROJECT", CONFIG_DIR / "project.json"))
if not PROJECT_FILE.is_absolute():
    PROJECT_FILE = ROOT / PROJECT_FILE
PROJECT: dict = json.loads(PROJECT_FILE.read_text()) if PROJECT_FILE.exists() else {}


def _get(path: str, default):
    node = PROJECT
    for k in path.split("."):
        if not isinstance(node, dict) or k not in node:
            return default
        node = node[k]
    return node


def _path(p: str | Path) -> Path:
    p = Path(p)
    return p if p.is_absolute() else ROOT / p


SITE = {"name": _get("site.name", "Equipment Room"), "description": _get("site.description", "")}

DATA_RAW = Path(os.environ.get("XRAY_DATA_RAW", ROOT / "data" / "raw"))
DATA_OUT = Path(os.environ.get("XRAY_DATA_OUT", ROOT / "data" / "processed"))
WEB_PUBLIC = ROOT / "web" / "public" / "data"

PLY_PATH = Path(os.environ.get("XRAY_PLY", _path(_get("inputs.ply", DATA_RAW / "equipment_room.ply"))))
XLSX_PATH = Path(os.environ.get("XRAY_XLSX", _path(_get("inputs.workbook", DATA_RAW / "builder_pack.xlsx"))))

LIBRARY_PATH = _path(_get("knowledge.equipment_library", "backend/xray/knowledge/equipment.json"))
ANNOTATIONS_PATH = _path(_get("knowledge.scene_annotations", "config/scene_annotations.json"))
MAPPING_OVERRIDES_PATH = _path(_get("knowledge.mapping_overrides", "config/mapping_overrides.json"))

# --- geometry ---------------------------------------------------------------
GEOM_MIN_OPACITY = float(_get("geometry.min_opacity", 0.25))     # splats below this are "fog" and ignored for geometry
GEOM_MAX_SCALE = float(_get("geometry.max_splat_scale_m", 0.25))  # very large splats are background blobs, not surfaces
VOXEL = float(_get("geometry.voxel_m", 0.03))                     # voxel size (scene units ~ metres) for geometry

# --- navigation ---------------------------------------------------------------
NAV_CELL = float(_get("geometry.nav_cell_m", 0.05))               # occupancy grid resolution
ROBOT_RADIUS = float(_get("robot.radius_m", 0.20))                # inflation radius (compact robot ~0.4 m wide)
ROBOT_MAX_STEP = float(_get("robot.max_step_m", 0.18))            # largest floor-height step the robot can climb
PROXIMITY_M = float(_get("robot.proximity_m", 1.2))               # assets read within this distance of the robot
OBSTACLE_MIN_H = float(_get("robot.obstacle_min_height_m", 0.12))  # anything between these heights above floor blocks
OBSTACLE_MAX_H = float(_get("robot.obstacle_max_height_m", 1.25))  # robot height incl. mast (overhead pipes passable)

# --- LLM ------------------------------------------------------------------------
LLM_MODEL = os.environ.get("XRAY_LLM_MODEL", _get("llm.model", "gpt-5.4-mini"))
VLM_MODEL = os.environ.get("XRAY_VLM_MODEL", _get("llm.vision_model", "gpt-5.4-mini"))
USE_LLM = os.environ.get("XRAY_USE_LLM", "1" if _get("llm.enabled", True) else "0") != "0"
