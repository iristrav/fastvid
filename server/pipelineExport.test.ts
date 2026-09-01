/**
 * The admin's whole-pipeline download.
 *
 * ── What is being protected ─────────────────────────────────────────────────────────────────
 *
 * Two things, and the second matters more than the first.
 *
 *   1. The file is COMPLETE. Every section the render wrote is in it, in the render's own order,
 *      including the empty ones and including the note that a section was truncated. A download
 *      that quietly drops a section is worse than no download, because the reader has no way to
 *      know something is missing.
 *
 *   2. The endpoint is ADMIN ONLY. The MP4 download beside it admits the video's owner as well,
 *      and copying that rule here would be wrong: this file names providers, queries, gate verdicts
 *      and internal reasons for every beat. That is operational detail about how FastVid works, not
 *      something a customer's own video entitles them to.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  formatPipelineExport,
  pipelineExportFilename,
  SECTION_TITLES,
  type PipelineExportInput,
} from "./pipelineExport";
import { PIPELINE_SECTIONS } from "./renderPipelineReport";

const REPORT = {
  renderId: "r-abc123",
  startedAt: "2026-09-01T10:00:00.000Z",
  finishedAt: "2026-09-01T10:06:30.000Z",
  sections: {
    summary: ["[ProductionRoute] video=42 route=cinematic_timeline", "[VisualCoverageFinal] COVERAGE beats=29 REAL_ASSET=21"],
    search: ["[SearchQueryAudit] status=BLOCKED blockedTerms=[\"WWII\"]"],
    warnings: [],
  },
  truncated: { search: 17 },
} as PipelineExportInput["pipelineReport"];

function input(over: Partial<PipelineExportInput> = {}): PipelineExportInput {
  return {
    videoId: 42,
    status: "completed",
    title: "The July 20 Plot",
    prompt: "A documentary about Stauffenberg and the July 20 plot",
    createdAt: "2026-09-01T09:58:00.000Z",
    errorMessage: null,
    pipelineReport: REPORT,
    pipelineGlance: { qualityStatus: "ok", score: 71, beats: 29, verifiedOwnVisual: 21 },
    qualityReport: { verdict: "acceptable", findings: ["shot variety is low in scene 3"] },
    pipelineStepTiming: { scene_generation: 4210, voiceover: 51200 },
    ...over,
  };
}

/* ═══════════════════════ the file is complete ═══════════════════════ */

describe("pipeline export — everything the render recorded is in the file", () => {
  const text = formatPipelineExport(input());

  it("identifies the video, including the prompt the gate was authorised by", () => {
    expect(text).toContain("VID-0042");
    expect(text).toContain("completed");
    expect(text).toContain("The July 20 Plot");
    expect(text).toContain("A documentary about Stauffenberg and the July 20 plot");
    expect(text).toContain("r-abc123");
  });

  /**
   * Every section, empty ones included. An empty section says "the render looked and had nothing
   * to report"; omitting it would make that indistinguishable from a section that does not exist.
   */
  it("contains every section the render can write", () => {
    for (const key of PIPELINE_SECTIONS) {
      /** Every key must have a heading, and every heading must reach the file. */
      const title = SECTION_TITLES[key];
      expect(title, `section "${key}" has no heading`).toBeTruthy();
      expect(text, `section "${key}" (${title}) is missing from the export`).toContain(title);
    }
    /** The one that was empty in the fixture is present and says so, rather than vanishing. */
    expect(text).toContain("(geen regels)");
  });

  it("reproduces the log lines verbatim", () => {
    expect(text).toContain("[ProductionRoute] video=42 route=cinematic_timeline");
    expect(text).toContain("[VisualCoverageFinal] COVERAGE beats=29 REAL_ASSET=21");
    expect(text).toContain('[SearchQueryAudit] status=BLOCKED blockedTerms=["WWII"]');
  });

  /** Truncation is the one thing a reader cannot infer from the file, so it has to be stated. */
  it("says when the render itself dropped lines", () => {
    expect(text).toContain("17 afgekapt");
    expect(text).toMatch(/17 regel\(s\) afgekapt/);
  });

  it("carries the small structured extras rather than leaving them out", () => {
    expect(text).toContain("score = 71");
    expect(text).toContain("verdict = acceptable");
    expect(text).toContain("scene_generation = 4210");
  });
});

/* ═══════════════════════ the awkward cases ═══════════════════════ */

describe("pipeline export — a video with no report still produces a usable file", () => {
  /**
   * The case this feature is most often needed for. A render that broke has no report, and
   * returning an empty file would read as a broken download rather than as the answer.
   */
  const text = formatPipelineExport(
    input({
      status: "failed",
      pipelineReport: null,
      pipelineGlance: null,
      qualityReport: null,
      pipelineStepTiming: null,
      errorMessage: "Timeout: scene 3 exceeded 600s (10101)",
    })
  );

  it("explains why there is no report instead of returning nothing", () => {
    expect(text).toContain("GEEN PIPELINE-RAPPORT");
    expect(text.length).toBeGreaterThan(200);
  });

  it("still carries the status and the error, which is what there is to send on", () => {
    expect(text).toContain("failed");
    expect(text).toContain("Timeout: scene 3 exceeded 600s");
  });

  it("never throws on a video with nothing recorded at all", () => {
    expect(() =>
      formatPipelineExport({
        videoId: 1, status: null, title: null, prompt: null, createdAt: null,
        errorMessage: null, pipelineReport: null, pipelineGlance: null,
        qualityReport: null, pipelineStepTiming: null,
      })
    ).not.toThrow();
  });
});

describe("pipeline export — the filename", () => {
  it("identifies the video and survives any title", () => {
    expect(pipelineExportFilename(42, "The July 20 Plot")).toBe("fastvid-pipeline-VID-0042-The-July-20-Plot.txt");
    expect(pipelineExportFilename(7, null)).toBe("fastvid-pipeline-VID-0007.txt");
  });

  /** A title is user-supplied text; it must not be able to shape the filename. */
  it("strips anything a title could smuggle into a path or a header", () => {
    const name = pipelineExportFilename(3, '../../etc/passwd "; rm -rf /');
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name).not.toContain('"');
    expect(name.endsWith(".txt")).toBe(true);
  });
});

/* ═══════════════════════ the endpoint's access rule ═══════════════════════ */

describe("pipeline export — admin only, with no owner exemption", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");
  const ROUTE = (() => {
    const start = SRC.indexOf('app.get("/api/admin/pipeline/:id"');
    expect(start, "the pipeline download endpoint is gone").toBeGreaterThan(-1);
    const end = SRC.indexOf("app.get(", start + 10);
    return SRC.slice(start, end > start ? end : undefined);
  })();

  /**
   * The MP4 download beside this one reads `video.userId !== userId && user?.role !== "admin"` —
   * owner OR admin. Copying that here would hand a customer the provider names, the queries and the
   * gate verdicts behind their video. This endpoint checks the role and nothing else.
   */
  it("requires the admin role and does not admit the owner", () => {
    expect(ROUTE).toContain('user?.role !== "admin"');
    expect(ROUTE, "an owner exemption was copied from the MP4 download")
      .not.toMatch(/video\.userId\s*!==\s*userId/);
  });

  it("still requires a valid session before looking at the role", () => {
    expect(ROUTE).toContain("jwtVerify");
    expect(ROUTE).toContain('res.status(401)');
  });

  /** Available for every video, not only completed ones — a failed render is the interesting case. */
  it("does not require the video to have an MP4", () => {
    expect(ROUTE, "the export refuses videos without a rendered file")
      .not.toMatch(/if \(!video\.videoUrl\)/);
  });

  it("sends a downloadable text file", () => {
    expect(ROUTE).toContain("text/plain");
    expect(ROUTE).toContain("attachment; filename=");
  });
});
