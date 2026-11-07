"""Copilot conversation guarantees (no network: template/retrieval mode). Run: `pytest -q` from the repo root.

The live LLM path is exercised by web/tests/e2e-copilot.mjs against a running server; here we check the parts that
must hold in every mode: routing, follow-up memory, citations only from the context, the FAQ file."""
import json
import os
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("XRAY_USE_LLM", "0")

from xray import config  # noqa: E402

config.USE_LLM = False
from xray import api  # noqa: E402


def ask(text, selected=None, history=None):
    return api.command(api.CommandReq(text=text, selected_asset_id=selected, history=history or []))


def test_named_question_is_answered_not_located():
    r = ask("Is P-005 safe to keep running?")
    assert r["intent"] == "question" and r["asset_id"] == "ASSET-017"
    assert "Mapped to scene object" not in r["text"] and "mapped to scene object" not in r["text"]
    assert "[ASSET-017]" in r["text"] and "DOC-FIELD-SAFETY" in r["text"]


def test_follow_up_uses_the_previous_asset():
    hist = [{"q": "What's wrong with M-006?", "a": "M-006 is overheating.", "asset_id": "ASSET-024"}]
    r = ask("and what should I check first?", None, hist)
    assert r["asset_id"] == "ASSET-024" and "M-006" in r["text"]


def test_suspect_parts_open_xray_with_the_hypothesis_components():
    r = ask("Which parts of P-005 are suspect?")
    xr = next(a for a in r["actions"] if a["type"] == "xray")
    assert xr["asset_id"] == "ASSET-017" and "impeller" in xr["focus"]


def test_product_questions_do_not_trigger_asset_commands():
    for q in ("How does the robot plan routes?", "What does Plan mode do?", "how does the robot find its path"):
        r = ask(q, "ASSET-017")
        assert not any(a["type"] in ("navigate", "select_object") for a in r["actions"]), q
        assert "is a process pump" not in r["text"], q


def test_rule_commands_still_work():
    assert any(a["type"] == "navigate" for a in ask("Send the robot to M-006")["actions"])
    assert ask("Which motor is overheating?")["asset_id"] == "ASSET-024"


def test_answer_cites_only_context_ids():
    cp = api.WORLD.copilot
    r = cp.answer("How does the robot plan routes?")
    assert "DOC-APP-NAV" in r["text"]
    ids = {d["id"] for d in cp.corpus.docs} | set(api.WORLD.assets_summary)
    for m in re.findall(r"\[([^\[\]]+)\]", r["text"]):
        for i in m.split(","):
            assert i.strip() in ids


def test_faq_file_is_complete_and_grounded():
    f = ROOT / "web" / "public" / "static" / "faq.json"
    if not f.exists():
        pytest.skip("faq.json not generated (python scripts/export_faq.py)")
    faq = json.loads(f.read_text())
    assert faq["count"] >= 250 and f.stat().st_size < 3e6
    tags = {a["tag"] for a in api.WORLD.assets_summary.values()}
    assert tags <= {e["tag"] for e in faq["faq"] if e["tag"]}          # every workbook asset is covered
    ids = {d["id"] for d in api.WORLD.copilot.corpus.docs} | set(api.WORLD.assets_summary) | tags | {"Telemetry_Sample_3d"}
    ev = api.WORLD.pack.events.event_id.tolist() + api.WORLD.pack.work_orders.work_order_id.tolist() + \
        api.WORLD.pack.data_quality.issue_id.tolist()
    ids |= set(ev)
    for e in faq["faq"]:
        assert re.search(r"\[[A-Za-z]", e["text"]), e["q"]                 # every answer cites something
        for s in e["sources"]:
            assert s["id"] in ids, (e["q"], s["id"])                     # and only real IDs
