/**
 * Archive first, suppliers second — and a video always comes before a picture.
 *
 * The own archive is asked first; only on an ARCHIVE_GAP do the YouTube turn and the Internet
 * Archive/Wikimedia video cascade start, together. The beat route needs a whole render around it,
 * so its ORDER is read from the source. The ladder rule that lets the two suppliers start together
 * is exercised for real.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  admitProviderForTier,
  declineTiersNotServedBy,
  forgetSceneDiscovery,
  noteTierAttempted,
  runCentralVisualSourcing,
} from "./centralVisualSourcing";
import { HISTORICAL_SOURCE_TIER_ORDER } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function bodyOf(signature: string): string {
  const at = PIPE.indexOf(signature);
  expect(at, `${signature} is gone`).toBeGreaterThan(-1);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
}

const ROUTE = bodyOf("export async function fetchBeatArchivalThenPexels(");
const at = (needle: string): number => {
  const i = ROUTE.indexOf(needle);
  expect(i, `${needle} is not in the beat route`).toBeGreaterThan(-1);
  return i;
};

describe("archive first — suppliers only on a gap", () => {
  it("the own archive is awaited before any supplier is started", () => {
    const archive = at("ownArchiveBeatClip(");
    expect(archive).toBeLessThan(at("youtubeFirstBeatSlice("));
    expect(archive).toBeLessThan(at("gatherHistoricalBeatVideoPool("));
    expect(ROUTE.slice(0, archive)).toContain("await settle(");
  });

  it("an archive video ends the beat before a supplier is asked", () => {
    const hit = at("ARCHIVE_HIT — no supplier asked");
    expect(hit).toBeLessThan(at("youtubeFirstBeatSlice("));
    expect(hit).toBeLessThan(at("gatherHistoricalBeatVideoPool("));
  });

  it("the gap is logged, then both suppliers start before either is awaited", () => {
    const gap = at("ARCHIVE_GAP");
    const firstWait = at("await youtube;");
    expect(gap).toBeLessThan(at("youtubeFirstBeatSlice("));
    expect(at("youtubeFirstBeatSlice(")).toBeLessThan(firstWait);
    expect(at("gatherHistoricalBeatVideoPool(")).toBeLessThan(firstWait);
    expect(at("await youtube;")).toBeLessThan(at("await archivePool;"));
    expect(at("await archivePool;")).toBeLessThan(at("adoptHistoricalBeatVideoPool("));
  });

  it("the cascade does not ask YouTube a second time while the YouTube turn runs", () => {
    expect(ROUTE).toContain("skipYoutube: youtubeTurnRuns,");
    expect(ROUTE).toContain("const youtubeTurnRuns = youtubeFirstEnabled();");
  });

  it("tier 1 is recorded as attempted before the suppliers start, because it is", () => {
    expect(at('if (youtubeTurnRuns) noteTierAttempted("YOUTUBE", "youtube_first_turn");')).toBeLessThan(
      at("youtubeFirstBeatSlice(")
    );
  });

  it("a failing source ends without a clip instead of taking the others down", () => {
    expect(ROUTE).toContain("p.catch((err) => {");
    for (const label of ['"youtube"', '"own archive"', '"archive video"']) expect(ROUTE).toContain(label);
  });
});

describe("Video 619 — video always before a picture", () => {
  it("still images are asked only after every video source", () => {
    const lastVideo = Math.max(at("adoptHistoricalBeatVideoPool("), at("adoptBestCelebrityClip("));
    expect(at("fetchBeatInternetStillsFirst(")).toBeGreaterThan(lastVideo);
    expect(at("fetchBeatAuthenticStills(")).toBeGreaterThan(lastVideo);
    expect(at("fetchBeatStockFallback(")).toBeGreaterThan(at("fetchBeatAuthenticStills("));
  });

  it("a photograph from the own archive waits until no source had a video", () => {
    expect(ROUTE).toContain("isCuratedPreparedStillClip(ownArchiveClip)");
    expect(ROUTE).toContain("if (ownArchiveClip !== null && !ownArchiveStill) {");
    const stillReturn = at("if (ownArchiveStill) {");
    expect(stillReturn).toBeGreaterThan(at("adoptHistoricalBeatVideoPool("));
    expect(stillReturn).toBeGreaterThan(at("adoptBestCelebrityClip("));
    expect(stillReturn).toBeLessThan(at("fetchBeatInternetStillsFirst("));
  });

  it("the historical stills no longer come before the video cascade", () => {
    expect(at("fetchBeatInternetStillsFirst(")).toBeGreaterThan(at("gatherHistoricalBeatVideoPool("));
  });
});

describe("Video 619 — gathering adopts nothing", () => {
  it("the gather half never adopts; the choose half does", () => {
    const gather = bodyOf("async function gatherHistoricalBeatVideoPoolInner(");
    expect(gather).not.toContain("adoptClip(");
    expect(gather).toContain("return [...new Set(pool)].slice(0, POOL_MAX);");
    expect(bodyOf("export async function adoptHistoricalBeatVideoPool(")).toContain("await adoptClip(boundedPool,");
  });

  it("the old single call is still gather then choose, for every other caller", () => {
    const inner = bodyOf("async function fetchHistoricalBeatVideoInner(");
    expect(inner.indexOf("gatherHistoricalBeatVideoPoolInner(")).toBeLessThan(
      inner.indexOf("adoptHistoricalBeatVideoPool(")
    );
  });
});

describe("Video 619 — the ladder lets the cascade run beside the YouTube turn", () => {
  const RENDER = "v619-together";
  beforeEach(() => forgetSceneDiscovery(RENDER));

  const onBeat = (body: () => void) =>
    runCentralVisualSourcing({ renderId: RENDER, sceneIndex: 0, beatIndex: 0 }, async () => body());

  it("without tier 1 recorded, the Internet Archive is refused — the race this prevents", async () => {
    await onBeat(() => {
      noteTierAttempted("OWN_ARCHIVE", "curated");
      declineTiersNotServedBy(HISTORICAL_SOURCE_TIER_ORDER, "historical_cascade");
      expect(admitProviderForTier("internet_archive")).toMatchObject({ admitted: false, reason: "TIER_OUT_OF_ORDER" });
    });
  });

  it("with the YouTube turn recorded, the archive sources are admitted and stock still waits its turn", async () => {
    await onBeat(() => {
      noteTierAttempted("YOUTUBE", "youtube_first_turn");
      noteTierAttempted("OWN_ARCHIVE", "curated");
      expect(admitProviderForTier("internet_archive").admitted).toBe(true);
      expect(admitProviderForTier("wikimedia").admitted).toBe(true);
    });
  });

  it("stock is not unlocked by the YouTube note alone", async () => {
    await onBeat(() => {
      noteTierAttempted("YOUTUBE", "youtube_first_turn");
      expect(admitProviderForTier("pexels").admitted).toBe(false);
    });
  });
});
