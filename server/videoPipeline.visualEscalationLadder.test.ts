import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// ALLERLAATSTE END-TO-END VISUAL SOURCING FIX — generateGuaranteedBeatClip previously tried
// exactly ONE real-search query (primaryPerson || videoTitle, curated archive only) before
// falling straight to text-overlay/color. That is not the escalation ladder the task requires
// (beat entity/event/location -> overall video topic -> richer VideoVisualContext -> another
// real provider -> only THEN AI/text-overlay/color), and it is universal/content-type-agnostic
// by construction (no isHistorical/primaryPerson branch decides whether it runs).

/**
 * Read one function's source out of videoPipeline.ts.
 *
 * RONDE 100B's second audit put a provenance wrapper in front of generateGuaranteedBeatClip —
 * it reaches Wikimedia, and thirteen callers got there without a beat scope. The ladder these
 * tests are about now lives in generateGuaranteedBeatClipInner. Follow the wrapper, and check on
 * the way through that it really is only a wrapper, so the indirection can never hide a second
 * implementation from these tests.
 */
function extractFunctionSource(fnName: string): string {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  if (src.includes(`async function ${fnName}Inner(`)) {
    const wrapper = sliceFunction(src, fnName);
    if (!wrapper.includes("withBeatProvenance") || !wrapper.includes(`${fnName}Inner(`)) {
      throw new Error(`${fnName} is not a plain provenance wrapper — inspect it directly`);
    }
    return sliceFunction(src, `${fnName}Inner`);
  }
  return sliceFunction(src, fnName);
}

function sliceFunction(src: string, fnName: string): string {
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
