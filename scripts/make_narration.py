"""Narration + English subtitles for the 2-minute demo video, from docs/video/script.json.

    python scripts/make_narration.py            → docs/video/narration.mp3, docs/video/subtitles.srt, docs/video/timing.json

Each line is synthesised separately (OpenAI text-to-speech, the voice is AI-generated), measured with ffprobe, and
joined with short pauses, so the subtitles match the audio exactly. timing.json gives each line's start and length,
which the frame-by-frame recorder (web/tests/record-demo.cjs) uses to time the scenes.
Needs OPENAI_API_KEY (or a proxy that injects it) and ffmpeg.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / "docs" / "video"
GAP = 0.35                      # seconds of silence between lines


def tts(text: str, voice: dict, out: Path) -> None:
    body = json.dumps({"model": voice["model"], "voice": voice["voice"], "input": text,
                       "instructions": voice.get("instructions", ""), "response_format": "mp3"}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=body, headers={
        "Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', 'sk-proxy-injected')}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        out.write_bytes(r.read())


def duration(p: Path) -> float:
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)]).decode())


def stamp(t: float) -> str:
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> None:
    spec = json.loads((DIR / "script.json").read_text())
    parts = DIR / "lines"; parts.mkdir(parents=True, exist_ok=True)
    timing, t, srt, concat = [], 0.0, [], []
    silence = parts / "gap.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(GAP), str(silence)], check=True)
    for i, line in enumerate(spec["lines"]):
        mp3 = parts / f"line{i:02d}.mp3"
        if not mp3.exists() or "--fresh" in sys.argv:
            tts(line["text"], spec["voice"], mp3)
        wav = parts / f"line{i:02d}.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), "-ar", "24000", "-ac", "1", str(wav)], check=True)
        d = duration(wav)
        timing.append({**line, "start": round(t, 3), "duration": round(d, 3)})
        srt.append(f"{i + 1}\n{stamp(t)} --> {stamp(t + d)}\n{line['text']}\n")
        concat += [f"file '{wav.name}'", f"file '{silence.name}'"]
        t += d + GAP
    (parts / "list.txt").write_text("\n".join(concat) + "\n")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(parts / "list.txt"),
                    "-c:a", "libmp3lame", "-b:a", "160k", str(DIR / "narration.mp3")], check=True)
    (DIR / "subtitles.srt").write_text("\n".join(srt))
    (DIR / "timing.json").write_text(json.dumps({"total": round(t, 3), "gap": GAP, "lines": timing}, indent=1))
    by_part = {}
    for x in timing:
        by_part.setdefault(x["part"], [x["start"], 0]); by_part[x["part"]][1] = x["start"] + x["duration"]
    print(f"total {t:.1f} s ·", " · ".join(f"{k} {a:.0f}–{b:.0f}s" for k, (a, b) in by_part.items()))


if __name__ == "__main__":
    main()
