/**
 * THE JOIN NAMED A STREAM, NOT A REASON — RONDE 627.
 *
 * ── What render 599 delivered to the operator ───────────────────────────────────────────────
 *
 *     RENDER_FAILED — transition graph: Error while processing the decoded data for stream #10:0
 *     Delivery blocked for video 599: AUTHORITATIVE_RENDER_FAILED
 *
 * RONDE 601 built `ffmpegComplaint` so that the sentence NAMING a fault would come first and the
 * bare failure reports would not. Its list holds three of the four lines ffmpeg emitted here:
 *
 *     [auto_scale_11 @ 0x…] Failed to configure output pad on auto_scale_11   listed
 *     Error reinitializing filters!                                           listed
 *     Failed to inject frame into filter network: Resource temporarily …      listed
 *     Error while processing the decoded data for stream #10:0                NOT listed
 *
 * So the only line carrying no cause was the only line eligible to be the complaint. This module's
 * own comment had already said as much — "ffmpeg then names an INPUT rather than the mismatch:
 * `Error while processing the decoded data for stream #10:0`" — and the list never learned it.
 *
 * ── Why the length explanation does not apply ───────────────────────────────────────────────
 *
 * Render 597 died on the same message and its cause was duration drift, which RONDE 184/597 fixed
 * by measuring each segment. Render 599 printed `[SegmentSpan] segments=11 unprobed=0 drifted=0
 * askedTotal=74.65s graphTotal=74.65s` — every segment measured, none drifted. The same symptom,
 * with the known cause ruled out by measurement, and no property visible to rule anything else in.
 *
 * ── What this round does, and deliberately does not ─────────────────────────────────────────
 *
 * It measures the four properties `xfade` and `concat` actually compare, on failure only, and names
 * the segment that differs. It repairs nothing: a segment with the wrong shape is a defect in
 * `renderSegment`, and normalising it here would hide the cause the next render has to show.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { ffmpegComplaint, oddSegmentsOut } from "./timelineRenderer";

const SRC = readFileSync(join(__dirname, "timelineRenderer.ts"), "utf8");

/** Render 599's stderr, in the order ffmpeg wrote it. */
const R599_STDERR = [
  "[auto_scale_11 @ 0x55f215e5c140] Failed to configure output pad on auto_scale_11",
  "Error reinitializing filters!",
  "Failed to inject frame into filter network: Resource temporarily unavailable",
  "Error while processing the decoded data for stream #10:0",
].join("\n");

/* ═══════════ §1 — the complaint no longer settles for a stream number ═══════════ */

describe("§1 — render 599's own stderr", () => {
  it("THE STREAM LINE IS NO LONGER REPORTED AS THE REASON", () => {
    expect(ffmpegComplaint({ stderr: R599_STDERR })).not.toBe(
      "Error while processing the decoded data for stream #10:0"
    );
  });

  it("and a real cause line still wins over every failure report", () => {
    /** Render 596's stderr, which DID carry a cause — it must still be the one chosen. */
    const withCause = [
      "[Parsed_xfade_6] First input link main parameters (size 1920x1078) do not match the " +
        "corresponding second input link xfade parameters (size 1920x1080)",
      "Error reinitializing filters!",
      "Error while processing the decoded data for stream #10:0",
    ].join("\n");
    expect(ffmpegComplaint({ stderr: withCause })).toContain("1920x1078");
  });

  it("the pattern is in the list rather than special-cased at the call site", () => {
    expect(SRC).toContain("/^Error while processing the decoded data for stream/,");
  });
});

/* ═══════════ §2 — the odd segment out ═══════════ */

describe("§2 — the majority is the reference, not the first segment", () => {
  const SHAPE_A = "width=1920 height=1080 pix_fmt=yuv420p sample_aspect_ratio=1:1 time_base=1/12800";
  const SHAPE_B = "width=1920 height=1078 pix_fmt=yuv420p sample_aspect_ratio=1:1 time_base=1/12800";

  it("RENDER 599's SHAPE — ten alike and one different names the one", () => {
    const shapes = Array.from({ length: 11 }, (_, i) => ({
      name: `seg_${String(i).padStart(3, "0")}.mp4`,
      shape: i === 10 ? SHAPE_B : SHAPE_A,
    }));
    const { reference, odd } = oddSegmentsOut(shapes);
    expect(reference).toBe(SHAPE_A);
    expect(odd.map((o) => o.name)).toEqual(["seg_010.mp4"]);
  });

  it("A DIFFERENT seg_000 DOES NOT MAKE THE OTHER TEN THE DEFECT", () => {
    /** The reason the reference is the majority: the first segment is not privileged. */
    const shapes = Array.from({ length: 11 }, (_, i) => ({
      name: `seg_${String(i).padStart(3, "0")}.mp4`,
      shape: i === 0 ? SHAPE_B : SHAPE_A,
    }));
    const { reference, odd } = oddSegmentsOut(shapes);
    expect(reference).toBe(SHAPE_A);
    expect(odd.map((o) => o.name)).toEqual(["seg_000.mp4"]);
  });

  it("segments that all agree produce no odd one — the join failed on something else", () => {
    const shapes = ["a", "b", "c"].map((n) => ({ name: n, shape: SHAPE_A }));
    expect(oddSegmentsOut(shapes).odd).toEqual([]);
  });

  it("an unprobeable segment is odd rather than silently matching", () => {
    const shapes = [
      { name: "a", shape: SHAPE_A },
      { name: "b", shape: SHAPE_A },
      { name: "c", shape: null },
    ];
    expect(oddSegmentsOut(shapes).odd.map((o) => o.name)).toEqual(["c"]);
  });

  it("and nothing probeable at all reports no reference rather than inventing one", () => {
    const { reference, odd } = oddSegmentsOut([{ name: "a", shape: null }]);
    expect(reference).toBeNull();
    expect(odd).toHaveLength(0);
  });

  it("A RENDER THAT MEASURED NOTHING SAYS SO, instead of reporting that the shapes matched", () => {
    /**
     * Written because the first draft printed "every segment has the same size, pixel format,
     * aspect and timebase" when `odd` was empty — which is also true of the case where not one
     * segment could be probed. That line would have reported a measurement nobody took, which is
     * the exact failure this round exists to remove.
     */
    expect(SRC).toContain("if (reference == null) {");
    expect(SRC).toContain("this render says NOTHING about whether");
  });
});

/* ═══════════ §3 — measured on failure, and only there ═══════════ */

describe("§3 — the probe is wired to the failure, and repairs nothing", () => {
  it("THE GRAPH CALL IS WRAPPED AND THE ERROR IS RE-THROWN", () => {
    const at = SRC.indexOf('await runFfmpeg(args, "transition graph");');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 1400);
    expect(body).toContain("catch (graphErr)");
    expect(body, "a diagnosed failure must still fail").toContain("throw graphErr;");
  });

  it("it probes the four properties the join actually compares", () => {
    for (const field of ["width", "height", "pix_fmt", "sample_aspect_ratio", "time_base"]) {
      expect(SRC).toContain(field);
    }
  });

  it("NOTHING IS NORMALISED HERE — the segment keeps the shape it was encoded with", () => {
    const at = SRC.indexOf("const { reference, odd } = oddSegmentsOut(shapes);");
    const body = SRC.slice(at, at + 900);
    expect(body).not.toContain("scale=");
    expect(body).not.toContain("setsar");
  });
});
