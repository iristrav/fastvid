# FASTVID — RAPPORT

Sessie van 22 september 2026. Twee rondes afgerond, twee commits klaar om te pushen.

---

## 1. Samenvatting

| | |
|---|---|
| Commits klaar (niet gepusht) | `780cd37`, `218c95d` |
| Branch | `main` |
| Testsuite | 754 bestanden, 12.398 tests groen, 0 rood |
| Typecheck | `tsc --noEmit` schoon |
| Laatste render | #VID-0599 — **mislukt** na 33 minuten |
| Lopende render | geen |

---

## 2. Wat render 599 werkelijk liet zien

### YouTube werkt end-to-end

Dit is de belangrijkste correctie van deze sessie. Ik had eerder gemeld dat YouTube-downloads faalden. Dat was fout — ik had naar één batch gekeken en daar een algemene conclusie uit getrokken.

Zes downloads zijn geslaagd in scène 1:

```
OqFhvKarYjU  RapidAPI       rPCWO-wZaLo  cloud service
FLal-KvTNAQ  62.500.468 b   z2kp1wkRE8o  36.990.505 b
aZbpVsQzBeU  17.874.368 b   7bx_yqMF3jc  28.151.510 b
```

Zoeken: `granted=45s`, `reserved=36000ms`, 68 kandidaten, query `"Hitler Führerbunker"` met zeven bewezen termen, nul `TURN_DECLINED`.

### Maar geen enkele YouTube-clip haalt de timeline

Nul `ASSIGNED provider=youtube_cc`. Alle toegewezen assets zijn `ww2` (eigen archief), `wikimedia`, `internet_archive` of `UNVERIFIED`.

### De reden is inhoudelijk, niet technisch

```
[BeatRelevance] s1b1 funnel:youtube_cc does_not_fit
  depicts="Young German soldier with Iron Cross, surrounded by other soldiers,
           1940s wartime setting. The text 'Willi Hübner' appears in one frame."
  reason="…does not specifically show a depiction relevant to the order Hitler issued"

[BeatRelevance] s1b1 funnel:youtube_cc does_not_fit
  depicts="A map with locations and military front labels related to WWII."
  reason="The map does not show anything directly related to the orders issued
          by Hitler in his final days… It focuses on the 1st Belorussian…"
```

**Dit zijn correcte weigeringen.** Een jonge soldaat met een IJzeren Kruis en een kaart van het 1e Wit-Russische Front gaan geen van beide over de bevelen die Hitler in de bunker gaf. De picture editor doet zijn werk.

### Belangrijke correctie op mijn eigen diagnose

Ik meldde eerder: *"twee clips door vision goedgekeurd en toch weggegooid — dat is het defect."* Dat klopte niet. Er zijn twee verschillende poorten:

| | wat het is | uitkomst |
|---|---|---|
| `passingScored` → 8,0 | CLIP-similariteit, een getal | passeerde |
| `beat_image_gate` | een VLM die naar de beelden kijkt | `does_not_fit` |

De 8,0 is een gelijkenisscore, geen goedkeuring. Mijn voorgestelde fix ("een goedgekeurde clip mag niet overruled worden") zou die twee ongeschikte clips de film in hebben geduwd — precies wat §48 van de eerdere opdracht verbiedt.

---

## 3. RONDE 626 — `"he issue"` (commit `780cd37`)

### Het defect

Beat-tekst: *"Yet, in his darkest hour, what orders did he issue?"*

```
action  "orders"
regel 2 \borders\b\s+(…)  →  "did he issue"  →  laatste twee woorden  →  "he issue"
```

`extractEventPhraseForQuery` leest de woorden ná het werkwoord als lijdend voorwerp. Dat klopt bij een mededelende zin. Een **vraagzin** zet het hulpwerkwoord en het onderwerp precies op de plek waar het lijdend voorwerp hoort.

Gevolg, gemeten:

```
[VisualIntent]     s1b1 subject=he issue event=he issue action=orders
[MismatchResearch] s1b1 correctedQuery="Heinrich Himmler Führerbunker he issue"
                        results=2 eligible=0 adopted=0
```

Alle negen providers kregen `"he issue"` als zoekterm. Elke kandidaat werd daartegen gerangschikt. De poorten beoordeelden dus beelden die opgehaald waren voor een frase die de beat nooit bedoelde.

**Dit is topic-onafhankelijk.** Elke beat die als vraag geformuleerd is, produceert dit.

### De fix

Hulpwerkwoorden en voornaamwoorden (`did`, `he`, `was`, `they`, …) **beëindigen** de reeks nu, in plaats van overgeslagen te worden. Overslaan is precies wat `"he issue"` opleverde — het liep door naar het volgende zinsdeel.

Blijft er minder dan twee inhoudswoorden over, dan valt hij terug op regel 3 — de weg die een beat zonder lijdend voorwerp altijd al nam.

Bezittelijke voornaamwoorden (`his`, `her`, `its`) staan bewust **niet** in de stoplijst, zodat `"dictated his final political testament"` gewoon `"political testament"` blijft geven.

Geen drempel, poort of ranking aangeraakt. Regels 1 en 3 onveranderd.

### Bewijs

Fix uitgezet als controle → **5 van 9 tests rood** (3 gedragstests + 2 bedradingstests). De sectie "er is niets versoepeld" bleef terecht groen.

---

## 4. RONDE 627 — seg_010 (commit `218c95d`)

### Wat er gebeurde

Een render wordt in elf segmenten gemaakt (`seg_000` … `seg_010`) en daarna aan elkaar geplakt met overgangen. Die laatste stap sneuvelde:

```
transition graph: Error while processing the decoded data for stream #10:0
[auto_scale_11] Failed to configure output pad on auto_scale_11
Error reinitializing filters!
```

### Waarom niemand kon zien wat er mis was

Die eerste regel **noemt geen oorzaak** — alleen "het ging mis bij invoer 10".

Er bestaat een functie (`ffmpegComplaint`) die juist gebouwd is om nietszeggende regels weg te filteren en de échte oorzaak vooraan te zetten. ffmpeg produceerde vier regels; **drie stonden op die filterlijst, deze ene niet.** Dus precies de enige regel zonder oorzaak werd gekozen als "de oorzaak".

En dit bestand wist het al. Er staat letterlijk:

> *"ffmpeg then names an INPUT rather than the mismatch: `Error while processing the decoded data for stream #10:0`, which is what render 597 died on."*

### Twee bekende oorzaken uitgesloten — met metingen

| Render | Oorzaak | Geldt voor 599? |
|---|---|---|
| 596 | geometrie: `1920x1078` vs `1920x1080` (letterbox croppte en padde terug) | **Nee** — ffmpeg noemde geen enkele maat |
| 597 | duurdrift: segment korter dan de graaf dacht | **Nee** — `unprobed=0 drifted=0` |

`[SegmentSpan] segments=11 unprobed=0 drifted=0 askedTotal=74.65s graphTotal=74.65s` — elk segment gemeten, geen enkele week af.

### Wat ik gedaan heb, en wat níét

**seg_010 is niet gerepareerd.** Ik weet nog steeds niet wat eraan mankeert, want ffmpeg heeft het nooit opgeschreven, en ik ga geen derde oorzaak verzinnen die goed klinkt.

Wat wel:

1. **De foutmelding liegt niet meer.** De stream-regel staat nu op de filterlijst.
2. **De fout meet zichzelf.** Bij een mislukte samenvoeging worden alle elf segmenten gemeten op de vier eigenschappen die `xfade` en `concat` vergelijken — breedte, hoogte, pixelformaat, beeldverhouding, tijdbasis — en het afwijkende segment wordt benoemd:

```
[SegmentShape] the transition graph failed — reference=width=1920 height=1080 … odd=1
[SegmentShape]   seg_010.mp4 width=1920 height=1078 …
```

De referentie is de **meerderheid**, niet het eerste segment — anders wijst een afwijkende `seg_000` de andere tien als kapot aan.

Er wordt niets genormaliseerd. Een segment met de verkeerde vorm is een fout in `renderSegment`; dat daar stil rechttrekken zou de oorzaak verbergen. De fout wordt onveranderd doorgegooid.

**Bug gevangen tijdens het schrijven:** de eerste versie printte "elk segment heeft dezelfde vorm" ook wanneer er géén segment gemeten kon worden — een bewering over een meting die nooit gedaan is. Dat geval zegt nu expliciet dat het niets weet.

---

## 5. Bewust NIET aangeraakt: de cloud-downloadroute

Gemeten in scène 1 van render 599:

```
Cloud DL service error 502: "Sign in to confirm you're not a bot"
Cloud DL failed z2kp1wkRE8o: exceeded 117s → RapidAPI slaagt in seconden
Cloud DL failed FLal-KvTNAQ: exceeded 117s → RapidAPI slaagt in seconden
Cloud DL failed aZbpVsQzBeU: exceeded  84s → RapidAPI slaagt in seconden
Cloud DL failed 7bx_yqMF3jc: exceeded  54s → RapidAPI slaagt in seconden
```

De scène kreeg 276s en gebruikte er 280. Vijf latere kandidaten vielen daardoor onder de 12s-vloer.

**Waarom ik het niet gefixt heb:** de commentaren in de code laten zien dat precies mijn fix al twee keer overwogen is en één keer betaald:

> *"Render 582 is what the old rule cost once the proxy existed: one bot check closed the cloud route, and all 48 later attempts fell to RapidAPI, which downloads the WHOLE source before it trims… The latch closed the only door that could still have opened."*

> *"Deliberately NOT 'try the fast one first'. That bets on which route is broken today."*

RapidAPI haalt de hele bronvideo op; de cloud-route alleen de seconden die de beat nodig heeft. Die route degraderen is wat render 582 de das om deed.

Wat wel toegevoegd is: **een meetregel**, omdat het ene getal dat nodig is om hierover te beslissen niet bestaat — hoelang duurt deze route wanneer hij *wel* slaagt?

```
[YouTubeCloudTiming] video=… scene=… outcome=DOWNLOAD_SUCCESS ms=… grantedMs=… scopeLeftAtStartMs=…
```

Verandert geen gedrag. Levert het bewijs waarmee een plafond uit een meting komt in plaats van uit een rekensom.

---

## 6. Open punten

1. **seg_010 zelf** — gediagnosticeerd maar niet opgelost. De volgende render noemt de oorzaak in één regel.
2. **YouTube-kandidaten passen inhoudelijk niet** — mogelijk deels opgelost door `"he issue"`; te bewijzen met een render.
3. **`YOUTUBE_NOT_SEARCHED` vs `YOUTUBE_NO_RESULTS`** — de turn wordt verkeerd geboekt terwijl `attempted=true`. Corrumpeert de telling in het eindrapport. Nog niet gefixt.
4. **`graphics_overload`** — 13 graphics per minuut gepland tegen een drempel van 12; de waarschuwing doet niets.
5. **Cloud-route economie** — meting toegevoegd, beslissing uitgesteld tot er data is.

---

## 7. Wat ik nodig heb

Twee commits staan klaar. Een push triggert een Railway-deploy; er loopt nu geen render, dus dat is op dit moment veilig.

Daarna is één render genoeg om twee vragen tegelijk te beantwoorden:
- wat is er mis met seg_010 (`[SegmentShape]`);
- levert de betere zoekopdracht bruikbare YouTube-kandidaten op.

**Ik kan zelf geen render starten** — dat loopt via `assertUserCanEnqueueVideo`, alleen jij kunt er een in de wachtrij zetten.

---
---

# TOEGEVOEGD: FASTVID — MANDATORY FINAL HARDENING PATCH

PRODUCTION RECOVERY + GUARANTEED DELIVERY + ZERO TERMINAL FAILURE

IMPORTANT:
This is an ADDITION to the previous master prompt I just gave you.

DO NOT start a product render yet.

DO NOT stop after implementing only part of this.

DO NOT ask me for approval between phases.

DO NOT tell me that the architecture is complete merely because TypeScript/build/tests pass.

First inspect the implementation created by the previous prompt, then implement EVERYTHING in this patch that is missing.

Only AFTER all implementation, tests, recovery logic, observability, and delivery safeguards are complete may you perform ONE final real production render to prove the entire system works.

============================================================
0. NEW ABSOLUTE PRODUCT INVARIANT
============================================================

FastVid must be designed around this principle:

GENERATE MUST END IN A VALID VIDEO WHENEVER A VALID TECHNICAL RECOVERY PATH EXISTS.

A recoverable production problem must NEVER directly become:

FAILED
DELIVERY_BLOCKED
RENDER_FAILED

without first exhausting the appropriate automatic recovery strategies.

The system must distinguish:

1. CONTENT QUALITY FAILURE
2. MEDIA RETRIEVAL FAILURE
3. MEDIA AVAILABILITY FAILURE
4. MEDIA REHYDRATION FAILURE
5. MEDIA DECODING FAILURE
6. MEDIA COMPATIBILITY FAILURE
7. TRANSITION/EFFECT FAILURE
8. TIMELINE FAILURE
9. AUDIO/MUX FAILURE
10. FFMPEG FAILURE
11. RESOURCE/TIMEOUT FAILURE
12. STALE PRODUCTION LOCK
13. DELIVERY VALIDATION FAILURE

Each class must have an explicit recovery path.

============================================================
1. DO NOT RENDER UNTIL THE WHOLE RECOVERY SYSTEM EXISTS
============================================================

Before the final product render:

- inspect all current failure paths;
- inspect all delivery gates;
- inspect all render gates;
- inspect all asset validation/revalidation;
- inspect all timeline construction;
- inspect all media rehydration;
- inspect all FFmpeg invocation;
- inspect all transition/effect processing;
- inspect all production locks;
- inspect all timeout handling;
- inspect all placeholder handling.

Find every place where code currently does something equivalent to:

return false
throw
reject
FAILED
RENDER_FAILED
DELIVERY_BLOCKED
ASSET_NOT_FOUND
ASSET_NOT_REHYDRATABLE
NO_MEDIA
NO_MATCH
TIMEOUT

and determine whether that failure should instead enter the recovery system.

Do NOT blindly remove legitimate hard safety gates.

Do NOT weaken visual quality, semantic matching, rights validation, or real-media requirements.

Instead, RECOVER first.

============================================================
2. BUILD A CENTRAL PRODUCTION RECOVERY ENGINE
============================================================

Create one centralized recovery mechanism.

Conceptually:

Production
  ↓
Prepare
  ↓
Validate
  ↓
Render
  ↓
Failure?
  ↓
ProductionRecoveryEngine
  ↓
classify failure
  ↓
select recovery strategy
  ↓
repair
  ↓
revalidate
  ↓
retry
  ↓
final MP4 validation

Do not implement unrelated duplicate recovery systems in multiple modules.

There must be one authoritative recovery policy.

The recovery engine must have:

- failure classification;
- retry limits;
- recovery attempt tracking;
- per-stage diagnostics;
- deterministic fallback order;
- idempotent recovery;
- no infinite loops;
- no duplicate asset adoption;
- no duplicate rendering jobs;
- complete recovery telemetry.

Every recovery attempt must have a reason.

Example:

RECOVERY_STARTED
failure=ASSET_NOT_REHYDRATABLE
scene=2.4
asset=...
strategy=REPLACE_APPROVED_MEDIA

RECOVERY_SUCCEEDED
scene=2.4
replacement=...

============================================================
3. ASSET_NOT_FOUND / ASSET_NOT_REHYDRATABLE
============================================================

These errors MUST NOT immediately terminate production.

If an asset referenced by the timeline cannot be found or rehydrated:

STEP 1:
Try normal rehydration.

STEP 2:
Try the canonical asset source / lineage.

STEP 3:
Try cached/local representation where valid.

STEP 4:
If still unavailable, invalidate that asset.

STEP 5:
Request a replacement through the central Media Engine.

STEP 6:
Replacement must pass the SAME ApprovedMedia gates as every other asset.

STEP 7:
Patch the authoritative timeline/project representation.

STEP 8:
Revalidate the affected scene.

STEP 9:
Continue rendering.

Never silently keep a broken asset reference.

Never insert a placeholder.

Never leave a dead asset ID in the final timeline.

The final timeline must contain only renderable media.

============================================================
4. ZERO-MATCH SCENE RECOVERY
============================================================

If a scene reports:

0 voice/script-matched clips
NO_MATCH
INSUFFICIENT_REAL_VISUAL_COVERAGE
NO_ELIGIBLE_MEDIA

do NOT immediately block the entire production.

The recovery sequence must be:

1. retry the existing retrieval;
2. expand/rewrite the visual query;
3. search YouTube again;
4. search the own FastVid archive;
5. search open web;
6. use other approved fallback sources;
7. use additional candidates already fetched;
8. re-rank candidates;
9. retry Vision/semantic validation where appropriate;
10. allow shorter valid clips where editorially valid;
11. allow multiple valid clips for one sentence/beat;
12. rebuild coverage;
13. patch the timeline;
14. revalidate.

Important:

DO NOT lower the semantic/quality/rights gates simply to manufacture coverage.

If no single clip covers an entire sentence, use multiple valid clips.

Coverage is about the scene being visually supported, not necessarily one clip per sentence.

============================================================
5. YOUTUBE RECOVERY
============================================================

YouTube remains SOURCE PRIORITY #1.

Do not silently give up on YouTube because of a single failed query, download, timeout, or candidate.

If a YouTube candidate fails:

- try another candidate;
- try another query variant;
- try another relevant YouTube result;
- use cached metadata/thumbnails when possible;
- use existing downloaded candidates where valid;
- continue in parallel with other providers;
- never let YouTube failure deadlock the whole scene.

YouTube must receive a fair and explicit retrieval opportunity.

But:

YouTube must still pass:
- content fit;
- semantic/visual validation;
- identity/entity checks;
- temporal/location checks;
- rights/licensing rules;
- media integrity;
- technical renderability.

Do not accept bad footage merely because it is YouTube.

============================================================
6. OWN FASTVID ARCHIVE RECOVERY
============================================================

SOURCE PRIORITY MUST REMAIN:

1. YouTube
2. OWN FASTVID MEDIA ARCHIVE
3. OPEN WEB
4. OTHER APPROVED FALLBACKS

If YouTube fails, the own FastVid archive must receive its full opportunity before falling further down the fallback ladder.

Audit the existing archive implementation.

Make sure archived assets have:

- stable identity;
- source lineage;
- local/canonical retrieval path;
- technical metadata;
- semantic metadata where available;
- renderability validation;
- rehydration support.

An archive asset that disappears must follow the same recovery system.

============================================================
7. OPEN WEB / WEB PAGE VISUALS
============================================================

Open-web sources may include:

- relevant article pages;
- historical pages;
- institutional pages;
- documents;
- screenshots;
- maps;
- public records;
- other approved web visuals.

These are first-class visual candidates when appropriate.

But screenshots/web visuals must still pass:

- relevance;
- readability;
- visual quality;
- rights/source policy;
- technical renderability.

Do not use random webpages merely to fill empty timeline space.

============================================================
8. TRANSITION / EFFECT FAILURE RECOVERY
============================================================

A transition/effect failure must NEVER automatically kill the whole render.

If:

transition graph failed
decoded data error
filter error
effect error
animation error
unsupported media operation

then:

LEVEL 1:
retry the operation.

LEVEL 2:
retry with a safer implementation.

LEVEL 3:
replace the transition with a simpler valid transition.

LEVEL 4:
fall back to crossfade if supported.

LEVEL 5:
fall back to hard cut.

For example:

complex transition
→ safe transition
→ crossfade
→ hard cut

The visual media itself must remain intact whenever possible.

A technically simpler transition is acceptable.

A failed entire video is not.

============================================================
9. SAFE RENDER MODE
============================================================

Implement a real SAFE_RENDER mode.

NORMAL_RENDER:
- full cinematic editing;
- transitions;
- effects;
- motion;
- captions;
- graphics;
- audio;
- all approved editorial treatments.

If normal rendering fails:

SAFE_RENDER:
- validated real media only;
- correct durations;
- voice-over;
- music/audio where valid;
- captions where safe;
- simple cuts;
- minimal effects;
- no risky transitions;
- no unsupported filters;
- no unnecessary render complexity.

Safe render must preserve:

- full story;
- full narration;
- real visuals;
- scene order;
- timing;
- audio;
- captions where possible.

SAFE_RENDER IS NOT A QUALITY GATE BYPASS.

It is a technical rendering fallback.

Never replace real media with placeholders.

Never lower semantic media quality simply to make the render pass.

============================================================
10. FFMPEG FAILURE RECOVERY
============================================================

FFmpeg failure must be classified.

Capture:

- command;
- exit code;
- stderr;
- affected scene/asset;
- filter graph;
- input files;
- output path;
- render mode.

Then automatically determine whether the failure is:

- asset-related;
- codec-related;
- filter-related;
- transition-related;
- duration-related;
- audio-related;
- mux-related;
- resource-related.

Recovery examples:

bad asset
→ replace asset

bad filter
→ remove/replace filter

bad transition
→ safe transition/hard cut

bad audio segment
→ regenerate/re-encode/rebuild that segment

mux issue
→ rebuild audio/video streams safely

complex render failure
→ SAFE_RENDER

Do not blindly retry the exact same failing FFmpeg command indefinitely.

============================================================
11. AUDIO / MUX RECOVERY
============================================================

The final render must validate:

- narration duration;
- timeline duration;
- music duration;
- SFX duration;
- audio mix duration;
- video duration;
- muxed output duration.

Never use `-shortest` or equivalent behavior as an unexplained escape hatch that silently truncates the video.

If audio and video durations disagree:

1. diagnose;
2. determine intended authoritative timeline duration;
3. extend/trim the appropriate stream safely;
4. rebuild;
5. validate again.

The final MP4 must represent the complete intended video.

============================================================
12. TIMELINE REPAIR
============================================================

There must be ONE authoritative timeline.

If recovery replaces an asset, changes duration, removes an effect, or simplifies a transition:

the authoritative timeline must be patched.

Do not patch only a render-local array.

Do not maintain separate competing timelines.

After recovery:

Project
→ authoritative timeline
→ render input
→ renderer

must all agree.

Validate:

- no missing assets;
- no orphaned asset IDs;
- no impossible durations;
- no negative durations;
- no overlapping invalid segments;
- no missing scenes;
- no placeholder media;
- no unrenderable references.

============================================================
13. PLACEHOLDER ABSOLUTE RULE
============================================================

Placeholders may exist internally only as temporary state.

They MUST NOT:

- enter the final authoritative timeline;
- enter render input;
- be rendered;
- be used as fake coverage;
- satisfy delivery coverage.

If a placeholder is encountered before rendering:

RECOVER.

Do not simply delete the scene.

Do not silently accept reduced coverage.

Retrieve/replace/rebuild.

Final validation must fail if ANY placeholder reaches render input.

============================================================
14. PRODUCTION LOCK / STALE JOB RECOVERY
============================================================

Fix the:

"A production render is already running"

failure class.

There must be one authoritative production job/lock state.

Track:

- production ID;
- project ID;
- status;
- startedAt;
- heartbeat;
- lastProgressAt;
- worker identity;
- render stage.

If a worker is genuinely active:

reuse/continue the existing production state rather than starting a duplicate.

If the job is stale:

detect stale heartbeat/timeout;
mark stale;
release the lock safely;
resume/restart production.

Never leave the project permanently blocked because of a crashed worker.

Never allow two authoritative production renders to mutate the same project simultaneously.

============================================================
15. TIMEOUT RECOVERY
============================================================

A timeout must NEVER automatically equal final failure.

Every timeout must specify:

- what timed out;
- why;
- whether partial work is reusable;
- whether retry is safe;
- whether another provider can continue;
- whether cached results exist.

For media retrieval:

timeout
→ reuse cache
→ retry
→ alternate candidate
→ alternate provider
→ continue.

For rendering:

timeout
→ determine stage
→ isolate expensive operation
→ simplify if safe
→ retry
→ SAFE_RENDER if necessary.

Never wait indefinitely.

Never fail prematurely.

============================================================
16. NO INFINITE RETRY LOOPS
============================================================

All recovery must be bounded.

Each stage needs:

- maximum attempts;
- maximum total recovery time;
- deduplication;
- attempt identity;
- failure history.

Do not repeatedly retry an asset/provider that has already proven unusable.

Move to the next recovery strategy.

============================================================
17. SPEED WITHOUT QUALITY REDUCTION
============================================================

The system must become faster through:

- parallel provider searches;
- parallel safe candidate downloads;
- caching;
- thumbnail/metadata ranking before expensive downloads;
- deduplication;
- reuse of already validated media;
- reuse of successful intermediate results;
- early failure classification;
- scene-level parallelism where safe.

DO NOT speed up by:

- lowering Vision thresholds;
- accepting irrelevant media;
- skipping rights checks;
- skipping identity checks;
- accepting placeholders;
- reducing real visual coverage;
- randomly shortening the story;
- blindly cutting scenes;
- silently dropping narration.

============================================================
18. RESOURCE FAIRNESS
============================================================

One failing provider must not consume the entire production budget.

One scene must not starve all other scenes.

YouTube must receive its intended opportunity.

Archive must receive its intended opportunity.

Open web must receive its intended opportunity.

Use bounded per-provider and per-scene budgets.

Do not create hidden render-wide counters that starve valid sources.

All budget decisions must be centralized.

============================================================
19. FINAL DELIVERY GATE
============================================================

The delivery gate must verify the ACTUAL OUTPUT FILE.

Not just the timeline.

Not just metadata.

Not just tests.

Not just render logs.

Verify:

1. output exists;
2. output is non-zero;
3. MP4 container is valid;
4. video stream exists;
5. audio stream exists when required;
6. duration is greater than zero;
7. duration is within acceptable tolerance of intended duration;
8. video is decodable;
9. audio is decodable;
10. no placeholder media;
11. all scenes are represented;
12. output can be opened by the player;
13. render completed successfully;
14. final project references the actual delivered output.

Only then:

DELIVERY_SUCCESS

============================================================
20. DELIVERY FAILURE MUST CONTAIN EXHAUSTION PROOF
============================================================

If, and ONLY if, the system ultimately cannot produce a video, the failure report must explain:

- every recovery strategy attempted;
- every provider attempted;
- every failed asset;
- every replacement attempted;
- every render mode attempted;
- every FFmpeg failure;
- every timeout;
- why each recovery path failed;
- whether any valid media remained;
- whether SAFE_RENDER was attempted;
- why a valid MP4 could not be produced.

Never return a generic:

"Render failed."

============================================================
21. OBSERVABILITY
============================================================

Add explicit lifecycle events for recovery:

RECOVERY_STARTED
RECOVERY_ATTEMPTED
ASSET_REHYDRATE_STARTED
ASSET_REHYDRATE_FAILED
ASSET_REPLACEMENT_STARTED
ASSET_REPLACED
SCENE_COVERAGE_RECOVERY_STARTED
SCENE_COVERAGE_RECOVERED
TRANSITION_FALLBACK
EFFECT_FALLBACK
FFMPEG_RECOVERY_STARTED
SAFE_RENDER_STARTED
SAFE_RENDER_SUCCEEDED
STALE_LOCK_RECOVERED
TIMELINE_PATCHED
FINAL_OUTPUT_VALIDATED
DELIVERY_SUCCESS

Make these visible in production logs and useful in the dashboard.

The user should not have to guess why a production is stuck.

============================================================
22. DASHBOARD BEHAVIOR
============================================================

The UI must not merely show:

FAILED
Retry

when automatic recovery is possible.

During recovery show meaningful states such as:

Generating
Finding visuals
Retrying YouTube
Checking archive
Replacing unavailable media
Repairing scene
Recovering render
Simplifying transition
Retrying FFmpeg
Safe render
Validating final video
Delivered

Only show FAILED after recovery exhaustion.

============================================================
23. TEST THE FAILURE CASES BEFORE FINAL RENDER
============================================================

Add/extend tests for at least:

- missing asset;
- asset rehydration success;
- asset rehydration failure + replacement;
- zero matching clips;
- YouTube download failure;
- YouTube timeout;
- archive retrieval failure;
- open-web retrieval failure;
- transition failure;
- effect failure;
- FFmpeg failure;
- audio/video duration mismatch;
- mux failure;
- stale production lock;
- worker timeout;
- placeholder reaching timeline;
- placeholder reaching render input;
- successful SAFE_RENDER;
- failed SAFE_RENDER;
- timeline patch after replacement;
- final MP4 validation;
- recovery exhaustion;
- duplicate recovery prevention;
- duplicate render prevention.

Use deterministic mocks/fixtures where possible.

Do not rely only on unit tests.

============================================================
24. DO NOT DESTROY EXISTING GOOD FASTVID BEHAVIOR
============================================================

Preserve existing working functionality unless there is a concrete reason to change it.

Especially preserve:

- existing visual intelligence;
- existing Vision validation;
- existing rights logic;
- existing YouTube lifecycle;
- existing own archive retrieval;
- existing source lineage;
- existing asset identity;
- existing thumbnail ranking;
- existing semantic matching;
- existing cinematic editing capabilities;
- existing golden tests;
- existing geometry protections.

The goal is:

UNIFY + HARDEN + RECOVER

not:

REWRITE EVERYTHING FOR NO REASON.

============================================================
25. ARCHITECTURAL RULE
============================================================

There must be a clear chain:

SCRIPT
↓
VISUAL INTELLIGENCE
↓
MEDIA ENGINE
↓
APPROVED MEDIA
↓
AUTHORITATIVE PROJECT/TIMELINE
↓
RENDER ENGINE
↓
RECOVERY ENGINE WHEN NEEDED
↓
FINAL MP4 VALIDATION
↓
DELIVERY

Do not create another parallel production pipeline.

Do not create another competing timeline.

Do not create another renderer.

Do not create another independent asset identity system.

Do not create another independent YouTube cascade.

Reuse and consolidate existing implementations.

============================================================
26. FINAL REAL PRODUCTION RENDER
============================================================

DO NOT perform a real product render until:

- implementation is complete;
- tests are complete;
- recovery paths exist;
- safe render exists;
- asset rehydration is handled;
- timeline repair exists;
- stale locks are handled;
- final MP4 validation exists;
- delivery gate is correct;
- observability is present.

Then perform ONE real end-to-end production.

Use a realistic documentary topic.

The test MUST exercise:

- YouTube;
- own FastVid archive;
- open web where appropriate;
- real visual matching;
- narration;
- music/audio;
- captions;
- transitions/effects;
- timeline;
- rendering;
- delivery validation.

Do not declare success because generation starts.

The proof of success is:

A COMPLETE, PLAYABLE, VALIDATED FINAL MP4.

============================================================
27. IF THE FINAL RENDER FAILS
============================================================

Do NOT stop at the first error.

Use the recovery system.

Investigate the failure.

Patch the implementation if necessary.

Run tests for the discovered failure.

Retry the production.

If advanced rendering fails:

SAFE_RENDER.

If an asset fails:

REPLACE.

If a transition fails:

SIMPLIFY.

If FFmpeg fails:

ISOLATE + RECOVER.

If an asset disappears:

REHYDRATE + REPLACE.

If a lock is stale:

RECOVER LOCK.

If a provider times out:

CONTINUE WITH THE NEXT VALID PATH.

Continue until either:

A) a validated complete MP4 is produced,

OR

B) every technically valid recovery path has genuinely been exhausted.

Do NOT stop at the first failure.

============================================================
28. FINAL REPORT
============================================================

Only after everything is complete, report:

1. What was implemented.
2. What duplicate/legacy paths were consolidated.
3. What recovery mechanisms were added.
4. How ASSET_NOT_FOUND is handled.
5. How ASSET_NOT_REHYDRATABLE is handled.
6. How zero-coverage scenes are recovered.
7. How YouTube failures are recovered.
8. How archive failures are recovered.
9. How transition/effect failures are recovered.
10. How FFmpeg failures are recovered.
11. How audio/video duration mismatch is handled.
12. How stale production locks are handled.
13. How SAFE_RENDER works.
14. How placeholders are prevented.
15. How final MP4 validation works.
16. Test results.
17. The final real production render result.
18. Exact final MP4 path/URL.
19. Exact production ID.
20. Any remaining known limitations.

CRITICAL:

Do not say "complete" merely because the code builds.

Do not say "production-ready" merely because tests pass.

The system is only proven when the real end-to-end production has produced and validated a complete MP4.

============================================================
FINAL COMMAND
============================================================

Implement this entire hardening patch on top of the previous master prompt.

Do not ask me questions.

Do not pause between phases.

Do not perform an interim product render.

Do not wait for my approval.

Inspect the existing code first.

Reuse what already works.

Implement all missing recovery and delivery mechanisms.

Run the complete relevant test suite.

Fix failures.

Only after ALL required implementation and tests are complete, perform the ONE final end-to-end production render.

The final objective is not:

"the pipeline ran."

The final objective is:

"FastVid accepted a user request, automatically produced a complete documentary video using real validated media, rendered it successfully, validated the actual MP4, and delivered it without requiring the user to manually repair the production."

THAT is the definition of DONE.
