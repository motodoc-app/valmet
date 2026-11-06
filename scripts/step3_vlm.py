"""Step 3 (optional, needs OPENAI_API_KEY or proxy): VLM labelling of extracted clusters, cached."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from xray import config, vlm_labeler  # noqa: E402

if __name__ == "__main__":
    scene = json.loads((config.DATA_OUT / "scene_objects.json").read_text())
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    vlm_labeler.label_all(scene, config.DATA_OUT, limit=limit)
