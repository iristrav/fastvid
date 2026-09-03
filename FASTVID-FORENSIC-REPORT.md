# FASTVID — FORENSISCH RAPPORT

**Onderwerp:** waarom YouTube-beeld de video niet haalde, en wat daaraan is gerepareerd
**Renders:** VID-0566 → VID-0567
**Branch:** `main` · **commits:** `f0d47a6` … `ec1c5ad` (10)
**Suite bij afsluiting:** 504 bestanden / 7589 tests, 0 gefaald

---

## 1. SAMENVATTING

Bij render 566 leverde YouTube niets: 17 video's gevonden, 17 downloads geweigerd, nul bytes
opgehaald. Oorzaak was **volgorde** — YouTube stond achteraan in de cascade en kreeg pas een beurt
als het scènebudget al op was.

Na de fix haalt render 567 **tien echte bestanden** binnen en beoordeelt de beeldredacteur **vijf
clips** op inhoud. Eén past. Die ene komt alsnog niet in de film.

Dat tweede probleem is nu volledig getraceerd: **adoptie en acceptatie zijn twee gescheiden
gebeurtenissen, in die volgorde**, en daartussen viel de clip. Het mechanisme is bewezen uit de
code; welke van twee poorten precies vuurde voor déze clip is niet vast te stellen omdat de
aangeleverde log ná de sourcing begint.

De legacy montage-route is **niet** de oorzaak. Wel bestaat er een architectuurkoppeling (P1).

---

## 2. DE CIJFERS

| youtube_cc | 566 | 567 |
|---|---:|---:|
| gevonden | 17 | 30 |
| download gestart | 0 | 19 |
| download gelukt | 0 | 10 |
| door beeldredacteur beoordeeld | 0 | 5 |
| goedgekeurd | 0 | 1 |
| in de montage | 0 | 0 |
| in de eindvideo | 0 | 0 |

De sprong van 0 naar 10 downloads en van 0 naar 5 oordelen bewijst dat de volgordefix werkt.
De 0 rechtsonder is wat er nog staat.

---

## 3. DE ASSET

```
provider        youtube_cc
sourceId        d5d161a4db2fca58
scene / beat    0 / 0
bestand         scene_0_ytcc_0__pid_youtube_cc-d5d161a4db2fca58_transformed.mp4
lineage wortel  rmtltnsb4-1#18
lineage kind    rmtltnsb4-1#30
vision          fits
selected        JA
adopted         JA
in eindvideo    NEE
beat 0 kreeg    scene_0_slot100_guaranteed.mp4
```

---

## 4. BEVINDINGEN

### 4.1 YouTube werd als laatste gevraagd — OPGELOST (`f0d47a6`, `b49d0a3`)

Zeventien weigeringen in render 566, alle identiek:

```
[Pipeline] Scene 1: skipping YouTube download of 9V7Zgx4rDDA
           — 0s left in the scene budget, not enough to finish
[YouTubeDownload] status=DOWNLOAD_TIMEOUT reason=scene_budget_too_short_to_start
                  cloudService=MISSING rapidApi=SET
```

Zeventien van de zeventien op **exact nul** seconden. Dus geen enkele clip is ooit op inhoud
beoordeeld, en geen enkele download is mislukt. Beide verklaringen die het getal
"20 gedownload / 0 gebruikt" vroeger droeg, vallen daarmee af.

YouTube gaat nu vooraan met een **eigen tijdsplak**. Niet onbegrensd: over RapidAPI is het de
traagste bron, en onbegrensd vooraan zou het archief uithongeren — dat is wat vandaag het beeld
levert. Voorbij die plak draait de cascade eronder volledig ongewijzigd.

```
566:  archief → wikimedia → stills → pexels → youtube (budget op)
567:  youtube (eigen plak) → archief → wikimedia → stills → pexels
```

### 4.2 De opstartregel loog — OPGELOST (`e25776b`)

```js
console.log("[Fastvid] YouTube clip sourcing: disabled");
```

Geen `if`, geen omgevingsvariabele. Elke start printte `disabled`, wat `ENABLE_YOUTUBE_SOURCING`
ook was. Ik nam die regel als bewijs dat de vlag uitstond. Fout: dezelfde render deed 17 echte
YouTube-zoekopdrachten, en elke aanroepplek zit achter `youtubeSourcingEnabled()`. Een render met
de vlag uit *kan* niet 17 keer zoeken. **De vlag stond al aan.**

De regel leest nu de vlag plus `formatYoutubeReadiness()`.

> Een statusregel met een vaste waarde is erger dan geen regel. Het is geen stilte — het is een
> onwaarheid die juist geloofd wordt omdat hij zo specifiek klinkt.

### 4.3 De pipeline-regel loog ook — OPGELOST (`8bebc8c`)

```js
console.log("[Fastvid] Video pipeline:",
  "single-pass compose (beelden + voice + jaartallen) — geen apart edit/effecten-stadium");
```

Gevonden door te zoeken naar de *vorm* van 4.2. Erger dan de eerste, want hij doet een uitspraak
over de architectuur — onjuist zodra de cinematische vlaggen aanstaan. Rapporteert nu drie
toestanden, want "wel gepland, nog niet geleverd" is een echte toestand die een ja/nee-regel
verkeerd zou weergeven.

### 4.4 Het archief kapte zijn eigen cachebestanden af — OPGELOST (`8bebc8c`)

18 archiefassets verloren aan 28 fouten:

```
curated asset 57364 failed: ENOENT: no such file or directory,
copyfile '/app/uploads/archive-s3-cache/media-archive_37_…mp4' -> '/var/tmp/…mp4'
```

De ENOENT zit op de **bron** — het cachebestand dat `existsSync` één regel eerder had bevestigd.
De cache werd gevuld met `copyFileSync(destPath, cachePath)` recht op het levende pad, en
`copyFileSync` **kapt zijn doel eerst af**. Een scène hergebruikt zijn beste clips over meerdere
beats, met meerdere renders tegelijk — in dat gaatje vallen is de normale gang van zaken.

Nu: schrijven naar een tijdelijke naam ernaast + `rename` (atomair). Een mislukte lees valt terug
op de download in plaats van de asset op te geven.

### 4.5 Twee definities van "ophaalbaar" — OPGELOST (`8dc834e`)

De cinematische planner gooide 12 van de 13 beats weg:

```
[CinematicPipeline] inputs scenes=2 beats=13 planned=2 dropped=12
[CinematicPipeline] dropped s1b1: adopted clip has no rehydratable identity (provider=unknown)
[AssetIdentity]     s1c1 provider=UNVERIFIED archiveAssetId=57449 … rehydratable=true
```

Vijf van de tien geleverde clips: echt archiefnummer, geen providernaam.

| functie | vraag | antwoord |
|---|---|---|
| `identityIsRehydratable` | ophaalbaar? | `if (archiveAssetId != null) return true` → **ja** |
| `identityFrom` | ophaalbaar? | eiste óók een providernaam → **nee** |

Dat het archiefnummer alleen werkt staat in de log: `REHYDRATION_DOWNLOAD_FAILED —
archiveAssetId=57353 could not be read from storage`. Hij probeerde het — en liep tegen opslag aan,
niet tegen een weigering.

`identityFrom` was een tweede implementatie. Die kopie is weg. En dat is op één punt **strenger**:
een clip waarvan de enige houvast een verlopende CDN-link is, wordt nu geweigerd.

### 4.6 Eén asset met twee levensverhalen — OPGELOST (`d32dc19`)

```
#18  reachedSelected=true   reachedAssigned=false   DROPPED_WITHOUT_EVENT
#30  reachedSelected=false  reachedAssigned=true    DROPPED_WITHOUT_EVENT
```

Exact gespiegeld, zelfde scène, beat, provider, bestand. Die spiegeling is het bewijs dat het
**één** asset is. `adoptClip` doet de fair-use-transform, `linkDerivedPath` opent met opzet een
kindrecord (zo overleeft de herkomst een hernoeming) en zet `ADOPTED` op het kind; `SELECTED` stond
al op de ouder. De audit liep de records plat af.

De audit vouwt een afleidingsketen nu op zijn wortel. Eén asset, één regel, met `derivedIds=` zodat
elk gebeurtenis-record bereikbaar blijft.

### 4.7 Een weigering aan de deur legde niets vast — OPGELOST (`d2ed83c`, `c21425c`)

Elke `pushSceneClip` begint met dezelfde twee weigeringen — de relevantiebarrière en "deze render
gebruikte dit beeld al". Beide waarschuwden naar de console en gaven `false` terug. **Geen van
beide raakte de ledger.**

Dat is geen ontbrekende logregel. Een clip die daar wordt geweigerd komt nooit in de clip-lijst van
de scène — en `noteSceneClipsResourced`, de enige plek die `REPLACED` schrijft, loopt precies die
lijst af. De asset is dus onzichtbaar voor het enige mechanisme dat hem achteraf had kunnen
verklaren.

Er zijn **vier** `pushSceneClip`-varianten. De registratie zit nu op het ene punt dat alle vier al
aanroepen, met een telling in de test zodat een vijfde route die niets vastlegt de suite laat falen.

### 4.8 "Exhausted" werd beweerd, niet gecontroleerd — OPGELOST (`ec1c5ad`)

Vlak vóór het maken van de filler printte de rescue:

```
[VisualCoverage] s0b0: rejected=0 topRejects=none contextualSearch=true
                 fallback=PLACEHOLDER (all real/contextual/AI sourcing strategies exhausted)
```

Er was niets uitgeput. En `rejected=0` is precies hoe een beat eruitziet die nóóit iets aangeboden
kreeg. Nu:

```
fallbackReason=REAL_ASSET_REJECTED (<gate reason>)      ← als de tally niet nul is
fallbackReason=ALL_SOURCING_EXHAUSTED (nothing was offered for this beat)
```

### 4.9 De push zei niets — OPGELOST (`ec1c5ad`)

`pushSceneClip` is het smalste punt waarop een clip de clip van een beat wordt — de enige schrijver
van `clipBeatIndices`, wat de enige leegte-test is die de rescue doet. Elke aanroeper doet
`await pushClip(clip);` en **gooit het antwoord weg**.

`tracePushOutcome` schrijft nu één `[PushTrace]`-regel bij beide weigeringen en bij elke
acceptatie, op canonieke identiteit (provider + provider asset id, opgevouwen tot de wortel), nooit
op pad of positie. Een clip die de ledger niet kent print `asset=unknown` met de bestandsnaam — een
eerlijke leemte, geen gok.

Het tellen van de acceptatieplekken vond een **vijfde** schrijver van `clipBeatIndices` die géén
`pushSceneClip` is: een lus die de clip-lijst opnieuw zaait uit de adopt-audit en beats toewijst
zonder de poorten te passeren. Ook getraceerd, met eigen reden `accepted_reseed`.

### 4.10 De invariant — OPGELOST (`5d9ef0a`)

De render controleert nu zichzelf op de toestand die VID-0567 had:

```
een ADOPTED echte asset + dezelfde beat + een filler + geen afloop op de asset
```

`formatFillerOverAdoptedAsset` meldt `INVARIANT_BROKEN` op error-niveau. Hij **rapporteert**; hij
zet de geweigerde clip niet terug — een barrière die dit beeld verkeerd vond bij deze vertelling
nam een redactionele beslissing.

Zeven van de twaalf tests leggen vast dat hij **stil blijft**: video gehaald, weigering vastgelegd,
expliciete REPLACED, filler op een andere beat, geen filler, nooit geadopteerd, download mislukt.
Een invariant die afgaat bij gezonde renders is ruis, en ruis is hoe een echte vondst wordt
weggescrold.

---

## 5. DE ROOT CAUSE, VOLLEDIG GETRACEERD

```
1. de funnel kiest een winnaar → funnelClip = clipPath          videoPipeline ~33373
2. recordEvent(…, "ADOPTED")                                    ~33405
3. if (funnelClip) clip = funnelClip                            ~33662
4. await pushClip(clip);          ← BOOLEAN WEGGEGOOID          ~33942, ~33964, ~34039
5. pushSceneClip weigert (barrière of duplicaat)                4 definities
6. geen clipBeatIndices.push → de beat leest als leeg
7. if (!clipBeatIndices.includes(beat.index))                   ~31666
8. rescueBeatVisualWhenEmptyInner
9. generateGuaranteedBeatClip(scene.index, beat.index + attempt * 100, …)
10. → scene_0_slot100_guaranteed.mp4     (beat 0, poging 1 = slot 100)
```

**Adoptie en acceptatie zijn scheidbaar, in die volgorde.** Een asset kan dus geadopteerd zijn en
de film nooit halen.

| | |
|---|---|
| verantwoordelijke functie | `pushSceneClip` + de drie `await pushClip(...)` die het resultaat negeren |
| verantwoordelijke route | **SHARED** — de beat-vulroute, vóór beide montages |
| waarom de filler koos | `clipBeatIndices` had geen beat 0 |
| wat ontbrak | de weigering werd nergens vastgelegd |

---

## 6. LEGACY VS NIEUWE MONTAGE

**Voor deze clip: NIET CAUSAAL.** De asset was al verdwenen tijdens retrieval, vóórdat
`composeSceneVideo` of de cinematische planner draaide. Legacy compose kan onmogelijk
verantwoordelijk zijn voor iets dat nooit in zijn invoer zat.

**Architecturaal: WEL KOPPELING (P1).**

```js
clipPaths: composedForScene.length > 0 ? composedForScene : sceneVisualResults[i]?.clips ?? []
```

`composedUsedClips` wordt geschreven **dóór** compose (regels 38741, 38784, 39578, 39680) en is de
**voorkeursinvoer** van de cinematische planner. De canonieke retrieval-state is slechts de
terugval.

Compose *overschrijft* `sceneVisualResults` niet — die blijft intact. Maar wat compose weglaat,
ziet de planner niet. Niet gewijzigd deze ronde: dat vraagt om een aparte, gemeten beslissing.

---

## 7. WAT IK FOUT DEED

Drie keer, en alle drie staan ze hier omdat ze het verhaal bepaalden.

1. **Ik geloofde een hardgecodeerde logregel** (4.2) en concludeerde dat de YouTube-vlag uitstond.
   Hij stond al aan. Kosten: een uur aan de verkeerde verklaring.

2. **Mijn eerste volgordefix zat op de verkeerde route.** Elf tests, allemaal groen, allemaal
   correct — ze bewezen dat de code vooraan stond in `fetchBeatArchivalThenPexels`. Alleen gebruikt
   de productie die functie niet. *Een test kan een feit bevestigen dat niet uitmaakt.*

3. **Ik dacht dat `pad_combined_*`-bestanden hun herkomst verliezen**, schreef die fix, en zag bij
   het controleren van de aanroepplek dat hij er al stond (`videoPipeline.ts:28266`). Volledig
   teruggedraaid, niets van bewaard.

Daarnaast één feitelijke correctie op mijn eigen eerdere rapport: ik stelde dat alléén
`pushSceneClip` `clipBeatIndices` vult. Er is een vijfde schrijver (4.9).

---

## 8. HET PATROON

Zes van de tien bevindingen hebben dezelfde vorm: **één regel, twee implementaties, één ervan
fout.**

- de opstartbanner beweert iets dat de code niet controleert (4.2, 4.3)
- de volgordefix zit op een route die de productie niet neemt (misdiagnose 2)
- `identityFrom` naast `identityIsRehydratable` (4.5)
- vier `pushSceneClip`-varianten met dezelfde vergeten registratie (4.7)
- vijf schrijvers van `clipBeatIndices`, één buiten de poorten (4.9)

Van de 504 testbestanden lezen er 253 de broncode als tekst. Die bewijzen dat code een bepaalde
**vorm** heeft, niet dat hij **werkt** — en al helemaal niet dat de productie er langskomt. Slechts
22 bestanden draaien echt ffmpeg, op materiaal dat ffmpeg zelf verzint, omdat deze omgeving geen
sleutels heeft.

---

## 9. COMMITS

| commit | wat |
|---|---|
| `f0d47a6` | YouTube eerst vragen, binnen een eigen tijdsplak |
| `b49d0a3` | dezelfde fix op de route die de render écht neemt (de funnel) |
| `e25776b` | de opstartbanner rapporteert de YouTube-vlag i.p.v. hem te beweren |
| `8bebc8c` | tweede hardgecodeerde banner + atomaire archief-cache |
| `8dc834e` | één regel voor "kan deze clip teruggehaald worden" |
| `d32dc19` | één fysieke asset is één regel in de niet-gerenderd-audit |
| `d2ed83c` | een geweigerde clip krijgt een afloop op de ledger |
| `c21425c` | de placeholder-beslissing meldt de weigering die hem veroorzaakte |
| `5d9ef0a` | de render controleert de filler-invariant op zichzelf |
| `ec1c5ad` | end-to-end asset-lineage forensische logging |

---

## 10. NIEUWE TESTS

| bestand | tests | bewijst |
|---|---:|---|
| `youtubeIsAskedFirst` | 11 | YouTube gaat eerst, begrensd, mis valt door |
| `startupBannerTellsTheTruth` | 10 | beide bannerregels zijn berekend, in beide richtingen |
| `archiveCacheIsAtomic` | 9 | temp+rename; een mislukte lees is een misser, geen dode asset |
| `oneRehydratabilityRule` | 11 | één regel voor ophaalbaarheid; strenger op verlopende links |
| `oneAssetOneLifecycle` | 12 | ouder/kind vouwt tot één asset; verbergt niets |
| `refusalIsAnOutcome` | 9 | elke weigering krijgt een terminale afloop, alle 4 routes |
| `adoptedAssetVsGuaranteedFiller` | 10 | de tally verandert echt; de keten blijft bedraad |
| `fillerOverAdoptedAsset` | 12 | de invariant vuurt — en blijft stil bij gezonde renders |
| `pushTraceIsComplete` | 12 | beide uitkomsten getraceerd, op identiteit, aan elke deur |

---

## 11. VERIFICATIE

| controle | resultaat |
|---|---|
| typecheck (`tsc --noEmit`) | **schoon** |
| build | **ok** |
| suite deel 1 | 167 bestanden / 1935 tests |
| suite deel 2 | 170 bestanden / 3727 tests |
| suite deel 3 | 167 bestanden / 1927 tests |
| **totaal** | **504 bestanden / 7589 tests, 0 gefaald** |
| overgeslagen | 5 bestanden / 15 tests |
| preflight | `PRODUCTION_RENDER_BLOCKED` |

De suite draait in drie delen omdat parallel draaien tegen een OOM-kill (exit 137) aanliep.

**Aangepaste bestaande tests** — beide verbreed, geen enkele versoepeld:

- `ronde151CinematicInputs` — de identiteit krijgt nu een echte Wikimedia-paginalink, berekend uit
  het File:-nummer. Die link is **opgenomen** in de assertie in plaats van het veld weg te laten;
  dat legt de afbeelding vast en is een sterkere claim dan zeggen dat het veld ontbreekt.
- `ronde103CentralGate` — de content key wordt één keer berekend en hergebruikt. De assertie eist
  nu óók dat hergebruik en de registratie, zodat een tweede apart afgeleide sleutel faalt.
- `visionGateIdentityFix` — zeven `idx + 3000`-vensters zijn structureel gemaakt (tot einde
  functie). Een venster in tekens bewaakt de lengte van de code, niet het gedrag.

---

## 12. INSTELLINGEN

| variabele | nu | advies |
|---|---|---|
| `ENABLE_YOUTUBE_SOURCING` | aan | laten |
| `YOUTUBE_API_KEY` / `RAPIDAPI_KEY` | gezet | laten |
| `YOUTUBE_CC_DL_SERVICE` | leeg | alleen bij bewezen timeouts |
| `CINEMATIC_EDITING_ENGINE` | aan | laten |
| `CINEMATIC_RENDER_PATH` | **uit** | **uit laten** |

`CINEMATIC_RENDER_PATH` pas aanzetten als een verse log laat zien dat `[CinematicPipeline] dropped=`
laag is. Bij render 567 zou aanzetten een film van 2 clips hebben opgeleverd in plaats van 19. Dat
de vlag uitstond heeft dat voorkomen.

---

## 13. WAT OPEN STAAT

**Welke van de twee weigeringen vuurde voor `d5d161a4db2fca58`.** Het mechanisme is bewezen; de
aangeleverde log begint ná de sourcing. Een verse render zegt het nu wél.

**AssetUsageSummary** — `found=30` naast `unused=30` terwijl er 10 gedownload zijn, kan niet
allebei kloppen. Vraagt om een herzien telmodel met expliciete noemers per teller. Bewust niet
aangeraakt: het raakt elke provider en elke rapportregel, en dat naast de lineagewijzigingen
doorvoeren maakt beide onbewijsbaar in één render.

**De trechter 30 → 1.** Van 30 kandidaten blijft er 1 over vóór de ranking. Zware filter, welke is
onbekend. Geen drempel verlaagd voordat die verdeling bekend is.

**De cinematic/render-helft van de trace.** `CINEMATIC_INPUT`, `CINEMATIC_DROPPED` met concrete
redenen op canonieke identiteit, `[FinalRenderInputs]`, `[FinalRenderAsset]`, `[FinalAssetPresence]`
en de vier validator-cases zijn **niet** gebouwd. De planner logt zijn drops wel
(`[CinematicPipeline] dropped sNbM: <reden>`), maar niet op asset-identiteit.

**De opslagfout.** `archiveAssetId=57353 could not be read from storage` — dat is de S3/R2-lees,
niet de lokale cache uit 4.4. Ander defect, niet onderzocht.

**Legacy compose als voorkeursinvoer van de planner** (hoofdstuk 6). P1, niet gewijzigd.

---

## 14. DE VOLGENDE RAILWAY-RENDER

Zet:

```
CINEMATIC_EDITING_ENGINE=true
CINEMATIC_RENDER_PATH=false
```

Log **vanaf de eerste regel** van de render — niet vanaf halverwege. Dat is precies waarom
hoofdstuk 13 nog openstaat.

**Goed teken:**

```
[Fastvid] YouTube clip sourcing: enabled …
[Funnel] s…b…: YouTube candidate moved to the front of the download order
[YouTubeDownload] … status=OK
[PushTrace] scene=0 beat=0 asset=youtube_cc:… accepted=true reason=accepted
[CinematicPipeline] inputs … dropped=0        (of laag, met begrijpelijke redenen)
```

**Nog mis:**

```
status=DOWNLOAD_TIMEOUT reason=scene_budget_too_short_to_start
[PushTrace] … accepted=false reason=<gate>
[VisualCoverage] … fallbackReason=REAL_ASSET_REJECTED (<reden>)
[FillerOverAdopted] INVARIANT_BROKEN …
```

Die laatste vier zijn geen fouten in de logging — het zijn de antwoorden. `PushTrace` met
`accepted=false` vertelt je precies welke poort de clip weigerde en waarom, en dan is de
vervolgvraag of die weigering terecht was.

---

## 15. EINDOORDEEL

**GO** voor de Railway-test. Propagatie is getraceerd, elke weigering krijgt een expliciete afloop,
de invariant is testbaar afgedwongen, de suite is groen.

**NO-GO** voor `CINEMATIC_RENDER_PATH=true` tot die render laat zien dat de nieuwe montage de
assets behoudt.

**Op de vraag "kan ik nu voor iedere visual exact volgen waarom hij wel of niet in final.mp4 kwam?"
is het antwoord: bijna.** Van `FOUND` tot en met de beat-toewijzing is het sluitend — dat is de
zone waar VID-0567 misging. Van de cinematische planner tot de MP4 nog niet.

---

> Tien gedownloade YouTube-clips is geen resultaat zolang er nul in de video staan.
> Dat blijft het enige cijfer dat telt.
