---
name: Production notation clips with pre-burned titles
description: Some archive clips have ALL-CAPS editorial labels burned into the video file itself
---

## The rule
Archive clips whose title matches broadcast production notation (ALL-CAPS shot labels like "MEDIC", "UNCERTAINTY WIDE SHOT MED", "ECU FACE") must be blocked at selection time.

## Why
These clips come from professional broadcast archives where editorial assistants added shot-type labels directly onto the video. The label appears in the bottom-left of the frame in the final output — not from our pipeline's drawtext, but pre-burned into the source file.

## How to apply
`hasProductionNotationTitle()` in `curatedMediaSourcing.ts`:
- Detects: ALL-CAPS title, only [A-Z0-9 _-], length ≤ 60
- Contains shot-type keywords: MEDIC, WIDE SHOT, CLOSE UP, MED, ECU, BCU, MCU, CU, WS, MS, LS, etc.
- Applied in: `assetPassesBeatMinimum()` (hard block) and `scoreCuratedAsset()` (score → 0, defense-in-depth)
