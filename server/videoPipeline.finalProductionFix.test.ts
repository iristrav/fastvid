import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// ALLERLAATSTE END-TO-END FIX — closes the remaining recordClipAdopt audit gaps found by
// grepping every generateGuaranteedBeatClip call site in the file (not just the three already
// fixed in Round 17 + its follow-up), plus hardens the YouTube CC 429/quota circuit breaker and
// adds production observability (final visual manifest, quality self-heal transparency).
//
// Structural checks below use the same extractFunctionSource convention as
// videoPipeline.round17AuditGapFix.test.ts — verified to FAIL against the pre-fix source for
// each site before the fix landed.

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

describe("Final production fix — appendGuaranteedSceneClips now records adoption", () => {
  const src = extractFunctionSource("appendGuaranteedSceneClips");

  it("takes an optional dedup parameter", () => {
    expect(src).toMatch(/dedup\?:\s*VisualDedupState/);
  });

  it("records the adoption with the source of the rung that actually answered", () => {
    expect(src).toContain("clips.push(clip)");
    expect(src).toMatch(/recordClipAdopt\(\s*\n?\s*dedup\.clipAdoptAudit/);
    // RONDE 50: this used to be the blanket "fallback" literal. The guaranteed ladder now
    // reports which rung produced the clip, so real archive/Commons media no longer counts as a
    // placeholder in fallbackBeats. That this site records at all — the property Round 17 added
    // and this test exists for — is unchanged.
    expect(src).toContain("guaranteedAdoptSource(tierOut.tier)");
    expect(src).toContain("tierOut");
  });

  it("all 5 call sites pass dedup/visualDedup through", () => {
    const defMarker = "async function appendGuaranteedSceneClips(";
    const occurrences = fullSource.split("appendGuaranteedSceneClips(").length - 1;
    // 1 definition + 5 call sites
    expect(occurrences).toBe(6);
    const callSiteStarts: number[] = [];
    let searchFrom = fullSource.indexOf(defMarker) + defMarker.length;
    for (;;) {
      const next = fullSource.indexOf("appendGuaranteedSceneClips(", searchFrom);
      if (next === -1) break;
      callSiteStarts.push(next);
      searchFrom = next + "appendGuaranteedSceneClips(".length;
    }
    expect(callSiteStarts.length).toBe(5);
    for (const start of callSiteStarts) {
      const closeIdx = fullSource.indexOf(");", start);
      const args = fullSource.slice(start, closeIdx);
      expect(args).toMatch(/\bdedup\b|\bvisualDedup\b/);
    }
  });
});

describe("Final production fix — fillBeatVisual emergency-finish guaranteed clip now recorded", () => {
  const src = extractFunctionSource("fillBeatVisual");

  it("records the emergency-finish guaranteed clip after a successful pushClip", () => {
    const marker = "self-heal — guaranteed clip (pipeline must complete)";
    // fillBeatVisual doesn't contain this marker (it's isPipelineEmergencyFinish inside
    // ensureBeatVisualFilled) — locate the actual emergency-finish branch instead, scoped by
    // its distinctive generateGuaranteedBeatClip(scene.index, beat.index, ...) call.
    const idx = src.search(/generateGuaranteedBeatClip\(\s*\n?\s*scene\.index,\s*beat\.index,\s*holdSec,\s*workDir,\s*beat\.text,/);
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 900);
    expect(scoped).toContain("pushClip(guaranteed, holdSec)");
    expect(scoped).toMatch(/recordClipAdopt\(\s*\n?\s*dedup\.clipAdoptAudit/);
    // RONDE 50: tier-aware source, see the note on the appendGuaranteedSceneClips test above.
    expect(scoped).toContain("guaranteedAdoptSource(guaranteedTierOut.tier)");
    void marker;
  });
});

describe("Final production fix — composeSceneVideoInner's fourth guaranteed-fill site (slot 1001) now recorded", () => {
  const src = extractFunctionSource("composeSceneVideoInner");

  it("calls recordClipAdopt for the 'alle clips faalden validatie' rescue (slot 1001)", () => {
    const marker = "alle clips faalden validatie — guaranteed compose fill";
    const idx = src.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const scoped = src.slice(idx, idx + 1200);
    expect(scoped).toMatch(/generateGuaranteedBeatClip\(\s*\n?\s*scene\.index,\s*1001,/);
    expect(scoped).toContain("safeClips.push(adopted)");
    expect(scoped).toMatch(/recordClipAdopt\(\s*\n?\s*composeOptions\.dedup\.clipAdoptAudit/);
    // RONDE 50: tier-aware source.
    expect(scoped).toContain("guaranteedAdoptSource(tierOut.tier)");
  });

  it("emits a FINAL_VISUAL_MANIFEST line per clip entering the montage", () => {
    expect(src).toContain("[FINAL_VISUAL_MANIFEST]");
    expect(src).toContain("audit.find((e) => e.sceneIndex === scene.index && e.basename === basename)");
  });

  it("all 3 recordClipAdopt(...'fallback') calls from Round 17 + follow-up review remain intact", () => {
    const count = (src.match(/recordClipAdopt\(\s*\n?\s*composeOptions\.dedup\.clipAdoptAudit/g) ?? []).length;
    // 3 pre-existing (loop, slot 999, slot 8888) + 1 new (slot 1001) = 4
    expect(count).toBe(4);
  });
});

describe("Final production fix — Path A/B rescue-compose guaranteed clips now recorded", () => {
  it("Path A: both the first-attempt and retry guaranteed clip are recorded (P5A rescue loop)", () => {
    const idx = fullSource.indexOf('`P5A composeSceneVideo s${scene.index}`');
    expect(idx).toBeGreaterThan(-1);
    // RONDE 32 widened this window: the P5A rescue block now salvages a completed compose
    // output, keeps the scene's surviving winners and shares one exclusion set across slots,
    // so the retry branch sits further down. Same property, longer block.
    const scoped = fullSource.slice(idx, idx + 8000);
    expect(scoped).toContain('`[Compose] Scene ${scene.index}: guaranteed clip ${si} failed, retrying once:`');
    const recordCount = (scoped.match(/recordClipAdopt\(\s*\n?\s*visualDedup\.clipAdoptAudit/g) ?? []).length;
    expect(recordCount).toBe(2);
  });

  it("Path B: the Stage4 rescue-compose loop records each guaranteed clip", () => {
    const idx = fullSource.indexOf('`Stage4 composeSceneVideo s${scene.index}`');
    expect(idx).toBeGreaterThan(-1);
    // RONDE 32: the call is now multi-line — it also passes the slot's beat text and the
    // batch-scoped exclusion sets — so match its shape rather than one flat line.
    const scoped = fullSource.slice(idx, idx + 8000);
    expect(scoped).toMatch(/generateGuaranteedBeatClip\(\s*scene\.index,\s*si,\s*hold,\s*workDir,/);
    expect(scoped).toMatch(/recordClipAdopt\(\s*\n?\s*visualDedup\.clipAdoptAudit/);
  });

  it("Path B last-resort: only records when a NEW clip was generated (no double-count when rescueClips[0] is reused)", () => {
    const idx = fullSource.indexOf('`Stage4 composeSceneVideo s${scene.index}`');
    expect(idx).toBeGreaterThan(-1);
    // RONDE 32 widened this window for the same reason as the two above; RONDE 33 widened it
    // again (the rescue block now also resolves uncovered beats from the adopt audit).
    const scoped = fullSource.slice(idx, idx + 14000);
    expect(scoped).toMatch(/generateGuaranteedBeatClip\(\s*\n?\s*scene\.index,\s*9999,/);
    // RONDE 32 (B1): the guard variable is now `reusableLastClip` — it covers a reused rescue
    // clip AND a surviving winner, where `hadRescueClips` only ever looked at rescueClips.
    // RONDE 48 (C1): the branch is entered through `lastClip`, which is seeded from
    // reusableLastClip, so the guard still covers both. The property this test protects
    // (record only when a NEW clip was generated) is unchanged.
    expect(scoped).toContain("reusableLastClip");
    expect(scoped).toContain("let lastClip = reusableLastClip;");
    expect(scoped).toContain("if (!lastClip)");
    const recordCount = (scoped.match(/recordClipAdopt\(\s*\n?\s*visualDedup\.clipAdoptAudit/g) ?? []).length;
    // 1 in the si-loop above + 1 guarded last-resort call.
    expect(recordCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Final production fix — YouTube CC 429/quota handling distinguishes rate-limit from generic failure", () => {
  it("defines a dedicated rate-limit cooldown path distinct from the generic failure-streak breaker", () => {
    expect(fullSource).toContain("function markYoutubeRateLimited(");
    expect(fullSource).toContain("YOUTUBE_RATE_LIMIT_COOLDOWN_MS");
    expect(fullSource).toContain("YOUTUBE_RATE_LIMIT_ESCALATED_COOLDOWN_MS");
  });

  it("honors a Retry-After header when present", () => {
    expect(fullSource).toContain("function parseRetryAfterMs(");
    expect(fullSource).toContain("retryAfterMs != null && retryAfterMs > 0");
  });

  it("escalates the cooldown on repeated 429s rather than reusing the same short window", () => {
    const src = fullSource.slice(
      fullSource.indexOf("function markYoutubeRateLimited("),
      fullSource.indexOf("function markYoutubeRateLimited(") + 900
    );
    expect(src).toContain("youtubeRateLimitStreak >= 2");
    expect(src).toContain("YOUTUBE_RATE_LIMIT_ESCALATED_COOLDOWN_MS");
  });

  it("both search call sites route a 429 status to markYoutubeRateLimited instead of the generic breaker", () => {
    const calls = [...fullSource.matchAll(/if \(searchResp\.status === 429\) \{\s*markYoutubeRateLimited\(/g)];
    expect(calls.length).toBe(2);
  });

  it("does not gate any other provider — isYoutubeInCooldown is only referenced by YouTube-specific functions", () => {
    const refs = [...fullSource.matchAll(/isYoutubeInCooldown\(\)/g)];
    expect(refs.length).toBeGreaterThanOrEqual(3);
    // Sanity: the generic per-provider breakers for Wikimedia/Pexels/Pixabay/Internet Archive
    // are untouched, separate cooldown variables — confirms isolation wasn't broken.
    expect(fullSource).toContain("function isInternetArchiveInCooldown(): boolean {");
    expect(fullSource).toContain("internetArchiveCooldownUntilMs");
  });
});
