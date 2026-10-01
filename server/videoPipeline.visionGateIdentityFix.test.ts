import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const fullSource = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

// Test A (the Openverse path collision) left with Openverse itself (VIDEO 619).

describe("Vision Gate root-cause fix round 2 — Test 9: off_topic_visual verdicts are individually logged", () => {
  /**
   * SUPERSEDED BY RONDE 114 in ONE respect: there is no off_topic_visual reject any more.
   *
   * The gate reads a provider TITLE, so it was demoted to a flag alongside `vision_gate`
   * (RONDE 103) and `off_topic_protest` (RONDE 104) — a metadata check standing in front of a
   * model that looks at the frame can only take material away. What this test actually protects
   * is unchanged and still worth protecting: when the gate has an opinion, the line carries
   * enough to reconstruct it from logs alone (scene, beat, provider, query, title). It is now
   * asserted on the flag line rather than on a reject that no longer exists.
   */
  it("logs scene, beat, provider, query and title when off_topic_visual has an opinion", () => {
    /** ONE ROUTE: the flag is the VisualJudge's now; `where` carries the scene and beat. */
    const judge = readFileSync(path.join(__dirname, "visualJudge.ts"), "utf8");
    const idx = judge.indexOf("provider title shares nothing with ");
    expect(idx).toBeGreaterThan(-1);
    // The scene/beat prefix opens the template literal, so the window reaches back past the match.
    const line = judge.slice(Math.max(0, idx - 200), idx + 600);
    expect(line).toContain("[VisualJudge] ${input.where}");
    expect(fullSource).toContain("where: `s${sceneIndex}b${beatIndex}`,");
    expect(line).toContain("provider=");
    expect(line).toContain("query=");
    expect(line).toContain("title=");
    expect(line).toContain("flagged, not rejected");
  });

  it("and nothing rejects on it any more", () => {
    expect(fullSource).not.toContain(
      'registerRejection(dedup.rejections, sceneIndex, beatIndex, p, "off_topic_visual"'
    );
  });
});

describe("Vision Gate root-cause fix — Test C: CLIP cannot record a content reject at all", () => {

  it("adoptClip's vision-gate call site records no vision_gate reject either", () => {
    const start = fullSource.indexOf("async function adoptClip(");
    expect(start).toBeGreaterThan(-1);
    const body = fullSource.slice(start, fullSource.indexOf("\nasync function fetchUniqueStockForBeat(", start));
    expect(body).not.toContain('registerRejection(dedup.rejections, sceneIndex, beatIndex, p, "vision_gate", sourceQuery)');
    // The relevance gate is what can still cost a candidate its place here.
    expect(body).toContain('registerRejection(dedup.rejections, sceneIndex, beatIndex, p, "beat_image_gate", sourceQuery)');
  });

  it("adoptClip calls evaluateClipVisionGate directly (not the boolean-only clipPassesVisionGate wrapper) so the score is observable", () => {
    const idx = fullSource.indexOf("const visionResult = await evaluateClipVisionGate(");
    expect(idx).toBeGreaterThan(-1);
    // The score is what it is kept for: it lands on the candidate's lineage record.
    expect(fullSource).toContain("eligibleRecord.visionScore ??= visionResult.worstScore10 ?? undefined;");
  });

  it("RONDE 103 — no CLIP call site anywhere still rejects a clip on content", () => {
    // The three sites RONDE 101 named: adoptClip, beatClipPassesVisionGate, the funnel. Not one
    // of them may turn a CLIP verdict into a rejection any more.
    const rejects = fullSource.match(/registerRejection\([^)]*"vision_gate"/g) ?? [];
    expect(rejects).toHaveLength(0);
  });
});
