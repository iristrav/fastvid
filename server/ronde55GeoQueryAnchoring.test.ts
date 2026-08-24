import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { anchorQueriesToHistoricalContext } from "./mediaResearchEngine";

/**
 * RONDE 55 — a documentary about April 1945 was asking a general-purpose archive for present-day
 * Berlin, and doing it first.
 *
 * Render 531, scene 0, in the order the searches actually fired:
 *
 *    1  berlin city skyline                    Timeout
 *    2  berlin public transport                Timeout
 *    3  berlin public transport documentary    Aborted
 *    4  berlin city street                     Aborted
 *    5  berlin city street documentary         Aborted
 *    6  Adolf Hitler archival footage          Aborted
 *    7  Adolf Hitler historical documentary    Aborted
 *    8  collection:tvnews AND Adolf Hitler     Aborted
 *    9  Adolf Hitler interview                 Aborted
 *   10  Adolf Hitler television                Aborted
 *   11  Adolf celebrity news                   Aborted
 *   12  subject:"Adolf Hitler"                 Aborted
 *
 * Twelve searches, zero completions. The five period-less geo queries went first and spent the
 * scene's budget; every topical query behind them was cancelled. Meanwhile the scene pool's own
 * Internet Archive calls — which did complete, taking 17–23 seconds — were the ones that supplied
 * "faces-of-ancient-europe-1-500-a.d" and "white-lives-matter-montana-sticker".
 *
 * anchorQueriesToHistoricalContext already existed for exactly this (added for render 517, "the
 * pool filled with present-day footage of the right place in the wrong century"). The geo builder
 * was simply never routed through it.
 */

describe("RONDE 55 — geo queries carry the period the script states", () => {
  const SCENE =
    "In April 1945, within hours of marrying, Adolf Hitler and Eva Braun died in the Führerbunker in Berlin.";
  const TITLE = "Why Hitler Chose Death: The Dark End of the Third Reich";

  it("the render-531 queries come back era-correct", () => {
    const result = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      extraQueries: ["berlin public transport", "berlin city street"],
      sceneText: SCENE,
      videoTitle: TITLE,
      primaryPerson: "Adolf Hitler",
    });

    expect(result.anchored).toBe(true);
    expect(result.year).toBe("1945");
    // The query that ran first in render 531, now pinned to the period.
    expect(result.primaryQuery).toBe("berlin city skyline 1945");
    // And the person the scene actually names leads the rest.
    expect(result.extraQueries[0]).toMatch(/Adolf Hitler/);
  });

  it("the original phrasings are still there, behind the anchored ones", () => {
    const result = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      extraQueries: ["berlin public transport"],
      sceneText: SCENE,
      videoTitle: TITLE,
      primaryPerson: "Adolf Hitler",
    });
    const all = [result.primaryQuery, ...result.extraQueries];
    // Anchoring may only ADD era-correct candidates — never shrink the pool below what it was.
    expect(all.some((q) => q.includes("berlin public transport"))).toBe(true);
    // But an anchored variant always ranks ahead of its period-less twin.
    const anchoredIdx = all.findIndex((q) => /1945/.test(q));
    const bareIdx = all.findIndex((q) => q === "berlin public transport");
    expect(anchoredIdx).toBeGreaterThan(-1);
    if (bareIdx > -1) expect(anchoredIdx).toBeLessThan(bareIdx);
  });

  it("a scene that states its own year wins over the title's", () => {
    const result = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city street",
      sceneText: "By 1923 the putsch had already failed in Munich.",
      videoTitle: TITLE,
      primaryPerson: "Adolf Hitler",
    });
    expect(result.year).toBe("1923");
    expect(result.primaryQuery).toBe("berlin city street 1923");
  });

  it("a query that already names a year is left alone", () => {
    const result = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin 1945 ruins",
      sceneText: SCENE,
      videoTitle: TITLE,
    });
    expect(result.primaryQuery).toBe("berlin 1945 ruins");
  });

  it("a non-historical video is untouched — no year is ever invented", () => {
    const result = anchorQueriesToHistoricalContext({
      primaryQuery: "berlin city skyline",
      extraQueries: ["berlin public transport"],
      sceneText: "Berlin's transport network moves millions of people every day.",
      videoTitle: "How Berlin Moves: A City in Motion",
    });
    expect(result.anchored).toBe(false);
    expect(result.year).toBe("");
    expect(result.primaryQuery).toBe("berlin city skyline");
    expect(result.extraQueries).toEqual(["berlin public transport"]);
  });
});

describe("RONDE 55 — the Internet Archive geo path is wired through it", () => {
  const SRC = () => readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the geo queries are anchored before they are searched", () => {
    const src = SRC();
    const idx = src.indexOf("const geoQueries = buildInternetArchiveGeoQueries(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("anchorQueriesToHistoricalContext({");
    // The unanchored list is only used when anchoring declined to act.
    expect(block).toContain("anchored.anchored");
    expect(block).toContain(": geoQueries;");
    // And it is the anchored list that reaches the search.
    const callIdx = src.indexOf("fetchInternetArchiveClips(\n      queries,", idx);
    expect(callIdx).toBeGreaterThan(idx);
  });

  it("the raw builder output no longer goes straight to the search", () => {
    const src = SRC();
    // The pre-fix line assigned the builder's result directly to `queries`.
    expect(src).not.toContain(
      "const queries = buildInternetArchiveGeoQueries(beat.text, videoTitle, beat.index);"
    );
  });
});
