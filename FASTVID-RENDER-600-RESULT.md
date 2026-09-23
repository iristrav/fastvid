# FASTVID — RENDER 600 RESULT

Eerste render op de gedeployde V1-fixes. Worker-deploy `ad0af82e`, gebouwd uit `d4f06a0`.

---

## Executive summary

**Er is een geldige, door de delivery gate goedgekeurde MP4.** Dat is de eerste in deze hele
sessie.

```
[DeliveryGate] DELIVERY_GATE_PASS video=600 clips=4 fromArchive=4
               route=cinematic_timeline timeline=present checks=assets+file
[RenderJob] job=19 status=completed output=edits/render_19_fef820f3.mp4
            renderer=timelineRenderer published=true clips=4 duration=61.88s
```

`checks=assets+file` betekent dat het **echte bestand** gemeten is, niet alleen de timeline.

**Maar de pipeline rapporteerde video 600 als mislukt**, 2,5 minuut vóórdat die render slaagde.
Dat is het defect van deze render, en het is een race — geen renderfout.

---

## 1. Deployment

| | |
|---|---|
| Live commit (worker) | `d4f06a0` — deploy `ad0af82e`, SUCCESS |
| Bevat | R626 t/m R631: `"he issue"`, foutmelding, transition ladder, ffmpeg-classificatie, SAFE_RENDER, archieffix |

---

## 2. Render

| | |
|---|---|
| Duur pipeline | 2261s (~38 min), `[Watchdog] stopped normally` |
| Duur render job 19 | 07:49:45 → 07:52:11 (~2,5 min) |
| Renderer | `timelineRenderer` (cinematic) |
| ffmpeg-commando's | 7 |

---

## 3. MP4 — **JA**

| | |
|---|---|
| Pad | `edits/render_19_fef820f3.mp4` |
| Duur | 61,88s (timeline: 61,85s) |
| Resolutie / fps | 1920×1080 @ 30 |
| Clips | 4 |
| Captions | 4 |
| Teksten | 6 (10 elementen aangeboden) |
| Graphics | 4, getekend door **Remotion** — `inkFrames=62/247 maxAlpha=255` |
| Audiotracks | 3, alle drie geduckt |
| Transities | 1 |
| Content check | `ok=true black=0 freeze=0 silent=2 frames=4` |
| Published | `true` |

De Remotion-graphics bevestigen dat de R616-packagingfix werkt: er wordt daadwerkelijk inkt op het
overlay-kanaal gezet.

---

## 4. YouTube

**Voor het eerst haalt YouTube de timeline op beat-niveau.** Render 599 had nul
`ASSIGNED provider=youtube_cc`; render 600 heeft er vier:

| Scène/beat | Video-id | Route |
|---|---|---|
| s0b0 | `o6bV1XdXMdc` | `fetchYouTubeCCClips`, query `"Berlin 1945"` |
| s2b1 | `6XnsYZxH2nI` | `scenePool:youtube_cc` |
| s2b1 | `-Mr4mbLZRbE` | query `"Berlin Führerbunker Adolf Hitler"` |
| s2b2 | `FJ3N_2r6R-o` | query `"Berlin Führerbunker Adolf Hitler"` |

Volledige levensloop van `6XnsYZxH2nI`: `FOUND` → `DOWNLOADED` → `VALIDATED (reason=judged)` →
`ASSIGNED`.

### Wat ik hier NIET van maak

**Geen van deze vier staat in de eindmontage.** De vier clips in de film zijn:

| clip | provider | asset |
|---|---|---|
| `vc_5f15c5482f` | wikimedia | `File:Adolf Hitler Berghof-1936.jpg` |
| `vc_fa8473b011` | internet_archive | `youtube-fy3NVwcDD5g` |
| `vc_853890718a` | ww2 (eigen archief) | 57387 |
| `vc_5881aa62c1` | ww2 (eigen archief) | 57364 |

`fromArchive=4`. De cinematic editor koos uit de pool vier andere. YouTube is dus **aantoonbaar als
bron #1 aan het werk op beat-niveau**, maar levert in deze film geen enkele clip aan het
eindresultaat.

---

## 5. Eigen archief

Werkt als bron #2, en levert het grootste deel van de film: 2 van de 4 eindclips komen rechtstreeks
uit `media-archive`, een derde uit `internet_archive`.

Ook zichtbaar: het archief is **uitgeput** voor bepaalde beats.

```
Scene 2 beat 2: no unused curated archive asset (beat tags: whispers, death, spread)   ×11
Scene 2 beat 2: rescue ladder already entered 3× — standing aside rather than entering again
Scene 2 zin 2: stock cap reached — skip emergency/last-resort stock
Scene 2 slot 2: text-overlay fallback OK
```

Drie beats in scène 2 (2, 202, 302) vielen terug op tekstkaarten. Dat is een **eerlijke
inhoudelijke tekortkoming**, geen technische fout: er is werkelijk geen ongebruikt archiefmateriaal
voor die beats.

---

## 6. AI fallback

**Niet gebruikt.** Geen Kling-, Grok- of Veo-regel in de logs.

---

## 7. Placeholderbescherming — werkt

```
[PlaceholderRefused] video=600 scene=0 beat=1 authority=ADOPT_SOURCE evidence=rescue_placeholder
    file=scene_0_slot101_guaranteed.mp4 — a card this pipeline drew is not media
[PlaceholderRefused] video=600 scene=1 beat=4 authority=ADOPT_SOURCE evidence=rescue_placeholder
    file=scene_1_slot204_guaranteed.mp4 — a card this pipeline drew is not media
[PlaceholderGate] refusedFromTimeline=2 clipsOnTimeline=4 placeholdersOnTimeline=0
```

Twee kaarten geweigerd, **nul placeholders in de film**.

---

## 8. HET DEFECT VAN DEZE RENDER — een race in de delivery gate

| tijd | gebeurtenis |
|---|---|
| 07:49:37.199 | `[RenderJob] video=600 job=19 route=cinematic_timeline queued` |
| 07:49:37.260 | `[RenderJob] route=legacy_compose RENDER_FALLBACK_USED reason=the render job worker claimed job 19 first` |
| 07:49:37.260 | `[DeliveryGate] DELIVERY_GATE_FAIL video=600 AUTHORITATIVE_RENDER_FAILED` |
| 07:49:37.443 | `[Video Generation] Error: Delivery blocked for video 600: 3 requirement(s) failed` |
| 07:49:45.334 | `[RenderJob] job=19 status=running phase=rehydrating` ← de worker begint pas |
| 07:52:06 | `[DeliveryGate] DELIVERY_GATE_PASS … checks=assets+file` |
| 07:52:11 | `job=19 status=completed published=true` |

**61 milliseconden** tussen "job in de wachtrij" en "de render heeft niets opgeleverd". De pipeline
vroeg *"heb ík het cinematic bestand gemaakt?"*, kreeg terecht nee, en las dat als *"de render is
mislukt"* — terwijl de job nog niet eens opgepakt was.

De gate die faalde beoordeelde bovendien de **verkeerde clipslijst**: `clips=6 timeline=absent
checks=assets`, dat is de compose montage inclusief de twee geweigerde kaarten. De gate die slaagde
beoordeelde `clips=4 timeline=present checks=assets+file` — de echte film.

Dezelfde signatuurfout als de rest van deze sessie: **een antwoord wordt aan één kant berekend en
doorgegeven aan een beslisser die een andere vraag stelt.**

### Gevolg

De MP4 bestaat, is gepubliceerd en is door de gate goedgekeurd — maar video 600 is in de
applicatie als mislukt weggeschreven.

---

## 9. Kwaliteit — feitelijk, geen cijfer

| | Bevinding |
|---|---|
| **Visuele relevantie** | De eindclips passen: Hitler-portret, WO2-archief, Führerbunker-materiaal |
| **Shot-variatie** | **Zwak.** 4 clips over 61,88s = ~15s per shot |
| **Camerabeweging** | **Geen.** `NO_CAMERA_MOVEMENT — every shot is static`. De planner vroeg 4 camera's aan, maar alle vier zijn holds, dus `cameraChain` gaf terecht null terug |
| **Transities** | 1 in de hele film |
| **Captions** | 4, gerenderd via libass |
| **Graphics** | 4 via Remotion, met gemeten inkt |
| **Audio** | 3 tracks, ducking actief |
| **Technisch** | 1920×1080@30, geen zwarte of bevroren frames |

**Oordeel: dit is nog geen YouTube-documentaire, het is een gevalideerde diavoorstelling met
archiefbeeld.** Vier statische shots van vijftien seconden met één transitie leest niet als montage.

### Één inhoudelijke waarschuwing

```
[AssetTrace] #195 status=ASSIGNED provider=internet_archive
  providerAssetId=white-lives-matter-montana-stickering-action-21
  scene=2 beat=2  query="As whispers of his death spread, shock reverberated through his inner circle,"
```

Internet Archive leverde op die narratie een video over een **white-supremacist stickeractie in
Montana**, en die werd toegewezen. Hij staat niet in de eindmontage van vier clips, maar dat is
geluk, geen bescherming. Modern extremistisch materiaal in een documentaire over 1945 is
inhoudelijk fout en reputationeel gevaarlijk.

---

## 10. Overgebleven zwakke subjects

De R626-fix ving de vraagzin-vorm. Er blijft een andere restcategorie:

| Beat | subject | gevolg |
|---|---|---|
| s1b2 | `distorted` | query `"his distorted"` → willekeurige Openverse-foto |
| s2b1, s2b2, s2b3 | `capture` | kaal werkwoord als onderwerp |
| s2b0 | `Berlin Führerbunker` | een plaats, getagd als `people=` |

---

## 11. Antwoord op de hoofdvraag

> "Kan FastVid op dit moment een professionele video produceren van prompt → MP4?"

**Prompt → gevalideerde MP4: JA.** Bewezen, met een delivery gate die het echte bestand las.

**Prompt → *professionele* video: NOG NIET.** Vier statische shots van vijftien seconden met één
transitie is geen montage.

---

## 12. Eén volgende actie

> **Repareer de race in de delivery gate.**

De pipeline moet zijn oordeel aan job 19 overlaten, of erop wachten — niet 61 ms na het inschakelen
concluderen dat er niets gerenderd is. Zolang dit blijft, rapporteert FastVid elke geslaagde render
als mislukt.

Daarna pas de montage-vraag: 4 clips voor 62 seconden is het volgende echte probleem, en dat is een
beslissing van de cinematic editor, niet van de renderer.

---

## Codebase

| | |
|---|---|
| Testsuite | 758 bestanden, 12.472 groen, 0 rood |
| `tsc --noEmit` | schoon |
| Onverzonden commit | `370ed8d` (alleen documentatie) |
