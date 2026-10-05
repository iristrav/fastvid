/**
 * P1 + P2 (VIDEO 630).
 *
 * P1 — "As dawn broke on June 1944, the D-Day Invasion launched…" was routed to the "Space Race &
 * NASA" archive. Its first clip ended the beat — `ARCHIVE_HIT — no supplier asked` — and the
 * picture editor refused the space telescope at the push, when the beat had no turn left. An
 * archive hit is now a candidate: the push's own look is taken first, and only a definite refusal
 * sends the beat on to its existing suppliers.
 *
 * P2 — 11 of the render's 37 looks went to pictures already refused for another sentence, and the
 * per-sentence ceiling of 5 was reached with fresh candidates never seen (s0b1: three moments of
 * "WWII Uncut: Combat Footage" were never looked at). Such pictures now go to the back of the
 * beat's shortlist — not refused, not approved, and the ceiling is unchanged.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  contentRefusedOnAnotherBeat,
  createBeatRelevanceLedger,
  beatRelevanceBeatKey,
  maxRelevanceLooksPerBeat,
  putRefusedElsewhereLast,
  relevanceVerdictForRenderedAsset,
  type BeatRelevanceDecision,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import { MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { adoptionGuardVerdict, visionVerdictFromGate } from "./adoptionPolicy";
import { rejectionStageForReason } from "./rejectionRegistry";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** A verdict filed the way `checkBeatRelevance` files one: by path, by content, and under the beat. */
function file(
  ledger: BeatRelevanceLedger,
  at: { sceneIndex: number; beatIndex: number },
  clipPath: string,
  contentKey: string,
  verdict: "fits" | "does_not_fit" | "unknown",
  opts: { evaluated?: boolean; reprieved?: boolean } = {}
): void {
  const decision = {
    verdict,
    allowed: verdict !== "does_not_fit" || Boolean(opts.reprieved),
    reprieved: Boolean(opts.reprieved),
    cached: false,
    depicts: "",
    reason: "test",
    route: "adopt",
    evaluated: opts.evaluated ?? true,
  } as BeatRelevanceDecision;
  const entry = { ctx: { ...at, beatText: "a line" }, decision, contentKey };
  ledger.byClipPath.set(clipPath, entry);
  ledger.byContentKey.set(contentKey, entry);
  ledger.byBeat.set(beatRelevanceBeatKey(at.sceneIndex, at.beatIndex, "path", clipPath), entry);
  ledger.byBeat.set(beatRelevanceBeatKey(at.sceneIndex, at.beatIndex, "content", contentKey), entry);
}

/* ═══════════════════════════════ P1 — an archive hit is a candidate ═══════════════════════════════ */

describe("P1 — the archive hit is judged before it ends the beat", () => {
  const load = async () => (await import("./videoPipeline")).archiveHitIsRefused;
  const HIT = "/tmp/w/scene_1_b4_curated_a58605.mp4";
  const KEY = "curated:asset:58605";
  const at = { sceneIndex: 1, beatIndex: 4 };
  const read = (ledger: BeatRelevanceLedger) =>
    relevanceVerdictForRenderedAsset(ledger, { localPath: HIT, currentFilename: path.basename(HIT), contentKey: KEY, ...at });

  it("A. archive hit + Judge REJECTED → the next existing supplier may be tried", async () => {
    const archiveHitIsRefused = await load();
    const ledger = createBeatRelevanceLedger();
    file(ledger, at, HIT, KEY, "does_not_fit");
    expect(archiveHitIsRefused(read(ledger))).toBe(true);
  }, 120_000);

  it("B. archive hit + Judge APPROVED → the beat ends there, no supplier is asked", async () => {
    const archiveHitIsRefused = await load();
    const ledger = createBeatRelevanceLedger();
    file(ledger, at, HIT, KEY, "fits");
    expect(archiveHitIsRefused(read(ledger))).toBe(false);
  });

  it("C. archive hit that could not be judged (no frame, no scope) → the existing route, unchanged", async () => {
    const archiveHitIsRefused = await load();
    const ledger = createBeatRelevanceLedger();
    file(ledger, at, HIT, KEY, "unknown", { evaluated: false });
    expect(archiveHitIsRefused(read(ledger))).toBe(false);
    expect(archiveHitIsRefused(null), "no verdict at all").toBe(false);
  });

  it("D. a wrong archive result for any sentence (630: a telescope under a D-Day line) does not stop sourcing", async () => {
    const archiveHitIsRefused = await load();
    const ledger = createBeatRelevanceLedger();
    file(ledger, at, HIT, KEY, "does_not_fit");
    /** A refusal earned on ANOTHER sentence is not this beat's answer: the reader returns nothing. */
    const elsewhere = createBeatRelevanceLedger();
    file(elsewhere, { sceneIndex: 0, beatIndex: 1 }, HIT, KEY, "does_not_fit");
    expect(archiveHitIsRefused(read(ledger))).toBe(true);
    expect(archiveHitIsRefused(read(elsewhere))).toBe(false);
    /** A reprieved refusal (the last-resort rule) is not a refusal here either. */
    const reprieved = createBeatRelevanceLedger();
    file(reprieved, at, HIT, KEY, "does_not_fit", { reprieved: true });
    expect(archiveHitIsRefused(read(reprieved))).toBe(false);
  });

  it("the route: asked before ARCHIVE_HIT returns, then the existing suppliers in their existing order", () => {
    const route = PIPE.slice(PIPE.indexOf("export async function fetchBeatArchivalThenPexels("));
    const ask = route.indexOf("await archiveHitRefusedByPictureEditor(dedup, ownArchiveClip, sceneIndex, beat.index)");
    const hit = route.indexOf("ARCHIVE_HIT — no supplier asked");
    const refused = route.indexOf("ARCHIVE_HIT_REFUSED");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(hit);
    expect(hit).toBeLessThan(refused);
    expect(refused).toBeLessThan(route.indexOf("youtubeFirstBeatSlice("));
    expect(refused).toBeLessThan(route.indexOf("gatherHistoricalBeatVideoPool("));
    expect(route).toContain("if (ownArchiveClip !== null && !ownArchiveStill) {");
    expect(route).toContain("if (!archiveHitRefused) {");
  });

  it("E/F. the look is the push's own look (finalSay), with no clock, budget or timer of its own", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("async function archiveHitRefusedByPictureEditor("),
      PIPE.indexOf("export async function fetchBeatArchivalThenPexels(")
    );
    expect(fn).toContain("ensureVerdictBeforeCompose({");
    expect(fn).toContain("finalSay: true,");
    for (const forbidden of ["setTimeout", "withSceneFetchTimeout", "Date.now()", "remainingScopeMs", "spendByBeat"]) {
      expect(fn, `${forbidden} in the archive-hit look`).not.toContain(forbidden);
    }
    /** The push reads the same ledger back: a second look for the same clip on the same beat is free. */
    expect(PIPE).toContain('route: "push",\n      finalSay: true,');
  });

  it("F. the 1600ff1 timing is untouched", () => {
    expect(PIPE).toContain("const JUDGED_BEAT_TURN_MS = 45_000;");
    expect(PIPE).toContain("const YOUTUBE_STOCK_WAIT_MAX_MS = 180_000;");
    expect(PIPE).toContain("Math.max(1, Math.round(beatWallMs * BEAT_RESOLVE_SHARE)),");
  });
});

/* ═════════════════════ P2 — a refusal for another sentence is asked about last ═════════════════════ */

describe("P2 — candidates refused for another sentence go to the back of the shortlist", () => {
  const YT_CAR = "youtube_cc:43014bfb350c0f2b@t15325d40";
  const YT_FRESH = "youtube_cc:8e6ed7abd1a40197@t44956d40";

  it("the same YouTube moment on two sentences has one identity (what makes the memory reach)", async () => {
    const { clipContentKey } = await import("./videoPipeline");
    const s0 = clipContentKey("/tmp/w/scene_0_ytfu_0m0_t15325d40__pid_youtube_cc-43014bfb350c0f2b.mp4");
    const s2 = clipContentKey("/tmp/w/scene_2_ytfu_0m0_t15325d40__pid_youtube_cc-43014bfb350c0f2b.mp4");
    expect(s0).toBe(s2);
    expect(s0).toContain(":");
  }, 120_000);

  it("A. refused for sentence A → lower for sentence B; B. a fresh candidate goes first", () => {
    const ledger = createBeatRelevanceLedger();
    file(ledger, { sceneIndex: 1, beatIndex: 3 }, "/tmp/a.mp4", YT_CAR, "does_not_fit");
    expect(contentRefusedOnAnotherBeat(ledger, YT_CAR, 0, 3)).toBe(true);
    expect(contentRefusedOnAnotherBeat(ledger, YT_FRESH, 0, 3)).toBe(false);
    const order = putRefusedElsewhereLast(["car.mp4", "fresh.mp4"], (p) =>
      contentRefusedOnAnotherBeat(ledger, p === "car.mp4" ? YT_CAR : YT_FRESH, 0, 3)
    );
    expect(order.paths).toEqual(["fresh.mp4", "car.mp4"]);
    expect(order.moved).toEqual(["car.mp4"]);
  });

  it("C. refused for A but the only candidate for B → still offered, so it can be judged again", () => {
    const ledger = createBeatRelevanceLedger();
    file(ledger, { sceneIndex: 1, beatIndex: 3 }, "/tmp/a.mp4", YT_CAR, "does_not_fit");
    const order = putRefusedElsewhereLast(["car.mp4"], () => contentRefusedOnAnotherBeat(ledger, YT_CAR, 2, 2));
    expect(order.paths).toEqual(["car.mp4"]);
  });

  it("only a real refusal counts: not this beat's own, not a reprieve, not an unlooked pass, not a filename", () => {
    const ledger = createBeatRelevanceLedger();
    file(ledger, { sceneIndex: 0, beatIndex: 3 }, "/tmp/own.mp4", "internet_archive:aaaaaaaaaaaaaaaa", "does_not_fit");
    file(ledger, { sceneIndex: 0, beatIndex: 2 }, "/tmp/rep.mp4", "internet_archive:bbbbbbbbbbbbbbbb", "does_not_fit", { reprieved: true });
    file(ledger, { sceneIndex: 0, beatIndex: 2 }, "/tmp/unk.mp4", "internet_archive:cccccccccccccccc", "unknown", { evaluated: false });
    file(ledger, { sceneIndex: 0, beatIndex: 2 }, "/tmp/fit.mp4", "internet_archive:dddddddddddddddd", "fits");
    expect(contentRefusedOnAnotherBeat(ledger, "internet_archive:aaaaaaaaaaaaaaaa", 0, 3), "own beat").toBe(false);
    expect(contentRefusedOnAnotherBeat(ledger, "internet_archive:bbbbbbbbbbbbbbbb", 0, 3)).toBe(false);
    expect(contentRefusedOnAnotherBeat(ledger, "internet_archive:cccccccccccccccc", 0, 3)).toBe(false);
    expect(contentRefusedOnAnotherBeat(ledger, "internet_archive:dddddddddddddddd", 0, 3)).toBe(false);
    expect(contentRefusedOnAnotherBeat(ledger, "file:123:x.mp4", 0, 3)).toBe(false);
    /** s1b3 vs s1b30: the beat prefix is exact. */
    file(ledger, { sceneIndex: 1, beatIndex: 30 }, "/tmp/b30.mp4", YT_CAR, "does_not_fit");
    expect(contentRefusedOnAnotherBeat(ledger, YT_CAR, 1, 3)).toBe(true);
  });

  it("video 630 s0b1, replayed: the three fresh combat-footage moments are now inside the 5 looks", () => {
    const ledger = createBeatRelevanceLedger();
    const BRIDGE = "internet_archive:77540f773c324681";
    const WINDOW = "youtube_cc:43014bfb350c0f2b@t15367d40";
    file(ledger, { sceneIndex: 0, beatIndex: 0 }, "/tmp/b.mp4", BRIDGE, "does_not_fit");
    file(ledger, { sceneIndex: 1, beatIndex: 3 }, "/tmp/c.mp4", YT_CAR, "does_not_fit");
    file(ledger, { sceneIndex: 0, beatIndex: 3 }, "/tmp/w.mp4", WINDOW, "does_not_fit");
    const keys: Record<string, string> = {
      bridge: BRIDGE, car: YT_CAR, window: WINDOW,
      mpx1: "youtube_cc:8e6ed7abd1a40197@t44956d40",
      mpx2: "youtube_cc:8e6ed7abd1a40197@t45025d31",
      mpx3: "youtube_cc:8e6ed7abd1a40197@t44895d40",
    };
    const ranked = ["bridge", "car", "window", "mpx1", "mpx2", "mpx3"];
    const order = putRefusedElsewhereLast(ranked, (p) => contentRefusedOnAnotherBeat(ledger, keys[p], 0, 1));
    /** s0b1 had 3 looks left after its 2 push looks; the first three now are the never-seen ones. */
    expect(order.paths.slice(0, 3)).toEqual(["mpx1", "mpx2", "mpx3"]);
    expect(order.paths).toHaveLength(ranked.length);
  });

  it("D. a technical refusal keeps its film-wide rule; F. the registry still files both kinds", async () => {
    const { refusalHoldsForEverySentence } = await import("./videoPipeline");
    expect(refusalHoldsForEverySentence("mostly_black")).toBe(true);
    expect(refusalHoldsForEverySentence("not_a_valid_video")).toBe(true);
    expect(refusalHoldsForEverySentence("refused on s1b3: does not fit")).toBe(false);
    expect(rejectionStageForReason("mostly_black")).toBe("technical");
    expect(rejectionStageForReason("refused on s1b3: does not fit")).toBe("picture");
  }, 120_000);

  it("E. the per-sentence ceiling and the render budget are exactly what they were", () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(MAX_JUDGEMENTS_PER_BEAT + 1);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
  });

  it("G. history never approves: an approval elsewhere is no verdict here, and nothing is dropped", () => {
    const ledger = createBeatRelevanceLedger();
    const clip = "/tmp/w/scene_0_b2_x__pid_internet_archive-eeeeeeeeeeeeeeee.mp4";
    const key = "internet_archive:eeeeeeeeeeeeeeee";
    file(ledger, { sceneIndex: 2, beatIndex: 1 }, clip, key, "fits");
    const here = relevanceVerdictForRenderedAsset(ledger, {
      localPath: clip, currentFilename: path.basename(clip), contentKey: key, sceneIndex: 0, beatIndex: 2,
    });
    expect(here).toBeNull();
    const vision = visionVerdictFromGate(here?.verdict, here?.evaluated);
    expect(vision).toBe("NOT_ASKED");
    expect(adoptionGuardVerdict({ source: "beat_fetch", eligible: true, vision }).allowed).toBe(false);
    expect(putRefusedElsewhereLast(["a", "b", "c"], (p) => p === "a").paths).toEqual(["b", "c", "a"]);
  });

  it("wired once, in the loop that spends the shortlist, after the footage-share order", () => {
    const lessFilled = PIPE.indexOf("const finalPaths = [...lessFilled.paths];");
    const reorder = PIPE.indexOf("putRefusedElsewhereLast(finalPaths, (p) =>");
    const spend = PIPE.indexOf("beatShortlistExhausted(dedup.beatShortlist, sceneIndex, beatIndex)");
    expect(lessFilled).toBeGreaterThan(0);
    expect(reorder).toBeGreaterThan(lessFilled);
    expect(spend).toBeGreaterThan(reorder);
    expect(PIPE.match(/putRefusedElsewhereLast\(/g)).toHaveLength(1);
  });
});
