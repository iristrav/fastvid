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
    expect(read("videoPipeline.ts")).toContain("noteVisionSpend(dedup, scene.index, beat.index, spent)");
  });

  it("a judged-and-refused candidate is still recorded as refused", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain('"beat_image_gate"');
    expect(pipe).toContain("dedup.beatImageRejectedIds.add");
  });
});
