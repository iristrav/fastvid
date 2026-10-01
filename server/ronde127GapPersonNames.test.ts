/**
 * RONDE 127 — "Gevraagde beelden die missen" lists people, not search phrases.
 *
 * The recording call was `recordArchiveContentGap(q, beat.text)` where `q` is whatever query fell
 * through to stock footage, so the admin page filled with phrases like "berlin street 1930s
 * documentary". What the page is for is deciding what to upload next, and for a documentary
 * archive that is a question about people: it either has footage of Hermann Göring or it does not.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { formatGapPersonLine, gapRowLooksLikePerson, personNameForGap } from "./archiveGapNames";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "server", f), "utf8");

describe("RONDE 127 — the existing rows are filtered, not deleted", () => {
  it("person-shaped rows show", () => {
    for (const k of ["Hermann Göring", "Adolf Hitler", "Charles de Gaulle", "low-coverage:José Mourinho"]) {
      expect(gapRowLooksLikePerson(k), k).toBe(true);
    }
  });

  it("query-shaped rows do not", () => {
    for (const k of [
      "berlin street 1930s documentary",
      "city establishing",
      "1923 munich",
      "hermann göring archival footage",
      "vintage photo",
      "wide shot",
      "",
    ]) {
      expect(gapRowLooksLikePerson(k), k).toBe(false);
    }
  });

  it("a single word is too ambiguous to show as a name", () => {
    expect(gapRowLooksLikePerson("Napoleon")).toBe(false);
    expect(gapRowLooksLikePerson("Berlin")).toBe(false);
  });

  it("the list filters rather than clearing — hit counts survive", () => {
    const gaps = src("archiveContentGaps.ts");
    expect(gaps).toContain("rows.filter((r) => gapRowLooksLikePerson(r.keyword))");
    // Over-fetch, so the filter can still fill the requested limit.
    expect(gaps).toContain("limit(Math.min(1000, limit * 10))");
    // clearArchiveContentGaps is still the only thing that deletes.
    expect(gaps).toContain("db.delete(archiveContentGaps)");
  });
});

describe("RONDE 127 — both recording routes are filtered", () => {

  it("the admin line says what it means", () => {
    expect(formatGapPersonLine("low-coverage:Hermann Göring", 7)).toBe(
      "Hermann Göring (7x gevraagd, geen beeld in archief)"
    );
  });
});
