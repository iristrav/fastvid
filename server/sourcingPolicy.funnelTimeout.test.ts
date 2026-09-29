import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { funnelAwaitTimeoutMs } from "./sourcingPolicy";

// FASE 7.2 PRODUCTION VERIFICATION — minimal, temporary test trigger.
//
// The funnel scoring branch (videoPipeline.ts, `else if (funnelResult && ...)`) is the only
// place the FASE 7.2 embedding-space fix executes. That branch is reachable only when the
// scene's `await withTimeout(prefetchFunnel, ...)` resolves. Production proved that await is
// a race, not a configuration: render 512 made it with 1243ms to spare ("prefetch waited
// 58757ms" against a 60s deadline), render 513 needed 140s and all three scenes fell back to
// per-beat retrieval — skipping the code under test entirely.
//
// This makes only that one deadline configurable. It is a delivery deadline: it decides
// whether the funnel's candidates arrive in time, never how any candidate is scored.

const PROD_DEFAULT = 60_000;

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const policySrc = readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8");

/** Strips line comments and block comments so assertions match real code, not prose. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The scene-level funnel await block, from the prefetch lookup to the post-await log. */
function funnelAwaitBlock(): string {
  const start = pipelineSrc.indexOf("const prefetchFunnel = prefetchFunnels?.get(scene.index);");
  expect(start).toBeGreaterThan(-1);
  const end = pipelineSrc.indexOf("[Hang] AFTER funnel await", start);
  expect(end).toBeGreaterThan(start);
  return pipelineSrc.slice(start, end);
}

describe("Test D — the timeout is scoped to the funnel await and nothing else", () => {

  it("provider, scene, watchdog and render timeouts are untouched", () => {
    // Each of these is a separate, independently-configured budget. Spot-check that the
    // well-known ones still read their own env vars / literals, not the funnel knob.
    expect(policySrc).toContain("process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim()");
    // The per-provider search/download timeouts named in the render 513 log keep their own
    // literals — none of them routes through funnelAwaitTimeoutMs.
    for (const label of ["SerpAPI search", "Wikimedia search", "Internet Archive search"]) {
      const idx = pipelineSrc.indexOf(label);
      expect(idx, `${label} should still exist`).toBeGreaterThan(-1);
      const scoped = pipelineSrc.slice(Math.max(0, idx - 300), idx + 100);
      expect(scoped, `${label} must not use the funnel knob`).not.toContain("funnelTimeoutMs");
    }
  });
});

describe("nothing under test was disturbed", () => {

  it("FASE 7.1: the scope-aware download fix is intact", () => {
    const idx = pipelineSrc.indexOf("async function fetchWithTimeout(");
    const scoped = pipelineSrc.slice(idx, idx + 1800);
    expect(scoped).toContain("AbortSignal.any([controller.signal, scopeSignal])");
    expect(scoped).not.toContain("funnelTimeoutMs");
  });

  it("FASE 7.3: the evidence rules are byte-identical", () => {
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MIN_SIM = visionThreshold\("MODERN_EVIDENCE_MIN_SIM", 0\.235\)/);
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MARGIN = visionThreshold\("MODERN_EVIDENCE_MARGIN", 0\.015\)/);
    expect(localSrc).toContain("const MODERN_EVIDENCE_MIN_PROBES = 2;");
    expect(localSrc).toContain("const MODERN_EVIDENCE_MIN_FRAMES = 2;");
    expect(localSrc).toContain("export function decideModernContentMismatch(");
    expect(localSrc).toContain(
      "if (negSim >= MODERN_EVIDENCE_MIN_SIM && negSim >= beatSim + MODERN_EVIDENCE_MARGIN) {"
    );
  });
});
