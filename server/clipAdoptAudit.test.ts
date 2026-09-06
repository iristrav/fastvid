import { describe, expect, it } from "vitest";
import { summarizeAdoptAudit } from "./clipAdoptAudit";

describe("summarizeAdoptAudit", () => {
  it("counts sources and emits hints for stock-heavy runs", () => {
    const summary = summarizeAdoptAudit([
      {
        sceneIndex: 0,
        beatIndex: 0,
        beatText: "In 2024 growth hit 4%",
        basename: "scene_0_b0_pexels.mp4",
        source: "pexels",
      },
      {
        sceneIndex: 0,
        beatIndex: 1,
        beatText: "Singapore skyline",
        basename: "scene_0_b1_pexels.mp4",
        source: "pexels",
      },
      {
        sceneIndex: 0,
        beatIndex: 2,
        beatText: "Urban planning",
        basename: "scene_0_b2_kling.mp4",
        source: "kling",
      },
    ]);
    expect(summary.beatsFilled).toBe(3);
    expect(summary.stockBeats).toBe(2);
    expect(summary.klingBeats).toBe(1);
    expect(summary.hints.some((h) => h.includes("stock"))).toBe(true);
  });

  // Production finding (Vision Gate root-cause fix, round 2, item 4): a real render logged
  // "35/14 filled beat(s) used the color/text fallback" — impossible for a literal per-beat
  // count. Independent recovery layers can each record their own recordClipAdopt entry for the
  // SAME sceneIndex+beatIndex when they re-attempt a beat's fill; the old code counted every
  // entry toward fallbackBeats instead of deduping by unique beat first.
  it("Test 4: 5 recorded attempts for the SAME beat count as at most 1 filled beat, not 5", () => {
    const attempts = Array.from({ length: 5 }, (_, i) => ({
      sceneIndex: 2,
      beatIndex: 0,
      beatText: "But the Germans arrived anyway.",
      basename: `scene_2_slot${i}_guaranteed.mp4`,
      source: "fallback",
    }));
    const summary = summarizeAdoptAudit(attempts);
    expect(summary.beatsFilled).toBe(1);
    expect(summary.fallbackBeats).toBe(1);
  });

  // Test 5 / invariant: fallbackBeats (and every other per-source beat counter) can never exceed
  // beatsFilled — a real render's own reported ratio (35/14) violated this by 2.5x, which also
  // broke assertVisualCoverageExportGate's majorityFallback check (fallbackBeats/beatsFilled was
  // able to exceed 1.0, forcing a false "majority fallback" hard-reject regardless of the true
  // per-beat ratio).
  it("Test 5: fallbackBeats can never exceed beatsFilled even with many repeated attempts across several beats", () => {
    const audit = [
      // beat s2b0: 5 attempts, final source fallback
      ...Array.from({ length: 5 }, (_, i) => ({
        sceneIndex: 2, beatIndex: 0, beatText: "beat 0", basename: `a${i}.mp4`, source: "fallback",
      })),
      // beat s1b0: 3 attempts, final source archive (a real clip)
      { sceneIndex: 1, beatIndex: 0, beatText: "beat 1", basename: "b0.mp4", source: "fallback" },
      { sceneIndex: 1, beatIndex: 0, beatText: "beat 1", basename: "b1.mp4", source: "rescue_placeholder" },
      { sceneIndex: 1, beatIndex: 0, beatText: "beat 1", basename: "b2.mp4", source: "archive" },
    ];
    const summary = summarizeAdoptAudit(audit);
    expect(summary.beatsFilled).toBe(2);
    expect(summary.fallbackBeats).toBeLessThanOrEqual(summary.beatsFilled);
    expect(summary.fallbackBeats).toBe(1); // only s2b0 — s1b0's FINAL entry was a real archive clip
    expect(summary.archiveBeats).toBe(1);
  });

  /**
   * RENDER 569 — THIS TEST USED TO ENCODE A PREMISE THE PRODUCTION LOG DISPROVED.
   *
   * It asserted that a real adoption followed by a later card counts as a fallback beat, on the
   * stated reasoning that the card had "legitimately replaced" a real clip which "stopped
   * existing/being valid". A card does not replace anything: `pushClip` APPENDS, which is why
   * `resolveBeatCoverage` has carried REAL_PLUS_FILLER since render 562. Both are on screen.
   *
   * Render 569 is what that premise cost. Ten beats held archive, Wikimedia and SerpAPI footage
   * with a card appended for the remainder of the narration; this rule discarded all ten, the
   * summary read `beats=14 wiki=0 arch=0 stock=0`, and the export gate refused the film for
   * "14/14 filled beat(s) used the color/text fallback".
   *
   * The direction check the test was written for is real and is kept — a beat's source must not
   * depend on the order entries happen to arrive in. It is asserted here as the stronger property
   * that survives the correction: the beat is counted under its real source EITHER WAY, and the
   * card is reported rather than discarded.
   */
  it("a real adoption is not erased by a card recorded after it", () => {
    const summary = summarizeAdoptAudit([
      { sceneIndex: 3, beatIndex: 2, beatText: "beat", basename: "real.mp4", source: "wikimedia" },
      { sceneIndex: 3, beatIndex: 2, beatText: "beat", basename: "fallback.mp4", source: "rescue_placeholder" },
    ]);
    expect(summary.beatsFilled).toBe(1);
    expect(summary.wikiBeats, "render 569 reported wiki=0 for exactly this shape").toBe(1);
    expect(summary.fallbackBeats).toBe(0);
    /** The card is not swept away either — it is named, in its own counter. */
    expect(summary.mixedBeats).toBe(1);
  });

  /** And the answer must not depend on which order the two entries arrived in. */
  it("gives the same answer when the card was recorded first", () => {
    const summary = summarizeAdoptAudit([
      { sceneIndex: 3, beatIndex: 2, beatText: "beat", basename: "fallback.mp4", source: "rescue_placeholder" },
      { sceneIndex: 3, beatIndex: 2, beatText: "beat", basename: "real.mp4", source: "wikimedia" },
    ]);
    expect(summary.wikiBeats).toBe(1);
    expect(summary.fallbackBeats).toBe(0);
    expect(summary.mixedBeats).toBe(1);
  });

  // Multiple real clips across different beats in the SAME scene must each be preserved
  // independently in the accounting (no cross-beat interference from the per-beat Map keying).
  it("multiple real clips in the same scene, on different beats, are each counted independently", () => {
    const audit = [
      { sceneIndex: 5, beatIndex: 0, beatText: "b0", basename: "a.mp4", source: "archive" },
      { sceneIndex: 5, beatIndex: 1, beatText: "b1", basename: "b.mp4", source: "wikimedia" },
      { sceneIndex: 5, beatIndex: 2, beatText: "b2", basename: "c.mp4", source: "pexels" },
    ];
    const summary = summarizeAdoptAudit(audit);
    expect(summary.beatsFilled).toBe(3);
    expect(summary.archiveBeats).toBe(1);
    expect(summary.wikiBeats).toBe(1);
    expect(summary.stockBeats).toBe(1);
    expect(summary.fallbackBeats).toBe(0);
  });

  // Final hardening round — Bug 2: appendGuaranteedSceneClips (and older guaranteed-fill call
  // sites) record scene-level "padding" adopt entries under sentinel beatIndex values
  // (999, 1001, 8888, 9999, and the 2000+slot range) specifically so they can never collide with
  // a real narrative beatIndex. Those entries must NOT be counted as extra narrative beats on top
  // of the real ones — 14 real beats + 6 sentinel padding entries must still report
  // beatsFilled = 14, never 20.
  it("Test B: sentinel-beatIndex guaranteed-fill entries (999/1001/8888/9999/2000+) never inflate beatsFilled beyond the real narrative beat count", () => {
    const realBeats = Array.from({ length: 14 }, (_, i) => ({
      sceneIndex: 0,
      beatIndex: i,
      beatText: `beat ${i}`,
      basename: `real_${i}.mp4`,
      source: i % 3 === 0 ? "wikimedia" : "pexels",
    }));
    const sentinelPadding = [
      { sceneIndex: 0, beatIndex: 999, beatText: "n/a", basename: "pad_a.mp4", source: "fallback" },
      { sceneIndex: 0, beatIndex: 1001, beatText: "n/a", basename: "pad_b.mp4", source: "fallback" },
      { sceneIndex: 1, beatIndex: 8888, beatText: "n/a", basename: "pad_c.mp4", source: "fallback" },
      { sceneIndex: 1, beatIndex: 9999, beatText: "n/a", basename: "pad_d.mp4", source: "fallback" },
      { sceneIndex: 2, beatIndex: 2000, beatText: "n/a", basename: "pad_e.mp4", source: "fallback" },
      { sceneIndex: 2, beatIndex: 2001, beatText: "n/a", basename: "pad_f.mp4", source: "fallback" },
    ];
    const summary = summarizeAdoptAudit([...realBeats, ...sentinelPadding]);
    expect(summary.beatsFilled).toBe(14);
    expect(summary.fallbackBeats).toBe(0);
    expect(summary.fallbackBeats).toBeLessThanOrEqual(summary.beatsFilled);
  });

  it("sentinel entries also can't create a fallback-only beat out of thin air when there are zero real beats", () => {
    const summary = summarizeAdoptAudit([
      { sceneIndex: 4, beatIndex: 999, beatText: "n/a", basename: "pad.mp4", source: "fallback" },
      { sceneIndex: 4, beatIndex: 2005, beatText: "n/a", basename: "pad2.mp4", source: "fallback" },
    ]);
    expect(summary.beatsFilled).toBe(0);
    expect(summary.fallbackBeats).toBe(0);
  });
});
