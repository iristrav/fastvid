/**
 * RONDE 132 — ask a better question, and land the last frame inside the file.
 *
 * Two production faults, both reproduced before being fixed.
 *
 * ── A. `[ClosingTail] could not be built` ────────────────────────────────────────────────────
 *
 * Reproduced exactly, with a scene-shaped MP4 whose audio outlives its picture — which is every
 * composed scene, because the voiceover and its fade end after the last video frame:
 *
 *     format=duration        21.400   ← what probeVideoDurationSec reads
 *     stream=duration (v:0)  21.200
 *     last video frame pts   21.160
 *
 *     ffmpeg -ss 21.300 …  →  "Output file is empty, nothing was encoded"
 *
 * RONDE 121 subtracted 0.1s from the CONTAINER duration, which is the maximum over all streams.
 * The tests below build that file for real and assert against its real frame times.
 *
 * ── B. a refusal that blamed the question and changed nothing ────────────────────────────────
 *
 * RONDE 131 taught the pipeline to read its refusals; it could only reorder the candidates it
 * already had. These tests prove the corrected question is selected from the contract, carries
 * the beat's own tokens with their Unicode intact, is capped at one extra pass, and never fires
 * on a fault that belongs to the material.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClosingTail,
  closingTailFrameSeek,
  closingTailSeekIsSafe,
  CLOSING_TAIL_FRAME_WINDOW_SEC,
} from "./closingTail";
import {
  correctionStrategyFor,
  createResearchTally,
  decideResearch,
  formatResearchDecision,
  formatResearchOutcome,
  formatResearchQuery,
  formatResearchSummary,
  recordResearchAttempt,
  recordResearchOutcome,
  recordResearchSkip,
  selectCorrectedQueries,
} from "./mismatchResearch";
import { classifyMismatch, mismatchFault } from "./visualMismatchFeedback";
import {
  emptyQueryContext,
  provenToken,
  searchGateStrict,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { auditVideoStillness, checkStillnessLimit } from "./videoStillnessAudit";
import { stillImageMaxSec } from "./stillImagePolicy";

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";

function ffprobe(args: string[]): string {
  return execFileSync(FFPROBE, args, { encoding: "utf8" }).trim();
}

/**
 * The production case, built from the beat's own words.
 *
 * "In April 1945 Hermann Göring left Berlin for the south." — the real extractor produces exactly
 * these tokens for it (traced against buildVerifiedQueryContextForBeat before this test was
 * written); they are stated here rather than re-extracted so the assertions are about the
 * correction logic and not about the extractor, which RONDE 125 already guards.
 */
function goringBerlinContext(): VerifiedQueryContext {
  const evidence = "In April 1945 Hermann Göring left Berlin for the south.";
  const ctx = emptyQueryContext(evidence);
  ctx.persons = [provenToken("Hermann Göring", "person", "beat_text", evidence)];
  ctx.places = [provenToken("Berlin", "place", "beat_text", evidence)];
  ctx.years = [provenToken("1945", "year", "beat_text", evidence)];
  ctx.time = [provenToken("April 1945", "time", "beat_text", evidence)];
  ctx.actions = [provenToken("left", "action", "beat_text", evidence)];
  return ctx;
}

/** A beat that names a person and nothing else — no year, no place to fall back on. */
function personOnlyContext(): VerifiedQueryContext {
  const evidence = "The influential choice Hermann Göring made to join Hitler changed everything.";
  const ctx = emptyQueryContext(evidence);
  ctx.persons = [provenToken("Hermann Göring", "person", "beat_text", evidence)];
  ctx.actions = [provenToken("changed", "action", "beat_text", evidence)];
  return ctx;
}

describe("RONDE 132 — a QUESTION fault starts one corrected search", () => {
  it("1. WRONG_PERIOD asks the contract's time-bearing question", () => {
    const ctx = goringBerlinContext();
    const decision = decideResearch({
      kind: "WRONG_PERIOD",
      ctx,
      alreadyResearched: false,
      alreadyUsed: ["Hermann Göring Berlin"],
    });
    expect(decision.action).toBe("RESEARCH");
    if (decision.action !== "RESEARCH") return;
    expect(decision.blame).toBe("QUESTION");
    expect(decision.strategy).toBe("ADD_TIME");
    // The brief's worked example, in this beat's own words: the period joins the question.
    expect(decision.correctedQuery).toBe("Hermann Göring Berlin 1945");
    expect(decision.correctedQuery).not.toBe("Hermann Göring Berlin");
  });

  it("2. WRONG_SUBJECT asks a question that names the person", () => {
    const decision = decideResearch({
      kind: "WRONG_SUBJECT",
      ctx: goringBerlinContext(),
      alreadyResearched: false,
      alreadyUsed: ["Hermann Göring Berlin"],
    });
    expect(decision.action).toBe("RESEARCH");
    if (decision.action !== "RESEARCH") return;
    expect(decision.strategy).toBe("ADD_PERSON");
    expect(decision.correctedQuery).toContain("Hermann Göring");
  });

  it("3. WRONG_LOCATION (WRONG_PLACE) asks a question that names the place", () => {
    const decision = decideResearch({
      kind: "WRONG_PLACE",
      ctx: goringBerlinContext(),
      alreadyResearched: false,
      alreadyUsed: ["Hermann Göring"],
    });
    expect(decision.action).toBe("RESEARCH");
    if (decision.action !== "RESEARCH") return;
    expect(decision.strategy).toBe("ADD_PLACE");
    expect(decision.correctedQuery).toContain("Berlin");
  });

  /**
   * SUPERSEDED BY RONDE 134, deliberately.
   *
   * This asserted that a TEXT_ON_SCREEN refusal changed nothing. RONDE 132's reasoning was that a
   * material fault does not indict the question — still true, and still visible in `blame`. What
   * RONDE 134 adds is that there IS one move available which does not change the subject: ask the
   * contract's archival-phrased variant of the same question. A beat whose every candidate was a
   * title card previously fell through with the question unchanged.
   *
   * The guarantee this test was protecting — a material fault never rewrites the SUBJECT — is
   * asserted below, and more strictly than before.
   */
  it("4. TEXT_ON_SCREEN asks for the archive without changing the subject", () => {
    const decision = decideResearch({
      kind: "TEXT_ON_SCREEN",
      ctx: goringBerlinContext(),
      alreadyResearched: false,
    });
    expect(decision.action).toBe("RESEARCH");
    if (decision.action !== "RESEARCH") return;
    // The blame is unchanged: this is still a fault of the material.
    expect(decision.blame).toBe("MATERIAL");
    expect(decision.strategy).toBe("ADD_ARCHIVAL_INTENT");
    expect(correctionStrategyFor("TEXT_ON_SCREEN")).toBe("ADD_ARCHIVAL_INTENT");
    // Same subject, different kind of material.
    expect(decision.correctedQuery).toContain("Hermann Göring");
    expect(decision.correctedQuery).toContain("archival footage");
  });

  it("5. TALKING_HEAD is a material fault and is still reported as one", () => {
    const decision = decideResearch({
      kind: "TALKING_HEAD",
      ctx: goringBerlinContext(),
      alreadyResearched: false,
    });
    // RONDE 134: it now corrects, but the classification it corrects UNDER is unchanged.
    expect(mismatchFault("TALKING_HEAD")).toBe("MATERIAL");
    expect(decision.blame).toBe("MATERIAL");
    if (decision.action !== "RESEARCH") return;
    expect(decision.strategy).toBe("ADD_ARCHIVAL_INTENT");
  });

  it("6. an unclassified refusal starts nothing", () => {
    const decision = decideResearch({
      kind: "UNCLEAR",
      ctx: goringBerlinContext(),
      alreadyResearched: false,
    });
    expect(decision.action).toBe("NONE");
    if (decision.action !== "NONE") return;
    expect(decision.reason).toBe("UNCLEAR");
  });

  it("7. at most one extra research pass per beat", () => {
    const ctx = goringBerlinContext();
    const first = decideResearch({ kind: "WRONG_PERIOD", ctx, alreadyResearched: false });
    expect(first.action).toBe("RESEARCH");
    const second = decideResearch({ kind: "WRONG_PERIOD", ctx, alreadyResearched: true });
    expect(second.action).toBe("NONE");
    if (second.action !== "NONE") return;
    expect(second.reason).toBe("ALREADY_RESEARCHED");
  });

  it("8. every corrected query is one the SearchQueryContract minted", () => {
    const ctx = goringBerlinContext();
    const fromContract = new Set(
      selectCorrectedQueries({ ctx, strategy: "MOST_SPECIFIC" }).map((q) => q.toLowerCase())
    );
    for (const kind of ["WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE", "UNRELATED"] as const) {
      const d = decideResearch({ kind, ctx, alreadyResearched: false });
      if (d.action !== "RESEARCH") continue;
      for (const q of d.correctedQueries) {
        expect(fromContract.has(q.toLowerCase())).toBe(true);
      }
    }
  });

  it("9. a word the beat does not prove never reaches a corrected query", () => {
    // The video's TITLE contains "influential" and "choice". Neither is a proven token, so neither
    // can appear — this is RONDE 90's rule, still holding through the correction path.
    const ctx = personOnlyContext();
    for (const kind of ["WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE", "UNRELATED"] as const) {
      const d = decideResearch({ kind, ctx, alreadyResearched: false });
      if (d.action !== "RESEARCH") continue;
      for (const q of d.correctedQueries) {
        expect(q.toLowerCase()).not.toContain("influential");
        expect(q.toLowerCase()).not.toContain("choice");
        expect(q.toLowerCase()).not.toContain("everything");
      }
    }
  });

  it("10. Hermann Göring survives the correction with its Unicode intact", () => {
    const ctx = goringBerlinContext();
    const d = decideResearch({ kind: "WRONG_PERIOD", ctx, alreadyResearched: false });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    // The leading correction names the person, and names them correctly.
    expect(d.correctedQuery).toContain("Hermann Göring");
    // No corrected query anywhere may carry a mangled form of the name — an ASCII fold, a
    // replacement character, or the space RONDE 125's `\b` bug used to leave behind.
    for (const q of d.correctedQueries) {
      expect(q).not.toContain("Goring");
      expect(q).not.toContain("G ring");
      expect(q).not.toContain("�");
    }
    // The ö is one composed character, exactly as the token holds it.
    expect(d.correctedQuery.normalize("NFC")).toBe(d.correctedQuery);
    expect([...d.correctedQuery].includes("ö")).toBe(true);
  });

  it("11. a beat that proves no period is told so instead of being given one", () => {
    const d = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: personOnlyContext(),
      alreadyResearched: false,
    });
    expect(d.action).toBe("NONE");
    if (d.action !== "NONE") return;
    expect(d.reason).toBe("NO_BETTER_QUERY");
  });

  it("12. the SearchGate is still strict — this round switches nothing off", () => {
    expect(process.env.SEARCH_GATE_STRICT).not.toBe("false");
    expect(searchGateStrict()).toBe(true);
  });

  it("13. a query already tried is never handed back as the correction", () => {
    const ctx = goringBerlinContext();
    const all = selectCorrectedQueries({ ctx, strategy: "ADD_TIME" });
    const d = decideResearch({
      kind: "WRONG_PERIOD",
      ctx,
      alreadyResearched: false,
      alreadyUsed: [all[0]!],
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.correctedQuery).not.toBe(all[0]);
  });

  it("14. the tally partitions attempts into accepted and rejected", () => {
    const tally = createResearchTally();
    recordResearchSkip(tally, "MATERIAL");
    recordResearchSkip(tally, "MATERIAL");
    recordResearchAttempt(tally, "ADD_TIME");
    recordResearchOutcome(tally, { produced: true, accepted: true });
    recordResearchAttempt(tally, "ADD_PLACE");
    recordResearchOutcome(tally, { produced: true, accepted: false });
    recordResearchAttempt(tally, "ADD_TIME");
    recordResearchOutcome(tally, { produced: false, accepted: false });

    expect(tally.attempts).toBe(3);
    expect(tally.produced).toBe(2);
    expect(tally.accepted).toBe(1);
    expect(tally.rejected).toBe(1);
    expect(tally.accepted + tally.rejected).toBe(tally.produced);
    expect(tally.byStrategy.get("ADD_TIME")).toBe(2);
    expect(tally.skipped.get("MATERIAL")).toBe(2);

    const summary = formatResearchSummary(tally);
    expect(summary).toContain("attempts=3");
    expect(summary).toContain("accepted=1");
    expect(summary).toContain("2x MATERIAL");
  });

  it("15. the log lines are the ones the round specifies", () => {
    const ctx = goringBerlinContext();
    const d = decideResearch({ kind: "WRONG_PERIOD", ctx, alreadyResearched: false });
    const line = formatResearchDecision("s2b1", d);
    expect(line).toContain("[MismatchResearch]");
    expect(line).toContain("beat=s2b1");
    expect(line).toContain("mismatch=WRONG_PERIOD");
    expect(line).toContain("blame=QUESTION");
    expect(line).toContain("action=RESEARCH");

    // RONDE 134: an unclassified refusal is now the case that starts nothing.
    const none = formatResearchDecision(
      "s2b2",
      decideResearch({ kind: "UNCLEAR", ctx, alreadyResearched: false })
    );
    expect(none).toContain("action=NONE");
    expect(none).toContain("reason=UNCLEAR");
    // And a material fault reports its blame even while it corrects.
    const material = formatResearchDecision(
      "s2b3",
      decideResearch({ kind: "TEXT_ON_SCREEN", ctx, alreadyResearched: false })
    );
    expect(material).toContain("blame=MATERIAL");

    expect(formatResearchQuery("s2b1", "Hermann Göring Berlin", "Hermann Göring Berlin 1945")).toContain(
      'correctedQuery="Hermann Göring Berlin 1945"'
    );
    expect(
      formatResearchOutcome({ beatLabel: "s2b1", newCandidates: 1, gateFits: 1, gateRejected: 0 })
    ).toContain("newCandidates=1 gateFits=1 gateRejected=0");
  });

  it("16. the gate's real wording drives the whole chain end to end", () => {
    // Exactly the two strings judgeBeatImage returns, straight into the classifier and out the
    // other side as a corrected question. No step in between invents anything.
    const kind = classifyMismatch({
      depicts: "a modern city street with parked cars and road markings, filmed in colour",
      reason: "this is present-day footage under narration about Berlin in April 1945",
    });
    expect(kind).toBe("WRONG_PERIOD");
    const d = decideResearch({ kind, ctx: goringBerlinContext(), alreadyResearched: false });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    // A period refusal is answered with the period. "Hermann Göring Berlin" carries no time token
    // and is therefore not a correction for THIS fault, however strong a query it is otherwise.
    expect(d.correctedQuery).toBe("Hermann Göring Berlin 1945");
  });
});

// ─── The pipeline wiring ─────────────────────────────────────────────────────────────────────

describe("RONDE 132 — the research pass is actually wired in", () => {
  const SRC = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("17. the funnel calls decideResearch and runs the corrected queries", () => {
    const src = SRC();
    const idx = src.indexOf("const researchKey = `s${scene.index}b${beat.index}`;");
    expect(idx).toBeGreaterThan(0);
    // RONDE 134 widened this from 4000: the research block gained the scene-context merge and the
    // budget check, which pushed the provider call past the old edge. No assertion changed.
    const block = src.slice(idx, idx + 5600);
    expect(block).toContain("decideResearch({");
    expect(block).toContain("kind: lastMismatchKind");
    // RONDE 134 widened the context to beat + scene; beatSearchProvenance is still what builds
    // both halves of it.
    expect(block).toContain("ctx: researchCtx");
    expect(block).toContain("beatSearchProvenance(beat, scene)");
    expect(block).toContain("fetchHistoricalBeatVideo(");
    expect(block).toContain("leadQueries: decision.correctedQueries");
    expect(block).toContain("researchPass: true");
  });

  it("18. the one-pass limit is claimed BEFORE the search, not after", () => {
    const src = SRC();
    const idx = src.indexOf("const researchKey = `s${scene.index}b${beat.index}`;");
    const block = src.slice(idx, idx + 5600);
    const claim = block.indexOf("dedup.mismatchResearchedBeats.add(researchKey);");
    const search = block.indexOf("fetchHistoricalBeatVideo(");
    expect(claim).toBeGreaterThan(0);
    expect(search).toBeGreaterThan(0);
    // A throw or a timeout inside the search must not leave the beat eligible again.
    expect(claim).toBeLessThan(search);
  });

  it("19. the corrected queries lead inside the SAME provider cap", () => {
    const src = SRC();
    const idx = src.indexOf("const allQueries = uniqueQueryStrings([...(opts.leadQueries ?? [])");
    expect(idx).toBeGreaterThan(0);
    // Still sliced to queryCap — the research pass redirects provider calls, it does not add them.
    expect(src.slice(idx, idx + 260)).toContain("queryCap");
  });

  it("20. YouTube is a tier the corrected query genuinely reaches", () => {
    const src = SRC();
    // The cascade the research pass calls has youtube_cc in its tier order, and `allQueries` —
    // which the corrected queries now lead — is what every tier is asked with.
    expect(src).toContain('"youtube_cc",');
    const tierIdx = src.indexOf("export const HISTORICAL_SOURCE_TIER_ORDER");
    const tiers = src.slice(tierIdx, tierIdx + 400);
    expect(tiers).toContain("youtube_cc");
    const fetchIdx = src.indexOf("const fetchTierPaths = async (tier: HistoricalSourceTier, q: string)");
    expect(fetchIdx).toBeGreaterThan(0);
    expect(src.slice(fetchIdx, fetchIdx + 1400)).toContain("fetchYouTubeCCClips(");
  });

  it("21. the license flow is untouched by this round", () => {
    const src = readFileSync(join(__dirname, "youtubeLicenseStatus.ts"), "utf8");
    expect(src).toContain('export type LicenseStatus = "VERIFIED" | "UNVERIFIED" | "REJECTED"');
    expect(src).toContain("ALLOW_UNVERIFIED_YOUTUBE");
    // A REJECTED license must still be a refusal no flag can turn into an allow.
    expect(src).toMatch(/REJECTED/);
  });

  it("22. the existing sourcing cache and search memory are what the pass uses", () => {
    const src = SRC();
    const idx = src.indexOf("const fetchTierPaths = async (tier: HistoricalSourceTier, q: string)");
    const block = src.slice(idx, idx + 2600);
    // Every tier is handed the render's own cache — the research pass inherits it rather than
    // opening a second one.
    expect(block).toContain("dedup.sourcingCache");
    expect(block).toContain("dedup.usedContentKeys");
    // And adoption still writes to the existing memory.
    expect(src).toContain("recordAdoptedClipSource");
  });
});

// ─── ClosingTail, against real files ─────────────────────────────────────────────────────────

describe("RONDE 132 — the closing tail lands inside the file", () => {
  let dir = "";
  /** A composed-scene shape: the audio outlives the picture, exactly as production's does. */
  let scenePath = "";
  let formatDur = 0;
  let streamDur = 0;
  let lastFramePts = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "r132-"));
    scenePath = join(dir, "scene.mp4");
    execFileSync(
      FFMPEG,
      [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=21.2",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-t", "21.40",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", scenePath,
      ],
      { timeout: 120_000 }
    );
    formatDur = Number(
      ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", scenePath])
    );
    streamDur = Number(
      ffprobe([
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration",
        "-of", "default=nw=1:nk=1", scenePath,
      ])
    );
    const times = ffprobe([
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
      "-of", "csv=p=0", scenePath,
    ])
      .split("\n")
      .map((l) => Number.parseFloat(l))
      .filter((n) => Number.isFinite(n));
    lastFramePts = Math.max(...times);
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("23. the production shape is reproduced: the container outlives the picture", () => {
    expect(formatDur).toBeGreaterThan(streamDur);
    expect(lastFramePts).toBeLessThan(streamDur);
    // This is the gap RONDE 121's fixed 0.1s could not cover.
    expect(formatDur - lastFramePts).toBeGreaterThan(0.1);
  });

  it("24. RONDE 121's seek was past the last frame — the bug, stated as a number", () => {
    const oldSeek = formatDur - 0.1;
    expect(oldSeek).toBeGreaterThan(lastFramePts);
    expect(closingTailSeekIsSafe(oldSeek, lastFramePts)).toBe(false);
  });

  it("25. the new seek is inside the valid frame range", () => {
    const seek = closingTailFrameSeek({
      containerDurationSec: formatDur,
      videoStreamDurationSec: streamDur,
      fps: 25,
    });
    expect(seek.basis).toBe("video_stream");
    expect(closingTailSeekIsSafe(seek.seekSec, lastFramePts)).toBe(true);
    expect(seek.seekSec).toBeLessThanOrEqual(lastFramePts);
    // And it is a window, not a pinpoint: there is room for several frames inside it.
    expect(streamDur - seek.seekSec).toBeGreaterThanOrEqual(CLOSING_TAIL_FRAME_WINDOW_SEC - 1e-9);
  });

  it("26. it is still inside the range when only the container duration is known", () => {
    const seek = closingTailFrameSeek({ containerDurationSec: formatDur, fps: 25 });
    expect(seek.basis).toBe("container");
    expect(closingTailSeekIsSafe(seek.seekSec, lastFramePts)).toBe(true);
  });

  it("27. a video duration longer than the container is not believed", () => {
    const seek = closingTailFrameSeek({
      containerDurationSec: 10,
      videoStreamDurationSec: 400,
      fps: 25,
    });
    expect(seek.basis).toBe("container");
    expect(seek.effectiveDurationSec).toBe(10);
  });

  it("28. buildClosingTail now produces a real tail on the file that used to defeat it", async () => {
    const framePath = join(dir, "tailframe.jpg");
    const outPath = join(dir, "tail.mp4");
    const built = await buildClosingTail({
      lastScenePath: scenePath,
      outputPath: outPath,
      framePath,
      ffmpegBin: FFMPEG,
      run: async (cmd) => {
        execFileSync("/bin/sh", ["-c", cmd], { timeout: 120_000, stdio: "pipe" });
      },
      lastSceneDurationSec: formatDur,
      lastSceneVideoDurationSec: streamDur,
      tailSec: 3,
      widthPx: 320,
      heightPx: 180,
      fileExists: (p) => {
        try { return existsSync(p) && statSync(p).size > 1000; } catch { return false; }
      },
    });
    expect(built).not.toBeNull();
    expect(existsSync(framePath)).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    const tailDur = Number(
      ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outPath])
    );
    expect(tailDur).toBeGreaterThan(2.8);
    expect(tailDur).toBeLessThan(3.4);
  }, 180_000);

  it("29. the grabbed frame is the LAST frame, not a black one past the end", async () => {
    const framePath = join(dir, "checkframe.jpg");
    const expectedPath = join(dir, "expected.jpg");
    const seek = closingTailFrameSeek({
      containerDurationSec: formatDur,
      videoStreamDurationSec: streamDur,
      fps: 25,
    });
    execFileSync(FFMPEG, [
      "-y", "-v", "error", "-ss", seek.seekSec.toFixed(3), "-i", scenePath,
      "-q:v", "2", "-update", "1", framePath,
    ], { timeout: 60_000 });
    execFileSync(FFMPEG, [
      "-y", "-v", "error", "-ss", lastFramePts.toFixed(3), "-i", scenePath,
      "-frames:v", "1", "-q:v", "2", expectedPath,
    ], { timeout: 60_000 });
    // Byte-identical: the window grab lands on exactly the frame an explicit grab of the last
    // timestamp produces. That is what "inside the valid frame range" means in practice.
    expect(readFileSync(framePath).equals(readFileSync(expectedPath))).toBe(true);

    // And it is a picture, not a black card. testsrc2's last frame is far from black.
    const luma = ffprobe([
      "-v", "error", "-f", "lavfi",
      "-i", `movie=${framePath},signalstats`,
      "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
      "-of", "default=nw=1:nk=1",
    ]);
    expect(Number.parseFloat(luma)).toBeGreaterThan(16);
  }, 180_000);

  it("30. the tail moves — it is not a three-second freeze", async () => {
    const outPath = join(dir, "tail.mp4");
    expect(existsSync(outPath)).toBe(true);
    const report = await auditVideoStillness({ videoPath: outPath, maxSampleFps: 8, timeoutMs: 120_000 });
    // RONDE 130's instrument, on RONDE 121's segment. A linear push must never read as a hold.
    expect(report.visualChanges).toBeGreaterThan(0);
    const verdict = checkStillnessLimit(report, stillImageMaxSec());
    expect(verdict.ok).toBe(true);
    expect(report.longestStillSec).toBeLessThanOrEqual(stillImageMaxSec() + 0.25);
  }, 240_000);

  it("31. the 5-second still limit is unchanged by this round", () => {
    expect(stillImageMaxSec()).toBe(5);
  });
});

// ─── Mutations ───────────────────────────────────────────────────────────────────────────────

describe("RONDE 132 — mutation guards", () => {
  const SRC = () => readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("M1. removing the research call breaks the wiring assertion", () => {
    const src = SRC();
    const idx = src.indexOf("const researchKey = `s${scene.index}b${beat.index}`;");
    const block = src.slice(idx, idx + 5600);
    expect(block).toContain("await withSceneFetchTimeout(");
    expect(block).toContain("fetchHistoricalBeatVideo(");
  });

  it("M2. removing WRONG_PERIOD's trigger leaves it with no strategy", () => {
    expect(correctionStrategyFor("WRONG_PERIOD")).toBe("ADD_TIME");
    const d = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: goringBerlinContext(),
      alreadyResearched: false,
    });
    expect(d.action).toBe("RESEARCH");
  });

  it("M3. the corrected query must be handed to the provider cascade", () => {
    const src = SRC();
    const idx = src.indexOf("const allQueries = uniqueQueryStrings([...(opts.leadQueries ?? [])");
    expect(idx).toBeGreaterThan(0);
    const wiring = src.indexOf("leadQueries: decision.correctedQueries");
    expect(wiring).toBeGreaterThan(0);
  });

  it("M4. the contract is the only source of a corrected query", () => {
    const src = readFileSync(join(__dirname, "mismatchResearch.ts"), "utf8");
    // Selected from buildPrioritisedQueries, never assembled here. `originalQuery + reason` is
    // precisely the shortcut this round forbids.
    expect(src).toContain("buildPrioritisedQueries(params.ctx)");
    // correctedQuery is assigned in exactly one place, from the selected list, and nowhere is a
    // query built by interpolation or concatenation.
    const assignments = [...src.matchAll(/correctedQuery:\s*([^,\n]+)/g)]
      .map((m) => m[1]!.trim())
      // The type declarations in ClosingTail-style unions say `correctedQuery: string;`.
      .filter((v) => v !== "string" && v !== "string;");
    expect(assignments).toEqual(["queries[0]!"]);
    expect(src).not.toMatch(/correctedQuery[^\n]*[`+]\s*(depicts|reason)/);

    // And the same property proved by behaviour, not only by reading: the gate's reason text
    // contributes no word to the query it produces.
    const kind = classifyMismatch({
      depicts: "a modern street in colour",
      reason: "present-day footage, wrong century, unrelated protest banners",
    });
    const d = decideResearch({ kind, ctx: goringBerlinContext(), alreadyResearched: false });
    if (d.action === "RESEARCH") {
      for (const w of ["present", "century", "protest", "banners", "unrelated", "colour"]) {
        expect(d.correctedQuery.toLowerCase()).not.toContain(w);
      }
    }
  });

  it("M5. the closing-tail seek guard exists and is asserted against a real frame time", () => {
    const src = readFileSync(join(__dirname, "closingTail.ts"), "utf8");
    expect(src).toContain("export function closingTailSeekIsSafe");
    expect(src).toContain("export function closingTailFrameSeek");
    // The fixed subtraction that caused the bug is gone from the build path.
    expect(src).not.toContain("params.lastSceneDurationSec - 0.1");
    expect(src).toContain("-update 1");
  });
});
