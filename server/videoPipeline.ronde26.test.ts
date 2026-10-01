import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { decideModernContentMismatch } from "./localClipVision";
import { detectImageMimeFromBuffer, imageMimeToDataUrl, prepareImageForVision } from "./archiveClipFilter";
import { expandAnchorToKnownPerson } from "./mediaResearchEngine";

import { hasContentAnchor } from "./searchQueryContract";

// RONDE 26 — four defects found by re-reading the renders 525/526/527 logs end to end.
//
// a) The anti-anachronism gate demanded two corroborating frames while the live path supplies
//    exactly one, so it could never fire: 152 evaluations, every one frames=0/1, zero rejects.
//    Its probe vocabulary was also office-only, blind to modern OUTDOOR footage — which is what
//    actually leaked into a WWII documentary (2020s roadside protests, a 2019 spacewalk).
// b) The baked-text detector hit "400 unsupported image" 38 times across 10 renders and, failing
//    open, admitted every one of those clips unexamined.
// c) The search anchor arrived truncated to a first name — "Adolf archival footage", 0 results,
//    eleven times — while Internet Archive's own full-name query found material.
// d) A montage shorter than its voice track was filled with a flat grey rectangle, which shipped.

// ── a) the modern-content gate ───────────────────────────────────────────────
//
// Thresholds under test: a probe counts only at >= 0.26 absolute AND >= beatSim + 0.05.
const OVER = 0.40; // clears both bars against the beatSim used below
const UNDER = 0.20; // inside the noise band, counts for nothing
const BEAT = 0.22;

const frame = (negSims: number[]): { beatSim: number; negSims: number[] } => ({
  beatSim: BEAT,
  negSims,
});

describe("RONDE 26a — the gate can fire on the single frame it is actually given", () => {
  it("rejects when three probes agree on one frame", () => {
    const verdict = decideModernContentMismatch([frame([OVER, OVER, OVER, UNDER, UNDER])]);
    expect(verdict.mismatch).toBe(true);
    expect(verdict.reason).toBe("strong-modern-evidence");
    expect(verdict.framesEvaluated).toBe(1);
  });

  it("still allows when only two probes agree on that single frame", () => {
    // Corroboration does not vanish with the second frame — it moves onto the probe axis and
    // gets STRICTER there (three, not two), because there is no second frame to back it up.
    const verdict = decideModernContentMismatch([frame([OVER, OVER, UNDER, UNDER, UNDER])]);
    expect(verdict.mismatch).toBe(false);
    expect(verdict.reason).toBe("insufficient-evidence");
  });

  it("keeps the two-probe bar when two frames can corroborate each other", () => {
    const verdict = decideModernContentMismatch([
      frame([OVER, OVER, UNDER]),
      frame([OVER, OVER, UNDER]),
    ]);
    expect(verdict.mismatch).toBe(true);
    expect(verdict.framesFlagged).toBe(2);
  });

  it("does not reject on a single flagged frame out of three", () => {
    const verdict = decideModernContentMismatch([
      frame([OVER, OVER, OVER]),
      frame([UNDER, UNDER, UNDER]),
      frame([UNDER, UNDER, UNDER]),
    ]);
    expect(verdict.mismatch).toBe(false);
  });

  it("leaves the borderline candidates from render 527 exactly where they were — allowed", () => {
    // The real numbers off the log line for the white-lives-matter clip: beatSim 0.2318,
    // topNegSim 0.2356. That is a 0.004 margin inside the noise band, nowhere near the 0.26
    // absolute floor. Making the gate reachable must NOT make it trigger-happy on near-ties;
    // those candidates still belong to the ordinary similarity ranking, not to a veto.
    const verdict = decideModernContentMismatch([
      { beatSim: 0.2318, negSims: [0.2356, 0.2301, 0.2288, 0.21, 0.19] },
    ]);
    expect(verdict.mismatch).toBe(false);
    expect(verdict.legacyWouldReject).toBe(true);
  });

  it("reports no-frames and no-probes rather than guessing", () => {
    expect(decideModernContentMismatch([]).reason).toBe("no-frames");
    expect(decideModernContentMismatch([frame([])]).reason).toBe("no-probes");
    expect(decideModernContentMismatch([]).mismatch).toBe(false);
  });
});

const visionSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");

describe("RONDE 26a — the probes can see modern life outside an office", () => {
  const block = visionSrc.slice(
    visionSrc.indexOf("const MODERN_MISMATCH_QUERIES = ["),
    visionSrc.indexOf("export function topicNeedsHistoricalFootage("),
  );

  it("covers clothing, vehicles, streets and skylines, not just meetings and laptops", () => {
    expect(block).toMatch(/modern casual clothing/);
    expect(block).toMatch(/present day street/);
    expect(block).toMatch(/skyscrapers/);
  });

  it("keeps the original office probes rather than swapping vocabulary wholesale", () => {
    expect(block).toContain("smartphone tablet digital app interface screen");
    expect(block).toContain("contemporary office whiteboard team meeting");
  });

  it("names no subject matter, so a historical rally cannot match on topic alone", () => {
    // "protest", "crowd" and "march" describe 1936 Nuremberg as readily as 2021 Alabama.
    expect(block).not.toMatch(/\b(protest|crowd|march|rally|demonstration)\b/i);
  });
});

// ── b) unsupported image formats ─────────────────────────────────────────────

/** Smallest thing that passes the magic-byte sniffer as a JPEG. */
const jpegBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 0x20)]);
const pngBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300)]);
const tiffBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(300)]);

describe("RONDE 26b — only formats the vision models accept ever reach them", () => {

  it("never labels a data URL with a mime the endpoint rejects", () => {
    // This is the exact shape that produced 38 x "400 unsupported image": the declared label was
    // forwarded verbatim into the data URL.
    expect(imageMimeToDataUrl(jpegBytes(), "image/tiff")).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageMimeToDataUrl(jpegBytes(), "image/svg+xml")).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageMimeToDataUrl(pngBytes(), "image/png")).toMatch(/^data:image\/png;base64,/);
  });

  it("identifies formats from the bytes, not the label", () => {
    expect(detectImageMimeFromBuffer(jpegBytes())).toBe("image/jpeg");
    expect(detectImageMimeFromBuffer(pngBytes())).toBe("image/png");
    expect(detectImageMimeFromBuffer(tiffBytes())).toBeNull();
    expect(detectImageMimeFromBuffer(Buffer.alloc(4))).toBeNull();
  });

  it("passes a mislabelled JPEG straight through, with no conversion and no failed call", async () => {
    const prepared = await prepareImageForVision(jpegBytes(), "image/tiff");
    expect(prepared).not.toBeNull();
    expect(prepared!.mimeType).toBe("image/jpeg");
  });

  it("refuses a buffer too short to carry a format signature", async () => {
    expect(await prepareImageForVision(Buffer.alloc(8), "image/jpeg")).toBeNull();
  });
});

const filterSrc = readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");

describe("RONDE 26b — both image call sites are guarded, and both still fail open", () => {
  it("the overlay filter prepares before it asks", () => {
    /**
     * RONDE 222 re-anchor: the body moved into `archiveClipBakedEditTextVerdict` and
     * `archiveClipHasBakedEditText` is now a one-line boolean wrapper over it. Same two claims —
     * it prepares first, and an unpreparable image does not become a judgement.
     */
    const fn = filterSrc.slice(
      filterSrc.indexOf("export async function archiveClipBakedEditTextVerdict("),
      filterSrc.indexOf("async function probeVideoDurationSec("),
    );
    expect(fn).toContain("prepareImageForVision(buf, mimeType)");
    expect(fn).toContain("if (!prepared) return NOT_ASKED(");
    /** And the one judge every caller asks still collapses that to "no text found". */
    const judge = readFileSync(path.join(__dirname, "visualJudge.ts"), "utf8");
    const at = judge.indexOf("export async function judgeOnScreenText(");
    const body = judge.slice(at, judge.indexOf("\n/**", at));
    /** The one reader (VisualJudge, code audit): "nobody looked" is an accept, never a refusal. */
    expect(body).toContain('if (result.verdict === "not_asked") {');
    expect(body).toContain('...accept("on_screen_text", "not_asked", 0)');
    expect(body).toContain('if (result.verdict === "has_text") {');
  });
});

// ── c) the truncated search anchor ───────────────────────────────────────────

describe("RONDE 26c — a first name is completed, never replaced", () => {
  const names = ["Adolf Hitler", "Eva Braun"];

  it("expands the fragment that produced eleven zero-result queries", () => {
    expect(expandAnchorToKnownPerson("Adolf", names)).toBe("Adolf Hitler");
    expect(expandAnchorToKnownPerson("Hitler", names)).toBe("Adolf Hitler");
    expect(expandAnchorToKnownPerson("Eva", names)).toBe("Eva Braun");
  });

  it("matches case-insensitively and through the possessive", () => {
    expect(expandAnchorToKnownPerson("hitler", names)).toBe("Adolf Hitler");
    expect(expandAnchorToKnownPerson("Hitler's", names)).toBe("Adolf Hitler");
  });

  it("leaves a multi-word anchor alone", () => {
    expect(expandAnchorToKnownPerson("Adolf Hitler", names)).toBe("Adolf Hitler");
    expect(expandAnchorToKnownPerson("Berlin bunker", names)).toBe("Berlin bunker");
  });

  it("leaves an anchor that is nobody's name alone", () => {
    // The dangerous failure mode would be silently swapping the subject of a query.
    expect(expandAnchorToKnownPerson("chaos", names)).toBe("chaos");
    expect(expandAnchorToKnownPerson("bunker", names)).toBe("bunker");
  });

  it("does nothing when no full name is known", () => {
    expect(expandAnchorToKnownPerson("Adolf", [])).toBe("Adolf");
    expect(expandAnchorToKnownPerson("Adolf", ["Adolf"])).toBe("Adolf");
  });

  it("handles empty input without throwing", () => {
    expect(expandAnchorToKnownPerson("", names)).toBe("");
    expect(expandAnchorToKnownPerson("   ", names)).toBe("");
  });
});

// ── d) the grey filler ───────────────────────────────────────────────────────

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
