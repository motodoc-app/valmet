# Scan integrity report — Industrial Boiler Room.ply (original challenge file)

* SHA-256: `117195366421b07aa6738415e94609d96cd41993a0c5b8e8b730849f6b7f1b03`
* File size: 355,449,599 bytes (header 1503 B, 59 float properties = 236 B/record)
* Declared splats: 1,506,136; size matches header: **True**
* First invalid record: **#502,483**
* Usable contiguous splats: **502,483 (33.4% of declared)**
* Remaining 1,003,653 records: plausible fraction 0.01% → Records after the first invalid record are statistically random bytes (only a tiny fraction pass plausibility checks by chance, consistent with noise). They are excluded, not repaired.

## Plausibility by block of 100k records

| records | plausible |
|---|---|
| 0–100,000 | 100.0% |
| 100,000–200,000 | 100.0% |
| 200,000–300,000 | 100.0% |
| 300,000–400,000 | 100.0% |
| 400,000–500,000 | 100.0% |
| 500,000–600,000 | 2.5% |
| 600,000–700,000 | 0.0% |
| 700,000–800,000 | 0.0% |
| 800,000–900,000 | 0.0% |
| 900,000–1,000,000 | 0.0% |
| 1,000,000–1,100,000 | 0.0% |
| 1,100,000–1,200,000 | 0.0% |
| 1,200,000–1,300,000 | 0.0% |
| 1,300,000–1,400,000 | 0.0% |
| 1,400,000–1,500,000 | 0.0% |
| 1,500,000–1,506,136 | 0.0% |

## Cross-checks

* Status: Superseded by 'Equipment Room.ply' (1,676,481 splats, 100% valid), which the pipeline now uses.
* Same SHA-256 in .ply, RAR and ZIP copies: yes

## Consequence for the demo

Only the contiguous valid prefix is used. The pipeline never treats it as the complete room: the UI and API label the scene as a *partial scan*, and every stage (segmentation, navigation, mapping) re-runs unchanged when a repaired PLY is dropped into `data/raw/`.
