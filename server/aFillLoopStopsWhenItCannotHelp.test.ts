import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fillLoopStopReason, withSceneFetchTimeout } from "./videoPipeline";

/**
 * RONDE 647 — render 610 asked scene 1 beat 0 for a picture about thirty times in eight minutes,
 * after its scene budget had ended. Three coverage loops kept picking the beat with the largest
 * gap, which a beat that comes back empty still has.
 */
const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function bodyOf(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  expect(start, `${name} is gone`).toBeGreaterThan(-1);
  const next = SRC.indexOf("\nasync function ", start + 10);
  return SRC.slice(start, next === -1 ? undefined : next);
}

describe("a fill loop stops when another attempt can no longer help", () => {
  it("a beat that already came back empty in this loop is not asked again", () => {
    expect(fillLoopStopReason(0, new Set([0]))).toMatch(/already came back empty/);
    expect(fillLoopStopReason(1, new Set([0]))).toBeNull();
  });

  it("nothing is asked once the scene budget has ended", async () => {
    let inside: string | null | undefined;
    let atStart: string | null | undefined;
    const scoped = withSceneFetchTimeout(
      async () => {
        atStart = fillLoopStopReason(3, new Set());
        await new Promise((r) => setTimeout(r, 60));
        inside = fillLoopStopReason(3, new Set());
      },
      20,
      "fill loop test scope"
    ).catch(() => undefined);
    await scoped;
    await new Promise((r) => setTimeout(r, 80));
    expect(atStart).toBeNull();
    expect(inside).toMatch(/budget has ended/);
  });

  it.each(["backfillArchiveMontageFromPool", "ensureArchiveMontageVoiceCoverage"])(
    "%s consults the stop rule and remembers the beats that came back empty",
    (name) => {
      const body = bodyOf(name);
      expect(body).toContain("fillLoopStopReason(beatIdx,");
      expect(body).toMatch(/if \(clips\.length === before\) empty\w*Beats\.add\(beatIdx\);/);
    }
  );

  it("the voice-coverage loops measure coverage after each attempt, not once after the loop", () => {
    const body = bodyOf("ensureArchiveMontageVoiceCoverage");
    const recounts = body.match(/add\(beatIdx\);\n\s*coverage = await estimateBalancedMontageCoverageSec\(/g) ?? [];
    expect(recounts).toHaveLength(2);
  });
});
