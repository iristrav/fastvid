/**
 * RONDE 104 — the seven things the RONDE 103 round left behind.
 *
 * Six of them were found by looking at the code with the new architecture in place; one was found
 * because my own change broke a test that had been passing for the wrong reason. They are grouped
 * here because they share one theme: after RONDE 103 made the vision model the content decider,
 * everything ELSE that still quietly decided content, or still quietly duplicated a decision, is
 * a leftover from the world where the model had no reach.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const QUALITY_GATE = fs.readFileSync(path.join(__dirname, "visualQualityGate.ts"), "utf8");
const EMBEDDING = fs.readFileSync(path.join(__dirname, "archiveClipEmbedding.ts"), "utf8");
const RELEVANCE = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");

/* ═══════════ 1. the last judge that decided without seeing the picture ═══════════ */

describe("RONDE 104 #1 — a filename may flag footage, it may not refuse it", () => {
  it("the off-topic-protest heuristic no longer costs a clip its place", () => {
    /**
     * RONDE 29 added this because a "white lives matter" roadside clip went under narration about
     * the Battle of Berlin, and it reads the provider's title or the asset's own slug to catch it.
     * It sat in front of CLIP, whose content verdicts on this material are inverted, so a cheap
     * word-match ahead of a bad judge was a net gain.
     *
     * It now sits in front of a model that looks at the frame, where it can only take material
     * away: a clip the model would have accepted, binned on a word in its filename. Same pattern
     * RONDE 103 removed from CLIP — it survived only because it was not called CLIP.
     */
    const start = PIPELINE.indexOf("const isOffTopicProtest = beatClipIsOffTopicProtest(");
    expect(start).toBeGreaterThan(-1);
    const block = PIPELINE.slice(start, start + 700);
    // Still measured, so the gate-firing stats can show how often it WOULD have fired.
    expect(block).toContain('recordGateVerdict("off_topic_protest", isOffTopicProtest)');
    // ...and no longer decisive.
    expect(block).not.toContain('recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, "off_topic_protest"');
    expect(block).toContain("flagged, not rejected");
  });

  it("the baked-text check KEEPS its veto — a chyron is a defect, not an opinion", () => {
    const start = PIPELINE.indexOf("const hasBakedText = await beatClipHasBakedText(clipPath);");
    expect(start).toBeGreaterThan(-1);
    const block = PIPELINE.slice(start, start + 700);
    expect(block).toContain('recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, "baked_text"');
    expect(block).toContain("return { pass: false");
  });

  it("no reject reason in the pipeline is decided by reading a filename any more", () => {
    // vision_gate went in RONDE 103; off_topic_protest goes here. baked_text reads the PIXELS.
    for (const reason of ['"vision_gate"', '"off_topic_protest"']) {
      const rejects = PIPELINE.match(new RegExp(`recordClipReject\\([^)]*${reason}`, "g")) ?? [];
      expect(rejects, `${reason} still rejects`).toHaveLength(0);
    }
  });
});

/* ═══════════ 2. the veto is not lying around any more ═══════════ */

describe("RONDE 104 #2 — the dead CLIP veto is gone, not just unused", () => {
  it("clipPassesVisionGate no longer exists", () => {
    // It was the boolean-only wrapper around CLIP. Leaving an exported function whose whole job
    // is "turn a CLIP score into a yes/no" is leaving the veto within reach.
    expect(QUALITY_GATE).not.toContain("export async function clipPassesVisionGate(");
    expect(PIPELINE).not.toContain("clipPassesVisionGate(");
  });

  it("scoreAssetClipSimilarity no longer exists", () => {
    expect(EMBEDDING).not.toContain("export async function scoreAssetClipSimilarity(");
  });

  it("the CLIP entry points that remain are the ranking and technical ones", () => {
    // What CLIP is genuinely good at, kept deliberately.
    expect(EMBEDDING).toContain("export async function preRankCuratedCandidatesByClipEmbedding");
    expect(EMBEDDING).toContain("export function scoreAssetClipPreRank");
    expect(QUALITY_GATE).toContain("export async function evaluateClipVisionGate(");
  });
});

/* ═══════════ 3. dead weight ═══════════ */

describe("RONDE 104 #3 — the dead functions are gone", () => {
  const REMOVED = [
    "generateHiggsfieldTextToVideoClip",
    "generateHiggsfieldImageToVideoClip",
    "buildEventVideoQueries",
    "beatsBelongTogether",
    "pickMontageExpansionClip",
    "stretchMontageDurations",
    "dedupeMontageClipsByContentKey",
    "dedupeAdjacentMontageClips",
    "expandClipsForSceneDuration",
    "extractTopicStockQueries",
    "extractVideoTopicAnchors",
    "adoptPexelsBeatClipFallback",
    "renderIntroCard",
    "renderOutroCard",
    "renderIntroCardFFmpeg",
    "renderOutroCardFFmpeg",
    "prepareMontageDurationsForVoice",
    "loadArchiveCandidatePool",
    "fetchMuskGoldenStockBeat",
  ];

  it("none of them is declared any more", () => {
    for (const name of REMOVED) {
      expect(PIPELINE, `${name} still declared`).not.toMatch(
        new RegExp(`^(export )?(async )?function ${name}\\s*[(<]`, "m")
      );
    }
  });

  it("and none of them is called, so nothing was orphaned", () => {
    for (const name of REMOVED) {
      expect(PIPELINE, `${name} still called`).not.toContain(`${name}(`);
    }
  });

  it("removing them left no orphaned function bodies behind", () => {
    /**
     * The first attempt at this cleanup DID orphan three bodies: the remover matched the `{` of
     * an inline object RETURN TYPE instead of the body brace, cut the signature, and left the
     * body as a bare block. TypeScript caught it; this makes sure nobody has to rely on that.
     */
    const orphans = PIPELINE.split("\n").filter((l, i, all) =>
      /^\s?\{\s*$/.test(l) && i > 0 && all[i - 1]!.trim() === ""
    );
    expect(orphans).toEqual([]);
  });

  it("the still-referenced neighbours survived", () => {
    // extractVideoTopicAnchorsWithKey shares a prefix with a deleted function and is live.
    expect(PIPELINE).toContain("function extractVideoTopicAnchorsWithKey(");
    expect(PIPELINE).toContain("extractVideoTopicAnchorsWithKey(videoTitle ?? \"\", beat.text)");
  });
});

/* ═══════════ 4. a test that could pass for the wrong reason ═══════════ */

describe("RONDE 104 #4 — source-reading helpers find the BODY, not a return type", () => {
  const HELPERS = [
    "archiveCoverageCalibration.ronde36.test.ts",
    "ronde56YoutubeMetaCache.test.ts",
    "videoPipeline.ronde50PreRenderHardening.test.ts",
  ];

  it("none of them still walks to the first close-paren", () => {
    /**
     * `indexOf(")", start)` stops inside the first parameter that has parentheses of its own — a
     * doc comment, a default, an inline function type. The `{` matched after that can be an
     * inline object return type, and the test then reads a few lines of a type declaration while
     * appearing to read the implementation.
     *
     * Found because a RONDE 103 signature change broke one of them. The other two were one
     * doc-comment away from the same silence.
     */
    for (const f of HELPERS) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      const code = src
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      expect(code, `${f} still uses the fragile pattern`).not.toContain('indexOf(")", start)');
    }
  });

  it("they balance the parameter list and take the last brace on the signature line", () => {
    for (const f of HELPERS.slice(0, 2)) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(src).toContain("function signatureBodyBrace(");
      expect(src).toContain('else if (src[i] === ")" && --depth === 0) break;');
      expect(src).toContain("line.lastIndexOf(\"{\")");
    }
  });
});

/* ═══════════ 5. a verdict outlives the render that paid for it ═══════════ */

describe("RONDE 104 #5 — the durable verdict store", () => {
  it("is consulted BEFORE the render budget is checked", () => {
    /**
     * A stored verdict costs nothing, so refusing to read it because the budget is spent buys
     * nothing and leaves the render blinder. Order matters and is asserted, not assumed.
     */
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    const lookup = src.indexOf("const stored = await lookupVerdict(seenKey)");
    const budget = src.indexOf("state.judgementsUsed >= maxBeatImageJudgementsPerRender()");
    expect(lookup).toBeGreaterThan(-1);
    expect(budget).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(budget);
  });

  it("stores only real answers — never `unknown`", () => {
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(src).toContain('if (judgement.verdict !== "unknown") {');
    expect(src).toContain("void persistVerdict(seenKey,");
    const store = fs.readFileSync(path.join(__dirname, "beatRelevanceVerdictStore.ts"), "utf8");
    expect(store).toContain('verdict: "fits" | "does_not_fit"');
  });

  it("is keyed on the same (picture, narration) pair the render cache uses", () => {
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(src).toContain("const seenKey = `${contentKey}|${params.beatIdentity ?? \"\"}`;");
    expect(src).toContain("lookupVerdict(seenKey)");
    expect(src).toContain("persistVerdict(seenKey,");
  });

  it("degrades to a no-op with no database, and can never change a verdict", async () => {
    vi.resetModules();
    vi.doMock("./db", () => ({ getDb: async () => null }));
    const store = await import("./beatRelevanceVerdictStore");
    store.__resetVerdictStoreForTests();
    expect(await store.lookupVerdict("k|b")).toBeNull();
    expect(await store.persistVerdict("k|b", "fits", "d", "r")).toBe(false);
    vi.doUnmock("./db");
    vi.resetModules();
  });

  it("the RENDER budget stays render-scoped even though verdicts no longer are", () => {
    /**
     * RONDE 58 made the whole gate state render-scoped so two concurrent renders could not read
     * each other's verdicts OR spend each other's budget. RONDE 104 deliberately breaks the first
     * half and keeps the second, and that split has to be stated somewhere a reader will find it.
     *
     * "Does this picture belong under this sentence" does not depend on who is asking, so
     * isolating it bought nothing and cost a re-render every answer it already owned. How many
     * judgements a render may pay for IS render state, and nothing else may draw on it.
     */
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain("this map is render-scoped; the VERDICTS in it are not");
    // Spend still lives on the per-render state and is created fresh with it.
    expect(gate).toContain("judgementsUsed: 0,");
    expect(gate).toContain("export function createBeatImageGateState()");
    // The store must not touch render budget in CODE. Its prose explains what it is NOT, so the
    // comments are stripped before asking — an assertion that reads documentation is not a test.
    const storeCode = fs
      .readFileSync(path.join(__dirname, "beatRelevanceVerdictStore.ts"), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const forbidden of ["judgementsUsed", "BeatImageGateState", "maxBeatImageJudgements"]) {
      expect(storeCode, `the store touches render budget via ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the in-process cache is bounded", () => {
    const store = fs.readFileSync(path.join(__dirname, "beatRelevanceVerdictStore.ts"), "utf8");
    expect(store).toContain("const CACHE_MAX_ENTRIES = 5000;");
    expect(store).toContain("while (cache.size > CACHE_MAX_ENTRIES)");
  });

  it("a stored verdict expires, so a better model eventually reaches the whole archive", () => {
    const store = fs.readFileSync(path.join(__dirname, "beatRelevanceVerdictStore.ts"), "utf8");
    expect(store).toContain("const VERDICT_TTL_DAYS = 90;");
    expect(store).toContain("DATE_SUB(NOW(), INTERVAL ${VERDICT_TTL_DAYS} DAY)");
  });
});

/* ═══════════ 6. YouTube joins the ledger ═══════════ */

describe("RONDE 104 #6 — the YouTube pre-pool verdict is written down", () => {
  it("records into the ledger under the clip's content identity", () => {
    const idx = PIPELINE.indexOf("async function youtubeClipPassesImageGate(");
    const body = PIPELINE.slice(idx, PIPELINE.indexOf("\nexport async function", idx));
    expect(body).toContain("recordExternalRelevanceVerdict(");
    expect(body).toContain('"youtube_prepool"');
    expect(body).toContain("clipContentKey(clipPath),");
  });

  it("every caller that supplies the gate state also supplies the ledger", () => {
    const withGate = PIPELINE.split("imageGate: dedup.beatImageGate,").length - 1;
    const withLedger = PIPELINE.split("relevanceLedger: dedup.beatRelevance").length - 1;
    expect(withGate).toBeGreaterThanOrEqual(8);
    expect(withLedger).toBe(withGate);
  });

  it("the recorder writes a decision down but never makes one", () => {
    const idx = RELEVANCE.indexOf("export function recordExternalRelevanceVerdict(");
    expect(idx).toBeGreaterThan(-1);
    const body = RELEVANCE.slice(idx, RELEVANCE.indexOf("\n}", idx));
    expect(body).toContain('allowed: judgement.verdict !== "does_not_fit"');
    // No model call, no frame extraction, no budget spend.
    for (const forbidden of ["judgeBeatImage", "sampleFrames", "judgementsUsed", "await "]) {
      expect(body, `recorder does ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("a `file:` key is still not indexed by content — it cannot survive a rename", () => {
    const idx = RELEVANCE.indexOf("export function recordExternalRelevanceVerdict(");
    const body = RELEVANCE.slice(idx, RELEVANCE.indexOf("\n}", idx));
    expect(body).toContain('!contentKey.startsWith("file:")');
  });
});

/* ═══════════ 7. the reprieve bookkeeping ═══════════ */

describe("RONDE 104 #7 — one record of the verdict, one record of the requeue", () => {
  it("the loop's own set is about re-offering, not about the verdict", () => {
    /**
     * I reported this as duplicate state and it is not. The ledger records a VERDICT — "the gate
     * refused this picture on this beat". The loop's set records "I have already re-offered this
     * one", which is different bookkeeping about the same product rule.
     *
     * Deriving one from the other is a real regression: a clip that a DIFFERENT route refused
     * earlier on the same beat would be adopted immediately instead of being put last, and the
     * whole point of the reprieve is that a refused picture is the last resort, not the first.
     */
    expect(PIPELINE).toContain("const requeuedAfterRefusal = new Set<string>();");
    expect(PIPELINE).toContain("!requeuedAfterRefusal.has(p) &&");
    expect(PIPELINE).toContain("requeuedAfterRefusal.add(p);");
    expect(PIPELINE).not.toContain("gateReprieved");
    // The reasoning is written down where the next person will look for it.
    expect(PIPELINE).toContain("RONDE 104 looked at whether this duplicated the relevance ledger");
  });

  it("both reprieve paths still record the override against the clip, not as a pass", () => {
    const calls = PIPELINE.split("reprieveBeatClip(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
    const idx = RELEVANCE.indexOf("export function reprieveBeatClip(");
    const body = RELEVANCE.slice(idx, RELEVANCE.indexOf("\n}", idx));
    expect(body).toContain("allowed: true, reprieved: true");
    expect(body).not.toContain('verdict: "fits"');
  });

  it("the speculative helper I nearly shipped is not there", () => {
    // refusedOnBeat() existed for about ten minutes and would have caused exactly the ordering
    // regression above. An unused export that encodes a wrong idea is worse than no export.
    expect(RELEVANCE).not.toContain("export function refusedOnBeat(");
  });
});
