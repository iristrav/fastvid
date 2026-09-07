/**
 * RONDE 122 §2 — LINEAGE THAT OUTLIVES ITS PROCESS, AND THE DELIVERY IT MAKES PROVABLE.
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────
 *
 * `DELIVERED` was a declared stage of a clip's life that nothing had ever written. RONDE 120's
 * census held it as the one known gap so its permanent `false` would not be read as a fact, and
 * RONDE 122 measured why it could not simply be filled in: the ledger is built per render and
 * dies with the process, while the code that uploads the output and learns its viewer-facing URL
 * runs in a render job that may start minutes later holding only a timeline. A timeline knows
 * identities; it knows no histories.
 *
 * ── What this file guards ───────────────────────────────────────────────────────────────────
 *
 * The whole chain, at each of its joints:
 *
 *   · the snapshot carries canonical identities, and a derived clip stays part of its asset
 *   · a stored snapshot reads back, and an unusable one is REFUSED BY NAME rather than ignored
 *   · a delivery is a join against the renderer's own output, never a claim
 *   · a render failure, an upload failure and an unproven final video each write NOTHING
 *   · the writers have callers — the trap three previous rounds fell into
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  LINEAGE_SNAPSHOT_SCHEMA,
  assetIdentityKey,
  deliveredKeysFor,
  formatDeliveryRecord,
  formatDeliveryRefusal,
  parseLineageSnapshot,
  recordDeliveredLineage,
  recordDelivery,
  snapshotComposeDelivery,
  snapshotLineage,
} from "./visualLineageSnapshot";
import { VisualSourceLedger } from "./visualSourceLineage";
import { videoTrack } from "./projectTimeline";
import type { AssetSourceIdentity } from "./projectTimeline";

const CLIP = "/w/scene_0_b0_pexels_9931.mp4";
const TRIMMED = "/w/scene_0_b0_pexels_9931_trim.mp4";

function ledgerWithOneDownloadedAsset(): VisualSourceLedger {
  const ledger = new VisualSourceLedger({ renderId: "r122", videoId: 580 });
  const record = ledger.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: "pexels:9931",
    contentKey: "pexels:9931",
    provider: "pexels",
    providerAssetId: "9931",
    localPath: CLIP,
    mediaType: "video",
    route: "primary",
  });
  ledger.recordEvent(record.lineageId, "SELECTED", { status: "OK" });
  ledger.recordEvent(record.lineageId, "ADOPTED", { status: "OK" });
  return ledger;
}

/* ═══════════════ the join key both sides compute ═══════════════ */

describe("one canonical identity, computed the same way on both sides", () => {
  it("an archive asset is keyed by the row this system holds", () => {
    expect(assetIdentityKey({ provider: "own_archive", archiveAssetId: 57364 })).toBe(
      "curated:asset:57364"
    );
  });

  it("a provider asset is keyed by provider and the provider's own id", () => {
    expect(assetIdentityKey({ provider: "pexels", providerAssetId: "9931" })).toBe("pexels:9931");
  });

  it("an unproven provider has NO key, whatever else it carries", () => {
    /**
     * The point of the null. An UNVERIFIED clip with a media URL still looks fetchable, and a key
     * for it would let a delivery claim an asset this pipeline could never name.
     */
    expect(
      assetIdentityKey({ provider: "UNVERIFIED", mediaUrl: "https://example.test/a.mp4" })
    ).toBeNull();
  });

  it("a provider NAME with no asset id has no key either", () => {
    expect(assetIdentityKey({ provider: "wikimedia" })).toBeNull();
    expect(assetIdentityKey(null)).toBeNull();
  });
});

/* ═══════════════ the snapshot ═══════════════ */

describe("the lineage a render can hand to the next process", () => {
  it("carries the asset, its identity and every stage it reached", () => {
    const snap = snapshotLineage(ledgerWithOneDownloadedAsset(), {
      videoId: 580,
      timelineVersion: 3,
    });
    expect(snap.schemaVersion).toBe(LINEAGE_SNAPSHOT_SCHEMA);
    expect(snap.videoId).toBe(580);
    expect(snap.timelineVersion).toBe(3);
    expect(snap.assets).toHaveLength(1);
    expect(snap.assets[0]).toMatchObject({
      key: "pexels:9931",
      provider: "pexels",
      providerAssetId: "9931",
      sceneIndex: 0,
      beatIndex: 0,
    });
    expect(snap.assets[0]!.stages).toEqual(["FOUND", "SELECTED", "ADOPTED"]);
  });

  it("a derived clip stays part of its asset instead of becoming a second one", () => {
    /** A trim is a new file and the same picture. Two entries here would double every count. */
    const ledger = ledgerWithOneDownloadedAsset();
    const parent = ledger.allRecords()[0]!;
    const child = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "pexels:9931",
      contentKey: "pexels:9931:trim",
      localPath: TRIMMED,
      parentLineageId: parent.lineageId,
    });
    ledger.recordEvent(child.lineageId, "COMPOSED", { status: "OK" });

    const snap = snapshotLineage(ledger, { videoId: 580, timelineVersion: 1 });
    expect(snap.assets).toHaveLength(1);
    expect(snap.assets[0]!.lineageIds).toEqual([parent.lineageId, child.lineageId]);
    expect(snap.assets[0]!.stages).toContain("COMPOSED");
  });

  it("a record with no canonical identity is COUNTED, never given a key", () => {
    const ledger = new VisualSourceLedger({ renderId: "r122b", videoId: 580 });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "filler",
      contentKey: "filler:1",
      localPath: "/w/subject_card_0.mp4",
    });
    const snap = snapshotLineage(ledger, { videoId: 580, timelineVersion: 1 });
    expect(snap.assets).toEqual([]);
    expect(snap.unidentifiedRecords).toBe(1);
  });

  it("it holds no local path and no media URL — neither survives the render, one is a secret", () => {
    const ledger = new VisualSourceLedger({ renderId: "r122c", videoId: 580 });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "pexels:1",
      contentKey: "pexels:1",
      provider: "pexels",
      providerAssetId: "1",
      sourceUrl: "https://player.example.test/v.mp4?token=SECRET",
      localPath: "/home/runner/work/render-1/clip.mp4",
    });
    const stored = JSON.stringify(snapshotLineage(ledger, { videoId: 580, timelineVersion: 1 }));
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain("/home/runner");
  });

  it("truncation is stated, so a partial snapshot is never read as a smaller render", () => {
    const ledger = new VisualSourceLedger({ renderId: "r122d", videoId: 580 });
    for (let i = 0; i < 5; i++) {
      ledger.createLineage({
        sceneIndex: 0,
        beatIndex: i,
        candidateId: `pexels:${i}`,
        contentKey: `pexels:${i}`,
        provider: "pexels",
        providerAssetId: String(i),
        localPath: `/w/c${i}.mp4`,
      });
    }
    const snap = snapshotLineage(ledger, { videoId: 580, timelineVersion: 1, maxAssets: 2 });
    expect(snap.assets).toHaveLength(2);
    expect(snap.truncated).toBe(3);
  });

  it("what is kept under truncation is what got furthest, not what arrived first", () => {
    const ledger = new VisualSourceLedger({ renderId: "r122e", videoId: 580 });
    const mk = (i: number) =>
      ledger.createLineage({
        sceneIndex: 0,
        beatIndex: i,
        candidateId: `pexels:${i}`,
        contentKey: `pexels:${i}`,
        provider: "pexels",
        providerAssetId: String(i),
        localPath: `/w/c${i}.mp4`,
      });
    mk(0);
    mk(1);
    const deep = mk(2);
    ledger.recordEvent(deep.lineageId, "RENDER_INPUT", { status: "OK" });
    const snap = snapshotLineage(ledger, { videoId: 580, timelineVersion: 1, maxAssets: 1 });
    expect(snap.assets.map((a) => a.key)).toEqual(["pexels:2"]);
  });
});

/* ═══════════════ reading it back ═══════════════ */

describe("a stored snapshot that cannot be used says which of the four problems it is", () => {
  it("round-trips through JSON, which is how it is actually stored", () => {
    const snap = snapshotLineage(ledgerWithOneDownloadedAsset(), {
      videoId: 580,
      timelineVersion: 2,
    });
    const read = parseLineageSnapshot(JSON.parse(JSON.stringify(snap)) as unknown);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.snapshot.assets[0]!.key).toBe("pexels:9931");
  });

  it("reads a snapshot that was stored as a JSON string, which some drivers return", () => {
    const snap = snapshotLineage(ledgerWithOneDownloadedAsset(), {
      videoId: 580,
      timelineVersion: 2,
    });
    const read = parseLineageSnapshot(JSON.stringify(snap));
    expect(read.ok).toBe(true);
  });

  it("MISSING — nothing was ever stored", () => {
    const read = parseLineageSnapshot(undefined);
    expect(read).toMatchObject({ ok: false, problem: "MISSING" });
  });

  it("MALFORMED — something is stored and it is not a snapshot", () => {
    expect(parseLineageSnapshot("{not json")).toMatchObject({ ok: false, problem: "MALFORMED" });
    expect(parseLineageSnapshot([1, 2])).toMatchObject({ ok: false, problem: "MALFORMED" });
    expect(parseLineageSnapshot({ schemaVersion: 1 })).toMatchObject({
      ok: false,
      problem: "MALFORMED",
    });
  });

  it("SCHEMA_TOO_NEW — a newer build wrote it, and guessing at it is not allowed", () => {
    const read = parseLineageSnapshot({
      schemaVersion: LINEAGE_SNAPSHOT_SCHEMA + 1,
      assets: [{ key: "pexels:1" }],
    });
    expect(read).toMatchObject({ ok: false, problem: "SCHEMA_TOO_NEW" });
  });

  it("EMPTY — a real snapshot that names no asset cannot attribute anything", () => {
    const read = parseLineageSnapshot({ schemaVersion: 1, assets: [] });
    expect(read).toMatchObject({ ok: false, problem: "EMPTY" });
  });

  it("the refusal line names the problem instead of going quiet", () => {
    const line = formatDeliveryRefusal(580, 91, "MISSING", "no lineage was ever stored");
    expect(line).toContain("NO_LINEAGE=MISSING");
    expect(line).toContain("cannot be attributed");
  });
});

/* ═══════════════ the delivery is a join, not a claim ═══════════════ */

const timelineClips: { id: string; source: AssetSourceIdentity }[] = [
  { id: "c1", source: { provider: "pexels", providerAssetId: "9931" } },
  { id: "c2", source: { provider: "own_archive", archiveAssetId: 57364 } },
  { id: "c3", source: { provider: "UNVERIFIED" } },
];

describe("what the renderer put on screen, reduced to identities", () => {
  it("only the clips the renderer reported count — a dropped clip is simply absent", () => {
    const { keys, unidentifiedClips } = deliveredKeysFor(timelineClips, ["c1", "c2"]);
    expect(keys).toEqual(["pexels:9931", "curated:asset:57364"]);
    expect(unidentifiedClips).toBe(0);
  });

  it("a rendered clip with no canonical identity is counted, never keyed", () => {
    const { keys, unidentifiedClips } = deliveredKeysFor(timelineClips, ["c1", "c3"]);
    expect(keys).toEqual(["pexels:9931"]);
    expect(unidentifiedClips).toBe(1);
  });

  it("a clip id the timeline does not carry is unidentified, not invented", () => {
    const { keys, unidentifiedClips } = deliveredKeysFor(timelineClips, ["ghost"]);
    expect(keys).toEqual([]);
    expect(unidentifiedClips).toBe(1);
  });
});

describe("recording a delivery into a snapshot", () => {
  const snapshotOf = () =>
    snapshotLineage(ledgerWithOneDownloadedAsset(), { videoId: 580, timelineVersion: 4 });

  const deliver = (keys: string[], over: Partial<Parameters<typeof recordDelivery>[1]> = {}) =>
    recordDelivery(snapshotOf(), {
      deliveredKeys: keys,
      unidentifiedClips: 0,
      route: "render_job",
      jobId: 91,
      attempt: 2,
      published: true,
      timelineVersion: 4,
      now: 1_000,
      ...over,
    });

  it("an asset the render really carried gains DELIVERED and a timestamp", () => {
    const out = deliver(["pexels:9931"]);
    expect(out.marked).toBe(1);
    expect(out.snapshot.assets[0]!.stages).toContain("DELIVERED");
    expect(out.snapshot.assets[0]!.deliveredAt).toBe(1_000);
    expect(out.record).toMatchObject({ route: "render_job", jobId: 91, delivered: 1 });
  });

  it("an asset the snapshot does not know is NAMED, and no record is created for it", () => {
    const out = deliver(["pexels:9931", "wikimedia:File:Ghost.jpg"]);
    expect(out.snapshot.assets).toHaveLength(1);
    expect(out.record.unmatchedKeys).toEqual(["wikimedia:File:Ghost.jpg"]);
    expect(out.record.delivered).toBe(1);
  });

  it("re-running the same job cannot inflate the count", () => {
    const first = deliver(["pexels:9931"]);
    const second = recordDelivery(first.snapshot, {
      deliveredKeys: ["pexels:9931"],
      unidentifiedClips: 0,
      route: "render_job",
      jobId: 91,
      attempt: 2,
      published: true,
      timelineVersion: 4,
      now: 9_999,
    });
    expect(second.marked).toBe(0);
    expect(second.snapshot.assets[0]!.deliveredAt).toBe(1_000);
    expect(second.snapshot.assets[0]!.stages.filter((s) => s === "DELIVERED")).toHaveLength(1);
  });

  it("a snapshot from another timeline version is delivered against AND reported as stale", () => {
    const out = deliver(["pexels:9931"], { timelineVersion: 9 });
    expect(out.record.timelineVersionAtDelivery).toBe(9);
    expect(formatDeliveryRecord(580, out.record)).toContain("STALE_LINEAGE(renderedVersion=9)");
  });

  it("the log line names the route and prints no URL, key or path", () => {
    const line = formatDeliveryRecord(580, deliver(["pexels:9931"]).record);
    expect(line).toContain("route=render_job");
    expect(line).toContain("deliveredAssets=1");
    expect(line).not.toContain("http");
    expect(line).not.toContain("/w/");
  });
});

/* ═══════════════ the stage itself: written from proof, or not at all ═══════════════ */

describe("markDelivered writes what was proven and refuses what was not", () => {
  it("a render that never checked its final video claims nothing", () => {
    const ledger = ledgerWithOneDownloadedAsset();
    expect(ledger.markDelivered("legacy_compose")).toEqual({
      written: 0,
      refused: "FINAL_VIDEO_NOT_PROVEN",
    });
    expect(ledger.allEvents().some((e) => e.stage === "DELIVERED")).toBe(false);
  });

  it("a render whose final video contained nothing claims nothing either", () => {
    /** `markFinalVideo([])` is a real check with a real answer: no clip of ours reached it. */
    const ledger = ledgerWithOneDownloadedAsset();
    ledger.markFinalVideo([]);
    expect(ledger.markDelivered("legacy_compose").written).toBe(0);
  });

  it("exactly the clips proven in the delivered file are marked", () => {
    const ledger = ledgerWithOneDownloadedAsset();
    ledger.markFinalVideo([CLIP]);
    expect(ledger.markDelivered("cinematic_timeline")).toEqual({ written: 1 });
    const delivered = ledger.allEvents().filter((e) => e.stage === "DELIVERED");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.reason).toBe("cinematic_timeline");
  });

  it("it takes no clip list, so no caller can widen the claim past the proof", () => {
    /**
     * The signature is the guarantee. `markFinalVideo` is where a clip list is judged; a second
     * list here could disagree with it, and a delivery that disagrees with its own proof is the
     * fake delivery event this round exists to make impossible.
     */
    expect(VisualSourceLedger.prototype.markDelivered.length).toBe(1);
  });

  it("calling it twice does not double-count", () => {
    const ledger = ledgerWithOneDownloadedAsset();
    ledger.markFinalVideo([CLIP]);
    ledger.markDelivered();
    expect(ledger.markDelivered().written).toBe(0);
    expect(ledger.allEvents().filter((e) => e.stage === "DELIVERED")).toHaveLength(1);
  });

  it("a final video re-proven against a DIFFERENT file withdraws the old delivery claim", () => {
    /**
     * The cinematic cutover's shape: compose proves its montage, then the timeline render delivers
     * its own file and `replaceFinalVideo` re-proves against that. A DELIVERED left standing from
     * the withdrawn proof would describe a video nobody receives.
     */
    const ledger = ledgerWithOneDownloadedAsset();
    ledger.markFinalVideo([CLIP]);
    ledger.markDelivered();
    ledger.replaceFinalVideo([]);
    expect(ledger.allRecords()[0]!.finalVideoAt).toBeUndefined();
    expect(ledger.markDelivered()).toEqual({ written: 0 });
  });
});

/* ═══════════════ the compose route's own delivery ═══════════════ */

describe("the compose montage records its delivery as the compose montage", () => {
  it("what was proven and marked is what the record claims", () => {
    const ledger = ledgerWithOneDownloadedAsset();
    ledger.markFinalVideo([CLIP]);
    ledger.markDelivered("legacy_compose");
    const out = snapshotComposeDelivery(ledger, {
      videoId: 580,
      timelineVersion: 0,
      published: true,
      now: 5,
    });
    expect(out).not.toBeNull();
    expect(out!.record).toMatchObject({ route: "compose_montage", delivered: 1 });
    expect(out!.record.jobId).toBeUndefined();
    expect(out!.snapshot.assets[0]!.deliveredAt).toBe(5);
  });

  it("a render that delivered nothing of its own writes no delivery record at all", () => {
    const ledger = ledgerWithOneDownloadedAsset();
    ledger.markFinalVideo([]);
    ledger.markDelivered("legacy_compose");
    expect(
      snapshotComposeDelivery(ledger, { videoId: 580, timelineVersion: 0, published: true })
    ).toBeNull();
  });
});

/* ═══════════════ the render job's half of the chain, driven end to end ═══════════════ */

describe("the render job joins its own output against the lineage it was left", () => {
  const timeline = {
    schemaVersion: 1,
    version: 4,
    videoId: 580,
    durationSec: 12,
    format: { width: 1920, height: 1080, fps: 30 },
    createdAt: new Date(0).toISOString(),
    tracks: [
      {
        id: "video",
        kind: "VIDEO",
        clips: [
          {
            id: "c1",
            source: { provider: "pexels", providerAssetId: "9931" },
            timelineStart: 0,
            timelineEnd: 6,
            sourceInSec: 0,
            sourceOutSec: 6,
          },
          {
            id: "c2",
            source: { provider: "UNVERIFIED" },
            timelineStart: 6,
            timelineEnd: 12,
            sourceInSec: 0,
            sourceOutSec: 6,
          },
        ],
      },
    ],
  } as unknown as import("./projectTimeline").ProjectTimeline;

  const job = { id: 91, videoId: 580, attempt: 2, timelineVersion: 4 };

  function store(initial: unknown) {
    const state = { value: initial, writes: 0 };
    return {
      state,
      lineage: {
        read: async () => state.value,
        write: async (_videoId: number, snapshot: unknown) => {
          state.value = snapshot;
          state.writes += 1;
        },
      },
    };
  }

  it("the delivered asset is written back, and the unidentified clip is counted not claimed", async () => {
    const stored = snapshotLineage(ledgerWithOneDownloadedAsset(), {
      videoId: 580,
      timelineVersion: 4,
    });
    const s = store(JSON.parse(JSON.stringify(stored)) as unknown);
    const out = await recordDeliveredLineage({
      store: s.lineage,
      job,
      clips: videoTrack(timeline),
      renderedClipIds: ["c1", "c2"],
      published: true,
      now: 42,
    });
    expect(out.recorded).toBe(true);
    expect(s.state.writes).toBe(1);
    const back = parseLineageSnapshot(s.state.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.snapshot.assets[0]!.deliveredAt).toBe(42);
    expect(back.snapshot.delivery).toMatchObject({
      route: "render_job",
      jobId: 91,
      delivered: 1,
      unidentifiedClips: 1,
    });
  });

  it("a video with no stored lineage is refused BY NAME and nothing is written", async () => {
    const s = store(undefined);
    const out = await recordDeliveredLineage({
      store: s.lineage,
      job,
      clips: videoTrack(timeline),
      renderedClipIds: ["c1"],
      published: true,
    });
    expect(out).toMatchObject({ recorded: false, problem: "MISSING" });
    expect(s.state.writes).toBe(0);
  });

  it("a store that throws does not take the finished render down with it", async () => {
    const out = await recordDeliveredLineage({
      store: {
        read: async () => {
          throw new Error("db is down");
        },
        write: async () => {},
      },
      job,
      clips: videoTrack(timeline),
      renderedClipIds: ["c1"],
      published: true,
    });
    expect(out).toMatchObject({ recorded: false, problem: "WRITE_FAILED" });
  });

  it("a superseded render is recorded as delivered=false, not as a delivery", async () => {
    /** It produced a real file and a newer render published first. Both facts are kept. */
    const s = store(
      JSON.parse(
        JSON.stringify(
          snapshotLineage(ledgerWithOneDownloadedAsset(), { videoId: 580, timelineVersion: 4 })
        )
      ) as unknown
    );
    await recordDeliveredLineage({
      store: s.lineage,
      job,
      clips: videoTrack(timeline),
      renderedClipIds: ["c1"],
      published: false,
    });
    const back = parseLineageSnapshot(s.state.value);
    if (!back.ok) throw new Error("snapshot did not read back");
    expect(back.snapshot.delivery!.published).toBe(false);
  });
});

/* ═══════════════ the writers have callers ═══════════════ */

const SERVER = __dirname;
const read = (f: string) => fs.readFileSync(path.join(SERVER, f), "utf8");

describe("every part of the chain is wired, not merely written", () => {
  /**
   * RONDE 120's census scans `export function` declarations and so cannot see a class method.
   * `markDelivered` is a method, and a method with no caller is the same defect that cost RONDE
   * 115, 119 and 120 a round each — so it is checked here, by name.
   */
  it("markDelivered has a caller outside the ledger it lives on", () => {
    expect(read("videoPipeline.ts")).toContain("ledger.markDelivered(");
  });

  it("the pipeline persists the lineage before anything renders it", () => {
    const src = read("videoPipeline.ts");
    expect(src).toContain("snapshotLineage(ledger");
    expect(src).toContain("LINEAGE_SNAPSHOT_METADATA_KEY");
  });

  it("the render job records its delivery, and only after the upload", () => {
    const src = read("renderJobWorker.ts");
    expect(src).toContain("recordDeliveredLineage(");
    /** The call must sit after the upload, or it would claim a delivery that never happened. */
    expect(src.indexOf("deps.upload(")).toBeLessThan(src.indexOf("await recordDeliveredLineage("));
    expect(src.indexOf("finishRenderJob({")).toBeLessThan(
      src.indexOf("await recordDeliveredLineage(")
    );
  });

  it("every failure path in the render job returns before the delivery is recorded", () => {
    /**
     * `fail()` is the single exit for a broken render, a refused upload and an invalid timeline.
     * If any of them could reach the delivery line, a failed render would report delivered assets.
     */
    const src = read("renderJobWorker.ts");
    const deliveryAt = src.indexOf("await recordDeliveredLineage(");
    const uploadFailure = src.indexOf("RENDER_ERROR.OUTPUT_UPLOAD_FAILED");
    expect(uploadFailure).toBeGreaterThan(-1);
    expect(uploadFailure).toBeLessThan(deliveryAt);
    expect(src.slice(uploadFailure - 60, uploadFailure)).toContain("return await fail(");
  });
});
