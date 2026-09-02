/**
 * `videos.metadata` HAS TWO SHAPES, AND FOUR READERS DISAGREED ABOUT WHICH.
 *
 * ── The reported symptom ────────────────────────────────────────────────────────────────────
 *
 * "Ik zie de pipeline niet meer in de admin staan. Bij alle video's."
 *
 * ── What the code says ──────────────────────────────────────────────────────────────────────
 *
 * The column is `json("metadata")`. What the driver hands back depends on its configuration:
 * mysql2 returns a parsed object in some setups and the raw JSON STRING in others. Four places
 * read it, each assuming a different one:
 *
 *   1. `readVideoMetadataObject`        object only — a string silently became `{}`
 *   2. `admin.getVideoPipeline`         blind cast — `meta?.pipelineReport` on a string is
 *                                       `undefined`, so the tab renders "Geen pipeline-rapport"
 *   3. `updateVideoEditorSettings`      `{ ...metadata }` — spreading a STRING yields
 *                                       `{0:"{",1:'"',…}`, and it WRITES THAT BACK
 *   4. `Admin.tsx`                      `JSON.parse(metadata)` — string only, threw on an object
 *
 * At most one of those can be right at a time. And #3 does not merely misread: it destroys. One
 * saved editor setting rewrites the column with character-indexed junk, taking qualityReport,
 * pipelineReport and pipelineGlance with it — for that video, permanently.
 *
 * ── What these tests protect ────────────────────────────────────────────────────────────────
 *
 * One reader, both shapes, never throwing. The corrupting spread is the test that matters most:
 * it is the one that loses data rather than merely failing to show it.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { readVideoMetadataObject } from "./db";

const REPORT = {
  qualityReport: { score: 71 },
  pipelineReport: { renderId: "r-1", sections: { summary: ["[ProductionRoute] route=cinematic"] } },
  pipelineGlance: { beats: 21 },
};

/* ═══════════════════════ one reader, both shapes ═══════════════════════ */

describe("videos.metadata — the one reader accepts either shape", () => {
  it("reads a parsed object", () => {
    expect(readVideoMetadataObject({ metadata: REPORT })).toEqual(REPORT);
  });

  /** The shape that made the admin tab go blank on every video. */
  it("reads a JSON string", () => {
    const meta = readVideoMetadataObject({ metadata: JSON.stringify(REPORT) });
    expect(meta).toEqual(REPORT);
    expect(meta.pipelineReport, "the pipeline report is unreachable from a string column")
      .toBeTruthy();
  });

  it("never throws, whatever is in the column", () => {
    for (const value of [null, undefined, "", "   ", "not json", "[1,2,3]", 42, [], true]) {
      expect(() => readVideoMetadataObject({ metadata: value })).not.toThrow();
      expect(readVideoMetadataObject({ metadata: value })).toEqual({});
    }
  });

  /** A JSON array is valid JSON and is not a metadata record — it must not become one. */
  it("refuses a JSON array rather than indexing it", () => {
    expect(readVideoMetadataObject({ metadata: '["a","b"]' })).toEqual({});
  });

  it("survives a missing video", () => {
    expect(readVideoMetadataObject(null)).toEqual({});
    expect(readVideoMetadataObject(undefined)).toEqual({});
  });
});

/* ═══════════════════════ the reader that DESTROYED data ═══════════════════════ */

describe("videos.metadata — a save must never erase the render's record", () => {
  /**
   * The defect, demonstrated on plain JavaScript. This is what
   * `{ ...((video.metadata ?? {}) as Record<string, unknown>) }` did when the column came back as
   * a string, and the result was written straight back to the column.
   */
  it("spreading a JSON string produces character-indexed junk", () => {
    const spread = { ...(JSON.stringify(REPORT) as unknown as Record<string, unknown>) };
    expect(spread.pipelineReport, "the old spread appeared to keep the report").toBeUndefined();
    expect(Object.keys(spread).length, "it produced one key per character").toBeGreaterThan(20);
    expect(Object.keys(spread)[0]).toBe("0");
  });

  /** Through the canonical reader the same value round-trips intact. */
  it("the canonical reader keeps every field a save must not lose", () => {
    const meta = { ...readVideoMetadataObject({ metadata: JSON.stringify(REPORT) }) };
    expect(meta.pipelineReport).toEqual(REPORT.pipelineReport);
    expect(meta.qualityReport).toEqual(REPORT.qualityReport);
    expect(meta.pipelineGlance).toEqual(REPORT.pipelineGlance);
  });

  /**
   * And the writer really uses it. `updateVideoEditorSettings` saves an editor setting and writes
   * the whole metadata object back, so a blind spread there is a data-loss bug rather than a
   * display bug.
   */
  it("updateVideoEditorSettings reads through the canonical reader", () => {
    const src = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
    const at = src.indexOf("export async function updateVideoEditorSettings(");
    expect(at, "updateVideoEditorSettings has moved").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}", src.indexOf("db.update(videos).set(patch)", at)));
    expect(body, "the editor save still spreads the raw column").not.toMatch(
      /\{\s*\.\.\.\(\(video\.metadata/
    );
    expect(body).toContain("readVideoMetadataObject(video)");
  });
});

/* ═══════════════════════ every reader now goes through it ═══════════════════════ */

describe("videos.metadata — no reader assumes a shape on its own", () => {
  const files = [
    ["routers.ts", path.join(__dirname, "routers.ts")],
    ["db.ts", path.join(__dirname, "db.ts")],
    ["_core/index.ts", path.join(__dirname, "_core", "index.ts")],
  ] as const;

  /**
   * The blind cast is the pattern that made the pipeline tab blank. It is banned by shape rather
   * than by location, so a new reader cannot reintroduce it somewhere else.
   */
  it.each(files)("%s casts video.metadata nowhere", (_name, file) => {
    const code = fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const casts = [...code.matchAll(/(video|row)\.metadata\s*\?\?[^;]*as Record<string, unknown>/g)];
    expect(
      casts.map((m) => m[0]),
      "a blind cast of videos.metadata — use readVideoMetadataObject, which handles both shapes"
    ).toEqual([]);
  });

  /** The admin's own reader must handle both too, or the Metadata tab breaks on the other shape. */
  it("the admin UI accepts an object as well as a string", () => {
    const ui = fs.readFileSync(path.join(__dirname, "..", "client", "src", "pages", "Admin.tsx"), "utf8");
    const at = ui.indexOf("let parsedMeta");
    const block = ui.slice(at, at + 1200);
    expect(block, "the admin still assumes metadata is a string").toContain('typeof raw === "object"');
    expect(block).toContain('typeof raw === "string"');
  });
});
