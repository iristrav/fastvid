# FASTVID V1 — PRODUCTION VALIDATION REPORT

Validation and debug phase. No rewrite, no refactor, no gate weakened, no test removed.
**No code was changed in this phase.**

---

## 1. Deployment Status

`origin/main` is at **`c481c02`**. Railway's live worker deployment `a7baca9f` was built from
**`c481c02`** (2026-09-22 18:12, SUCCESS). Local `HEAD` is `17b8861`.

| Commit | Lokaal | Gepusht | Deployed | Relevant voor V1 |
|---|---|---|---|---|
| `780cd37` a question has no object | ✅ | ❌ | ❌ | **JA — kritiek.** Zonder dit zoekt elke vraag-beat naar `"he issue"` |
| `218c95d` the join named a stream | ✅ | ❌ | ❌ | **JA** — zonder dit noemt de foutmelding geen oorzaak |
| `23803a9` audit docs | ✅ | ❌ | ❌ | nee — documentatie |
| `3a90d2d` a plainer join is not a lost film | ✅ | ❌ | ❌ | **JA — kritiek.** De ladder die render 599 had gered |
| `bd48873` ffmpeg says the consequence loudest | ✅ | ❌ | ❌ | **JA** — voedt SAFE_RENDER's beslissing |
| `dba88ab` the same film, cut plainly | ✅ | ❌ | ❌ | **JA — kritiek.** SAFE_RENDER |
| `17b8861` pipeline audit | ✅ | ❌ | ❌ | nee — documentatie |

**Conclusie: de draaiende versie bevat geen van de vijf V1-relevante fixes.**

### Wat er precies nodig is

```
git push -u origin main
```

Dat is alles. Railway deployt automatisch op push naar `main` (`railway.worker.json`), en de vier
voorgaande deployments in de historie zijn allemaal `reason: "deploy"` op een `main`-commit.

**Ik heb dit niet uitgevoerd.** Een push deployt en herstart de worker; dat is jouw beslissing en ik
heb er geen toestemming voor. Er draait op dit moment geen render, dus het risico van een gedode
render bestaat nu niet.

**Geen productie-render gestart** — zoals gevraagd, en ook omdat ik dat technisch niet kan
(`assertUserCanEnqueueVideo`, `routers.ts:1177`).

---

## 2. Test Video

**NIET UITGEVOERD.** Stap 4 en 5 vereisen een echte productieflow. Ik kan geen render in de
wachtrij zetten. Het onderwerp dat ik zou kiezen — en dat render 599 al gebruikte — is een
WWII-documentaire (Führerbunker, april 1945): historisch materiaal daarvan is aantoonbaar op
YouTube aanwezig, want render 599 downloadde er zes clips van.

---

## 3. Full Production Trace

Zie `FASTVID-V1-PIPELINE-AUDIT.md` §1 voor de volledige keten. Hier alleen het deel dat deze fase
moest bewijzen.

---

## 4-6. YouTube → Timeline: de exacte route, en waarom de kandidaten sneuvelen

### A. Waar wordt de kandidaat aangemaakt?

`server/scenePool.ts` — de scene pool zoekt parallel over alle providers.
Gemeten in 599: `[ScenePool] Scene 1: 68 candidates … calls: youtube_cc=2 … ms: youtube_cc=549`.
Lineage: `[VisualLineageEvent] … provider=youtube_cc … stage=FOUND status=OK`.

### B. Waar wordt hij gedownload?

`server/videoPipeline.ts:16404-16690` — `youtubeSourceFile` (hergebruik) → cloud yt-dlp
(`:16484`) → RapidAPI (`:16691`).
Gemeten: zes `DOWNLOAD_SUCCESS` in scène 1.

### C. Waar krijgt hij zijn score?

`videoPipeline.ts:27917` — de `[VisualSelection]`-regel drukt alle termen af.
Gemeten: `scores={youtube_cc:8.0, youtube_cc:8.0}`.

### D. Waar wordt vision uitgevoerd?

Twee verschillende poorten, en dit is de kern van de zaak:

| | Bestand | Wat het is | Resultaat in 599 |
|---|---|---|---|
| Funnel vision | `beatVisualRelevance.ts` → `visionResult.pass` | CLIP-similariteit | **pass = true** |
| Beat image gate | `beatImageRelevanceGate.ts` → `dedup.beatImageRejectedIds` | VLM die naar de frames kijkt | **does_not_fit** |

### E/F. Waarom wordt hij geweigerd, en door welke gate precies?

**`retrievalFunnel.ts:1589-1604`, in `pickBestFunnelCandidate`:**

```ts
const allPassers = scored
  .filter(s => s.visionResult.pass)
  .filter(s => !rejectedCandidateIds?.has(s.candidate.id));   // = dedup.beatImageRejectedIds
if (allPassers.length === 0) return null;
```

Aangeroepen op `videoPipeline.ts:41650`:
```ts
let winner = pickBestFunnelCandidate(scored, dedup.usedFunnelCandidateIds, dedup.beatImageRejectedIds);
```

De twee YouTube-clips stonden in **beide** verzamelingen: `visionResult.pass === true` én
`beatImageRejectedIds`. De tweede filter verwijderde ze, `allPassers.length === 0`, dus
`winner = null`, dus `[VisualDiscovery] winner=none(fallback)`, dus
`[VisualCoverage] fallback=PLACEHOLDER fallbackReason=REAL_ASSET_REJECTED`.

De weigeringen zelf waren **inhoudelijk correct**:

```
OqFhvKarYjU  depicts="Young German soldier with Iron Cross, surrounded by other soldiers,
                      1940s wartime setting. The text 'Willi Hübner' appears in one frame."
             reason="…does not specifically show a depiction relevant to the order Hitler issued"

rPCWO-wZaLo  depicts="A map with locations and military front labels related to WWII."
             reason="The map does not show anything directly related to the orders issued by
                     Hitler in his final days… It focuses on the 1st Belorussian…"
```

De code is expliciet over waarom `null` het goede antwoord is
(`retrievalFunnel.ts:1595-1597`): *"Returning null is the correct answer here: the beat falls
through to the next source, which is strictly better than showing a picture the pipeline has
already established does not belong."*

**Dit is dus geen bug in de poort. De poort werkt.**

### G. Waarom wordt de kandidaat niet alsnog als runner-up gebruikt? — EN HIER ZIT WEL EEN DEFECT

Hij wordt **wél** als runner-up gebruikt — maar niet voor deze beat, en met een verkeerd label.

`videoPipeline.ts:42286`:
```ts
const passingScored = scored.filter(s => s.visionResult.pass);
```

`videoPipeline.ts:42485-42501`:
```ts
for (const s of passingScored) {
  if (s === winner) continue;
  ...
  queueArchiveIngestion(s.clipPath, s.candidate);
  approvedKept += 1;
}
...
`[Ingestion] s${scene.index}b${beat.index} keeping ${approvedKept} approved ` +
`runner-up clip(s) the picture editor passed — they lost the beat, not the judgement`
```

**`passingScored` filtert NIET op `beatImageRejectedIds`.**

Gevolg, gemeten in render 599 op dezelfde beat, dezelfde seconde:

```
[VisualLineageEvent] providerAssetId=OqFhvKarYjU stage=REMOVED status=REJECTED
  reason=vision_rejected:s1b1
[VisualLineageEvent] providerAssetId=rPCWO-wZaLo stage=REMOVED status=REJECTED
  reason=vision_rejected:s1b1
[Ingestion] s1b1 keeping 2 approved runner-up clip(s) the picture editor passed
  — they lost the beat, not the judgement
```

**Dezelfde twee clips worden in dezelfde seconde afgewezen door de beat image gate én in het
curated archive geschreven met de tekst "the picture editor passed".**

De picture editor heeft ze niet gepasseerd. Hij heeft ze geweigerd, met reden.

**Waarom dit ertoe doet voor V1:** het eigen archief is bron #2. Het wordt nu gevoed met clips die
een poort heeft geweigerd, gelabeld als goedgekeurd. Bij een volgende render worden die aangeboden
als archiefmateriaal — en `[AssetTrace] providerAssetId=57782 sourceUrl=…/archive-ingested/37/
youtube_cc:youtube_cc:3k-HbACK31g_….mp4` laat zien dat dat pad al in gebruik is.

Dit is de signatuurfout van deze codebase, opnieuw: **een antwoord wordt aan één kant berekend en
nooit doorgegeven aan de kant die beslist.** `pickBestFunnelCandidate` leest
`beatImageRejectedIds`; `passingScored`, twintig regels verderop, niet.

**Ik heb dit NIET gerepareerd** — deze fase is validatie, en de opdracht zegt: eerst vaststellen.

### H. Waar wordt de uiteindelijke provider bepaald?

`centralVisualSourcing.ts` — de tier-ladder, `sourcingTiers.ts:39`:
`["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES", "STOCK"]`.
`TIER_OUT_OF_ORDER` wordt gelogd als een provider een tier overslaat (`:635`).

### I. Waar wordt de timeline assignment gemaakt?

`cinematicPipeline.ts:326` → `translateEdl(...)` → `ProjectTimeline`.
Opgeslagen via `timelineStore.ts`, gelezen door `renderJobWorker.ts:301 loadTimelineForJob` →
`parseStoredTimeline`.

---

## 7. Own Archive Fallback

Werkte in 599, en won bijna alles: `provider=ww2`, `provider=wikimedia`,
`provider=internet_archive`, `provider=UNVERIFIED` (curated).
De tier-volgorde is correct; het archief kwam aan bod omdat YouTube's kandidaten inhoudelijk
afvielen — niet omdat de volgorde fout staat.

## 8. AI Fallback

**NIET GEBRUIKT in render 599.** Geen Kling/Grok/Veo-regel in de logs.
`klingBeatFallbackEnabled()` vereist `KLING_API_KEY`; of die gezet is, is **ONBEKEND**.

## 9-12. Timeline Assignment / Render / Delivery / Final MP4

**NIET GEMETEN.** Vereist een render. Laatste bekende stand, render 599:
- 11 segmenten gerenderd, alle elf gemeten, `drifted=0`
- transition graph faalde op `seg_010`
- `AUTHORITATIVE_RENDER_FAILED`, geen MP4 geleverd

## 13-15. Visual / Audio / Technical Quality

**NIET TE BEOORDELEN.** Er is geen MP4 om te beoordelen. Elke uitspraak hierover zou een aanname
zijn, en de opdracht verbiedt aannames.

---

## 16. Remaining V1 Blockers

| # | Blocker | Status |
|---|---|---|
| 1 | Vijf V1-relevante fixes niet gedeployed | **jouw push** |
| 2 | Geen render mogelijk vanaf hier | **jouw actie** — `assertUserCanEnqueueVideo` |
| 3 | `passingScored` leest `beatImageRejectedIds` niet → geweigerde clips gaan het archief in als "approved" | **gevonden deze fase, niet gefixt** |
| 4 | `YOUTUBE_NOT_SEARCHED` mislabel | bekend |
| 5 | `seg_010` oorzaak | diagnostiek klaar, wacht op render |
| 6 | Cloud yt-dlp verbrandt scènebudget | meting klaar, wacht op render |

**Niet een blocker, wél belangrijk:** dat YouTube-clips worden afgewezen is op zichzelf **geen bug**.
De twee clips uit 599 — een jonge soldaat met een IJzeren Kruis, en een frontkaart — horen niet bij
narratie over Hitlers bevelen in de bunker. Of er ná de `"he issue"`-fix betere kandidaten
binnenkomen, is precies wat de volgende render moet uitwijzen.

---

## 17. Exact Minimal Fixes

1. **`git push -u origin main`** — nul regels code.
2. **Eén render starten** — nul regels code.
3. **Blocker 3:** `passingScored` moet `beatImageRejectedIds` respecteren, óf de logregel moet
   ophouden te beweren dat de picture editor ze passeerde. Eén filter of één zin. *(Mijn voorkeur:
   het filter — het archief hoort geen geweigerde clips te bevatten.)*
4. **Blocker 4:** de tweede site die `YOUTUBE_NOT_SEARCHED` zet door de bestaande predicate op
   `videoPipeline.ts:5298` routeren.

## 18. What Can Wait Until Post-V1

Recovery engine, productie-statemachine, exhaustion proof, AI editing agent, autosave,
audio-mutaties in de editor, open-web screenshot, leerlaag/telemetrie, checkpoint-resume,
`videoPipeline.ts` opsplitsen, consolidatie van de twee edit-representaties.

---

## 19. Step 10 — Edit Representations (trace, geen migratie)

**Welke representatie leest de renderer daadwerkelijk?**

**`ProjectTimeline`.** Bewijs:
`renderJobWorker.ts:480` `const loaded = await loadTimelineForJob(job)` →
`renderJobWorker.ts:301 loadTimelineForJob` → `timelineStore.ts:110 parseStoredTimeline(raw)` →
`ProjectTimeline`. De module-header van `renderJobWorker.ts:6` zegt het zelf:
*"job → timeline (timelineStore) — the document, read back and version-checked"*.

**Kan een edit in `EditorScene[]` verloren gaan wanneer `ProjectTimeline` wordt gebruikt?**

**ONBEKEND — en ik ga het niet raden.** Wat ik kan aantonen:
- `video.replaceClip` (`routers.ts:1049`) schrijft naar `EditorScene[]` via
  `videoEditorEdits.ts:138 replaceClipInScenes`, zonder zichtbare versiecontrole.
- `timeline.replaceClip` (`timelineRouter.ts:569`) schrijft naar `ProjectTimeline` mét
  `expectedTimelineVersion`.
- De renderer leest alleen de tweede.

Wat ik **niet** heb kunnen aantonen is of `timelineFromEditorScenes` ooit ná een
`timeline.replaceClip` draait en die daarmee overschrijft. Dat vereist het volgen van elke caller
van `timelineFromEditorScenes` door de re-render-route. **Dat is de volgende trace, niet deze.**

---

## DE HOOFDVRAAG

> "Kan FastVid op dit moment een professionele video produceren van prompt → MP4?"

# NO

### De minimale blockers tussen ons en YES

1. **De vijf fixes staan niet in de draaiende versie.** `origin/main` = `c481c02`; de live worker
   draait `c481c02`. Een render vandaag reproduceert `"he issue"`, de onleesbare foutmelding, en
   het verlies van elf gerenderde segmenten aan één `xfade`.

2. **Er is sinds render 599 geen geldige MP4 geproduceerd.** De laatste poging eindigde op
   `AUTHORITATIVE_RENDER_FAILED`.

3. **Ik kan geen render starten.** `assertUserCanEnqueueVideo(ctx.user.id)`.

Blockers 1 en 3 kosten samen nul regels code en zijn beide van jou. Blocker 2 wordt beantwoord door
de eerste render ná de deploy — de `[SegmentShape]`-regel noemt dan in één zin wat `seg_010`
mankeert.

**Alles wat ik zonder een render kan bewijzen, is bewezen: 757 testbestanden, 12.462 tests groen,
typecheck schoon. Wat ik niet kan bewijzen zonder render, claim ik niet.**
