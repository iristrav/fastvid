import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clipContentKey } from "./videoPipeline";
import { createBeatRelevanceLedger, recordExternalRelevanceVerdict } from "./beatVisualRelevance";
import { bindContentKeyResolver, type ClipAdoptEntry } from "./clipAdoptAudit";
import { buildBeatVisualStatuses } from "./beatVisualStatus";
import {
  buildCinematicSceneInputs,
  formatCinematicInputs,
  type AdoptedClipFacts,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import type { Scene } from "./pipeline/types";

/**
 * §21 — THE WHOLE CHAIN, FOR ONE ASSET, WITH NOTHING STUBBED IN THE MIDDLE.
 *
 * The audit's F-1 said a beat could be APPROVED by the editor, adopted, recorded `verified_fit`,
 * and still be cut from the delivered timeline — because the planner asked "can this be fetched
 * again later" and used the answer to decide "can this be shown now". Every stage did its job and
 * the viewer still saw nothing.
 *
 * This test walks the real functions in order — vision verdict, adoption audit, verification,
 * cinematic planning — and asserts the beat arrives. It is deliberately built around the clip that
 * used to fail: a real file on disk whose provider the render could never prove.
 */

let TMP: string;
const NARRATION = "Soviet troops entered the outskirts of the city that April.";

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fv-e2e-"));
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function realClip(name: string): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.alloc(4096, 3));
  return p;
}

function scene(index: number, duration: number): Scene {
  return {
    index,
    text: NARRATION,
    visualCue: "",
    pexelsQuery: "",
    aiImagePrompt: "",
    duration,
    ...({} as Record<string, never>),
  };
}

function beat(index: number, startSec: number, durationSec = 4): ProductionBeat {
  return {
    index,
    text: NARRATION,
    searchQuery: "soviet troops city april",
    powerWord: "troops",
    keywords: ["troops", "city"],
    holdSec: durationSec,
    visualDescription: "",
    voiceStartSec: startSec,
    voiceEndSec: startSec + durationSec,
  };
}

/** The whole chain for one clip, returning what each stage concluded. */
function walkChain(params: { clipPath: string; adoption: AdoptionFacts }) {
  // ── vision: the editor looked at THIS file and said it fits ──────────────────────────────
  const ledger = createBeatRelevanceLedger();
  recordExternalRelevanceVerdict(
    ledger,
    params.clipPath,
    clipContentKey(params.clipPath),
    { sceneIndex: 0, beatIndex: 0, beatText: NARRATION },
    { verdict: "fits", depicts: "troops on a street", reason: "e2e" },
    "e2e"
  );

  // ── adoption: recorded with the identity resolved from the full path ─────────────────────
  const audit: ClipAdoptEntry[] = [];
  bindContentKeyResolver(audit, clipContentKey);
  audit.push({
    sceneIndex: 0,
    beatIndex: 0,
    beatText: NARRATION,
    basename: path.basename(params.clipPath),
    source: "archive",
    contentKey: clipContentKey(params.clipPath),
  });

  // ── verification ─────────────────────────────────────────────────────────────────────────
  const [status] = buildBeatVisualStatuses(audit, ledger);

  // ── cinematic: does the plan keep the beat? ──────────────────────────────────────────────
  const facts: AdoptedClipFacts = { localPath: params.clipPath, durationSec: 4 };
  const sceneFacts: SceneFacts = {
    scene: scene(0, 4),
    beats: [beat(0, 0)],
    clips: [{ facts, adoption: params.adoption }],
  };
  const built = buildCinematicSceneInputs({ scenes: [sceneFacts] });

  return { status: status!, built };
}

describe("§21 — a verified beat reaches the timeline", () => {
  it("TEST 7 — approved → adopted → verified_fit → SURVIVES cinematic, with an unprovable provider", () => {
    /**
     * THE REGRESSION. `provider: null` is the case F-1 named: the lineage could not attribute the
     * clip, so `identityFrom` refused it and the planner dropped the beat — discarding a picture
     * the editor had approved and the report had already counted as verified.
     */
    const clip = realClip("scene_0_b0_curated_a99001.mp4");
    const { status, built } = walkChain({ clipPath: clip, adoption: { provider: null } });

    expect(status.verification).toBe("verified_fit");
    expect(status.coverage).toBe("own_footage");
    expect(status.verifiedOwnVisual).toBe(true);

    expect(built.dropped).toEqual([]);
    expect(built.scenes[0]!.beats).toHaveLength(1);
    expect(built.stats.localOnlyIdentity).toBe(1);
    expect(formatCinematicInputs(built)).toContain("localOnly=1");
  });

  it("a rehydratable asset takes the normal path and is NOT counted as local-only", () => {
    const clip = realClip("scene_0_b0_curated_a99002.mp4");
    const { status, built } = walkChain({
      clipPath: clip,
      adoption: { provider: "pexels", providerAssetId: "778899" },
    });

    expect(status.verifiedOwnVisual).toBe(true);
    expect(built.dropped).toEqual([]);
    expect(built.stats.localOnlyIdentity).toBe(0);
  });

  it("a beat whose file is genuinely gone is still dropped, with its reason", () => {
    /**
     * The half that must not move. F-1 is about not discarding a file the render HOLDS; a file
     * that does not exist is a real loss and the plan must still refuse it rather than plan an
     * edit around nothing.
     */
    const missing = path.join(TMP, "was_never_written.mp4");
    const { built } = walkChain({ clipPath: missing, adoption: { provider: null } });

    expect(built.scenes[0]?.beats ?? []).toHaveLength(0);
    expect(built.dropped.join(" ")).toContain("no rehydratable identity");
    expect(built.stats.localOnlyIdentity).toBe(0);
  });
});
