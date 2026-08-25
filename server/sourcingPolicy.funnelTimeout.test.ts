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

describe("funnelAwaitTimeoutMs", () => {
  const prev = process.env.FASTVID_FUNNEL_TIMEOUT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.FASTVID_FUNNEL_TIMEOUT_MS;
    else process.env.FASTVID_FUNNEL_TIMEOUT_MS = prev;
  });

  it("Test A — unset env var yields exactly the pre-existing 60000ms production default", () => {
    delete process.env.FASTVID_FUNNEL_TIMEOUT_MS;
    expect(funnelAwaitTimeoutMs()).toBe(PROD_DEFAULT);
  });

  it("Test B — FASTVID_FUNNEL_TIMEOUT_MS=180000 yields 180000", () => {
    process.env.FASTVID_FUNNEL_TIMEOUT_MS = "180000";
    expect(funnelAwaitTimeoutMs()).toBe(180_000);
  });

  it("Test C — a non-numeric value falls back to 60000 instead of NaN/0", () => {
    process.env.FASTVID_FUNNEL_TIMEOUT_MS = "abc";
    expect(funnelAwaitTimeoutMs()).toBe(PROD_DEFAULT);
    process.env.FASTVID_FUNNEL_TIMEOUT_MS = "";
    expect(funnelAwaitTimeoutMs()).toBe(PROD_DEFAULT);
    process.env.FASTVID_FUNNEL_TIMEOUT_MS = "   ";
    expect(funnelAwaitTimeoutMs()).toBe(PROD_DEFAULT);
  });

  it("Test C2 — out-of-range values fall back to 60000; the deadline can never be tightened", () => {
    // Below the production default: rejected, so a stray/typo'd value cannot make live
    // renders give the funnel LESS time than they do today.
    for (const v of ["0", "-1", "1000", "59999"]) {
      process.env.FASTVID_FUNNEL_TIMEOUT_MS = v;
      expect(funnelAwaitTimeoutMs(), `value ${v} must not tighten the deadline`).toBe(PROD_DEFAULT);
    }
    // Above the render's own wall-clock budget: rejected.
    for (const v of ["600001", "99999999"]) {
      process.env.FASTVID_FUNNEL_TIMEOUT_MS = v;
      expect(funnelAwaitTimeoutMs(), `value ${v} must not exceed the cap`).toBe(PROD_DEFAULT);
    }
    // The bounds themselves are accepted.
    process.env.FASTVID_FUNNEL_TIMEOUT_MS = "60000";
    expect(funnelAwaitTimeoutMs()).toBe(60_000);
    process.env.FASTVID_FUNNEL_TIMEOUT_MS = "600000";
    expect(funnelAwaitTimeoutMs()).toBe(600_000);
  });
});

describe("Test D — the timeout is scoped to the funnel await and nothing else", () => {
  it("both funnel awaits (prefetch and inline) use funnelTimeoutMs", () => {
    const block = funnelAwaitBlock();
    expect(block).toContain("const funnelTimeoutMs = funnelAwaitTimeoutMs();");
    expect(block).toContain("await withTimeout(prefetchFunnel, funnelTimeoutMs,");
    expect(block).toContain("}), funnelTimeoutMs, `buildRetrievalFunnel s${scene.index}`);");
    // The two 60_000 literals this replaced are gone from the executable code of this block.
    expect(codeOnly(block)).not.toContain("60_000");
  });

  it("funnelAwaitTimeoutMs is called at exactly one place in the pipeline", () => {
    const calls = codeOnly(pipelineSrc).match(/funnelAwaitTimeoutMs\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("funnelTimeoutMs is passed to exactly the two funnel awaits and nowhere else", () => {
    const code = codeOnly(pipelineSrc);
    const uses = code.match(/\bfunnelTimeoutMs\b/g) ?? [];
    // 1 declaration + 2 withTimeout arguments + 2 log interpolations = 5.
    expect(uses).toHaveLength(5);
    expect(code).toContain("await withTimeout(prefetchFunnel, funnelTimeoutMs,");
    expect(code).toContain("}), funnelTimeoutMs, `buildRetrievalFunnel s${scene.index}`);");
  });

  it("FASTVID_FUNNEL_TIMEOUT_MS is read in exactly one place in the whole server", () => {
    // Guards against the knob quietly spreading to provider/scene/render timeouts.
    const inPolicy = (codeOnly(policySrc).match(/FASTVID_FUNNEL_TIMEOUT_MS/g) ?? []).length;
    expect(inPolicy).toBe(1);
    expect(codeOnly(pipelineSrc)).not.toContain("FASTVID_FUNNEL_TIMEOUT_MS");
  });

  it("provider, scene, watchdog and render timeouts are untouched", () => {
    // Each of these is a separate, independently-configured budget. Spot-check that the
    // well-known ones still read their own env vars / literals, not the funnel knob.
    expect(policySrc).toContain("process.env.ARCHIVE_BEAT_TRY_TIMEOUT_MS?.trim()");
    // The per-provider search/download timeouts named in the render 513 log keep their own
    // literals — none of them routes through funnelAwaitTimeoutMs.
    for (const label of ["SerpAPI search", "Wikimedia search", "Internet Archive search", "SepiaSearch download"]) {
      const idx = pipelineSrc.indexOf(label);
      expect(idx, `${label} should still exist`).toBeGreaterThan(-1);
      const scoped = pipelineSrc.slice(Math.max(0, idx - 300), idx + 100);
      expect(scoped, `${label} must not use the funnel knob`).not.toContain("funnelTimeoutMs");
    }
  });
});

describe("observability", () => {
  it("logs the timeout in use once per scene, and the elapsed time on success", () => {
    const block = funnelAwaitBlock();
    expect(block).toContain("[FunnelTimeout] scene=${scene.index} timeoutMs=${funnelTimeoutMs}");
    expect(pipelineSrc).toContain(
      "[FunnelTimeout] scene=${scene.index} completed elapsedMs=${Date.now() - funnelAwaitT0}"
    );
    // Per scene, not per candidate: the whole file has exactly the two lines above.
    const logs = pipelineSrc.match(/\[FunnelTimeout\]/g) ?? [];
    expect(logs).toHaveLength(2);
  });
});

describe("nothing under test was disturbed", () => {
  it("FASE 7.2: the funnel still passes no queryEmb to VisionGate", () => {
    const start = pipelineSrc.indexOf("let funnelBeatEmb: number[] | null = null;");
    // RONDE 1 added the used-id argument; anchor on the stable prefix.
    const end = pipelineSrc.indexOf("const winner = pickBestFunnelCandidate(scored", start);
    const block = pipelineSrc.slice(start, end);
    expect(block).toContain("[FunnelVisionGate]");
    expect(block).toContain("queryEmbeddingSource=resolved-by-vision-gate");
    const callStart = block.indexOf("await evaluateClipVisionGate(");
    const call = block.slice(callStart, block.indexOf(");", callStart));
    expect(call).not.toContain("funnelBeatEmb");
    const args = call
      .slice(call.indexOf("(") + 1)
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    expect(args[10]).toBe("undefined"); // queryEmb slot
  });

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

  it("no similarity threshold or scoring constant moved", () => {
    const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
    expect(localSrc).toContain("return minScore10 / 40;");
    expect(localSrc).toContain("return Math.max(0, Math.min(10, Math.round(sim * 40)));");
    const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
    // Local renamed to allPassers by RONDE 1; the passers-only rule itself is unchanged.
    expect(funnelSrc).toMatch(/const allPassers = scored\s*\n?\s*\.filter\(s => s\.visionResult\.pass\)/);
  });
});
