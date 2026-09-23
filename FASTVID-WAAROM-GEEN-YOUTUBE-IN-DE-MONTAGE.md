# WAAROM STAAT ER GEEN YOUTUBE-CLIP IN DE EINDMONTAGE VAN RENDER 600?

Onderzoeksrapport. Geen code gewijzigd.

---

## Het korte antwoord

**De cinematic editor heeft niet voor andere beelden gekozen. Hij kreeg er maar vier aangeleverd.**

De vraag ging uit van een selectie die niet heeft plaatsgevonden. De YouTube-clips waren al weg
vóórdat de editor aan het werk ging.

---

## Eerst: een eerdere lezing van mij die niet klopt

In mijn vorige antwoord suggereerde ik dat latere toewijzingen de YouTube-clips "overschreven",
op grond van deze volgorde:

```
07:13:22  #32  ASSIGNED youtube_cc o6bV1XdXMdc        scene=0 beat=0
07:25:44  #133 ASSIGNED curated:asset:57387           scene=0 beat=0   route=rescue
```

Dat was een verhaal gebouwd op logvolgorde, en het is niet houdbaar. `visualSourceLineage.ts:1940`:

```ts
export const ASSET_TRACE_STATUS: Partial<Record<LineageStage, string>> = {
  FOUND: "FOUND",
  ELIGIBLE: "VALIDATED",
  SELECTED: "SELECTED",
  DOWNLOAD_SUCCEEDED: "DOWNLOADED",
  ADOPTED: "ASSIGNED",
  ...
```

**`ASSIGNED` = `ADOPTED`** — opgenomen in de clip-pool van de scène. Het is geen "deze clip wint deze
beat". Meerdere clips krijgen die status voor dezelfde scène; s2b1 heeft er twee, allebei
`route=primary`. Een tweede toewijzing bewijst dus geen vervanging.

Ook mijn tweede aanname klopte niet. Ik dacht dat de `route=rescue`-pass de beat overnam, maar die
rescue staat op `videoPipeline.ts:43277` en vuurt alleen als een scène **nul** echte clips heeft:

```ts
if (clips.filter((c) => c && !isPipelineFallbackClip(c)).length === 0 && beats[0]) {
```

Scène 0 had clips. Die tak liep dus niet.

**Beide aannames ingetrokken.**

---

## Wat er wél vaststaat

### 1. De editor kreeg vier inputs, niet twaalf

`cinematicPipeline.ts:263` — één input per beat, geen selectie:

```ts
params.scenes.forEach((scene, sceneIndex) => {
  scene.beats.forEach((beat, beatIndex) => {
    inputs.push({ ...beat.input, beatIndexInScene: beatIndex, ... });
  });
});
```

en `generateEDL` maakt één decision per input (`edl.decisions.map(...)` op regel 318).

```
[CinematicPipeline] video=600 engine=true director=true decisions=4 clips=4
                    cameras=4 transitions=1 duration=61.85s unsupported=7 held=3
```

**`decisions=4` betekent: er kwamen vier beats binnen.** De engine heeft niets weggegooid — hij kan
dat op deze route niet eens.

### 2. De reductie zat vóór de editor

```
[DeliveryGate]   DELIVERY_GATE_FAIL video=600 clips=6 route=legacy_compose
[PlaceholderGate] video=600 refusedFromTimeline=2 clipsOnTimeline=4 placeholdersOnTimeline=0
```

Zes clips bereikten de timeline-fase → twee placeholders geweigerd → vier over.

Terwijl de sourcing ongeveer twaalf beats behandelde: s0b0–b2, s1b0–b5, s2b0–b3.

### 3. De vier overlevers

| clip | provider | asset |
|---|---|---|
| `vc_5f15c5482f` | wikimedia | `File:Adolf Hitler Berghof-1936.jpg` |
| `vc_fa8473b011` | internet_archive | `youtube-fy3NVwcDD5g` |
| `vc_853890718a` | ww2 (eigen archief) | 57387 |
| `vc_5881aa62c1` | ww2 (eigen archief) | 57364 |

`fromArchive=4`. Geen directe `youtube_cc`-clip.

### 4. De vier YouTube-clips die wél geadopteerd werden

| Scène/beat | Video-id | Route |
|---|---|---|
| s0b0 | `o6bV1XdXMdc` | `fetchYouTubeCCClips`, query `"Berlin 1945"` |
| s2b1 | `6XnsYZxH2nI` | `scenePool:youtube_cc` |
| s2b1 | `-Mr4mbLZRbE` | query `"Berlin Führerbunker Adolf Hitler"` |
| s2b2 | `FJ3N_2r6R-o` | query `"Berlin Führerbunker Adolf Hitler"` |

Volledige levensloop van `6XnsYZxH2nI`: `FOUND` → `DOWNLOADED` → `VALIDATED (reason=judged)` →
`ASSIGNED`. Dat is echt en het is nieuw — render 599 had er nul.

---

## De conclusie

**Tussen ~12 beats aan sourcing en 6 clips op de timeline is de YouTube-footage verdwenen — vóór de
editor, niet door de editor.**

Welke stap dat doet, weet ik **nog niet**. Dat is de volgende trace: van `planCinematicScene`
(`videoPipeline.ts:43787` en `:45054`) terug naar hoe `scene.beats` gevuld wordt.

Ik ga die stap niet raden. Deze sessie heeft me drie keer laten zien wat dat kost: een verhaal dat
past bij de logs is niet hetzelfde als de oorzaak.

---

## Eén ding dat ik fout deed

De logs van render 600 zijn niet meer op te vragen. Mijn documentatie-push van daarna triggerde een
nieuwe Railway-deploy (`46eb617a`), en die rolde de deployment weg waar de logs op stonden.

Ik had gezegd dat die push onschadelijk was omdat er geen render liep. Dat klopte voor de render,
maar ik had moeten bedenken dat hij ook het bewijsmateriaal wegrolt waar ik nog middenin zat.

**Voortaan: geen docs-push zolang een onderzoek op de logs van de draaiende deployment steunt.**

Wat ik hierboven citeer, had ik gelukkig al woordelijk opgehaald.

---

## Twee manieren verder

**A — Code-trace, nu, zonder render.**
`scene.beats` terugvolgen naar zijn bron en vaststellen welke stap van twaalf naar zes gaat. Kost
geen render en maakt de volgende render gerichter.

**B — Volgende render, met één extra logregel.**
Per beat opschrijven wat de timeline in ging en wat niet, zodat het zichtbaar is in plaats van
afgeleid.

**Mijn voorkeur: A eerst.** Als de trace de oorzaak aanwijst, hoeft B niet. Als hij hem niet
aanwijst, weet ik wel precies welke regel B moet loggen.

---

## Status

| | |
|---|---|
| MP4 van render 600 | `edits/render_19_fef820f3.mp4`, 61,88s — bestaat, door de gate |
| Live commit | `9ddb4d9` |
| Testsuite | 758 bestanden, 12.472 groen, 0 rood |
| Openstaand defect #1 | de 61 ms-race die een geslaagde render als mislukt rapporteert |
| Openstaand defect #2 | 12 beats → 6 clips: oorzaak onbekend |
| Openstaand punt #3 | 4 clips over 62s, geen camerabeweging — nog geen montage |
