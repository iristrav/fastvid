import { readFileSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RONDE 90 — this file calls provider fetchers directly, outside any beat.
 *
 * In production every provider search runs inside a beat's provenance scope
 * (withSearchProvenance), and that scope is what lets the gate verify a query against what the
 * script actually says. A direct call has no such scope, so strict mode refuses it — correctly,
 * and by design: a query nobody can trace is exactly what RONDE 90 exists to stop.
 *
 * That refusal is not what this file is about. Its subject is what happens AFTER a query is
 * admitted — the render-scoped query cache, the per-item licence gates, the dedup skips, the call
 * ceilings. The gate's own behaviour, including the refusal above, is covered by
 * ronde89ProviderGate and ronde90SearchProvenance; restating it in every assertion here would
 * test the gate twice and these mechanics not at all.
 */
// Set at module scope, not in beforeAll: several suites here snapshot `process.env` into an
// ORIGINAL_ENV constant while the file is being evaluated and restore it before every test, so a
// value written later is wiped again before the first assertion runs.
process.env.SEARCH_GATE_STRICT = "false";


// RONDE 50 — pre-render hardening.
//
// Three defects, all found by the Ronde-49 audit and all about the first real render being
// READABLE rather than about the pipeline producing prettier video:
//
//   1. fetchWikimediaImages stopped at a cached candidate pool even when an exclusion set had
//      already taken every entry in it. The pool lives in the database with a seven-day TTL and
//      is only as deep as the call that wrote it, so a two-entry pool from another render could
//      cap every later rescue at two candidates — permanently.
//   2. Every clip from the guaranteed ladder was recorded as source "fallback", including the
//      rungs that return real archive or Commons media. assertVisualCoverageExportGate reads
//      fallbackBeats/beatsFilled > 0.5, so a render the rescue ladder SAVED could be refused for
//      being mostly placeholders.
//   3. Stage4 published a rescue slot's beat mapping before the clip it describes existed.
//
// Plus the returnComposed coverage that Ronde 49 could only assert in a comment.

const SRC = () => readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The `{...}` block starting at `from`, matched by braces rather than a character window. */
function blockAt(src: string, from: number): string {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error("unbalanced block");
}

/**
 * RONDE 100B's second audit put a provenance wrapper in front of generateGuaranteedBeatClip, so
 * the ladder this file inspects moved into `...Inner`. Follow the wrapper — and verify it cannot
 * hide a second implementation from these tests.
 *
 * RONDE 103 gave that wrapper a second job: the ladder's two REAL rungs (`topical`, `wikimedia`)
 * fetch genuine imagery and now face the same relevance gate every other route faces, and the
 * tier the ladder returned is the only place that distinction is known. So "plain wrapper" is no
 * longer the right test — a wrapper may delegate and may judge, but it may not build a ladder of
 * its own. What this checks is exactly that: it delegates, and it assigns no tier itself.
 */
function functionBody(src: string, name: string): string {
  if (src.includes(`async function ${name}Inner(`)) {
    const wrapper = sliceBody(src, name);
    if (!wrapper.includes("withBeatProvenance") || !wrapper.includes(`${name}Inner(`)) {
      throw new Error(`${name} does not delegate to ${name}Inner under provenance — inspect it directly`);
    }
    if (/tierOut\.tier = "/.test(wrapper) || /\btier\.tier = "/.test(wrapper)) {
      throw new Error(`${name}'s wrapper assigns a tier — that is a second ladder, not a wrapper`);
    }
    return sliceBody(src, `${name}Inner`);
  }
  return sliceBody(src, name);
}

function sliceBody(src: string, name: string): string {
  const marker = [`export async function ${name}(`, `async function ${name}(`].find((m) =>
    src.includes(m)
  );
  if (!marker) throw new Error(`${name} not found`);
  const start = src.indexOf(marker);
  /**
   * RONDE 103: walk the parameter list by BALANCE, not to its first `)`.
   *
   * `src.indexOf(")", start)` finds the first close paren after the name, which stops inside the
   * first parameter that has parentheses of its own — a doc comment, a default, an inline
   * function type. blockAt then matches the next `{`, which is that parameter's object type
   * rather than the function's body, and the test reads a few lines of a type declaration while
   * appearing to read the implementation. That is a test that passes for the wrong reason.
   */
  const paramsAt = start + marker.length - 1;
  let depth = 0;
  let closeParen = -1;
  for (let i = paramsAt; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen < 0) throw new Error(`${name} has an unbalanced parameter list`);
  return blockAt(src, closeParen);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wikimedia cache-hit + exclusions — behavioural
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("./sceneCandidateCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sceneCandidateCache")>();
  return {
    ...actual,
    getCandidatePool: vi.fn(),
    putCandidatePool: vi.fn(async () => {}),
  };
});

// videoPipeline imports `fetch` from node-fetch (line ~121), not from globalThis — spying on the
// global would silently miss every request and let the real network answer instead.
const netlog = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node-fetch", () => ({
  __esModule: true,
  default: async (url: unknown) => {
    const u = String(url);
    netlog.calls.push(u);
    if (u.includes("list=search")) {
      // An empty result set is enough: the assertion is that the request HAPPENED at all.
      return { ok: true, status: 200, json: async () => ({ query: { search: [] } }) };
    }
    // Everything else (candidate downloads) fails fast — no disk, no ffmpeg, no network.
    return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
  },
}));

// Lets a cached candidate be "restored" without any network: the mock writes a real JPEG to the
// path the pipeline asked for and reports a hit, so the rest of the cached branch (ffmpeg
// still-to-video) runs for real. Defaults to a miss; individual tests opt in.
vi.mock("./mediaCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mediaCache")>();
  return { ...actual, tryRestoreFromMediaCache: vi.fn(async () => false), reportToMediaCache: vi.fn() };
});

const searchRequests = () => netlog.calls.filter((u) => u.includes("list=search"));

const CACHED_TWO = [
  {
    assetId: "File:Alpha.jpg",
    title: "File:Alpha.jpg",
    url: "https://upload.invalid/alpha.jpg",
    thumbnailUrl: null,
    contentType: "image/jpeg",
    durationSec: null,
    meta: {},
  },
  {
    assetId: "File:Beta.jpg",
    title: "File:Beta.jpg",
    url: "https://upload.invalid/beta.jpg",
    thumbnailUrl: null,
    contentType: "image/jpeg",
    durationSec: null,
    meta: {},
  },
];

describe("RONDE 50 #1 — a cached pool exhausted by exclusions no longer ends the search", () => {
  let dir: string;
  let sampleJpeg: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r50-wiki-"));
    sampleJpeg = path.join(dir, "sample.jpg");
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=c=steelblue:s=640x480", "-frames:v", "1", sampleJpeg],
      { stdio: "ignore" }
    );
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  afterEach(async () => {
    netlog.calls.length = 0;
    const { tryRestoreFromMediaCache } = await import("./mediaCache");
    vi.mocked(tryRestoreFromMediaCache).mockImplementation(async () => false);
  });

  it("issues the live search when every cached candidate is already excluded", async () => {
    const { getCandidatePool } = await import("./sceneCandidateCache");
    const { fetchWikimediaImages } = await import("./videoPipeline");
    vi.mocked(getCandidatePool).mockResolvedValue(CACHED_TWO as never);
    netlog.calls.length = 0;

    // Both cached URLs already taken by earlier rescue slots.
    const excludeUrls = new Set(CACHED_TWO.map((c) => c.url));
    await fetchWikimediaImages("berlin 1945", 3, dir, 1, 2, "r50", { excludeUrls });

    // Pre-fix this was 0: the function returned the (fully excluded) cached pool as if it were
    // the whole search space.
    expect(searchRequests().length).toBeGreaterThanOrEqual(1);
    // and the cached pool really was consulted first
    expect(vi.mocked(getCandidatePool)).toHaveBeenCalled();
  }, 60_000);

  it("asks Commons for the deeper result set, not the default ten", async () => {
    const { getCandidatePool } = await import("./sceneCandidateCache");
    const { fetchWikimediaImages } = await import("./videoPipeline");
    vi.mocked(getCandidatePool).mockResolvedValue(CACHED_TWO as never);
    netlog.calls.length = 0;

    const excludeUrls = new Set(CACHED_TWO.map((c) => c.url));
    await fetchWikimediaImages("berlin 1945", 3, dir, 2, 2, "r50", { excludeUrls });

    expect(searchRequests()[0]).toContain("srlimit=25");
  }, 60_000);

  it("does NOT issue a live search when no exclusion set is in play", async () => {
    const { getCandidatePool } = await import("./sceneCandidateCache");
    const { fetchWikimediaImages } = await import("./videoPipeline");
    vi.mocked(getCandidatePool).mockResolvedValue(CACHED_TWO as never);
    netlog.calls.length = 0;

    // Same cached pool, no exclusions: the cache is still the whole answer and the extra
    // request must not be made. This is the half of the fix that guarantees no new traffic.
    await fetchWikimediaImages("berlin 1945", 3, dir, 3, 2, "r50", {});

    expect(searchRequests().length).toBe(0);
  }, 60_000);

  it("does NOT issue a live search when the cached pool still satisfies the request", async () => {
    const { getCandidatePool } = await import("./sceneCandidateCache");
    const { tryRestoreFromMediaCache } = await import("./mediaCache");
    const { fetchWikimediaImages } = await import("./videoPipeline");
    vi.mocked(getCandidatePool).mockResolvedValue(CACHED_TWO as never);

    // Both cached candidates are genuinely usable: the media cache hands back a real JPEG and
    // ffmpeg turns it into a clip, so the call reaches `count` without touching the network.
    vi.mocked(tryRestoreFromMediaCache).mockImplementation(async (_url: string, dest: string) => {
      fs.copyFileSync(sampleJpeg, dest);
      return true;
    });
    netlog.calls.length = 0;

    // Exclusions ARE active — they just do not hit either cached candidate. This is the case
    // §2B protects: no extra request when the pool already answers the question.
    const results = await fetchWikimediaImages("berlin 1945", 2, dir, 4, 2, "r50sat", {
      excludeUrls: new Set(["https://upload.invalid/unrelated.jpg"]),
    });

    expect(results.length).toBe(2);
    expect(searchRequests().length).toBe(0);
  }, 180_000);

  it("count=0 is trivially satisfied and also issues nothing", async () => {
    const { getCandidatePool } = await import("./sceneCandidateCache");
    const { fetchWikimediaImages } = await import("./videoPipeline");
    vi.mocked(getCandidatePool).mockResolvedValue(CACHED_TWO as never);
    netlog.calls.length = 0;

    await fetchWikimediaImages("berlin 1945", 3, dir, 5, 0, "r50", { excludeUrls: new Set() });

    expect(searchRequests().length).toBe(0);
  }, 60_000);

  it("the fall-through is bounded by the same scan cap as the cache-miss path", () => {
    const body = functionBody(SRC(), "fetchWikimediaImages");
    expect(body).toContain("if (!excludeUrls || results.length >= count) return results;");
    // No second cache layer, no retry loop, no pagination — one live search, same ceiling.
    expect(body).toContain("const searchLimit = excludeUrls ? WIKIMEDIA_MAX_CANDIDATE_SCAN : 10;");
    expect((body.match(/list=search/g) ?? []).length).toBe(1);
    // Clips already adopted from the cached pool survive the fall-through.
    expect(body).not.toContain("return [];");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Guaranteed tier classification
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 50 #2 — the guaranteed ladder reports which rung answered", () => {
  it("maps each tier onto a source clipAdoptAudit already classifies", async () => {
    const { guaranteedAdoptSource, isPlaceholderGuaranteedTier } = await import("./videoPipeline");
    expect(guaranteedAdoptSource("topical")).toBe("rescue_archive");
    /**
     * RONDE 90: this rung used to return the bare "wikimedia" — the same label the real Wikimedia
     * RETRIEVAL route uses — so a last-resort rescue image and a retrieved, ranked, judged Commons
     * asset were recorded identically, and adoptRouteForSource called both "primary". Render 568
     * reported the consequence as `wikimedia retrieved=400 eligible=0 adopted=2 finalVideo=1`.
     *
     * RONDE 50's claim is unchanged and asserted below: the rung returns REAL media and must not
     * count as a fallback beat. Only the route label is corrected, and it now matches the "rescue_"
     * shape its sibling rung already had.
     */
    expect(guaranteedAdoptSource("wikimedia")).toBe("rescue_wikimedia");
    expect(guaranteedAdoptSource("wikimedia")).not.toBe("wikimedia");
    expect(guaranteedAdoptSource("text_overlay")).toBe("fallback");
    expect(guaranteedAdoptSource("color_fallback")).toBe("fallback");
    // A caller that passes no out-parameter keeps the old answer exactly.
    expect(guaranteedAdoptSource(undefined)).toBe("fallback");

    expect(isPlaceholderGuaranteedTier("topical")).toBe(false);
    expect(isPlaceholderGuaranteedTier("wikimedia")).toBe(false);
    expect(isPlaceholderGuaranteedTier("text_overlay")).toBe(true);
    expect(isPlaceholderGuaranteedTier("color_fallback")).toBe(true);
    expect(isPlaceholderGuaranteedTier(undefined)).toBe(true);
  });

  it("the audit counts real rescue media as archive/wiki and placeholders as fallback", async () => {
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    const { guaranteedAdoptSource } = await import("./videoPipeline");

    const audit = createClipAdoptAudit();
    // Four beats saved by the ladder with REAL media, one genuine colour card.
    recordClipAdopt(audit, 0, 0, "b0", "/w/a.mp4", guaranteedAdoptSource("topical"));
    recordClipAdopt(audit, 0, 1, "b1", "/w/b.mp4", guaranteedAdoptSource("topical"));
    recordClipAdopt(audit, 0, 2, "b2", "/w/c.mp4", guaranteedAdoptSource("wikimedia"));
    recordClipAdopt(audit, 0, 3, "b3", "/w/d.mp4", guaranteedAdoptSource("wikimedia"));
    recordClipAdopt(audit, 0, 4, "b4", "/w/e.mp4", guaranteedAdoptSource("color_fallback"));

    const summary = summarizeAdoptAudit(audit);
    expect(summary.beatsFilled).toBe(5);
    // Pre-fix every one of these five was "fallback" — 5/5, a guaranteed majority-fallback.
    expect(summary.fallbackBeats).toBe(1);
  });

  it("each of the four rungs lands on the right side of the fallback count", async () => {
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    const { guaranteedAdoptSource } = await import("./videoPipeline");

    // One beat per rung, so each tier's effect on fallbackBeats is isolated rather than inferred
    // from a mixed total. This is the end the export gate actually reads.
    const per = (tier: Parameters<typeof guaranteedAdoptSource>[0]) => {
      const audit = createClipAdoptAudit();
      recordClipAdopt(audit, 0, 0, "b", "/w/x.mp4", guaranteedAdoptSource(tier));
      return summarizeAdoptAudit(audit);
    };

    // A — the topical rung returned curated ARCHIVE footage: real media, not a placeholder.
    expect(per("topical").fallbackBeats).toBe(0);
    expect(per("topical").archiveBeats).toBe(1);
    // B — the Wikimedia rung returned a Commons file: real media, counted as wiki.
    //     RONDE 90 renamed the ROUTE to rescue_wikimedia; the MEDIA is still a Commons file, so
    //     both of these still hold. That is the whole point of separating route from provider.
    expect(per("wikimedia").fallbackBeats).toBe(0);
    expect(per("wikimedia").wikiBeats).toBe(1);
    // C — a text-over-gradient card is a placeholder and must still count as one.
    expect(per("text_overlay").fallbackBeats).toBe(1);
    // D — so is a plain colour card.
    expect(per("color_fallback").fallbackBeats).toBe(1);
  });

  it("a render the ladder saved with real media now passes the export gate", async () => {
    const { assertVisualCoverageExportGate } = await import("./videoQualityReport");
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    const { guaranteedAdoptSource } = await import("./videoPipeline");

    const audit = createClipAdoptAudit();
    for (let b = 0; b < 4; b++) {
      recordClipAdopt(audit, 0, b, `b${b}`, `/w/${b}.mp4`, guaranteedAdoptSource("topical"));
    }
    recordClipAdopt(audit, 0, 4, "b4", "/w/4.mp4", guaranteedAdoptSource("color_fallback"));

    const report = {
      generatedAt: new Date().toISOString(),
      videoTitle: "t",
      visualTopic: "history",
      totalClips: 5,
      bySource: {},
      byMixKind: {} as never,
      wikimediaCount: 0,
      archiveCount: 4,
      stockCount: 0,
      warnings: [],
      offTopicSuspects: [],
      adoptAuditSummary: summarizeAdoptAudit(audit),
    } as never;

    expect(() => assertVisualCoverageExportGate(report, 0)).not.toThrow();
  });

  it("a render that really is mostly colour cards is still blocked", async () => {
    const { assertVisualCoverageExportGate } = await import("./videoQualityReport");
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    const { guaranteedAdoptSource } = await import("./videoPipeline");

    const audit = createClipAdoptAudit();
    for (let b = 0; b < 4; b++) {
      recordClipAdopt(audit, 0, b, `b${b}`, `/w/${b}.mp4`, guaranteedAdoptSource("color_fallback"));
    }
    recordClipAdopt(audit, 0, 4, "b4", "/w/4.mp4", guaranteedAdoptSource("topical"));

    const report = {
      generatedAt: new Date().toISOString(),
      videoTitle: "t",
      visualTopic: "history",
      totalClips: 5,
      bySource: {},
      byMixKind: {} as never,
      wikimediaCount: 0,
      archiveCount: 1,
      stockCount: 0,
      warnings: [],
      offTopicSuspects: [],
      adoptAuditSummary: summarizeAdoptAudit(audit),
    } as never;

    // The gate must not have become permissive — this is the case it exists for.
    expect(() => assertVisualCoverageExportGate(report, 0)).toThrow(
      /insufficient real visual coverage/
    );
  });

  it("every rung of the ladder sets the tier, and only the two real ones map to real sources", () => {
    const body = functionBody(SRC(), "generateGuaranteedBeatClip");
    expect(body).toContain('if (tierOut) tierOut.tier = "topical";');
    expect(body).toContain('if (tierOut) tierOut.tier = "wikimedia";');
    expect(body).toContain('if (tierOut) tierOut.tier = "text_overlay";');
    expect((body.match(/tierOut\.tier = "color_fallback";/g) ?? []).length).toBe(2);
    // No adoption in the pipeline still hard-codes the old blanket label.
    const src = SRC();
    expect(src).not.toMatch(/recordClipAdopt\([^)]*generateGuaranteed/);
    const blanket = src.match(/recordClipAdopt\([\s\S]{0,200}?,\s*"fallback"\s*[,)]/g) ?? [];
    expect(blanket).toHaveLength(0);
  });
});

describe("RONDE 50 #2 — the tier is set at runtime, not just in the source", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r50-tier-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("reports color_fallback when there is nothing to search for and no text to draw", async () => {
    const { generateGuaranteedBeatClip } = await import("./videoPipeline");
    const tierOut: { tier?: string } = {};
    // No beat text and no render-scoped topic ⇒ the escalation tiers are empty, no provider is
    // contacted, the text-overlay rung has nothing to draw, and the ladder lands on its card.
    const clip = await generateGuaranteedBeatClip(
      7001, 0, 3, dir, undefined, undefined, undefined, tierOut as never
    );
    expect(fs.existsSync(clip)).toBe(true);
    expect(tierOut.tier).toBe("color_fallback");
  }, 180_000);

  it("that clip is classified as a placeholder, so the gate still sees it", async () => {
    const { guaranteedAdoptSource, isPlaceholderGuaranteedTier } = await import("./videoPipeline");
    expect(guaranteedAdoptSource("color_fallback")).toBe("fallback");
    expect(isPlaceholderGuaranteedTier("color_fallback")).toBe(true);
  });

  it("a guaranteed clip is still muxed with an audio track by the last-resort compose", async () => {
    const { generateGuaranteedBeatClip, composeLastResortSceneFromClip } = await import(
      "./videoPipeline"
    );
    const clip = await generateGuaranteedBeatClip(7002, 0, 3, dir);
    // No audio file on disk: the helper must generate a silent track rather than ship a mute
    // scene. Ronde 34 point 7 relies on this, and the tier change must not have touched it.
    const out = await composeLastResortSceneFromClip(7002, 3, clip, path.join(dir, "missing.mp3"), dir);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(1_000);
    expect(fs.existsSync(path.join(dir, "scene_7002_lastresort_silent.mp3"))).toBe(true);
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. returnComposed coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 50 #3 — no compose output can be published without its clip list", () => {
  it("every value-returning path that hands back a compose output goes through returnComposed", () => {
    const body = functionBody(SRC(), "composeSceneVideoInner");
    const returns = [...body.matchAll(/\breturn\s+([^\n;]+);/g)].map((m) => m[1].trim());
    // Everything that hands back the compose output itself.
    const outputReturns = returns.filter(
      (r) => r.includes("outputPath") || r.includes("returnComposed") || /composed/i.test(r)
    );
    expect(outputReturns.length).toBeGreaterThanOrEqual(7);
    for (const r of outputReturns) {
      // RONDE 158 made the funnel async (it now measures the finished scene before publishing it),
      // so the call is awaited. The rule is unchanged: nothing hands back a compose output except
      // through the funnel.
      expect(r).toMatch(/^(await\s+)?returnComposed\(/);
    }
    // A bare `return outputPath;` would bypass the publication entirely.
    expect(returns).not.toContain("outputPath");
  });

  it("the clip list is published in exactly one place, inside returnComposed", () => {
    const body = functionBody(SRC(), "composeSceneVideoInner");
    const publishes = [...body.matchAll(/usedClipsOut\.push\(/g)];
    expect(publishes).toHaveLength(1);
    const funnel = body.indexOf("const returnComposed =");
    expect(funnel).toBeGreaterThan(-1);
    const funnelBlock = blockAt(body, funnel);
    expect(funnelBlock).toContain("usedClipsOut.push(...pendingUsedClips);");
    // ...and it is staged, not published, where the old code published it.
    expect(body).toContain("pendingUsedClips = uniqueClipsInOrder(safeClips);");
    const firstReturn = body.indexOf("return await returnComposed(");
    expect(firstReturn).toBeGreaterThan(-1);
    expect(body.indexOf("pendingUsedClips = uniqueClipsInOrder")).toBeLessThan(firstReturn);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Rescue beat mapping — both paths publish after the clip exists
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 50 #4 — a beat mapping is published only once its clip exists", () => {
  const stage4Block = (src: string) => {
    const idx = src.indexOf("`Stage4 rescue-compose s${scene.index}`");
    expect(idx).toBeGreaterThan(-1);
    // The rescue slot loop sits above the compose call that carries this label.
    const loop = src.lastIndexOf("for (let si = 0; si < missing; si++) {", idx);
    expect(loop).toBeGreaterThan(-1);
    return blockAt(src, loop);
  };

  it("Stage4 pushes the mapping after the guaranteed call returns, like P5A already did", () => {
    const block = stage4Block(SRC());
    const generate = block.indexOf("generateGuaranteedBeatClip(");
    const push = block.indexOf("rescueBeatIndices.push(");
    expect(generate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(generate);
    // The clip itself is still pushed first, so the two arrays stay index-aligned.
    const clipPush = block.indexOf("rescueClips.push(rescueClip);");
    expect(clipPush).toBeGreaterThan(generate);
    expect(push).toBeGreaterThan(clipPush);
  });

  it("both rescue paths agree: generate, then map", () => {
    const src = SRC();
    const p5aIdx = src.indexOf("`P5A composeSceneVideo s${scene.index}`");
    const p5aLoop = src.indexOf("for (let si = 0; si < missing; si++) {", p5aIdx);
    for (const block of [blockAt(src, p5aLoop), stage4Block(src)]) {
      const generate = block.indexOf("generateGuaranteedBeatClip(");
      const push = block.indexOf("rescueBeatIndices.push(");
      expect(push).toBeGreaterThan(generate);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Curated dedup through the real resolver
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 50 #5 — the same storage file cannot be adopted twice in one render", () => {
  it("resolves the URL from render state and excludes the second attempt", async () => {
    const { curatedStorageUrlForClip } = await import("./videoPipeline");
    const { markCuratedAssetUsed } = await import("./curatedMediaSourcing");

    const dedup = {
      archiveCandidatePool: [{ asset: { id: 55988, storageUrl: "https://cdn/shared.mp4" } }],
      archiveAssetsCache: new Map(),
      curatedStorageUrlById: new Map<number, string>(),
    } as never as import("./videoPipeline").VisualDedupState;

    const ids = new Set<number>();
    const urls = new Set<string>();

    // First adoption: the URL comes from the asset row, never from the filename.
    const url = curatedStorageUrlForClip("/w/a_curated_a55988.mp4", dedup);
    expect(url).toBe("https://cdn/shared.mp4");
    markCuratedAssetUsed("/w/a_curated_a55988.mp4", ids, urls, url);

    // A DIFFERENT row pointing at the same file is now excluded — the case asset-id dedup
    // alone never caught, and the one Ronde 34 point 1 exists for.
    expect(urls.has("https://cdn/shared.mp4")).toBe(true);
    expect(ids.has(55988)).toBe(true);
  });

  it("a miss stays memoised — a known, deliberate limitation, asserted so it cannot drift silently", async () => {
    const { curatedStorageUrlForClip } = await import("./videoPipeline");

    const pool: Array<{ asset: { id: number; storageUrl: string } }> = [];
    const dedup = {
      archiveCandidatePool: pool,
      archiveAssetsCache: new Map(),
      curatedStorageUrlById: new Map<number, string>(),
    } as never as import("./videoPipeline").VisualDedupState;

    // Asset not loaded yet: no URL, and the miss is remembered as "".
    expect(curatedStorageUrlForClip("/w/a_curated_a77.mp4", dedup)).toBeUndefined();

    // It arrives later in the render...
    pool.push({ asset: { id: 77, storageUrl: "https://cdn/late.mp4" } });

    // ...and is still not resolved. This is the documented trade-off: a miss costs one scan per
    // asset instead of one per adoption. It is never WORSE than the pre-Ronde-34 behaviour
    // (which marked nothing at all), it just does not always reach its goal.
    expect(curatedStorageUrlForClip("/w/a_curated_a77.mp4", dedup)).toBeUndefined();
  });
});
