/**
 * FFMPEG SAYS THE CONSEQUENCE LOUDEST — RONDE 629.
 *
 * ── The trap this classifier is built around ────────────────────────────────────────────────
 *
 * Render 599's entire stderr was four lines, and not one of them named a cause:
 *
 *     [auto_scale_11 @ 0x…] Failed to configure output pad on auto_scale_11
 *     Error reinitializing filters!
 *     Failed to inject frame into filter network: Resource temporarily unavailable
 *     Error while processing the decoded data for stream #10:0
 *
 * A classifier that reads the first line it recognises calls that RESOURCE, because line three
 * contains the words "Resource temporarily unavailable" — in a sentence about a filter graph
 * refusing a frame, on a machine with plenty of memory. That is the single most likely way for
 * this module to be wrong, so §1 pins it.
 *
 * ── Why auto_scale counts as geometry ───────────────────────────────────────────────────────
 *
 * ffmpeg inserts an auto-scaler only when two links disagree about size or format. Its failure is
 * therefore evidence of a geometry-family fault even though the line names no dimensions — which is
 * the one case where a consequence line is allowed to decide.
 *
 * ── UNKNOWN is a real answer ────────────────────────────────────────────────────────────────
 *
 * §4. A failure nothing recognises must not be given a class by coincidence of wording, because a
 * recovery engine would then pick a strategy from that coincidence.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  classifyFfmpegFailure,
  formatFfmpegFailure,
  geometryEvidenceFromShapes,
} from "./ffmpegFailureClass";

const SRC = readFileSync(join(__dirname, "timelineRenderer.ts"), "utf8");

/** Render 599, verbatim. */
const R599 = [
  "[auto_scale_11 @ 0x55f215e5c140] Failed to configure output pad on auto_scale_11",
  "Error reinitializing filters!",
  "Failed to inject frame into filter network: Resource temporarily unavailable",
  "Error while processing the decoded data for stream #10:0",
].join("\n");

/** Render 596, which did carry a cause. */
const R596 = [
  "[Parsed_xfade_6] First input link main parameters (size 1920x1078) do not match the " +
    "corresponding second input link xfade parameters (size 1920x1080)",
  "Error reinitializing filters!",
].join("\n");

/* ═══════════ §1 — render 599 is not a resource failure ═══════════ */

describe("§1 — the consequence must not out-shout the cause", () => {
  it("RENDER 599 IS NOT CLASSIFIED AS RESOURCE", () => {
    /** "Resource temporarily unavailable" is a filter-graph message, not an out-of-memory. */
    expect(classifyFfmpegFailure(R599).cls).not.toBe("RESOURCE");
  });

  it("it is GEOMETRY, because an auto-scaler only exists when two links disagree", () => {
    expect(classifyFfmpegFailure(R599).cls).toBe("GEOMETRY");
  });

  it("and the evidence is the whole line, not the matched fragment", () => {
    expect(classifyFfmpegFailure(R599).evidence).toBe(
      "[auto_scale_11 @ 0x55f215e5c140] Failed to configure output pad on auto_scale_11"
    );
  });

  it("RENDER 596's SIZE LINE STILL WINS over the reinit line below it", () => {
    const d = classifyFfmpegFailure(R596);
    expect(d.cls).toBe("GEOMETRY");
    expect(d.evidence).toContain("1920x1078");
  });
});

/* ═══════════ §2 — one real string per class ═══════════ */

describe("§2 — each class is anchored on something ffmpeg actually prints", () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ["TIMEOUT", "Timeout: YouTube CC cloud download scene 1 exceeded 117s (10101)"],
    ["PIXEL_FORMAT", "Impossible to convert between the formats supported by the filter"],
    ["TIMEBASE", "First input link main timebase (1/1000000) do not match the second timebase"],
    ["INPUT_MISSING", "seg_004.mp4: No such file or directory"],
    ["RESOURCE", "av_interleaved_write_frame(): No space left on device"],
    ["CODEC", "Unknown encoder 'libx265'"],
    ["STREAM_MAPPING", "Stream map '[vout]' matches no streams."],
    ["FILTER_GRAPH", "No such filter: 'xfadez'"],
    ["DECODE", "Invalid data found when processing input"],
    ["AUDIO_VIDEO_MISMATCH", "Non-monotonous DTS in output stream 0:1"],
    ["MUX", "Could not write header for output file #0"],
  ];

  for (const [cls, line] of CASES) {
    it(`${cls}`, () => {
      expect(classifyFfmpegFailure(line).cls).toBe(cls);
    });
  }
});

/* ═══════════ §3 — the measurement checks the classifier ═══════════ */

describe("§3 — the shapes are allowed to contradict the label", () => {
  const SHAPE = "width=1920 height=1080 pix_fmt=yuv420p";

  it("A GEOMETRY VERDICT WITH IDENTICAL SEGMENTS IS REPORTED AS A SYMPTOM", () => {
    const note = geometryEvidenceFromShapes({ cls: "GEOMETRY", reference: SHAPE, odd: [] });
    expect(note).toContain("SYMPTOM and not the cause");
  });

  it("and an odd segment is named with what it is instead", () => {
    const note = geometryEvidenceFromShapes({
      cls: "GEOMETRY",
      reference: SHAPE,
      odd: [{ name: "seg_010.mp4", shape: "width=1920 height=1078 pix_fmt=yuv420p" }],
    });
    expect(note).toContain("seg_010.mp4=width=1920 height=1078");
  });

  it("an unprobeable render says nothing rather than something", () => {
    expect(geometryEvidenceFromShapes({ cls: "GEOMETRY", reference: null, odd: [] })).toBeNull();
  });

  it("a non-geometry class with matching shapes adds no note at all", () => {
    expect(geometryEvidenceFromShapes({ cls: "MUX", reference: SHAPE, odd: [] })).toBeNull();
  });
});

/* ═══════════ §4 — UNKNOWN stays UNKNOWN ═══════════ */

describe("§4 — an unrecognised failure is not given a class", () => {
  it("UNKNOWN RATHER THAN A GUESS", () => {
    expect(classifyFfmpegFailure("something nobody has written a pattern for").cls).toBe("UNKNOWN");
  });

  it("empty input is UNKNOWN with no evidence, not a crash", () => {
    expect(classifyFfmpegFailure("")).toEqual({ cls: "UNKNOWN", evidence: "" });
    expect(classifyFfmpegFailure(null).cls).toBe("UNKNOWN");
    expect(classifyFfmpegFailure(undefined).cls).toBe("UNKNOWN");
  });

  it("an Error's stderr is read as well as its message", () => {
    const err = Object.assign(new Error("Command failed: ffmpeg …"), {
      stderr: "Unknown encoder 'libx265'",
    });
    expect(classifyFfmpegFailure(err).cls).toBe("CODEC");
  });
});

/* ═══════════ §5 — wired into the render, beside the probe ═══════════ */

describe("§5 — the renderer prints the class with the measurement", () => {
  it("THE CLASSIFIER READS THE ACTUAL ERROR", () => {
    expect(SRC).toContain("const diagnosis = classifyFfmpegFailure(graphErr);");
    expect(SRC).toContain("await diagnoseSegmentShapes(graphErr);");
  });

  it("and the shape evidence is passed alongside it", () => {
    expect(SRC).toContain("geometryEvidenceFromShapes({ cls: diagnosis.cls, reference, odd })");
  });

  it("the line is greppable across productions", () => {
    expect(formatFfmpegFailure("transition graph", { cls: "GEOMETRY", evidence: "x" })).toContain(
      "[FfmpegFailure] stage=transition graph class=GEOMETRY"
    );
  });
});
