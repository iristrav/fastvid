import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  extractPersonNamesFromText,
  extractPersonSurnameAnchor,
  extractPrimaryPersonFromText,
  resolvePersonFromSurnameAnchor,
} from "./videoPipeline";

// RONDE 11 — two defects render 521 proved:
//
// 11A: the RONDE 8 archive.org metadata timeout increase (8s → 15s) BACKFIRED. 36 metadata calls
//      each hung the full 15s, pushing the visual stage from ~24s to 47-65s/scene and a 1-min
//      render to 12m44s, leaving all 3 scenes gray. Reverted to 8s: a slow archive.org metadata
//      endpoint is the common case, and cutting losers fast keeps the pipeline moving.
//
// 11B: the person lock became "Suicide Pact" — a title's two-capitalized-word phrase that is not
//      a person. It won because the weak two-word title guess ran BEFORE the surname anchor (which
//      resolves "Hitler" against the script's real "Adolf Hitler"). Fix: block concept-noun
//      phrases, and resolve the (script-validated) surname anchor before any title/topic guess.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 11A — the archive.org metadata timeout is reverted to 8s", () => {
  it("uses 8s, not 15s, for the metadata call", () => {
    const idx = pipelineSrc.indexOf("`Internet Archive metadata scene ${sceneIndex}`");
    expect(idx).toBeGreaterThan(-1);
    const window = pipelineSrc.slice(idx - 500, idx);
    expect(window).toContain("8_000");
    expect(window).not.toContain("15_000");
  });
});

describe("RONDE 11B — concept-noun phrases are never a person", () => {
  it("render-521 regression: 'The Suicide Pact' yields no person", () => {
    expect(extractPrimaryPersonFromText("The Suicide Pact")).toBe("");
  });

  it("'Nazi Germany' and 'As Nazi Germany' are not persons", () => {
    expect(extractPrimaryPersonFromText("Nazi Germany")).toBe("");
    expect(extractPrimaryPersonFromText("As Nazi Germany collapsed")).toBe("");
  });

  it("the script scan does not surface concept nouns as scene-persons", () => {
    const names = extractPersonNamesFromText(
      "As Nazi Germany fell, Adolf Hitler and Eva Braun made a Suicide Pact in the bunker."
    );
    expect(names).toContain("Adolf Hitler");
    expect(names).toContain("Eva Braun");
    expect(names.every((n) => !/suicide|pact|nazi|germany/i.test(n))).toBe(true);
  });

  it("real names are still extracted next to concept nouns", () => {
    expect(extractPrimaryPersonFromText("Elon Musk buys Twitter")).toBe("Elon Musk");
  });
});

describe("RONDE 11B — the surname anchor beats a weak title guess in the lock chain", () => {
  it("a title's surname resolves against the script's real name, not a concept phrase", () => {
    // "Hitler" (surname anchor) → the script's "Adolf Hitler", never "Suicide Pact".
    expect(extractPersonSurnameAnchor("Hitler's Final Hours: The Suicide Pact")).toBe("Hitler");
    expect(
      resolvePersonFromSurnameAnchor("Hitler", ["Adolf Hitler", "Eva Braun", "Hans Krebs"])
    ).toBe("Adolf Hitler");
  });

  it("the anchor resolution is placed BEFORE the title/topic guesses in the chain", () => {
    const idx = pipelineSrc.indexOf("const anchorResolvedPerson = resolvePersonFromSurnameAnchor(surnameAnchor, scriptPersonNames);");
    expect(idx).toBeGreaterThan(-1);
    const chain = pipelineSrc.slice(idx, idx + 500);
    // anchorResolvedPerson appears before extractPrimaryPersonFromText(videoTitle) in the chain.
    const anchorPos = chain.indexOf("anchorResolvedPerson ||");
    const titlePos = chain.indexOf("extractPrimaryPersonFromText(videoTitle)");
    expect(anchorPos).toBeGreaterThan(-1);
    expect(titlePos).toBeGreaterThan(anchorPos);
  });

  it("the prompt extraction still wins first when it finds a real full name", () => {
    // Chain order preserved: userPrompt extraction is still the very first term.
    const idx = pipelineSrc.indexOf("const primaryPerson =");
    const chain = pipelineSrc.slice(idx, idx + 400);
    const promptPos = chain.indexOf('extractPrimaryPersonFromText(userPrompt ?? videoRow?.prompt ?? "")');
    const anchorPos = chain.indexOf("anchorResolvedPerson ||");
    expect(promptPos).toBeGreaterThan(-1);
    expect(anchorPos).toBeGreaterThan(promptPos);
  });
});
