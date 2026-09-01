/**
 * The whole pipeline record of ONE video, as a file an admin can download.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * The admin already SHOWS the pipeline report: `getVideoPipeline` reads it back and the Pipeline
 * tab renders it section by section. That is good for looking and useless for sharing — the useful
 * thing to do with a render's account of itself is to send it to somebody, and a person cannot
 * usefully copy nine collapsible panels out of a browser.
 *
 * So this turns the same stored record into one plain-text file. It re-derives nothing: every line
 * below came out of the render itself, through `renderPipelineReport.ts`, and is reproduced in the
 * order the render wrote it.
 *
 * ── Why text and not JSON ───────────────────────────────────────────────────────────────────
 *
 * The sections ARE log lines — `[SearchQueryAudit] …`, `[VisualCoverageFinal] …`,
 * `[ProductionRoute] …`. Wrapping log lines in JSON makes them harder to read and no more
 * complete. The structured extras (glance, quality, timing) are small, so they are printed as
 * readable key/value blocks rather than left out.
 *
 * ── The rule this file follows ──────────────────────────────────────────────────────────────
 *
 * Never invent a section that is not there. A video rendered before the report existed, or one
 * that never finished, has no report — and the file says exactly that, with whatever the render
 * DID leave behind (its status and its error). An empty download that looks like a broken feature
 * is worse than a file that explains itself.
 */
import { PIPELINE_SECTIONS, type PipelineGlance, type RenderPipelineReport } from "./renderPipelineReport";

/** Human titles for the section keys, in the order the render writes them. */
export const SECTION_TITLES: Record<(typeof PIPELINE_SECTIONS)[number], string> = {
  summary: "SAMENVATTING",
  beats: "BEATS ZONDER GOEDGEKEURD EIGEN BEELD",
  clips: "CLIPS IN DE UITEINDELIJKE VIDEO",
  dropped: "GEKOZEN MAAR NIET GERENDERD",
  sourcing: "BRONNEN EN FUNNEL",
  search: "ZOEKOPDRACHTEN",
  gates: "GATES",
  timing: "TIJD PER STAP",
  warnings: "WAARSCHUWINGEN",
};

export type PipelineExportInput = {
  videoId: number;
  status: string | null;
  title: string | null;
  prompt: string | null;
  createdAt: Date | string | null;
  errorMessage: string | null;
  pipelineReport: RenderPipelineReport | null;
  pipelineGlance: PipelineGlance | null;
  qualityReport: unknown;
  pipelineStepTiming: unknown;
};

function heading(text: string): string[] {
  return ["", "=".repeat(78), text, "=".repeat(78)];
}

/**
 * A small structured extra, printed as lines.
 *
 * Objects and arrays are flattened one level deep, which is as far as any of these actually nest;
 * anything deeper falls back to compact JSON rather than being dropped. Nothing is summarised
 * away — this file's whole purpose is that the reader gets everything the render stored.
 */
function structured(value: unknown, indent = "  "): string[] {
  if (value == null) return [`${indent}(niets vastgelegd)`];
  if (typeof value !== "object") return [`${indent}${String(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}(leeg)`];
    return value.map((v) =>
      typeof v === "object" && v !== null ? `${indent}${JSON.stringify(v)}` : `${indent}${String(v)}`
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [`${indent}(leeg)`];
  return entries.map(([k, v]) =>
    typeof v === "object" && v !== null
      ? `${indent}${k} = ${JSON.stringify(v)}`
      : `${indent}${k} = ${String(v)}`
  );
}

/** The filename an admin gets. Safe on every OS, and identifies the video at a glance. */
export function pipelineExportFilename(videoId: number, title: string | null): string {
  const safe = (title ?? "")
    .replace(/[^a-zA-Z0-9\-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const id = `VID-${String(videoId).padStart(4, "0")}`;
  return `fastvid-pipeline-${id}${safe ? `-${safe}` : ""}.txt`;
}

/**
 * The whole record as one text file.
 *
 * Always returns content. A video with no report still produces a file saying so, because the
 * question "why is there no report for this render" is itself worth being able to send to somebody.
 */
export function formatPipelineExport(input: PipelineExportInput): string {
  const out: string[] = [];
  const report = input.pipelineReport;

  out.push(
    "FASTVID — VOLLEDIG PIPELINE-RAPPORT",
    "",
    `video          VID-${String(input.videoId).padStart(4, "0")} (#${input.videoId})`,
    `status         ${input.status ?? "onbekend"}`,
    `titel          ${input.title ?? "—"}`,
    /** The user's own prompt — this is the topic the search gate is authorised by. */
    `prompt         ${input.prompt ?? "—"}`,
    `aangemaakt     ${input.createdAt ? new Date(input.createdAt).toISOString() : "—"}`,
    `geëxporteerd   ${new Date().toISOString()}`
  );
  if (report?.renderId) out.push(`render         ${report.renderId}`);
  if (report?.startedAt) out.push(`render start   ${report.startedAt}`);
  if (report?.finishedAt) out.push(`render eind    ${report.finishedAt}`);
  if (input.errorMessage) out.push("", `FOUT           ${input.errorMessage}`);

  if (input.pipelineGlance) {
    out.push(...heading("KERNCIJFERS"));
    out.push(...structured(input.pipelineGlance));
  }

  if (!report?.sections) {
    out.push(...heading("GEEN PIPELINE-RAPPORT"));
    out.push(
      "",
      "Deze video heeft geen opgeslagen pipeline-rapport. Dat gebeurt bij een render die",
      "vóór deze functie is gedraaid, of bij een render die niet is afgerond — de status en",
      "de eventuele foutmelding bovenaan zijn dan alles wat is vastgelegd.",
      ""
    );
    return out.join("\n");
  }

  /**
   * Every section, in the render's own order, including the empty ones.
   *
   * An empty section is information: "the render looked and found nothing to report here" is not
   * the same as "this section does not exist", and silently omitting it would hide the difference.
   */
  for (const key of PIPELINE_SECTIONS) {
    const lines = report.sections[key] ?? [];
    const dropped = report.truncated?.[key] ?? 0;
    out.push(...heading(`${SECTION_TITLES[key]}  (${lines.length} regels${dropped > 0 ? `, ${dropped} afgekapt` : ""})`));
    out.push("");
    if (lines.length === 0) out.push("  (geen regels)");
    else out.push(...lines);
    if (dropped > 0) {
      out.push("", `  … ${dropped} regel(s) afgekapt — het rapport is per sectie begrensd.`);
    }
  }

  out.push(...heading("KWALITEITSRAPPORT"));
  out.push(...structured(input.qualityReport));
  out.push(...heading("TIJD PER PIPELINE-STAP"));
  out.push(...structured(input.pipelineStepTiming));
  out.push("");
  return out.join("\n");
}
