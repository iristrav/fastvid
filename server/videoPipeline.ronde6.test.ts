import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { anchorQueriesToHistoricalContext } from "./mediaResearchEngine";
import {
  extractPersonSurnameAnchor,
  extractPrimaryPersonFromText,
  resolvePersonFromSurnameAnchor,
} from "./videoPipeline";

// RONDE 6 — P1-A (person extraction) + P1-B (historical query context).
//
// P1-A, proven in render 517: the pipeline logged `[person lock: Why Hitler]` — the first two
// capitalized words of the title "Why Hitler Lost the War" were treated as a person's name. The
// corrupt lock polluted every person-anchored query AND suppressed the historical-documentary
// handling (personTopicLock disables historicalDoc at every branch that checks it).
//
// P1-B, proven in render 517: the funnel searched era-less stock phrasing ("berlin public
// transport documentary", "berlin city skyline", "russia city street") for a 1945 documentary,
// so the pool filled with present-day footage of the right place in the wrong century.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

// ─── P1-A: extractPrimaryPersonFromText no longer fabricates names from title framing ────────

describe("RONDE 6 P1-A — title framing words are never a person name", () => {
  it("render-517 regression: 'Why Hitler Lost the War' yields NO name (was: 'Why Hitler')", () => {
    expect(extractPrimaryPersonFromText("Why Hitler Lost the War")).toBe("");
  });

  it("'How Napoleon Conquered Europe' yields no fabricated 'Napoleon Conquered'", () => {
    expect(extractPrimaryPersonFromText("How Napoleon Conquered Europe")).toBe("");
  });

  it("a title of pure framing words yields nothing at all", () => {
    expect(extractPrimaryPersonFromText("The Untold Story")).toBe("");
    expect(extractPersonSurnameAnchor("The Untold Story")).toBe("");
  });

  it("real full names still pass through unchanged", () => {
    expect(extractPrimaryPersonFromText("Rumors about Kylie Jenner")).toBe("Kylie Jenner");
    expect(extractPrimaryPersonFromText("Elon Musk Documentary")).toBe("Elon Musk");
  });

  it("a trailing framing word is stripped without losing the name", () => {
    // "Biography" is framing; "Will" is a real first name and must never be stripped.
    expect(extractPrimaryPersonFromText("Will Smith Biography")).toBe("Will Smith");
  });

  it("'Kylie Jenner: The Full Story' still resolves to Kylie Jenner", () => {
    expect(extractPrimaryPersonFromText("Kylie Jenner: The Full Story")).toBe("Kylie Jenner");
  });
});

describe("RONDE 6 P1-A — surname anchor resolves against the script's own full names", () => {
  it("'Why Hitler Lost the War' yields the surname anchor 'Hitler'", () => {
    expect(extractPersonSurnameAnchor("Why Hitler Lost the War")).toBe("Hitler");
  });

  it("the anchor picks the script name in surname position — 'Adolf Hitler', not 'Eva Braun'", () => {
    expect(
      resolvePersonFromSurnameAnchor("Hitler", ["Eva Braun", "Adolf Hitler", "Albert Speer"])
    ).toBe("Adolf Hitler");
  });

  it("a non-surname-position match never fabricates a person (Chernobyl Exclusion Zone)", () => {
    expect(
      resolvePersonFromSurnameAnchor("Chernobyl", ["Chernobyl Exclusion Zone", "Igor Kostin"])
    ).toBe("");
  });

  it("an empty anchor resolves to nothing", () => {
    expect(resolvePersonFromSurnameAnchor("", ["Adolf Hitler"])).toBe("");
    expect(resolvePersonFromSurnameAnchor("Hitler", [])).toBe("");
  });

  it("a title with a full real name does not degrade to an anchor", () => {
    // Full-name extraction wins first in the pipeline chain; the anchor path is only reached
    // when extractPrimaryPersonFromText found nothing. This guards the anchor helper itself
    // from returning a fragment of a name that is already complete.
    expect(extractPersonSurnameAnchor("Elon Musk Documentary")).toBe("");
  });
});

describe("RONDE 6 P1-A — the pipeline chain wiring", () => {
  it("the primaryPerson chain resolves the surname anchor against script names", () => {
    expect(pipelineSrc).toContain("resolvePersonFromSurnameAnchor(surnameAnchor, scriptPersonNames)");
  });

  it("the script-name fallback stays last in the chain — and only takes a name the topic names", () => {
    // Video 612: the raw scriptPersonNames[0] fallback locked "Scipio Africanus" on a video about
    // the Roman Empire. The last resort is now the first script name the prompt/title/topic names.
    const chainStart = pipelineSrc.indexOf("const candidate =\n    extractPrimaryPersonFromText(input.prompt)");
    expect(chainStart).toBeGreaterThan(-1);
    const tail = pipelineSrc.slice(chainStart, chainStart + 400);
    expect(tail).toContain("scriptPersonNames.find(namedByTopic)");
    expect(tail).not.toContain("scriptPersonNames[0]");
  });

  it("the person lock log line itself is untouched", () => {
    expect(pipelineSrc).toContain("[person lock: ${primaryPerson}]");
  });
});

// ─── P1-B: anchorQueriesToHistoricalContext ──────────────────────────────────────────────────

const SCENE_1945 =
  "In April 1945 the Red Army encircled the city while Hitler retreated into the bunker in Berlin.";
const TITLE_517 = "Why Hitler Lost the War";
