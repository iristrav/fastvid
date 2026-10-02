/**
 * OCTOBER 2026 — the `dust` effect the planner puts on archive footage is executed: aged-film grain
 * and a per-frame projector flicker, from filters both ffmpeg builds carry. See `effectChain`.
 */
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import ffmpegStatic from "ffmpeg-static";

import { effectChain } from "./timelineFilters";

describe("dust runs", () => {
  it("is a grain and a flicker, scaled by intensity", () => {
    const light = effectChain({ effectType: "dust", intensity: 0 })!;
    const heavy = effectChain({ effectType: "dust", intensity: 1 })!;
    expect(light).toContain("noise=alls=6");
    expect(heavy).toContain("noise=alls=20");
    expect(heavy).toContain(":eval=frame");
  });
  it("the bundled ffmpeg executes it, and the picture flickers from frame to frame", () => {
    const chain = effectChain({ effectType: "dust", intensity: 1 })!.replace(/^noise=[^,]+,/, "");
    const raw = execFileSync(String(ffmpegStatic), [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=gray:s=64x36:r=25:d=1",
      "-vf", chain, "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], { maxBuffer: 1 << 24 });
    const size = 64 * 36;
    const means = Array.from({ length: Math.floor(raw.length / size) }, (_, f) => {
      let sum = 0;
      for (let i = f * size; i < (f + 1) * size; i++) sum += raw[i]!;
      return sum / size;
    });
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(3);
  });
});
