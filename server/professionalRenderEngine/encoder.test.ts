import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEncodeCommand, encode, isForkPressureError, jitteredDelay } from "./encoder";
import type { EncodeOptions, RenderPlan, SceneRenderPlan } from "./types";

const ORIGINAL_GPU_FLAG = process.env.RENDER_GPU_ENCODING;

afterEach(() => {
  if (ORIGINAL_GPU_FLAG === undefined) delete process.env.RENDER_GPU_ENCODING;
  else process.env.RENDER_GPU_ENCODING = ORIGINAL_GPU_FLAG;
});

function scene(overrides: Partial<SceneRenderPlan> = {}): SceneRenderPlan {
  return {
    sceneIndex: 0,
    steps: [],
    filterComplex: "[0:v]scale=1920:1080[s0_out]",
    outputLabel: "s0_out",
    audioFilterComplex: "",
    audioOutputLabel: "",
    durationSec: 4,
    ...overrides,
  };
}

function plan(scenes: SceneRenderPlan[]): RenderPlan {
  return {
    videoId: "vid1",
    aspectRatio: "16:9",
    dimensions: { width: 1920, height: 1080 },
    scenes,
    totalDurationSec: scenes.reduce((s, sc) => s + sc.durationSec, 0),
  };
}

function options(overrides: Partial<EncodeOptions> = {}): EncodeOptions {
  return { outputPath: "/tmp/out.mp4", useGpu: false, crf: 20, preset: "medium", maxRetries: 2, ...overrides };
}

describe("Encoder (Phase 7)", () => {
  describe("isForkPressureError", () => {
    it("recognizes EAGAIN errors", () => {
      expect(isForkPressureError({ code: "EAGAIN" })).toBe(true);
    });

    it("recognizes 'resource temporarily unavailable' and 'cannot fork' text", () => {
      expect(isForkPressureError(new Error("Resource temporarily unavailable"))).toBe(true);
      expect(isForkPressureError(new Error("cannot fork process"))).toBe(true);
    });

    it("recognizes the libx264 pthread-init fork-pressure pattern", () => {
      const err = new Error("Error initializing output stream 0:0 -- Error while opening encoder");
      expect(isForkPressureError(err)).toBe(true);
    });

    it("does not classify an unrelated error as fork pressure", () => {
      expect(isForkPressureError(new Error("Invalid argument"))).toBe(false);
    });

    it("checks .stderr as well as .message", () => {
      const err = Object.assign(new Error("spawn failed"), { stderr: "Resource temporarily unavailable" });
      expect(isForkPressureError(err)).toBe(true);
    });
  });

  describe("jitteredDelay", () => {
    it("stays within +/-30% of the base delay", () => {
      for (let i = 0; i < 50; i++) {
        const d = jitteredDelay(1000);
        expect(d).toBeGreaterThanOrEqual(700);
        expect(d).toBeLessThanOrEqual(1300);
      }
    });
  });

  describe("buildEncodeCommand", () => {
    it("builds a single-scene command with -i inputs, filter_complex, and libx264 by default", () => {
      const cmd = buildEncodeCommand(plan([scene()]), ["/tmp/a.mp4"], options());
      expect(cmd).toContain('-i "/tmp/a.mp4"');
      expect(cmd).toContain('-filter_complex "[0:v]scale=1920:1080[s0_out]"');
      expect(cmd).toContain('-map "[s0_out]"');
      expect(cmd).toContain("-c:v libx264");
      expect(cmd).toContain("-crf 20");
      expect(cmd).toContain("-preset medium");
      expect(cmd).toContain('"/tmp/out.mp4"');
    });

    it("concatenates multiple scenes' video outputs with a top-level concat node", () => {
      const twoScenes = plan([
        scene({ sceneIndex: 0, outputLabel: "s0_out", filterComplex: "[0:v]scale=1920:1080[s0_out]" }),
        scene({ sceneIndex: 1, outputLabel: "s1_out", filterComplex: "[1:v]scale=1920:1080[s1_out]" }),
      ]);
      const cmd = buildEncodeCommand(twoScenes, ["/tmp/a.mp4", "/tmp/b.mp4"], options());
      expect(cmd).toContain("[s0_out][s1_out]concat=n=2:v=1:a=0[vfinal]");
      expect(cmd).toContain('-map "[vfinal]"');
    });

    it("maps audio when at least one scene has an audio output label", () => {
      const withAudio = plan([scene({ audioFilterComplex: "[0:a]volume=1.0[s0_aout]", audioOutputLabel: "s0_aout" })]);
      const cmd = buildEncodeCommand(withAudio, ["/tmp/a.mp4"], options());
      expect(cmd).toContain('-map "[s0_out]" -map "[s0_aout]"');
    });

    it("does not emit an audio map when no scene has audio", () => {
      const cmd = buildEncodeCommand(plan([scene()]), ["/tmp/a.mp4"], options());
      expect(cmd.match(/-map/g)?.length).toBe(1);
    });

    it("requesting GPU without RENDER_GPU_ENCODING set still falls back to libx264", () => {
      delete process.env.RENDER_GPU_ENCODING;
      const cmd = buildEncodeCommand(plan([scene()]), ["/tmp/a.mp4"], options({ useGpu: true }));
      expect(cmd).toContain("-c:v libx264");
      expect(cmd).not.toContain("nvenc");
    });

    it("uses nvenc only when both useGpu is requested AND RENDER_GPU_ENCODING=true", () => {
      process.env.RENDER_GPU_ENCODING = "true";
      const cmd = buildEncodeCommand(plan([scene()]), ["/tmp/a.mp4"], options({ useGpu: true }));
      expect(cmd).toContain("-c:v h264_nvenc");
    });
  });

  describe("encode", () => {
    const noSleep = () => Promise.resolve();

    it("succeeds on the first attempt with no retries", async () => {
      const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const result = await encode(plan([scene()]), ["/tmp/a.mp4"], options(), executor, noSleep);
      expect(result.succeeded).toBe(true);
      expect(result.attempts).toHaveLength(1);
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it("retries on a fork-pressure error and succeeds on the second attempt", async () => {
      const executor = vi
        .fn()
        .mockRejectedValueOnce({ code: "EAGAIN" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" });
      const result = await encode(plan([scene()]), ["/tmp/a.mp4"], options(), executor, noSleep);
      expect(result.succeeded).toBe(true);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]!.succeeded).toBe(false);
      expect(result.attempts[1]!.succeeded).toBe(true);
    });

    it("gives up immediately on a non-fork-pressure error without retrying", async () => {
      const executor = vi.fn().mockRejectedValue(new Error("Invalid filter syntax"));
      const result = await encode(plan([scene()]), ["/tmp/a.mp4"], options({ maxRetries: 3 }), executor, noSleep);
      expect(result.succeeded).toBe(false);
      expect(result.attempts).toHaveLength(1);
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it("stops after maxRetries is exhausted", async () => {
      const executor = vi.fn().mockRejectedValue({ code: "EAGAIN" });
      const result = await encode(plan([scene()]), ["/tmp/a.mp4"], options({ maxRetries: 2 }), executor, noSleep);
      expect(result.succeeded).toBe(false);
      expect(result.attempts).toHaveLength(3); // initial attempt + 2 retries
      expect(executor).toHaveBeenCalledTimes(3);
    });

    it("records usedGpu based on both the request and the feature flag", async () => {
      process.env.RENDER_GPU_ENCODING = "true";
      const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const result = await encode(plan([scene()]), ["/tmp/a.mp4"], options({ useGpu: true }), executor, noSleep);
      expect(result.usedGpu).toBe(true);
    });
  });
});
