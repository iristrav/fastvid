/**
 * RONDE 235 — WHAT RENDER 576 WAS UNABLE TO SAY ABOUT ITSELF.
 *
 * Render 576 is the first delivered film a human reviewer called good. It also shipped twenty-seven
 * decibels under the streaming loudness target, and the line explaining why said this and only this:
 *
 *     [Loudness] target=-14 LUFS measured=-41.4 LUFS after=unknown outcome=failed —
 *     the correction pass failed: Command failed: "/usr/bin/ffmpeg" -nostdin -hide_banner -y
 *     -i "/var/tmp/fastvid_576_.../covered_the_assembled_film_....mp4" -map 0:v:0 -map
 *
 * It stops mid-flag, because the reason kept the first 160 characters of a message whose first
 * ~250 characters are the command line the reader already has. ffmpeg's own diagnosis — the part
 * after the command — could never fit. The same round's other two findings have the same shape:
 * a preflight that reports a capability as present when only its fallback is present, and a
 * download ceiling spent twice over on the same ten videos because nothing remembered the first
 * refusal.
 *
 * None of these are decisions the pipeline got wrong. They are answers it threw away.
 *
 * WHAT IS DELIBERATELY NOT HERE: the 20.88s unchanging picture. Its root cause is narrowed in this
 * round (every HOLD route is capped and demonstrably fired — five extendLastClip refusals, zero
 * allowed extensions, no tail-pad line) but not proven to a writer, and this round forbids a fix
 * ahead of its proof. Asserting a fix that does not exist would be the worse failure.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LOUDNESS_TOLERANCE_LU,
  TARGET_LUFS,
  describeFfmpegFailure,
  isOnTarget,
  loudnormChain,
  normaliseDeliveredLoudness,
  parseLoudnormJson,
} from "./audioLoudness";
import { CAPABILITIES } from "./productionPreflight";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const LOUD = fs.readFileSync(path.join(__dirname, "audioLoudness.ts"), "utf8");
const FAIL = fs.readFileSync(path.join(__dirname, "providerFailureClass.ts"), "utf8");

/* ═══════════ 1. the failure reason carries ffmpeg's answer, not the question ═══════════ */

describe("R235 §1 — a correction that failed says why", () => {
  /** The shape Node's `exec` rejects with: the echoed command, then the child's stderr. */
  const execError = (stderr: string, code = 1) =>
    Object.assign(new Error(`Command failed: "/usr/bin/ffmpeg" -nostdin -hide_banner -y -i "/var/tmp/x.mp4" -map 0:v:0 -map 0:a:0 -c:v copy -af "loudnorm=..." -c:a aac -b:a 320k -movflags +faststart "/var/tmp/x.mp4.loudnorm.mp4"\n${stderr}`), {
      stderr,
      code,
    });

  it("RENDER 576's REASON WOULD NOW NAME THE FAULT — the old slice could not reach it", () => {
    const err = execError(
      "[out#0/mp4 @ 0x55] Error opening output file /var/tmp/x.mp4.loudnorm.mp4.\n" +
        "Error opening output files: No space left on device"
    );
    const said = describeFfmpegFailure(err);
    expect(said, "the reason still cannot name the fault").toContain("No space left on device");
    /** And the old behaviour is genuinely gone: the head of the command is not the answer. */
    expect((err.message ?? "").slice(0, 160)).not.toContain("No space left on device");
  });

  it("THE EXIT STATUS TRAVELS WITH IT", () => {
    expect(describeFfmpegFailure(execError("Conversion failed!", 187))).toContain("exit 187");
  });

  it("A KILLED CHILD IS NOT REPORTED AS AN EXIT CODE — a timeout and a crash differ", () => {
    const killed = Object.assign(new Error("Command failed: ffmpeg ..."), {
      stderr: "",
      signal: "SIGTERM",
    });
    expect(describeFfmpegFailure(killed)).toContain("killed by SIGTERM");
  });

  it("THE TAIL SURVIVES, NOT THE HEAD — ffmpeg puts its complaint last", () => {
    const noisy =
      Array.from({ length: 200 }, (_, i) => `  Stream #0:${i}: irrelevant banner line`).join("\n") +
      "\nInvalid argument";
    const said = describeFfmpegFailure(execError(noisy));
    expect(said).toContain("Invalid argument");
    expect(said, "the banner crowded out the error").not.toContain("Stream #0:0");
  });

  it("PROGRESS COUNTERS ARE NOT MISTAKEN FOR A DIAGNOSIS", () => {
    const err = execError("frame= 300 fps=25 q=-1.0 size=  188kB\nsize=  188kB time=00:00:12\nmuxer does not support non seekable output");
    const said = describeFfmpegFailure(err);
    expect(said).toContain("muxer does not support non seekable output");
    expect(said).not.toContain("fps=25");
  });

  it("A CHILD THAT PRINTED NOTHING SAYS SO, rather than producing an empty reason", () => {
    const said = describeFfmpegFailure(Object.assign(new Error("Command failed: ffmpeg x"), { stderr: "  \n \n", code: 1 }));
    expect(said).toContain("ffmpeg printed nothing");
  });

  it("IT NEVER THROWS ON A SHAPE IT DID NOT EXPECT — this runs inside a failure path", () => {
    for (const junk of [undefined, null, {}, "a string", 42, new Error("bare")]) {
      expect(() => describeFfmpegFailure(junk)).not.toThrow();
      expect(typeof describeFfmpegFailure(junk)).toBe("string");
    }
  });

  it("the 160-character slice that produced render 576's line is gone from the correction path", () => {
    const at = LOUD.indexOf("const runCorrection = async (");
    expect(at).toBeGreaterThan(0);
    const block = LOUD.slice(at, LOUD.indexOf("const firstFailure", at));
    expect(block).toContain("describeFfmpegFailure(err)");
    expect(block).not.toContain("slice(0, 160)");
  });
});

/* ═══════════ 2. a failed correction is not the last word — but it cannot lower the bar ═══════════ */

describe("R235 §2 — the second attempt asks for less, never for worse", () => {
  it("THE RETRY DROPS ONLY +faststart — the correction itself is unchanged", () => {
    const at = LOUD.indexOf("const runCorrection = async (");
    const block = LOUD.slice(at, LOUD.indexOf("const firstFailure", at));
    /** One invocation, one flag decided by the parameter. Two commands would be two behaviours. */
    expect(block).toContain('${faststart ? "-movflags +faststart " : ""}');
    /** The measured chain, the target bitrate and the stream mapping are the same in both runs. */
    expect(block).toContain('-map 0:v:0 -map 0:a:0 -c:v copy -af "${chain}"');
    expect(block).toContain("-c:a aac -b:a 320k");
  });

  it("IT IS ATTEMPTED EXACTLY TWICE — a retry loop would be a new failure mode", () => {
    expect((LOUD.match(/runCorrection\((?:true|false)\)/g) ?? []).length).toBe(2);
    expect(LOUD).toContain("await runCorrection(true)");
    expect(LOUD).toContain("await runCorrection(false)");
  });

  it("BOTH ATTEMPTS' OUTPUT STILL GOES THROUGH THE SAME MEASURE-AND-COMPARE", () => {
    /**
     * The retry must not become a way to ship an unverified file. There is still exactly one
     * `improved` test and one rename, downstream of both attempts.
     */
    expect((LOUD.match(/const improved =/g) ?? []).length).toBe(1);
    expect((LOUD.match(/fs\.renameSync\(tmpPath, filePath\)/g) ?? []).length).toBe(1);
    const improvedAt = LOUD.indexOf("const improved =");
    expect(improvedAt).toBeGreaterThan(LOUD.indexOf("const firstFailure"));
  });

  it("A FAILURE OF BOTH ATTEMPTS REPORTS BOTH REASONS", () => {
    const at = LOUD.indexOf("if (secondFailure) {");
    const block = LOUD.slice(at, at + 500);
    expect(block).toContain("with faststart: ${firstFailure}");
    expect(block).toContain("without faststart: ${secondFailure}");
    expect(block).toContain('outcome: "failed"');
  });

  it("A RETRY THAT WORKED IS ANNOUNCED — a silent recovery hides a real environment fault", () => {
    expect(LOUD).toContain("the first correction attempt failed");
    expect(LOUD).toContain("the retry without +faststart produced a file");
  });

  it("THE TARGETS ARE UNTOUCHED — this round changed no threshold", () => {
    expect(TARGET_LUFS).toBe(-14);
    expect(LOUDNESS_TOLERANCE_LU).toBe(1.0);
    expect(LOUD).toContain("export const TRUE_PEAK_DBTP = -1.5;");
  });

  it("and the safety rules RONDE 222 wrote are all still in force", () => {
    expect(isOnTarget(-14.5)).toBe(true);
    expect(isOnTarget(-41.4)).toBe(false);
    expect(isOnTarget(null)).toBe(false);
    /** A measurement that cannot be read still computes no correction. */
    expect(loudnormChain({ integratedLufs: null, truePeakDb: -2, lra: 3, thresholdLufs: -25 })).toBeNull();
    /** `-inf` on a silent file is still not turned into an infinite gain. */
    const silent = parseLoudnormJson('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-inf"}');
    expect(silent?.integratedLufs).toBeNull();
  });
});

/* ═══════════ 3. the pass still refuses to touch what it cannot verify ═══════════ */

describe("R235 §3 — the outcomes that must not have changed", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r235-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("A FILE WITH NO AUDIO IS LEFT ALONE, and no ffmpeg runs", async () => {
    const p = path.join(dir, "silent.mp4");
    fs.writeFileSync(p, "not really a video");
    const r = await normaliseDeliveredLoudness(p, { hasAudio: false });
    expect(r.outcome).toBe("no_audio");
    expect(fs.readFileSync(p, "utf8"), "a file with no audio was rewritten").toBe("not really a video");
  });

  it("A FILE THAT IS NOT THERE IS A FAILURE, NOT A CRASH", async () => {
    const r = await normaliseDeliveredLoudness(path.join(dir, "gone.mp4"));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toContain("does not exist");
  });

  it("AN UNMEASURABLE FILE IS NEVER RE-ENCODED ON A GUESS", async () => {
    const p = path.join(dir, "junk.mp4");
    fs.writeFileSync(p, "0000");
    const before = fs.statSync(p).mtimeMs;
    const r = await normaliseDeliveredLoudness(p);
    expect(r.outcome).toBe("not_measurable");
    expect(fs.statSync(p).mtimeMs, "an unmeasurable file was rewritten anyway").toBe(before);
  });
});

/* ═══════════ 4. the preflight can tell the primary route from its fallback ═══════════ */

describe("R235 §4 — 'a route is configured' is not 'the route is configured'", () => {
  const byId = (id: string) => CAPABILITIES.find((c) => c.id === id);

  it("THE PRIMARY YOUTUBE ROUTE HAS ITS OWN CAPABILITY", () => {
    const primary = byId("youtube_download_primary");
    expect(primary, "render 576's cloudService=MISSING is invisible again").toBeDefined();
    expect(primary!.requires).toEqual(["YOUTUBE_CC_DL_SERVICE"]);
  });

  it("IT IS A `requires`, NOT A `requiresAny` — that is the whole distinction", () => {
    const primary = byId("youtube_download_primary")!;
    /**
     * `requiresAny: [CLOUD, RAPIDAPI]` is exactly what could not see this: RAPIDAPI_KEY alone
     * satisfied it, which is the production state that fetched nothing.
     */
    expect(primary.requiresAny ?? []).toEqual([]);
    expect(primary.requires).not.toContain("RAPIDAPI_KEY");
  });

  it("THE ORIGINAL CAPABILITY IS UNCHANGED — nothing about routing moved", () => {
    const either = byId("youtube_download");
    expect(either).toBeDefined();
    expect(either!.requiresAny).toEqual(["YOUTUBE_CC_DL_SERVICE", "RAPIDAPI_KEY"]);
    expect(either!.fatal).toBe(false);
  });

  it("NEITHER IS FATAL — a render without YouTube is a render", () => {
    expect(byId("youtube_download")!.fatal).toBe(false);
    expect(byId("youtube_download_primary")!.fatal).toBe(false);
  });

  it("the description says what the fallback actually costs, in the log's own words", () => {
    const d = byId("youtube_download_primary")!.describes;
    expect(d).toContain("whole-video");
    expect(d).toContain("scene budget");
  });

  it("every capability id is still unique", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size, "a duplicate capability id shadows another").toBe(ids.length);
  });
});

/* ═══════════ 5. a refusal about the video is remembered; a refusal about the moment is not ═══════════ */

describe("R235 §5 — twenty slots, ten videos", () => {
  const rule = () => {
    const at = FAIL.indexOf("export const YOUTUBE_PERMANENT_DOWNLOAD_STATUSES");
    expect(at, "the rule has no single definition").toBeGreaterThan(0);
    return FAIL.slice(at, FAIL.indexOf("]);", at));
  };

  it("THE THREE STATUSES THAT ARE ABOUT THE VIDEO ARE REMEMBERED", () => {
    const set = rule();
    for (const permanent of ["DOWNLOAD_UNSUPPORTED", "DOWNLOAD_EMPTY", "DOWNLOAD_INVALID_CONTENT"]) {
      expect(set, `${permanent} says something that stays true`).toContain(permanent);
    }
  });

  it("A TIMEOUT IS NOT — 75 of render 576's 79 refusals were a spent scene budget", () => {
    /**
     * `scene_budget_too_short_to_start` is reported as DOWNLOAD_TIMEOUT. Memoising it would write
     * a video off because ONE scene ran out of room, which is a silent narrowing of retrieval and
     * the opposite of this round's intent.
     */
    expect(rule(), "a budget timeout would blacklist a perfectly good video").not.toContain(
      "DOWNLOAD_TIMEOUT"
    );
  });

  it("AN AMBIGUOUS FAILURE IS NOT — the memo is for permanent reasons", () => {
    expect(rule()).not.toContain("DOWNLOAD_FAILED");
  });

  it("AND A MISSING ROUTE IS NOT — that would blacklist the whole platform", () => {
    expect(rule()).not.toContain("DOWNLOAD_UNAVAILABLE");
  });

  it("THE MEMO IS CONSULTED BEFORE THE CEILING IS SPENT, not after", () => {
    const consult = PIPE.indexOf("const alreadyRefused = youtubeDownloadRefusal(videoId);");
    const claim = PIPE.indexOf("if (!claimDownloadSlot()) {");
    expect(consult, "the memo is not consulted at all").toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(consult);
    /** A known-refused video must cost nothing: the loop moves on, it does not fall through. */
    expect(PIPE.slice(consult, claim)).toContain("continue;");
  });

  it("THE READ AND THE WRITE AGREE ABOUT THE KEY, because neither spells it out", () => {
    /**
     * A key built at two call sites is a memo that silently never hits. Both go through one
     * private helper instead.
     */
    expect((FAIL.match(/function youtubeRefusalKey\(/g) ?? []).length).toBe(1);
    expect((FAIL.match(/youtubeRefusalKey\(videoId\)/g) ?? []).length).toBe(2);
    expect(PIPE, "the pipeline spells the memo key out itself").not.toContain('`youtube_cc:${videoId}`');
  });

  it("RONDE 69's ATOMIC CLAIM IS UNTOUCHED — nothing is awaited between read and write", () => {
    const claim = PIPE.indexOf("if (!claimDownloadSlot()) {");
    const download = PIPE.indexOf("const ok = await downloadYouTubeCCClip(", claim);
    expect(download).toBeGreaterThan(claim);
    expect(PIPE.slice(claim, download), "an await crept between the claim and the download").not.toContain(
      "await"
    );
  });

  it("THE CEILING ITSELF IS UNCHANGED — this round raised no budget", () => {
    const at = PIPE.indexOf("export function claimYoutubeDownloadSlot(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(body).toContain("if (m.downloadSlotsClaimed >= maxDownloads) return false;");
    expect(body).toContain("m.downloadSlotsClaimed++;");
  });

  it("THE REFUSAL IS WRITTEN ONLY ON A FAILURE", () => {
    const at = PIPE.indexOf("if (!ok && noteYoutubeDownloadRefusal(videoId, dl.status, dl.reason))");
    expect(at, "the refusal is never recorded").toBeGreaterThan(0);
    /** The status reaches the log, so a written-off video says WHY it was written off. */
    expect(PIPE.slice(at, at + 300)).toContain("${dl.status}");
  });

  it("RONDE 223's SINGLE-WRITER RULE SURVIVED THIS ROUND INTACT", () => {
    /**
     * R223 asserts that `notePermanentDownloadRefusal(` appears exactly once in videoPipeline.ts —
     * a rule N loops register is the defect this codebase keeps removing, and that assertion is
     * the guard against it. Adding a second call here would have broken it, so the YouTube pair
     * lives beside the memo instead and the pipeline gained a READER, not a second writer.
     */
    expect((PIPE.match(/notePermanentDownloadRefusal\(/g) ?? []).length).toBe(1);
    expect((PIPE.match(/permanentDownloadRefusal\(url\)/g) ?? []).length).toBe(1);
  });

  it("it uses RONDE 223's memo rather than a second one", () => {
    /**
     * The point is that this facility already existed and this route did not consult it. A new map
     * here would be the defect this codebase keeps removing.
     */
    const at = FAIL.indexOf("export function noteYoutubeDownloadRefusal(");
    const body = FAIL.slice(at, FAIL.indexOf("\n}", at));
    expect(body).toContain("notePermanentDownloadRefusal(");
    expect(body, "the YouTube route grew its own store").not.toContain("new Map");
    expect((FAIL.match(/const permanentDownloadRefusals = new Map/g) ?? []).length).toBe(1);
  });

  it("a status the rule does not cover is not remembered, and says so by returning false", () => {
    const at = FAIL.indexOf("export function noteYoutubeDownloadRefusal(");
    const body = FAIL.slice(at, FAIL.indexOf("\n}", at));
    expect(body).toContain("YOUTUBE_PERMANENT_DOWNLOAD_STATUSES.has(status)");
    expect(body).toContain("return false;");
    /** An absent videoId or status is a miss, never a memo entry under an empty key. */
    expect(body).toContain("if (!videoId || !status");
  });
});
