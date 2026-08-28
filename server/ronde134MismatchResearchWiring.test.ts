/**
 * RONDE 134 — the corrected question reaches a provider, and it carries the scene's evidence.
 *
 * ── What RONDE 133 measured, and why this round exists ───────────────────────────────────────
 *
 * RONDE 132 wired a research pass: a refusal the gate blames on the QUESTION makes the beat ask a
 * different one. RONDE 133 then measured how far that reaches and found the ceiling:
 *
 *     WRONG_PERIOD fires on 2 of 10 realistic beats
 *
 * because a period correction needs a year, years are read from the BEAT's own words, and a
 * documentary states its period once per scene and then relies on it. The scene's text was
 * already admissible evidence to the SearchGate — `validateSearchQuery` proves a content word
 * against `ctx.evidence`, and `beatSearchProvenance` builds that from beat text PLUS scene text —
 * so nothing was forbidden. Nothing was building queries from it either.
 *
 * ── What is proved here ──────────────────────────────────────────────────────────────────────
 *
 *   1-9    the scene widens the research context, and every widened query still passes the gate.
 *   10-14  material faults now get a correction too, without changing the subject.
 *   15-19  the invariant: a "correction" that says nothing new is not sent.
 *   20-22  budget.
 *   23-27  entity integrity, international names, negative cases.
 *   28-30  THE WIRING: a corrected query reaching a real outbound provider request.
 *   M1-M8  mutations.
 *
 * Test 28 is the one that matters most. Everything else could be true of a research pass that
 * never causes a search; 28 mocks the transport and reads the URL that leaves the process.
 */
/**
 * Provider keys are captured into module-level consts when videoPipeline is imported, so they
 * have to exist BEFORE the import — `vi.hoisted` runs ahead of the hoisted imports. These are
 * placeholders against a mocked transport; no request reaches a real service.
 */
vi.hoisted(() => {
  process.env.YOUTUBE_API_KEY = "r134-test-key-not-a-credential";
  process.env.RAPIDAPI_KEY = "r134-test-key-not-a-credential";
  // The YouTube tier is opt-in by flag (sourcingPolicy.youtubeSourcingEnabled). Production has
  // it on — video 546 retrieved 25 YouTube candidates — so the wiring test runs with it on too.
  process.env.ENABLE_YOUTUBE_SOURCING = "true";
});

vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: vi.fn(actual.default) };
});

import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fetchModule from "node-fetch";

import {
  buildResearchContext,
  correctionStrategyFor,
  decideResearch,
  formatResearchContext,
  queryImprovesOn,
  selectCorrectedQueries,
  RESEARCH_ESTIMATED_COST_MS,
} from "./mismatchResearch";
import { classifyMismatch, mismatchFault } from "./visualMismatchFeedback";
import {
  buildPrioritisedQueries,
  searchGateStrict,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import {
  buildVerifiedQueryContextForBeat,
  createVisualDedupState,
  fetchHistoricalBeatVideo,
  getPipelinePerfProfile,
} from "./videoPipeline";
import { buildMediaSearchIntent } from "./mediaResearchEngine";

const mockedFetch = vi.mocked(fetchModule);

/** The scene under audit, in the shape a real script produces. */
const SCENE_TEXT =
  "In April 1945 Hermann Göring left Berlin for the south. " +
  "He had commanded the Luftwaffe since 1935. " +
  "Adolf Hitler had already turned against him.";

const ctxFor = (beatText: string): VerifiedQueryContext =>
  buildVerifiedQueryContextForBeat(beatText, { sceneText: SCENE_TEXT });

const researchCtxFor = (beatText: string): VerifiedQueryContext =>
  buildResearchContext({ beat: ctxFor(beatText), scene: ctxFor(SCENE_TEXT) });

/**
 * The real factories, not hand-made stubs.
 *
 * The wiring tests drive `fetchHistoricalBeatVideo`, which reads a dozen fields off the perf
 * profile and the search intent. A stub that happens to satisfy the type is not evidence about
 * production: the first version of these tests used one and the cascade threw on a field it
 * never set, which reads exactly like "the provider was not called".
 */
const RESEARCH_BEAT = {
  index: 0,
  text: "The decision was his alone.",
  holdSec: 4,
  keywords: [] as string[],
  powerWord: "",
  searchQuery: "Hermann Göring Berlin",
};
const RESEARCH_SCENE = { index: 0, text: SCENE_TEXT, visualCue: "", pexelsQuery: "" };
const VIDEO_TITLE = "The real reason Hermann Göring joined Hitler";

const researchDedup = (videoId: number) =>
  createVisualDedupState(getPipelinePerfProfile("5min"), {
    primaryPerson: "Hermann Göring",
    personTopicLock: false,
    videoId,
  });

const researchIntent = () =>
  buildMediaSearchIntent({
    beatText: RESEARCH_BEAT.text,
    searchQueries: [RESEARCH_BEAT.searchQuery],
    keywords: [],
    primaryPerson: "Hermann Göring",
    persons: ["Hermann Göring"],
    videoTitle: VIDEO_TITLE,
    powerWord: "",
    personTopicLock: false,
    spaceTopic: false,
    muskTopic: false,
  });

describe("RONDE 134 — the scene's evidence reaches the research pass", () => {
  it("1. a beat that states its own period is unchanged by the merge", () => {
    const beat = "In April 1945 Hermann Göring left Berlin for the south.";
    const d = decideResearch({
      kind: "WRONG_PERIOD",
      ctx: researchCtxFor(beat),
      alreadyResearched: false,
      alreadyUsed: ["Hermann Göring Berlin"],
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.correctedQuery).toBe("Hermann Göring Berlin 1945");
  });

  it("2. a beat with NO period of its own now gets one from its scene", () => {
    const beat = "The influential choice Hermann Göring made to join Hitler changed everything.";
    // RONDE 132/133 behaviour: the beat alone proves no year, so there is nothing to correct with.
    const beatOnly = decideResearch({
      kind: "WRONG_PERIOD", ctx: ctxFor(beat), alreadyResearched: false,
    });
    expect(beatOnly.action).toBe("NONE");
    if (beatOnly.action === "NONE") expect(beatOnly.reason).toBe("NO_BETTER_QUERY");

    // RONDE 134: the scene states April 1945, and that is evidence the gate already accepted.
    const merged = decideResearch({
      kind: "WRONG_PERIOD", ctx: researchCtxFor(beat), alreadyResearched: false,
    });
    expect(merged.action).toBe("RESEARCH");
    if (merged.action !== "RESEARCH") return;
    expect(merged.correctedQuery).toContain("1945");
    expect(merged.correctedQuery).toContain("Hermann Göring");
  });

  it("3. a beat with no entities at all is carried by its scene", () => {
    const d = decideResearch({
      kind: "WRONG_PERIOD", ctx: researchCtxFor("The decision was his alone."),
      alreadyResearched: false,
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.correctedQuery).toBe("Hermann Göring Berlin 1945");
  });

  it("4. every scene-widened query still passes the SearchGate", () => {
    // The gate is what stands between a widened context and an invented term. Each corrected
    // query is validated against the BEAT's own ambient provenance — the context the pipeline
    // actually runs the search under — not against the widened one.
    for (const beat of [
      "The influential choice Hermann Göring made to join Hitler changed everything.",
      "The decision was his alone.",
      "Ambition, not ideology, was what drew him in.",
    ]) {
      const beatCtx = ctxFor(beat);
      for (const kind of ["WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE", "UNRELATED"] as const) {
        const d = decideResearch({ kind, ctx: researchCtxFor(beat), alreadyResearched: false });
        if (d.action !== "RESEARCH") continue;
        for (const q of d.correctedQueries) {
          const verdict = validateSearchQuery(q, beatCtx);
          expect(verdict.ok, `"${q}" rejected as ${verdict.reason}`).toBe(true);
        }
      }
    }
  });

  it("5. the merge adds nothing the scene does not literally state", () => {
    const merged = researchCtxFor("The decision was his alone.");
    const haystack = SCENE_TEXT.toLowerCase();
    for (const list of [merged.persons, merged.places, merged.countries, merged.years, merged.time]) {
      for (const token of list) {
        if (!token.verified) continue;
        expect(haystack).toContain(token.term.toLowerCase());
      }
    }
  });

  it("6. scene-derived tokens are labelled scene_text, not passed off as the beat's", () => {
    const merged = researchCtxFor("The decision was his alone.");
    const year = merged.years.find((t) => t.term === "1945");
    expect(year).toBeDefined();
    expect(year!.source).toBe("scene_text");
    // A beat that DOES state its year keeps beat_text.
    const own = researchCtxFor("In April 1945 Hermann Göring left Berlin for the south.")
      .years.find((t) => t.term === "1945");
    expect(own!.source).toBe("beat_text");
  });

  it("7. the beat's own tokens still lead", () => {
    const merged = researchCtxFor("In April 1945 Hermann Göring left Berlin for the south.");
    expect(merged.persons[0]!.term).toBe("Hermann Göring");
    expect(merged.persons[0]!.source).toBe("beat_text");
  });

  it("8. a verb from another sentence is never carried across", () => {
    // "left" belongs to the sentence that says it. The beat below says "commanded" only in the
    // scene, and its own actions must not acquire it.
    const merged = researchCtxFor("The decision was his alone.");
    expect(merged.actions.map((a) => a.term.toLowerCase())).not.toContain("left");
    expect(merged.actions.map((a) => a.term.toLowerCase())).not.toContain("commanded");
  });

  it("9. the context log names the sources", () => {
    const line = formatResearchContext("s0b2", researchCtxFor("The decision was his alone."));
    expect(line).toContain("[MismatchResearch]");
    expect(line).toContain("beat=s0b2");
    expect(line).toContain("1945*");
    expect(line).toContain("proven by the scene");
  });
});

describe("RONDE 134 — a material fault gets a correction too", () => {
  it("10. TEXT_ON_SCREEN asks for the archive instead of doing nothing", () => {
    const d = decideResearch({
      kind: "TEXT_ON_SCREEN",
      ctx: researchCtxFor("In April 1945 Hermann Göring left Berlin for the south."),
      alreadyResearched: false,
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.strategy).toBe("ADD_ARCHIVAL_INTENT");
    expect(d.correctedQuery).toContain("archival footage");
    // The BLAME is unchanged — this is still a fault of the material, and the report says so.
    expect(d.blame).toBe("MATERIAL");
  });

  it("11. TALKING_HEAD does the same", () => {
    const d = decideResearch({
      kind: "TALKING_HEAD",
      ctx: researchCtxFor("The decision was his alone."),
      alreadyResearched: false,
    });
    expect(d.action).toBe("RESEARCH");
    if (d.action !== "RESEARCH") return;
    expect(d.strategy).toBe("ADD_ARCHIVAL_INTENT");
    expect(mismatchFault("TALKING_HEAD")).toBe("MATERIAL");
  });

  it("12. the archival correction keeps the same subject", () => {
    const d = decideResearch({
      kind: "TEXT_ON_SCREEN",
      ctx: researchCtxFor("In April 1945 Hermann Göring left Berlin for the south."),
      alreadyResearched: false,
    });
    if (d.action !== "RESEARCH") return;
    // It changes what is asked FOR, never what is asked ABOUT.
    expect(d.correctedQuery).toContain("Hermann Göring");
  });

  it("13. it uses the contract's one permitted technical term, not a phrase of its own", () => {
    const src = readFileSync(join(__dirname, "mismatchResearch.ts"), "utf8");
    // No literal search phrasing in the CODE — prose in a comment is allowed to name the term it
    // is explaining, so the comments are stripped before the check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/["'`][^"'`]*documentary footage/);
    expect(code).not.toMatch(/["'`][^"'`]*archival footage/);
    const d = decideResearch({
      kind: "TEXT_ON_SCREEN",
      ctx: researchCtxFor("In April 1945 Hermann Göring left Berlin for the south."),
      alreadyResearched: false,
    });
    if (d.action !== "RESEARCH") return;
    const contract = new Set(
      buildPrioritisedQueries(
        researchCtxFor("In April 1945 Hermann Göring left Berlin for the south.")
      ).map((q) => q.query)
    );
    for (const q of d.correctedQueries) expect(contract.has(q)).toBe(true);
  });

  it("14. an unclassified refusal still starts nothing", () => {
    expect(correctionStrategyFor("UNCLEAR")).toBeNull();
    const d = decideResearch({
      kind: "UNCLEAR", ctx: researchCtxFor("The decision was his alone."), alreadyResearched: false,
    });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("UNCLEAR");
  });
});

describe("RONDE 134 — the same question is never asked twice", () => {
  it("15. a reordering of the same words is not an improvement", () => {
    expect(queryImprovesOn("Hermann Göring Berlin", "Berlin Hermann Göring")).toBe(false);
    expect(queryImprovesOn("Hermann Göring Berlin", "hermann göring berlin")).toBe(false);
  });

  it("16. a genuinely narrower question is", () => {
    expect(queryImprovesOn("Hermann Göring Berlin", "Hermann Göring Berlin 1945")).toBe(true);
    expect(queryImprovesOn("Berlin street footage", "Hermann Göring Berlin")).toBe(true);
  });

  it("17. it is not a length rule", () => {
    // Longer, and yet says nothing the original did not.
    expect(queryImprovesOn("Hermann Göring Berlin 1945", "Berlin 1945")).toBe(false);
    // Shorter, and says something new.
    expect(queryImprovesOn("Berlin 1945", "Göring")).toBe(true);
  });

  it("18. an empty candidate is never an improvement", () => {
    expect(queryImprovesOn("Hermann Göring Berlin", "")).toBe(false);
    expect(queryImprovesOn("Hermann Göring Berlin", "   ")).toBe(false);
  });

  it("19. every query already tried is excluded, not just the last one", () => {
    const ctx = researchCtxFor("In April 1945 Hermann Göring left Berlin for the south.");
    const all = selectCorrectedQueries({ ctx, strategy: "ADD_TIME" });
    const d = decideResearch({
      kind: "WRONG_PERIOD", ctx, alreadyResearched: false,
      alreadyUsed: all.slice(0, 3),
    });
    if (d.action === "RESEARCH") {
      for (const q of d.correctedQueries) expect(all.slice(0, 3)).not.toContain(q);
    }
  });
});

describe("RONDE 134 — budget", () => {
  const ctx = () => researchCtxFor("In April 1945 Hermann Göring left Berlin for the south.");

  it("20. a render with no time left does not start a search", () => {
    const d = decideResearch({
      kind: "WRONG_PERIOD", ctx: ctx(), alreadyResearched: false, remainingBudgetMs: 0,
    });
    expect(d.action).toBe("NONE");
    if (d.action === "NONE") expect(d.reason).toBe("BUDGET_EXCEEDED");
  });

  it("21. a render with room does", () => {
    const d = decideResearch({
      kind: "WRONG_PERIOD", ctx: ctx(), alreadyResearched: false,
      remainingBudgetMs: RESEARCH_ESTIMATED_COST_MS * 4,
    });
    expect(d.action).toBe("RESEARCH");
  });

  it("22. a caller that tracks no budget is not guessed at", () => {
    const d = decideResearch({ kind: "WRONG_PERIOD", ctx: ctx(), alreadyResearched: false });
    expect(d.action).toBe("RESEARCH");
  });
});

describe("RONDE 134 — entity integrity survives the widening", () => {
  it("23. the title's words never become entities", () => {
    const ctx = researchCtxFor(
      "The influential choice Hermann Göring made to join Hitler changed everything."
    );
    const terms = [...ctx.persons, ...ctx.places, ...ctx.countries].map((t) => t.term.toLowerCase());
    expect(terms).not.toContain("influential");
    expect(terms).not.toContain("choice");
    expect(terms).not.toContain("everything");
    // And "Hermann" alone is never a person — the full name is.
    expect(terms).not.toContain("hermann");
    expect(terms).toContain("hermann göring");
  });

  it("24. Göring keeps its ö through every correction", () => {
    for (const kind of ["WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE", "TEXT_ON_SCREEN"] as const) {
      const d = decideResearch({
        kind, ctx: researchCtxFor("The decision was his alone."), alreadyResearched: false,
      });
      if (d.action !== "RESEARCH") continue;
      expect(d.correctedQuery).toContain("Göring");
      expect(d.correctedQuery).not.toContain("Goring");
      expect(d.correctedQuery).not.toContain("G ring");
      expect(d.correctedQuery.normalize("NFC")).toBe(d.correctedQuery);
    }
  });

  it("25. international names survive the merge byte for byte", () => {
    const NAMES = [
      "José Mourinho", "François Mitterrand", "Jean-Luc Godard", "Charles de Gaulle",
      "Vincent van Gogh", "Ludwig van Beethoven", "Łukasz Fabiański", "İsmet İnönü",
    ];
    for (const name of NAMES) {
      const scene = `${name} arrived in Berlin in 1945.`;
      const merged = buildResearchContext({
        beat: buildVerifiedQueryContextForBeat("The decision was his alone.", { sceneText: scene }),
        scene: buildVerifiedQueryContextForBeat(scene, { sceneText: scene }),
      });
      const found = merged.persons.map((p) => p.term);
      expect(found.join(" | "), `${name} lost in the merge`).toContain(name);
    }
  });

  it("26. the reason text contributes no word to any query", () => {
    const kind = classifyMismatch({
      depicts: "a modern street with protest banners",
      reason: "present-day footage, wrong century, unrelated protest",
    });
    const d = decideResearch({
      kind, ctx: researchCtxFor("The decision was his alone."), alreadyResearched: false,
    });
    if (d.action !== "RESEARCH") return;
    for (const w of ["present", "century", "protest", "banners", "unrelated", "modern"]) {
      expect(d.correctedQuery.toLowerCase()).not.toContain(w);
    }
  });

  it("27. the SearchGate is still strict", () => {
    expect(process.env.SEARCH_GATE_STRICT).not.toBe("false");
    expect(searchGateStrict()).toBe(true);
  });
});

// ─── THE WIRING ──────────────────────────────────────────────────────────────────────────────

describe("RONDE 134 — the corrected query causes a real provider request", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    process.env.YOUTUBE_API_KEY = "test-key-not-a-real-credential";
    process.env.RAPIDAPI_KEY = "test-key-not-a-real-credential";
  });

  /** Every URL the process tried to fetch during a call. */
  function requestedUrls(): string[] {
    return mockedFetch.mock.calls.map((c) => String(c[0]));
  }

  it("28. leadQueries reach an outbound provider URL", async () => {
    // The whole point of the round, at the only place it can be observed from outside: the
    // corrected query is handed to fetchHistoricalBeatVideo, and something leaves the process
    // carrying it. Everything else in this file could be true of a research pass that never
    // searches.
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ items: [] }),
      text: async () => "",
    } as never);

    const correctedQuery = "Hermann Göring Berlin 1945";
    const dedup = researchDedup(999);
    await fetchHistoricalBeatVideo(
      RESEARCH_BEAT as never, RESEARCH_SCENE as never, "/tmp", 0, 4, dedup,
      researchIntent(),
      { videoTitle: VIDEO_TITLE, keywords: [] } as never,
      "r134_wiring",
      { leadQueries: [correctedQuery], researchPass: true }
    ).catch(() => null);

    const urls = requestedUrls();
    expect(urls.length, "no outbound request was made at all").toBeGreaterThan(0);
    // The corrected query, URL-encoded, in something that actually left the process.
    const encoded = encodeURIComponent(correctedQuery).replace(/%20/g, "+");
    const carried = urls.filter(
      (u) => u.includes(encoded) || u.includes(encodeURIComponent(correctedQuery))
    );
    expect(carried.length, `corrected query never left the process. URLs: ${urls.slice(0, 5).join(" | ")}`)
      .toBeGreaterThan(0);
  }, 120_000);

  it("29. it reaches YouTube specifically, through the existing cascade", async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ items: [] }), text: async () => "",
    } as never);

    const dedup = researchDedup(998);
    await fetchHistoricalBeatVideo(
      RESEARCH_BEAT as never, RESEARCH_SCENE as never, "/tmp", 0, 4, dedup,
      researchIntent(),
      { videoTitle: VIDEO_TITLE, keywords: [] } as never,
      "r134_yt",
      { leadQueries: ["Hermann Göring Berlin 1945"], researchPass: true }
    ).catch(() => null);

    const yt = requestedUrls().filter((u) => u.includes("googleapis.com/youtube/v3/search"));
    expect(yt.length, "the research query never reached YouTube").toBeGreaterThan(0);
    expect(yt.some((u) => u.includes("G%C3%B6ring") || u.includes("Göring"))).toBe(true);
  }, 120_000);

  it("30. without leadQueries the same call asks the cascade's own questions", async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ items: [] }), text: async () => "",
    } as never);

    const dedup = researchDedup(997);
    await fetchHistoricalBeatVideo(
      RESEARCH_BEAT as never, RESEARCH_SCENE as never, "/tmp", 0, 4, dedup,
      researchIntent(),
      { videoTitle: VIDEO_TITLE, keywords: [] } as never,
      "r134_nolead",
      {}
    ).catch(() => null);

    // The corrected query is absent — proving test 28's hit came from leadQueries and not from
    // something the cascade would have asked anyway.
    const carried = requestedUrls().filter((u) => u.includes("1945"));
    expect(carried.length).toBe(0);
  }, 120_000);
});

describe("RONDE 134 — mutation guards", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const MOD = readFileSync(join(__dirname, "mismatchResearch.ts"), "utf8");

  it("M1. the research pass calls the provider cascade", () => {
    const idx = PIPE.indexOf("const researchKey = `s${scene.index}b${beat.index}`;");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, idx + 6200);
    expect(block).toContain("fetchHistoricalBeatVideo(");
    expect(block).toContain("leadQueries: decision.correctedQueries");
    expect(block).toContain("researchPass: true");
  });

  it("M2/M3. the scene context is built and passed", () => {
    const idx = PIPE.indexOf("const researchKey = `s${scene.index}b${beat.index}`;");
    const block = PIPE.slice(idx, idx + 3000);
    expect(block).toContain("buildResearchContext({");
    expect(block).toContain("scene: scene.text?.trim()");
    expect(block).toContain("ctx: researchCtx");
  });

  it("M4. the corrected query comes from the contract", () => {
    expect(MOD).toContain("buildPrioritisedQueries(params.ctx)");
    const assignments = [...MOD.matchAll(/correctedQuery:\s*([^,\n]+)/g)]
      .map((m) => m[1]!.trim())
      .filter((v) => v !== "string" && v !== "string;");
    expect(assignments).toEqual(["queries[0]!"]);
  });

  it("M5. leadQueries lead inside the existing cap", () => {
    const idx = PIPE.indexOf("const allQueries = uniqueQueryStrings([...(opts.leadQueries ?? [])");
    expect(idx).toBeGreaterThan(0);
    expect(PIPE.slice(idx, idx + 260)).toContain("queryCap");
  });

  it("M6. the improvement invariant is applied to the selection, not just exported", () => {
    expect(MOD).toContain("used.some((u) => queryImprovesOn(u, q.query))");
  });

  it("M7. a scene token is re-minted with its real source", () => {
    expect(MOD).toContain('provenToken(token.term, token.type, "scene_text", sceneEvidence)');
    // Never a bare copy — that would carry a beat_text label the beat never earned.
    expect(MOD).not.toMatch(/target\.push\(token\)/);
  });

  it("M8. the existing cache and dedup are what the pass uses", () => {
    const idx = PIPE.indexOf("const fetchTierPaths = async (tier: HistoricalSourceTier, q: string)");
    const block = PIPE.slice(idx, idx + 2600);
    expect(block).toContain("dedup.sourcingCache");
    expect(block).toContain("dedup.usedContentKeys");
    expect(PIPE).toContain("recordAdoptedClipSource");
  });
});
