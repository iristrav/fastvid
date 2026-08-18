import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// ALLERLAATSTE END-TO-END VISUAL SOURCING FIX — generateGuaranteedBeatClip previously tried
// exactly ONE real-search query (primaryPerson || videoTitle, curated archive only) before
// falling straight to text-overlay/color. That is not the escalation ladder the task requires
// (beat entity/event/location -> overall video topic -> richer VideoVisualContext -> another
// real provider -> only THEN AI/text-overlay/color), and it is universal/content-type-agnostic
// by construction (no isHistorical/primaryPerson branch decides whether it runs).

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

describe("Visual sourcing escalation ladder — generateGuaranteedBeatClip", () => {
  const src = extractFunctionSource("generateGuaranteedBeatClip");

  it("builds a beat-level entity/event/location escalation tier via buildBeatQueryEscalationTiers", () => {
    expect(src).toContain("buildBeatQueryEscalationTiers(beatText, topic?.primaryPerson, topic?.videoTitle)");
  });

  it("still includes the overall video topic (primaryPerson || videoTitle) as a tier", () => {
    expect(src).toContain("topic?.primaryPerson || topic?.videoTitle");
    expect(src).toContain("if (topicQuery) tiers.push(topicQuery)");
  });

  it("adds a richer-context tier built from VideoVisualContext (people/locations/period) when available", () => {
    expect(src).toContain("get_activeVideoVisualContext()");
    expect(src).toContain("videoCtx.people[0]");
    expect(src).toContain("videoCtx.locations[0]");
    expect(src).toContain("videoCtx.period");
  });

  it("tries curated archive across every tier (not just one flat query), stopping at the first hit", () => {
    const searchTiersIdx = src.indexOf("const searchTiers");
    expect(searchTiersIdx).toBeGreaterThan(-1);
    const loopIdx = src.indexOf("for (const query of searchTiers)");
    expect(loopIdx).toBeGreaterThan(searchTiersIdx);
    const scoped = src.slice(loopIdx, loopIdx + 1200);
    expect(scoped).toContain("fetchCuratedArchiveBeatClip(");
    expect(scoped).toContain("{ relaxed: true }");
    expect(scoped).toContain("return topicalClip");
  });

  it("tries one more real provider (Wikimedia) before ever falling to text-overlay/color", () => {
    const wikiIdx = src.indexOf("fetchWikimediaImages(wikiQuery");
    expect(wikiIdx).toBeGreaterThan(-1);
    const textOverlayIdx = src.indexOf("Try text-over-gradient");
    const colorIdx = src.indexOf("generateColorFallback(sceneIndex * 1000");
    expect(wikiIdx).toBeLessThan(textOverlayIdx);
    expect(textOverlayIdx).toBeLessThan(colorIdx);
  });

  it("is content-type-agnostic: no isHistorical/primaryPerson conditional gates whether the ladder runs", () => {
    // The escalation-ladder block (from the topic/videoCtx reads down to the Wikimedia tier)
    // must not be wrapped in a historical- or person-only guard.
    const ladderStart = src.indexOf("const topic = get_activeVideoTopic();");
    const ladderEnd = src.indexOf("Try text-over-gradient");
    const ladder = src.slice(ladderStart, ladderEnd);
    expect(ladder).not.toMatch(/if\s*\(\s*isHistorical/);
    expect(ladder).not.toMatch(/if\s*\(\s*primaryPerson\)/);
  });

  it("bounds the tier list (no unbounded retries)", () => {
    expect(src).toMatch(/\.slice\(0,\s*4\)/);
  });
});

describe("Visual sourcing escalation ladder — render-scoped VideoVisualContext plumbing", () => {
  it("RenderCtx carries videoVisualContext (mirrors the existing videoTopic pattern)", () => {
    expect(fullSource).toContain("videoVisualContext: VideoVisualContext | null;");
    expect(fullSource).toContain("function get_activeVideoVisualContext(): VideoVisualContext | null");
  });

  it("both RenderCtx object literals initialize videoVisualContext (getRenderCtx default + runVideoPipeline's per-render ctx)", () => {
    const count = (fullSource.match(/videoVisualContext:\s*null,/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("videoVisualContext is mirrored into the render context right after it's built", () => {
    const idx = fullSource.indexOf("visualDedup.videoVisualContext = await buildVideoVisualContext(");
    expect(idx).toBeGreaterThan(-1);
    const scoped = fullSource.slice(idx, idx + 300);
    expect(scoped).toContain("getRenderCtx().videoVisualContext = visualDedup.videoVisualContext ?? null;");
  });
});
