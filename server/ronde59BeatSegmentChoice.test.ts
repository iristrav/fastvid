import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  pickBeatSegmentStartSec,
  beatSegmentChoiceEnabled,
  JUDGEMENT_FRAME_FRACTIONS,
} from "./beatSegmentChoice";

/**
 * RONDE 59 — which SECOND of the right video ends up on screen.
 *
 * Render 531 downloaded 41 clips. Seventeen were longer than a minute; the longest was 272
 * seconds and was fetched eight separate times. Every one of them was trimmed with no start
 * offset at all, so `ss = 0`: from four and a half minutes of archive footage the pipeline took
 * the opening three and a half seconds — 1.3% of it, and precisely where archive material keeps
 * its title cards, leaders and countdowns.
 *
 * The numbers below are the real durations from that render.
 */

/** The distinct source durations measured in render 531, in seconds. */
const RENDER_531_DURATIONS = [10.1, 11.8, 38.8, 94.2, 151.1, 272.0];
/** A typical beat hold in that render. */
const HOLD = 3.5;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("RONDE 59 — a long source no longer gives up its opening seconds", () => {
  it("every long render-531 source now starts well past its title card", () => {
    for (const dur of RENDER_531_DURATIONS.filter((d) => d >= 30)) {
      const start = pickBeatSegmentStartSec(dur, HOLD, 0);
      expect(start).toBeGreaterThan(0);
      // At least a couple of seconds in — enough to clear a leader on the shortest of them.
      expect(start).toBeGreaterThanOrEqual(2);
    }
  });

  it("the 272-second source that was fetched eight times skips its first half-minute", () => {
    const start = pickBeatSegmentStartSec(272.0, HOLD, 0);
    expect(start).toBeCloseTo(30, 1);
  });

  it("a short source still starts at zero — there is nothing to choose", () => {
    // Barely longer than the take: any offset would just eat the clip.
    expect(pickBeatSegmentStartSec(4.5, HOLD)).toBe(0);
    expect(pickBeatSegmentStartSec(3.6, HOLD)).toBe(0);
    expect(pickBeatSegmentStartSec(HOLD, HOLD)).toBe(0);
  });

  it("the skip scales with the source instead of being a flat number of seconds", () => {
    // A ten-second clip cannot afford a thirty-second leader skip, and does not get one.
    const short = pickBeatSegmentStartSec(10.1, HOLD, 0);
    const long = pickBeatSegmentStartSec(272.0, HOLD, 0);
    expect(short).toBeLessThan(long);
    expect(short).toBeLessThan(10.1 - HOLD);
  });
});

describe("RONDE 59 — two beats from one source do not get the same seconds", () => {
  it("consecutive indices land far apart, not a step of milliseconds", () => {
    const a = pickBeatSegmentStartSec(272.0, HOLD, 0);
    const b = pickBeatSegmentStartSec(272.0, HOLD, 1);
    const c = pickBeatSegmentStartSec(272.0, HOLD, 2);
    expect(Math.abs(b - a)).toBeGreaterThan(30);
    expect(Math.abs(c - b)).toBeGreaterThan(30);
    expect(Math.abs(c - a)).toBeGreaterThan(30);
  });

  it("the same source used eight times in a render yields eight distinct starts", () => {
    const starts = new Set(
      Array.from({ length: 8 }, (_, i) => pickBeatSegmentStartSec(272.0, HOLD, i).toFixed(2))
    );
    expect(starts.size).toBe(8);
  });

  it("is deterministic — the same beat of the same render always makes the same choice", () => {
    for (const dur of RENDER_531_DURATIONS) {
      for (let i = 0; i < 4; i++) {
        expect(pickBeatSegmentStartSec(dur, HOLD, i)).toBe(pickBeatSegmentStartSec(dur, HOLD, i));
      }
    }
  });
});

describe("RONDE 59 — it can never ask for a second that is not there", () => {
  it("the start always leaves the whole take inside the source", () => {
    for (const dur of RENDER_531_DURATIONS) {
      for (let i = 0; i < 12; i++) {
        for (const hold of [2.5, 3.5, 6, 9]) {
          const start = pickBeatSegmentStartSec(dur, hold, i);
          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThanOrEqual(Math.max(0, dur - hold));
        }
      }
    }
  });

  it("nonsense input starts at zero rather than at NaN", () => {
    expect(pickBeatSegmentStartSec(NaN, HOLD)).toBe(0);
    expect(pickBeatSegmentStartSec(272, NaN)).toBe(0);
    expect(pickBeatSegmentStartSec(Infinity, HOLD)).toBe(0);
    expect(pickBeatSegmentStartSec(0, HOLD)).toBe(0);
    expect(pickBeatSegmentStartSec(-5, HOLD)).toBe(0);
    expect(pickBeatSegmentStartSec(272, 0)).toBe(0);
    expect(pickBeatSegmentStartSec(272, -1)).toBe(0);
  });

  it("switches off to the exact previous behaviour", () => {
    vi.stubEnv("ENABLE_BEAT_SEGMENT_CHOICE", "false");
    expect(beatSegmentChoiceEnabled()).toBe(false);
    for (const dur of RENDER_531_DURATIONS) {
      expect(pickBeatSegmentStartSec(dur, HOLD, 3)).toBe(0);
    }
  });
});

describe("RONDE 59 — the trim actually receives the offset", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("downloadAndTrimPoolCandidate passes a start offset to the trim", () => {
    const src = SRC();
    const idx = src.indexOf("export async function downloadAndTrimPoolCandidate(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 8000);
    expect(block).toContain("pickBeatSegmentStartSec(sourceDur, takeSec, beatIndex)");
    expect(block).toContain(
      "trimDownloadedStockClip(rawPath, outPath, holdSec, sourceDur, `pool s${sceneIndex}b${beatIndex}`, startOffsetSec)"
    );
  });

  it("the bare no-offset call that cut every clip from second 0 is gone", () => {
    const src = SRC();
    expect(src).not.toContain(
      "trimDownloadedStockClip(rawPath, outPath, holdSec, sourceDur, `pool s${sceneIndex}b${beatIndex}`)"
    );
  });

  it("trimDownloadedStockClip still clamps whatever it is handed", () => {
    const src = SRC();
    const idx = src.indexOf("async function trimDownloadedStockClip(");
    const block = src.slice(idx, idx + 1200);
    // The offset is advice, not a command: the trim keeps its own bound on the source length.
    expect(block).toContain("Math.max(0, Math.min(ss, Math.max(0, sourceDuration - trimDur - 0.1)))");
  });
});

describe("RONDE 59 — the judge looks across the clip, not at one instant", () => {
  it("samples several moments, spread over the whole of it", () => {
    expect(JUDGEMENT_FRAME_FRACTIONS.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...JUDGEMENT_FRAME_FRACTIONS)).toBeGreaterThan(0);
    expect(Math.max(...JUDGEMENT_FRAME_FRACTIONS)).toBeLessThan(1);
    // Spread, not clustered: the first and last are on opposite sides of the middle.
    expect(Math.max(...JUDGEMENT_FRAME_FRACTIONS) - Math.min(...JUDGEMENT_FRAME_FRACTIONS))
      .toBeGreaterThanOrEqual(0.5);
  });

  it("the pipeline extracts one frame per fraction and cleans all of them up", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = src.indexOf("let winner = pickBestFunnelCandidate(");
    const block = src.slice(idx, idx + 3200);
    expect(block).toContain("f < JUDGEMENT_FRAME_FRACTIONS.length");
    expect(block).toContain("JUDGEMENT_FRAME_FRACTIONS[f]!");
    expect(block).toContain("framePaths,");
    expect(block).toMatch(/for \(const p of framePaths\)[\s\S]{0,80}fs\.unlinkSync\(p\)/);
    // The single fixed frame it used to judge on is gone.
    expect(block).not.toContain("extractFrameAtFraction(winner.clipPath, framePath, 0.45");
  });
});

describe("RONDE 59 — judging a clip from several frames", () => {
  let dir: string;
  let frames: string[];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r59-"));
    frames = ["gray", "red", "blue"].map((c, i) => {
      const p = path.join(dir, `f${i}.jpg`);
      execFileSync(
        "ffmpeg",
        ["-y", "-f", "lavfi", "-i", `color=c=${c}:s=320x240`, "-frames:v", "1", p],
        { stdio: "ignore" }
      );
      return p;
    });
  });
  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const judge = async (framePaths: string[]) => {
    vi.resetModules();
    vi.doMock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
    const { invokeLLM } = await import("./_core/llm");
    const mock = invokeLLM as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ depicts: "a bunker", belongs: true, reason: "fits" }),
          },
        },
      ],
    });
    const { judgeBeatImage, createBeatImageGateState } = await import("./beatImageRelevanceGate");
    const verdict = await judgeBeatImage({
      framePaths,
      beatText: "In April 1945, Adolf Hitler died in the Führerbunker.",
      videoTitle: "Why Hitler Chose Death",
      contentKey: `k-${Math.random()}`,
      state: createBeatImageGateState(),
    });
    return { verdict, mock };
  };

  const images = (mock: ReturnType<typeof vi.fn>) =>
    (mock.mock.calls[0]![0].messages[1].content as Array<Record<string, unknown>>).filter(
      (c) => c.type === "image_url"
    );

  it("sends every readable frame in one call, not one call per frame", async () => {
    const { mock } = await judge(frames);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(images(mock)).toHaveLength(3);
  });

  it("tells the model the frames are from one clip at different moments", async () => {
    const { mock } = await judge(frames);
    const content = mock.mock.calls[0]![0].messages[1].content as Array<Record<string, unknown>>;
    const text = (content.find((c) => c.type === "text") as { text: string }).text;
    expect(text).toMatch(/frames sampled in order from across one clip/);
    expect(text).toMatch(/SAME clip at different moments/);
    // And it now knows a title card filling the clip is a reason to reject it.
    expect(text).toMatch(/title card, a leader or a countdown/);
  });

  it("one frame that could not be extracted does not sink the judgement", async () => {
    const { verdict, mock } = await judge([frames[0]!, path.join(dir, "missing.jpg"), frames[2]!]);
    expect(verdict.verdict).toBe("fits");
    expect(images(mock)).toHaveLength(2);
  });

  it("no readable frame at all still adopts the clip", async () => {
    const { verdict, mock } = await judge([path.join(dir, "nope.jpg")]);
    expect(verdict.verdict).toBe("unknown");
    expect(mock).not.toHaveBeenCalled();
  });

  it("an empty frame list adopts the clip rather than throwing", async () => {
    const { verdict, mock } = await judge([]);
    expect(verdict.verdict).toBe("unknown");
    expect(mock).not.toHaveBeenCalled();
  });

  it("a single frame still works, and reads as a single frame in the prompt", async () => {
    const { verdict, mock } = await judge([frames[0]!]);
    expect(verdict.verdict).toBe("fits");
    expect(images(mock)).toHaveLength(1);
    const content = mock.mock.calls[0]![0].messages[1].content as Array<Record<string, unknown>>;
    const text = (content.find((c) => c.type === "text") as { text: string }).text;
    expect(text).toMatch(/one frame from a clip/);
  });
});
