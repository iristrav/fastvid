import { describe, expect, it } from "vitest";
import { clipTimelineDurationSec, renderClip } from "./clipRenderer";
import type { ClipInstruction } from "./types";

function clip(overrides: Partial<ClipInstruction> = {}): ClipInstruction {
  return {
    candidateId: "c1",
    assetType: "video",
    localPath: "/tmp/c1.mp4",
    remoteUrl: null,
    trimStartSec: 2,
    trimEndSec: 6,
    startSec: 0,
    endSec: 4,
    timingSource: "tts_word_alignment",
    ...overrides,
  };
}

describe("Clip Renderer (Phase 7)", () => {
  describe("renderClip", () => {
    it("video clips get a trim fragment followed by the aspect ratio fragment", () => {
      const frags = renderClip(clip(), "16:9", { width: 1920, height: 1080 });
      expect(frags).toHaveLength(2);
      expect(frags[0]!.filter).toBe("trim=start=2.000:duration=4.000,setpts=PTS-STARTPTS");
      expect(frags[1]!.filter).toContain("scale=1920:1080");
    });

    it("image clips skip the trim fragment entirely — only the aspect ratio fragment is emitted", () => {
      const frags = renderClip(clip({ assetType: "image", trimStartSec: 0, trimEndSec: 0 }), "16:9", null);
      expect(frags).toHaveLength(1);
      expect(frags[0]!.filter).toContain("pad=");
    });

    it("never produces a negative trim start, and duration is clamped from the raw end-start span", () => {
      const frags = renderClip(clip({ trimStartSec: -1, trimEndSec: -0.5 }), "16:9", null);
      expect(frags[0]!.filter).toBe("trim=start=0.000:duration=0.500,setpts=PTS-STARTPTS");
    });

    it("clamps duration to 0 when trimEndSec is before trimStartSec", () => {
      const frags = renderClip(clip({ trimStartSec: 5, trimEndSec: 2 }), "16:9", null);
      expect(frags[0]!.filter).toBe("trim=start=5.000:duration=0.000,setpts=PTS-STARTPTS");
    });

    it("passes source dimensions through to the aspect ratio filter for crop-vs-fit selection", () => {
      const cropped = renderClip(clip(), "9:16", { width: 1080, height: 1920 })[1]!.filter;
      const padded = renderClip(clip(), "9:16", { width: 1920, height: 1080 })[1]!.filter;
      expect(cropped).toContain("crop=");
      expect(padded).toContain("pad=");
    });

    it("null source dimensions fall back to the safe pad/fit default", () => {
      const frags = renderClip(clip(), "1:1", null);
      expect(frags[1]!.filter).toContain("pad=");
    });

    it("includes the candidate id and timing source in the fragment reason", () => {
      const frags = renderClip(clip({ candidateId: "abc123", timingSource: "proportional_estimate" }), "16:9", null);
      expect(frags[0]!.reason).toBe("clip abc123 (proportional_estimate)");
    });
  });

  describe("clipTimelineDurationSec", () => {
    it("computes endSec - startSec", () => {
      expect(clipTimelineDurationSec(clip({ startSec: 1.5, endSec: 5.5 }))).toBe(4);
    });

    it("never returns a negative duration", () => {
      expect(clipTimelineDurationSec(clip({ startSec: 5, endSec: 2 }))).toBe(0);
    });
  });
});
