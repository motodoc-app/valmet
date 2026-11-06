"""Central paths and tunable parameters for the Industrial X-Ray AI pipeline."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_RAW = Path(os.environ.get("XRAY_DATA_RAW", ROOT / "data" / "raw"))
DATA_OUT = Path(os.environ.get("XRAY_DATA_OUT", ROOT / "data" / "processed"))
WEB_PUBLIC = ROOT / "web" / "public" / "data"

PLY_PATH = Path(os.environ.get("XRAY_PLY", DATA_RAW / "industrial_boiler_room.ply"))
XLSX_PATH = Path(os.environ.get("XRAY_XLSX", DATA_RAW / "builder_pack.xlsx"))
CONFIG_DIR = ROOT / "config"

# --- geometry ---------------------------------------------------------------
GEOM_MIN_OPACITY = 0.25        # splats below this are "fog" and ignored for geometry
GEOM_MAX_SCALE = 0.25          # very large splats are background blobs, not surfaces
VOXEL = 0.03                   # voxel size (scene units ~ metres) for geometry processing

# --- navigation ---------------------------------------------------------------
NAV_CELL = 0.05                # occupancy grid resolution
ROBOT_RADIUS = 0.20            # inflation radius (compact inspection robot ≈ 0.4 m wide)
OBSTACLE_MIN_H = 0.12          # anything between these heights above floor blocks walking
OBSTACLE_MAX_H = 1.25          # inspection-robot height incl. sensor mast (overhead pipes are passable)

# --- LLM ------------------------------------------------------------------------
LLM_MODEL = os.environ.get("XRAY_LLM_MODEL", "gpt-5.4-mini")
VLM_MODEL = os.environ.get("XRAY_VLM_MODEL", "gpt-5.4-mini")
USE_LLM = os.environ.get("XRAY_USE_LLM", "1") != "0"
