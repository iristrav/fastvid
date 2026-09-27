import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function extractFunctionSource(fnName: string): string {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const candidates = [
    `export async function ${fnName}(`,
    `async function ${fnName}(`,
    `export function ${fnName}(`,
    `function ${fnName}(`,
  ];
  const marker = candidates.find((m) => src.includes(m));
  const startIdx = marker ? src.indexOf(marker) : -1;
  if (startIdx === -1) throw new Error(`function ${fnName} not found in videoPipeline.ts`);
  const parenStart = src.indexOf("(", startIdx);
  let parenDepth = 0;
  let j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === "(") parenDepth++;
    else if (src[j] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = src.indexOf("{", j);
  let depth = 0;
  let i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(startIdx, i + 1);
}

const fullSource = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Vision Gate root-cause fix — Test A: fetchOpenverseImages path collision", () => {
  const src = extractFunctionSource("fetchOpenverseImages");

  it("no longer keys the output filename on the loop-local index alone", () => {
    // The old, buggy construction: `openverse_${i}` with nothing else. Assert it's gone.
    expect(src).not.toMatch(/openverse_\$\{i\}\.jpg/);
    expect(src).not.toMatch(/openverse_\$\{i\}\.mp4/);
  });

  it("derives the filename from the asset's own id (or the image URL) so different assets can never collide on the same path", () => {
    expect(src).toContain("images[i]?.id?.trim() || imgUrl");
    expect(src).toContain("assetTag");
    expect(src).toContain("openverse_${assetTag}.jpg");
    expect(src).toContain("openverse_${assetTag}.mp4");
  });

  it("still falls back to a still-unique value when both id and URL are unexpectedly empty (never reintroduces `i` alone as the sole disambiguator for that edge case)", () => {
    const idx = src.indexOf("const assetTag");
    expect(idx).toBeGreaterThan(-1);
    // Scoped to the statement, not to a byte count — a comment added above the fallback expression
    // used to push it out of a snug window and report the fallback as gone.
    const end = src.indexOf(";", idx);
    expect(end).toBeGreaterThan(idx);
    const scoped = src.slice(idx, end);
    expect(scoped).toContain("String(i)");
  });
});

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
    const idx = fullSource.indexOf("provider title shares nothing with ");
    expect(idx).toBeGreaterThan(-1);
    // The scene/beat prefix opens the template literal, so the window reaches back past the match.
    const line = fullSource.slice(Math.max(0, idx - 200), idx + 600);
    expect(line).toContain("Scene ${sceneIndex} beat ${beatIndex}");
    expect(line).toContain("provider=");
    expect(line).toContain("query=");
    expect(line).toContain("title=");
    expect(line).toContain("flagged, not rejected");
  });

  it("and nothing rejects on it any more", () => {
    expect(fullSource).not.toContain(
      'recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "off_topic_visual"'
    );
  });
});

describe("Vision Gate root-cause fix — Test C: CLIP cannot record a content reject at all", () => {

  it("adoptClip's vision-gate call site records no vision_gate reject either", () => {
    const start = fullSource.indexOf("async function adoptClip(");
    expect(start).toBeGreaterThan(-1);
    const body = fullSource.slice(start, fullSource.indexOf("\nasync function fetchUniqueStockForBeat(", start));
    expect(body).not.toContain('recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "vision_gate", sourceQuery)');
    // The relevance gate is what can still cost a candidate its place here.
    expect(body).toContain('recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "beat_image_gate", sourceQuery)');
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
    const rejects = fullSource.match(/recordClipReject\([^)]*"vision_gate"/g) ?? [];
    expect(rejects).toHaveLength(0);
  });
});
