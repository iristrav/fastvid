/**
 * "NO PROVIDER TO PROVE" AND "A PROVIDER WE COULD NOT PROVE" ARE OPPOSITE FINDINGS.
 *
 * ── The render that was refused ─────────────────────────────────────────────────────────────
 *
 *     MOSTLY_UNVERIFIED_CLIPS: 12 of 14 delivered clip(s) have no proven source
 *     (86%, limit 50%) — the lineage cannot say where most of this film came from
 *
 * That sentence is true and serious about a clip fetched from somewhere whose record broke. It is
 * false about a colour card the render drew itself: nothing was lost, because there was never a
 * provider to lose. Both answer null from `providerFor`, so both landed in one bucket, and a film
 * was refused for losing provenance it never had.
 *
 * The ledger has always kept the two apart — `summary()` counts `route === "fallback"` in its own
 * column — so the distinction is read here, not invented.
 *
 * ── Why this is not a relaxation, said in tests rather than in prose ────────────────────────
 *
 * A film that really is mostly drawn cards is refused by `assertVisualCoverageExportGate`, whose
 * fallbackBeats/beatsFilled majority test is about exactly that and is untouched. And a film whose
 * FETCHED clips cannot be traced still fails this gate at the same 50% — asserted below, because
 * "make the render pass" is precisely the request under which a gate quietly stops guarding.
 */
import { describe, expect, it } from "vitest";

import { buildVideoQualityReport, indefensibleExportConditions } from "./videoQualityReport";

/** A report shaped only by what this gate reads. */
const report = (opts: {
  clips: string[];
  provider: (clip: string) => string | null;
  drawn?: (clip: string) => boolean;
}) =>
  buildVideoQualityReport(opts.clips, "Why Adolf Hitler Chose Suicide Over Capture", {
    resolveSource: (c) => opts.provider(c),
    isGeneratedClip: (c) => opts.drawn?.(c) ?? false,
  });

const codes = (r: ReturnType<typeof buildVideoQualityReport>) =>
  indefensibleExportConditions(r).map((c) => c.code);

describe("a card the render drew itself", () => {
  /** The production shape: two fetched clips that are traceable, twelve cards. */
  const CLIPS = [
    "/w/archive_a.mp4",
    "/w/wikimedia_b.mp4",
    ...Array.from({ length: 12 }, (_, i) => `/w/scene_${i}_guaranteed.mp4`),
  ];
  const isCard = (c: string) => c.includes("guaranteed");

  it("is not counted as lost provenance", () => {
    const r = report({
      clips: CLIPS,
      provider: (c) => (isCard(c) ? null : "archive"),
      drawn: isCard,
    });
    expect(r.generatedClips).toBe(12);
    expect(codes(r), "12 of 14 was this render's refusal").not.toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  it("is still counted as UNVERIFIED in the source breakdown, which is correct", () => {
    const r = report({
      clips: CLIPS,
      provider: (c) => (isCard(c) ? null : "archive"),
      drawn: isCard,
    });
    expect(r.bySource.UNVERIFIED).toBe(12);
  });
});

describe("a fetched clip whose lineage broke", () => {
  /** The thing this gate exists for: clips that came from somewhere and cannot say where. */
  const FETCHED = Array.from({ length: 10 }, (_, i) => `/w/pool_${i}.mp4`);

  it("still fails the gate at the same limit", () => {
    const r = report({
      clips: FETCHED,
      provider: (c) => (c.endsWith("0.mp4") || c.endsWith("1.mp4") ? "archive" : null),
      drawn: () => false,
    });
    expect(codes(r)).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });

  it("and cards in the same film do not hide it", () => {
    const r = report({
      clips: [...FETCHED, "/w/scene_0_guaranteed.mp4", "/w/scene_1_guaranteed.mp4"],
      provider: (c) => (c.endsWith("0.mp4") || c.endsWith("1.mp4") ? "archive" : null),
      drawn: (c) => c.includes("guaranteed"),
    });
    expect(codes(r), "8 of 10 fetched clips are untraceable either way").toContain(
      "MOSTLY_UNVERIFIED_CLIPS"
    );
  });

  /** Exactly at the limit is not over it — the threshold itself has not moved. */
  it("half is allowed, more than half is not", () => {
    const half = report({
      clips: ["/w/a.mp4", "/w/b.mp4", "/w/c.mp4", "/w/d.mp4"],
      provider: (c) => (c.includes("a") || c.includes("b") ? "archive" : null),
      drawn: () => false,
    });
    const more = report({
      clips: ["/w/a.mp4", "/w/b.mp4", "/w/c.mp4", "/w/d.mp4"],
      provider: (c) => (c.includes("a") ? "archive" : null),
      drawn: () => false,
    });
    expect(codes(half)).not.toContain("MOSTLY_UNVERIFIED_CLIPS");
    expect(codes(more)).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });
});

describe("the report never hides one count behind the other", () => {
  it("names the excluded cards in the refusal", () => {
    const r = report({
      clips: [
        ...Array.from({ length: 8 }, (_, i) => `/w/pool_${i}.mp4`),
        "/w/scene_0_guaranteed.mp4",
      ],
      provider: () => null,
      drawn: (c) => c.includes("guaranteed"),
    });
    const found = indefensibleExportConditions(r).find((c) => c.code === "MOSTLY_UNVERIFIED_CLIPS");
    expect(found?.detail).toContain("fetched clip(s)");
    expect(found?.detail).toContain("1 drawn card(s) excluded");
  });

  /**
   * A caller with no ledger — tests, tools — asks nothing and gets the old behaviour. The gate must
   * not become weaker for a caller that simply could not answer the question.
   */
  it("a render that cannot tell counts every clip, as before", () => {
    const r = buildVideoQualityReport(
      Array.from({ length: 4 }, (_, i) => `/w/pool_${i}.mp4`),
      "t",
      { resolveSource: () => null }
    );
    expect(r.generatedClips).toBe(0);
    expect(codes(r)).toContain("MOSTLY_UNVERIFIED_CLIPS");
  });
});
