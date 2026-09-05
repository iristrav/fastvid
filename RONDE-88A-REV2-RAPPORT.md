# FASTVID — RONDE 88A-REV2

## Forensisch rapport: P5, P1, P2, P3, P4

**Basis:** `815d84e` · **Resultaat:** `574d116` · **Branch:** `main` (3 commits)
**Bron van bewijs:** render VID-0568 (pipeline-rapport + ruw Railway-log)
**Suite:** 511 bestanden / 7718 tests / 0 failures · typecheck schoon · build schoon

---

## 0. Samenvatting in één alinea

Vijf punten uit de opdracht zijn afgehandeld, elk gekoppeld aan een concrete logregel, een
concrete functie en een regressietest. Twee van de vijf bleken een andere oorzaak te hebben dan
de hypothese in de opdracht; dat is per §1 gevolgd en hieronder expliciet benoemd. Eén van de
vijf (P1) corrigeert een eerdere conclusie van mij: `UNVERIFIED_TERM` op `fuhrerbunker` was
**niet** correct poortgedrag. Geen enkele poort is versoepeld; geen enkele assertie is verwijderd
of verzwakt; geen drempel verlaagd. Twee bevindingen die ik onderweg tegenkwam heb ik bewust
*niet* aangeraakt en staan in §7.

| # | Onderwerp | Oorzaak gevonden in | Commit |
|---|---|---|---|
| P5 | Zelfde archiefrij 38× voorbereid | `adoptClip` + `generateGuaranteedBeatClipInner` | `2bbf0f9` |
| P1 | `fuhrerbunker` geweigerd terwijl script het zegt | `evidenceStems` (geen folding) | `dfea271` |
| P2 | `hrerbunker` — verminkt woord | 9 builders met ASCII-only woordklasse | `dfea271` |
| P3 | `render=- scene=? beat=?` | velden werden nooit gevuld | `574d116` |
| P4 | 128 queries zonder onderwerp | `pipelineSelfHeal` generators | `574d116` |

---

## 1. P5 — dezelfde archiefrij 38× gekocht (PRIORITEIT 1)

### 1.1 Wat het log meet

```
09:46:46  #2 score=926 id=57364                                  ← geranked
09:46:54  Scene 1 beat 6:   curated archive #57364 (score 505)   ← gedownload + getranscodeerd
09:46:54  [PushTrace] scene=1 beat=6 asset=ww2:57364 lineage=rmto6gvyy-1#17
                      accepted=false reason=duplicate_clip_once_per_video
09:46:55  #2 score=926 id=57364                                  ← opnieuw geranked
09:46:58  Scene 1 beat 106: curated archive #57364 (score 509)   ← opnieuw gekocht
09:47:02  Scene 1 beat 206: …
```

`[PushTrace]` telde 42 weigeringen voor die scène, **38 daarvan de enkele rij `ww2:57364`**,
onder 18 verschillende bestandsnamen.

### 1.2 Waarom "beat 106" en "beat 206" de vindplaats verraden

`beat.index + attempt * 100` is de eigen hernummering van de rescue-lus in
`videoPipeline.ts:30356` en `:30656`. Beat 6 → 106 → 206 is dus letterlijk attempt 0, 1, 2 van
één beat. Daarmee is de aanroepketen zonder gissen vastgelegd:

```
rescueBeatVisualWhenEmptyInner / ensureBeatVisualFilled
  → generateGuaranteedBeatClip(scene.index, beat.index + attempt*100, …)
    → generateGuaranteedBeatClipInner
      → fetchCuratedArchiveBeatClip({ index: slotIndex, … })
        → prepareCuratedArchiveClip      ← download + ffmpeg + schrijf
  → pushClip → pushSceneClip → duplicate_clip_once_per_video → weg
```

### 1.3 Hoofdoorzaak: één regel, twee registers

Een curated archiefrij leeft in **twee** registers op `VisualDedupState`, en die beantwoorden
verschillende vragen:

| Register | Wie leest het |
|---|---|
| `usedContentKeys` | de laatste verdedigingslinie — élke `pushSceneClip`-variant weigert hierop |
| `usedCuratedAssetIds` / `usedCuratedStorageUrls` | de **zoekkant**: `searchCuratedCandidatesForBeat`'s pool-filter (`curatedMediaSourcing.ts:2521`), `listCuratedArchiveCandidates`' excludeIds, de eligibility-lus (`:2959`), `archiveAssetPreflight` |

Schrijf je het eerste en niet het tweede, dan kán de render de beelden nog steeds niet twee keer
gebruiken — hij kan alleen niet stoppen ze te *kopen*. Twee plekken deden precies dat:

**(a) `adoptClip` (`videoPipeline.ts:22860`)** — het enige acceptatiepunt van de funnel. De eigen
downloadtak van de funnel (`downloadFunnelCandidate`, `candidate.archivePick`) roept
`prepareCuratedArchiveClip` aan en produceert `…_curated_a<id>.mp4`, dus een curated rij *kan*
hier geadopteerd worden — het commentaar op de volgende regel benoemt `"curated"` zelfs als
mogelijke key-familie. Elk ander acceptatiepunt in het bestand schrijft beide registers (de vier
`pushSceneClip`-varianten, `rejectClip`, de compose-backfills, de fast-short rescue). Dit was de
enige die dat niet deed.

**(b) De guaranteed-ladder** — `generateGuaranteedBeatClipInner` zet zijn twee exclusiesets
standaard op **verse lege Sets** (`usedAssetIds ?? new Set<number>()`), en **9 van de 10
aanroepplekken gaven er geen mee**. De markering die de ladder zelf wél doet (regel 9461) stierf
dus met de aanroep, en het archief antwoordde elke poging opnieuw met zijn best scorende rij.

Dit is dezelfde naad als RONDE 53's `recordClipAdopt`, RONDE 70's beat-audit en RONDE 86's
mislukte assets: een regel die meerdere routes moeten onthouden, onthouden door op één na
allemaal. Dit is de vijftiende instantie in dit bestand.

### 1.4 Wat ik heb gewijzigd — en wat níet

Gewijzigd zijn precies vier plekken:

- `adoptClip` schrijft nu `markCuratedAssetUsed(p, …)` naast `usedContentKeys.add(contentKey)`.
- De drie ladder-aanroepen wier clip naar `pushClip` gaat (`:30356`, `:30656`, `:31072`) geven de
  render-brede curated sets mee.

**RONDE 34 punt 8 is niet aangetast.** Die beslissing houdt compose-rescues bewust op
batch-scoped sets — *"een render-brede uitsluiting daar laat de rescue verhongeren tot een
kleurkaart"* — en dat blijft staan: die clips gaan rechtstreeks `validClips` in, waar geen
render-brede regel geldt. De drie gewijzigde plekken geven hun clip aan een `pushSceneClip`-
variant, die die regel **sowieso al toepast** — alleen ná de download. Deze wijziging verandert
dus niets aan wélke beelden een render mag gebruiken; ze verplaatst een identieke beslissing naar
vóór de download.

### 1.5 Test

Nieuw: `server/duplicatePreparationIsPrevented.test.ts` (15 tests).
Gedrag: `searchCuratedCandidatesForBeat` biedt `57364` aan zonder markering en **niet** met
markering, blijft de rest van de pool aanbieden (uitsluiting ≠ uithongering), en `markCuratedAssetUsed`
+ de zoekfilter passen end-to-end op elkaar. Structureel: een invariant over álle
`generateGuaranteedBeatClip`-aanroepen — wie zijn clip pusht, moet de render-brede sets meegeven;
wie dat niet doet, moet ze juist níet meegeven.

**Aangepaste bestaande test:** `ronde32Rescue` TEST E verbood de render-brede set in *élke*
ladder-aanroep — breder dan zijn eigen ratio ondersteunt. Hij stelt die eis nu over de
rescue-batch-aanroepen waarvoor hij geschreven is; de aanroepen die hij niet meer dekt worden —
met de voor hén juiste eis — gedekt door de nieuwe test, wiens invariant TEST E's regel bovendien
voor élke niet-pushende aanroep herhaalt. Netto dekking neemt toe, niet af.

---

## 2. P1 — `fuhrerbunker` geweigerd terwijl het script het woord zegt

> **Dit corrigeert een eerdere conclusie van mij.** Ik meldde eerder dat `UNVERIFIED_TERM` op
> `fuhrerbunker` correct validatorgedrag was omdat Führerbunker niet in de canonieke
> entiteitencontext staat. Dat laatste klopt nog steeds. Maar de bewijsregel — *"de eigen woorden
> van het script bewijzen zichzelf"* — had het woord moeten bewijzen en kon dat niet.

### 2.1 Wat het log meet

```
blockedTerms=["fuhrerbunker"]  ×6
```

### 2.2 Hoofdoorzaak

`validateSearchQuery` bewijst een woord onder meer uit `ctx.evidence` — de eigen tekst van de beat
— via `evidenceStems`. Die functie **vouwde geen diakritieken**:

- de builders die wél vouwen (`scriptVisualKeywords`, `curatedMediaSourcing`,
  `mediaResearchEngine`, `scriptGuidedClipFinder`) leveren `fuhrerbunker`;
- het bewijs bevat `führerbunker`;
- `evidenceStems("fuhrerbunker")` en `evidenceStems("führerbunker")` deelden geen enkele vorm.

De poort meldde dus `UNVERIFIED_TERM` over een woord dat de beat letterlijk bevat. Dat is het
faalpatroon waar deze module tegen gebouwd is, binnengekomen langs de andere kant: niet een gok
toegelaten, maar het eigen woord van het script geweigerd.

### 2.3 Fix

`evidenceStems` vouwt nu via `foldSearchText`. Beide kanten van de vergelijking gebruiken
dezelfde functie, dus de relatie is symmetrisch: `führerbunker`, `Fuhrerbunker` en `fuhrerbunker`
zijn één woord. Ook de `rejected`-map en de production/function-woordcheck vouwen nu, zodat de
gemelde *reden* (`LLM_GENERATED_TERM` vs. anoniem `UNVERIFIED_TERM`) klopt.

### 2.4 Vouwen is géén versoepeling — en dat wordt getest

`server/searchTextIsFolded.test.ts` (16 tests) bewijst de fix én de grens:

| Blijft geweigerd | Waarom |
|---|---|
| `reichstag` bij een script dat het niet zegt | vouwen verandert spelling, geen antwoord |
| `München` / `munchen` bij een script zonder München | idem |
| `fuhrer` uit het compound `Führerbunker` | vouwen is geen woordsplitsing |
| een `llm_generated` term | wordt nog steeds bij naam genoemd |

En blijft bewezen: RONDE 90's verbuigingsregels (`canals`→`canal`, `cycling` ≠ `cyclists`),
inclusief bovenop het vouwen. Niet-Latijnse schriften blijven intact.

---

## 3. P2 — `hrerbunker`, een woord dat geen archief bevat

### 3.1 Wat het log meet

```
blockedTerms=["hrerbunker"]  ×6
```

### 3.2 Hoofdoorzaak

Een ASCII-only woordklasse (`\W`, `[^a-z0-9]`) behandelt `ü` als leesteken. `Führerbunker` valt
uiteen in `f` en `hrerbunker`; het fragment van één letter sneuvelt op de eerstvolgende
`length >= 4`-filter. Wat overblijft is een woord dat nergens bestaat.

**`searchTextNormalize` is precies hiervoor geschreven, in RONDE 51, en de header van dat bestand
noemt deze exacte string uit render 530.** Het bereikte twee builders. Zeven andere hielden hun
eigen ASCII-klasse — waaronder degene die een videoTITEL in een providerquery verandert.

### 3.3 Gerepareerde plekken

| Bestand | Wat het deed |
|---|---|
| `videoPipeline.ts` (titel→query) | **produceerde `hrerbunker` als providerquery** |
| `videoPipeline.ts` (`personWords`) | `Göring` → `{g, ring}`; kon iemands eigen naam aan zichzelf plakken |
| `videoPipeline.ts` (`tokenizeForRelevance`) | relevantiescore tegen een niet-bestaand woord |
| `scenePool.ts` ×2 | beat-tokens én kandidaat-tokens |
| `localClipVision.ts` ×3 | query-deduplicatie |
| `clipGoodCache.ts` | gedeelde woorden tussen beats |
| `replacementCandidates.ts` | zoekwoorden van de editor |
| `scriptWriter.ts` | on-topic-bewaking |

**Bewuste uitzondering:** `extractKeywords` (kinetische typografie) is nu Unicode-bewust maar
**niet** gevouwen — die woorden komen ín beeld, dus de kijker moet `Führerbunker` lezen. De oude
ASCII-klasse was het slechtste van twee werelden en zette `hrerbunker` op het scherm.

### 3.4 Invariant tegen de volgende

`searchTextIsFolded.test.ts` scant 13 modules die tekst in woorden omzetten en eist dat élke
ASCII-only klasse óf voorafgegaan wordt door een fold, óf een `// ascii-safe: <reden>`-markering
draagt. Bestandsnamen, ids en slugs dragen die markering; niets anders. Een markering zonder
inhoudelijke reden faalt ook.

---

## 4. P3 — `render=- scene=? beat=?`

### 4.1 Wat het log meet

Élke `[SearchQueryAudit]`-regel van render 568. Niet sommige — alle.

### 4.2 Hoofdoorzaak: geen scope-verlies

- `searchGateDecision` muntte zijn ticket met `mintVerifiedQuery(text, ambient, { route })` —
  route en verder niets. Het auditregel-veld las `ticket.sceneIndex`, dat dus altijd `undefined` was.
- `formatSearchQueryRejected` werd aangeroepen **zonder enig scope-argument**.
- `VerifiedQueryContext` zegt bewust *wat* een beat bewijst, niet *welke* beat het is — er was
  ook niets ambient om te lezen.

De velden zijn met andere woorden nooit door iemand gevuld. Een audit die de beat niet kan noemen
is niet naar een shot terug te volgen — en dat is precies wat de 128 weigeringen uit P4
onleesbaar maakte.

### 4.3 Fix

Een kleine ambient scope draagt `videoId / sceneIndex / beatIndex`:

- geopend in `withBeatProvenance` — hetzelfde blad dat RONDE 100B voor de provenance koos, en dat
  `beat.index` en `scene.index` twee regels eerder al leest voor de planned shot;
- geopend in `buildSceneCandidatePool`, die `req.sceneIndex` altijd al in handen had (die schrijft
  `scene=N beat=?`, want de pool draait bóven de beat-lus — dat `?` is het juiste antwoord);
- de default wordt **in de drie formatters** toegepast, niet op hun aanroepplekken, zodat een
  nieuwe logregel het niet kan vergeten. Een expliciete waarde wint nog steeds.
- Scopes **mergen**: een binnenste scope die alleen een beat kent, wist de scène er omheen niet.

Buiten elke beat-scope blijft het `-` en `?`. Dat is het eerlijke antwoord voor een query die
niemand kan plaatsen, en hetzelfde antwoord dat strict mode er al aan geeft.

---

## 5. P4 — 128 queries gebouwd om weggegooid te worden

### 5.1 Wat het log meet

```
reason=NO_CONTENT_ANCHOR   documentary ×68   establishing ×40   historical ×20
```

### 5.2 Bewijs, niet vermoeden

Ik heb de echte generators gedraaid tegen de echte validator:

```
buildDocumentaryShotQueries("documentary", 0)
  → ["documentary wide establishing aerial",
     "documentary medium street level documentary"]      NO_CONTENT_ANCHOR

buildEmergencyGeoStockQueries("documentary", "documentary")
  → ["documentary documentary footage", "documentary"]   NO_CONTENT_ANCHOR ×2
```

De tweede uitvoer is letterlijk de string die de audit 68× telde.

### 5.3 Hoofdoorzaak

Beide generators plakken shot-vocabulaire achter een onderwerp — `${q} wide establishing aerial`
— en vroegen nooit óf dat onderwerp er een wás. De enige controle was `q.length < 4`, en
`documentary` is elf tekens. Het woord komt stroomopwaarts binnen uit fallbacks die op
`|| "documentary"` eindigen.

De poort had 128 keer gelijk. Maar 128 keer gelijk hebben nádat het werk gedaan is, is niet
hetzelfde als het werk niet doen.

### 5.4 Fix — de regel van de validator zelf, eerder gesteld

Regel H van `validateSearchQuery` ("een query van louter cameravocabulaire heeft geen onderwerp")
is gelicht naar `hasContentAnchor(query)` — en **regel H roept die functie nu aan**. Eén definitie
van "heeft een onderwerp"; generator en poort kunnen niet uit elkaar lopen. Een test controleert
die gelijkheid over veertien gevallen.

De generators stellen die vraag nu vóór ze bouwen: `buildDocumentaryShotQueries` geeft niets terug
voor een genrewoord, `buildEmergencyGeoStockQueries` filtert zijn uitvoer. Niets teruggeven is
het antwoord dat RONDE 100B voor dezelfde situatie al vastlegde: *"nothing left, so ask for
nothing"*. Voor een echt onderwerp is de uitvoer onveranderd — dat wordt apart getest.

De poort is nergens versoepeld: een query die hem bereikt wordt precies zoals voorheen beoordeeld.

---

## 6. Wat ik bewust niet heb gedaan

| Verbod uit de opdracht | Nageleefd |
|---|---|
| `SEARCH_GATE_STRICT` uitschakelen / poorten versoepelen | niet gedaan; P1 en P4 laten expliciet zien dát ze niet versoepelen |
| Assertions verwijderen of versoepelen, drempels verlagen | niet gedaan; drie aangepaste testvensters zijn *structureler* gemaakt, twee assertie-wijzigingen zijn per saldo strenger |
| `fuhrerbunker → allow` zonder canonieke context | niet gedaan — het woord wordt bewezen uit het *script*, niet vrijgegeven |
| Onbekende term automatisch vertrouwd | niet gedaan |
| `documentary/establishing/historical → allow` | het tegenovergestelde: ze worden nu al eerder gestopt |
| Scènebudget onbeperkt verhogen | niet gedaan |
| Duplicate detection uitzetten / kandidaten wissen | niet gedaan |
| `PushTrace` verwijderen / forensische logging verminderen | niet gedaan; P3 vult juist velden die leeg stonden |
| Scoring blind wijzigen | niet gedaan |
| Nieuwe Visual Selection Engine | niet gedaan; P4 hergebruikt regel H, P5 hergebruikt de bestaande dedup-registers |
| Mocks / gesimuleerde providers / fake responses | geen enkele; het P4-bewijs komt uit de échte generators |
| Credentials of secrets in logs of commits | geen |

---

## 7. Openstaande bevindingen die ik niet heb aangeraakt

1. **`formatSearchQueryLog` heeft geen enkele productie-aanroeper.** De `[SearchQuery]`-regel
   verschijnt dus nooit in een Railway-log, terwijl de formatter wel onderhouden en getest wordt.
   Dat hoort bij taak #64 ("audits eerlijk en leesbaar maken"), niet bij deze ronde.

2. **De bron van het woord `"documentary"` zit stroomopwaarts.**
   `stubPowerWordFromSceneText` eindigt op `|| "documentary"`, en `buildVideoArchiveCandidatePool`
   heeft twee soortgelijke fallbacks. Die voeden de *lokale* archief-tagmatching, niet een
   provider, dus de generator-fix vangt het waar het tijd kost. Het echte
   onderwerp-extractieprobleem daarachter blijft staan.

3. **`Führerbunker` staat nog steeds niet in de canonieke entiteitencontext.**
   `terms=["Adolf Hitler","Joseph Stalin","wrapped","bunker"]` — de entiteitextractie herkent de
   locatie niet, en `"wrapped"` staat er als vermeende entiteit in. P1 lost op dat het woord uit
   het *script* bewijsbaar is; het herkennen ervan als entiteit is een aparte opdracht.

4. **`ProviderFunnelInvariant` sloeg in 568 voor het eerst aan in productie**
   (`youtube_cc candidates=24 tracked=12 terminalOutcomes=10 untracked=12 unexplained=2
   INVARIANT_BROKEN`). Deze ronde raakte die keten niet; §43/§44 zetten vision→adoptie buiten
   scope.

5. **Twee `[LINEAGE_ERROR]`-regels dragen een thumbnail-URL als identiteit**
   (`serpapi:https://thumb.wikimedia.org/…/960px-….jpg?utm_source=…`). Dat botst met de
   staande regel "geen thumbnails, alleen echte beelden" en verdient een eigen ronde.

---

## 8. Verificatie

```
suite      511 bestanden · 7718 tests · 0 failures   (in 3 delen gedraaid — parallel geeft OOM)
typecheck  npx tsc --noEmit -p tsconfig.json         schoon
build      npm run build                             schoon
tree       clean
```

Nieuwe tests: 52 (`duplicatePreparationIsPrevented` 15, `searchTextIsFolded` 16,
`queryScopeAndContentAnchor` 21).
Aangepaste bestaande tests: 5 — vier vensters die op een bytecount stonden zijn structureel
gemaakt (een toegevoegd commentaarblok duwde de bewaakte regel uit beeld), één assertie is van een
letterlijke string naar de vorm plus een strengere regel gebracht.

### Wat dit rapport níet claimt

Er is **geen productie-render** gedraaid. Railway-toegang ontbreekt nog steeds
(`railway whoami` → `Unauthorized`; DATABASE_URL / OPENAI / ELEVENLABS / YOUTUBE / RAPIDAPI /
PEXELS / S3 allemaal `MISSING`). Alle bovenstaande oorzaken zijn afgeleid uit het log van render
568 en uit de code zelf, en elke fix is met een test vastgelegd — maar of het *aantal* dubbele
voorbereidingen in de volgende render werkelijk naar één zakt, is pas te meten in een echte
render. Dat wordt hier niet beweerd.
