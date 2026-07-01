# Fastvid — Dynamic Render Budget

## Doel

De renderpipeline berekent alle timeouts dynamisch op basis van de werkelijke videoduur. Er zijn geen hardcoded `120_000` of `600_000` ms waarden meer voor de pipeline-stappen die met videoduur schalen.

---

## Architectuur

### Bestanden

| Bestand | Rol |
|---|---|
| `server/renderBudget.ts` | Formule, interface, logging |
| `server/renderWatchdog.ts` | Globale hard-kill watchdog, accepteert `updateBudget()` |
| `server/videoPipeline.ts` | Berekent budget na Stage 2 (TTS), slaat op in `_activeRenderBudget` |

### Lifecyle

```
runVideoPipeline()
  │
  ├─ Stage 1: Script → scenes[]
  │
  ├─ Stage 2: TTS → scenes[i].duration (echte audioduur)
  │                   │
  │                   └─ computeRenderBudget(scenes.length, totalVoSec)
  │                        ├─ logRenderBudget()         → [RenderBudget] log
  │                        ├─ _activeRenderBudget = budget
  │                        └─ watchdog.updateBudget(budget.totalMs)
  │
  ├─ Stage 3: Retrieval    ← gebruikt perBeatSearchMs, perBeatFallbackMs
  ├─ Stage 4/P5A: Compose  ← gebruikt composeSceneTimeoutMs() (complexity-aware)
  ├─ Stage 5: Concat+Music ← gebruikt concatMs, musicMixMs
  ├─ Stage 6: Upload       ← gebruikt uploadMs
  │
  └─ finally:
       watchdog.stop()
       _activeRenderBudget = null
```

---

## Budget tiers

Smoothe interpolatie binnen elke tier (geen harde sprongen):

```
videoMin = totalVoSec / 60

videoMin ≤ 3  → renderMin = 8
videoMin ≤ 6  → renderMin = lerp(8,  12, (v−3)/3)
videoMin ≤ 10 → renderMin = lerp(12, 18, (v−6)/4)
videoMin ≤ 15 → renderMin = lerp(18, 25, (v−10)/5)
videoMin > 15 → renderMin = min(25 + (v−15)×1.5, 40)   ← hard ceiling 40 min
```

### Concrete voorbeelden

| Videoduur | Render budget | Scene base | Concat | Upload | TTS | Muziek |
|---|---|---|---|---|---|---|
| 2 min | 8 min | 73 s | 60 s | 69 s | 30 s | 45 s |
| 5 min | 10 m 42 s | 87 s | 64 s | 77 s | 161 s | 51 s |
| 9 min | 16 m 30 s | 136 s | 99 s | 119 s | 248 s | 79 s |
| 15 min | 25 min | 206 s | 150 s | 180 s | 375 s | 120 s |
| 20 min | 32 m 30 s | 180 s* | 195 s | 234 s | 488 s | 156 s |

*geclampd op 180 s maximum

---

## RenderBudget interface

```typescript
export interface RenderBudget {
  // Inputs
  scenesCount: number;
  expectedVideoSec: number;      // som van scenes[i].duration na TTS

  // Global hard limit
  totalMs: number;               // watchdog budget

  // Per-stage budgets
  basePerSceneComposeMs: number; // basis per scene (voor complexity-aanpassing)
  perSceneRetrieveMs: number;    // retrieval per scene
  concatMs: number;              // finale concat
  uploadMs: number;              // storage upload
  ttsMs: number;                 // bulk TTS generatie
  musicMixMs: number;            // achtergrondmuziek mixing

  // Per-beat budgets
  perBeatSearchMs: number;       // visuele zoekopdracht per beat
  perBeatFallbackMs: number;     // stock fallback per beat
}
```

---

## Budget-allocaties (als % van totalMs)

| Stage | % van total | Floor | Ceiling |
|---|---|---|---|
| Compose (pool, alle scenes) | 55% | 45 s/scene | 180 s/scene |
| Retrieval (pool, alle scenes) | 20% | 20 s/scene | 55 s/scene |
| Beat search | 30% van retrieve/scene | 10 s | 40 s |
| Beat fallback | 20% van retrieve/scene | 5 s | 25 s |
| Concat | 10% | 60 s | 210 s |
| Upload | 12% | 60 s | 360 s |
| TTS | 25% | 30 s | 600 s |
| Muziek mix | 8% | 45 s | 180 s |

---

## Complexity-gebaseerde scene compose timeout

De per-scene compose timeout wordt verder verfijnd op basis van het aantal clips:

```
timeout = max(45s, min(basePerSceneComposeMs,
    sceneDurationSec × 3s/s + clipCount × 2.5s))
```

### Voorbeelden

| Scene | Clips | Formule | Resultaat (budget base = 136s) |
|---|---|---|---|
| 10 s | 2 clips | 10×3 + 2×2.5 = 35s | max(45s, min(136s, 35s)) = **45 s** |
| 30 s | 6 clips | 30×3 + 6×2.5 = 105s | max(45s, min(136s, 105s)) = **105 s** |
| 60 s | 12 clips | 60×3 + 12×2.5 = 210s | max(45s, min(136s, 210s)) = **136 s** |
| 15 s | 8 clips | 15×3 + 8×2.5 = 65s | max(45s, min(136s, 65s)) = **65 s** |

---

## Functies die van _activeRenderBudget lezen

| Functie | Was (hardcoded) | Nu (uit budget) |
|---|---|---|
| `beatVisualSearchMaxMs()` | 35 000 ms | `budget.perBeatSearchMs` |
| `beatStockFallbackWallMs()` | 20 000 ms | `budget.perBeatFallbackMs` |
| `composeSceneTimeoutMs()` | 75 000 ms | complexity-formula |
| `bulkVoiceoverTimeoutMs()` | 900 000 ms (!) | `budget.ttsMs` |
| `concatenateScenesWithMusic()` | 180 000 ms | `budget.musicMixMs` |
| Watchdog hard-kill | 12 min (fixed) | `budget.totalMs` (dynamisch) |

---

## Bewust hardcoded (externe API's)

De volgende timeouts zijn niet videoduur-gerelateerd en blijven hardcoded. Het zijn betrouwbaarheidsmarges voor externe services, niet pipeline-schaalkenmerken:

| Operatie | Waarde | Reden |
|---|---|---|
| Runway / Luma / Pika video download | 60 s | API-bounded, niet afhankelijk van videoduur |
| NASA video download | 60 s | idem |
| Wikimedia image download | 45 s | idem |
| AI polling retry cadence | 5 s | vaste pollinginterval |
| Blackdetect analyse | 12 s | altijd snel |
| Still image encode | 25 s | altijd snel |

---

## Watchdog

De watchdog (`server/renderWatchdog.ts`) biedt een hard-kill guarantee:

- Wordt aangemaakt met een conservatieve fallback van **18 minuten**
- Na Stage 2 (TTS) wordt `.updateBudget(budget.totalMs)` aangeroepen met het werkelijke budget
- Bij overschrijding: alle `child_process` worden SIGKILL gestuurd, `deadline` Promise rejectet
- Wordt netjes gestopt in de `finally` block van `runVideoPipeline`

```
[Watchdog] video=123 budget updated: 1080s → 990s
[Watchdog] video=123 KILL — total budget exceeded (991s > 990s) (elapsed=991s)
```

---

## Log output per render

```
[RenderBudget] video=123
  expectedVideo=9m 12s  scenes=15
  renderBudget=16m 18s
  sceneBudget=1m 30s/compose (base+clips)  29s/retrieve
  beatBudget=8s/search  5s/fallback
  concatBudget=1m 38s  uploadBudget=1m 58s
  ttsBudget=4m 4s  musicBudget=1m 18s
```
