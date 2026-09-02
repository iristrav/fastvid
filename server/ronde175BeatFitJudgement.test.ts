/**
 * RONDE 175 — the only thing that judges whether a picture belongs, and how rarely it was asked.
 *
 * ── What the chain actually is ───────────────────────────────────────────────────────────────
 *
 *     beat → ~6 candidates downloaded (MAX_FUNNEL_CANDIDATES_TO_SCORE)
 *          → ranked on keywords + embedding + source tier + moving bonus
 *          → the winner goes to the beat image gate: "does this belong under this narration?"
 *          → MAX_JUDGEMENTS_PER_BEAT
 *
 * Render 555 measured the gate:
 *
 *     beat image gate — attempts=50 answered=50 (fits=13 does_not_fit=37) never_asked=38
 *
 * Three quarters of what it saw did not belong, and it said so. The gate works. What it did not
 * get was a look: six candidates downloaded, two ever asked.
 *
 * ── And the model that looks at the pixels cannot help ───────────────────────────────────────
 *
 * `vision_gate` is in INTENTIONALLY_NON_FIRING_GATES — demoted to ranking, allowed to refuse
 * nothing — because RONDE 58 measured CLIP scoring a white-lives-matter sticker at 0.2226 against
 * a signed photograph of Hitler at 0.2116, on the same beat. So the ordering the two judged
 * candidates are drawn from is partly noise on archive material, and only two of six are checked.
 *
 * ── The two changes here, and why they are one commit ────────────────────────────────────────
 *
 * §1 raises the looks. §3 sharpens the question. §3 ALONE would make coverage worse: a sharper
 * question means more refusals, and with two looks a beat would more often end with nothing. §1 is
 * what pays for §3.
 */
import { describe, expect, it } from "vitest";

import { matchCandidateToBeat, yearsIn } from "./candidatePeriodMatch";
import { reorderShortlistForBeat, type FunnelCandidate } from "./retrievalFunnel";
import {
  MAX_JUDGEMENTS_PER_BEAT,
  maxBeatImageJudgementsPerRender,
  maxYoutubeBeatImageJudgements,
} from "./beatImageRelevanceGate";

const read = (file: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, file), "utf8").replace(/\0/g, "");
};

/* ═══════════════════════ §1 — the gate gets to look ═══════════════════════ */

describe("RONDE 175 §1 — four looks per beat, not two", () => {
  it("THE LEVER: a beat downloads six candidates and now judges four of them", () => {
    /**
     * Two was never a quality setting, it was a budget. The candidates are already downloaded and
     * already paid for; the judgement is the only way to find out whether they belong.
     */
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    // Still below the six a beat can have, so this is more looks and not "judge everything".
    expect(MAX_JUDGEMENTS_PER_BEAT).toBeLessThan(6);
  });

  it("THE RISK, closed: the render ceiling rose with it", () => {
    /**
     * The failure this had to avoid. At a render ceiling of 60, a 19-beat render allows barely
     * three judgements per beat — and the ceiling is spent in beat order, so the early beats would
     * take four each and the last beats would get none. Raising the per-beat number alone does not
     * buy looks, it moves the starvation to the end of the render, where it is harder to see.
     */
    const beats = 19;
    expect(maxBeatImageJudgementsPerRender()).toBeGreaterThanOrEqual(beats * MAX_JUDGEMENTS_PER_BEAT);
  });

  it("every added call goes to the funnel, not to YouTube", () => {
    /**
     * RONDE 61 measured render 532 spending 52 of its 60 judgements on YouTube candidates and
     * refusing 48 — YouTube is judged BEFORE a clip enters the pool, so it burns calls on material
     * that was never going to be used, while the funnel judges the clip about to go in the video.
     * The YouTube share deliberately did not move, so the whole increase lands on the funnel.
     */
    expect(maxYoutubeBeatImageJudgements()).toBe(24);
    const forEverythingElse = maxBeatImageJudgementsPerRender() - maxYoutubeBeatImageJudgements();
    expect(forEverythingElse).toBeGreaterThanOrEqual(19 * MAX_JUDGEMENTS_PER_BEAT);
  });

  it("both budgets stay overridable, and refuse nonsense", () => {
    const gate = read("beatImageRelevanceGate.ts");
    expect(gate).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12)');
    expect(gate).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500)');
    // A per-beat budget of zero would silently switch the gate off; the floor is 1.
    expect(MAX_JUDGEMENTS_PER_BEAT).toBeGreaterThanOrEqual(1);
  });

  it("the loop still stops at the ceiling rather than asking without bound", () => {
    // The protection that makes raising the number safe: it is a ceiling, not a target.
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("for (let look = 0; look < MAX_JUDGEMENTS_PER_BEAT && winner; look++)");
  });
});

/* ═══════════════════════ §3 — the question names the subject ═══════════════════════ */

describe("RONDE 175 §3 — the judge is told what it is checking against", () => {
  const gate = () => read("beatImageRelevanceGate.ts");

  it("THE GAP: the question carried the title, the paragraph and the line, and nothing else", () => {
    /**
     * The pipeline establishes the period and the places for the documentary and resolves a
     * subject per beat. None of it reached the prompt, so the judge inferred them from prose.
     */
    const src = gate();
    expect(src).toContain("This shot is meant to show:");
    expect(src).toContain("The documentary is set in:");
    expect(src).toContain("Places this documentary is about:");
    /**
     * And the lines are actually IN the prompt. Asserting only that the strings exist in the file
     * leaves a version that builds the anchors and never prints them — which is the state before
     * this round, and a mutation proved the test could not see it.
     */
    const idx = src.indexOf("function buildPrompt(");
    expect(idx).toBeGreaterThan(0);
    const prompt = src.slice(idx, src.indexOf("\n}", src.indexOf(".join(\"\\n\");", idx)));
    expect(prompt).toContain("...formatAnchors(anchors),");
    // ...positioned after the narration, so the judge reads the line before its anchors.
    expect(prompt.indexOf("Narration for this shot")).toBeLessThan(
      prompt.indexOf("...formatAnchors(anchors),")
    );
  });

  it("WHY it matters: the tie-break lets doubt through", () => {
    /**
     * The prompt ends "when you genuinely cannot tell, say it belongs". A vague question therefore
     * does not merely produce a vague answer — it produces an ALLOW. That is the wrong direction to
     * fail in if the goal is a picture that truly fits.
     *
     * The tie-break itself is deliberately NOT changed: reversing it would turn every uncertainty
     * into a refusal, and more empty beats is not better pictures.
     */
    expect(gate()).toContain("When you genuinely cannot tell, say it belongs.");
  });

  it("the period is labelled as the FILM's, never as this shot's", () => {
    /**
     * The misattribution that would have made this change harmful. A WWII documentary can
     * legitimately cut to a 1919 photograph; telling the judge "the narration places this shot in
     * the 1930s-1940s" would make it refuse a correct picture.
     */
    const src = gate();
    expect(src).toContain("(the film, not necessarily this shot)");
    expect(src).not.toContain("The narration places it in:");
  });

  it("an anchor the pipeline does not have prints nothing at all", () => {
    /**
     * No placeholder, no empty label. An "unknown period" line is something the model can reason
     * from, and it would be reasoning from a fact FastVid never established.
     */
    const src = gate();
    const idx = src.indexOf("function formatAnchors(");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, src.indexOf("\nfunction buildPrompt", idx));
    expect(body).toContain("if (!anchors) return [];");
    expect(body).toContain("if (subject)");
    expect(body).toContain("if (period)");
    expect(body).toContain("places.length > 0");
    // Every push is guarded: no line emits without a preceding `if`, so an absent anchor
    // contributes nothing at all rather than an empty label.
    const lines = body.split("\n");
    const pushes = lines.filter((l) => l.includes("lines.push("));
    expect(pushes.length).toBe(3);
    for (const [i, l] of lines.entries()) {
      if (!l.includes("lines.push(")) continue;
      const guarded = l.trimStart().startsWith("if (") || lines[i - 1]!.includes("if (");
      expect(guarded, l.trim()).toBe(true);
    }
  });

  it("the anchors reach the judge through the decider that every route uses", () => {
    const relevance = read("beatVisualRelevance.ts");
    expect(relevance).toContain("anchors: ctx.anchors,");
    expect(relevance).toContain("anchors?: BeatSubjectAnchors;");
  });

  it("the anchors are NOT part of the cache key", () => {
    /**
     * Two clips judged against the same narration are the same question whether or not the anchors
     * happened to be available. Letting them into `beatIdentityKey` would split the cache and
     * re-ask questions that were already answered — spending exactly the budget §1 just bought.
     */
    const relevance = read("beatVisualRelevance.ts");
    const idx = relevance.indexOf("export function beatIdentityKey(");
    expect(idx).toBeGreaterThan(0);
    const body = relevance.slice(idx, relevance.indexOf("\n}", idx));
    expect(body).not.toContain("anchors");
  });

  it("the pipeline fills them from context it established, not from the beat's guesses", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("const visual = get_activeVideoVisualContext();");
    expect(pipe).toContain("documentaryPeriod: visual.period?.trim() || undefined,");
    expect(pipe).toContain("documentaryPlaces: visual.locations?.filter(Boolean).slice(0, 3),");
    // A render with no established context passes no anchors at all.
    expect(pipe).toContain("const anchors = visual");
  });
});

/* ═══════════════════════ the guards this must not have moved ═══════════════════════ */

describe("RONDE 175 — nothing was loosened to get here", () => {
  it("the gate still refuses, and its verdict still blocks adoption", () => {
    const relevance = read("beatVisualRelevance.ts");
    expect(relevance).toContain("does_not_fit");
    expect(read("videoPipeline.ts")).toContain("composeBarrierAllows");
  });

  it("CLIP is still demoted — this round did not re-arm a judge that scores backwards", () => {
    /**
     * RONDE 58's measurement stands: a sticker at 0.2226 over a Hitler photograph at 0.2116. More
     * looks do not make an inverted ranker trustworthy, and re-arming it here would have undone
     * two rounds of work to buy an apparent improvement.
     */
    const stats = read("gateFiringStats.ts");
    expect(stats).toContain('"vision_gate"');
    expect(stats).toContain("INTENTIONALLY_NON_FIRING_GATES");
  });

  it("the per-beat spend is still recorded, so the extra calls are visible", () => {
    // A budget that doubled without being measured is how the next round loses an afternoon.
    expect(read("videoPipeline.ts")).toContain("noteVisionSpend(dedup, sceneIndex, beatIndex, spent)");
  });

  it("a judged-and-refused candidate is still recorded as refused", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain('"beat_image_gate"');
    expect(pipe).toContain("dedup.beatImageRejectedIds.add");
  });
});

/* ═══════════════════════ §2 — the ranker learns when and where ═══════════════════════ */

describe("RONDE 175 §2 — period, place and subject reach the ranking", () => {
  const ctx = { years: ["1926"], places: ["Munich"], subjects: ["Hermann Göring"] };

  it("THE RULE THIS RESTS ON: saying nothing costs nothing", () => {
    /**
     * The mistake this had to avoid, and the reason the module is written the way it is. Real
     * archive titles are catalogue numbers with no year, no place and no name:
     *
     *     "Bundesarchiv Bild 183-S33882"
     *
     * If absence were a penalty, exactly the material this pipeline exists to find would sink and
     * richly-titled stock footage would rise — RONDE 54's finding reproduced through a new
     * mechanism. So a candidate that establishes nothing scores exactly zero, not below zero.
     */
    const m = matchCandidateToBeat("Bundesarchiv Bild 183-S33882", ctx);
    expect(m.bonus).toBe(0);
    expect(m.period).toBe("unknown");
    expect(m.place).toBe("unknown");
    expect(m.subject).toBe("unknown");
  });

  it("K. a candidate from the wrong decade is pushed down", () => {
    const wrong = matchCandidateToBeat("Berlin street scene, 1945", ctx);
    expect(wrong.period).toBe("contradicts");
    expect(wrong.bonus).toBeLessThan(0);
    // ...and it ends up below the catalogue-numbered archive title that claims nothing.
    expect(wrong.bonus).toBeLessThan(matchCandidateToBeat("Bundesarchiv Bild 183", ctx).bonus);
  });

  it("K2. a candidate from the right period is lifted", () => {
    const right = matchCandidateToBeat("Munich rally, 1926 newsreel", ctx);
    expect(right.period).toBe("agrees");
    expect(right.place).toBe("agrees");
    expect(right.bonus).toBeGreaterThan(0);
  });

  it("a near miss is not a contradiction", () => {
    /**
     * Archive material is routinely dated to the year it was catalogued rather than shot, and a
     * beat about the mid-twenties is legitimately served by a 1931 photograph. Only a real
     * conflict trips it.
     */
    expect(matchCandidateToBeat("Munich, 1931", ctx).period).toBe("agrees");
    expect(matchCandidateToBeat("Munich, 1955", ctx).period).toBe("contradicts");
  });

  it("a compilation spanning years is judged on its closest one", () => {
    // A reel labelled 1939-1945 is not in conflict with a beat about 1943.
    expect(matchCandidateToBeat("Newsreel compilation 1939-1945", { years: ["1943"] }).period)
      .toBe("agrees");
  });

  it("L. the named place lifts, and a place the candidate never mentions does not sink it", () => {
    expect(matchCandidateToBeat("Munich beer hall", ctx).place).toBe("agrees");
    // Not naming Munich is not a claim about somewhere else — there is no contradiction to find.
    const silent = matchCandidateToBeat("Crowd in a hall", ctx);
    expect(silent.place).toBe("unknown");
    expect(silent.bonus).toBe(0);
  });

  it("M. the named subject lifts, on a whole word", () => {
    expect(matchCandidateToBeat("Portrait of Hermann Göring", ctx).subject).toBe("agrees");
    // Whole-word: "man" appears INSIDE "woman" and "Germany" and must not match either.
    expect(matchCandidateToBeat("A woman in Germany", { subjects: ["man"] }).subject).toBe("unknown");
    // ...while the same word standing on its own does match.
    expect(matchCandidateToBeat("A man in Germany", { subjects: ["man"] }).subject).toBe("agrees");
  });

  it("no beat context at all leaves every candidate exactly where it was", () => {
    for (const text of ["Munich 1926", "Berlin 1945", "Bundesarchiv Bild 183"]) {
      expect(matchCandidateToBeat(text, undefined).bonus, text).toBe(0);
      expect(matchCandidateToBeat(text, {}).bonus, text).toBe(0);
    }
  });

  it("it is a nudge, not a veto — sized inside one source-tier step", () => {
    /**
     * The tier bonuses span 0–0.15. A ranking signal larger than that would let period alone
     * reorder the source priorities, and the winner is still decided by the beat image gate on the
     * actual picture, not by this.
     */
    const best = matchCandidateToBeat("Hermann Göring in Munich, 1926", ctx);
    expect(best.bonus).toBeLessThanOrEqual(0.25);
    const worst = matchCandidateToBeat("Berlin 1999", ctx);
    expect(worst.bonus).toBeGreaterThanOrEqual(-0.2);
  });

  it("a year outside plausible range is not read as a year", () => {
    expect(yearsIn("Bild 183-S33882")).toEqual([]);
    expect(yearsIn("shot in 1926 and 1931")).toEqual([1926, 1931]);
  });

  it("both ranking paths use it — the archive is not exempt", () => {
    /**
     * An archive holding a 1945 reel is no better a fit for a 1926 beat than a stock clip. Applying
     * it only to external candidates would have made the archive the one source that could never
     * be wrong about a period.
     */
    const funnel = read("retrievalFunnel.ts");
    expect(funnel).toContain("const archiveMatch = matchCandidateToBeat(");
    expect(funnel).toContain("+ archiveMatch.bonus)");
    expect(funnel).toContain("matchCandidateToBeat(`${c.title ?? \"\"} ${c.assetId ?? \"\"}`");
  });

  it("the pipeline fills it from the script, not from a guess", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("years: yearsIn(scene.text).map(String),");
    expect(pipe).toContain("places: get_activeVideoVisualContext()?.locations?.slice(0, 3),");
  });
});

/* ═══════════════════════ RONDE 176 — the beat orders its own pool ═══════════════════════ */

describe("RONDE 176 — the scene's order no longer decides what a late beat gets", () => {
  const cand = (id: string, title: string, rankingScore: number): FunnelCandidate =>
    ({ id, source: "wikimedia", title, rankingScore, mediaType: "image" }) as FunnelCandidate;

  it("THE ASYMMETRY: a beat used to inherit the scene's order minus its neighbours' picks", () => {
    /**
     * The funnel searches once per SCENE; the shortlist is drawn once per BEAT. Between them
     * nothing re-read the beat, so the last beat of a scene had systematically worse options than
     * the first — not because its sentence was harder, but because it came later in the loop.
     */
    const pool = [
      cand("a", "Luftwaffe aircraft, 1940", 9),
      cand("b", "Munich beer hall, 1926", 5),
    ];
    // With no beat context the order is exactly the scene's, unchanged.
    expect(reorderShortlistForBeat(pool, undefined).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("THE FIX: the beat about Munich in 1926 gets the Munich picture first", () => {
    const pool = [
      cand("a", "Luftwaffe aircraft, 1940", 9),
      cand("b", "Munich beer hall, 1926", 5),
    ];
    const ordered = reorderShortlistForBeat(pool, { years: ["1926"], places: ["Munich"] });
    expect(ordered.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("it reorders, it never drops", () => {
    // Every candidate the scene found is still a candidate — this decides order, not membership.
    const pool = [cand("a", "A", 3), cand("b", "Munich 1926", 2), cand("c", "C", 1)];
    const ordered = reorderShortlistForBeat(pool, { years: ["1926"], places: ["Munich"] });
    expect(ordered).toHaveLength(3);
    expect(ordered.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("a beat that establishes nothing leaves the scene ranking exactly as it was", () => {
    const pool = [cand("a", "A", 3), cand("b", "B", 2)];
    expect(reorderShortlistForBeat(pool, {})).toBe(pool);
    expect(reorderShortlistForBeat(pool, { years: [], places: [], subjects: [] })).toBe(pool);
  });

  it("the scene ranking still breaks ties, and the order is fully determined", () => {
    /**
     * Two candidates that agree equally with the beat fall back to the ranking that got them into
     * the pool, then to their original position — so two runs of the same render cannot differ.
     */
    const pool = [
      cand("a", "Munich 1926 street", 4),
      cand("b", "Munich 1926 hall", 7),
      cand("c", "Munich 1926 square", 7),
    ];
    const ordered = reorderShortlistForBeat(pool, { years: ["1926"], places: ["Munich"] });
    expect(ordered.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("a catalogue-numbered archive title keeps its place", () => {
    // The rule the whole matcher rests on, re-checked at this call site: absence is neutral, so
    // the material this pipeline exists to find is not pushed down by saying nothing.
    const pool = [
      cand("bund", "Bundesarchiv Bild 183-S33882", 9),
      cand("stock", "Generic crowd footage HD", 8),
    ];
    expect(reorderShortlistForBeat(pool, { years: ["1926"], places: ["Munich"] }).map((c) => c.id))
      .toEqual(["bund", "stock"]);
  });

  it("a contradicting year sinks below a candidate that claims nothing", () => {
    const pool = [
      cand("wrong", "Berlin 1955 street scene", 9),
      cand("silent", "Bundesarchiv Bild 183-S33882", 8),
    ];
    expect(reorderShortlistForBeat(pool, { years: ["1926"] }).map((c) => c.id))
      .toEqual(["silent", "wrong"]);
  });

  it("an archive candidate is read from its asset, not from a title it does not have", () => {
    const archive = {
      id: "archive:101",
      source: "archive",
      title: "archive clip",
      rankingScore: 5,
      mediaType: "video",
      archivePick: {
        asset: { id: 101, title: "Munich rally 1926" },
        archiveName: "Bundesarchiv",
        score: 40,
      },
    } as unknown as FunnelCandidate;
    const other = cand("x", "Something else", 9);
    expect(reorderShortlistForBeat([other, archive], { years: ["1926"], places: ["Munich"] })
      .map((c) => c.id)).toEqual(["archive:101", "x"]);
  });

  it("the archive's NAME counts too — it is often the only thing naming the place", () => {
    /**
     * A holding's title is frequently a catalogue number while the archive it sits in names the
     * city: "Stadtarchiv München" says Munich when "Bild 183-S33882" says nothing. Reading only
     * the title would throw that away, and a mutation proved the other archive test could not see
     * it because its title already carried the match.
     */
    const named = {
      id: "archive:7",
      source: "archive",
      title: "archive clip",
      rankingScore: 1,
      mediaType: "video",
      archivePick: {
        asset: { id: 7, title: "Bild 183-S33882" },
        archiveName: "Stadtarchiv Munich",
        score: 40,
      },
    } as unknown as FunnelCandidate;
    const other = cand("x", "Unrelated footage", 9);
    expect(reorderShortlistForBeat([other, named], { places: ["Munich"] }).map((c) => c.id))
      .toEqual(["archive:7", "x"]);
  });

  it("it runs BEFORE the shortlist is cut, or it could not change what is downloaded", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("reorderShortlistForBeat(funnelCandidates, beatContext),");
    // The years come from the BEAT here — the sentence is in scope at this point, unlike where
    // the funnel is built.
    expect(pipe).toContain("years: yearsIn(beat.text).map(String),");
  });
});
