---
name: Pexels fallback in archive-first mode
description: Why Pexels was blocked even though archivePexelsFallbackEnabled() returned true
---

## The rule
In `curatedArchiveOnlyVisuals()` mode, Pexels must never be budget-capped. It is the sole fallback when the archive has no matching clip.

## Why
The pipeline profile block at the bottom of `buildPipelineProfile()` in `videoPipeline.ts` explicitly sets:
```
minimizeStockFootage: true,
maxStockBeatsPerVideo: 0,
maxStockQueriesPerBeat: 0,
```
This hard-zeros Pexels even though `archivePexelsFallbackEnabled()` returns true. The zero values affect multiple code paths beyond `canUseLicensedStockBeat()` (e.g. `fetchPexelsClips` loop limits, `maxQ` variables).

## How to apply
When `curatedArchiveOnlyVisuals()` is true, the profile must use:
```
minimizeStockFootage: false,
maxStockBeatsPerVideo: 999,
maxStockQueriesPerBeat: 5,
```
`canUseLicensedStockBeat()` also has a bypass: if `curatedArchiveOnlyVisuals()` → always true.
