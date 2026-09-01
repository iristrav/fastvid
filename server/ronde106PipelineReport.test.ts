/**
 * RONDE 106 — the render's account of itself is stored with the video, and shown in the admin.
 *
 * The pipeline already explains what it did: a [FinalVisualReport] block, a [RenderAsset] line per
 * clip in the delivered file, a [BeatVisual] line per beat that got no picture, the provider
 * funnel, the search gate's tally, the timings. All of it went to stdout and nowhere else — so the
 * only way to answer "why does this video look like this" was to still have that render's Railway
 * log open. Days later, about a specific video, that is not an answer.
 *
 * The same lines are now collected as they are printed and stored with the video. The diagnostic
 * card that used to sit under the viewer's own video is gone: it reports on how the render was
 * assembled, which is a question for whoever maintains the pipeline.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  PIPELINE_SECTIONS,
  createPipelineReportCollector,
  type PipelineSection,
} from "./renderPipelineReport";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
const ADMIN = fs.readFileSync(path.join(__dirname, "..", "client", "src", "pages", "Admin.tsx"), "utf8");
const DASHBOARD = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "pages", "Dashboard.tsx"),
  "utf8"
);

/* ═══════════ the collector ═══════════ */

describe("RONDE 106 — the collector", () => {
  it("returns the line it was given, so a caller can log and collect in one expression", () => {
    const c = createPipelineReportCollector(1, "render-1");
    const line = "[FinalVisualReport] beats=15";
    expect(c.add("summary", line)).toBe(line);
    expect(c.build().sections.summary).toEqual([line]);
  });

  it("keeps sections apart, in the order a person reads them", () => {
    const c = createPipelineReportCollector(1);
    c.add("clips", "[RenderAsset] a");
    c.add("beats", "[BeatVisual] b");
    const built = c.build();
    expect(built.sections.clips).toEqual(["[RenderAsset] a"]);
    expect(built.sections.beats).toEqual(["[BeatVisual] b"]);
    expect(PIPELINE_SECTIONS[0]).toBe("summary");
  });

  it("is bounded, and says how much it dropped rather than truncating silently", () => {
    /**
     * This ends up in a JSON column next to the quality report. A report that quietly keeps the
     * first N lines of a long render is worse than one that admits it: the reader would draw
     * conclusions from a list that looks complete.
     */
    const c = createPipelineReportCollector(1);
    for (let i = 0; i < 400; i++) c.add("clips", `[RenderAsset] clip ${i}`);
    const built = c.build();
    expect(built.sections.clips!.length).toBe(300);
    expect(built.truncated.clips).toBe(100);
  });

  it("caps a single runaway line instead of storing a data dump", () => {
    const c = createPipelineReportCollector(1);
    c.add("sourcing", "x".repeat(5000));
    const stored = c.build().sections.sourcing![0]!;
    expect(stored.length).toBeLessThan(700);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("ignores empty lines, which are not report content", () => {
    const c = createPipelineReportCollector(1);
    c.add("summary", "   ");
    c.add("summary", "");
    expect(c.build().sections.summary).toBeUndefined();
  });

  it("records the render id and when it finished, so a report can be placed in time", () => {
    const built = createPipelineReportCollector(42, "render-abc").build();
    expect(built.videoId).toBe(42);
    expect(built.renderId).toBe("render-abc");
    expect(Date.parse(built.finishedAt!)).toBeGreaterThan(0);
  });
});

/* ═══════════ the wiring ═══════════ */

describe("RONDE 106 — the render collects what it already prints", () => {
  it("the collector is created before anything worth keeping is emitted", () => {
    const created = PIPELINE.indexOf("const pipelineReport = createPipelineReportCollector(");
    const firstUse = PIPELINE.indexOf('pipelineReport.add("');
    expect(created).toBeGreaterThan(-1);
    expect(firstUse).toBeGreaterThan(created);
  });

  it("every structured report the render composes is collected", () => {
    /**
     * The rule is: nothing was re-instrumented. Each emitter still prints exactly what it printed
     * before; the collector sits on the way to the console. So each of these must appear with a
     * pipelineReport.add around or beside it.
     */
    const expectations: Array<[string, PipelineSection]> = [
      ["formatSourceSummary", "sourcing"],
      ["formatFunnelReport", "sourcing"],
      ["formatAssetUsageSummary", "sourcing"],
      ["formatRenderManifest", "clips"],
      ["formatFinalVisualReport", "summary"],
      ["formatBeatVisualProblems", "beats"],
      ["formatSelectedButNotRendered", "dropped"],
      ["formatSearchGateReport", "search"],
    ];
    for (const [emitter, section] of expectations) {
      const idx = PIPELINE.lastIndexOf(`${emitter}(`);
      expect(idx, `${emitter} not called`).toBeGreaterThan(-1);
      const block = PIPELINE.slice(idx, idx + 900);
      expect(block, `${emitter} is not collected into "${section}"`).toContain(
        `pipelineReport.add("${section}"`
      );
    }
  });

  it("the report and the glance are stored with the video, in the same merge as the quality report", () => {
    const idx = PIPELINE.indexOf("await mergeVideoMetadata(videoId, {");
    expect(idx).toBeGreaterThan(-1);
    const block = PIPELINE.slice(idx, idx + 1400);
    expect(block).toContain("qualityReport,");
    expect(block).toContain("pipelineReport: pipelineReport.build(),");
    expect(block).toContain("pipelineGlance: {");
    // The glance carries what the "all videos" table shows, and nothing heavy.
    for (const key of ["qualityStatus", "score", "beats", "verifiedOwnVisual", "gateAttempts"]) {
      expect(block, key).toContain(`${key}:`);
    }
  });

  it("the demoted gates are reported as information, not as an alarm", () => {
    // RONDE 103/104 took the veto off vision_gate and off_topic_protest on purpose. The admin
    // still wants to know how often they WOULD have fired.
    expect(PIPELINE).toContain("for (const row of summarizeDemotedGates(gateStats))");
    expect(PIPELINE).toContain("[GateDemoted]");
    expect(PIPELINE).toContain("bewust geen veto meer");
  });

  it("collecting cannot fail a render — it is inside the audit's own try/catch", () => {
    const anchor = PIPELINE.indexOf("const deliveredScenes = new Set(finalConcatInputs");
    const tryIdx = PIPELINE.lastIndexOf("try {", anchor);
    const catchIdx = PIPELINE.indexOf("[VisualAudit] audit reporting failed (non-fatal)", anchor);
    const collectIdx = PIPELINE.indexOf('pipelineReport.add("clips"', anchor);
    expect(tryIdx).toBeLessThan(collectIdx);
    expect(collectIdx).toBeLessThan(catchIdx);
  });
});

/* ═══════════ the admin ═══════════ */

describe("RONDE 106 — the admin reads it back", () => {
  it("there is an endpoint that returns one video's whole pipeline", () => {
    expect(ROUTERS).toContain("getVideoPipeline: adminProcedure");
    const idx = ROUTERS.indexOf("getVideoPipeline: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 1400);
    expect(block).toContain("pipelineReport:");
    expect(block).toContain("pipelineGlance:");
    expect(block).toContain("qualityReport:");
    // It reads back what was stored; it must not re-derive anything.
    expect(block).not.toContain("buildVideoQualityReport");
    expect(block).not.toContain("computeMeritQualityScore");
  });

  it("the video LIST does not carry a full report per row", () => {
    /**
     * searchVideos returns metadata verbatim and the list asks for a hundred rows. Shipping nine
     * sections of a few hundred lines each, a hundred times, to render a table would make the
     * admin slow for the one badge a person is scanning for.
     */
    const idx = ROUTERS.indexOf("const rows = await searchVideos(input);");
    expect(idx).toBeGreaterThan(-1);
    const block = ROUTERS.slice(idx, idx + 700);
    expect(block).toContain("pipelineReport: _omitted");
    // ...but the small glance stays, which is what the row shows.
    expect(block).not.toContain("pipelineGlance: _");
  });

  it("the videos table has a Pipeline column fed by the glance", () => {
    expect(ADMIN).toContain('<th className="text-left px-4 py-3">Pipeline</th>');
    expect(ADMIN).toContain("<PipelineGlanceCell metadata={video.metadata} />");
    expect(ADMIN).toContain("function readGlance(metadata: unknown)");
    // The empty-state colspan grew with the table, or it renders short.
    expect(ADMIN).toContain('colSpan={8}');
  });

  it("the detail modal has a Pipeline tab that renders every section", () => {
    expect(ADMIN).toContain('{ id: "pipeline" as const, label: "Pipeline" }');
    expect(ADMIN).toContain('{tab === "pipeline" && <VideoPipelineTab videoId={video.id} />}');
    expect(ADMIN).toContain("trpc.admin.getVideoPipeline.useQuery({ videoId })");
    for (const section of PIPELINE_SECTIONS) {
      expect(ADMIN, `section ${section} is not rendered`).toContain(`["${section}",`);
    }
  });

  it("truncation is shown to the reader, not swallowed by the UI", () => {
    expect(ADMIN).toContain("report.truncated?.[key]");
    expect(ADMIN).toContain("afgekapt");
  });

  it("a video with no stored report says so instead of rendering an empty page", () => {
    expect(ADMIN).toContain("Geen pipeline-rapport voor deze video.");
  });
});

/* ═══════════ removed from the viewer ═══════════ */

describe("RONDE 106 — the diagnostic card is gone from the user's own video", () => {
  it("the quality card no longer renders in the dashboard", () => {
    expect(DASHBOARD).not.toContain("Visual quality —");
    expect(DASHBOARD).not.toContain("qualityReport.warnings.map");
    expect(DASHBOARD).not.toContain("rejectSummary");
  });

  it("the score badge is gone from the video card too", () => {
    expect(DASHBOARD).not.toContain("qualityScoreColor(");
    expect(DASHBOARD).not.toContain("qualityStatusLabel(");
    expect(DASHBOARD).not.toContain("readQualityReportFromMetadata(");
  });

  it("the removal says where it went, so nobody re-adds it by accident", () => {
    expect(DASHBOARD).toContain("RONDE 106 — the quality report moved to the admin.");
    expect(DASHBOARD).toContain("Admin → Videos → Pipeline");
  });

  it("the report itself is untouched — only where it is SHOWN changed", () => {
    // The pipeline still builds and persists it; this round moved the audience, not the data.
    expect(PIPELINE).toContain("const qualityReport = buildVideoQualityReport(");
    expect(PIPELINE).toContain("qualityReport,");
    const shared = fs.readFileSync(path.join(__dirname, "..", "shared", "videoQuality.ts"), "utf8");
    expect(shared).toContain("export function qualityStatusLabel(");
  });
});
