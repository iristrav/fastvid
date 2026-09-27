/**
 * NO DOOR INTO THE FILM SKIPS THE ARCHIVE.
 *
 * ── Render 595, one clip, two answers, twenty-three minutes apart ────────────────────────────
 *
 *     11:41:57  [PushTrace] scene=0 beat=0 asset=internet_archive:youtube-r6LB5toWr5I
 *                 accepted=false reason=archive not ready (ARCHIVE_INGEST_REFUSED:REJECTED)
 *     12:04:43  [PushTrace] scene=0 beat=0 asset=internet_archive:youtube-r6LB5toWr5I
 *                 accepted=true  reason=accepted_reseed
 *
 * The archive-first invariant refused this clip at the front door. A scene rebuild then carried it
 * into the film through `seedExistingProvenSceneClips`, which asked the compose barrier and
 * nothing else. It reached the timeline with `archiveAssetId=null`, and the render died on
 *
 *     ASSET_NOT_FOUND — provider=internet_archive providerAssetId=youtube-r6LB5toWr5I
 *                       has no fetchable URL
 *
 * The function's own comment had said so all along — "a beat is assigned here without passing the
 * push gates" — describing the trace, and true of the gates.
 *
 * ── And the clip that lost its beat to it ───────────────────────────────────────────────────
 *
 *     12:09:56  [SceneResourced] scene_0_resourced:strict_voice_refill dropped a fetched asset
 *                 nothing refused: provider=youtube_cc:gPOOfUxvc0w scene=0 beat=0
 *
 * `youtube_cc:gPOOfUxvc0w` was downloaded, validated, vision FIT and adopted for the same beat 0.
 * Sorted order gave the beat to the reseeded clip and the YouTube clip fell through a bare
 * `continue` with no ending written anywhere. "Nothing refused" was accurate, and was the defect.
 *
 * Both findings are this one function. Neither fix names a provider.
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "fs";

import { seedExistingProvenSceneClips, clipContentKey } from "./videoPipeline";
import { VisualSourceLedger } from "./visualSourceLineage";
import { createClipRejectAudit } from "./clipRejectAudit";

const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The seed route's body, by brace matching, so formatting is not the contract. */
const SEED = (() => {
  const at = PIPELINE.indexOf("export async function seedExistingProvenSceneClips(");
  const end = PIPELINE.indexOf("\nasync function refillSceneStrictVoiceMatch(", at);
  return at < 0 || end < 0 ? "" : PIPELINE.slice(at, end);
})();

let dir = "";
const FILES = ["yt.mp4", "ia.mp4", "wiki.mp4"] as const;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-gate-"));
  for (const f of FILES) {
    execFileSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=2",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, f)],
      { stdio: "ignore" }
    );
  }
}, 120_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * A render holding one adopted clip per spec, through the ledger's own writers.
 *
 * `archiveAssetId` is the whole subject: a clip adopted at a push gate carries the handle that
 * gate wrote, and a clip that never cleared one does not.
 */
function worldWith(
  specs: Array<{ file: string; provider: string; assetId: string; beat: number; archiveAssetId: number | null }>
) {
  const lineage = new VisualSourceLedger({ renderId: "r598" });
  for (const [i, spec] of specs.entries()) {
    const clipPath = path.join(dir, spec.file);
    const record = lineage.createLineage({
      sceneIndex: 0,
      beatIndex: spec.beat,
      candidateId: `${spec.provider}:${spec.assetId}`,
      contentKey: clipContentKey(clipPath),
      localPath: clipPath,
      provider: spec.provider,
      providerAssetId: spec.assetId,
    });
    lineage.recordEvent(record.lineageId, "ADOPTED", { status: "OK", currentPath: clipPath });
    if (spec.archiveAssetId != null) lineage.attachArchiveAsset(record, spec.archiveAssetId);
    void i;
  }
  const dedup = {
    clipAdoptAudit: specs.map((s) => ({
      sceneIndex: 0, beatIndex: s.beat, beatText: "", basename: s.file, source: s.provider,
    })),
    usedContentKeys: new Set<string>(),
    usedPaths: new Set<string>(),
    clipRejectAudit: createClipRejectAudit(),
    sourcingCache: { lineage, assets: new Map(), metrics: new Map(), totals: {}, providers: new Map() },
  } as never;
  return { lineage, dedup };
}

async function seed(dedup: unknown) {
  const clips: string[] = [];
  const beatDurations: number[] = [];
  const clipBeatIndices: number[] = [];
  const seeded = await seedExistingProvenSceneClips({
    scene: { index: 0, duration: 16, text: "a scene" } as never,
    workDir: dir,
    dedup: dedup as never,
    clips,
    beatDurations,
    clipBeatIndices,
    holdSecFor: () => 4,
    branch: "full_resource",
  });
  return { seeded, clips, clipBeatIndices };
}

/* ═══════════════════ THE SOURCE SAYS IT TOO ═══════════════════ */

describe("the seed route's own body", () => {

  it("NO PROVIDER IS NAMED ANYWHERE IN THE DECISION", () => {
    /**
     * §7 — the rule must be provider-agnostic. Every mention of a provider in this function's body
     * would be a special case; there are none, and the gate it delegates to reads the provider off
     * the ledger rather than off a literal.
     */
    const code = SEED.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const provider of ["youtube", "wikimedia", "internet_archive", "pexels", "pixabay"]) {
      expect(code.toLowerCase(), `the seed route branches on ${provider}`).not.toContain(provider);
    }
  });

  it("the replacement policy is still closed", () => {
    /** §12 — nothing here widens who may replace a proven picture. */
    expect(PIPELINE).toContain(
      "const SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE: ReadonlySet<SceneResourceSite> = new Set();"
    );
  });
});
