/**
 * TWO THINGS A RENDER COULD NOT TELL YOU ABOUT ITSELF.
 *
 * ── One: how much vision it actually bought ─────────────────────────────────────────────────
 *
 * Five production routes reach a vision model. `scoreCandidates` fed `visionMetrics`, the beat
 * judge fed `beatOutcomeAudit`, and the YouTube pre-pool screening, the clip quality gate and the
 * adopted-clip scorer fed nothing at all. So a statement of the form "this render made N vision
 * calls" was a count of one subsystem presented as a total — the same shape as every other
 * observability hole this codebase has found: the pipeline does something, the metric does not
 * know it happened.
 *
 * ── Two: what a viewer will hear ────────────────────────────────────────────────────────────
 *
 * This build has no music catalogue, so the delivered film's bed is ambience and sound effects.
 * Both are addressed by identity — `freesound:401178` — and both need a key to resolve. Without
 * one they are planned, carried into the timeline, and skipped at fetch time into a `skipped`
 * array nothing printed. Ten minutes of voice over silence would render, pass every check and read
 * as correct in every report.
 */
import { describe, expect, it } from "vitest";

import {
  formatVisionCensus,
  getVisionCensus,
  newVisionCensus,
  recordVisionAsk,
  withVisionCensus,
} from "./visionCensus";
import { describeAudioBed } from "./renderJobWorker";
import type { ProjectTimeline } from "./projectTimeline";

/* ═══════════════════════ the roll-call ═══════════════════════ */

describe("every route that asks a model is counted, and named", () => {
  it("records nothing outside a render, and does not throw doing it", () => {
    expect(getVisionCensus()).toBeUndefined();
    expect(() => recordVisionAsk("beat_judge", "judged")).not.toThrow();
  });

  it("separates the callers rather than pooling them", () => {
    const census = newVisionCensus();
    withVisionCensus(census, () => {
      recordVisionAsk("beat_judge", "judged", 4);
      recordVisionAsk("youtube_screening", "judged", 2);
      recordVisionAsk("clip_quality_gate", "judged");
      recordVisionAsk("funnel_scorer", "judged", 3);
      recordVisionAsk("adopted_clip_quality", "skipped", 5);
    });
    const lines = formatVisionCensus(census);
    expect(lines.join("\n")).toContain("beat_judge judged=4");
    expect(lines.join("\n")).toContain("youtube_screening judged=2");
    expect(lines.join("\n")).toContain("adopted_clip_quality judged=0 unavailable=0 skipped=5");
    expect(lines[lines.length - 1]).toContain("TOTAL judged=10 unavailable=0 skipped=5 callers=5");
  });

  /**
   * "We did not ask" and "we asked and got nothing" are different facts about a render, and a
   * reader chasing a thin video needs to tell them apart. A budget spent looks nothing like an
   * outage.
   */
  it("keeps a spent budget distinct from an outage", () => {
    const census = newVisionCensus();
    withVisionCensus(census, () => {
      recordVisionAsk("beat_judge", "skipped", 12);
      recordVisionAsk("beat_judge", "unavailable", 3);
    });
    const line = formatVisionCensus(census).join("\n");
    expect(line).toContain("beat_judge judged=0 unavailable=3 skipped=12");
  });

  it("says so plainly when nothing looked at anything", () => {
    expect(formatVisionCensus(newVisionCensus())[0]).toContain("no vision call was made");
    expect(formatVisionCensus(undefined)[0]).toContain("no vision call was made");
  });

  /**
   * `MAX_CONCURRENT_RENDERS` can be greater than one. A module-level counter would have each
   * render reporting the other's spend, which is why this is a scope and not a variable.
   */
  it("two concurrent renders do not see each other's spend", async () => {
    const a = newVisionCensus();
    const b = newVisionCensus();
    await Promise.all([
      withVisionCensus(a, async () => {
        recordVisionAsk("beat_judge", "judged", 2);
        await new Promise((r) => setTimeout(r, 5));
        recordVisionAsk("beat_judge", "judged", 1);
      }),
      withVisionCensus(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        recordVisionAsk("funnel_scorer", "judged", 7);
      }),
    ]);
    expect(formatVisionCensus(a).join("\n")).toContain("TOTAL judged=3");
    expect(formatVisionCensus(b).join("\n")).toContain("TOTAL judged=7");
    expect(formatVisionCensus(a).join("\n")).not.toContain("funnel_scorer");
  });

  it("the report is stable, so two renders of one shape produce one text", () => {
    const build = (order: Array<"a" | "b">) => {
      const c = newVisionCensus();
      withVisionCensus(c, () => {
        for (const o of order) {
          recordVisionAsk(o === "a" ? "beat_judge" : "funnel_scorer", "judged");
        }
      });
      return formatVisionCensus(c);
    };
    expect(build(["a", "b"])).toEqual(build(["b", "a"]));
  });

  it("a zero or negative count records nothing", () => {
    const c = newVisionCensus();
    withVisionCensus(c, () => {
      recordVisionAsk("beat_judge", "judged", 0);
      recordVisionAsk("beat_judge", "judged", -3);
    });
    expect(c.byCaller.size).toBe(0);
  });
});

/* ═══════════════════════ what is under the voice ═══════════════════════ */

const timelineWith = (tracks: Partial<Record<string, Array<{ id: string }>>>): ProjectTimeline =>
  ({
    schemaVersion: 1,
    videoId: 1,
    timelineVersion: 0,
    durationSec: 60,
    format: { widthPx: 1920, heightPx: 1080, fps: 30 },
    tracks: [
      { kind: "VIDEO", clips: [] },
      {
        kind: "VOICE",
        clips: (tracks.VOICE ?? [{ id: "voice_1" }]).map((c) => ({
          id: c.id,
          source: { provider: "narration", canonicalUrl: "https://x/v.mp3" },
          start: 0, end: 60, gain: 1,
        })),
      },
      ...(["MUSIC", "AMBIENT", "SFX"] as const).map((kind) => ({
        kind,
        clips: (tracks[kind] ?? []).map((c) => ({
          id: c.id,
          source: { provider: "freesound", providerAssetId: c.id },
          start: 0, end: 10, gain: 0.4,
        })),
      })),
      { kind: "CAPTIONS", captions: [] },
      { kind: "TEXT", texts: [] },
      { kind: "GRAPHICS", graphics: [] },
    ],
  }) as unknown as ProjectTimeline;

describe("the film says what is under its narration", () => {
  it("names the tracks that actually have a file", () => {
    const bed = describeAudioBed({
      timeline: timelineWith({ AMBIENT: [{ id: "amb_1" }, { id: "amb_2" }], SFX: [{ id: "sfx_1" }] }),
      recovered: new Set(["amb_1", "amb_2", "sfx_1"]),
    });
    expect(bed.bare).toBe(false);
    expect(bed.lost).toEqual([]);
    expect(bed.line).toContain("ambient=2");
    expect(bed.line).toContain("sfx=1");
  });

  /**
   * The silent failure this exists for: the plan is full, the key is missing, and the fetch drops
   * everything into an array nobody printed.
   */
  it("a planned bed that could not be fetched is a loss, not an absence", () => {
    const bed = describeAudioBed({
      timeline: timelineWith({ AMBIENT: [{ id: "amb_1" }, { id: "amb_2" }] }),
      recovered: new Set<string>(),
    });
    expect(bed.bare).toBe(true);
    expect(bed.line).toContain("nothing under the narration");
    expect(bed.line).toContain("UNRECOVERED(ambient=2)");
  });

  it("a partial loss is stated as a partial loss", () => {
    const bed = describeAudioBed({
      timeline: timelineWith({ AMBIENT: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      recovered: new Set(["a"]),
    });
    expect(bed.bare).toBe(false);
    expect(bed.line).toContain("ambient=1");
    expect(bed.line).toContain("UNRECOVERED(ambient=2)");
  });

  /**
   * The state the cutover produced and nobody chose: no music catalogue in this build, and no
   * ambience configured either. A ten-minute documentary of voice over silence.
   */
  it("voice over nothing at all is the loudest case", () => {
    const bed = describeAudioBed({ timeline: timelineWith({}), recovered: new Set() });
    expect(bed.bare).toBe(true);
    expect(bed.present).toEqual([]);
    expect(bed.lost).toEqual([]);
    expect(bed.line).toContain("voice=1");
    expect(bed.line).toContain("nothing under the narration");
  });

  it("an empty MUSIC track is not reported as a loss — nothing was ever planned", () => {
    const bed = describeAudioBed({
      timeline: timelineWith({ AMBIENT: [{ id: "a" }] }),
      recovered: new Set(["a"]),
    });
    expect(bed.line).not.toContain("music");
  });
});
