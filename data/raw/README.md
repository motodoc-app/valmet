Place the Valmet challenge files here (git-ignored, about 400 MB):

- `equipment_room.ply` ← "Equipment Room.ply" (Valmet's Google Drive, file id `1MrwNjHxFqk5IfHpJQ24KlTn5nAAn40rd`;
  SHA-256 `83d8c7d99316c08c9719cfc2c5a6b9d1903b89847780e2458adc662c79f32955`, 395,651,019 bytes)
- `builder_pack.xlsx`  ← "Valmet_SinceAI_2026_Synthetic_Industrial_Metaverse_Builder_Pack.xlsx"

The PLY is only needed to re-run the scan pipeline. The workbook is needed for the FastAPI server (server mode),
`pytest` and `scripts/export_static.py`. The processed outputs (`data/processed/`, `web/public/static/`) are
committed, so the hosted/static demo runs from a fresh checkout without either file.
