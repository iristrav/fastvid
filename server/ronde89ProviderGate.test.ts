import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SearchGateAudit,
  emptyQueryContext,
  isVerifiedSearchQuery,
  legacyQueryTicket,
  mintVerifiedQuery,
  provenToken,
  searchGateStrict,
  formatSearchGateReport,
} from "./searchQueryContract";
import { admitProviderQuery, buildVerifiedQueryContextForBeat, typedQueryPrefix } from "./videoPipeline";

/**
 * RONDE 89 — no content query reaches a provider except through the gate.
 *
 * The RONDE 88 report answered "can an unverified term still reach a provider?" with "yes,
 * partially", and this round is that answer's follow-up. The audit found EIGHT provider searches
 * that never passed the gate at all:
 *
 *   fetchBrollClips · fetchWikimediaImages · fetchWikimediaImagesV1 · fetchYouTubeThumbnails
 *   fetchSerpAPIImages · fetchOpenverseImages · fetchUnsplashImages · searchYoutubeViaRapidApi
 *
 * Openverse and Unsplash did not even use the timeout wrapper — they called `fetch` directly.
 */

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CONTRACT_SRC = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
const PLAN_SRC = fs.readFileSync(path.join(__dirname, "visualSearchPlan.ts"), "utf8");

/** The provider searches this round had to bring inside the gate. */
const FORMERLY_BYPASSING = [
  "fetchBrollClips",
  "fetchWikimediaImages",
  "fetchWikimediaImagesV1",
  // RONDE 97 removed fetchYouTubeThumbnails: it turned a YouTube search-result still into an mp4
  // with a ken-burns pan and handed it on as footage. A route that no longer exists cannot bypass
  // the gate, and ronde97YouTubeVideoOnly asserts it stays gone.
  "fetchSerpAPIImages",
  "fetchOpenverseImages",
  "fetchUnsplashImages",
  "searchYoutubeViaRapidApi",
  "searchWebWideVideoClips",
];

const provenCtx = () => {
  const ctx = emptyQueryContext();
  ctx.persons.push(provenToken("Hitler", "person", "beat_text"));
  ctx.places.push(provenToken("Berlin", "place", "beat_text"));
  return ctx;
};

/* ═══════════ §1/§19 — no search escapes the gate ═══════════ */

describe("RONDE 89 §1/§19 — every provider search passes the gate", () => {
  it("TEST 1 — each formerly bypassing fetcher now consults the gate", () => {
    for (const fn of FORMERLY_BYPASSING) {
      const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
      expect(idx, `${fn} not found`).toBeGreaterThan(-1);
      const body = PIPELINE_SRC.slice(idx, idx + 9000);
      expect(body, `${fn} still reaches a provider without the gate`).toContain("admitProviderQuery(");
    }
  });

  it("TEST 2 — the gate and the cached search share one enforcement path", () => {
    // Two entry points, one set of rules: a divergence between them is how the last round's gap
    // survived. RONDE 90 made that structural — both delegate to the same searchGateDecision,
    // so "the same rules" is no longer a property two copies happen to share.
    for (const fnName of ["admitProviderQuery", "cachedProviderSearch"]) {
      const idx = PIPELINE_SRC.indexOf(`export ${fnName === "admitProviderQuery" ? "function" : "async function"} ${fnName}`);
      expect(idx, fnName).toBeGreaterThan(-1);
      const body = PIPELINE_SRC.slice(idx, idx + 3500);
      expect(body, `${fnName} must go through the shared decision`).toContain("searchGateDecision(");
    }
    // RONDE 91: the decision moved to searchQueryContract, so every module can reach it.
    const gateIdx = CONTRACT_SRC.indexOf("function searchGateDecision(");
    expect(gateIdx).toBeGreaterThan(-1);
    const gate = CONTRACT_SRC.slice(gateIdx, CONTRACT_SRC.indexOf("\n}", gateIdx));
    expect(gate, "the decision must validate").toContain("validateSearchQuery(");
    expect(gate, "the decision must count").toContain("searchGateAudit.record(");
    expect(gate, "the decision must honour strict mode").toContain("searchGateStrict()");
  });

  it("TEST 3 — no search-shaped network call is left outside the gate", () => {
    // Every remaining fetchWithTimeout whose URL carries a query must sit in a function that
    // either goes through cachedProviderSearch or calls the gate directly.
    const lines = PIPELINE_SRC.split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/fetchWithTimeout\(|[^.\w]fetch\(/.test(lines[i]!)) continue;
      const around = lines.slice(Math.max(0, i - 8), i + 2).join("\n");
      if (!/encodeURIComponent|[?&]q=|srsearch|[?&]query=/i.test(around)) continue;
      let fn = "";
      for (let j = i; j >= 0; j--) {
        const m = /^(?:export )?(?:async )?function (\w+)/.exec(lines[j]!);
        if (m) { fn = m[1]!; break; }
      }
      const start = PIPELINE_SRC.indexOf(`function ${fn}(`);
      const body = start >= 0 ? PIPELINE_SRC.slice(start, start + 6000) : "";
      const gated = body.includes("admitProviderQuery(") || body.includes("cachedProviderSearch(");
      // Voice synthesis is not a media provider search; it has no beat context by nature.
      if (!gated && !/^synthesize/.test(fn)) offenders.push(`${fn}:${i + 1}`);
    }
    expect(offenders, `ungated provider searches: ${offenders.join(", ")}`).toEqual([]);
  });
});

/* ═══════════ §4/§5 — the query object, and no fake verification ═══════════ */

describe("RONDE 89 §4/§5 — verified means the contract said so", () => {
  it("TEST 4 — a verified query can only be minted from a context", () => {
    const ok = mintVerifiedQuery("Hitler Berlin", provenCtx(), { route: "primary" });
    expect(ok.verified).toBe(true);
    expect(ok.tokens.length).toBeGreaterThan(0);
    expect(isVerifiedSearchQuery(ok)).toBe(true);
  });

  it("TEST 5 — no context means NOT verified, and the reason says so (§3)", () => {
    const none = mintVerifiedQuery("Hitler Berlin", undefined, { route: "primary" });
    expect(none.verified).toBe(false);
    expect(none.rejectReason).toBe("NO_SEARCH_CONTEXT");
  });

  it("TEST 6 — a term the context cannot prove is refused, not quietly kept", () => {
    const bad = mintVerifiedQuery("Hitler Stalingrad", provenCtx(), { route: "primary" });
    expect(bad.verified).toBe(false);
    expect(bad.rejectReason).toBe("UNVERIFIED_TERM");
  });

  it("TEST 7 — a legacy ticket is never verified, whatever it carries", () => {
    const t = legacyQueryTicket("Hitler Berlin", "old_builder");
    expect(t.verified).toBe(false);
    expect(t.rejectReason).toBe("LEGACY_QUERY_BUILDER");
    // MUTATION GUARD: nothing in the module hands out `verified: true` without minting.
    const SRC = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
    const mintIdx = SRC.indexOf("export function mintVerifiedQuery(");
    // Code lines only — the module's own prose explains the rule and would match otherwise.
    let offset = 0;
    for (const line of SRC.split("\n")) {
      const at = offset;
      offset += line.length + 1;
      if (!line.includes("verified: true")) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      const inMint = at > mintIdx && at < mintIdx + 1400;
      const inProvenToken = SRC.slice(Math.max(0, at - 400), at).includes("provenToken");
      // The one permitted technical term declares itself on the same line.
      const inTechnical = line.includes("TECHNICAL_ARCHIVAL_TERM");
      expect(inMint || inProvenToken || inTechnical, `verified:true at ${at} is unaccounted for`).toBe(true);
    }
  });
});

/* ═══════════ §13/§18 — defence in depth ═══════════ */

describe("RONDE 89 §13 — the gate protects the providers from their own callers", () => {
  it("TEST 8 — a bare string is admitted but COUNTED as a bypass attempt", () => {
    // It cannot be blocked outright today without stopping the pipeline sourcing anything — see
    // the round's report. What it must never be is invisible.
    const audit = new SearchGateAudit();
    audit.record("bypassAttempts", "pexels", "legacy_fetcher", "LEGACY_QUERY_BUILDER");
    expect(audit.summary().total.bypassAttempts).toBe(1);
    expect(audit.summary().rejectReasons.LEGACY_QUERY_BUILDER).toBe(1);
  });

  it("TEST 9 — a provably wrong query is BLOCKED, with or without a context", () => {
    // "She France" is the measured RONDE 87 query. It never reaches a provider again.
    expect(admitProviderQuery("pexels", "She France", "test")).toBeNull();
    expect(admitProviderQuery("pexels", "", "test")).toBeNull();
  });

  it("TEST 10 — a blocked query returns null, never a repaired substitute", () => {
    const out = admitProviderQuery("wikimedia", "She France", "test");
    expect(out).toBeNull();
    // MUTATION GUARD: no call site may fall back to an unblocked query after a null.
    expect(PIPELINE_SRC).not.toMatch(/admitProviderQuery\([^)]*\) === null\) \{[^}]*query =/);
  });

  it("TEST 11 — strict mode is ON unless somebody explicitly turns it off (RONDE 90 §1)", () => {
    // RONDE 89 shipped this default as OFF and said so in its report, because nothing in the
    // pipeline could mint a verified query and turning it on would have blocked every search.
    // RONDE 90 removed that reason: the beat's proof is ambient, so the gate can verify a bare
    // string. A safety property that has to be switched on is off in production — the default
    // is now the contract, and only an explicit "false" opts out of it.
    const prev = process.env.SEARCH_GATE_STRICT;
    try {
      delete process.env.SEARCH_GATE_STRICT;
      expect(searchGateStrict()).toBe(true);
      process.env.SEARCH_GATE_STRICT = "true";
      expect(searchGateStrict()).toBe(true);
      process.env.SEARCH_GATE_STRICT = "";
      expect(searchGateStrict()).toBe(true);
      process.env.SEARCH_GATE_STRICT = "false";
      expect(searchGateStrict()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SEARCH_GATE_STRICT;
      else process.env.SEARCH_GATE_STRICT = prev;
    }
  });
});

/* ═══════════ §15 — the audit ═══════════ */

describe("RONDE 89 §15 — the gate counts what it did", () => {
  it("TEST 12 — every counter the round names exists, per provider and per route", () => {
    const audit = new SearchGateAudit();
    for (const f of ["queriesBuilt", "queriesValidated", "queriesRejected", "queriesSent", "queriesBlocked", "bypassAttempts"] as const) {
      audit.record(f, "pexels", "primary");
    }
    const s = audit.summary();
    expect(s.total.queriesSent).toBe(1);
    expect(s.byProvider.pexels!.queriesBuilt).toBe(1);
    expect(s.byRoute.primary!.queriesBlocked).toBe(1);
  });

  it("TEST 13 — the report block names totals, providers and routes", () => {
    const lines = formatSearchGateReport();
    expect(lines[0]).toContain("[SearchGate] TOTAL");
    expect(lines.join("\n")).toContain("built=");
    expect(lines.join("\n")).toContain("bypassAttempts=");
    expect(PIPELINE_SRC).toContain("formatSearchGateReport()");
  });
});

/* ═══════════ §17 — forensic cases, end to end ═══════════ */

describe("RONDE 89 §17 — the measured cases, through the whole chain", () => {
  const verifiedFirst = (beat: string, opts = {}) => {
    const ctx = buildVerifiedQueryContextForBeat(beat, opts);
    const query = typedQueryPrefix(beat, opts)[0] ?? "";
    return { ctx, query, minted: mintVerifiedQuery(query, ctx, { route: "primary" }) };
  };

  it("TEST 14 — Hitler + Berlin is built, verified and admitted", () => {
    const { query, minted } = verifiedFirst("Hitler visited Berlin during the war.");
    expect(query).toBe("Hitler Berlin");
    expect(minted.verified).toBe(true);
    expect(admitProviderQuery("wikimedia", minted, "primary")).toBe("Hitler Berlin");
  });

  it("TEST 15 — both names survive and the query is verified", () => {
    const { query, minted } = verifiedFirst("Churchill and Roosevelt met at Casablanca.");
    expect(query).toBe("Churchill Roosevelt Casablanca");
    expect(minted.verified).toBe(true);
  });

  it("TEST 16 — a person-only beat still produces a verified query", () => {
    const { query, minted } = verifiedFirst("Hitler met Eva Braun shortly before the end of the war.");
    expect(query).toBe("Hitler Eva Braun");
    expect(minted.verified).toBe(true);
  });

  it("TEST 17 — the pronoun beat yields no person and no pronoun query", () => {
    const { ctx, query } = verifiedFirst("She addressed the nation after the fall of France.");
    expect(ctx.persons.filter((p) => p.verified)).toEqual([]);
    expect(query).not.toMatch(/\bShe\b/);
    expect(admitProviderQuery("pexels", "She France", "primary")).toBeNull();
  });

  it("TEST 18 — a title person cannot ride into a beat query, and is refused at the gate", () => {
    const beat = "She addressed the nation.";
    const ctx = buildVerifiedQueryContextForBeat(beat, { scenePersons: ["Eva Braun"] });
    expect(ctx.persons.find((p) => p.term === "Eva Braun")!.verified).toBe(false);
    const minted = mintVerifiedQuery("Eva Braun France", ctx, { route: "primary" });
    expect(minted.verified).toBe(false);
    expect(minted.rejectReason).toBe("TITLE_INFERENCE_NOT_ALLOWED");
  });

  it("TEST 19 — an LLM term is refused as a query term", () => {
    const ctx = emptyQueryContext();
    ctx.objects.push({ term: "empty harbor", type: "object", source: "llm_generated", verified: false });
    const minted = mintVerifiedQuery("empty harbor", ctx, { route: "rescue" });
    expect(minted.verified).toBe(false);
    expect(minted.rejectReason).toBe("LLM_GENERATED_TERM");
  });

  it("TEST 20 — the LLM cannot reach a provider with an invented subject at all", () => {
    expect(PLAN_SRC).not.toContain("metaphorical equivalents");
    expect(PLAN_SRC).not.toContain('{ label: "visual-equiv", items: plan.fallback }');
    expect(PLAN_SRC).toContain("do NOT invent subjects");
  });
});

/* ═══════════ §20 — nothing else moved ═══════════ */

describe("RONDE 89 §20 — lineage, ranking and concurrency untouched", () => {
  it("TEST 21 — the RONDE 83-88 anchors all still stand", () => {
    for (const anchor of [
      "export function scoreCandidateAgainstBeat(",
      "rankCuratedPicksByBeatContext(ranked, curatedRankCtx)",
      "export const ARCHIVE_PREPARE_ATTEMPTS_MAX = 6;",
      "if (queue.length >= prepareCap) break;",
      "const visualLimit = pLimit(perf.sceneParallelism);",
      "const beatLimit = pLimit(beatConcurrency);",
      "return withGlobalMediaFetch(() => downloadToFileStreamingInner(",
      "ledger.markFinalVideo(deliveredClips)",
      "await withGlobalVisionGate(() => evaluateClipVisionGate(",
    ]) {
      expect(PIPELINE_SRC, anchor).toContain(anchor);
    }
    // SUPERSEDED by RONDE 111: two clone-pads now, both deliberate — the MONTAGE_TAIL_PAD
    // =freeze override, and the remainder after slowing is capped at 2x (the absolute last
    // technical fallback). A THIRD would still mean a freeze had leaked back in.
    expect((PIPELINE_SRC.match(/tpad=stop_mode=clone/g) ?? []).length).toBe(2);
  });

  it("TEST 22 — the gate never rewrites a query, only admits or refuses it", () => {
    const idx = PIPELINE_SRC.indexOf("export function admitProviderQuery(");
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));
    // It returns the query it was given, or null. No widening, no substitution, no repair.
    expect(body).toContain("return decision.admitted ? decision.text : null;");
    expect(body).not.toMatch(/return ["'`]/);
    // And the decision it delegates to hands back the text it was given, never a rewrite: the
    // only two `text` values it can return are the caller's ticket query and the caller's string.
    const gateIdx = CONTRACT_SRC.indexOf("function searchGateDecision(");
    const gate = CONTRACT_SRC.slice(gateIdx, CONTRACT_SRC.indexOf("\n}", gateIdx));
    expect(gate).toContain("const text = String(preVerified ? preVerified.query : (query ?? \"\"));");
    expect(gate).not.toMatch(/text = (?!String\(preVerified)/);
  });
});
