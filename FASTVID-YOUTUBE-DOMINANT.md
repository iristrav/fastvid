# FASTVID — YOUTUBE DOMINANT

```
CODE STATUS:   READY
RENDER STATUS: NOT STARTED
REASON:        USER ENQUEUE REQUIRED
```

`assertUserCanEnqueueVideo(ctx.user.id)` — `server/routers.ts:1177`. Ik kan geen productiejob starten.
Elk veld in §20 is daarom **NIET GEMETEN**. Ik vul er niets in.

---

## 1. Wat er gewijzigd is

Eén wijziging. Het was ook de enige die telde.

### De beslissing die niemand nam

`pickBestFunnelCandidate` kende precies één bronvoorkeur: **non-stock boven stock**, met
`STOCK_TIER_WIN_MARGIN`. *Binnen* de non-stock tier — YouTube, Internet Archive, NARA, Wikimedia,
het eigen archief — won gewoon de hoogste `worstScore10`.

De enige andere plek met een bronvoorkeur is `EXTERNAL_SOURCE_TIER_BONUS`, en diens eigen comment
zegt wat dat waard is:

> *"It moves candidates up the shortlist, and nothing else … `pickBestFunnelCandidate` still picks
> the winner on real VisionGate scores."*

**Render 600 is precies wat die combinatie oplevert.** YouTube bereikte `status=ASSIGNED` op vier
beats — voor het eerst in de geschiedenis van deze pipeline, de shortlist-bonus die exact zijn werk
deed — en de geleverde film kwam eruit als `fromArchive=4`.

> De bonus bepaalde wie er **bekeken** werd. Niets bepaalde wie er **gebruikt** werd.

### Dezelfde regel, één tier hoger

```
YouTube 0.82, Archive 0.88   ->  YouTube     een edge van 0,06 beslist niets
YouTube 6.0,  Archive 9.0    ->  Archive     drie punten is geen marginale edge
```

Een **marge**, geen rang — want jouw eis heeft twee helften en alleen een marge eert er twee:
YouTube moet de film vullen, én een beeld dat aantoonbaar slechter is mag daar niet voor gebruikt
worden. Exact even groot als `STOCK_TIER_WIN_MARGIN` en op exact dezelfde 0-10-schaal, omdat het
exact dezelfde uitspraak is over exact hetzelfde soort bewijs. Eén regel, twee keer toegepast.

### Waarom dit geen gate versoepelt

De voorkeur draait over `passers`: kandidaten die **al** door VisionGate zijn (`visionResult.pass`)
en **niet** in `rejectedCandidateIds` zitten — de harde uitsluiting van de beat image gate. Hij kan
dus geen beeld toelaten dat een gate weigerde, geen drempel verplaatsen, en geen kandidaat bereiken
die nooit beoordeeld is. Precies jouw §3-volgorde: inhoud, techniek, gates, adoptie — **en pas
daarna** spreekt de bron.

### Eén ding dat de tests hebben blootgelegd

RONDE 65's ruisvloer blijkt de **bindende** guard, niet mijn marge. `discriminating` eist een spread
**strikt groter dan** één punt voordat een score überhaupt als ranking geldt, en de margetak zit
daarbinnen. Een gat van precies de marge is dus nog steeds ruis en YouTube houdt de beat. Dat staat
nu in een test in plaats van dat het wordt aangenomen.

---

## 2. Wat er NIET gewijzigd is, en waarom niet

| § | Punt | Status |
|---|---|---|
| **4** | meer YouTube-aanvoer per beat | **BESTOND AL.** Cap = 4 van 6 downloadslots (`maxShortlistPerYoutubeSource`), tier bonus 0,22 — de hoogste in de tabel. De aanvoer was niet de bottleneck; render 600 bewijst dat: vier clips gevonden, gedownload, gevalideerd, geadopteerd. **Niets gewijzigd.** |
| **6** | 8–15 shots per 60s | **VOLGT UIT DE VORIGE FIX.** Shotaantal = beataantal: `cinematicPipeline.ts:263` duwt één input per beat, `generateEDL` maakt één decision per input. Render 600 had 4 shots omdat 4 van ~12 beats een clip kregen. Dat was de canonical clip-loss. **Geen aparte wijziging; een aparte wijziging zou een tweede knop op dezelfde uitkomst zijn.** |
| **8** | coverage-aware planner | **NIET GEBOUWD, MET REDEN.** Een globale coverage-optimizer is een nieuw selectiemechanisme, wat §16 verbiedt. §7 bereikt hetzelfde per beat: als elke beat onafhankelijk YouTube prefereert bij een vergelijkbaar veld, komt "10 YouTube / 2 archive" er vanzelf uit — zonder een tweede beslisser naast de bestaande. |
| **9** | beat-onafhankelijkheid | **AL WAAR.** `pickBestFunnelCandidate` wordt per beat aangeroepen en houdt geen bronstatus vast; er bestaat geen scene-level source lock in de codebase (gecontroleerd). Een test pint dit nu vast. |
| **5** | meerdere segmenten uit één video | **NIET GEBOUWD, MET REDEN.** `sourceIn`/`sourceOut` bestaan, maar de **adoptie-identiteit is de basename**: `pairClipsToBeats` mapt basename → beat en slaat elke clip over waarvan de beat al bezet is, en de dedup-laag (`usedCandidateIds`, `clipAdoptAudit`) bestaat juist om te voorkomen dat één asset meerdere beats bedient. Eén video als drie shots vraagt dus om drie bestanden met drie content keys — dat is een wijziging aan het adoptiemodel, niet aan een vlag. §16 zegt: geen nieuwe sourcingarchitectuur. **En het is niet de bottleneck:** §7 laat meer *verschillende* YouTube-video's beats winnen, wat dezelfde dekking oplevert langs de bestaande weg. |
| **12** | camera motion | **BESTAANDE FUNCTIONALITEIT.** `cameraChain` werkt; render 600 gaf `NO_CAMERA_MOVEMENT` omdat de planner vier *holds* aanvroeg, en dat volgde uit vier inputs. Zelfde oorzaak als §6. |
| **10** | visual intent | **VORIGE RONDE.** `capture` en `distorted` zijn weg. |
| **11** | historische relevantie | **ONAANGEROERD**, met opzet. Geen provider-blacklist, geen gate versoepeld, geen gate toegevoegd. |
| **13** | delivery race | **VORIGE RONDE.** Moet nu in een echte render bevestigd worden. |

---

## 3. Tests

27 nieuwe, in `youtubeWinsWhenTheFieldIsComparable.test.ts`. Uit jouw §17:

| Eis | Test |
|---|---|
| YouTube preference | beide valide → YouTube wint, bij gelijk, bij beter, en bij marginale archive-edge |
| YouTube persistence | canonical → planner → timeline (RONDE 632's suite, 22 tests) |
| YouTube rejection | door de beat image gate geweigerd → wint nooit; alleen-geweigerd → `null`, geen beeld |
| Multiple segments | **niet getest** — niet gebouwd, zie §2 |
| Fallback | geen YouTube, of YouTube gezakt voor VisionGate → archive neemt de beat |
| Historical mismatch | de voorkeur kan een geweigerd beeld niet bereiken; gates staan vóór de voorkeur in de broncode, vastgepind |
| Delivery | vorige ronde, 22 tests |
| MP4 | delivery gate leest `checks=assets+file` — bestaand, niet verzwakt |

Daarnaast vastgepind dat er **niets** anders bewoog: de stock-regel, cross-beat variety, de
shortlist-bonus (0,22), de YouTube-downloadcap (4), en dat de voorkeur op één plek gedeclareerd staat.

---

## 4. Deploy

| | |
|---|---|
| `origin/main` | **`f9609df`** |
| **fastvid worker** | deploy `b6b7a639` — **SUCCESS** ✅ |
| fastvid (web/API) | SUCCESS ✅ |
| `tsc --noEmit` | schoon |
| Testsuite | 767 bestanden, **12.573 groen**, 21 skipped, **0 rood** |
| Tests verwijderd of verzwakt | **geen** |

---

## 5. §20 — EINDRAPPORT

**Niet gemeten. Er is geen render gedraaid.**

```
VIDEO         MP4:            NIET GEMETEN
              file:           NIET GEMETEN
              size:           NIET GEMETEN
              duration:       NIET GEMETEN
              resolution:     NIET GEMETEN
              fps:            NIET GEMETEN

SOURCE MIX    YouTube:        NIET GEMETEN
              Archive:        NIET GEMETEN
              Other:          NIET GEMETEN

SHOTS         total:          NIET GEMETEN
              YouTube:        NIET GEMETEN
              archive:        NIET GEMETEN
              avg duration:   NIET GEMETEN

PIPELINE      candidates:     NIET GEMETEN
              validated:      NIET GEMETEN
              adopted:        NIET GEMETEN
              planner inputs: NIET GEMETEN
              timeline clips: NIET GEMETEN
              final clips:    NIET GEMETEN

DELIVERY      queued:         NIET GEMETEN
              running:        NIET GEMETEN
              completed:      NIET GEMETEN
              published:      NIET GEMETEN
              delivery gate:  NIET GEMETEN
```

### RESULT

| Vraag | Antwoord |
|---|---|
| 1. Is er een valide MP4? | **NIET GEMETEN** — geen render gestart |
| 2. Hoeveel procent YouTube? | **NIET GEMETEN** |
| 3. Hoeveel YouTube-clips in de MP4? | **NIET GEMETEN** |
| 4. Onverwachte drops? | **NIET GEMETEN** |
| 5. Nieuwe concrete blocker? | **Ja, en het is dezelfde:** ik kan geen productierender starten |

---

## 6. Wat ik nodig heb

> **Start één render in de app. Onderwerp: Berlin / 1945 / Führerbunker / Hitler.**

Zelfde onderwerp als render 600, zodat het één-op-één vergelijkt. Daarna lever ik §20 met echte
getallen.

Wat die ene render in één keer beantwoordt:

| Logregel | Beantwoordt |
|---|---|
| `[CinematicPlannerSource] canonicalAvailableToPlanner=` | hoeveel geadopteerde clips de planner nu ziet |
| `[CinematicPlannerBeat] reason=` | welke beats een beeld kregen, en waarom niet |
| `[CinematicPipeline] decisions=` | of §6 (te weinig shots) inderdaad dezelfde oorzaak had |
| `[AssetTrace] ASSIGNED provider=youtube_cc` vs de eindmontage | **de hoofdvraag: haalt YouTube nu de film** |
| `[RenderJob] DELIVERED_BY=` | of de 61 ms-race weg is |
| `[DeliveryGate] … checks=assets+file` | of er een echte MP4 is |
| `[VisualIntent] subject=` | of `capture` en `distorted` weg zijn |
