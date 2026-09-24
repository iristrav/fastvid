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

/* ═══════════════════ THE DOOR IS LOCKED ═══════════════════ */

describe("a clip the archive refused cannot be reseeded into the film", () => {
  it("RENDER 595's CLIP IS NOT CARRIED — no archive handle, no beat", async () => {
    const { dedup } = worldWith([
      { file: "ia.mp4", provider: "internet_archive", assetId: "youtube-r6LB5toWr5I", beat: 0, archiveAssetId: null },
    ]);
    const { seeded, clips } = await seed(dedup);
    expect(seeded, "an unarchived clip was reseeded into the film").toBe(0);
    expect(clips).toEqual([]);
  });

  it("AND THE SAME CLIP IS CARRIED ONCE IT IS ARCHIVE-BACKED", async () => {
    /**
     * The other direction, so the fix cannot be satisfied by refusing everything. Nothing about a
     * legitimate rebuild changed: a clip this render proved and stored is still carried rather
     * than re-sourced from an empty list, which is what RC-3 added the seeding for.
     */
    const { dedup } = worldWith([
      { file: "ia.mp4", provider: "internet_archive", assetId: "youtube-r6LB5toWr5I", beat: 0, archiveAssetId: 57743 },
    ]);
    const { seeded, clips, clipBeatIndices } = await seed(dedup);
    expect(seeded).toBe(1);
    expect(clips).toEqual([path.join(dir, "ia.mp4")]);
    expect(clipBeatIndices).toEqual([0]);
  });

  it("THE REFUSAL IS PROVIDER-AGNOSTIC — no name is special", async () => {
    /**
     * §7 — the rule may not be `if (provider === "youtube_cc")`. Every external provider with no
     * handle is refused, and every one of them is carried with a handle. The two stock providers
     * are RONDE 9's standing exemption and are asserted separately below.
     */
    for (const provider of ["youtube_cc", "wikimedia", "internet_archive", "loc", "nasa"]) {
      const without = worldWith([{ file: "yt.mp4", provider, assetId: "a1", beat: 0, archiveAssetId: null }]);
      expect((await seed(without.dedup)).seeded, `${provider} was reseeded unarchived`).toBe(0);

      const withHandle = worldWith([{ file: "yt.mp4", provider, assetId: "a1", beat: 0, archiveAssetId: 900 }]);
      expect((await seed(withHandle.dedup)).seeded, `${provider} was refused when archived`).toBe(1);
    }
  });

  it("and stock no longer passes unstored — pexels and pixabay need their own archive copy too", async () => {
    /**
     * RONDE 9 still keeps these two out of the CURATED archive: `sourceMayEnterCuratedArchive`
     * refuses them, and a stock clip tagged "adolf hitler" never outranks real footage again.
     *
     * RONDE 647 — but they are no longer carried WITHOUT a handle. Video 604 was not delivered
     * because a Pexels shot had no archive asset, which the delivery gate refuses. Stock is now
     * stored in the separate Stockbeelden archive before it may enter the film; in this world no
     * storage answers, so the clip is refused like any other clip that cannot be read back.
     */
    for (const provider of ["pexels", "pixabay"]) {
      const { dedup } = worldWith([{ file: "yt.mp4", provider, assetId: "1", beat: 0, archiveAssetId: null }]);
      expect((await seed(dedup)).seeded, `${provider} entered the film with no archive copy`).toBe(0);
    }
  });
});

/* ═══════════════════ A LOST BEAT IS A REASON ═══════════════════ */

describe("a clip that loses its beat gets an ending", () => {
  it("RENDER 595's YOUTUBE CLIP IS NOT DROPPED IN SILENCE", async () => {
    /**
     * Two assets adopted for the same beat — the shape scene 0 was in. One wins; the other must
     * leave a record saying so, instead of the bare `continue` that produced
     * "dropped a fetched asset nothing refused".
     */
    const { lineage, dedup } = worldWith([
      { file: "ia.mp4", provider: "internet_archive", assetId: "ia1", beat: 0, archiveAssetId: 57743 },
      { file: "yt.mp4", provider: "youtube_cc", assetId: "gPOOfUxvc0w", beat: 0, archiveAssetId: 57744 },
    ]);
    const { seeded } = await seed(dedup);
    expect(seeded, "both clips took the same beat").toBe(1);

    const loser = lineage.resolve(path.join(dir, "yt.mp4"));
    expect(loser, "the losing clip has no ledger record").toBeTruthy();
    const events = lineage
      .allEvents()
      .filter((e) => e.lineageId === loser!.lineageId)
      .map((e) => `${e.stage}:${e.reason ?? ""}`);
    expect(
      events.some((e) => e.includes("superseded_by_winner") || e.includes("beat_already_held")),
      `the losing clip's ending was not recorded — events were ${events.join(" | ")}`
    ).toBe(true);
  });

  it("the winner keeps its beat and is unaffected", async () => {
    const { dedup } = worldWith([
      { file: "ia.mp4", provider: "internet_archive", assetId: "ia1", beat: 0, archiveAssetId: 57743 },
      { file: "yt.mp4", provider: "youtube_cc", assetId: "gPOOfUxvc0w", beat: 0, archiveAssetId: 57744 },
    ]);
    const { clips, clipBeatIndices } = await seed(dedup);
    expect(clips).toEqual([path.join(dir, "ia.mp4")]);
    expect(clipBeatIndices).toEqual([0]);
  });

  it("two clips on DIFFERENT beats both survive — this is not a cap", async () => {
    const { dedup } = worldWith([
      { file: "ia.mp4", provider: "internet_archive", assetId: "ia1", beat: 0, archiveAssetId: 57743 },
      { file: "yt.mp4", provider: "youtube_cc", assetId: "gPOOfUxvc0w", beat: 2, archiveAssetId: 57744 },
    ]);
    const { seeded, clipBeatIndices } = await seed(dedup);
    expect(seeded).toBe(2);
    expect(clipBeatIndices).toEqual([0, 2]);
  });
});

/* ═══════════════════ THE SOURCE SAYS IT TOO ═══════════════════ */

describe("the seed route's own body", () => {
  it("ASKS THE ARCHIVE QUESTION, with the same call every other route uses", () => {
    expect(SEED, "the seed route is gone").not.toBe("");
    /**
     * The exact call, not merely the name: a mutation proved a presence check passes while the
     * branch is switched off.
     */
    expect(SEED).toContain("const archived = await ensureArchiveBackedBeforePush(");
    expect(SEED).toContain("if (!archived.ok) {");
    expect(SEED).toContain("recordArchivePushRefusal(dedup, candidate, scene.index, entry.beatIndex, archived.reason);");
  });

  it("AND IT ASKS BEFORE THE CLIP IS GIVEN A BEAT", () => {
    /**
     * Order is the whole point. Refusing after `clips.push` would be refusing a record rather than
     * a picture — RONDE 93's finding, which is why the gate lives at the push and not at the
     * recorder.
     */
    const gate = SEED.indexOf("ensureArchiveBackedBeforePush(");
    const push = SEED.indexOf("clips.push(candidate);");
    expect(gate).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(gate);
  });

  it("A TAKEN BEAT RECORDS AN ENDING RATHER THAN CONTINUING IN SILENCE", () => {
    expect(SEED).toContain('"superseded_by_winner",');
    expect(SEED).toContain("beat_already_held");
    expect(SEED, "the silent skip is back").not.toContain(
      "if (takenBeats.has(entry.beatIndex)) continue;"
    );
  });

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

  it("the compose barrier is still asked, and still first", () => {
    /** The editorial question was never the problem and is unchanged. */
    const barrier = SEED.indexOf("composeBarrierAllows(");
    const gate = SEED.indexOf("ensureArchiveBackedBeforePush(");
    expect(barrier).toBeGreaterThan(0);
    expect(barrier).toBeLessThan(gate);
  });

  it("the replacement policy is still closed", () => {
    /** §12 — nothing here widens who may replace a proven picture. */
    expect(PIPELINE).toContain(
      "const SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE: ReadonlySet<SceneResourceSite> = new Set();"
    );
  });
});
