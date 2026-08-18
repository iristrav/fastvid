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

  // Final review round — explicit direction check requested alongside Test 5's fallback->real:
  // a beat adopted for real FIRST and then overwritten by a later fallback attempt must count as
  // its FINAL (fallback) status, not its first. This is the "real clip legitimately replaced
  // because it stopped existing/being valid" case — as opposed to item 6's protected case, where
  // the real clip still exists and must NOT be replaced. Coverage accounting always reflects
  // whatever the last recorded entry says, regardless of direction.
  it("real adopted first, then overwritten by a later fallback attempt for the same beat, counts as fallback (final status wins, not first)", () => {
    const audit = [
      { sceneIndex: 3, beatIndex: 2, beatText: "beat", basename: "real.mp4", source: "wikimedia" },
      { sceneIndex: 3, beatIndex: 2, beatText: "beat", basename: "fallback.mp4", source: "rescue_placeholder" },
    ];
    const summary = summarizeAdoptAudit(audit);
    expect(summary.beatsFilled).toBe(1);
    expect(summary.fallbackBeats).toBe(1);
    expect(summary.wikiBeats).toBe(0);
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
