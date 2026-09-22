# FASTVID V1 — FULL PIPELINE AUDIT

Audit only. No code was changed, no refactor performed, nothing deleted. Every claim below cites a
file and a symbol I opened. Where I did not open it, it says **ONBEKEND**.

---

## Executive Summary

**The architecture you describe as the V1 target is, for the most part, already the architecture
that is implemented.** That is the single most important finding, and it was not what I expected
after four rounds of briefs describing it as missing.

`server/sourcingTiers.ts:39` contains, literally:

```ts
export const SOURCING_TIERS = ["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES", "STOCK"] as const;
```

That is your requested priority, enforced centrally, with a ladder that records per beat which
tiers were attempted and which were explicitly declined.

**What is actually wrong is narrower and more boring than the briefs assume:**

1. The last real render (#599) **failed**, and the six fixes for it are **committed but not pushed**,
   so they are not deployed.
2. YouTube works end to end — searched, downloaded, judged — but **zero YouTube clips reached the
   timeline**, because the picture editor correctly refused the ones it was offered.
3. There are **two edit representations** (`EditorScene[]` and `ProjectTimeline`) with two
   `replaceClip` routes. This is a genuine two-truths problem.
4. **AI visual fallback exists** but is off unless `KLING_API_KEY` is set.
5. **Open-web screenshotting does not exist.** `web_wide` is a tier entry; there is no browser.

**The gap between current state and V1 is not architectural. It is: deploy what is fixed, prove one
render end-to-end, then close the edit-representation split.**

---

## 1. Current End-to-End Pipeline

Traced from the tRPC entry point to the MP4. Names are the real symbols.

```
USER PROMPT
  └─ routers.ts:1177  assertUserCanEnqueueVideo(ctx.user.id)     ← the enqueue gate
     routers.ts:1188  createVideo(...)
     routers.ts:1201  enqueueVideoJob(videoId, coverageNote)

WORKER
  └─ videoPipeline.ts:46467  runVideoPipeline()
     videoPipeline.ts:46633  _runVideoPipelineInner()

  1. SCRIPT          routers.ts:403   generateScriptOnly()
                     _core/llm.ts     provider resolved at runtime (groq | openai | gemini)
                     routers.ts:515   buildScriptLengthRefinePrompt() — a second pass that
                                      re-lengths the script if it missed its word budget
                     routers.ts:572   attachScriptVisualKeywords()

  2. SCENES          videoPipeline.ts:46805  parseScriptIntoScenes(script, maxScenes, topicContext)
                     then sanitizeSceneStockQueries / sanitizeSceneForMuskTopic /
                          sanitizeSceneForPersonTopic

  3. VOICEOVER       videoPipeline.ts:46991  generateBulkSceneVoiceovers(scenes, audioPaths, …)
                     videoPipeline.ts:8324   VoiceoverProvider = elevenlabs | fish-audio
                                             | google-tts | silent

  4. VISUAL INTENT   beatVisualIntent.ts:92  buildBeatVisualIntent({ ctx, contract })
                     searchQueryContract.ts:112  VerifiedQueryContext

  5. SOURCING        centralVisualSourcing.ts  the tier ladder
                     sourcingTiers.ts:39       YOUTUBE → OWN_ARCHIVE → OPEN_SOURCES → STOCK
                     scenePool.ts              parallel candidate pool per scene

  6. VALIDATION      beatVisualRelevance.ts    the picture editor (VLM)
                     beatImageRelevanceGate.ts the per-beat gate
                     technicalMediaGate.ts     resolution / size floors

  7. TIMELINE        cinematicPipeline.ts:326  translateEdl({...})  → ProjectTimeline
                     projectTimeline.ts:599    ProjectTimeline, TIMELINE_SCHEMA_VERSION = 1

  8. RENDER          renderJobWorker.ts:662→   deps.render({ timeline, … })
                     timelineRenderer.ts       renderSegment() per clip
                                               buildTransitionGraph() joins them
                     timelineFilters.ts        containChain / coverChain / cameraChain /
                                               effectChain / buildTransitionGraph

  9. DELIVERY        deliveryGate.ts:150       deliveryGate(input)
                     renderJobWorker.ts:943    called WITH real file facts
                     videoPipeline.ts:52778    called with `delivered: null, assetsOnly: true`

 10. MP4
```

**Two render routes exist**, and the delivery gate knows it:
`route: cinematicDeliveredUrl ? "cinematic_timeline" : "legacy_compose"`
(`videoPipeline.ts:52556`, `:52780`, `:52873`). `deliveryGate.ts:133` blocks a `legacy_compose`
delivery that carries a cinematic refusal unless `legacyFallbackDeliveryAllowed()` is set. So legacy
compose **cannot silently become the delivery** — it is gated and logged as `RENDER_FALLBACK_USED`.

---

## 2. Script Pipeline

| Question | Answer | Evidence |
|---|---|---|
| Waar gemaakt | `generateScriptOnly()` | `routers.ts:403` |
| Model/API | runtime-resolved: groq / openai / gemini | `_core/llm.ts:298-342` |
| Default models | groq `openai/gpt-oss-20b` (fast) + `openai/gpt-oss-120b` (heavy); gemini `gemini-3.6-flash` | `_core/llm.ts:321-340` |
| Fallback bij failure | provider-naar-provider fallback op 429/401, met cooldown | `_core/llm.ts:444-517` |
| Lengte-correctie | tweede pass die hersschrijft als het woordbudget gemist is | `routers.ts:515-531` |
| On-topic check | `scriptStillOnTopic(prompt, refined)` — een herschrijving die van onderwerp afdwaalt wordt verworpen | `routers.ts:519` |
| Metadata | titel, beschrijving, tags, chapters via LLM | `routers.ts:547-572` |
| Opslag | `videos` tabel | `db.ts` |

**Oordeel: WERKT.** Dit is niet een V1-blocker.

---

## 3. Scene Planning

`parseScriptIntoScenes(script, maxScenes, topicContext, pipelineStepTiming)` —
`videoPipeline.ts:46805`, step label `"scene_generation"`.

Daarna drie sanitizers die onderwerp-lock afdwingen. `sanitizeSceneForMuskTopic` en
`sanitizeSceneForPersonTopic` zijn onderwerp-specifiek in hun *naam* maar generiek in gebruik.

**Scènes en voice-over zijn gekoppeld**: `generateBulkSceneVoiceovers(scenes, audioPaths, …)`
produceert `durations`, en die durations sturen de timing. Zie ook `voiceBeatAlignment.ts` en
`voiceTtsAlignment.ts`.

---

## 4. Visual Intent

`buildBeatVisualIntent()` — `beatVisualIntent.ts:92`. Velden (regel 38-63):

```
subject, action[], event[], location[], period[], people[], objects[],
evidenceRequirement: "hard" | "soft" | "none",
preferredShot, fallbackClass, narrativePurpose, forbidden[], foldedTerms[]
```

`subject` wordt gekozen in een expliciete autoriteitsvolgorde (regel 109):

```ts
mustContain[0] ?? event[0] ?? people[0] ?? location[0] ?? objects[0] ?? action[0] ?? ""
```

**Negatieve termen: JA** — `forbidden[]`, uit `contract.forbiddenContent`.
**Meerdere queries: JA** — `buildPrioritisedQueries()` in `mediaResearchEngine.ts`.
**Queries worden aangepast na slechte resultaten: JA** — `[MismatchResearch]`, strategie
`ADD_PERSON` etc.

**Wordt het daadwerkelijk gebruikt: JA.** Bewezen in render 599:
`[VisualIntent] s1b1 subject=… event=… action=… want=NEWS ok=NEWS|REAL_FOOTAGE|PHOTO|B_ROLL`
en `[HardMatch] s1b1 winner=0/2 missed=[event,action]` — het intent stuurt de ranking echt.

**Bekende zwakte, deze sessie gevonden en gefixt (R626):** `extractEventPhraseForQuery` las bij een
vraagzin het hulpwerkwoord + voornaamwoord als lijdend voorwerp. *"what orders did he issue?"* werd
`"he issue"`, en dat ging naar alle negen providers. Gefixt in `mediaResearchEngine.ts`
(`EVENT_PHRASE_STOP`), commit `780cd37`. **Nog niet gedeployed.**

---

## 5. YouTube Pipeline

### Search

| | |
|---|---|
| Providers | `youtube_cc` (download-zijde), `youtube` (search-zijde) — één bron, twee labels |
| Tier | 1, de hoogste — `sourcingTiers.ts:56-59` |
| Queries per scène | meerdere varianten; gemeten in 599: 6 per beat (3 licentiefilters × 2 querys) |
| Filters | `#any`, `#creative_common`, `#youtube` + `#n50` + `#dshort`/`#dmedium` |
| Audit | `[SearchQueryAudit]` met `terms=[]` en `blockedTerms=[]` per query |

Gemeten in render 599:
```
[ScenePool] Scene 1: 68 candidates … calls: youtube_cc=2 … ms: youtube_cc=549
[SearchQueryAudit] query="Hitler Führerbunker#creative_common#n50#dmedium" status=ALLOWED
  verified=true terms=["Hitler","Heinrich Himmler","Hermann Göring","Nero Decree",
  "Albert Speer","Führerbunker","orders"] blockedTerms=[] reason=OK
```

**De zoekopdracht is inhoudelijk goed en de gate laat hem door.**

### Download

Twee routes, in deze volgorde: eigen yt-dlp cloud service → RapidAPI fallback.
`videoPipeline.ts:16433-16690`.

Gemeten in render 599, scène 1 — **zes downloads geslaagd**:

```
OqFhvKarYjU  RapidAPI (na 502 bot_check)
rPCWO-wZaLo  cloud service
FLal-KvTNAQ  RapidAPI  62.500.468 bytes
z2kp1wkRE8o  RapidAPI  36.990.505 bytes
aZbpVsQzBeU  RapidAPI  17.874.368 bytes
7bx_yqMF3jc  RapidAPI  28.151.510 bytes
```

**KNOWN OPEN — de cloud route kost het scènebudget.** Vier pogingen faalden met
`exceeded 117s / 117s / 84s / 54s`; RapidAPI deed elk daarna in 1–3 seconden. De scène kreeg 276s en
gebruikte 280s, waardoor vijf latere kandidaten onder de 12s-vloer vielen.

**Niet gefixt, bewust.** De code argumenteert er twee keer tegen, en render 582 is wat die fix ooit
kostte: *"one bot check closed the cloud route, and all 48 later attempts fell to RapidAPI, which
downloads the WHOLE source before it trims"*. Er is deze sessie een meetregel toegevoegd
(`[YouTubeCloudTiming]`, commit `780cd37`) omdat het getal dat nodig is om hierover te beslissen —
hoelang duurt die route als hij *wel* slaagt — niet bestond.

### Scoring

De echte regels, uit `videoPipeline.ts:27917` (de logregel die ze allemaal noemt):

```
focus  primaryEntity  secondaryEntity  event  location  object  date  place
eventPhrase  action  modern  narration  visual  negativeEvidence  genericPenalty  → finalScore
```

Gemeten voorbeeld uit 599:
```
[VisualSelection] scene=1 beat=1 pool=2 focus=person primaryEntity=+0(general)
  secondaryEntity=+0 event=+0 location=+0 object=+0 date=+0 place=+0 eventPhrase=+0
  action=+0 modern=+0 narration=+24 visual=+12 negativeEvidence=-6 genericPenalty=+0
  finalScore=+30
```

Losse scorers met eigen gewichten (`ronde79CandidateRanking.test.ts`, `videoPipeline.ts:26953`):
`eventPhraseMatchScore` → 8 bij exacte titelmatch, lager bij deelmatch, 0 bij geen.
Archiefkandidaten hebben een eigen scorer: `archiveMetadataScorer.ts` (+0..+3 uniqueness,
+0..+3 technical quality).

**Belangrijk en vaak verkeerd begrepen:** de similariteitsscore is **geen goedkeuring**.
`passingScored = scored.filter(s => s.visionResult.pass)` is de funnel-vision; de
`beat_image_gate` is een aparte VLM die daarna naar de frames kijkt en kan weigeren. In 599 scoorden
twee YouTube-clips 8,0 en werden ze alsnog geweigerd — terecht.

### Clip selection

- Timestamps: **JA** — `clipStart` + `duration` gaan mee in de download-URL
  (`videoPipeline.ts:16484`).
- Transcript: **ONBEKEND** — niet getraceerd in deze audit.
- Shot detection: **NIET GEÏMPLEMENTEERD** voor YouTube-clipkeuze.
- Eén bronvideo voor meerdere scènes: **JA** — `youtubeSourceFile(videoId)` +
  `[Pipeline] re-cut from the source this render already fetched … — no transfer`
  (`videoPipeline.ts:16404-16422`, RONDE 261).
- Herhaling voorkomen: `providerAssetAlreadyUsed`, `clipRejectAudit.refusedAssets` (R625),
  `strictNoVisualRepeat`.

### Permissions

`[YouTubeLicense] video=… status=UNVERIFIED action=ALLOW_UNVERIFIED_YOUTUBE
operatorAuthorized=false … — rights NOT proven, verify manually before publishing`.

Rechten worden **gelogd, niet afgedwongen** voor YouTube. De gebruiker heeft dit eerder expliciet
zo gewild (*"Ook hoef je niet naar de rechten te kijken. Dat los ik zelf op."*).

---

## 6. Own Media Archive

| | |
|---|---|
| Tier | 2 — `archive`, `curated` → `OWN_ARCHIVE` |
| Opslag | `/manus-storage/media-archive/…` en `/manus-storage/archive-ingested/…` |
| DB | `media_archive_assets` |
| Ingestie | `archiveIngestion.ts` — `ingestExternalClipToArchive`, semafoor van 2 |
| Intelligence | `archiveIntelligencePipeline.ts` — 23+ stages (watermark heuristiek, storytelling labels, temporal scene intelligence) |
| Scoring | `archiveMetadataScorer.ts` |
| Embeddings / vector | `visualMatchingV2/embeddings/qdrantVectorStore.ts`, `resilientVectorStore.ts`, `embeddingCache.ts`; Voyage voor embeddings |
| Rehydratie | `assetRehydrator.ts` — `ARCHIVE_REHYDRATE_FAILED`, `REHYDRATION_DOWNLOAD_FAILED` |

**Verhouding tot YouTube: de gevraagde volgorde is geïmplementeerd.** YouTube is tier 1, archive
tier 2, en `tierMayRun` weigert een tier over te slaan zonder expliciete decline
(`TIER_OUT_OF_ORDER` wordt gelogd als het tóch gebeurt — `centralVisualSourcing.ts:635`).

**In render 599 won het archief bijna alles.** Dat is niet omdat de volgorde fout staat, maar omdat
YouTube's kandidaten inhoudelijk werden afgewezen.

**Interessant:** `[AssetTrace] providerAssetId=57782 sourceUrl=/manus-storage/archive-ingested/37/
youtube_cc:youtube_cc:3k-HbACK31g_…mp4` — het archief bevat al eerder geïngesteerde YouTube-clips.
De R625-ingestie (`[Ingestion] keeping N approved runner-up clips`) voedt dit actief.

---

## 7. AI Visual Fallback

**BESTAAT — gedeeltelijk, en staat standaard uit.**

| Provider | Bestand | Aangeroepen op |
|---|---|---|
| Kling | `_core/klingVideo.ts` | `videoPipeline.ts:36968` |
| Grok | `_core/grokVideo.ts` | `videoPipeline.ts:19339` via `generateGrokVideoClip` |
| Veo | `_core/veoVideo.ts` | `videoPipeline.ts:19342` via `generateVeoVideoClip` |
| Higgsfield | `_core/higgsfieldVideo.ts` | ONBEKEND — niet getraceerd |
| Stills | `_core/imageGeneration.ts` | vereist `BUILT_IN_FORGE_API_URL`, dat *"is not"* gezet (`videoPipeline.ts:9124`) |

```ts
// _core/klingVideo.ts:55
export function klingBeatFallbackEnabled(): boolean {
  if (process.env.ENABLE_KLING_BEAT_FALLBACK === "false") return false;
  return isKlingAvailable();               // = KLING_API_KEY aanwezig
}
// max 6 clips per video, override via KLING_MAX_CLIPS_PER_VIDEO
```

**Zonder `KLING_API_KEY` is er geen AI-fallback.** Of die key in productie staat is **ONBEKEND** —
ik lees geen secrets.

---

## 8. Voiceover

`videoPipeline.ts:8324`:
```ts
export type VoiceoverProvider = "elevenlabs" | "fish-audio" | "google-tts" | "silent";
```

- Fish Audio: `https://api.fish.audio/v1/tts` (`:8684`)
- ElevenLabs: `https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}` (`:8867`)
- `"silent"` is een echte fallback — `usedSilentFallback: true`

**Koppeling aan de timeline:** `generateBulkSceneVoiceovers` geeft `durations` terug, die de
scèneduur zetten; `voiceBeatAlignment.ts` en `voiceTtsAlignment.ts` doen de beat-uitlijning. De
VOICE-track komt in `ProjectTimeline` via `audioTrackOf(timeline, "VOICE")`.

**Risico:** de `silent` provider betekent dat een render met stille narratie kan doorlopen.
`[RenderJob] AUDIO_BED_EMPTY` waarschuwt hierover maar blokkeert niet.

---

## 9. Timeline

`projectTimeline.ts` — `ProjectTimeline`, `TIMELINE_SCHEMA_VERSION = 1`.

**Tracks:** VIDEO, VOICE, MUSIC, SFX, AMBIENT, CAPTIONS, TEXT, GRAPHICS (`TrackKind`, regel 85).

**Per clip** (`TimelineVideoClip`, regel 253): `source: AssetSourceIdentity`, `sourceIn/sourceOut`
(optioneel — *"absent is not zero"*), `timelineStart/End`, `motion`, `camera?: ClipCamera`,
`transform?: ClipTransform`, `effects?: ClipEffect[]`, `sourceKind?`, `transitionIn/Out`,
`transitionInSec/OutSec`, `previewSource`, `sceneIndex/beatIndex`, `editedByUser?`, `disabled?`.

**Audio:** `TimelineAudioClip`, `AudioDucking`, `AudioKeyframe` (regels 449-536) — volledig.
**Tekst:** `TimelineText`, `TimelineCaption`, `CaptionMode`, `TextAnimation`, `TextSafeZone`.
**Graphics:** `TimelineGraphic`, `normaliseGraphicsTrack`, `graphicsWithLabels`.

### Is de timeline de source of truth? — GEDEELTELIJK. Dit is blocker #3.

**Er zijn twee edit-representaties:**

| | `video.replaceClip` | `timeline.replaceClip` |
|---|---|---|
| Bestand | `routers.ts:1049` | `timelineRouter.ts:569` |
| Document | `EditorScene[]` | `ProjectTimeline` |
| Adressering | `sceneIndex` + `clipIndex` | `clipId` |
| Implementatie | `videoEditorEdits.ts:138` `replaceClipInScenes` | inline |
| Versiecontrole | geen zichtbaar | `expectedTimelineVersion` |

`timelineFromManifest.timelineFromEditorScenes` is de brug. `edlToTimeline.translateEdl` is de
bouwer die de **productie** gebruikt (`cinematicPipeline.ts:326`).

**Wat ik NIET heb getraceerd en dus niet claim:** of een `video.replaceClip` een eerdere
`timeline.replaceClip` kan overschrijven, en welke van de twee de renderer leest bij een
her-render na een editor-bewerking. Dat vereist het volgen van de call-graph vanaf
`renderJobWorker` terug naar de opslag. **ONBEKEND — en het is de belangrijkste openstaande vraag.**

---

## 10. Compose / Render / Export

```
renderJobWorker.ts:662  deps.render({ timeline, workDir, outputPath, resolveMedia, resolveAudio,
                                      graphicsOverlay })
timelineRenderer.ts     renderSegment(clip, media, outPath, fmt, look, handleSec)
                          → ffmpeg -vf <buildVideoFilter> -c:v libx264 -preset veryfast -crf 20
                            -pix_fmt yuv420p
                        buildTransitionGraph({ durations, transitions })
                          → ffmpeg -filter_complex [i:v]settb=AVTB[ti];…xfade/concat…
                            -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p
                        buildAssDocument(...)   → libass voor captions/tekst
                        graphicsOverlay         → Remotion, met ffmpeg_ass als fallback
```

**Formaat:** `DEFAULT_FORMAT = { widthPx: 1920, heightPx: 1080, fps: 30 }` (`projectTimeline.ts:623`).

**Filters** (`timelineFilters.ts`): `containChain` (scale+pad+setsar+fps+format),
`coverChain` (scale+crop), `cameraChain` (2× upscale + zoompan), `effectChain`
(letterbox via `drawbox`, glow/bloom via split+gblur+blend, `rgbashift`, `vignette`, `noise`),
`buildTransitionGraph`, `buildAudioGraph`.

### Gates — waar ze zitten, waarom, wat ze doen

| Gate | Bestand | Activering | Gevolg |
|---|---|---|---|
| Search gate | `searchQueryContract.ts` / `searchGateDecision` | onbewezen term in query | query BLOCKED, `[SearchQueryAudit] status=BLOCKED` |
| Technical media gate | `technicalMediaGate.ts` | short side < `VIDEO_MIN_SHORT_SIDE_PX` | REJECT `video_too_low_res` |
| Quality bar | `technicalMediaGate.ts:237` | short side < 480 | **NOTE only** — `below_quality_bar`, niets wordt weggegooid |
| Beat image gate | `beatImageRelevanceGate.ts` | VLM zegt `does_not_fit` | clip geweigerd voor deze beat |
| Funnel vision | `beatVisualRelevance.ts` | `visionResult.pass` false | clip niet in `passingScored` |
| Adoption guard | `videoPipeline.ts` | `FUNNEL_WITHOUT_EVIDENCE` | adoptie geweigerd |
| Baked text | `videoPipeline.ts` (R625) | ingebrande ondertitels | asset render-breed afgeschreven |
| Timeline validator | `timelineValidator.ts` | blocking issue | repair of fallback |
| Timeline repair | `timelineRepair.ts` | clip-scoped blocking issue | clip gedropt of transitie genormaliseerd, max `MAX_REPAIR_PASSES` |
| Export gate | `videoPipeline.ts` (R89) | visual mismatch | export geblokkeerd (configureerbaar) |
| Render lock | `renderLock.ts` | tweede render zelfde video | `RENDER_ALREADY_RUNNING`; lease 40 min, heartbeat 5 min, `STALE_LOCK_RECOVERED` |
| Delivery gate | `deliveryGate.ts:150` | 10 failure codes | levering geblokkeerd |
| Watchdog | `renderWatchdog.ts` | `WATCHDOG_RENDER_MAX_MS` | render gestopt |

### Timeouts

Genest, met één klok per scope: `withSceneFetchTimeout(work, ms, label)` klemt elk kind op
`min(now + ms, parentDeadline)`. `describeEnclosingScope()` print
`clock="…" granted=Ns used=Ns transferReserve=Ns`. `remainingSearchMs()` trekt de transfer-reserve
af, zodat zoeken nooit het downloadvenster opeet (RONDE 259).

`YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS (12s) + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS (12s)` = 24s.
`YOUTUBE_TURN_WINDOW_MS = 12s + TRANSFER_RESERVE_MS (24s)` = 36s.

---

## 11. Audio Pipeline

VOICE / MUSIC / SFX / AMBIENT bestaan volledig in het model, inclusief `AudioDucking` en
`AudioKeyframe`. `buildAudioGraph` in `timelineFilters.ts` bouwt de mix.

`formatMuxSpan()` (`timelineRenderer.ts:533`) en `shortestTruncatesPicture()` bewaken `-shortest`:

```
[MuxSpan] picture=74.65s audioMix=74.20s timeline=74.65s tracks=4 mux=yes
  shortestWouldTruncatePicture=no
```

**Dit is goed gebouwd** — de vraag die §16 van je brief stelt over `-shortest` is al beantwoord in
de code, met een expliciete meting in plaats van een aanname.

**Ontbrekend:** er zijn **geen editor-mutaties** voor audio. Renderen kan; bewerken niet.

---

## 12. Captions / Text / Graphics

Captions en tekst gaan via **libass** (`buildAssDocument`), niet via `drawtext` — want
`drawtext` ontbreekt in de gebundelde ffmpeg-static (`timelineFilters.ts:105`).
`PlayResX/Y` worden op het timeline-formaat gezet zodat een fontgrootte pixels betekent.

Graphics gaan via **Remotion** (`server/remotion/`), met `ffmpeg_ass` als fallback.
`[OverlayInk]` meet het alfakanaal van het gecomposite bestand — een echte observatie, geen
voorspelling.

**KNOWN OPEN — graphics overload.** 13 graphics/minuut gepland tegen een drempel van 12. De
waarschuwing doet niets. Sinds R616 (Dockerfile-fix) worden de graphics ook daadwerkelijk getekend,
dus dit is nu een reëel risico in plaats van een theoretisch.

---

## 13. Tests

Uitgevoerd, volledig, zojuist:

```
Test Files  757 passed | 5 skipped (762)
     Tests  12462 passed | 21 skipped (12483)
```

`tsc --noEmit` schoon. Geen enkele test verwijderd of verzwakt in deze sessie.

Relevante suites: `ronde148CinematicRender`, `ronde184TransitionDuration`, `longRenderDefects`,
`r203TransitionsAreMeasured`, `professionalRenderEngine/*`, `ronde147TimelineValidator`,
`renderLockKeepsRendersApart`, `deliveryIsNotAConsolationPrize`, `theGraphIsBuiltOnWhatWasEncoded`,
plus zes nieuwe bestanden uit deze sessie.

**Bekende flake:** `ronde134VideoTechnicalGate` onder volle parallelle belasting (ffmpeg trim 35s);
slaagt geïsoleerd 24/24. Niet onderdrukt.

---

## 14. Known Bugs

### KNOWN FIXED (deze sessie — **gecommit, NIET gedeployed**)

| # | Bug | Commit |
|---|---|---|
| 1 | `"he issue"` — vraagzin gaf hulpwerkwoord+voornaamwoord als event naar alle providers | `780cd37` |
| 2 | `ffmpegComplaint` koos de enige regel zonder oorzaak als "de oorzaak" | `218c95d` |
| 3 | Eén mislukte `xfade` verwierp elf gerenderde segmenten | `3a90d2d` |
| 4 | Geen ffmpeg-foutclassificatie | `bd48873` |
| 5 | Geen SAFE_RENDER | `dba88ab` |

### KNOWN OPEN

| # | Probleem | Bewijs |
|---|---|---|
| 1 | **Render 599 faalde**; geen geldige MP4 sinds | `[DeliveryGate] AUTHORITATIVE_RENDER_FAILED` |
| 2 | **Geen YouTube-clip haalt de timeline** — nul `ASSIGNED provider=youtube_cc` | render 599 logs |
| 3 | `YOUTUBE_NOT_SEARCHED` wordt gezet terwijl `attempted=true` | `TIER_DECLINED tier=1:YOUTUBE reason=YOUTUBE_NOT_SEARCHED` naast `YOUTUBE_TURN_ENDED outcome=YOUTUBE_NO_RESULTS`, zelfde beat |
| 4 | Cloud yt-dlp verbrandt 54–117s per download, RapidAPI doet het in 1–3s | vier `Cloud DL failed … exceeded` |
| 5 | Twee edit-representaties | `routers.ts:1049` vs `timelineRouter.ts:569` |
| 6 | Graphics overload 13/min vs drempel 12 | waarschuwing zonder effect |
| 7 | Geen autosave | `grep autosave` → 0 treffers |
| 8 | Geen AI editing agent | `grep editAgent|rushAgent` → 0 treffers |
| 9 | Geen audio-mutaties in de editor | `timelineRouter` heeft alleen `editText`, `replaceClip` |
| 10 | `seg_010` oorzaak onbekend | R627 diagnostiek toegevoegd, nog geen render om hem te lezen |

### POSSIBLE RISK

- `YOUTUBE_BEAT_BUDGET_MS` accepteert een operator-override tot 15.000ms — onder de 24s-prijs.
- `"silent"` voiceover provider kan een film met stille narratie laten passeren.
- `legacyFallbackDeliveryAllowed()` — als die env-vlag in productie aan staat, kan legacy compose
  wél leveren. **ONBEKEND of hij aan staat.**

---

## 15. External Dependencies

| Service | Waarvoor | Aangeroepen in | Kritisch voor V1 | Blocker? |
|---|---|---|---|---|
| Groq / OpenAI / Gemini | script, metadata, intent | `_core/llm.ts` | **JA** | nee — 3 providers met fallback |
| YouTube (search) | tier 1 bron | `searchYoutubeVideoCandidates` | **JA** | nee |
| eigen yt-dlp service | YouTube download primair | `videoPipeline.ts:16484` | nee | **JA — bot check, verbrandt budget** |
| RapidAPI | YouTube download fallback | `videoPipeline.ts:16691` | **JA** | nee — doet nu het echte werk |
| Fish Audio / ElevenLabs | voiceover | `videoPipeline.ts:8684/8867` | **JA** | nee |
| Qdrant | vector search archief | `visualMatchingV2/embeddings/qdrantVectorStore.ts` | nee | nee — `resilientVectorStore` vangt af |
| Voyage | embeddings | `visualMatchingV2/embeddings/` | nee | nee |
| Kling / Grok / Veo | AI visual fallback | `_core/*Video.ts` | nee | uit zonder key |
| Wikimedia, Internet Archive, Europeana, NARA, LoC, NASA, Flickr, Sepiasearch, Vimeo, media.ccc, Openverse, GDELT | tier 3 | diverse | nee | rate limiting gezien |
| Pexels, Pixabay, Unsplash, SerpAPI | tier 4 | diverse | nee | nee |
| Railway | hosting + worker | — | **JA** | nee |
| MySQL | `videos`, `media_archive_assets` | `db.ts` | **JA** | nee |
| manus-storage | media | — | **JA** | ONBEKEND of volume persistent is — de log waarschuwt: *"uploads ⚠ ephemeral"* |
| Remotion | graphics | `server/remotion/` | nee | R616 fixte packaging |

---

## 16. Current vs Target V1

| Onderdeel | Staat er al | Werkt goed | Moet aangepast | Moet gebouwd | Kan weg |
|---|---|---|---|---|---|
| Prompt → Script | ✅ | ✅ | | | |
| Scene planning | ✅ | ✅ | | | |
| Visual Intent | ✅ | ✅ (na R626) | | | |
| YouTube FIRST | ✅ | ✅ zoeken+downloaden | cloud-route economie | | |
| YouTube → timeline | ✅ | ❌ nul clips landen | onderzoeken na deploy | | |
| Own Archive SECOND | ✅ | ✅ | | | |
| Open web THIRD | ⚠️ tier bestaat | providers ja, **screenshot nee** | | web capture | |
| AI Visual LAST | ✅ | uit zonder key | | | |
| Voiceover | ✅ | ✅ | | | |
| Timeline | ✅ | ✅ model | twee representaties | | |
| Captions | ✅ | ✅ | | | |
| Music | ✅ | model ✅ | editor-mutatie | | |
| SFX | ✅ | model ✅ | editor-mutatie | | |
| Ducking | ✅ | model ✅ | editor-mutatie | | |
| Motion / Ken Burns | ✅ | ✅ | | | |
| Transitions | ✅ | ✅ (+ ladder) | | | |
| Render | ✅ | ⚠️ 599 faalde | | | |
| MP4 export | ✅ | ⚠️ ongetest sinds 599 | | | |
| Editor | ✅ | ✅ 14/25 punten | | autosave, audio, agent | |
| Recovery | ⚠️ deels | ladder + SAFE_RENDER nieuw | | recovery engine | |
| Delivery gate | ✅ | ✅ | | | |

---

## 17. Redundant / Unnecessary Complexity

**Gerapporteerd, niet verwijderd.**

1. **Twee `replaceClip`-routes** op twee documenten — `routers.ts:1049` en `timelineRouter.ts:569`.
   De enige echte dubbele autoriteit die ik gevonden heb.
2. **Twee renderroutes** — `cinematic_timeline` en `legacy_compose`. **Niet overbodig**: de
   delivery gate blokkeert legacy expliciet. Dit is een gemarkeerde migratiegrens, precies wat een
   one-route architectuur voorschrijft.
3. **`videoPipeline.ts` is ~52.500 regels.** Dat is geen defect op zichzelf, maar het is de reden
   dat dezelfde vraag op meerdere plekken beantwoord wordt (zie `YOUTUBE_NOT_SEARCHED`).
4. **Twee YouTube-labels** — `youtube` (search) en `youtube_cc` (download) voor één bron.
   Bewust, gedocumenteerd in `sourcingTiers.ts:57-59`.
5. **Root-niveau losse scripts** — `trigger-elon.ts`, `generate-real-video.mjs`,
   `test-ytstream{,2,3}.mjs`, `insert_pixabay.py`, `upgrade_quality.py` enz. Ontwikkelrestanten,
   niet in de productieroute. **Kandidaat voor opruiming, na tracen.**
6. **Vier oude rapporten in de repo root** — `FASTVID-FORENSIC-REPORT.md`,
   `REAL_VIDEO_GENERATION_REPORT.md`, `VIDEO_GENERATION_VERIFICATION.md`,
   `RONDE-88A-REV2-RAPPORT.md`.

**Wat ik NIET als overbodig aanmerk**, ondanks dat het zo oogt: de vele scoringlagen. Render 599
laat zien dat ze elk iets anders beslissen (similariteit ≠ goedkeuring ≠ hard match). Ze
samenvoegen zou de fout introduceren die ik zelf deze sessie bijna maakte.

---

## 18. V1 Blockers

Gesorteerd op jouw criteria: blokkeert productie → onbetrouwbare output → ontbrekende functie →
kwaliteit → schuld.

### 1. Zes fixes zijn niet gedeployed — *blokkeert volledige productie*
- **Probleem:** commits `780cd37`, `218c95d`, `23803a9`, `3a90d2d`, `bd48873`, `dba88ab` staan lokaal.
- **Oorzaak:** niet gepusht.
- **Huidige situatie:** een render vandaag reproduceert `"he issue"`, de onleesbare foutmelding én
  het verlies van de hele film bij één `xfade`.
- **Minimale oplossing:** pushen. Eén handeling.

### 2. Geen geldige MP4 sinds render 599 — *blokkeert volledige productie*
- **Oorzaak:** transition graph faalde op `seg_010`.
- **Bestanden:** `timelineRenderer.ts`, `timelineFilters.ts`.
- **Huidig:** R627 diagnostiek + R628 ladder + R630 SAFE_RENDER staan klaar maar zijn ongetest in
  productie.
- **Minimale oplossing:** deploy + één render. De `[SegmentShape]`-regel noemt dan de oorzaak.

### 3. Ik kan zelf geen render starten — *blokkeert de hele debug-loop*
- **Oorzaak:** `assertUserCanEnqueueVideo(ctx.user.id)` — `routers.ts:1177`.
- **Minimale oplossing:** de accounthouder start de render. Geen code-oplossing; ik verzin geen
  credentials.

### 4. Geen YouTube-clip bereikt de timeline — *onbetrouwbare output t.o.v. de productbelofte*
- **Oorzaak:** de aangeboden kandidaten passen inhoudelijk niet. Deels veroorzaakt door `"he issue"`
  (gefixt, niet gedeployed).
- **Minimale oplossing:** deploy fix 1, dan meten. Pas dan is bekend of er een tweede oorzaak is.

### 5. Twee edit-representaties — *onbetrouwbare output*
- **Bestanden:** `routers.ts:1049`, `timelineRouter.ts:569`, `timelineFromManifest.ts`.
- **Minimale oplossing:** tracen welke de renderer leest; de andere markeren als legacy met een
  expliciete migratiegrens. **Niet verwijderen.**

### 6. `YOUTUBE_NOT_SEARCHED` mislabel — *onbetrouwbare metriek*
- **Oorzaak:** tweede site die het label zet zonder `attempt.searched` te lezen.
  De juiste logica staat op `videoPipeline.ts:5298`.
- **Minimale oplossing:** de tweede site vinden en door de bestaande predicate routeren.

### 7. Cloud yt-dlp verbrandt het scènebudget — *kwaliteit + betrouwbaarheid*
- **Minimale oplossing:** `[YouTubeCloudTiming]` uitlezen na één render, dán beslissen.

### 8. Geen autosave — *ontbrekende essentiële functie*
- **Minimale oplossing:** `recordEdit` koppelen aan `timeline.save` met debounce. Beide bestaan al,
  inclusief `expectedTimelineVersion`.

### 9. Graphics overload 13/min vs 12 — *kwaliteitsprobleem*
- **Minimale oplossing:** eerst meten wat er echt getekend wordt. Drempel **niet** verhogen.

### 10. Open-web screenshot ontbreekt — *ontbrekende functie*
- `web_wide` is een tier-entry; er is geen browser.
- **Minimale oplossing voor V1: overslaan.** Tier 3 heeft al twaalf echte providers.

---

## 19. 7-Day Ship Plan

Alleen werk dat `PROMPT → PROFESSIONAL VIDEO → MP4` dient.

**DAG 1 — Deploy + eerste echte meting**
Push de zes commits. Jij start één render. Ik lees: `[SegmentShape]`, `[FfmpegFailure]`,
`[TransitionLadder]`, `[YouTubeCloudTiming]`, `[VisualIntent]`. Eén render beantwoordt vijf vragen.

**DAG 2 — De seg_010-oorzaak repareren**
Nu bekend uit dag 1. Fix + regressietest. Tweede render.

**DAG 3 — YouTube naar de timeline**
Meten of de R626-fix betere kandidaten geeft. Zo niet: de tweede oorzaak vinden. `YOUTUBE_NOT_SEARCHED`
mislabel fixen zodat het rapport klopt.

**DAG 4 — Eén geldige MP4, volledig gevalideerd**
Delivery gate met echte bestandsmetingen. Alle 14 checks. Dit is het eerste punt waarop iets
"werkend" genoemd mag worden.

**DAG 5 — Edit-representaties**
Tracen, migratiegrens documenteren, regressietest `EDIT → SAVE → RENDER`.

**DAG 6 — Autosave + audio-mutaties**
Klein, bestaand fundament.

**DAG 7 — Tweede volledige render + rapport**
Bewijzen dat het reproduceerbaar is, niet eenmalig.

### POST-V1
Recovery engine, productie-statemachine, exhaustion proof, AI editing agent, open-web screenshot,
leerlaag/telemetrie, checkpoint-resume, `videoPipeline.ts` opsplitsen.

---

## 20. Recommended Final V1 Architecture

**Verander de architectuur niet.** Die is al wat je wilt:

```
PROMPT → generateScriptOnly → parseScriptIntoScenes → buildBeatVisualIntent
       → centralVisualSourcing  [YOUTUBE → OWN_ARCHIVE → OPEN_SOURCES → STOCK]
       → beatVisualRelevance + beatImageRelevanceGate + technicalMediaGate
       → translateEdl → ProjectTimeline
       → renderJobWorker → timelineRenderer  (+ ladder + SAFE_RENDER)
       → deliveryGate → MP4
```

Drie wijzigingen, meer niet:

1. **Eén edit-representatie.** `ProjectTimeline` is de kandidaat: hij heeft versiecontrole, de
   renderer leest hem, en de editor-history hangt eraan. `EditorScene[]` wordt legacy met een
   gemarkeerde grens.
2. **Autosave**, gebouwd op wat er is.
3. **De recovery die er nu staat, bewijzen** — ladder en SAFE_RENDER zijn CODE- en TEST-PROVEN,
   niet RENDER-PROVEN.

---

## De minimale set wijzigingen om binnen 7 dagen V1 te shippen

1. **Push de zes commits.** *(geen code)*
2. **Start één render.** *(geen code — alleen jij kunt dit)*
3. Repareer wat `[SegmentShape]` aanwijst.
4. Fix de `YOUTUBE_NOT_SEARCHED`-mislabel.
5. Trace de twee edit-representaties en markeer er één als legacy.
6. Autosave koppelen.

Stappen 1 en 2 kosten geen regel code en ontgrendelen alles daarna. Op dit moment is **niet de
architectuur de bottleneck — het is dat er niets gedeployed is en al vier dagen geen render is
gedraaid.**

---

## Wat ik niet weet

Expliciet, omdat een audit die alles claimt te weten niets waard is:

- Of `video.replaceClip` een `timeline.replaceClip` kan overschrijven — **ONBEKEND**.
- Of `KLING_API_KEY` in productie staat — **ONBEKEND** (ik lees geen secrets).
- Of `legacyFallbackDeliveryAllowed()` aan staat — **ONBEKEND**.
- Of het YouTube-transcript gebruikt wordt bij clipkeuze — **ONBEKEND**.
- Wat er precies mis is met `seg_010` — **ONBEKEND tot de volgende render**.
- Of `manus-storage` een persistent volume is — de log waarschuwt dat `uploads` ephemeral is.
