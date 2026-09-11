/**
 * RONDE 222 §A — THE LEVEL NOBODY SET.
 *
 * Video 574 was delivered at -41.2 LUFS against a -14 LUFS streaming target. Twenty-seven decibels
 * under; effectively inaudible at normal volume. It was not a regression — a search of the tree for
 * `loudnorm`, `LUFS`, `targetLufs` and `normalizeAudio` returned nothing at all.
 *
 * The measurement below is the point of this file. Everything else here guards the shape; §3 runs a
 * real ffmpeg over a real quiet file and asserts the delivered level actually moves.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, execSync } from "child_process";

import {
  LOUDNESS_TOLERANCE_LU,
  TARGET_LUFS,
  TRUE_PEAK_DBTP,
  formatLoudness,
  isOnTarget,
  loudnessNeedsAttention,
  loudnormChain,
  measureLoudness,
  normaliseDeliveredLoudness,
  parseLoudnormJson,
  type LoudnessResult,
} from "./audioLoudness";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");

function haveFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = haveFfmpeg();

/* ═══════════ 1. the target, and the parser that feeds it ═══════════ */

describe("R222 §1 — the numbers", () => {
  it("the target is the streaming-platform target, not an invention", () => {
    expect(TARGET_LUFS).toBe(-14);
    expect(TRUE_PEAK_DBTP).toBe(-1.5);
  });

  it("VIDEO 574's MEASURED LEVEL IS OFF TARGET, and a correct file is not", () => {
    expect(isOnTarget(-41.2), "the render 574 level counted as acceptable").toBe(false);
    expect(isOnTarget(-14)).toBe(true);
    expect(isOnTarget(-14 + LOUDNESS_TOLERANCE_LU)).toBe(true);
    expect(isOnTarget(-14 - LOUDNESS_TOLERANCE_LU * 2)).toBe(false);
  });

  it("an unmeasured file is never called on target", () => {
    expect(isOnTarget(null)).toBe(false);
  });

  it("the parser reads a real loudnorm block", () => {
    const stderr = `
[Parsed_loudnorm_0 @ 0x55]
{
	"input_i" : "-41.20",
	"input_tp" : "-20.30",
	"input_lra" : "2.20",
	"input_thresh" : "-51.70",
	"output_i" : "-14.00",
	"normalization_type" : "linear"
}
`;
    const stats = parseLoudnormJson(stderr);
    expect(stats?.integratedLufs).toBeCloseTo(-41.2, 2);
    expect(stats?.truePeakDb).toBeCloseTo(-20.3, 2);
    expect(stats?.lra).toBeCloseTo(2.2, 2);
    expect(stats?.thresholdLufs).toBeCloseTo(-51.7, 2);
  });

  it("A SILENT FILE IS UNMEASURABLE, NOT INFINITELY QUIET", () => {
    /** loudnorm prints `-inf` for silence; a gain cannot be computed from it. */
    const stats = parseLoudnormJson(
      `{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-inf"}`
    );
    expect(stats?.integratedLufs).toBeNull();
    expect(loudnormChain(stats!), "a correction was built from an infinity").toBeNull();
  });

  it("garbage in stderr yields no measurement rather than a wrong one", () => {
    expect(parseLoudnormJson("no json here at all")).toBeNull();
    expect(parseLoudnormJson("{ not valid json")).toBeNull();
  });
});

/* ═══════════ 2. the correction is linear, and says so ═══════════ */

describe("R222 §2 — the second pass carries the first pass's measurement", () => {
  const stats = {
    integratedLufs: -41.2,
    truePeakDb: -20.3,
    lra: 2.2,
    thresholdLufs: -51.7,
  };

  it("all four measured values reach the filter", () => {
    const chain = loudnormChain(stats)!;
    expect(chain).toContain("measured_I=-41.2");
    expect(chain).toContain("measured_TP=-20.3");
    expect(chain).toContain("measured_LRA=2.2");
    expect(chain).toContain("measured_thresh=-51.7");
  });

  it("LINEAR, so narration is lifted rather than compressed", () => {
    expect(loudnormChain(stats)).toContain("linear=true");
  });

  it("THE SAMPLE RATE IS STILL RESTORED — loudnorm outputs 192kHz", () => {
    /**
     * The REQUIREMENT is unchanged and still asserted: the delivered file must be 48 kHz, because
     * loudnorm outputs 192 kHz and no player expects that. What moved is WHERE it is enforced.
     *
     * `aresample=48000` used to end this chain, and render 577 showed it is the one filter the
     * deployed ffmpeg cannot link:
     *
     *     Cannot select channel layout for the link between filters
     *     Parsed_aresample_1 and format_out_0_1 … Conversion failed!
     *
     * — twice, with and without faststart. Asking the ENCODER for 48 kHz produces the same file
     * with no such link to negotiate. So the chain must NOT carry the filter any more, and the
     * invocation MUST carry the rate; both halves are asserted, so the guarantee cannot be lost by
     * dropping one of them.
     */
    const LOUD = fs.readFileSync(path.join(__dirname, "audioLoudness.ts"), "utf8");
    expect(loudnormChain(stats), "the filter that could not be linked is back").not.toContain(
      "aresample"
    );
    expect(LOUD, "nothing asks for 48 kHz any more").toContain("-c:a aac -b:a 320k -ar 48000 ");
  });

  it("AND THE CHANNEL LAYOUT IS STATED, so no filter has to infer one", () => {
    /**
     * The underlying cause of that failed link: a stream that declares a channel COUNT but no
     * LAYOUT gives the graph nothing to agree on. The layout is read from the file and asserted at
     * the head of the chain, so loudnorm and everything after it is told rather than guessing.
     */
    expect(loudnormChain(stats, "mono")).toContain("aformat=channel_layouts=mono,loudnorm=");
    expect(loudnormChain(stats, "stereo")).toContain("aformat=channel_layouts=stereo,loudnorm=");
    /** Unknown layout asserts nothing — exactly the behaviour that existed before. */
    expect(loudnormChain(stats, null)).not.toContain("aformat");
    expect(loudnormChain(stats)).not.toContain("aformat");
  });

  it("an incomplete measurement produces no chain at all", () => {
    expect(loudnormChain({ ...stats, truePeakDb: null })).toBeNull();
    expect(loudnormChain({ ...stats, thresholdLufs: null })).toBeNull();
  });
});

/* ═══════════ 3. measured on a real file ═══════════ */

describe("R222 §3 — measured, not asserted", () => {
  it.skipIf(!FFMPEG)(
    "A FILE DELIVERED FAR BELOW TARGET IS BROUGHT TO TARGET",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r222-loud-"));
      const file = path.join(dir, "quiet.mp4");
      try {
        /**
         * A real 12-second file with a real quiet audio stream — no mock, no stub. The sine is
         * attenuated hard so the starting point sits in render 574's territory rather than near
         * the target, which is the case the pass exists for.
         */
        execSync(
          `ffmpeg -v error -y -f lavfi -i color=c=black:s=320x180:r=25:d=12 ` +
            `-f lavfi -i "sine=frequency=220:duration=12" ` +
            `-filter:a "volume=-30dB" -c:v libx264 -preset ultrafast -pix_fmt yuv420p ` +
            `-c:a aac -b:a 128k -shortest "${file}"`,
          { stdio: "ignore", timeout: 120_000 }
        );

        const before = await measureLoudness(file);
        expect(before.integratedLufs, "the fixture was not measurable").not.toBeNull();
        expect(
          isOnTarget(before.integratedLufs),
          `the fixture started on target (${before.integratedLufs}) so it proves nothing`
        ).toBe(false);

        const result = await normaliseDeliveredLoudness(file);
        expect(result.outcome, `outcome=${result.outcome} reason=${result.reason}`).toBe(
          "normalised"
        );
        expect(result.afterLufs).not.toBeNull();

        /** The file on disk — not the return value — is what a viewer receives. */
        const after = await measureLoudness(file);
        expect(after.integratedLufs).not.toBeNull();
        expect(
          Math.abs(after.integratedLufs! - TARGET_LUFS),
          `after=${after.integratedLufs} is not within 2 LU of ${TARGET_LUFS}`
        ).toBeLessThanOrEqual(2);

        /** And it is still a playable video with its picture intact. */
        const probe = execSync(
          `ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "${file}"`,
          { encoding: "utf8", timeout: 60_000 }
        );
        expect(probe).toContain("video");
        expect(probe).toContain("audio");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000
  );

  it.skipIf(!FFMPEG)(
    "A FILE ALREADY ON TARGET IS LEFT ALONE — no needless re-encode",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r222-ok-"));
      const file = path.join(dir, "ontarget.mp4");
      try {
        execSync(
          `ffmpeg -v error -y -f lavfi -i color=c=black:s=320x180:r=25:d=12 ` +
            `-f lavfi -i "sine=frequency=220:duration=12" ` +
            `-filter:a "loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=11,aresample=48000" ` +
            `-c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${file}"`,
          { stdio: "ignore", timeout: 120_000 }
        );
        const sizeBefore = fs.statSync(file).size;
        const result = await normaliseDeliveredLoudness(file);
        expect(["already_on_target", "normalised"]).toContain(result.outcome);
        if (result.outcome === "already_on_target") {
          expect(fs.statSync(file).size, "the file was re-encoded anyway").toBe(sizeBefore);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000
  );

  it("a file that does not exist fails cleanly instead of throwing", async () => {
    const r = await normaliseDeliveredLoudness("/nonexistent/nope.mp4");
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBeTruthy();
  });

  it("a caller that knows there is no audio is answered without an ffmpeg run", async () => {
    const r = await normaliseDeliveredLoudness("/nonexistent/nope.mp4", { hasAudio: false });
    expect(r.outcome).toBe("no_audio");
  });
});

/* ═══════════ 4. it reaches BOTH delivery routes ═══════════ */

describe("R222 §4 — one rule, both routes", () => {
  it("THE COMPOSE ROUTE NORMALISES THE FILE IT UPLOADS", () => {
    expect(PIPE).toContain("normaliseDeliveredLoudness(finalVideoPath)");
  });

  it("THE CINEMATIC ROUTE NORMALISES THE FILE IT DELIVERS", () => {
    expect(WORKER).toContain("normaliseDeliveredLoudness(outputPath)");
  });

  it("the compose route corrects AFTER the export pass and BEFORE the deliverable is measured", () => {
    /**
     * Two envelope checks exist on this route and only the LAST one describes the delivered file.
     * The first runs before `ensureFinalVideoExportReady`, which may REASSEMBLE the video — a
     * correction applied there would be silently thrown away, which is why the pass sits after it.
     * So the anchor is the stage-6 measurement, not the first `checkFileAvSync` in the file.
     */
    const norm = PIPE.indexOf("normaliseDeliveredLoudness(finalVideoPath)");
    const exportReady = PIPE.indexOf("ensureFinalVideoExportReady({");
    const size = PIPE.indexOf("const finalVideoSizeBytes");
    const deliveredEnvelope = PIPE.lastIndexOf("await checkFileAvSync(finalVideoPath)");
    expect(norm).toBeGreaterThan(0);
    expect(exportReady).toBeGreaterThan(0);
    expect(norm, "a rebuild by the export pass would discard the correction").toBeGreaterThan(
      exportReady
    );
    expect(norm, "the size is taken before the audio is corrected").toBeLessThan(size);
    expect(
      norm,
      "the delivered envelope is measured on a file that is about to change"
    ).toBeLessThan(deliveredEnvelope);
  });

  it("the cinematic route corrects before its own envelope check", () => {
    const norm = WORKER.indexOf("normaliseDeliveredLoudness(outputPath)");
    const env = WORKER.indexOf("await checkFileAvSync(outputPath)");
    expect(norm).toBeGreaterThan(0);
    expect(norm).toBeLessThan(env);
  });

  it("NEITHER ROUTE FAILS A RENDER OVER THE LEVEL", () => {
    /**
     * A film that could not be levelled is still a film. Both call sites catch, and neither
     * throws or returns early on the result.
     */
    for (const [name, src] of [["compose", PIPE], ["cinematic", WORKER]] as const) {
      const at = src.indexOf("normaliseDeliveredLoudness(");
      const block = src.slice(at, at + 700);
      expect(block, `${name} does not catch the loudness pass`).toContain(".catch(");
      expect(block, `${name} throws on a loudness outcome`).not.toContain("throw ");
    }
  });

  it("every outcome is reported — a silent success is still a line", () => {
    for (const outcome of [
      "already_on_target",
      "normalised",
      "no_audio",
      "not_measurable",
      "not_improved",
      "failed",
    ] as const) {
      const line = formatLoudness({
        outcome,
        beforeLufs: -41.2,
        afterLufs: null,
        targetLufs: TARGET_LUFS,
        reason: "because",
      } as LoudnessResult);
      expect(line.startsWith("[Loudness]"), `${outcome} printed no tagged line`).toBe(true);
      expect(line).toContain("-41.2");
    }
  });

  it("only the two good outcomes are quiet; the rest ask for attention", () => {
    const of = (outcome: LoudnessResult["outcome"]) =>
      loudnessNeedsAttention({
        outcome,
        beforeLufs: null,
        afterLufs: null,
        targetLufs: TARGET_LUFS,
      });
    expect(of("already_on_target")).toBe(false);
    expect(of("normalised")).toBe(false);
    expect(of("not_measurable")).toBe(true);
    expect(of("not_improved")).toBe(true);
    expect(of("failed")).toBe(true);
    expect(of("no_audio")).toBe(true);
  });
});

/* ═══════════ 5. what this round did NOT do ═══════════ */

describe("R222 §5 — the mix graphs were not touched", () => {
  it("NO FILTER WAS SCATTERED ACROSS THE ENCODE SITES", () => {
    /**
     * The defect this codebase keeps removing is a rule N routes must follow, registered by a few.
     * Loudness is corrected on the finished film at one point per route, so no ffmpeg string in
     * the pipeline's twenty-odd encode sites carries a loudnorm of its own.
     */
    const filters = fs.readFileSync(path.join(__dirname, "timelineFilters.ts"), "utf8");
    expect(filters, "a loudnorm appeared in the shared filter builder").not.toContain("loudnorm");
    const inPipe = [...PIPE.matchAll(/loudnorm/g)].length;
    expect(inPipe, "loudnorm leaked into the compose ffmpeg strings").toBe(0);
  });

  it("the amix that RONDE 189 settled is untouched", () => {
    const filters = fs.readFileSync(path.join(__dirname, "timelineFilters.ts"), "utf8");
    expect(filters).toContain("duration=longest");
    expect(filters).toContain("normalize=0");
  });
});
