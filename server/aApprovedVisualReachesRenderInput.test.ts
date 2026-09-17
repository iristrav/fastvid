/**
 * PRE-RENDER END-TO-END — AN APPROVED VISUAL REACHES THE RENDER'S INPUT.
 *
 * ── What this proves, and what it is not ────────────────────────────────────────────────────
 *
 * Every repair since VID-0589 has been proved one seam at a time: the card's reprieve asks its
 * premise, the rebuild seeds, the ending is read in order, the gate names its check. Each of
 * those is true on its own and none of them is the claim that matters, which is that a picture
 * the editor approved travels the WHOLE way — adopted, seeded through a rebuild, over the compose
 * barrier, into the montage's inputs, into the cinematic plan, and onto the list the renderer is
 * handed — carrying the same identity at the end that it had at the start.
 *
 * So this drives the real production functions, in the real order, over real media:
 *
 *     seedExistingProvenSceneClips    the rebuild's seeding          (videoPipeline.ts)
 *     composeReadySceneClips          the compose filter             (videoPipeline.ts)
 *       └ montageClipComposeGate      ffprobe, luma, the barrier
 *       └ composeBarrierAllows        the editor's verdict           (beatVisualRelevance.ts)
 *     buildCinematicSceneInputs       the cinematic planner          (cinematicPipelineInputs.ts)
 *       └ identityFrom                the rehydration question       (assetIdentity.ts)
 *     localFilesForTimelineClips      what the renderer is handed    (cinematicPipelineInputs.ts)
 *     VisualSourceLedger              the real lifecycle bookkeeping (visualSourceLineage.ts)
 *
 * Nothing in that list is mocked. The clips are real MP4s written by ffmpeg into a temp directory,
 * so the compose gate's probes run for real and a clip that could not survive them does not
 * survive them here either.
 *
 * ── The one thing that is a double, and why ─────────────────────────────────────────────────
 *
 * The final ffmpeg concat/encode and the upload. Those are the expensive, external steps the
 * brief allows standing in for, and they are the step AFTER the question: the render input is the
 * list ffmpeg would be handed, and asserting on that list is what tells us what would be in the
 * film. No provider is contacted and nothing is downloaded — the identities are fixtures.
 *
 * ── The fixture ─────────────────────────────────────────────────────────────────────────────
 *
 * `youtube_cc:ODx7fCL6BHw` on scene 0 beat 0, alongside `internet_archive` on beat 2, with beat 1
 * deliberately empty. The YouTube id is the one named in the brief; no download is performed for
 * it and none is needed — what is under test is what happens to an asset AFTER it arrives.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  seedExistingProvenSceneClips,
  composeReadySceneClips,
  clipContentKey,
} from "./videoPipeline";
import { VisualSourceLedger, type LineageStage } from "./visualSourceLineage";
import {
  createBeatRelevanceLedger,
  composeBarrierAllows,
  type BeatRelevanceLedger,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";
import {
  buildCinematicSceneInputs,
  localFilesForTimelineClips,
  type AdoptionFacts,
  type SceneFacts,
} from "./cinematicPipelineInputs";

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/* ═══════════════════════ the fixture: real media, real identities ═══════════════════════ */

/** Render 589's own naming, so `clipContentKey` reads the identity off the path as it does live. */
const YT_ID = "ODx7fCL6BHw";
const YT_FILE = "scene_0_ytfu_0__pid_youtube_cc-132f0ec33347cc7a_transformed.mp4";
const IA_FILE = "scene_0_ia_2__pid_internet_archive-83a770cf64be57ab.mp4";
const CARD_FILE = "scene_0_slot100_guaranteed.mp4";

type Fixture = {
  file: string;
  provider: string;
  providerAssetId: string;
  beatIndex: number;
  lineageId: string;
};

let dir = "";

/**
 * A real, probe-able clip: bright and textured, so the gate's luma and black-frame checks pass on
 * their own terms rather than because anything was relaxed for the test.
 */
const makeClip = async (name: string): Promise<string> => {
  const out = path.join(dir, name);
  await execFileAsync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", out,
  ]);
  return out;
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-render-input-"));
  await Promise.all([makeClip(YT_FILE), makeClip(IA_FILE), makeClip(CARD_FILE)]);
}, 120_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const scene = { index: 0, duration: 16, text: "How Kardashians turn rumors into profits" } as never;

const beatsOf = (n = 3) =>
  Array.from({ length: n }, (_, index) => ({
    index,
    text: `Beat ${index} narration about the Kardashians.`,
    holdSec: 4,
  }));

/* ═══════════════════════ the harness: real state, nothing invented ═══════════════════════ */

type World = {
  lineage: VisualSourceLedger;
  relevance: BeatRelevanceLedger;
  dedup: never;
  fixtures: Fixture[];
};

/**
 * Put the render into the state it is in the moment a clip has been adopted — through the REAL
 * registers, with the real stages, in the real order. Nothing here is a stand-in for a lifecycle
 * event: `recordEvent` is the ledger's own writer and these are its own stage names.
 */
const adoptedWorld = (specs: Array<{ file: string; provider: string; assetId: string; beat: number; verdict?: "fits" | "does_not_fit" }>): World => {
  const lineage = new VisualSourceLedger({ renderId: "e2e-1" });
  const relevance = createBeatRelevanceLedger();
  const fixtures: Fixture[] = [];
  const clipAdoptAudit: Array<Record<string, unknown>> = [];

  for (const spec of specs) {
    const clipPath = path.join(dir, spec.file);
    const contentKey = clipContentKey(clipPath);
    const record = lineage.createLineage({
      sceneIndex: 0,
      beatIndex: spec.beat,
      candidateId: `${spec.provider}:${spec.assetId}`,
      contentKey,
      localPath: clipPath,
      provider: spec.provider,
      providerAssetId: spec.assetId,
    });
    const stages: LineageStage[] = [
      "ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_STARTED", "DOWNLOAD_SUCCEEDED", "ADOPTED",
    ];
    for (const stage of stages) lineage.recordEvent(record.lineageId, stage, { status: "OK", currentPath: clipPath });
    recordExternalRelevanceVerdict(
      relevance, clipPath, contentKey,
      { sceneIndex: 0, beatIndex: spec.beat } as BeatVisualContext,
      { verdict: spec.verdict ?? "fits", depicts: "the subject", reason: "" },
      "e2e"
    );
    clipAdoptAudit.push({
      sceneIndex: 0, beatIndex: spec.beat, beatText: "", basename: spec.file, source: spec.provider,
    });
    fixtures.push({
      file: clipPath, provider: spec.provider, providerAssetId: spec.assetId,
      beatIndex: spec.beat, lineageId: record.lineageId,
    });
  }

  const dedup = {
    clipAdoptAudit,
    usedContentKeys: new Set<string>(),
    usedPaths: new Set<string>(),
    usedCuratedAssetIds: new Set<number>(),
    usedCuratedStorageUrls: new Set<string>(),
    beatRelevance: relevance,
    sourcingCache: { lineage },
  } as never;
  return { lineage, relevance, dedup, fixtures };
};

/** Every stage this asset reached, from the ledger — never from the test's own bookkeeping. */
const stagesOf = (lineage: VisualSourceLedger, lineageId: string): Set<string> =>
  new Set(
    lineage.allEvents().filter((e) => e.lineageId === lineageId && e.status === "OK").map((e) => e.stage)
  );

const terminalReasonsOf = (lineage: VisualSourceLedger, lineageId: string): string[] =>
  lineage
    .allEvents()
    .filter((e) => e.lineageId === lineageId && e.status !== "OK")
    .map((e) => `${e.stage}:${e.status}:${e.reason ?? ""}`);

/**
 * The pipeline, from a rebuild to the list the renderer is handed — the real functions, in the
 * real order, with the real ledger recording as it goes.
 */
const runToRenderInput = async (world: World, opts: { beats?: number } = {}) => {
  const beats = beatsOf(opts.beats ?? 3);

  /* 1 — the scene rebuild's EXPENSIVE branch: an empty list, then seeding. */
  const clips: string[] = [];
  const beatDurations: number[] = [];
  const clipBeatIndices: number[] = [];
  const seeded = seedExistingProvenSceneClips({
    scene, workDir: dir, dedup: world.dedup, clips, beatDurations, clipBeatIndices,
    holdSecFor: (beatIndex) => beats.find((b) => b.index === beatIndex)?.holdSec ?? 4,
    branch: "full_resource",
  });

  /* 2 — the compose filter, with the real gate and the real barrier over real media. */
  const ready = await composeReadySceneClips(clips, scene.index, world.relevance, world.lineage);

  /* 3 — COMPOSE_INPUT / COMPOSE_SELECTED, exactly as `returnComposed` files them. */
  for (const clipPath of clips) {
    const contentKey = clipContentKey(clipPath);
    world.lineage.recordEventForPath(clipPath, "COMPOSE_INPUT", { status: "OK", contentKey });
    if (ready.includes(clipPath)) {
      world.lineage.recordEventForPath(clipPath, "COMPOSE_SELECTED", { status: "OK", contentKey });
    }
  }

  /* 4 — the cinematic planner, over the adoption facts the pipeline builds from the ledger. */
  const beatToClip = new Map<number, string>();
  clips.forEach((c, i) => {
    if (ready.includes(c)) beatToClip.set(clipBeatIndices[i]!, c);
  });
  const sceneFacts: SceneFacts = {
    scene: { ...(scene as object), beats } as never,
    beats,
    clips: beats.map((b) => {
      const clipPath = beatToClip.get(b.index);
      if (!clipPath) return null;
      const rec = world.lineage.resolve(clipPath, clipContentKey(clipPath));
      const adoption: AdoptionFacts | null = rec
        ? {
            provider: rec.provider,
            providerAssetId: rec.providerAssetId,
            archiveAssetId: rec.archiveAssetId,
            sourceUrl: rec.sourceUrl,
            originalUrl: rec.originalUrl,
            assetTitle: rec.assetTitle,
            query: rec.query,
            candidateId: rec.candidateId,
          }
        : null;
      return { facts: { localPath: clipPath, durationSec: 4 }, adoption };
    }),
  };
  /**
   * `onBeatOutcome` is the planner's own announcement of what it kept and dropped, and it is the
   * production sink — `videoPipeline` wires it to exactly this `recordEventForPath`. Collecting
   * the kept beats from it means the render input below is built from the planner's decision
   * rather than from the test's guess about it.
   */
  const plannedByBeat = new Map<number, string>();
  const cinematic = buildCinematicSceneInputs({
    scenes: [sceneFacts],
    onBeatOutcome: (o) => {
      if (!o.clipPath) return;
      if (o.stage === "CINEMATIC_SELECTED") plannedByBeat.set(o.beatIndex, o.clipPath);
      world.lineage.recordEventForPath(o.clipPath, o.stage, { status: "OK", reason: o.reason });
    },
  });

  /* 5 — what the renderer is handed, addressed the way it asks for it. */
  const timelineClips = [...plannedByBeat.keys()].map((beatIndex, i) => ({
    id: `vc_${i}`,
    sceneIndex: 0,
    beatIndex,
  }));
  const existingByClipId = localFilesForTimelineClips({
    clips: timelineClips,
    localPathFor: (s, bi) => (s === 0 ? plannedByBeat.get(bi) ?? null : null),
  });
  for (const local of existingByClipId.values()) {
    world.lineage.recordEventForPath(local, "RENDER_INPUT", { status: "OK" });
  }

  return { seeded, clips, beatDurations, clipBeatIndices, ready, cinematic, existingByClipId };
};

/* ═══════════════════════ A — YouTube, end to end ═══════════════════════ */

describe("E2E §A — an approved YouTube visual reaches the render's input", () => {
  it("walks ADOPTED → SEED → COMPOSE_INPUT → COMPOSE_SELECTED → CINEMATIC_SELECTED → RENDER_INPUT", async () => {
    const world = adoptedWorld([{ file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 }]);
    const yt = world.fixtures[0]!;
    const out = await runToRenderInput(world, { beats: 1 });

    expect(out.seeded, "the rebuild did not carry the approved clip").toBe(1);
    expect(out.ready, "the compose barrier dropped it").toContain(yt.file);

    const stages = stagesOf(world.lineage, yt.lineageId);
    for (const stage of [
      "ELIGIBLE", "RANKED", "SELECTED", "DOWNLOAD_SUCCEEDED", "ADOPTED",
      "COMPOSE_INPUT", "COMPOSE_SELECTED", "CINEMATIC_SELECTED", "RENDER_INPUT",
    ]) {
      expect(stages, `${stage} was never reached`).toContain(stage);
    }
    expect([...out.existingByClipId.values()]).toContain(yt.file);
  }, 60_000);

  it("the canonical identity at RENDER_INPUT is the one it had at ADOPTED", async () => {
    const world = adoptedWorld([{ file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 }]);
    const yt = world.fixtures[0]!;
    const before = world.lineage.resolve(yt.file, clipContentKey(yt.file))!;
    const snapshot = {
      provider: before.provider,
      providerAssetId: before.providerAssetId,
      candidateId: before.candidateId,
      lineageId: before.lineageId,
      sceneIndex: before.sceneIndex,
      beatIndex: before.beatIndex,
    };

    const out = await runToRenderInput(world, { beats: 1 });
    const delivered = [...out.existingByClipId.values()][0]!;
    const after = world.lineage.resolve(delivered, clipContentKey(delivered))!;

    expect({
      provider: after.provider,
      providerAssetId: after.providerAssetId,
      candidateId: after.candidateId,
      lineageId: after.lineageId,
      sceneIndex: after.sceneIndex,
      beatIndex: after.beatIndex,
    }).toEqual(snapshot);
    expect(after.provider).toBe("youtube_cc");
    expect(after.providerAssetId).toBe(YT_ID);
    expect(after.provider, "identity decayed to unknown").not.toBe("UNVERIFIED");
    expect(after.providerAssetId).not.toBeNull();

    /**
     * And the identity the PLANNER emitted, not only the one the ledger still holds.
     *
     * A mutation run caught this: corrupting the identity inside `identityFrom` left every
     * ledger-side assertion green, because the ledger is upstream of the planner. The plan's
     * `AssetSourceIdentity` is what the rehydrator will be handed tomorrow, so it is the one that
     * has to be right — checking only the ledger proves the render's memory, not its output.
     */
    const plannedIdentity = out.cinematic.scenes[0]!.beats[0]!.identity;
    expect(plannedIdentity.provider).toBe("youtube_cc");
    expect(plannedIdentity.providerAssetId).toBe(YT_ID);
  }, 60_000);

  it("the cinematic planner kept the beat rather than dropping it as unrehydratable", async () => {
    const world = adoptedWorld([{ file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 }]);
    const out = await runToRenderInput(world, { beats: 1 });
    expect(out.cinematic.dropped, out.cinematic.dropped.join("; ")).toHaveLength(0);
    expect(out.cinematic.scenes[0]?.beats ?? []).toHaveLength(1);
  }, 60_000);
});

/* ═══════════════════════ B — Internet Archive, the same ═══════════════════════ */

describe("E2E §B — the chain is not YouTube-specific", () => {
  it("an Internet Archive visual makes the same journey", async () => {
    const world = adoptedWorld([
      { file: IA_FILE, provider: "internet_archive", assetId: "test-ia-asset", beat: 0 },
    ]);
    const ia = world.fixtures[0]!;
    const out = await runToRenderInput(world, { beats: 1 });

    expect(out.ready).toContain(ia.file);
    const stages = stagesOf(world.lineage, ia.lineageId);
    for (const stage of ["ADOPTED", "COMPOSE_INPUT", "COMPOSE_SELECTED", "CINEMATIC_SELECTED", "RENDER_INPUT"]) {
      expect(stages, `${stage} was never reached`).toContain(stage);
    }
    const after = world.lineage.resolve(ia.file, clipContentKey(ia.file))!;
    expect(after.provider).toBe("internet_archive");
    expect(after.providerAssetId).toBe("test-ia-asset");
  }, 60_000);
});

/* ═══════════════════════ C — VID-0589's own shape ═══════════════════════ */

describe("E2E §C — render 589's scenario cannot play out again", () => {
  it("a proven beat survives a rebuild that also has a guaranteed card to hand", async () => {
    /**
     * Beat 0 holds the approved YouTube clip; beat 1 has nothing and is where 589's text card was
     * drawn. The card is present on disk and adopted as a placeholder, exactly as it was.
     */
    const world = adoptedWorld([{ file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 }]);
    (world.dedup as unknown as { clipAdoptAudit: unknown[] }).clipAdoptAudit.push({
      sceneIndex: 0, beatIndex: 1, beatText: "", basename: CARD_FILE, source: "rescue_placeholder",
    });

    const out = await runToRenderInput(world, { beats: 2 });
    expect(out.clips, "the approved clip was replaced").toContain(path.join(dir, YT_FILE));
    expect(out.clips, "a refused placeholder took a proven beat").not.toContain(path.join(dir, CARD_FILE));
    expect([...out.existingByClipId.values()]).toContain(path.join(dir, YT_FILE));
  }, 60_000);

  it("no adopted asset reaches the end without either RENDER_INPUT or a terminal reason", async () => {
    /**
     * §10, asserted rather than hoped for. Every record that reached ADOPTED must end somewhere:
     * in the renderer's list, or with a recorded refusal. "Adopted, then nothing" fails here.
     */
    const world = adoptedWorld([
      { file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 },
      { file: IA_FILE, provider: "internet_archive", assetId: "test-ia-asset", beat: 2 },
    ]);
    const out = await runToRenderInput(world);
    const delivered = new Set(out.existingByClipId.values());

    for (const f of world.fixtures) {
      const stages = stagesOf(world.lineage, f.lineageId);
      if (!stages.has("ADOPTED")) continue;
      if (delivered.has(f.file)) continue;
      const reasons = terminalReasonsOf(world.lineage, f.lineageId);
      expect(
        reasons.length,
        `${f.provider}:${f.providerAssetId} was adopted, is not in the render input, and nothing says why`
      ).toBeGreaterThan(0);
    }
  }, 60_000);
});

/* ═══════════════════════ D — the barrier is real ═══════════════════════ */

describe("E2E §D — the quality gate is not bypassed to make this pass", () => {
  it("a clip the editor refused is dropped, and the drop names the check that made it", async () => {
    const world = adoptedWorld([
      { file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0, verdict: "does_not_fit" },
    ]);
    const yt = world.fixtures[0]!;
    /** The real reader, asked directly: this clip may not compose. */
    expect(composeBarrierAllows(world.relevance, yt.file, clipContentKey(yt.file)).allow).toBe(false);

    const out = await runToRenderInput(world, { beats: 1 });
    expect(out.ready, "a refused clip reached compose").not.toContain(yt.file);
    expect([...out.existingByClipId.values()], "a refused clip reached the renderer").not.toContain(yt.file);

    const reasons = terminalReasonsOf(world.lineage, yt.lineageId).join(" ");
    expect(reasons, "the drop was silent").not.toBe("");
    expect(reasons).toContain("compose_gate");
  }, 60_000);

  it("the seeding refuses it too — the same reader, so the two cannot disagree", async () => {
    const world = adoptedWorld([
      { file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0, verdict: "does_not_fit" },
    ]);
    const clips: string[] = [];
    const seeded = seedExistingProvenSceneClips({
      scene, workDir: dir, dedup: world.dedup, clips, beatDurations: [], clipBeatIndices: [],
      holdSecFor: () => 4, branch: "full_resource",
    });
    expect(seeded).toBe(0);
  }, 60_000);
});

/* ═══════════════════════ E — beat ownership across the whole chain ═══════════════════════ */

describe("E2E §E — beat ownership survives the journey", () => {
  it("beat 0 keeps YouTube, beat 1 stays open, beat 2 keeps the archive clip", async () => {
    const world = adoptedWorld([
      { file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 },
      { file: IA_FILE, provider: "internet_archive", assetId: "test-ia-asset", beat: 2 },
    ]);
    const out = await runToRenderInput(world);

    expect(out.clipBeatIndices).toEqual([0, 2]);
    expect(out.clips).toHaveLength(2);
    expect(out.beatDurations).toHaveLength(2);
    expect(out.clipBeatIndices, "beat 1 must stay open for ordinary sourcing").not.toContain(1);

    /**
     * And the planner placed each on ITS beat, carrying ITS identity. A `CinematicBeatInput` holds
     * an `AssetSourceIdentity`, which is the stronger thing to assert than a path: it is what the
     * rehydrator will use tomorrow.
     */
    const planned = out.cinematic.scenes[0]!.beats;
    expect(planned).toHaveLength(2);
    const providers = planned.map((b) => `${b.identity.provider}:${b.identity.providerAssetId}`);
    expect(providers).toContain(`youtube_cc:${YT_ID}`);
    expect(providers).toContain("internet_archive:test-ia-asset");
    expect([...out.existingByClipId.values()]).toEqual(
      expect.arrayContaining([path.join(dir, YT_FILE), path.join(dir, IA_FILE)])
    );
  }, 60_000);

  it("both rebuild branches carry the asset — the cheap one and the expensive one", async () => {
    /**
     * §7. The two branches are one implementation; what differs is the hold each asks for. Running
     * the helper under both branch labels proves the carrying does not depend on which asked.
     */
    for (const branch of ["guaranteed_fill_only", "full_resource"] as const) {
      const world = adoptedWorld([{ file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 }]);
      const clips: string[] = [];
      const clipBeatIndices: number[] = [];
      const seeded = seedExistingProvenSceneClips({
        scene, workDir: dir, dedup: world.dedup, clips, beatDurations: [], clipBeatIndices,
        holdSecFor: () => 4, branch,
      });
      expect(seeded, branch).toBe(1);
      expect(clips, branch).toEqual([path.join(dir, YT_FILE)]);
      expect(clipBeatIndices, branch).toEqual([0]);
    }
  }, 60_000);
});
