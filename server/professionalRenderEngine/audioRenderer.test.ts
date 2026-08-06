import { describe, expect, it } from "vitest";
import {
  buildCrossfadeNode,
  buildDuckingFilterComplex,
  buildVoiceFadeFragment,
  buildVolumeAutomationFragment,
  renderSoundEffectFragment,
} from "./audioRenderer";
import type { SoundInstruction } from "./types";

function sfx(overrides: Partial<SoundInstruction> = {}): SoundInstruction {
  return {
    soundType: "whoosh",
    timeSec: 1.5,
    volume: 0.7,
    fadeInSec: 0,
    fadeOutSec: 0,
    reason: "test",
    ...overrides,
  };
}

describe("Audio Renderer (Phase 7)", () => {
  describe("renderSoundEffectFragment", () => {
    it("builds the adelay/volume/atrim/asetpts chain with millisecond delay", () => {
      const [frag] = renderSoundEffectFragment(sfx({ timeSec: 1.5, volume: 0.7 }));
      expect(frag!.filter).toBe("adelay=1500|1500,volume=0.70,atrim=0:0.35,asetpts=PTS-STARTPTS");
    });

    it("clamps volume to [0,1]", () => {
      const over = renderSoundEffectFragment(sfx({ volume: 5 }))[0]!.filter;
      const atMax = renderSoundEffectFragment(sfx({ volume: 1 }))[0]!.filter;
      expect(over).toBe(atMax);
    });

    it("omits afade entirely when no fade durations are specified", () => {
      const frag = renderSoundEffectFragment(sfx({ fadeInSec: 0, fadeOutSec: 0 }))[0]!.filter;
      expect(frag).not.toContain("afade");
    });

    it("adds afade=in and afade=out when fade durations are specified", () => {
      const frag = renderSoundEffectFragment(sfx({ fadeInSec: 0.05, fadeOutSec: 0.1 }))[0]!.filter;
      expect(frag).toContain("afade=t=in:st=0:d=0.050");
      expect(frag).toContain("afade=t=out:st=0.250:d=0.100");
    });

    it("negative timeSec never produces a negative delay", () => {
      const frag = renderSoundEffectFragment(sfx({ timeSec: -1 }))[0]!.filter;
      expect(frag).toContain("adelay=0|0");
    });
  });

  describe("buildVoiceFadeFragment", () => {
    it("builds afade in/out relative to total duration", () => {
      const frag = buildVoiceFadeFragment(0.06, 0.12, 10);
      expect(frag.filter).toBe("afade=t=in:st=0:d=0.060,afade=t=out:st=9.880:d=0.120");
    });

    it("never produces a negative fade-out start", () => {
      const frag = buildVoiceFadeFragment(0.06, 5, 2);
      expect(frag.filter).toContain("afade=t=out:st=0.000:d=5.000");
    });
  });

  describe("buildCrossfadeNode", () => {
    it("builds the native acrossfade filter with a tri curve by default", () => {
      const node = buildCrossfadeNode(["a0", "a1"], 0.5, "aout");
      expect(node).toEqual({ inputs: ["a0", "a1"], filter: "acrossfade=d=0.500:c1=tri:c2=tri", output: "aout" });
    });

    it("supports a custom curve", () => {
      const node = buildCrossfadeNode(["a0", "a1"], 1, "aout", "exp");
      expect(node.filter).toBe("acrossfade=d=1.000:c1=exp:c2=exp");
    });
  });

  describe("buildDuckingFilterComplex", () => {
    it("builds the full asplit/aloop/sidechaincompress/amix mini-graph", () => {
      const graph = buildDuckingFilterComplex("voice0", "music0", 0.22, "aout");
      expect(graph).toBe(
        "[voice0]volume=1.0,asplit=2[voice_aout][voicedet_aout];" +
          "[music0]volume=0.22,aloop=loop=-1:size=2e+09[musicloop_aout];" +
          "[musicloop_aout][voicedet_aout]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200:makeup=1[ducked_aout];" +
          "[voice_aout][ducked_aout]amix=inputs=2:duration=first:dropout_transition=3[aout]"
      );
    });
  });

  describe("buildVolumeAutomationFragment", () => {
    it("returns a flat volume filter for zero keyframes", () => {
      expect(buildVolumeAutomationFragment([], "test").filter).toBe("volume=1.0");
    });

    it("returns a flat volume filter for a single keyframe", () => {
      expect(buildVolumeAutomationFragment([{ timeSec: 3, volume: 0.5 }], "test").filter).toBe("volume=0.500");
    });

    it("builds a piecewise-linear interpolation expression across multiple keyframes", () => {
      const frag = buildVolumeAutomationFragment(
        [
          { timeSec: 0, volume: 1 },
          { timeSec: 5, volume: 0.2 },
          { timeSec: 10, volume: 1 },
        ],
        "duck for narration"
      );
      expect(frag.filter).toContain("volume='if(lt(t,0.000),1.000,");
      expect(frag.filter).toContain("eval=frame");
      expect(frag.reason).toBe("duck for narration");
    });

    it("sorts out-of-order keyframes before building the expression", () => {
      const sorted = buildVolumeAutomationFragment(
        [
          { timeSec: 5, volume: 0.2 },
          { timeSec: 0, volume: 1 },
        ],
        "test"
      );
      expect(sorted.filter).toContain("if(lt(t,0.000),1.000,");
    });
  });
});
