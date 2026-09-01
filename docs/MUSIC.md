# Music: what exists, what is missing, and what it would take

Status: **there is no music catalogue.** What happens instead depends on which route renders, and
the two routes disagree — which is the first thing to fix conceptually, before any procurement.

| Route | What it does about music |
|-------|--------------------------|
| Cinematic (`CINEMATIC_EDITING_ENGINE=true`) | reports `music=unavailable` with a reason and leaves the MUSIC track **empty** |
| Legacy compose (default) | synthesises a **sine drone** with ffmpeg and mixes it in at `volume=0.22` as "background music" |

Neither route ever plays a real piece of music. The cinematic route says so; the legacy route does
not.

This document is the R217 investigation. It exists so the gap is a documented decision rather than
a thing somebody rediscovers, and so a future round does not build a second audio architecture to
fill it.

---

## 1. The honest summary

Of the seven links R217 names, **four are built and proven with real ffmpeg**, one exists but is
unreached, and two are genuinely missing.

| Link | Status | Where |
|------|--------|-------|
| Catalogue | **D — missing** | no music library in this repository |
| Selection | **C — interface only, no caller** | `MusicSource` in `server/audioAssetSource.ts` |
| Licence | **D — missing** | `AssetSourceIdentity` carries no licence field |
| Duration | **B — proven** | `MusicRequest.durationSec` + `aloop=loop=-1` in the mixer |
| Volume | **B — proven** | `volume=0.22` in the mixer |
| Ducking | **B — proven** | `sidechaincompress` against voice detection |
| Final mix | **B — proven** | `amix=inputs=3` (voice + music + ambient) |

So the missing piece is **a licensed source**, not a mixing chain. The mixer has had a working
music input all along; nothing ever hands it a file.

---

## 2. What the code actually does today

### The cinematic route — honest

`server/cinematicAmbient.ts` states the verdict as a fact, unconditionally:

```ts
music: { available: false, reason: "musicSourceUnavailable — this build has no music catalogue…" }
```

and `server/cinematicProduction.ts` prints it: `[Audio] music musicSourceUnavailable — …`.

This is deliberate and should not be "fixed" by lowering the bar. There **is** a
`ProceduralMusicSource` — a synthesised sine bed — and it is deliberately **not** wired in. Laying a
sine bed under a historical documentary and calling it music would be exactly the silent
substitution this codebase forbids everywhere else. The bed cannot answer "give me something
tense"; it answers every request and honours none, and it says so itself via
`formatMusicChoice(… moodHonoured=false)`.

`MusicSource`, `ProceduralMusicSource` and `formatMusicChoice` currently have **no production
caller**. That is correct given there is nothing to select from, but it means the selection layer
is unproven code, not working code.

### The legacy compose route — not honest, and older than the rule

`server/videoPipeline.ts` does the opposite. `generateBackgroundMusic()` builds a drone out of
ffmpeg `sine` sources — A2/E3/A3/G3 with a sub-bass and a slow AM pulse — writes it to
`bg_music.mp3`, and feeds it to the mixer as input `[1:a]`. Every legacy render therefore carries a
synthesised bed presented as background music, with no log line saying it is synthetic.

This is the same substitution the cinematic route refuses, reached by a different path. It predates
the rule rather than breaking it, and **it is deliberately left unchanged here**: altering what
every legacy render sounds like is a product decision, not an audit finding, and there is no real
render in this environment against which to measure the change. It is recorded so the choice is
explicit.

### One thing checked and cleared

`buildCinematicAudioFilter` ends with `amix=inputs=3:duration=first`, which is the exact pattern
R189 found truncating audio in `timelineFilters.ts`. It is **not** a bug here: in that graph input
`[0:a]` is the narration alone, while here it is `concatPath` — the finished programme with its
voice already embedded. `duration=first` therefore means "as long as the video", and the music and
ambient loops correctly do not extend it.

---

## 3. What the mixer already supports

`server/cinematicAudio/mixer.ts` builds a three-input graph:

```
[0:a] voice
[1:a] music   → volume=0.22 → aloop=loop=-1 → sidechaincompress(vs voice) → ducked
[2:a] ambient → ducked more gently than music
                                    → amix=inputs=3
```

Looping means a track shorter than the video is not a problem. Ducking against the voice already
works and was measured in the R189 audio audit. **No changes are needed here to support music** —
only a file on input 1.

---

## 4. What is actually needed

Three things, in order:

### 4.1 A licensed catalogue

The blocking item, and it is a **licensing and procurement** decision, not an engineering one. A
documentary distributed publicly needs music whose licence permits that. Options, roughly in
increasing cost:

- a public-domain / CC0 set committed to the repo or an object-storage bucket (cheapest, narrowest
  range, and mood coverage is usually poor);
- a subscription library with an API (Epidemic Sound, Artlist, Musicbed) — an API key and a per-
  render attribution obligation;
- a per-track licensed set curated once and stored in `media_archive_assets` alongside video.

FastVid already fetches CC-licensed **field recordings** from Freesound for ambience and SFX
(`FREESOUND_API_KEY`). Freesound is not a music library and should not be pressed into service as
one — its music content is sparse and inconsistently licensed.

### 4.2 A licence field on the audio identity

`AssetSourceIdentity` has `provider`, `providerAssetId`, `archiveAssetId`, `canonicalUrl`,
`mediaUrl`, `sourcePageUrl` and `title` — and **no licence**. For video, licence lives on
`PoolCandidate.license` and never reaches the timeline identity.

Music makes that gap matter: a subscription track carries an attribution obligation that has to
survive into the finished video's provenance, and the standing rule that `any` licence mode means
"not filtered on licence" rather than "this is licensed" applies here too. Adding one optional
field to the existing type is the right shape — **not** a parallel identity type for audio.

### 4.3 One implementation of the existing interface

`MusicSource` already has the right shape: `supports(request)` and `resolve(request)` returning an
identity, never a file, so fetching stays the rehydrator's job exactly as it is for video. A real
library implements that interface and is passed where `ProceduralMusicSource` would have gone.

Nothing else needs to change. The planner, the mixer, the ducking and the timeline's MUSIC track
are all already there.

---

## 5. What must not happen

- **Do not wire in `ProceduralMusicSource`** to make the MUSIC track non-empty. A sine bed reported
  as music is a false claim in the render log and a worse video.
- **Do not build a second audio pipeline.** The mixer, the ducking and the MUSIC track exist.
- **Do not report `music=available`** until a real track from a real licensed source is actually in
  the mix, verified by measurement.
- **Do not "fix" the legacy sine drone as a side effect** of adding a catalogue. Removing it or
  labelling it changes what every existing legacy render sounds like, and that deserves its own
  decision and its own before/after render.

---

## 6. Verdict

**Music stays D (catalogue, licence) / C (selection).**

The absent catalogue is not a bug and not an oversight: it is an unmade procurement decision. On
the cinematic route the code states that plainly on every render instead of hiding it. Once a
licensed source exists, the remaining engineering is one interface implementation and one optional
field — the mixing chain is done and measured.

The one real defect this investigation found is the **route divergence**: the legacy compose path
presents a synthesised drone as background music with nothing in the log saying so. It is recorded
here rather than fixed, because changing the sound of every legacy render is a product decision and
because there is no real render in this environment to measure a change against.
