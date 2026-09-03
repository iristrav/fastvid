/**
 * WHAT KIND OF SHOT IS THIS? — ASKED OF THE PICTURE, NOT OF THE FILENAME.
 *
 * ── The weakness ────────────────────────────────────────────────────────────────────────────
 *
 * `inferShotTypeFromPath` in assetDirector.ts answers this by running regexes over the download
 * filename and the beat's own words:
 *
 *     if (CLOSE_RE.test(combined)) return "close_up";
 *     if (WIDE_RE.test(combined)) return "wide";
 *
 * For a curated archive asset that never mattered — those carry human-reviewed
 * `cinematography.shotType`. For Pexels, YouTube, Wikimedia and the Internet Archive, which is
 * most of what any render downloads, it is a guess about a picture nobody looked at. And it is not
 * a harmless guess: it feeds a 10% score weight, the planned-shot bonus, and every decision about
 * what shot should follow this one. A montage built on wrong framings repeats itself with nothing
 * noticing.
 *
 * ── The fix, and why it costs nothing ───────────────────────────────────────────────────────
 *
 * The beat image judge already puts this clip's real frames in front of a vision model, to decide
 * whether the picture belongs under the line. It now names the framing in the SAME answer. One
 * extra field on a call we already pay for, rather than a second vision pass per candidate.
 *
 * The chain this file guards, end to end:
 *
 *     judge sees frames → framing on the judgement → framing on the decision
 *       → dedup.clipAnnotationMeta.observedShotType → scoreShotVariety
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { buildBeatImagePrompt } from "./beatImageRelevanceGate";
import { ALL_SHOT_TYPES, normaliseShotType } from "./shotVocabulary";

/* ═══════════════════════ the question is actually asked ═══════════════════════ */

describe("the judge is asked how the shot is framed", () => {
  const prompt = () =>
    buildBeatImagePrompt("Soviet troops entered the city centre in April 1945.", 3, "The Fall of Berlin");

  it("asks for a framing at all", () => {
    expect(prompt()).toContain("name how this shot is FRAMED");
  });

  /**
   * The framing question must not be able to drag the verdict around. A model asked to label a
   * close-up tends to justify the label, and a shot it has just called a close-up starts to look
   * more suitable than it is. Saying plainly that the answer changes nothing is what keeps the two
   * decisions independent.
   */
  it("tells the model the framing does not change the verdict", () => {
    expect(prompt()).toContain("without letting it change your verdict");
  });

  /**
   * "unclear" has to be an available answer, or the model invents one. A wrong framing is worse
   * than no framing: absent means the ranking falls back to what it did before, while wrong means
   * the shot-variety score and everything downstream act on a fiction.
   */
  it("offers 'unclear' as a real answer rather than forcing a guess", () => {
    const p = prompt();
    expect(p).toContain('Answer "unclear" rather than guessing');
    expect(p).toContain("A wrong framing is worse than no framing");
  });

  it("the schema constrains the answer to this vocabulary plus unclear", () => {
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    const schemaAt = src.indexOf("framing: {");
    expect(schemaAt).toBeGreaterThan(-1);
    const block = src.slice(schemaAt, schemaAt + 700);
    for (const shot of ALL_SHOT_TYPES) {
      expect(block, `${shot} is not an allowed answer`).toContain(`"${shot}"`);
    }
    expect(block).toContain('"unclear"');
  });

  it("the framing is required, so a model cannot quietly omit it", () => {
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(src).toContain('required: ["depicts", "belongs", "reason", "framing"]');
  });
});

/* ═══════════════════════ the answer is read honestly ═══════════════════════ */

describe("an answer outside the vocabulary becomes no answer", () => {
  /**
   * `normaliseShotType` is the vocabulary's own reader. "unclear" is not a framing, and neither is
   * anything a model invents outside the enum; both must come back null so the field stays absent
   * and the ranking falls back to what it did before.
   */
  it("'unclear' is not a framing", () => {
    expect(normaliseShotType("unclear")).toBeNull();
  });

  it("an invented framing is not a framing", () => {
    for (const invented of ["dutch_angle", "over_the_shoulder", "very close", "cinematic"]) {
      expect(normaliseShotType(invented), invented).toBeNull();
    }
  });

  it("every framing the schema allows is one the vocabulary can read back", () => {
    for (const shot of ALL_SHOT_TYPES) {
      expect(normaliseShotType(shot), shot).toBe(shot);
    }
  });
});

/* ═══════════════════════ the chain, from frames to ranking ═══════════════════════ */

describe("the framing reaches the ranking instead of stopping at the judge", () => {
  const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
  const relevance = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
  const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const director = fs.readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8");

  it("the judgement carries it out of the gate", () => {
    expect(gate).toContain("framing?: ShotType;");
    expect(gate).toContain("normaliseShotType(parsed.framing ?? null)");
  });

  it("the relevance decision carries it out of the ledger", () => {
    expect(relevance).toContain("framing?: ShotType;");
    expect(relevance).toContain("...(judgement.framing ? { framing: judgement.framing } : {})");
  });

  /**
   * The seam this codebase keeps finding: a fact one route establishes and the next does not
   * receive. Deleting this block leaves every other line in the chain intact and the ranking still
   * reading a filename.
   */
  it("the pipeline files it where the ranking looks", () => {
    expect(pipeline).toContain("observedShotType: decision.framing,");
    expect(pipeline).toContain("dedup.clipAnnotationMeta.set(params.clipPath, {");
  });

  /**
   * Precedence, and it matters. Curated annotation is human-reviewed and strongest. A model that
   * looked at these exact pixels is next. The filename regex stays last so a candidate nobody
   * judged is no worse off than it was before any of this.
   */
  it("the ranking prefers annotation, then the observed framing, then the filename", () => {
    const at = director.indexOf("const shotType = meta?.annotation?.cinematography?.shotType");
    expect(at).toBeGreaterThan(-1);
    const expr = director.slice(at, at + 220);
    expect(expr).toContain("meta?.observedShotType");
    expect(expr.indexOf("meta?.observedShotType")).toBeLessThan(
      expr.indexOf("inferShotTypeFromPath")
    );
  });

  /**
   * The filename guess is NOT removed. A candidate that no model judged — the gate switched off, a
   * budget spent, a cache hit — still needs an answer, and the regex is the answer it always had.
   * Removing it would trade a weak signal for no signal.
   */
  it("the filename fallback survives for candidates nobody judged", () => {
    expect(director).toContain("function inferShotTypeFromPath(");
    expect(director).toContain("?? inferShotTypeFromPath(clipPath, beatText)");
  });
});

/* ═══════════════════════ shot progression reads the same evidence ═══════════════════════ */

describe("a run of identical shots is judged on what those shots are", () => {
  const director = fs.readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8");
  const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /**
   * The consecutive-run penalty is the whole of FastVid's shot-progression logic, and it read the
   * PREVIOUS clips' framings out of their download filenames. So three genuine close-ups in a row
   * went unpenalised whenever their filenames happened not to contain the word "close", and three
   * unrelated shots were penalised as a run whenever they did.
   */
  it("previous shots are read the same way the candidate is", () => {
    expect(director).toContain("shotTypeOf?.(previous) ?? inferShotTypeFromPath(previous, beatText)");
  });

  it("the resolver reaches the scorer instead of stopping at the context type", () => {
    expect(director).toContain("shotTypeOf?: (clipPath: string) => string | null | undefined;");
    expect(director).toContain("ctx.shotTypeOf");
  });

  /**
   * And the pipeline fills it from the same store the judge writes into. Two stores would drift;
   * one store cannot.
   */
  it("the pipeline answers it from the judge's own observations", () => {
    expect(pipeline).toContain("shotTypeOf: (clipPath: string) =>");
    expect(pipeline).toContain("?.observedShotType ??");
  });

  it("an unjudged scene still gets the reading it always had", () => {
    // `??` on both sides, never a hard requirement — the filename path survives.
    const at = director.indexOf("const prevType = shotTypeOf?.(previous)");
    expect(director.slice(at, at + 120)).toContain("inferShotTypeFromPath");
  });
});
