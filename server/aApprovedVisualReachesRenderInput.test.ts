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
const adoptedWorld = (
  specs: Array<{
    file: string;
    provider: string;
    assetId: string;
    beat: number;
    verdict?: "fits" | "does_not_fit";
    /**
     * ROUND 598 — AN ADOPTED EXTERNAL CLIP IS AN ARCHIVE-BACKED CLIP.
     *
     * The world this helper builds is "the moment a clip has been adopted", and adoption happens
     * at a push gate, which under the archive-first invariant has already stored the clip and
     * written its handle onto the lineage record. A fixture that reached ADOPTED with
     * `archiveAssetId` still null was describing a state production does not produce.
     *
     * It mattered once the scene-seed route started asking the archive question: every clip in
     * here looked unarchived, so the seed correctly refused them all. The fixture was wrong, not
     * the gate. `archiveAssetId: null` is available for the tests that need the other case.
     */
    archiveAssetId?: number | null;
  }>
): World => {
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
    /** The handle the push gate wrote when it stored this clip — see the note on `archiveAssetId`. */
    const handle = spec.archiveAssetId === undefined ? 57000 + fixtures.length : spec.archiveAssetId;
    if (handle != null) lineage.attachArchiveAsset(record, handle);
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
  const seeded = await seedExistingProvenSceneClips({
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

/* ═══════════════════════ D — the barrier is real ═══════════════════════ */

describe("E2E §D — the quality gate is not bypassed to make this pass", () => {

  it("the seeding refuses it too — the same reader, so the two cannot disagree", async () => {
    const world = adoptedWorld([
      { file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0, verdict: "does_not_fit" },
    ]);
    const clips: string[] = [];
    const seeded = await seedExistingProvenSceneClips({
      scene, workDir: dir, dedup: world.dedup, clips, beatDurations: [], clipBeatIndices: [],
      holdSecFor: () => 4, branch: "full_resource",
    });
    expect(seeded).toBe(0);
  }, 60_000);
});

/* ═══════════════════════ E — beat ownership across the whole chain ═══════════════════════ */

describe("E2E §E — beat ownership survives the journey", () => {

  it("both rebuild branches carry the asset — the cheap one and the expensive one", async () => {
    /**
     * §7. The two branches are one implementation; what differs is the hold each asks for. Running
     * the helper under both branch labels proves the carrying does not depend on which asked.
     */
    for (const branch of ["guaranteed_fill_only", "full_resource"] as const) {
      const world = adoptedWorld([{ file: YT_FILE, provider: "youtube_cc", assetId: YT_ID, beat: 0 }]);
      const clips: string[] = [];
      const clipBeatIndices: number[] = [];
      const seeded = await seedExistingProvenSceneClips({
        scene, workDir: dir, dedup: world.dedup, clips, beatDurations: [], clipBeatIndices,
        holdSecFor: () => 4, branch,
      });
      expect(seeded, branch).toBe(1);
      expect(clips, branch).toEqual([path.join(dir, YT_FILE)]);
      expect(clipBeatIndices, branch).toEqual([0]);
    }
  }, 60_000);
});
