# `server/pipeline/`

This directory holds **one file**: `types.ts`, the shared `Scene` / beat vocabulary that thirty-two
live modules import — the AI Director, the cinematic editing engine, `cinematicPipelineInputs`,
`visualMatchingV2`, `cinematicAmbient`.

It used to hold a second thing, and that is worth writing down.

## What was here, and why it is gone

A parallel "modular pipeline": `orchestrator.ts`, ten stage modules under `stages/`, a Phase-8
new-engine chain (`newPipelineStages.ts`, `newEngineFlags.ts`, `adapters.ts`, `observability.ts`)
and their tests. About 1,450 lines of production code and 1,500 of tests.

It was reachable only by setting **two** environment variables, the second of which spelled
`PIPELINE_ARCHITECTURE_CONFIRM=modular-i-understand-unverified`. It never carried a render.

The reason it could never ship was not that it was unfinished. From its own docstring:

> This orchestrator calls Media Search once per scene (its primary beat) and uses the top-ranked
> candidate; it does not implement the legacy cascade's other tiers.

**Once per scene.** Everything this system has been built around since is per *beat*: the picture
editor's verdicts, the shot vocabulary and shot-progression logic, the Asset Director's ranking, the
`BeatRelevanceLedger`, the cinematic timeline's clip-per-beat structure. The modular pipeline was not
an unverified version of today's film — it was a coarser one, with one shot where the plan asks for
six.

It was also a second Director, a second renderer, a second timeline and a second composer, in a
codebase whose standing rule is that there is exactly one of each. Two answers to one question is the
defect this programme has spent its rounds removing; keeping a rival architecture in the tree is that
defect at the largest possible scale, and it costs a reader the ability to tell which of the two the
product actually is.

## Recovering it

It is in git. `git log -- server/pipeline/orchestrator.ts` finds the commit that removed it; the
commit before that has the whole thing intact.

## What replaced it

Nothing needed to. `runVideoPipeline` (`server/videoPipeline.ts`) plans and sources; the cinematic
route (`server/cinematicProduction.ts` → `server/timelineRenderer.ts`) plans the edit and renders the
delivered file. The modularisation the orchestrator was reaching for happened anyway, in the modules
that route calls: `scenePool`, `assetDirector`, `beatVisualRelevance`, `cinematicPipeline`,
`edlToTimeline`, `timelineRenderer`, `musicDirector`, `avSyncCheck`.
