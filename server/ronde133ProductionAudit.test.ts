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
  it("1. the pipeline calls auditVideoStillness on the finished MP4", () => {
    const src = SRC();
    // The defect this round fixed: the module existed and nothing called it.
    expect(src).toContain("auditVideoStillness({");
    expect(src).toContain("videoPath: finalVideoPath");
  });

  it("2. it measures the EXPORTED file, not a scene or a candidate", () => {
    const src = SRC();
    const idx = src.indexOf("auditVideoStillness({");
    expect(idx).toBeGreaterThan(0);
    // The call's own arguments, and nothing after them.
    const args = src.slice(idx, src.indexOf("})", idx));
    expect(args).toContain("videoPath: finalVideoPath");
    // An audit that trusted the pipeline's own metadata would be asking the suspect for its
    // alibi — the only input is the exported file's path.
    expect(args).not.toContain("qualityReport");
    expect(args).not.toContain("scenePaths");
  });

  it("3. the verdict is checked against the still-image cap, not a fresh threshold", () => {
    const src = SRC();
    const idx = src.indexOf("auditVideoStillness({");
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("checkStillnessLimit(stillness, stillImageMaxSec())");
  });

  it("4. a violation becomes a warning on the report, not a silent pass", () => {
    const src = SRC();
    const idx = src.indexOf("auditVideoStillness({");
    const block = src.slice(idx, idx + 1600);
    expect(block).toContain("verdict.violations");
    expect(block).toContain("qualityReport.warnings.push");
    expect(block).toContain("qualityReport.stillness =");
  });

  it("5. an audit that cannot run never blocks the export and never reads as a pass", () => {
    const src = SRC();
    const idx = src.indexOf("auditVideoStillness({");
    // The wrapper sits BEFORE the call, so the window has to start above it.
    const block = src.slice(idx - 200, idx + 1900);
    // Wrapped, timed out, and on failure it logs — it does not set `ok: true`.
    expect(block).toContain("await withTimeout(");
    expect(block).toContain("stillness audit could not run");
    const catchIdx = block.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(0);
    // Nothing in the failure path claims the file passed.
    expect(block.slice(catchIdx)).not.toContain("ok: true");
    expect(block.slice(catchIdx)).not.toContain("qualityReport.stillness =");
  });

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
describe("RONDE 133 — how far the research correction reaches", () => {
  const ctxFor = (evidence: string, parts: Partial<Record<
    "person" | "place" | "year" | "time" | "action", string
  >>): VerifiedQueryContext => {
    const ctx = emptyQueryContext(evidence);
    if (parts.person) ctx.persons = [provenToken(parts.person, "person", "beat_text", evidence)];
    if (parts.place) ctx.places = [provenToken(parts.place, "place", "beat_text", evidence)];
    if (parts.year) ctx.years = [provenToken(parts.year, "year", "beat_text", evidence)];
    if (parts.time) ctx.time = [provenToken(parts.time, "time", "beat_text", evidence)];
    if (parts.action) ctx.actions = [provenToken(parts.action, "action", "beat_text", evidence)];
    return ctx;
  };

  it("11. a period correction needs a period the BEAT states", () => {
    const withYear = ctxFor("In April 1945 Hermann Göring left Berlin for the south.", {
      person: "Hermann Göring", place: "Berlin", year: "1945", time: "April 1945", action: "left",
    });
    expect(decideResearch({ kind: "WRONG_PERIOD", ctx: withYear, alreadyResearched: false }).action)
      .toBe("RESEARCH");

    const withoutYear = ctxFor("Göring commanded the Luftwaffe throughout the war.", {
      person: "Göring", action: "commanded",
    });
    const d = decideResearch({ kind: "WRONG_PERIOD", ctx: withoutYear, alreadyResearched: false });
    expect(d.action).toBe("NONE");
    if (d.action !== "NONE") return;
    // Declining is correct — RONDE 90 forbids supplying a year the script does not state — but it
    // is also the ceiling on how much of a render's period faults this pass can address.
    expect(d.reason).toBe("NO_BETTER_QUERY");
  });

  it("12. subject and place corrections reach beats a period correction cannot", () => {
    const personOnly = ctxFor("Göring built an air force from nothing.", {
      person: "Göring", action: "built",
    });
    expect(decideResearch({ kind: "WRONG_PERIOD", ctx: personOnly, alreadyResearched: false }).action)
      .toBe("NONE");
    expect(decideResearch({ kind: "WRONG_SUBJECT", ctx: personOnly, alreadyResearched: false }).action)
      .toBe("RESEARCH");
  });

  it("13. the correction already walks narrow → broad, and stops", () => {
    const ctx = ctxFor("In April 1945 Hermann Göring left Berlin for the south.", {
      person: "Hermann Göring", place: "Berlin", year: "1945", time: "April 1945", action: "left",
    });
    const d = decideResearch({
      kind: "WRONG_PERIOD", ctx, alreadyResearched: false,
      alreadyUsed: ["Hermann Göring Berlin"],
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    // Two queries: the specific correction, then a broader one. Never more — §6's bound, already
    // satisfied by the maxQueries cap rather than by a new expansion stage.
    expect(d.correctedQueries).toHaveLength(2);
    expect(d.correctedQueries[0]).toBe("Hermann Göring Berlin 1945");
    const tokens = d.correctedQueries.map((q) => q.split(/\s+/).length);
    expect(tokens[1]!).toBeLessThan(tokens[0]!);
  });

  it("14. more corrections exist than are sent — the cap is what bounds the pass", () => {
    const ctx = ctxFor("In April 1945 Hermann Göring left Berlin for the south.", {
      person: "Hermann Göring", place: "Berlin", year: "1945", time: "April 1945", action: "left",
    });
    const pool = selectCorrectedQueries({ ctx, strategy: "ADD_TIME" });
    expect(pool.length).toBeGreaterThan(2);
    const d = decideResearch({ kind: "WRONG_PERIOD", ctx, alreadyResearched: false });
    if (d.action !== "RESEARCH") return;
    expect(d.correctedQueries.length).toBeLessThanOrEqual(2);
  });

  it("15. the title's words never enter a correction, whatever the fault", () => {
    // "The Influential Choice Hermann Göring Made To Join Hitler" — RONDE 90 keeps the title out
    // of the evidence entirely, so none of its words can be proven by it.
    const ctx = ctxFor("The influential choice Hermann Göring made to join Hitler changed everything.", {
      person: "Hermann Göring", action: "changed",
    });
    for (const kind of ["WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE", "UNRELATED"] as const) {
      const d = decideResearch({ kind, ctx, alreadyResearched: false });
      if (d.action !== "RESEARCH") continue;
      for (const q of d.correctedQueries) {
        expect(q.toLowerCase()).not.toContain("influential");
        expect(q.toLowerCase()).not.toContain("choice");
        expect(q).toContain("Göring");
      }
    }
  });
});
