# Generic footage — the moving floor under the sourcing ladder

A spoken sentence that YouTube, the own archive, the open sources, stock, a graphic, a generated
video (ElevenLabs, Replicate) and a generated still could not picture ends on **generic footage**:
rights-clear moving pictures that are not about the sentence (skies, water, traffic, textures).
It is visual coverage, never a content fit, and every log line and the delivery gate say so
(`contentApproval: "generic_footage"`, coverage kind `generic_footage`, `QUALITY_NOTE GENERIC_FOOTAGE`).

There are two sources, in this order:

| source | provider name | what it is | how it is reported |
|---|---|---|---|
| **archive** | `generic_footage` | a real clip an operator put in the media archive under the tag `generic` | `QUALITY_NOTE GENERIC_FOOTAGE` — delivered, not a content fit |
| **synthetic** | `synthetic_placeholder` | a slowly moving colour field FastVid renders itself with ffmpeg (`gradients` source) | `QUALITY_PROBLEM SYNTHETIC_PLACEHOLDER` — **not cover**: the sentence stays uncovered; the film is still delivered (VIDEO 653) with the gap named as a quality problem; it is an EMERGENCY placeholder, not footage |

The synthetic clip is never cover and never presented as footage: a coloured field under a spoken
sentence is no picture, so that sentence counts as uncovered; the film is delivered and the delivery gate names
the gap as a quality problem for the customer to replace (VIDEO 653).
The clip makes the gap visible in the render instead of a blue-grey chapter card: its archive title is
`EMERGENCY PLACEHOLDER — synthetic colour field (not footage)`, it is filed under the generic archive
with the tag `placeholder` (not `generic`, so a later film can never pick it as real generic footage),
the coverage row carries `kinds=generic_footage+synthetic_placeholder`, and the render log carries
`[GENERIC_FOOTAGE_FALLBACK] … EMERGENCY PLACEHOLDER … QUALITY PROBLEM`.

## Putting real generic clips in production

The archive is the only route that is reliable on every Railway worker: no download happens during
a render, the clip is read from the archive's storage like every other archive clip, and it has been
through the archive's own ingestion (validity, duration, shot split).

What a clip must be:

- rights-clear for commercial use **without attribution in the picture**: CC0 (for example Wikimedia
  Commons CC0 videos, Pexels and Pixabay videos under their own licences — read each licence), or footage
  you own. **The admin upload has no licence field**: keep your own list of file name → source URL →
  licence (for example in the archive's description, or a spreadsheet) before you upload;
- a real moving picture (a camera move on a still is refused by the motion check), landscape, one single
  shot without cuts, at least 8 s long — 8 to 20 s is ideal. The archive's floor is
  `MIN_VIDEO_DURATION_SEC` (3 s, archiveIngestion.ts), but a sentence typically needs 4 to 7 s and a clip
  shorter than the sentence is passed over;
- non-specific: no recognisable person, text, logo or landmark that could contradict a sentence.

How to add them (once, by an operator — not by the pipeline):

1. Admin → Media archive → choose an archive (for example a new one called "Generieke beelden") →
   upload the files with the typed tag **`generic`** in the tags field (`tags=generic` on the API;
   typed tags are kept as typed and never dropped, see archiveUpload.ts `typedTagsRow`). Turn **auto-split
   off** for these clips, so a clip is not cut into shots shorter than a sentence. AI tags may stay on:
   your own tag `generic` is kept first. (Routes: the chunked upload `/api/admin/archive/upload/chunk` +
   `/assemble`, or the single-request `/api/admin/archive/upload` for files under ~100 MB.)
2. Wait for the asset to reach `mediaStatus=READY` and `isActive=1`.
3. Check: the next render that needs the floor logs
   `[GENERIC_FOOTAGE_FALLBACK] library: N active generic clip(s) tagged "generic" in the archive`
   with N > 0, and places `source=archive`.

The pipeline reads them with `listActiveVideoArchiveAssetsByTag("generic", 200)` (db.ts): active,
video, READY, `JSON_SEARCH(tags, 'one', 'generic')`. A clip is chosen for its length (it must cover
the sentence's seconds without being held past its source), rotated by seed so two films do not
open on the same clip, and measured before it is placed (valid stream, not black, moving, long enough).

A small set is enough: 10 to 20 clips of 8 to 20 s. Until the set exists, every sentence on the
floor is a synthetic placeholder, named `QUALITY_PROBLEM SYNTHETIC_PLACEHOLDER` (`SENTENCE_NOT_COVERED`
at the delivery gate) — the film is delivered, with that sentence marked for replacement.

## The library fills itself (VIDEO 656)

Nobody uploaded the set, so the worker now fills it (`server/genericLibraryFill.ts`). While no film
renders, every 5 minutes, it adds up to 3 clips until the library holds 15 usable ones (active, video,
READY, tagged `generic`, at least 6 s). It needs `PEXELS_API_KEY` and/or `PIXABAY_API_KEY`; without
either it logs `[GenericLibrary] OFF`.

- **Searches**: a fixed list of neutral terms (clouds timelapse, ocean waves, fog landscape, ...) —
  never a person, place, brand or year.
- **What is kept**: landscape, at least 1280 px wide, a source of 8–40 s, cut where the picture
  changes; only the longest single shot (at least 6 s, at most 11 s, a quarter second clear of any
  cut) that moves. The archive's own intake then checks it for on-screen text, decodability and
  storage read-back before the row is `READY`.
- **Where it goes**: the "Generieke beelden" archive, active, `mixKind: "stock"`, tag `generic` only,
  with the Pexels or Pixabay licence and page on the row. The curated sourcing never reads this archive,
  so these clips are offered only on the floor, never as a sentence's own footage.
- **Log**: `[GenericLibrary] N/15 usable generic clip(s)`, then one line per added or skipped clip.

Hand uploads under the tag `generic` (above) still count toward the 15 and are used the same way.
