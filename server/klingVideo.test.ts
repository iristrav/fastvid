import { describe, expect, it } from "vitest";
import {
  isKlingAvailable,
  klingBeatFallbackEnabled,
  maxKlingClipsPerVideo,
} from "./_core/klingVideo";

describe("klingVideo", () => {
  it("respects ENABLE_KLING_BEAT_FALLBACK=false", () => {
    const prevEnable = process.env.ENABLE_KLING_BEAT_FALLBACK;
    const prevFal = process.env.FAL_KEY;
    process.env.FAL_KEY = "test-key";
    process.env.ENABLE_KLING_BEAT_FALLBACK = "false";
    expect(klingBeatFallbackEnabled()).toBe(false);
    if (prevEnable === undefined) delete process.env.ENABLE_KLING_BEAT_FALLBACK;
    else process.env.ENABLE_KLING_BEAT_FALLBACK = prevEnable;
    if (prevFal === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = prevFal;
  });

  it("detects availability from FAL_KEY", () => {
    const prev = process.env.FAL_KEY;
    const prevK = process.env.KLING_API_KEY;
    const prevS = process.env.KLING_API_SECRET;
    delete process.env.KLING_API_KEY;
    delete process.env.KLING_API_SECRET;
    process.env.FAL_KEY = "abc";
    expect(isKlingAvailable()).toBe(true);
    delete process.env.FAL_KEY;
    expect(isKlingAvailable()).toBe(false);
    if (prev === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = prev;
    if (prevK) process.env.KLING_API_KEY = prevK;
    if (prevS) process.env.KLING_API_SECRET = prevS;
  });

  it("caps max clips per video", () => {
    const prev = process.env.KLING_MAX_CLIPS_PER_VIDEO;
    process.env.KLING_MAX_CLIPS_PER_VIDEO = "99";
    expect(maxKlingClipsPerVideo()).toBe(20);
    process.env.KLING_MAX_CLIPS_PER_VIDEO = "3";
    expect(maxKlingClipsPerVideo()).toBe(3);
    if (prev === undefined) delete process.env.KLING_MAX_CLIPS_PER_VIDEO;
    else process.env.KLING_MAX_CLIPS_PER_VIDEO = prev;
  });
});
