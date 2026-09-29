import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { anchorQueriesToHistoricalContext } from "./mediaResearchEngine";

describe("RONDE 55 — the Internet Archive geo path is wired through it", () => {
  const SRC = () => readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the raw builder output no longer goes straight to the search", () => {
    const src = SRC();
    // The pre-fix line assigned the builder's result directly to `queries`.
    expect(src).not.toContain(
      "const queries = buildInternetArchiveGeoQueries(beat.text, videoTitle, beat.index);"
    );
  });
});
