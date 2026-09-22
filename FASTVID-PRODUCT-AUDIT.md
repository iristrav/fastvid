# FASTVID — PRODUCT EXPERIENCE AUDIT (VidRush-level checklist)

Audit only, nothing built. Every line cites a file and a symbol I opened. This is the addendum to
`FASTVID-PHASE0-AUDIT.md` covering items D9 and D10, which that document listed as not yet audited.

**Headline: the product surface is far more complete than I expected, and there is one real
violation of the "één authoritative project/timeline" rule.**

---

## 1. The checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | automatische productie | **COMPLETE** | `server/videoPipeline.ts`, `renderJobWorker.ts` |
| 2 | editor | **COMPLETE** | `client/src/components/VideoEditor.tsx` (1382 rgls) |
| 3 | timeline | **COMPLETE** | `server/projectTimeline.ts`, `ProjectTimeline`, `TIMELINE_SCHEMA_VERSION = 1` |
| 4 | media library | **PARTIAL** | `timeline.replacementCandidates` levert alternatieven per clip; geen vrij doorzoekbare bibliotheek |
| 5 | media replacement | **COMPLETE** | `timeline.replaceClip` + `VideoEditor.tsx:955` `trpc.timeline.replaceClip.useMutation()` |
| 6 | text/captions | **COMPLETE** | `timeline.editText`; `TimelineText`, `TimelineCaption`, `CaptionMode`, `TextAnimation`, `TextSafeZone` |
| 7 | voiceover | **PARTIAL** | VOICE-track bestaat (`audioTrackOf(t,"VOICE")`); geen "regenerate voiceover" mutatie in `timelineRouter` |
| 8 | music | **PARTIAL** | MUSIC-track + `AudioDucking`, `AudioKeyframe`; geen editor-mutatie om te wisselen |
| 9 | SFX | **PARTIAL** | SFX-track bestaat; idem geen mutatie |
| 10 | effects | **COMPLETE** (model+render) | `ClipEffect`, `effectChain()` in `timelineFilters.ts` |
| 11 | transitions | **COMPLETE** (model+render) | `TransitionKind`, `buildTransitionGraph` |
| 12 | camera movement | **COMPLETE** | `ClipCamera`, `cameraChain()` (zoompan) |
| 13 | graphics | **COMPLETE** | `TimelineGraphic`, `graphicsTrack`, `normaliseGraphicsTrack` |
| 14 | preview | **COMPLETE** | `VideoEditor.tsx:521` `previewUrl`; scrubber gebonden aan de TIMELINE-duur, niet aan het previewbestand |
| 15 | autosave | **MISSING** | `grep -rln "autosave\|autoSave" server client` → **0 treffers** |
| 16 | history / undo-redo | **COMPLETE** | `shared/timelineHistory.ts`; client importeert `newHistory`, `recordEdit`, `canUndo`, `undo`, `redo` |
| 17 | export | **COMPLETE** | `timeline.render`, `timeline.renderJob` |
| 18 | AI editing agent | **MISSING** | `grep -rln "editAgent\|rushAgent\|naturalLanguageEdit\|aiEdit"` → **0 treffers** |
| 19 | natuurlijke taal → projectwijziging | **MISSING** | idem |
| 20 | YouTube-first sourcing | **COMPLETE** (gedrag) | bewezen in render 599: `youtube_cc=2` calls, `granted=45s`, query `"Hitler Führerbunker"` |
| 21 | echte documentaire visuals | **COMPLETE** | geen AI-animatie als standaard; `beat_image_gate` weigert niet-passende beelden |
| 22 | één authoritative project/timeline | **PARTIAL — zie §2** | twee edit-representaties |
| 23 | één renderer | **PARTIAL** | `cinematic_timeline` is authoritative; `legacy_compose` is gated en luid, niet stil |
| 24 | recovery | **MISSING** | geen recovery engine, geen SAFE_RENDER, geen transition-ladder (zie Phase 0 §B) |
| 25 | echte MP4 delivery | **COMPLETE** (gate) / **BLOCKED** (bewijs) | `deliveryGate` valideert het echte bestand; ik kan geen render starten |

---

## 2. De echte vondst: twee edit-representaties

Dit is precies wat deze opdracht verbiedt — *"automatische productie en handmatige editing mogen
NOOIT twee verschillende waarheidssystemen creëren."*

Er bestaan **twee `replaceClip`-procedures**, elk op een andere representatie:

| | `video.replaceClip` | `timeline.replaceClip` |
|---|---|---|
| Bestand | `server/routers.ts:1049` | `server/timelineRouter.ts:569` |
| Werkt op | `EditorScene[]` — het "editor manifest" | `ProjectTimeline` |
| Adresseert een clip met | `sceneIndex` + `clipIndex` | `clipId` |
| Implementatie | `videoEditorEdits.ts:138` `replaceClipInScenes` | inline, leest de identiteit zelf op via `archiveAssetId` |
| Concurrency | geen versiecontrole zichtbaar | `expectedTimelineVersion` |

`timelineFromManifest.timelineFromEditorScenes` is de brug tussen de twee — en dat is het bestand
dat de eerdere opdracht al aanwees.

**Wat dit betekent:** een clip vervangen via de ene route en via de andere raakt twee verschillende
documenten. Welke daarvan de renderer uiteindelijk leest, bepaalt of de bewerking zichtbaar wordt.

**Wat ik NIET ga doen:** één van beide weghalen op grond van dit lijstje. De staande regel is
*"DO NOT GUESS WHAT IS REDUNDANT — trace callers, imports, production reachability, tests."*
`video.replaceClip` heeft eigen tests en een eigen RONDE-geschiedenis (RONDE 139 wordt in beide
bestanden genoemd als de reden dat een client zijn eigen provider niet mag opgeven).

**ACTION:** tracen welke representatie de renderer leest, welke de editor toont, en of een bewerking
op de ene de andere kan overschrijven. Dan pas een migratiegrens voorstellen. Dat is Phase 1-werk,
geen opruiming.

---

## 3. Wat beter is dan verwacht

Drie dingen die ik als ontbrekend had ingeschat en die er wél zijn:

**History is één systeem, niet twee.** De client importeert `newHistory`, `recordEdit`, `canUndo`,
`undo` uit `@shared/timelineHistory` — hetzelfde module als de server. De editor zegt het zelf in
een comment: *"the same module the server binds to — not a second [one]"*. Undo/redo hoeft dus niet
gebouwd te worden.

**De preview liegt niet.** `VideoEditor.tsx:684`: *"The scrubber is bound to the TIMELINE's
duration, not the preview file's. They can differ — the preview may be an older render."* Dat is
precies de eerlijkheid die §11/§20 elders eisen.

**De editor toont onherstelbare shots.** `data.recovery.previewOnly` — het aantal shots zonder
bruikbare bron wordt in de UI benoemd in plaats van stil gelaten. Dat is een aanzet tot §22
(dashboard behaviour) die al bestaat.

---

## 4. Wat er werkelijk ontbreekt op productniveau

Drie dingen, en ze zijn kleiner dan de opdracht doet vermoeden omdat het fundament er ligt:

1. **Autosave** — 0 treffers. De history-machinerie bestaat al; autosave is een `save`-aanroep
   koppelen aan `recordEdit` met debounce. `timeline.save` bestaat al en neemt
   `expectedTimelineVersion`, dus de conflictafhandeling is er ook.

2. **AI editing agent** — 0 treffers. Het fundament is gunstiger dan verwacht: er zijn al getypeerde
   mutaties (`replaceClip`, `editText`, `save`) met eigendoms- en versiecontrole. Een agent hoeft
   dus geen nieuwe schrijfroute te krijgen — hij mag alleen bestaande procedures aanroepen. Dat is
   exact wat de opdracht vraagt (*"wijzigt eveneens dezelfde projectrepresentatie"*) en het is
   veiliger dan een agent die het document zelf schrijft.

3. **Audio-mutaties in de editor** — VOICE/MUSIC/SFX staan volledig in het model, inclusief
   `AudioDucking` en `AudioKeyframe`, maar er is geen procedure om ze te wijzigen. Renderen kan het
   al; bewerken niet.

---

## 5. Bijgestelde volgorde

De eerdere volgorde uit `FASTVID-PHASE0-AUDIT.md` §F blijft staan, met deze toevoeging: de
productitems zijn **goedkoper** dan de recovery-items en raken de renderbetrouwbaarheid niet. Ze
horen dus ná de twee dingen die een echte render hebben gekost.

1. **B3 + B1** — transition fallback ladder, dan SAFE_RENDER. *(render 599 verloor elf gerenderde
   segmenten aan één `xfade`)*
2. **B4** — ffmpeg-foutclassificatie
3. **C2** — de `YOUTUBE_NOT_SEARCHED`-mislabel
4. **§2 hierboven** — de twee edit-representaties tracen en een migratiegrens voorstellen
5. **Autosave** — klein, bestaand fundament
6. **Audio-mutaties** — model bestaat, procedures ontbreken
7. **AI editing agent** — bovenop de bestaande getypeerde mutaties, geen nieuwe schrijfroute
8. **B2, B5, B6** — recovery engine, productiestatussen, exhaustion proof

---

## 6. Onveranderd BLOCKED

**E1 — de finale end-to-end productierender.** `assertUserCanEnqueueVideo(ctx.user.id)` in
`server/routers.ts` gates het in de wachtrij zetten op de ingelogde gebruiker. Ik heb geen
servicepad en verzin geen credentials. Jij start de render; ik lees de logs, diagnosticeer, patch.

Dit is nog steeds het enige punt uit alle vier de opdrachten dat ik niet zelf kan afronden.
