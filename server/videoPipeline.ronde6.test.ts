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

  it("the script-name fallback stays last in the chain (pre-existing behavior preserved)", () => {
    // RONDE 11 moved a validated anchor-resolution earlier in the chain; the raw scriptPersonNames[0]
    // fallback still exists as the final resort. Anchor on the primaryPerson chain, not the first
    // resolvePersonFromSurnameAnchor occurrence (there are now two).
    const chainStart = pipelineSrc.indexOf("const primaryPerson =");
    expect(chainStart).toBeGreaterThan(-1);
    const tail = pipelineSrc.slice(chainStart, chainStart + 400);
    expect(tail).toContain("scriptPersonNames[0]");
  });

  it("the person lock log line itself is untouched", () => {
    expect(pipelineSrc).toContain("[person lock: ${primaryPerson}]");
  });
});

// ─── P1-B: anchorQueriesToHistoricalContext ──────────────────────────────────────────────────

const SCENE_1945 =
  "In April 1945 the Red Army encircled the city while Hitler retreated into the bunker in Berlin.";
const TITLE_517 = "Why Hitler Lost the War";

describe("RONDE 6 P1-B — historical anchoring activates only for historical intent", () => {
  it("a non-historical scene is returned byte-for-byte unchanged", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "modern office workspace",
      extraQueries: ["team collaboration"],
      sceneText: "People collaborate in a bright open office.",
      videoTitle: "Productivity Tips",
    });
    expect(res.anchored).toBe(false);
    expect(res.primaryQuery).toBe("modern office workspace");
    expect(res.extraQueries).toEqual(["team collaboration"]);
  });

  it("historical but with NO year stated and NO person mentioned stays unchanged — nothing is invented", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "soldiers marching",
      sceneText: "The war changed everything across the continent.",
      videoTitle: "The Great War documentary",
      primaryPerson: "Adolf Hitler", // NOT mentioned by this scene → must not be injected
    });
    expect(res.anchored).toBe(false);
    expect(res.primaryQuery).toBe("soldiers marching");
    expect(res.year).toBe("");
  });
});

describe("RONDE 6 P1-B — the year the script states anchors the queries", () => {
  it("render-517 regression: 'berlin public transport documentary' becomes era-anchored", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin public transport documentary",
      extraQueries: ["berlin city skyline"],
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
    });
    expect(res.anchored).toBe(true);
    expect(res.year).toBe("1945");
    expect(res.primaryQuery).toBe("berlin public transport documentary 1945");
    expect(res.extraQueries).toContain("berlin city skyline 1945");
  });

  it("a query that already states a year is never double-anchored", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin 1945 ruins",
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
    });
    expect(res.primaryQuery).toBe("berlin 1945 ruins");
  });

  it("scene year wins over title year (a 1923 scene in a 1945-titled video searches 1923)", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "munich street scene",
      sceneText: "The failed putsch of 1923 landed him in Landsberg prison.",
      videoTitle: "The Road to 1945",
    });
    expect(res.year).toBe("1923");
    expect(res.primaryQuery).toBe("munich street scene 1923");
  });

  it("falls back to the title's year when the scene states none", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "city in ruins",
      sceneText: "The Red Army encircled the city in the final days of the war.",
      videoTitle: "The Fall of Berlin 1945",
    });
    expect(res.year).toBe("1945");
    expect(res.primaryQuery).toBe("city in ruins 1945");
  });
});

describe("RONDE 6 P1-B — person and location variants come only from the scene's own intent", () => {
  it("adds a person-anchored variant when THIS scene mentions the primary person", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
      primaryPerson: "Adolf Hitler",
    });
    expect(res.anchored).toBe(true);
    expect(res.extraQueries.some((q) => q.startsWith("Adolf Hitler") && q.includes("1945"))).toBe(true);
  });

  it("adds a location+year variant from the scene's location phrase", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "city skyline",
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
    });
    expect(res.extraQueries).toContain("Berlin 1945");
  });

  it("no person variant when the scene does not mention the person", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "soviet city street",
      sceneText: "In 1942 the factories east of the Urals ran day and night.",
      videoTitle: TITLE_517,
      primaryPerson: "Adolf Hitler",
    });
    expect(res.anchored).toBe(true);
    expect(res.extraQueries.every((q) => !q.toLowerCase().includes("hitler"))).toBe(true);
  });
});

describe("RONDE 6 P1-B — breadth guarantee and bounds", () => {
  it("the ORIGINAL primary phrasing stays available as an extra (pool can only grow)", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      extraQueries: ["german capital aerial"],
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
    });
    expect(res.extraQueries).toContain("berlin city skyline");
    expect(res.extraQueries).toContain("german capital aerial");
  });

  it("anchored variants are ordered BEFORE the original phrasings", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      extraQueries: ["german capital aerial"],
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
    });
    const anchoredIdx = res.extraQueries.findIndex((q) => q.includes("1945"));
    const originalIdx = res.extraQueries.indexOf("berlin city skyline");
    expect(anchoredIdx).toBeGreaterThan(-1);
    expect(originalIdx).toBeGreaterThan(anchoredIdx);
  });

  it("extras are capped at 6 so provider fan-out stays bounded", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      extraQueries: ["q one alpha", "q two beta", "q three gamma", "q four delta", "q five epsilon"],
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
      primaryPerson: "Adolf Hitler",
    });
    expect(res.extraQueries.length).toBeLessThanOrEqual(6);
  });

  it("the anchored primary never duplicates into the extras", () => {
    const res = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      sceneText: SCENE_1945,
      videoTitle: TITLE_517,
    });
    expect(res.extraQueries).not.toContain(res.primaryQuery);
  });
});

describe("RONDE 6 P1-B — wiring: all four funnel/pool query call sites are anchored", () => {
  it("videoPipeline.ts calls anchorQueriesToHistoricalContext at 4 call sites", () => {
    const calls = pipelineSrc.match(/anchorQueriesToHistoricalContext\(\{/g) ?? [];
    expect(calls.length).toBe(4);
  });

  it("the funnel prefetch passes the anchored queries, not the raw scene phrasing", () => {
    const idx = pipelineSrc.indexOf("[Funnel P4] Hybrid retrieval prefetch started");
    expect(idx).toBeGreaterThan(-1);
    const block = pipelineSrc.slice(idx - 3000, idx);
    expect(block).toContain("primaryQuery: anchoredQueries.primaryQuery");
    expect(block).toContain("extraQueries: anchoredQueries.extraQueries");
  });

  it("the pool prefetch passes the anchored queries too", () => {
    const idx = pipelineSrc.indexOf("[Pool P4] Prefetch started");
    expect(idx).toBeGreaterThan(-1);
    const block = pipelineSrc.slice(idx - 3000, idx);
    expect(block).toContain("primaryQuery: anchoredPoolQueries.primaryQuery");
    expect(block).toContain("extraQueries: anchoredPoolQueries.extraQueries");
  });

  it("anchoring is observable in the logs for the measurement render", () => {
    expect(pipelineSrc).toContain("[HistoricalAnchor]");
  });
});
