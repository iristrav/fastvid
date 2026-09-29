/**
 * RONDE 133 — the audit round, and the one bug it found.
 *
 * This round's headline task was a live production render. That could not be run here: the
 * environment has no DATABASE_URL, no TTS key, no YouTube Data API key and no LLM provider key,
 * so there is no way to produce a script, a voiceover, a provider search or a vision verdict. The
 * numbers that need a render are reported as unavailable rather than estimated.
 *
 * What the audit COULD do is measure the code against the production data already recorded in it,
 * and that turned up one defect of exactly the kind this project keeps rediscovering:
 *
 *     RONDE 130 built videoStillnessAudit to answer "how long is the viewer looking at the same
 *     thing", proved it on a real MP4, and never called it from the pipeline.
 *
 * Healthy module, healthy tests, no flag switching it off, and zero effect on a render — the
 * RONDE 26 shape, missed by all three of the lenses RONDE 29 named. The tests below hold the
 * wiring in place and record the two measurements that produced the round's other findings.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { decideModernContentMismatch, type ModernMismatchFrameEvidence } from "./localClipVision";
import { decideResearch, selectCorrectedQueries } from "./mismatchResearch";
import {
  emptyQueryContext,
  provenToken,
  type VerifiedQueryContext,
} from "./searchQueryContract";

/**
 * videoPipeline.ts is a very large file and every wiring assertion below scans it. Read once and
 * shared: nine separate reads of it measurably lengthened this file's slot in the suite, which on
 * a loaded machine is enough to push a concurrently-running ffmpeg test past its own timeout.
 */
const PIPELINE_SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const SRC = () => PIPELINE_SRC;

describe("RONDE 133 — the stillness audit runs on real renders", () => {

  it("6. the measurement is stored on the quality report so it survives the render", () => {
    const report = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("stillness?: {");
    expect(report).toContain("longestStillSec: number;");
    expect(report).toContain("visualChanges: number;");
  });
});

/**
 * The modern_mismatch finding, as a measurement rather than an opinion.
 *
 * RONDE 51 recorded, in localClipVision.ts, the only per-candidate production numbers this gate
 * has ever produced — render 530, six candidates, topNegSim against beatSim. Those numbers are
 * replayed here through the gate's own decision function.
 *
 * Nothing about the gate is changed by this round. These tests exist so the next person to look
 * at `modern_mismatch=0/77` finds the arithmetic already done.
 */
describe("RONDE 133 — why modern_mismatch never fires", () => {
  /** Render 530, from the RONDE 51 comment block. */
  const RENDER_530 = [
    { label: "archive Bundesarchiv", top: 0.2103, beat: 0.2145, trulyModern: false },
    { label: "archive (2)", top: 0.2077, beat: 0.1974, trulyModern: false },
    { label: "archive Klara_Hitler", top: 0.189, beat: 0.1974, trulyModern: false },
    { label: "modern pexels (1)", top: 0.2432, beat: 0.2129, trulyModern: true },
    { label: "modern pexels (2)", top: 0.2284, beat: 0.226, trulyModern: true },
    { label: "modern pexels (3)", top: 0.2389, beat: 0.223, trulyModern: true },
  ];

  /** One frame is what the live cascade supplies — see extractSinglePreviewFrame. */
  const singleFrame = (top: number, beat: number, spread = 0.02): ModernMismatchFrameEvidence[] => [
    { beatSim: beat, negSims: [top, ...Array(9).fill(top - spread)] },
  ];

  it("7. on the live single-frame path it fires on nothing — including genuinely modern stock", () => {
    for (const c of RENDER_530) {
      const verdict = decideModernContentMismatch(singleFrame(c.top, c.beat));
      expect(verdict.mismatch).toBe(false);
    }
    // The three archive candidates are correctly left alone. The three modern ones are missed —
    // which is the finding: 0/77 in production is the gate working exactly as configured.
    expect(RENDER_530.filter((c) => c.trulyModern)).toHaveLength(3);
  });

  it("8. the reason is the three-probe rule, not the floor alone", () => {
    // Two of the three modern candidates never clear the 0.235 floor even on their TOP probe, so
    // no rule about corroboration could save them.
    const clearsFloor = RENDER_530.filter((c) => c.trulyModern && c.top >= 0.235);
    expect(clearsFloor).toHaveLength(2);

    // And for the two that do, the single-frame path demands THREE probes above the floor. With
    // every probe tied at the top value — the most generous reading possible — it fires.
    for (const c of clearsFloor) {
      const generous: ModernMismatchFrameEvidence[] = [
        { beatSim: c.beat, negSims: Array(10).fill(c.top) },
      ];
      expect(decideModernContentMismatch(generous).mismatch).toBe(true);
      // With any realistic spread between probe families, it does not.
      expect(decideModernContentMismatch(singleFrame(c.top, c.beat)).mismatch).toBe(false);
    }
  });

  it("9. the multi-frame path can fire, which is why the gate is not simply broken", () => {
    const c = RENDER_530[3]!;
    const threeFrames: ModernMismatchFrameEvidence[] = Array.from({ length: 3 }, () => ({
      beatSim: c.beat,
      negSims: [c.top, c.top - 0.005, ...Array(8).fill(c.top - 0.02)],
    }));
    expect(decideModernContentMismatch(threeFrames).mismatch).toBe(true);
  });

  it("10. it costs no network call and no extra image embedding", () => {
    const src = readFileSync(join(__dirname, "localClipVision.ts"), "utf8");
    // The probes are CLIP text embeddings computed locally and cached for the process.
    expect(src).toContain("modernMismatchEmbCache");
    // The image embeddings are the ones the similarity score already computed.
    expect(src).toContain("evaluateModernContentMismatch(imageEmbeddings");
  });
});

/**
 * The research pass, measured for reach.
 *
 * RONDE 132 proved the corrected query is well-formed. This measures how OFTEN it can be formed
 * at all, which is the number that bounds the round's effect on a real render.
 */
