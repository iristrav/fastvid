import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MAX_SINGLE_FOOTAGE_SHARE,
  MAX_SINGLE_SOURCE_SHARE,
  UNPROVEN_SOURCE,
  computeScreenTimeShare,
  formatScreenTimeShare,
  screenTimeFindings,
  type DeliveredClip,
} from "./deliveredScreenTime";

/**
 * THE FILM THIS EXISTS BECAUSE OF.
 *
 * 76.30 seconds about Berlin in 1945. One modern Brink's armoured van filled 36.29s of it —
 * 47.6% — across three appearances including the opening and the closing shot. 4.92s of frozen
 * near-black filled another 6.4%. Every export gate passed it.
 *
 * None of them was wrong to. The gates ask whether beats were filled and whether provenance can
 * be named; both were true. The one number describing the mix, `bySource` in the quality report,
 * is `+ 1` per CLIP — so a 36-second clip and a 2-second clip weigh the same, and a film that is
 * half one shot reports as a healthy spread.
 */

const clip = (
  source: string | null,
  contentKey: string | null,
  durationSec: number,
  path = `${contentKey ?? source}-${durationSec}.mp4`
): DeliveredClip => ({ path, source, contentKey, durationSec });

/** Render 578's delivered mix, to the numbers measured off the file. */
const RENDER_578: DeliveredClip[] = [
  clip("pexels", "pexels:brinks", 17.44),
  clip("pexels", "pexels:brinks", 1.78),
  clip("pexels", "pexels:brinks", 17.07),
  clip("youtube_cc", "youtube_cc:hitler-balcony", 6.0),
  clip("archive", "curated:asset:1", 8.0),
  clip("openverse", "openverse:bendlerblock", 6.0),
  clip("wikimedia", "wikimedia:crowd", 15.09),
];

describe("screen time, in the units the viewer experiences", () => {
  it("counts SECONDS, not clips", () => {
    /**
     * The whole point. By clip count the van is 3 of 7 entries — 43%, and one of four sources.
     * By screen time it is 47.6% of the film. Only the second number is what anyone watches.
     */
    const share = computeScreenTimeShare(RENDER_578);
    expect(share.totalSec).toBeCloseTo(71.38, 2);
    const van = share.byFootage.find((f) => f.key === "pexels:brinks")!;
    expect(van.sec).toBeCloseTo(36.29, 2);
    expect(van.share).toBeGreaterThan(0.5);
    expect(van.appearances, "three separate appearances, one piece of footage").toBe(3);
  });

  it("THE SAME FOOTAGE IN THREE PLACES IS ONE PIECE OF FOOTAGE", () => {
    // Keyed on the ledger's content key, so repetition is visible rather than spread across rows.
    const share = computeScreenTimeShare(RENDER_578);
    expect(share.byFootage.filter((f) => f.key === "pexels:brinks")).toHaveLength(1);
    expect(share.byFootage[0]!.key, "and it is the largest thing in the film").toBe("pexels:brinks");
  });

  it("a clip the ledger could not key counts as its own footage, never merged", () => {
    /**
     * Over-counting distinct footage is the safe direction: it can only make the dominance number
     * smaller, so an unkeyed clip can never manufacture a finding that is not there.
     */
    const share = computeScreenTimeShare([
      clip("pexels", null, 10, "/w/a.mp4"),
      clip("pexels", null, 10, "/w/b.mp4"),
    ]);
    expect(share.byFootage).toHaveLength(2);
    expect(share.bySource[0]!.sec).toBe(20);
  });

  it("an unproven source is named, not dropped", () => {
    const share = computeScreenTimeShare([clip(null, "file:xyz", 5)]);
    expect(share.bySource[0]!.source).toBe(UNPROVEN_SOURCE);
  });

  it("zero and negative durations cannot poison the total", () => {
    const share = computeScreenTimeShare([
      clip("pexels", "a", 10),
      clip("pexels", "b", 0),
      clip("pexels", "c", Number.NaN),
      clip("pexels", "d", -4),
    ]);
    expect(share.totalSec).toBe(10);
    expect(share.byFootage).toHaveLength(1);
  });

  it("an empty film measures nothing and says so", () => {
    const share = computeScreenTimeShare([]);
    expect(share.totalSec).toBe(0);
    expect(formatScreenTimeShare(share, [])).toContain("could not be measured");
  });
});

describe("the findings", () => {
  it("RENDER 578 WOULD HAVE BEEN CAUGHT", () => {
    const findings = screenTimeFindings(computeScreenTimeShare(RENDER_578));
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("ONE_CLIP_DOMINATES");
    const detail = findings.find((f) => f.code === "ONE_CLIP_DOMINATES")!.detail;
    expect(detail).toContain("36.3s");
    expect(detail).toContain("3 appearance(s)");
    expect(detail).toContain("source=pexels");
  });

  it("a considered edit produces nothing", () => {
    // Four sources, longest shot under a quarter of the film. Silence is the correct output.
    const fine = computeScreenTimeShare([
      clip("youtube_cc", "yt:a", 12),
      clip("youtube_cc", "yt:b", 11),
      clip("archive", "curated:asset:9", 10),
      clip("wikimedia", "wiki:x", 9),
      clip("internet_archive", "ia:y", 8),
    ]);
    expect(screenTimeFindings(fine)).toEqual([]);
    expect(formatScreenTimeShare(fine, [])).toContain("ok");
  });

  it("ONE SOURCE MAY LEAD; IT MAY NOT BE THE WHOLE FILM", () => {
    /**
     * The operator's brief is a film made mostly of YouTube, so a leading source is the intent and
     * must not trip this. The limit sits where "mostly" has become "only".
     */
    const mostlyYoutube = computeScreenTimeShare([
      clip("youtube_cc", "yt:a", 10),
      clip("youtube_cc", "yt:b", 10),
      clip("youtube_cc", "yt:c", 10),
      clip("youtube_cc", "yt:d", 10),
      clip("archive", "curated:asset:1", 10),
    ]);
    expect(mostlyYoutube.bySource[0]!.share).toBeCloseTo(0.8, 2);
    const codes = screenTimeFindings(mostlyYoutube).map((f) => f.code);
    expect(codes, "80% from one source, no single shot dominating").toContain("ONE_SOURCE_DOMINATES");
    expect(codes, "and no clip dominates — they are four different shots").not.toContain("ONE_CLIP_DOMINATES");
    expect(MAX_SINGLE_SOURCE_SHARE).toBe(0.7);
    expect(MAX_SINGLE_FOOTAGE_SHARE).toBe(0.25);
  });

  it("limits are arguments, so a caller may hold a different line", () => {
    const share = computeScreenTimeShare(RENDER_578);
    expect(screenTimeFindings(share, { maxFootage: 0.99, maxSource: 0.99 })).toEqual([]);
  });
});

describe("what the render does with it", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("it measures, it does not decide", () => {
    /**
     * `screenTimeFindings` returns findings and throws nothing. Turning this into an export block
     * is a separate decision with an operator behind it — a measurement that starts failing renders
     * on the day it lands is not a measurement.
     */
    /** Comments stripped: the prose says "it does not throw", and that is not a throw. */
    const src = readFileSync(join(__dirname, "deliveredScreenTime.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("throw ");
    expect(src).not.toContain("pipelineError");
  });

  it("THE FINDING REACHES THE STORED REPORT, not only the console", () => {
    /**
     * The defect this pipeline keeps reproducing: a value computed and then not carried. A warning
     * that only ever reaches a worker log is how a film that was 47.6% one stock clip shipped.
     */
    expect(PIPE).toContain("qualityReportScreenTimeWarnings.push(");
    expect(PIPE).toContain("for (const w of qualityReportScreenTimeWarnings) qualityReport.warnings.push(w);");
  });

  it("the source comes from the ledger and never from a filename", () => {
    const at = PIPE.indexOf("const delivered: DeliveredClip[] = [];");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, PIPE.indexOf("const share = computeScreenTimeShare(delivered);", at));
    expect(block).toContain("ledger.providerFor(clipPath");
    expect(block).toContain("clipContentKey(clipPath)");
    expect(block, "no filename reading").not.toContain("basename");
  });

  it("each distinct clip is probed once", () => {
    // A render with fifteen clips must not pay for fifteen probes of the same repeated file.
    const at = PIPE.indexOf("const seenDur = new Map<string, number>();");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, PIPE.indexOf("const share = computeScreenTimeShare(delivered);", at));
    expect(block).toContain("seenDur.get(clipPath)");
    expect(block).toContain("seenDur.set(clipPath, durationSec)");
    expect(block, "the render's own probe first").toContain("memoisedVideoStreamMeta(clipPath)");
  });

  it("a failed measurement never costs the render its film", () => {
    const at = PIPE.indexOf("[ScreenTime] could not measure the delivered mix");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.slice(at - 300, at)).toContain("catch");
  });
});
