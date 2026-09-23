# FASTVID — RENDER 602

```
MP4:            NEE
OORZAAK:        mijn eigen regressie uit de vorige ronde
STATUS:         gerepareerd, getest, gepusht (bc84f3a)
```

---

## 1. Wat er gebeurde

```
[CinematicPlannerSource] scene=0 canonicalCount=4 canonicalExcludedByCompose=4 available=0
[CinematicPlannerSource] scene=1 canonicalCount=5 canonicalExcludedByCompose=5 available=0
[CinematicPlannerSource] scene=2 canonicalCount=4 canonicalExcludedByCompose=4 available=0
[CinematicPipeline] inputs scenes=0 beats=14 planned=0 dropped=17
[CinematicPipeline] video=602 plan NOT stored code=CINEMATIC_NO_PLANNABLE_BEATS
[RenderJob] video=602 route=legacy_compose RENDER_FALLBACK_USED
[DeliveryGate] DELIVERY_GATE_FAIL video=602 clips=12 fromArchive=9 timeline=absent failures=3
```

**Dertien van de dertien geadopteerde clips afgewezen, in alle drie de scènes.** Alle 14 beats
gedropt. Geen cinematic plan. Terugval op compose, en die montage bevatte 3 placeholders, dus de
delivery gate weigerde hem.

---

## 2. De oorzaak — en het is mijn fout

Mijn fix van vorige ronde draaide compose's eigen bruikbaarheidscheck (`usableSurvivorClips`) over
de geadopteerde clips. De redenering klopte. **De plaats niet.**

Het bewijs staat in dezelfde render:

| | |
|---|---|
| Compose's aanroep van `usableSurvivorClips` | hield **12** clips over |
| Mijn aanroep, over dezelfde bestanden | hield er **0** over van 13 |

> Dezelfde functie, dezelfde bestanden, dezelfde render, een ander moment — tegengestelde
> antwoorden.

De predicate leest het bestandssysteem. De inputs van de planner worden samengesteld **nadat**
compose zijn tussenbestanden heeft opgebruikt. Een uniform verlies van 100% is nooit een
inhoudelijk oordeel; het is een systematisch oordeel, en dat had ik aan het aantal moeten zien.

### En het was een tweede kopie van een check die al bestond

De planner doet dit zelf, op het enige moment waarop het antwoord actueel is:

| Check | Wat hij doet |
|---|---|
| §10 (in videoPipeline) | weigert een kaart die deze pipeline zelf tekende |
| `localOnlyIdentityFor` | houdt een beat alleen als het pad bestaat en bytes heeft |
| `identityFrom` | eist anders dat de clip herophaalbaar is bij zijn provider |
| duration check | dropt een beat zonder bruikbare lengte |

Die zijn **strikt beter** dan mijn probe: een bestand dat deze render niet meer heeft maar wél
opnieuw kan ophalen, wordt bewaard en opgehaald — waar mijn probe het gewoon doodde.

Dit is exact de signatuurfout die ik in deze codebase vijf keer heb beschreven, nu door mijzelf
gemaakt: **een antwoord wordt op één plek berekend en gebruikt door een beslisser die een andere
vraag stelt.**

### De fix

`plannerClipsForScene` **stelt samen en oordeelt niet**. Alles wat geadopteerd is gaat naar de
planner, compose's eigen vondsten komen erachteraan, en de beslissingen blijven bij de code die ze
al nam. `usableSurvivorClips` is onaangeraakt en draait nog steeds in compose, op bestanden die
compose vasthoudt.

---

## 3. §20 — de gevraagde cijfers

```
VIDEO         MP4:            GEEN — delivery gate geweigerd
              delivery gate:  DELIVERY_GATE_FAIL, 3 failures
              failures:       3× PLACEHOLDER_IN_DELIVERY
              route:          legacy_compose (cinematic plan bestond niet)
              timeline:       absent

SOURCE MIX    compose montage: clips=12, fromArchive=9
              YouTube in MP4:  0 — er is geen geldige MP4
              cinematic clips: 0

SHOTS         total:          0 op de cinematic route (plan niet opgeslagen)
              beats:          14 aangeboden, 14 gedropt

PIPELINE      found:          1693
              validated:      85
              downloaded:     65
              assigned:       24
              rendered:       12   (compose montage, gate-geweigerd)
              planner inputs: 0    ← de regressie
              timeline clips: 0
              final clips:    0

DELIVERY      queued:         geen job — de cinematic route had geen plan
              completed:      n.v.t.
              published:      n.v.t.
```

### RESULT

| Vraag | Antwoord |
|---|---|
| 1. Valide MP4? | **Nee.** De gate weigerde de compose montage op 3 placeholders |
| 2. % YouTube? | **0%** — er is geen film om over te rekenen |
| 3. YouTube-clips in de MP4? | **0** |
| 4. Onverwachte drops? | **Ja, 14 van 14** — mijn regressie |
| 5. Nieuwe blocker? | **Ja, twee.** Zie §4 |

---

## 4. Twee echte bevindingen die NIET van mij zijn

### A. `strict_voice_refill` overschrijft geadopteerde YouTube-clips

```
[AssetNotRendered] assetId=#26  provider=youtube_cc scene=2 beat=3
                   reachedSelected=true reachedAssigned=true
                   outcome=REPLACED reason=scene_resourced:scene_2_resourced:strict_voice_refill
[AssetNotRendered] assetId=#117 provider=youtube_cc scene=1 beat=1
                   reachedSelected=true reachedAssigned=true
                   outcome=REPLACED reason=scene_resourced:scene_1_resourced:strict_voice_refill
```

Twee YouTube-clips haalden `ASSIGNED` en werden daarna **vervangen door een scene-herverdeling**.
Dit is de pipeline's eigen oordeel (`outcome=REPLACED`), geen gevolgtrekking van mij uit logvolgorde
— die fout heb ik deze sessie al gemaakt en dit is het niet.

**Dit is jouw §8/§9 in de praktijk**, en het is de volgende echte blocker voor YouTube-dekking:
een scene-brede stap die per-beat toewijzingen overschrijft. Ik heb er nog niets aan gedaan.

### B. De historische relevantiepoort werkt

```
stage=ELIGIBLE status=REJECTED reason=refused on s0b2: The frames depict a modern conference
setting with a person and a presentation, unrelated to the historical context of the narration
about 1945, Berlin, or Hitler
```

Jouw §11, aantoonbaar actief. Een moderne conferentie-opname werd geweigerd op inhoud, niet op
provider. **Geen blacklist nodig.**

---

## 5. Wat ik nog fout deed

Mijn rapport-push van 11:00 triggerde een worker-deploy precies rond het moment dat jij startte. Die
heeft je render niet gedood — hij was klaar vóór de start, en 602 draaide op de nieuwe deployment —
maar ik had het niet moeten laten gebeuren, en ik had het ook niet als waarschuwing moeten brengen
vóórdat ik het had nagekeken.

**Regel vanaf nu: geen push zolang een render kan starten of loopt.** Deze fix is nu gepusht omdat
602 klaar is en er niets draait.

---

## 6. Status

| | |
|---|---|
| `origin/main` | **`bc84f3a`** |
| Testsuite | 767 bestanden, **12.575 groen**, 21 skipped, **0 rood** |
| `tsc --noEmit` | schoon |
| Ankers verplaatst / verzwakt | 6 / **0** |
| Gates versoepeld | geen |

`planDoesNotNeedCompose` is nu twee keer herschreven, en beide keren overleefde de **reden** het
mechanisme: geen bestand dat compose's check zou weigeren bereikt de planner. Daarom pint hij nu de
eigen weigeringen van de planner in plaats van een probe.

---

## 7. Volgende stap

> **Start opnieuw één render, zelfde onderwerp.** Ik push niets tot hij klaar is.

Wat ik dan als eerste lees:

```
[CinematicPlannerSource] canonicalAvailableToPlanner=   moet nu gelijk zijn aan canonicalCount
[CinematicPlannerBeat] reason=                          per beat
[CinematicPipeline] decisions=                          het aantal shots
[AssetNotRendered] … strict_voice_refill                hoeveel YouTube dit nog kost
```
