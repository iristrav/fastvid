/**
 * OCTOBER 2026 — THE VISUAL JUDGE ALWAYS REALLY LOOKS (renders 616, 625, 626).
 *
 *   625  "gate could not ask: LLM API key is not configured" — never_asked=37, 19 clips in the film
 *        that nobody looked at, because an unreachable editor suspended the requirement.
 *   626  "Any shot of Musk belongs under a line about his media strategies" — a person on screen
 *        carried the whole verdict.
 *
 * The chain every photograph now follows: selected → reviewed → APPROVED → adopted.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { adoptionGuardVerdict, adoptionPolicyFor, type AdoptionVisionVerdict } from "./adoptionPolicy";
import { buildBeatImagePrompt, situationRule } from "./beatImageRelevanceGate";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

/** Every route that puts a photograph (real or generated) on screen. */
const PHOTOGRAPHIC = [
  "archive", "youtube_cc", "youtube", "wikimedia", "pexels", "pool",
  "rescue_archive", "rescue_wikimedia", "rescue_stock", "archive_similar", "recovered_scene",
  "subject_fallback", "ai",
];

const guard = (source: string, vision: AdoptionVisionVerdict) =>
  adoptionGuardVerdict({ source, eligible: true, vision, visionAvailable: true });

describe("judge unavailable → no adoption", () => {
  it.each(PHOTOGRAPHIC)("%s is refused when nobody looked (NOT_ASKED)", (source) => {
    expect(guard(source, "NOT_ASKED").allowed).toBe(false);
  });

  it.each(PHOTOGRAPHIC)("%s is refused on 'asked, no usable answer' (UNCLEAR)", (source) => {
    expect(guard(source, "UNCLEAR").allowed).toBe(false);
  });

  it.each(PHOTOGRAPHIC)("%s is adopted on an approval", (source) => {
    expect(guard(source, "APPROVED").allowed).toBe(true);
  });

  it("every photographic route requires an approval, not merely the absence of a refusal", () => {
    for (const source of PHOTOGRAPHIC) {
      expect(adoptionPolicyFor(source).visionRequirement, source).toBe("approved");
    }
  });

  it("the push guard no longer turns an unreachable editor into a suspension", () => {
    const at = PIPE.indexOf("async function visualJudgeRefusesPush(");
    const guardBody = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(guardBody).toContain("const visionAvailable = !nothingToJudge;");
    expect(guardBody).not.toMatch(/visionAvailable\s*=\s*!visionPipelineIsUnavailable\(\)/);
    expect(guardBody).toContain("judge unavailable → no adoption");
  });

  it("a render without a picture editor says that nothing is adopted, not that it is waived", () => {
    expect(GATE).toContain("No photograph is adopted");
    expect(GATE).not.toContain("the adoption guard's vision requirement is suspended render-wide");
  });
});

describe("a person on screen is not the whole answer (render 626)", () => {
  const fits = { verdict: "fits" as const, reason: "The clip shows Elon Musk, who is named in the line." };

  it("subject seen, situation not shown → does not fit", () => {
    const out = situationRule(fits, { subject_matches: true, situation_matches: false });
    expect(out.verdict).toBe("does_not_fit");
    expect(out.reason).toMatch(/^situation not shown/);
  });

  it("situation shown, subject not seen → does not fit", () => {
    expect(situationRule(fits, { subject_matches: false, situation_matches: true }).verdict).toBe("does_not_fit");
  });

  it("both → fits", () => {
    expect(situationRule(fits, { subject_matches: true, situation_matches: true }).verdict).toBe("fits");
  });

  it("a refusal is never turned into an approval", () => {
    const refused = { verdict: "does_not_fit" as const, reason: "unrelated" };
    expect(situationRule(refused, { subject_matches: true, situation_matches: true }).verdict).toBe("does_not_fit");
  });

  it("an answer without the two fields keeps its own verdict", () => {
    expect(situationRule(fits, {}).verdict).toBe("fits");
  });

  it("the question asks for both halves and names the situation's parts", () => {
    const p = buildBeatImagePrompt("Kris Jenner turned her family into a media empire.", 3);
    expect(p).toContain("subject_matches");
    expect(p).toContain("situation_matches");
    expect(p).toMatch(/action,\s+its context, its place or setting, its objects, what it means/);
    expect(p).toContain("It BELONGS only when BOTH are true.");
    expect(GATE).toContain('required: ["depicts", "subject_matches", "situation_matches", "belongs", "reason", "framing"]');
  });

  it("stored verdicts from the looser rule are not reused", () => {
    expect(GATE).toContain('export const BEAT_JUDGE_RULES = "r2610-subject-and-situation";');
  });
});
