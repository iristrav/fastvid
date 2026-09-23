# FASTVID V1 — FIRST REAL PRODUCTION RESULT

Datum: 23 september 2026. Fase: deploy + minimale fix + eerste echte render.

**Uitkomst in één zin: stappen 1, 2 en 4 zijn uitgevoerd en live; stap 5 (de render) is niet
uitgevoerd omdat ik geen render kan starten.**

---

## 1. Deployment

| | |
|---|---|
| `origin/main` vóór deze fase | `c481c02` |
| `origin/main` nu | **`d4f06a0`** |
| **fastvid worker** (draait de renders) | deploy `ad0af82e` — **SUCCESS**, uit `d4f06a0` ✅ |
| fastvid (web/API) | deploy `2021afba` — BUILDING op moment van schrijven |
| MySQL, calibration-db, eloquent-serenity | SUCCESS, ongewijzigd |

### Wat er gepusht is

Twee pushes, geen enkele nieuwe refactorcommit:

```
c481c02..526e9ae    de zeven bestaande commits
526e9ae..d4f06a0    de minimale archief-fix uit stap 2
```

| Commit | Lokaal | Gepusht | Deployed | Relevant voor V1 |
|---|---|---|---|---|
| `780cd37` a question has no object | ✅ | ✅ | ✅ | **JA** — `"he issue"` gaat niet meer naar negen providers |
| `218c95d` the join named a stream | ✅ | ✅ | ✅ | **JA** — de foutmelding noemt weer een oorzaak |
| `23803a9` audit docs | ✅ | ✅ | ✅ | nee |
| `3a90d2d` a plainer join is not a lost film | ✅ | ✅ | ✅ | **JA** — de transition ladder |
| `bd48873` ffmpeg says the consequence loudest | ✅ | ✅ | ✅ | **JA** — foutclassificatie |
| `dba88ab` the same film, cut plainly | ✅ | ✅ | ✅ | **JA** — SAFE_RENDER |
| `17b8861` pipeline audit | ✅ | ✅ | ✅ | nee |
| `526e9ae` validation audit | ✅ | ✅ | ✅ | nee |
| `d4f06a0` a refused clip is not archive material | ✅ | ✅ | ✅ | **JA** — stap 2 |

**De worker die renders draait, is live met alle zes V1-fixes.**

---

## 2. Stap 2 — de archief-bug, gerepareerd

### Wat er mis was

`videoPipeline.ts` las één van twee oordelen:

```ts
const passingScored = scored.filter(s => s.visionResult.pass);
```

`visionResult.pass` is het oordeel van de **funnel** — een CLIP-similariteitsscore.
`dedup.beatImageRejectedIds` is het oordeel van de **beat image gate** — een model dat naar de
frames kijkt. `pickBestFunnelCandidate` (`retrievalFunnel.ts:1601`) leest allebei. `passingScored`,
twintig regels verderop en voedend voor archief-ingestie, las alleen de eerste.

Render 599, scène 1 beat 1, binnen één seconde:

```
…providerAssetId=OqFhvKarYjU stage=REMOVED status=REJECTED reason=vision_rejected:s1b1
…providerAssetId=rPCWO-wZaLo stage=REMOVED status=REJECTED reason=vision_rejected:s1b1
[Ingestion] s1b1 keeping 2 approved runner-up clip(s) the picture editor passed
```

Twee clips die de picture editor wél degelijk geweigerd had — een jonge Duitse soldaat met een
IJzeren Kruis, en een frontkaart van het 1e Wit-Russische Front — werden in het **curated archive**
gezet met het label "approved".

### Waarom juist het archief de ergste plek is

Het eigen archief is bron #2 en het **overleeft de render die het schreef**. Een geweigerd beeld dat
als goedgekeurd is opgeslagen, komt bij elke volgende render terug als archiefmateriaal, met de
weigering nergens meer in beeld. RONDE 9 trok deze lijn al eens voor stock: *"a generic Pexels clip
that happened to win a Hitler beat was ingested tagged 'adolf hitler', then outranked real archival
footage on every later Hitler render (the self-poisoning loop)."* Dit is dezelfde lus door een
andere deur.

### De fix

```ts
const passingScored = scored
  .filter(s => s.visionResult.pass)
  .filter(s => !dedup.beatImageRejectedIds.has(s.candidate.id));
```

Beide lezers van `passingScored` wilden dezelfde uitsluiting: het archief mag geen geweigerd beeld
krijgen, en een "runner-up" die de gate weigerde is geen runner-up, dus `[VisualDiscovery]` noemt er
geen meer als tweede keus van de beat.

**Er is niets versoepeld.** Dit verwijdert clips uit een verzameling en laat er geen toe. Geen
drempel bewogen, geen poort toegevoegd, en de winnaar wordt nog precies zo gekozen door de functie
die deze regel al toepaste.

### Eén bestaande test verbreed, niet verzwakt

`approvedRunnersUpReachTheArchive.test.ts` pinde de letterlijke tekst
`scored.filter(s => s.visionResult.pass)` onder de kop *"a clip Vision refused never appears in it"*.
Dat is de **juiste claim**; de letterlijke tekst leverde hem alleen niet — hij dekte één van de twee
oordelen. De assertie eist nu allebei, en die tweede verwachting is precies wat render 599 gevangen
zou hebben. De reden staat in de test zelf.

---

## 3. Stap 3 — NIET UITGEVOERD, en waarom

De opdracht zei: fix `YOUTUBE_NOT_SEARCHED` **alleen als het dezelfde bekende predicate-routing-fout
is.** Dat is het niet.

- `videoPipeline.ts:5298` is de **enige** producent van dat literal, en leest al:
  `attempt.searched ? "YOUTUBE_NO_RESULTS" : "YOUTUBE_NOT_SEARCHED"`.
- De verbatim regel die ik eerder uit render 599 ophaalde luidt:
  `[CentralSourcing] s1b1 TIER_DECLINED tier=1:YOUTUBE reason=YOUTUBE_NO_RESULTS` — **correct**.

De claim dat er een mislabel was, kwam uit mijn eigen samenvatting en ik kon hem niet tegen een log
reproduceren. **Ik trek die claim in.** Correcte code wijzigen op grond van een herinnering is
precies hoe je een defect uitvindt.

*(De logs van render 599 zijn inmiddels niet meer op te vragen: die deployment is vervangen. Mocht
het label in een volgende render tóch verschijnen, dan is het opnieuw te onderzoeken met bewijs.)*

---

## 4-8. Render, MP4, YouTube, Archive, AI, Segments, Productkwaliteit

**NIET UITGEVOERD / NIET MEETBAAR.**

Er is geen render gestart, dus elk getal in stap 6 en 7 is ongemeten, en de productbeoordeling uit
stap 7 heeft geen MP4 om over te oordelen. Ik vul die velden niet in met schattingen.

---

## 9. Remaining blockers

**Eén, en het is dezelfde als in het vorige rapport:**

**Ik kan geen productie-render in de wachtrij zetten.**
`assertUserCanEnqueueVideo(ctx.user.id)` — `server/routers.ts:1177`.

Ik heb op jouw verzoek gecontroleerd of er een operator-pad bestaat dat ik over het hoofd zag:

| Script | Wat het werkelijk doet |
|---|---|
| `trigger-gen.mjs` | print alleen tekst, roept niets aan |
| `trigger-video-generation.mjs` | POST naar `http://localhost:3000/api/trpc` — niet productie |
| `start-video-generation.mjs` | dev-scaffolding, geen productie-aanroep |

Er is dus geen operator-pad. **Ik zet ook geen rij rechtstreeks in de queue**: dat omzeilt de quota-
en concurrency-controles die `createVideo` uitvoert, en ik ken de invarianten niet die het vestigt.
Dat zou precies het soort stille omweg zijn dat deze codebase al twee keer duur betaald heeft.

---

## 10. NEXT ACTION

Precies één:

> **Start één render in de app, met een WWII/Führerbunker-prompt.**

Zelfde onderwerp als render 599, zodat we appels met appels vergelijken. Daarna lees ik de logs en
lever ik stap 4 tot en met 8 met echte getallen.

Wat die ene render in één keer beantwoordt:

| Logregel | Beantwoordt |
|---|---|
| `[SegmentShape]` | wat er precies mis is met `seg_010` |
| `[FfmpegFailure] class=…` | welke klasse fout het is |
| `[TransitionLadder] RECOVERED via …` | of de ladder de film redt |
| `[SafeRender] SAFE_RENDER_SUCCEEDED` | of de laatste vangnetlaag werkt |
| `[YouTubeCloudTiming]` | hoelang de cloud-route duurt als hij slaagt |
| `[VisualIntent] subject=…` | of de `"he issue"`-fix betere kandidaten oplevert |
| `[AssetTrace] ASSIGNED provider=youtube_cc` | of er eindelijk een YouTube-clip in de film komt |

---

## Status van de codebase

| | |
|---|---|
| Testsuite | 758 bestanden, **12.472 tests groen**, 21 skipped, 0 rood |
| `tsc --noEmit` | schoon |
| Tests verwijderd of verzwakt | geen |
| Gates versoepeld | geen |
| Drempels gewijzigd | geen |
| Architectuur gewijzigd | geen |

Alles wat zonder render te bewijzen valt, is bewezen. Wat zonder render niet te bewijzen valt, claim
ik niet.
