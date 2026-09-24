/**
 * RONDE 650 — RENDER 607: THE SEARCH KEY RAN DRY, AND THE QUERIES NAMED NOBODY.
 *
 *   1  One licence pass per query by default (the widest), so a day's 10,000 units last; the two
 *      queries alternate short / medium so both duration slices are still asked.
 *   2  A query that names nobody is not sent while the list has queries that do.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { youtubeSearchDurationForPass, youtubeSearchPassesPerQuery } from "./sourcingPolicy";
import { queriesThatNameSomething, queryNamesSomething } from "./youtubeNonFootage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

describe("1 — one search per query", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.YOUTUBE_SEARCH_PASSES;
    delete process.env.YOUTUBE_SEARCH_PASSES;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.YOUTUBE_SEARCH_PASSES;
    else process.env.YOUTUBE_SEARCH_PASSES = saved;
  });

  it("one pass by default; YOUTUBE_SEARCH_PASSES restores more; nonsense falls back to one", () => {
    expect(youtubeSearchPassesPerQuery()).toBe(1);
    process.env.YOUTUBE_SEARCH_PASSES = "3";
    expect(youtubeSearchPassesPerQuery()).toBe(3);
    process.env.YOUTUBE_SEARCH_PASSES = "zero";
    expect(youtubeSearchPassesPerQuery()).toBe(1);
    process.env.YOUTUBE_SEARCH_PASSES = "0";
    expect(youtubeSearchPassesPerQuery()).toBe(1);
  });

  it("with one pass, the two queries cover both duration slices", () => {
    expect(youtubeSearchDurationForPass(0, 1, 0)).toBe("short");
    expect(youtubeSearchDurationForPass(0, 1, 1)).toBe("medium");
    // Callers that do not say which query keep the old one-pass answer.
    expect(youtubeSearchDurationForPass(0, 1)).toBe("medium");
    // With several passes, the passes alternate exactly as before.
    expect(youtubeSearchDurationForPass(0, 3, 1)).toBe("short");
    expect(youtubeSearchDurationForPass(1, 3, 0)).toBe("medium");
  });

  it("the passes are cut after they are ordered, so the widest one is the one kept", () => {
    const anyFirst = PIPE.indexOf("if (recallFirst && youtubeFairUseEnabled()) licensePasses.push(anyPass);");
    const cut = PIPE.indexOf("licensePasses.splice(youtubeSearchPassesPerQuery());");
    const loop = PIPE.indexOf("for (const [queryIndex, query] of uniqueQueries.slice(0, 2).entries()) {");
    expect(anyFirst).toBeGreaterThan(-1);
    expect(cut).toBeGreaterThan(anyFirst);
    expect(loop).toBeGreaterThan(cut);
  });
});

describe("2 — a query that names nobody is not sent while others do", () => {
  // Render 607's person lock read "Hitler Kill" — the reason nothing is prefixed.
  const LOCK = "Hitler Kill";

  it("render 607's beat s0b2: the subject-less query goes, the named ones stay", () => {
    const queries = [
      "suicide archival footage",
      "Adolf Hitler suicide archival footage",
      "Adolf Hitler archival footage",
    ];
    expect(queriesThatNameSomething(queries, LOCK)).toEqual([
      "Adolf Hitler suicide archival footage",
      "Adolf Hitler archival footage",
    ]);
  });

  it.each(["escape archival footage", "broader disintegration archival footage", "suicide"])(
    "names nobody: %s",
    (q) => expect(queryNamesSomething(q, LOCK)).toBe(false)
  );

  it.each([
    "hitler rumors archival footage",
    "Joseph Goebbels Führerbunker archival footage",
    "Third Reich archival footage",
    "Berlin 1945 ruins",
  ])("names something: %s", (q) => expect(queryNamesSomething(q, LOCK)).toBe(true));

  it("a topic film whose queries all name nobody keeps every one of them", () => {
    const topic = ["steam locomotive archival footage", "railway station archival footage"];
    expect(queriesThatNameSomething(topic, "")).toEqual(topic);
  });

  it("nothing is prefixed: a wrong person lock cannot reach a query", () => {
    expect(queriesThatNameSomething(["escape archival footage"], LOCK)).toEqual(["escape archival footage"]);
  });

  it("the beat query builder filters its whole list", () => {
    const fn = PIPE.slice(PIPE.indexOf("function buildBeatYoutubeQueries("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("const unique = queriesThatNameSomething(all, coercePersonName(personName));");
  });
});
