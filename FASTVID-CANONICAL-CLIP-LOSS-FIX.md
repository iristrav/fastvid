# FASTVID — CANONICAL CLIP LOSS, GEREPAREERD

Vier commits. Testsuite 12.546 groen, 0 rood. `tsc --noEmit` schoon.

---

## 1. De root cause, weg

`server/videoPipeline.ts` had één regel:

```ts
clipPaths: usingCompose ? composedForScene : canonicalForScene
```

Zodra de legacy compose-montage ook maar één clip had geproduceerd, las de cinematic planner
**compose's lijst** en werd de canonieke geadopteerde set onzichtbaar.

Render 600 adopteerde vier YouTube-clips — de eerste die deze pipeline ooit op beat-niveau tot
`status=ASSIGNED` bracht. Geen enkele haalde de film. `[CinematicPipeline] decisions=4 clips=4`,
alle vier `fromArchive`. **De editor heeft niet voor andere beelden gekozen. Hij kreeg er vier.**

### Wat ik NIET heb gedaan

De ternary omdraaien. Jouw §2 verbood het en de code gaf de reden:

> *"the composed list is more accurate: it has had unusable files filtered out of it"*

Compose gooit ontbrekende, lege, ondecodeerbare bestanden weg, en kaarten die deze pipeline zelf
heeft getekend. Blind naar canonical overstappen geeft die precies terug aan de planner.

### De twee feiten die nooit hetzelfde feit waren

```
compose REJECTED dit bestand   ->  geen bruikbare media  ->  blijft eruit
compose MIST dit bestand       ->  compose heeft gekozen ->  gaat naar de planner
```

`plannerClipsForScene` draait **compose's eigen predicate** (`usableSurvivorClips`, geïnjecteerd,
niet nagebouwd) over de geadopteerde clips, houdt alles wat slaagt, en voegt toe wat compose had en
de adopted set niet. **Afwezigheid in compose verwijdert niets meer.**

### Waarom een langere lijst veilig is

`pairClipsToBeats` houdt de **eerste** clip per beat en slaat elke latere over, en slaat elke clip
over die de adoption audit niet noemt. Een langere lijst kan dus alleen beats vullen die leeg waren.
Canonical staat vooraan, dus waar beide bronnen iets over een beat zeggen, wint de clip die de
render ervoor adopteerde.

### Nooit meer stil

Per scène:

```
[CinematicPlannerSource] scene=N canonicalCount=… composeCount=…
                         canonicalExcludedByCompose=… canonicalAvailableToPlanner=…
                         composeOnlyAdded=…
[CinematicPlannerSource] scene=N asset=provider:id excluded=UNUSABLE_MEDIA file=…
```

Per beat, de drie redenen die `NO_ADOPTED_CLIP` vanuit `planCinematicScene` niet uit elkaar kón
houden:

```
CANONICAL_CLIP_AVAILABLE   de geadopteerde clip zit in de lijst van de planner
CANONICAL_CLIP_EXCLUDED    er was er één, en de bruikbaarheidscheck weigerde hem
NO_CANONICAL_CLIP          er is er nooit één geadopteerd  ← alleen dit betekent wat het label zei
```

---

## 2. De 61 ms-race, weg

```
07:49:37.199  job=19 queued
07:49:37.260  RENDER_FALLBACK_USED  reason=the render job worker claimed job 19 first
07:49:37.260  DELIVERY_GATE_FAIL video=600 AUTHORITATIVE_RENDER_FAILED
07:49:45.334  job=19 status=running          ← de winnaar begint pas
07:52:06      DELIVERY_GATE_PASS clips=4 checks=assets+file
07:52:11      job=19 status=completed published=true
```

```
ik heb het cinematic bestand niet gemaakt   ->   het cinematic bestand is niet gemaakt
```

Alleen het eerste was gemeten. **Dezelfde signatuurfout als al het andere deze sessie.**

`awaitRenderJobOutcome` **leest** alleen de job-rij — geen claim, geen re-queue, geen write, geen
enkele import. Twee ffmpeg-runs op één rij blijven dus onmogelijk, wat precies de eigenschap is die
`claimQueuedRenderJob` bewaakt. Wat verandert is de vraag: niet *"heb ík het gerenderd"* maar
*"is het gerenderd"*.

De rij beantwoordt het, of hetzelfde in-process budget dat de claimende route al uitgeeft beëindigt
het wachten. `STILL_RUNNING` is **geen** oordeel: de job loopt door en publiceert zelf. Een read die
gooit beëindigt het wachten ook niet — één onbereikbaar databasemoment mag geen mislukte film worden.

**En de kwaliteitscijfers trekken hun claim in.** De claimende route corrigeert spot check en
AV-envelope uit de eigen returnwaarde van de job; die is er hier niet, een ander proces heeft ze
gemeten. Dus `avSync`, `stillness` en `repeats` zeggen dat ze de compose montage beschreven, en
`postRenderSpotCheck` — dat geen `measuredOn` heeft om zich mee te kwalificeren — vervalt in plaats
van te blijven staan als oordeel over een bestand dat het nooit zag.

---

## 3. De zwakke subjects, weg

Twee losse defecten, elk tegengesproken door een doc comment in zijn eigen bestand.

### `subject=capture`

`extractEventPhraseForQuery` antwoordt in drie regels. Regel 3 geeft `EVENT_CUE_RE`'s kale
woordenlijsttreffer terug — en `extractEventCue`'s eigen comment zegt wat dat waard is:

> *"callers must treat it as 'no event signal to check', **not evidence of anything**."*

De subject-keten behandelde het als het **sterkste** bewijs in de beat, bóven een persoon die de
beat noemt en een plaats die hij noemt — terwijl `buildPrioritisedQueries` stroomafwaarts
PERSON > PLACE > EVENT voorschrijft. **Twee volgordes van dezelfde zes tokentypes, die elkaar
tegenspreken.**

Woordtelling scheidt ze exact: regel 1 geeft drie of meer woorden, regel 2 precies twee, regel 3 één.
Een event van één woord is dus regel 3's cue en zakt onder persoon en plaats. Een **benoemd** event
wint nog steeds van allebei — dat was de redenering waarop de keten is gebouwd, en die blijft.

### `subject=distorted`

`extractActionCue` neemt elk kleingeschreven woord van vijf letters dat op "ed" eindigt. Zijn comment
verdedigt dat met:

> *"An action only ever appears in a query behind an entity that anchors it, so a loose verb costs a
> low-ranked query and **never the subject of the search**."*

De subject-keten eindigt op `action[0]`. Op een beat zonder event, persoon, plaats of object **is**
de action het subject. De ruimhartigheid was prima; de bewering over waar hij kon landen niet.

De regel is positioneel, geen nieuwe woordenlijst: een "-ed"-woord direct ná een lidwoord of
bezittelijk voornaamwoord hoort bij het zelfstandig naamwoord erna — *"his distorted view"*, *"the
shattered remains"*. Een persoonsvorm staat nooit op die plek. En hij stapt eróver in plaats van te
stoppen: *"His distorted view of reality had hardened"* geeft nu `hardened`.

**Niets verwijderd uit enige lijst. Geen drempel bewogen. Geen gate aangeraakt.**

---

## 4. Wat ik NIET heb gefixt, en waarom — het extremistische materiaal

Jouw §14. Ik heb geen veilige fix, en ik bouw er geen half.

```
[AssetTrace] #195 status=ASSIGNED provider=internet_archive
  providerAssetId=white-lives-matter-montana-stickering-action-21
  scene=2 beat=2  query="As whispers of his death spread, …"
```

`candidatePeriodMatch.ts` bestaat al en **noemt dit asset bij naam** — RONDE 54 zag het al eens
opduiken tegen een gesigneerde foto van Hitler. Maar:

| | |
|---|---|
| De titel bevat geen jaartal | `period="unknown"` → **bijdrage exact 0** |
| `subject` en `place` kennen geen tegenspraak | alleen `"agrees"` of `"unknown"`, met opzet |
| De hele module is een nudge | *"a nudge, never a veto"*, met opzet |

De enige tekstuele signalen die dit asset zouden vangen zijn zijn eigen woorden — en daarop filteren
is hardcoding voor één onderwerp, wat jouw eigen brief verbiedt. Het alternatief, "afwezigheid van
bewijs is een straf", breekt de invariant die echt archiefmateriaal beschermt:

> *"Real archive titles are catalogue numbers … If a missing year cost a candidate points, the exact
> material this pipeline exists to find would sink and stock footage would rise."*

**En er is iets wat je moet weten over mijn eigen fix uit §1.**

Die clip haalde de eindmontage van render 600 niet. Ik schreef eerder: *dat is geluk, geen
bescherming.* Dat geluk was precies het defect dat ik nu heb weggehaald. **Meer geadopteerde clips
bereiken vanaf nu de planner — dus ook deze.** Mijn fix verhoogt de blootstelling aan dit risico.
Dat staat hier omdat je het moet weten vóór de volgende render, niet erna.

De juiste plek hiervoor is de **beat image gate** — een model dat naar de frames kijkt, niet naar de
slug. Of die gate dit asset überhaupt heeft beoordeeld, is **ONBEKEND**: de logs van render 600 zijn
weg. Eén render met `[BeatImageGate]` erbij beantwoordt het.

---

## 5. Commits

| | |
|---|---|
| `0997762` | an adopted clip is not lost to a montage |
| `048985f` | a lost claim is not a lost film |
| `7cdab30` | a cue is not the subject, and a modifier is not a verb |

Zes testankers verplaatst, **geen enkele verzwakt** — elk met de reden in de test zelf:

| Test | Wat het beschermde | Nu |
|---|---|---|
| `planDoesNotNeedCompose` | *"geen bestand dat compose's CHECK afwijst bereikt de planner"* | die check wordt nu rechtstreeks gedraaid — strikt sterker |
| `cinematicTraceIsComplete` | hield de deur open voor *"a separate, measured decision"* | dit is die beslissing |
| `oneRouteMakesTheFilm` | de planner heeft compose niet nódig | compose mag nu op elke scène leeg zijn |
| `aClaimThatCannotBeProven` | een verloren claim mag niet zwijgen | over de hele tak i.p.v. 400 tekens, plus: nog steeds geen tweede `runRenderJob` |
| `qualityReportMeasuredOn…` | de flip staat onder een vastgestelde levering | **elke** flip, niet alleen de eerste |

72 nieuwe tests.

---

## 6. Wat nu

1. **Deploy.** De fixes staan op `main` en de worker moet ze hebben.
2. **Eén render**, zelfde onderwerp (Berlijn / 1945 / Führerbunker), zodat we appels met appels
   vergelijken.

Die ene render beantwoordt in één keer:

| Logregel | Beantwoordt |
|---|---|
| `[CinematicPlannerSource] canonicalAvailableToPlanner=` | hoeveel geadopteerde clips de planner nu écht ziet |
| `[CinematicPlannerBeat] reason=` | welke beats een beeld kregen, en waarom niet |
| `[AssetTrace] ASSIGNED provider=youtube_cc` + de eindmontage | of YouTube nu de film haalt |
| `[CinematicPipeline] decisions=` | of Fase 9 (te weinig shots) inderdaad hetzelfde defect was |
| `[RenderJob] DELIVERED_BY=render_job_worker` | of de race weg is |
| `[VisualIntent] subject=` | of `capture` en `distorted` weg zijn |
| `[BeatImageGate]` op het Montana-asset | de enige open vraag uit §4 |

**Ik kan die render niet starten** — `assertUserCanEnqueueVideo(ctx.user.id)`, `server/routers.ts:1177`.

---

## Status

| | |
|---|---|
| Testsuite | 766 bestanden, **12.546 groen**, 21 skipped, 0 rood |
| `tsc --noEmit` | schoon |
| Tests verwijderd of verzwakt | geen |
| Gates versoepeld | geen |
| Drempels gewijzigd | geen |
| Nieuwe architectuur | geen — één helper naast `pairClipsToBeats`, één leesmodule |
