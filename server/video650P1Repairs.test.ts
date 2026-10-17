/**
 * VIDEO 650 — the P1/P2 repairs: decodability, next-binary-only-when-it-cannot-run, the black check
 * two-of-three, the approved mark released on a technical refusal, the no-frame memory, sentence
 * timing measured from the scene audio's pauses, the single writer per cut, the render-job heartbeat
 * and stale sweep, and the observability lines.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { technicalMediaRefusal } from "./technicalMediaGate";
import { binaryCannotRun, refusalHoldsForEverySentence, releaseApprovedPickForBeat, noteApprovedKeyForBeat, approvedPicksForBeat, pictureApprovedForBeat } from "./videoPipeline";
import { clipKnownToGiveNoFrame, noteClipGaveNoFrame, resetNoFrameMemoryForTests } from "./beatVisualRelevance";
import { measureSentenceWindows, parseSilences, sentenceWindowsFromSilences } from "./voiceTimingFromSilence";
import { extractVideoSegment, segmentWriteTempPath } from "./archiveVideoSplitter";
import { RENDER_JOB_HEARTBEAT_MS, renderJobStaleMs, staleRunningRenderJobIds } from "./renderJobs";
import { sentenceCoverage } from "./sentenceCoverage";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
let dir = "";
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-650-p1-")); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("P1-F — a declared stream is not a decodable one", () => {
  const base = { isValidVideo: async () => true, isPipelineFallback: () => false, isMostlyBlack: async () => false };
  it("the gate refuses a file that decodes no frame as not_decodable, for every sentence; an unmeasurable probe refuses nothing", async () => {
    expect(await technicalMediaRefusal("/x.mp4", { ...base, decodesAFrame: async () => false })).toBe("not_decodable");
    expect(await technicalMediaRefusal("/x.mp4", { ...base, decodesAFrame: async () => null })).toBeNull();
    expect(await technicalMediaRefusal("/x.mp4", { ...base, decodesAFrame: async () => true })).toBeNull();
    expect(await technicalMediaRefusal("/x.mp4", base)).toBeNull();
    expect(refusalHoldsForEverySentence("not_decodable")).toBe(true);
    expect(refusalHoldsForEverySentence("not_a_valid_video")).toBe(true);
    expect(PIPE).toContain("decodesAFrame: (f) => clipDecodesAFrame(f),");
  });

  it("a clip that gave no frame is remembered until the file changes", () => {
    resetNoFrameMemoryForTests();
    const f = path.join(dir, "noframe.bin");
    fs.writeFileSync(f, Buffer.alloc(2000, 1));
    expect(clipKnownToGiveNoFrame(f)).toBe(false);
    noteClipGaveNoFrame(f);
    expect(clipKnownToGiveNoFrame(f)).toBe(true);
    fs.writeFileSync(f, Buffer.alloc(3000, 2)); // re-downloaded: different bytes
    expect(clipKnownToGiveNoFrame(f)).toBe(false);
    resetNoFrameMemoryForTests();
  });

  it("two requests for the same cut share one writer; the cut lands atomically and no temporary file is left", async () => {
    const src = path.join(dir, "src.mp4");
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    const outFile = path.join(dir, "cut.mp4");
    expect(segmentWriteTempPath(outFile)).toMatch(/cut\.part-\d+-[a-z0-9]+\.mp4$/);
    await Promise.all([extractVideoSegment(src, outFile, 0.5, 3.5), extractVideoSegment(src, outFile, 0.5, 3.5)]);
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.statSync(outFile).size).toBeGreaterThan(5_000);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".part-"))).toEqual([]);
  }, 120_000);
});

describe("P1-I — the next binary only when this one cannot run", () => {
  it("ENOENT/EACCES/ENOEXEC move on; an exit code, a timeout or an abort are the answer", () => {
    expect(binaryCannotRun(Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }))).toBe(true);
    expect(binaryCannotRun(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(true);
    expect(binaryCannotRun(new Error("spawn /usr/bin/ffprobe ENOENT"))).toBe(true);
    expect(binaryCannotRun(Object.assign(new Error("Command failed: ffprobe … Invalid data found when processing input"), { code: 1 }))).toBe(false);
    expect(binaryCannotRun(new Error("execFileRaw timeout after 8000ms: ffprobe"))).toBe(false);
    expect(binaryCannotRun(new Error("[SceneFetchScope] Aborted"))).toBe(false);
    /** every probe loop asks the question */
    expect((PIPE.match(/binaryCannotRun\(err\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

describe("P1-G — the black check and the approved mark", () => {
  it("Railway: three luma samples, dark when two are (pinned), never one frame deciding", () => {
    const at = PIPE.indexOf("async function isMostlyBlackClip(");
    const body = PIPE.slice(at, at + 3400); // VIDEO 663 — the flat-band crop sits before the samples
    expect(body).toContain("THREE single-frame luma samples");
    expect(body).toContain("return samples.length === 1 ? dark === 1 : dark >= 2;");
    expect(body).not.toContain("const mid = await probeClipMeanLuma(filePath, 0.5);\n    return mid !== null && mid < 24;");
  });

  it("an approved picture the technical check refused is released: the count drops, the key is gone, the fill no longer waits", () => {
    const dedup = {};
    noteApprovedKeyForBeat(dedup, 1, 2, "youtube_cc:abc");
    expect(approvedPicksForBeat(dedup, 1, 2)).toBe(1);
    expect(pictureApprovedForBeat(dedup, 1, 2, "youtube_cc:abc")).toBe(true);
    expect(releaseApprovedPickForBeat(dedup, 1, 2, "youtube_cc:abc", "technical check: not_decodable")).toBe(true);
    expect(approvedPicksForBeat(dedup, 1, 2)).toBe(0);
    expect(pictureApprovedForBeat(dedup, 1, 2, "youtube_cc:abc")).toBe(false);
    expect(releaseApprovedPickForBeat(dedup, 1, 2, "youtube_cc:abc", "again")).toBe(false);
    expect((PIPE.match(/releaseApprovedPickForBeat\(dedup, sceneIndex, beat\.index, clipContentKey\([cv]\), `technical check: \$\{refusal\}`\)/g) ?? []).length).toBe(2);
  });
});

describe("P1-H — sentence windows measured from the scene audio's pauses", () => {
  it("parses silencedetect, cuts at the N−1 longest pauses, measures one sentence as the file, refuses what the text contradicts", () => {
    const stderr = "[silencedetect] silence_start: 1.20\n[silencedetect] silence_end: 1.62 | silence_duration: 0.42\n[silencedetect] silence_start: 3.10\n[silencedetect] silence_end: 3.60\n[silencedetect] silence_start: 3.90\n[silencedetect] silence_end: 4.15\n";
    const silences = parseSilences(stderr, 5.0);
    expect(silences).toEqual([{ startSec: 1.2, endSec: 1.62 }, { startSec: 3.1, endSec: 3.6 }, { startSec: 3.9, endSec: 4.15 }]);
    const three = sentenceWindowsFromSilences([{ text: "The first sentence is spoken here." }, { text: "Then a second sentence of similar length." }, { text: "And a shorter third." }], silences, 5.0);
    expect(three).toMatchObject({ ok: true, pausesFound: 3, pausesUsed: 2 });
    if (three.ok) expect(three.windows).toEqual([{ startSec: 0, endSec: 1.41 }, { startSec: 1.41, endSec: 3.35 }, { startSec: 3.35, endSec: 5 }]);
    const one = sentenceWindowsFromSilences([{ text: "Only one." }], [], 4.2);
    expect(one).toMatchObject({ ok: true, windows: [{ startSec: 0, endSec: 4.2 }] });
    expect(sentenceWindowsFromSilences([{ text: "a" }, { text: "b" }, { text: "c" }], [silences[0]!], 5)).toMatchObject({ ok: false, reason: "3 sentences need 2 pauses; 1 measured" });
    /** a cut that gives a long sentence a sliver is refused: the text contradicts the pauses */
    const contradiction = sentenceWindowsFromSilences([{ text: "A" }, { text: "This is a very long sentence that keeps going on and on with many many words in it indeed." }], [{ startSec: 4.5, endSec: 4.8 }], 5.0);
    expect(contradiction.ok).toBe(false);
    expect(sentenceWindowsFromSilences([{ text: "x" }], [], 0)).toMatchObject({ ok: false });
  });

  it("with real ffmpeg: three spoken bursts with two pauses give three measured windows", async () => {
    const wav = path.join(dir, "speech.wav");
    await run(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-filter_complex",
      "sine=f=440:d=1.2[a];anullsrc=r=44100:cl=mono:d=0.45[s1];sine=f=440:d=1.5[b];anullsrc=r=44100:cl=mono:d=0.5[s2];sine=f=440:d=0.9[c];[a][s1][b][s2][c]concat=n=5:v=0:a=1[out]",
      "-map", "[out]", wav,
    ]);
    const total = 1.2 + 0.45 + 1.5 + 0.5 + 0.9;
    const r = await measureSentenceWindows(FFMPEG, wav, total, [{ text: "First sentence here." }, { text: "The second one is a bit longer." }, { text: "Third, short." }]);
    expect(r).toMatchObject({ ok: true, pausesUsed: 2 });
    if (!r.ok) return;
    expect(r.windows[0]!.startSec).toBe(0);
    expect(r.windows[0]!.endSec).toBeGreaterThan(1.2);
    expect(r.windows[0]!.endSec).toBeLessThan(1.7);
    expect(r.windows[1]!.endSec).toBeGreaterThan(3.1);
    expect(r.windows[1]!.endSec).toBeLessThan(3.7);
    expect(r.windows[2]!.endSec).toBeCloseTo(total, 1);
  }, 60_000);

  it("the basis is recorded as measured_silence: the coverage check counts it as cover but calls the timing APPROXIMATE, never proven; the pipeline writes it only without word timing", () => {
    const t = emptyTimeline(650);
    t.durationSec = 4;
    videoTrack(t).push({ id: "a", kind: "video", source: { provider: "youtube_cc", providerAssetId: "a", archiveAssetId: 1, contentApproval: "judge_fit" }, sourceIn: 0, sourceOut: 4, timelineStart: 0, timelineEnd: 4, motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset", sceneIndex: 0, beatIndex: 0 } as TimelineVideoClip);
    t.sentences = [{ sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 4, timingBasis: "measured_silence", text: "x" }];
    const r = sentenceCoverage(t as ProjectTimeline);
    expect(r.sentences[0]).toMatchObject({ status: "covered", timingBasis: "measured_silence" });
    /** PRE-DEPLOY — approximate: the window was cut at a pause, not at a word timestamp */
    expect(r.proven).toBe(false);
    expect(r.timing).toBe("approximate");
    expect(r.problems.some((p) => p.includes("measured from pauses") && p.includes("approximate"))).toBe(true);
    const exact = sentenceCoverage({ ...t, sentences: [{ ...t.sentences[0]!, timingBasis: "measured" }] } as ProjectTimeline);
    expect(exact).toMatchObject({ proven: true, timing: "exact" });
    const est = sentenceCoverage({ ...t, sentences: [{ ...t.sentences[0]!, timingBasis: "estimated" }] } as ProjectTimeline);
    expect(est.sentences[0]!.status).toBe("unknown");
    expect(est.timing).toBe("unproven");
    expect(PIPE).toContain("if (!sceneAudioPath || beats.length === 0 || beats.some((b) => b.voiceStartSec != null)) return;");
    expect(PIPE).toContain("b.voiceTimingSource = \"silence\";");
    expect(fs.readFileSync(path.join(__dirname, "cinematicPipelineInputs.ts"), "utf8")).toContain('(beat.voiceTimingSource === "silence" ? "measured_silence" : "measured")');
  });
});

describe("P1-J — the render job's heartbeat and the stale sweep", () => {
  it("stale: running, no heartbeat for the threshold; queued and fresh rows are left alone; the threshold is at least 3 min", () => {
    const now = Date.parse("2026-10-13T10:00:00Z");
    const rows = [
      { id: 1, status: "running", updatedAt: new Date(now - 20 * 60_000) },
      { id: 2, status: "running", updatedAt: new Date(now - 2 * 60_000) },
      { id: 3, status: "queued", updatedAt: new Date(now - 60 * 60_000) },
      { id: 4, status: "running", updatedAt: null },
      { id: 5, status: "running", updatedAt: new Date(now - 15 * 60_000).toISOString() },
    ];
    expect(staleRunningRenderJobIds(rows, now, 15 * 60_000)).toEqual([1, 5]);
    expect(renderJobStaleMs({})).toBe(15 * 60_000);
    expect(renderJobStaleMs({ RENDER_JOB_STALE_MIN: "40" })).toBe(40 * 60_000);
    expect(renderJobStaleMs({ RENDER_JOB_STALE_MIN: "1" })).toBe(15 * 60_000);
    expect(RENDER_JOB_HEARTBEAT_MS).toBe(60_000);
  });

  it("the worker writes the heartbeat while it holds the job, clears it in finally, and sweeps at start and every two minutes; the db guards status and age inside the UPDATE", () => {
    expect(WORKER).toContain("void touchRunningRenderJob(job.id).catch(() => undefined);");
    expect(WORKER).toContain("}, RENDER_JOB_HEARTBEAT_MS);");
    expect(WORKER).toContain("  } finally {\n    clearInterval(heartbeat);");
    expect(WORKER).toContain("void sweepStaleRenderJobs().then(() => processRenderJobTick());");
    /** G/H — the same two-minute sweep, now followed by the render-recovery sweep (`recoveryCoordinator.ts`). */
    expect(WORKER).toContain("const sweep = setInterval(() => void sweepStaleRenderJobs().then(() => sweepRenderRecoveries()), 2 * 60_000);");
    expect(DB).toContain('.where(and(eq(renderJobs.id, row.id), eq(renderJobs.status, "running"), sql`${renderJobs.updatedAt} < ${cutoff}`));');
    expect(DB).toContain(".set({ updatedAt: new Date() })");
  });
});

describe("P2-K — the lines a log reader needs", () => {
  it("the final file line, the Freesound status, the beat label by the beat's own index", () => {
    expect(WORKER).toContain("FINAL_FILE ${check.widthPx ?? \"?\"}x${check.heightPx ?? \"?\"}");
    expect(fs.readFileSync(path.join(__dirname, "cinematicAudio", "fetcher.ts"), "utf8")).toContain("preview lookup answered HTTP ${resp.status}");
    expect(PIPE).toContain("`scene ${scene.index} beat ${beat.index} visuals`");
    expect(PIPE).not.toContain("`scene ${scene.index} beat ${bi} visuals`");
  });
});
