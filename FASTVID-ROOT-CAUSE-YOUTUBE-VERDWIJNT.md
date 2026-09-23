# ROOT CAUSE — WAAR DE YOUTUBE-CLIPS VERDWIJNEN

Fase 1 en 2 van de opdracht. **Geen code gewijzigd. Geen render gedraaid.**

---

## Het antwoord in één regel

`server/videoPipeline.ts:51853`:

```ts
const clipForBeat = pairClipsToBeats({
  clipPaths: usingCompose ? composedForScene : canonicalForScene,
  adoptions: visualDedup.clipAdoptAudit.filter((e) => e.sceneIndex === scene.index),
  beats,
  basenameOf: (clipPath) => path.basename(clipPath),
});
```

met, twintig regels hoger:

```ts
const composedForScene   = composedUsedClips[i] ?? [];        // wat de LEGACY compose gebruikte
const canonicalForScene  = sceneVisualResults[i]?.clips ?? []; // wat retrieval ADOPTEERDE
const usingCompose       = composedForScene.length > 0;
```

**Zodra de legacy compose-montage ook maar één clip heeft geproduceerd, leest de cinematic planner
compose's lijst en niet de canonieke geadopteerde set.**

Een YouTube-clip die is gevonden, gedownload, gevalideerd en geadopteerd — maar die compose niet in
zijn montage stopte — is voor de planner onzichtbaar. Hij staat in de lineage, hij heeft
`status=ASSIGNED`, en hij bestaat niet voor de timeline.

---

## Fase 2 — de gevraagde antwoorden

### A. Welke functie reduceert de input?

Niet één functie die filtert. **De planner krijgt een andere lijst aangereikt.**
`pairClipsToBeats` (`cinematicPipelineInputs.ts`) doet de koppeling correct; hij krijgt alleen
`composedForScene` in plaats van `canonicalForScene` mee.

Daarna, in `cinematicPipelineInputs.ts:929`:

```ts
const adopted = sceneFacts.clips[beatIndex] ?? null;
if (!adopted) {
  dropped.push(`${beatId}: no clip was adopted for this beat`);
  console.log(`[CinematicDrop] scene=… beat=… asset=none reason=NO_ADOPTED_CLIP`);
  return;
}
```

Een beat waarvan de clip niet in compose's lijst zat, wordt hier gedropt met
`reason=NO_ADOPTED_CLIP` — terwijl er wél een clip geadopteerd was.

**Het label liegt.** Niet kwaadwillig: vanuit deze functie gezien *is* er geen clip, want zij kreeg
de verkeerde lijst.

### B. Van hoeveel naar hoeveel?

| | |
|---|---|
| Sourcing behandelde | ~12 beats (s0b0–b2, s1b0–b5, s2b0–b3) |
| Compose leverde | **6** — `[DeliveryGate] … clips=6 route=legacy_compose` |
| Placeholders geweigerd | 2 — `[PlaceholderGate] refusedFromTimeline=2` |
| Planner-inputs | **4** — `[CinematicPipeline] decisions=4` |

De zes van de delivery gate is exact compose's telling.

### C/D/E. Welke YouTube-clips verdwijnen, en waarom?

`o6bV1XdXMdc` (s0b0), `6XnsYZxH2nI` (s2b1), `-Mr4mbLZRbE` (s2b1), `FJ3N_2r6R-o` (s2b2).

Van je lijstje met mogelijke oorzaken is het antwoord: **"nooit naar `scene.beats` gekopieerd"** —
en preciezer: *nooit aan de planner aangeboden, omdat die een andere bron leest.*

Niet gefilterd. Niet gededupliceerd. Niet afgewezen. Niet vervangen door fallback. Niet door een
cap verwijderd. **Ze staan gewoon in de verkeerde lijst.**

### F. Provider-onafhankelijk of YouTube-specifiek?

**Provider-onafhankelijk.** Elk geadopteerd asset dat compose niet gebruikt, is onzichtbaar voor de
planner — archief, wikimedia, wat dan ook.

Dat het YouTube het hardst raakt, is een gevolg: compose maakt zijn eigen selectie, en de
YouTube-clips arriveren via de scene pool laat in de scène.

---

## Wat de codebase hier zelf al over zei

Dit is geen ontdekking die ik alleen heb gedaan. De vorige ronde schreef de vraag er letterlijk bij,
op regel 51806:

> *"Compose does not OVERWRITE `sceneVisualResults` — that array is intact — but what compose leaves
> out, the planner never sees. **Whether the legacy route can therefore hide an adopted asset from
> the new one is a real question, and until now nothing in a render answered it.**"*
>
> *"Changing the preference is a separate, measured decision and is deliberately not made here.
> These lines make the next production render decide it on evidence."*

Er staat dus al een detector klaar (`videoPipeline.ts:51836`):

```
[CinematicSourceDecision]   scene=N preferredSource=composedUsedClips
                            canonicalSourceAvailable=true composedSourceCount=6 canonicalSourceCount=…
[CinematicSourceDivergence] scene=N canonicalCount=… composeCount=6 missingFromCompose=…
[CinematicSourceDivergence] scene=N asset=youtube_cc:o6bV1XdXMdc
                            canonicalState=ADOPTED composeState=MISSING file=…
```

**Precies die regel — `canonicalState=ADOPTED composeState=MISSING` — is het bewijs.**

---

## Wat ik NIET beweer

**Ik heb die regels niet gezien.** Render 600 wás de render die ze zou opleveren, en de logs zijn
weg omdat mijn documentatie-push erna een nieuwe deploy triggerde.

Dus:

| | |
|---|---|
| Het mechanisme | **BEWEZEN in code** — de ternary leest compose zodra compose iets heeft |
| Dat het in render 600 vuurde | **NIET GEMETEN** — `missingFromCompose=N` is niet waargenomen |

Het verschil is belangrijk. De code zegt dat dit kán; de divergence-regel zegt of het gebéúrde en
voor hoeveel assets.

---

## Fase 3 — de minimale fix, en waarom ik hem nog niet doe

De voor de hand liggende fix is de ternary omdraaien: altijd `canonicalForScene`.

**Dat zou ik nu fout vinden, om twee redenen die in de code staan.**

**1.** Regel 51772, §19:

> *"`composedUsedClips[i]` is written BY the compose stage… Reading only that made compose an INPUT
> to the cinematic plan, not merely a fallback behind it — delete the compose stage and this array
> is empty for every scene, every beat is dropped for having no clip, no timeline is stored."*

De vorige ronde voegde `canonicalForScene` toe als **fallback** om precies die afhankelijkheid te
breken. De voorkeur omdraaien is de volgende stap, niet dezelfde stap.

**2.** Regel 51810 zegt waarom compose's lijst soms béter is:

> *"the composed list is more accurate: it has had unusable files filtered out of it"*

Compose gooit bestanden weg die niet te gebruiken zijn. Blind naar canonical overstappen kan dus
clips binnenhalen die compose terecht verwierp — en dat is precies de "meer slechte beelden
accepteren"-val die je in elke brief verbiedt.

**De juiste fix is niet "flip de ternary" maar "voeg samen":** canonical als bron, met compose's
uitsluitingen gerespecteerd. Dat is een andere regel code en een andere test.

En om die samenvoeging goed te doen moet ik weten **welke** assets compose weglaat en waarom — wat
de divergence-regel precies rapporteert.

---

## Wat ik voorstel

**Eén render, zonder codewijziging.**

De logging die het antwoord geeft, is er al. Ik hoef niets toe te voegen. Uit die render lees ik:

```
[CinematicSourceDecision]   → leest de planner compose of canonical?
[CinematicSourceDivergence] → welke geadopteerde assets mist compose, per provider
[CinematicDrop]             → welke beats vallen af, met reason
```

Dat beantwoordt in één keer: of het mechanisme vuurt, hoeveel het kost, en of het YouTube
onevenredig raakt.

**Daarna** de fix, met bewijs, en de tests uit Fase 14.

Als je liever hebt dat ik nu al bouw, zeg het — maar dan bouw ik op een mechanisme dat bewezen is
en een omvang die geraden is, en dat is precies de combinatie die me deze sessie drie keer de
verkeerde kant op stuurde.

---

## De andere punten uit je brief

Ik heb ze niet aangeraakt, en dat is opzettelijk: jouw eigen Fase 3 zegt *"Pas nadat de oorzaak
vaststaat: fix alleen de daadwerkelijke oorzaak."*

| Fase | Onderwerp | Status |
|---|---|---|
| 5–6 | YouTube-prioriteit, 70–90% dekking | wacht op de root-cause fix — nu zou het niets doen |
| 8 | meerdere segmenten per YouTube-video | `sourceIn`/`sourceOut` bestaan al in `TimelineVideoClip` |
| 9 | shot density 8–15 per 60s | **gevolg van dezelfde oorzaak**: 4 shots omdat er 4 inputs waren |
| 10 | camerabeweging | `cameraChain` werkt; de planner vroeg 4 holds aan. Aparte vraag |
| 11 | `subject=distorted` / `subject=capture` | echt, apart van deze oorzaak |
| 12 | modern/extremistisch materiaal bij WO2 | echt, apart, en gevaarlijk |
| 13 | delivery race | echt, los, klein |

**Fase 9 is opvallend:** de "te weinig shots"-klacht is waarschijnlijk geen aparte
montage-instelling, maar hetzelfde defect. Vier shots omdat de planner vier clips kreeg. Als de
root cause klopt, lost Fase 9 grotendeels zichzelf op.

Dat is een voorspelling, en de volgende render toetst hem.

---

## Status

| | |
|---|---|
| Live commit | `d4f55bd` |
| Testsuite | 758 bestanden, 12.472 groen, 0 rood |
| Code gewijzigd deze fase | **geen** |
| MP4 render 600 | `edits/render_19_fef820f3.mp4`, 61,88s |
