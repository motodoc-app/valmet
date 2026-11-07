# Scan integrity report — equipment_room.ply

* SHA-256: `83d8c7d99316c08c9719cfc2c5a6b9d1903b89847780e2458adc662c79f32955`
* File size: 395,651,019 bytes (header 1503 B, 59 float properties = 236 B/record)
* Declared splats: 1,676,481; size matches header: **True**
* First invalid record: **#1,676,481**
* Usable contiguous splats: **1,676,481 (100.0% of declared)**
* Remaining 0 records: plausible fraction 100.00% → n/a

## Plausibility by block of 100k records

| records | plausible |
|---|---|
| 0–100,000 | 100.0% |
| 100,000–200,000 | 100.0% |
| 200,000–300,000 | 100.0% |
| 300,000–400,000 | 100.0% |
| 400,000–500,000 | 100.0% |
| 500,000–600,000 | 100.0% |
| 600,000–700,000 | 100.0% |
| 700,000–800,000 | 100.0% |
| 800,000–900,000 | 100.0% |
| 900,000–1,000,000 | 100.0% |
| 1,000,000–1,100,000 | 100.0% |
| 1,100,000–1,200,000 | 100.0% |
| 1,200,000–1,300,000 | 100.0% |
| 1,300,000–1,400,000 | 100.0% |
| 1,400,000–1,500,000 | 100.0% |
| 1,500,000–1,600,000 | 100.0% |
| 1,600,000–1,676,481 | 100.0% |

## Cross-checks

* Same SHA-256 for direct .ply, the 2-part RAR extraction and the ZIP copy: see README (verified 2026-11-06)
* Canonical frame: Y up, floor at y=0, walls axis-aligned (yaw 87.0°)
* Scale: Valid region spans ≈7.2 × 2.4 × 9.0 units (W×H×D). Ceiling height and the standard-size door in the scan are consistent with 1 unit ≈ 1 metre; scale is therefore treated as approximately metric (not surveyed).

## Consequence for the demo

Only the contiguous valid prefix is used. The pipeline never treats it as the complete room: the UI and API label the scene as a *partial scan*, and every stage (segmentation, navigation, mapping) re-runs unchanged when a repaired PLY is dropped into `data/raw/`.
