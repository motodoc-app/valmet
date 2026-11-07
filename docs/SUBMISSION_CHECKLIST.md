# Submission checklist — Industrial X-Ray (Valmet × Since AI Hackathon 2026)

**Deadline:** Sunday 8 November 2026, 10:00 Finland time (aim for 09:00).
**Status on 7 Nov 2026 (commit `e694afc`):** software and documents ready; **the video is not recorded yet**; the
submission platform is, per an independent audit of the organisers' Builder Guide, **sinceai.app** (one team entry,
signed in); we have not seen the form ourselves, so confirm its fields there.

## What the organisers asked for
* **Valmet's brief, §07 "Submission package":** "working demo (runnable locally in Python/Rust/web or clearly
  recorded)" · "source-code repository with concise README and setup instructions" · "5–8 presentation slides …" ·
  "short demo video (maximum 5 minutes) …" · "brief technical note describing the models, libraries, and software
  components used".
* **Organisers' Discord announcement:** a video of **about 2 minutes** (Problem 0–15 s · Solution 15–35 s · Live
  demo 35–95 s · Business impact 95–120 s), **voice narration + English subtitles**, "Localhost is enough", simulated
  data is fine if what is real and what is simulated is explained, "watch your final exported video and verify your
  submission before the deadline". A 2-minute video satisfies both.
* **Independent audit (7 Nov), from the organisers' Builder and Judge Guides — confirm in the signed-in form:** one
  team entry on **sinceai.app** by Sun 8 Nov 10:00 Finland time; fields reported: project name, tagline, description,
  technology list, repository, **YouTube demo (public or unlisted)**, **source ZIP (≤ 100 MB, no datasets or
  dependencies)** and challenge IP acceptance. Finals: at most **4 minutes** presenting + up to 6 minutes of questions.
* **Valmet's own scoring weights (brief):** 30 % extraction density and framing · 25 % navigation and proximity ·
  20 % diagnostic grounding · 15 % backend implementation · 10 % demo clarity and innovation. Keep the mandatory
  journey (scan → assets → robot → nearby assets → grounded guidance) in every cut.

## Deliverables

| # | Deliverable | Location | Status | Owner action |
|---|---|---|---|---|
| 1 | Live demo (hosted, static) | https://claude.ai/artifact/FbUbNXsimhQWK9Zw9Vpebs | Published (version 12); set to "Anyone with the link" | Open it once in a private window before submitting. Republish only after the final QA merge and a full test run. |
| 2 | Backup demo (earlier build) | https://claude.ai/artifact/PKt4BtBkZvpTE3V9RyBDZe | Published; unchanged | Check its sharing setting (Share menu) if you list it in the submission. |
| 3 | Local run (fallback if the network fails) | README → *Run it* | Verified on this commit: `npm run build` OK; backend answered on a test port | Bring a laptop with the repo, `npm ci` done and `data/raw/builder_pack.xlsx` in place (needed for server mode only). `#plan` opens the 2D floor plan without a GPU. |
| 4 | Pitch deck (8 slides: cover + 7) | https://claude.ai/artifact/S8rpiiuncbmJm7mEiPsFc2 (text: [`PITCH.md`](PITCH.md)) | Published (version 5); **private** | Share it from its Share menu ("Anyone with the link") or export it to PDF/PPTX if the form wants a file. |
| 5 | GitHub repository | `motodoc-app/valmet`, branch `ccr-3b4e61d7-jdmlgf` | Pushed. **Visibility unknown**; the work is on this branch, which may not be the default branch | Make sure judges can open it (public, or invite them). Link the branch explicitly, or merge it into the default branch. Read *Licence and attribution* in the README first: the repo contains files derived from the organisers' scan. |
| 6 | Demo video (≈ 2 min, narration + English subtitles) | Script: [`DEMO_GUIDE.md`](DEMO_GUIDE.md) (presenter script); assets: `docs/video/` | **Not recorded.** `narration.mp3` (AI voice) and `subtitles.srt` follow an earlier cut without Robot POV and the in-scene X-Ray | User records on a laptop with a GPU (OBS / Cmd+Shift+5 / Win+Alt+R) at 1920×1080, narrates the presenter script, adds English subtitles, watches the exported file end to end, uploads it where the form asks (e.g. YouTube unlisted). |
| 7 | Technical architecture note | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Ready | Link it in the submission. |
| 8 | Requirement-compliance checklist | [`COMPLIANCE.md`](COMPLIANCE.md) | Ready | Optional to submit; useful for judges' questions. |
| 9 | Known limitations | [`LIMITATIONS.md`](LIMITATIONS.md); About sheet in the app | Ready | — |
| 10 | Demo script | [`DEMO_GUIDE.md`](DEMO_GUIDE.md) (28-step walkthrough + 2-minute script) | Ready | Rehearse once on the presentation machine. |
| 11 | README and setup | [`README.md`](../README.md) | Ready | — |
| 12 | Source ZIP (≤ 100 MB) | `scripts/make_source_zip.sh` → `industrial-xray-source.zip` | Script verified 7 Nov: 83.5 MB, 222 files; a clean extraction ran `npm ci && npm run build`, and `vite preview` loaded the full-fidelity scan with no failed requests | Re-run the script on the final commit and upload the ZIP. It excludes `data/raw` (PLY + workbook), `data/processed` and `node_modules`; the README says where the challenge files go. |
| 13 | Official submission form | **sinceai.app** (per the audit; fields to confirm) | Not done | Sign in, fill project name, tagline, description, technology list, repository link (pin the branch or a commit), YouTube link, source ZIP, IP acceptance. Save the confirmation/receipt. |

## Before pressing submit
- [ ] The live demo opens from a private window and reaches the room; `#plan` works.
- [ ] Deck and (if listed) backup links open for someone outside the team.
- [ ] Judges can open the GitHub repository and the right branch.
- [ ] The video is about 2 minutes, has narration and English subtitles, says what is simulated, and plays end to end.
- [ ] Every number said in the video matches the app (676 candidates · 416 typed · 195 confident · 7 corrected ·
      30 linked · 52 % confidence · route 8.40 m → 7.98 m after the Plan move).
- [ ] The YouTube video plays signed out (public or unlisted).
- [ ] The source ZIP was rebuilt on the final commit and is under 100 MB.
- [ ] The form's required fields are all filled; confirmation/receipt saved.
