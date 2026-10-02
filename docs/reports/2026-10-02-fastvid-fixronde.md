# FastVid — fix round report (1–2 October 2026)

All of this is the existing pipeline: one route, one Visual Judge, one adoption, one timeline, one graphics engine (Remotion), one render route (ffmpeg). Nothing new was added alongside it: no Motion Canvas, WeMM, SigLIP2 or second judge, and no new external services or npm packages.

---

## 1. What was changed, and why

| # | Problem | Cause (with evidence) | Fix | Files |
|---|---|---|---|---|
| 1 | Clips adopted without an assessment (render 625: 19 clips, `never_asked=37`) | `visualJudgeRefusesPush` set the vision requirement to "suspended" when the judge was unreachable (no key / cooldown / CLIP failure); fallback routes accepted UNCLEAR | `visionAvailable` is now only false for a slot without a sentence. All photographic routes (archive, YouTube, Wikimedia, Pexels, rescue, subject_fallback, AI) require **APPROVED**. Judge unreachable → log line "judge unavailable → no adoption" | `adoptionPolicy.ts`, `videoPipeline.ts`, `beatImageRelevanceGate.ts` |
| 2 | Judge approved on person presence alone (render 626: "Any shot of Musk belongs…") | Prompt said "any one of these is enough" and "when you genuinely cannot tell, say it belongs" | Judge must answer two separate questions in JSON: `subject_matches` **and** `situation_matches` (action, context, place, objects, meaning). Code rule: both true, otherwise `does_not_fit`. Doubt = no. Rules version bumped (`r2610-subject-and-situation`), so old cached approvals are asked again | `beatImageRelevanceGate.ts` |
| 3 | YouTube moment chosen by hash/fixed fraction | `pickLongVideoStartSec` (hash of video ID) decided the window; the stock handed out 1 shot without the judge comparing | For a guessed start: download **one** 20 s section (same download slot), cut at real shot boundaries, and offer up to **3** moments (env `YOUTUBE_MOMENTS_PER_VIDEO`, max 5) to the judge as separate candidates. The stock now also hands up to 3 shots per video. A start found via the transcript remains a single window | `youtubeMoments.ts` (new), `youtubeShotStock.ts`, `videoPipeline.ts` |
| 4 | One video filling the film (612/616: `ONE_FOOTAGE_FILLS_FILM`) | Nothing in the ranking preferred other footage; dedup only blocks the *same seconds* | Screen time per footage (YouTube video = 1 footage) is counted at the push point; a source already holding ≥15% / ≥30% of the film moves down the ranking per sentence. Nothing is refused; the DeliveryGate (50%) remains the last check | `usageDiversity.ts`, `videoPipeline.ts` |
| 5 | Person lock "Opening Kim Kardashian", "Unveil Kris Jenner", "Dominated Despite" | Markdown headings were not seen as sentence starts; teaser/heading words were not on the opener list; `cleanPersonNameCandidate` didn't strip them | `atSentenceStart` handles markdown (#, **, newline); opener list extended (opening, unveil, discover, …); a leading word is dropped when the script itself uses the shorter name elsewhere. Real names stay intact (Martin Luther King, Mohammed bin Salman, Kim Kardashian West) | `sentenceOpeners.ts`, `videoPipeline.ts` |
| 6 | Archive: textual matches through without a real look | Same cause as 1 (fallback/rescue routes accepted UNCLEAR/suspension) | Covered by fix 1: archive candidates go through the same judge and need APPROVED | (see 1) |
| 7a | Map was an abstract grid with a pin | No geo data in the bundle; `locationMap` had only (inaccurate) normX/normY | Real world map: Natural Earth 1:110m (public domain, 156 KB bundled), Natural Earth projection, **camera** from world to place (or route), country highlight (ISO3), pin + pulse + label. `locationMap` gets real lon/lat + ISO3 | `remotion/components/GeoMap.tsx` (new), `remotion/data/countries110m.json` (new), `cinematicMotion/locationMap.ts`, `graphicsVocabulary.ts`, `Graphics.tsx` |
| 7b | Chart without title/axes/values; planner never produced chart data | Planner only emitted `chart` with a keyword (undrawable) | Line chart: title, y-axis with round steps, years, values, line drawing + area, running value at the head. Bar chart: axis, grid lines, staggered growth, counting values. Planner emits `line_chart` **only** when the narration itself contains ≥2 year/value pairs in the same unit (no invented data) | `Charts.tsx`, `motionGraphicsPlanner.ts`, `cinematicEditingEngine/types.ts` |
| 7c | Counter: linear, `Math.round` ("3.5 billion" became 4) | `parseNumericStat` dropped decimals; component rounded | Easing (in-out), decimals as written, currency/unit, caption | `Graphics.tsx`, `motionGraphicsPlanner.ts`, `graphicsVocabulary.ts` |
| 7d | Graphics always started at the start of the sentence | No word anchor | Planner provides `anchorWord` (number, year, place, name); props builder moves the start to the measured moment that word is spoken (only later, within its own window, ≥1.5 s visible) | `remotionProps.ts`, `motionGraphicsPlanner.ts` |
| 7e | The real map would never have reached the film | `onScreenTextDirector` (rule 2) switched off **every** `map_point` as "a map without geography" and put a location card in its place | Only a map without lon/lat is still replaced; a real map stays on | `onScreenTextDirector.ts` |
| 8 | Subtitle box wrong (narrower than the text, solid black) | (1) When the layout engine had to move a caption, the plate got 84% of its *own measured box* as a maximum, so the text ran past the edge; (2) a block that wraps is as wide as its maximum, not its longest line; (3) `backgroundColor:"black"` overrode the 45% opacity; (4) trailing margin after the last word; (5) font depended on the machine | Lines fixed in advance (same character budget as the measurement, balanced, no orphaned word); plate = longest line + padding; no double width limit; opacity applied correctly; whole pixels; **Inter and Oswald (OFL 1.1) bundled** and loaded before the first frame | `remotion/components/Text.tsx`, `captionLayout.ts`, `remotion/fonts.ts` (new), `remotion/fonts/*` (new), `remotion/Root.tsx` |

---

## 2. Tests

- **Typecheck** (`tsc --noEmit`): clean.
- **Lint** (eslint on all changed files): clean.
- **Build** (`npm run build`): OK.
- **Full suite (vitest), 3rd full run after the test-video fixes: 9,810 passed, 10 skipped, 0 failed.** Earlier 2nd full run: 723 files, **9,810 tests: 9,799 passed, 10 skipped, 1 red** — that one was my temporary showcase script (it uses `drawtext`, which the burned-in-text test guards against); the script was moved out of the repo and that test is 12/12 green. After the map-rule fix (7e): all 20 test files that touch the planning chain, 338/338 green.
- **New tests:**
  - `judgeAlwaysLooks` (49)
  - `personLockOpeners`
  - `youtubeMomentsAreJudged`
  - `footageShareLowersPriority`
  - `graphicsCarryRealData` (21)
  - `realMapChartCounterReachTheMp4` (7, real Remotion → ffmpeg → MP4 render with pixel checks: map moves, every graphic has ink, plate ≤ text + padding, plate translucent)
- **Old tests updated (25)**, each with a comment explaining why: 15 encoded the old rule "fallback may be adopted without approval", which you have now forbidden; the others covered the prompt text, `line_chart` (+1 type), the font, and the old area method of the overlap test.

### Overlap test: methodology change

The old area method no longer holds with a translucent plate: edge rows are counted differently after a move. It has been replaced by a direct pixel-by-pixel measurement (does the graphic change once the caption is added?). Result: **0 overlap**.

- **Production layout check:** the Remotion bundle built exactly as the Dockerfile lays it out (`dist/remotion` + `graphicsVocabulary.ts` + `captionLayout.ts`) contains both fonts and the country data.

---

## 3. Proven vs. UNKNOWN

### Proven (tests and real local renders)

- The judge requirement: no adoption without APPROVED, for every photographic route.
- The subject + situation rule in code.
- Name extraction.
- The YouTube moment cut (real ffmpeg: shots found exactly at the cuts).
- The diversity order.
- The map with camera, chart, counter, word timing, captions and fonts in a real MP4.

### UNKNOWN — niet bewezen

- **Whether a real production video now gets better pictures.** No production test with this code (see section 4).
- **Whether the judge gives enough approvals under the stricter rules.** Measured risk: under the new rule, all 52 refusals from render 569 come back (that film ended up all colour cards). A film without enough approvals now fails honestly at the DeliveryGate instead of shipping unassessed clips.
- **Whether a 20 s YouTube section downloads within the beat time.**
- **Extra judge calls per beat.** Up to 3 moments per video; the existing limit of 4 looks per beat stays.
- **The judge picks the first approved moment, not the best of several.** It doesn't compare approved moments against each other (a comparing judge would be a second judge mode).

---

## 4. Production test

**Not done: UNKNOWN — niet bewezen.**

Reasons:
- This sandbox has no API keys, no database, and no access to YouTube, OpenAI, Wikimedia, archive.org, Pexels, Freesound or a TTS service.
- Production was running older code until this push.

After this push to `main`, Railway deploys automatically. The real Kardashian/Kris Jenner test must therefore be run in production (via the app).

---

## 5. Remaining concrete problems before serious production testing

1. **Visuals budget (render 616).** Scenes 1–2 got `SCOPE_EXPIRED` after ~3 min and were never searched; the only adopted clip was then held for 68.8 s. Not changed this round. With the stricter judge this becomes even more important.
2. **No coverage rule for graphics/editorial text.** The planner plans graphics per sentence from what the sentence contains, and `onScreenTextDirector` removes duplicates and pop-ups. The requested "minimum 2 motion + 2 editorial text per started minute" (with a treatment selector) does **not** exist yet.
3. **No music or SFX in the repo.** Music/SFX come live from Freesound (`FREESOUND_API_KEY`). Without that key, the film has no music.
4. **The judge picks the first approved moment, not the best of several** (see section 3).

---

## 6. Status of the two large assignments ("VidRush-worthy" and "Remotion motion graphics")

| Requirement | Status |
|---|---|
| Judge unavailable → no adoption; reviewed=0 never a success | **Done** (fix 1) |
| Judge assesses the sentence, not just the person | **Done** (fix 2) |
| Right moment from a YouTube video via the judge | **Done** (fix 3), max 3–5 moments |
| Judge **compares** candidates (best, not first acceptable) | **Not done** (first approved wins) |
| What the judge sees: 3 frames at 20/50/80% of a moment | Unchanged; shots are now single shots, so 3 frames cover the moment |
| Person lock | **Done** (fix 5) |
| Source diversity before the DeliveryGate | **Done** (fix 4) |
| Archive through the same judge | **Done** (fix 1) |
| Real map + camera, chart with data, counter with easing/decimals, word timing | **Done** (fix 7) |
| Captions: box, wrapping, fonts | **Done** (fix 8) |
| Visual Intent richer (person + action + context + footage type in the query) | **Not changed this round** |
| Timelines (several years on a line), kinetic typography, diagram/comparison as components | **Not built** (timeline_event exists as a card; comparison has no component) |
| Treatment selector + coverage rule (2 motion + 2 editorial text per started minute) | **Not built** |
| Graphics avoid faces/action in the footage | **Not built** (avoid captions: yes; faces: no) |
| Remotion performance for 30/60 min | **Not measured** |
| Real production render ≥2 min with all elements | **Not possible here** (see section 4) |

---

## 7. Files (this round)

### New

- `server/youtubeMoments.ts`
- `server/remotion/components/GeoMap.tsx`
- `server/remotion/data/countries110m.json`
- `server/remotion/fonts.ts`
- `server/remotion/fonts/Inter.ttf`
- `server/remotion/fonts/Oswald.ttf`
- `server/remotion/fonts/NOTICE.txt`
- `server/remotion/assets.d.ts`
- Tests:
  - `judgeAlwaysLooks.test.ts`
  - `personLockOpeners.test.ts`
  - `youtubeMomentsAreJudged.test.ts`
  - `footageShareLowersPriority.test.ts`
  - `graphicsCarryRealData.test.ts`
  - `realMapChartCounterReachTheMp4.test.ts`

### Changed

- `server/adoptionPolicy.ts`
- `server/videoPipeline.ts`
- `server/beatImageRelevanceGate.ts`
- `server/sentenceOpeners.ts`
- `server/youtubeShotStock.ts`
- `server/usageDiversity.ts`
- `server/graphicsVocabulary.ts`
- `server/remotionProps.ts`
- `server/captionLayout.ts`
- `server/cinematicMotion/locationMap.ts`
- `server/cinematicEditingEngine/motionGraphicsPlanner.ts`
- `server/cinematicEditingEngine/types.ts`
- `server/onScreenTextDirector.ts`
- `server/edlToTimeline.ts`, `server/remotion/GraphicsOverlay.tsx`, `server/cinematicEditingEngine/captionPlanner.ts` (after the test video)
- `server/remotion/Root.tsx`
- `server/remotion/components/{Charts,Graphics,Text,animation}.tsx/ts`
- Tests updated (see section 2).

### Also in this commit

Earlier rounds that were not yet committed (editor work V1–V8: timeline editor, autosave/version history, audio fades, …).

---

## 8. Test video (made here, after the push) — and what it exposed

**How it was made:** a 9-sentence script about the Berlin Wall (people, places, years, a figure, a population series) through the **real** planner (`buildCinematicSceneInputs` → `runCinematicPipeline`) and the **production** render route (`renderTimeline` + Remotion overlay + ffmpeg). Result: 45 s, 1080p/30 fps, 9 graphics, 14 captions, music track mixed.

**Stand-ins (clearly marked in the frame):** footage (generated grain; YouTube/archive unreachable here), narration timing (evenly spread over each sentence; no TTS here), music (generated pad; Freesound unreachable). So the video shows the graphics/caption/edit layer, **not** clip selection or the judge.

The render exposed six real problems the tests did not. Each was fixed in the same round, with a test:

| Found in the render | Cause | Fix |
|---|---|---|
| The real map never appeared (all 3 switched off) | `onScreenTextDirector` rule 2 turned every `map_point` into a location card; rule 6 ranked a map as "other", so a loose "Berlin" word beat it | A map with lon/lat stays on and counts as the place's card (shown once, the first time); rule 4b does not merge a year into a map |
| Lower third "West Berlin"; "John F. Kennedy" missing; person lock on "West Berlin" | The name pattern broke at the middle initial; a compass word + place passed as a person; the primary-person function had no place check at all | Names with a middle initial read whole ("John F. Kennedy", "George W. Bush"); qualifier + place = place; the same place/thing check in the person lock |
| Counter "140" under three sentences | A scene's stat was placed under every beat of the scene | Only under the sentence that says the figure (counter and statistic caption) |
| Chart title "germany", line flat on 0–100 | Title was the lowercase subject; axis always started at zero | Title from the sentence's own measure ("Population of Germany"); a line chart of a small change uses its own range |
| Event card "1961 — border ran" | A clause fragment was used as an event name | A label ending in a verb is no event; the year becomes a date card |
| Captions repeated words ("1961, 1961,", "come down. down.") | A word straddling two captions was given to both (overlap rule in `edlToTimeline` and in the overlay); the joined word list then held it twice | A word belongs to the caption that holds its midpoint; the joined list is de-duplicated |

**What the final render shows (checked frame by frame):**
- The world map moves in to Europe, with Germany highlighted and a Berlin pin.
- Lower thirds: "John F. Kennedy" and "Ronald Reagan".
- Date cards: 1963, 1989 (typed in).
- Location card: "Brandenburg Gate · 1987".
- The counter counts to 140 under the sentence that says it.
- The line chart is titled "Population of Germany" (79.8 → 82.3 → 83.2 million) with a visible trend.
- Captions sit on a translucent plate as wide as the text, with no repeated words and no overflow.

**Still visible, not fixed:**
- The editing engine plans a "dust" effect on archive clips that the renderer does not execute (reported as "kept on the timeline, not executed").
- When a graphic is moved to its spoken word, it keeps its original end, so its time on screen can shrink to about 2 s.
