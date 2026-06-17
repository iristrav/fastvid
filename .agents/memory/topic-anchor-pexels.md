---
name: Topic anchor injection for Pexels
description: How country/topic is auto-detected from video title and injected into Pexels queries
---

## The rule
When archive returns no clip and Pexels fallback fires, the FIRST queries sent to Pexels must be country/topic-specific, not generic. This is done by `extractVideoTopicAnchors(videoTitle, beatText)` using `TOPIC_ANCHOR_RULES`.

## Why
Without topic injection, a beat like "this changed everything" on a Netherlands video would search Pexels for "documentary" or generic terms instead of "Amsterdam" or "Dutch cycling". The result was zero Dutch imagery.

## How to apply
- `TOPIC_ANCHOR_RULES` in `videoPipeline.ts` — ~50 country/topic patterns, each with 2-3 Pexels anchor terms
- `extractVideoTopicAnchors(videoTitle, beatText)` returns the anchors for the first match
- In `fetchBeatStockFallback`: when `curatedArchiveOnlyVisuals()` is true, prepend topic anchors BEFORE all other queries (they must survive the `.slice(0, 6)` cap)
- Order matters: topic anchors → topic-specific (buildBeatVisualQueryList) → beat.searchQuery → scene.pexelsQuery

## Where topic-specific tags also live
- `PLACE_ENTRIES` in `visualBeatTags.ts` — extracts tags from beat text for countries/cities (Netherlands, Amsterdam, Rotterdam, etc. added)
- `refineVisualSearchTagsForTopic()` — injects Dutch-specific tags when topic is geography_urban and beat mentions Netherlands
- `DUTCH_STOCK_WORD_MAP` + `STOCK_TOPIC_WORD_RULES` in `videoPipeline.ts` — maps Dutch words and Netherlands patterns to English Pexels queries
