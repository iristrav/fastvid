/**
 * RONDE 106 — the render's own account of itself, kept instead of thrown away.
 *
 * The pipeline already explains what it did. It prints a [FinalVisualReport] block, a
 * [RenderAsset] line per clip in the delivered file, a [BeatVisual] line per beat that did not
 * get a picture, the provider funnel, the search gate's tally, the per-step timings. Every one of
 * those went to stdout and nowhere else — which means the only way to find out why a video looks
 * the way it does is to have the Railway log for that render still open.
 *
 * That is the wrong place for it. The question "what did this video's pipeline do" is asked days
 * later, about a specific video, by someone looking at the video. So the lines are collected here
 * and stored with the video, and the admin reads them there.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────────────────────
 *
 * Not a second logging system, and not a capture of every console.log in a 35 000-line file. It
 * collects the STRUCTURED reports the pipeline already composes — the ones that were written to
 * be read — and leaves the running commentary where it is. Each emitter keeps printing exactly as
 * before; `capture` just also remembers.
 *
 * ── Bounded, always ──────────────────────────────────────────────────────────────────────────
 *
 * This ends up in a MySQL JSON column next to the quality report, so it cannot be allowed to grow
 * with the render. Every section is capped and says so when it truncates: a report that silently
 * drops half its lines is worse than one that admits it kept the first N.
 */

/** The order sections appear in the admin, which is the order a person reads them. */
export const PIPELINE_SECTIONS = [
  /** The headline: beats, verification, final clips, provenance, quality status. */
  "summary",
  /** One line per beat that did not end up with its own approved picture. */
  "beats",
  /** One line per clip in the delivered file: provider, asset id, query, verdict. */
  "clips",
  /** Assets the pipeline chose that the file does not contain, and why. */
  "dropped",
  /** Where the render looked, what it found, and what it kept. */
  "sourcing",
  /** What the provider gate built, sent and refused. */
  "search",
  /** Which gate fired how often, including the ones demoted on purpose. */
  "gates",
  /** Wall-clock per pipeline step. */
  "timing",
  /** Anything the render flagged about itself. */
  "warnings",
] as const;

export type PipelineSection = (typeof PIPELINE_SECTIONS)[number];

/** Per-section line cap. Generous enough for a long render, small enough to store. */
const MAX_LINES_PER_SECTION = 300;
/** A single line longer than this is a data dump, not a report line. */
const MAX_LINE_CHARS = 600;

export type RenderPipelineReport = {
  videoId: number;
  renderId?: string;
  startedAt: string;
  finishedAt?: string;
  sections: Partial<Record<PipelineSection, string[]>>;
  /** How many lines each section had to drop, so truncation is never silent. */
  truncated: Partial<Record<PipelineSection, number>>;
};

export type PipelineReportCollector = {
  /** Remember one line. Returns it unchanged so a caller can log and collect in one expression. */
  add: (section: PipelineSection, line: string) => string;
  /** Remember several. */
  addAll: (section: PipelineSection, lines: readonly string[]) => void;
  /** The report as it stands, ready to be stored. */
  build: () => RenderPipelineReport;
};

export function createPipelineReportCollector(
  videoId: number,
  renderId?: string
): PipelineReportCollector {
  const sections = new Map<PipelineSection, string[]>();
  const dropped = new Map<PipelineSection, number>();
  const startedAt = new Date().toISOString();

  const add = (section: PipelineSection, line: string): string => {
    const text = String(line ?? "").trim();
    if (!text) return line;
    const bucket = sections.get(section) ?? [];
    if (bucket.length >= MAX_LINES_PER_SECTION) {
      dropped.set(section, (dropped.get(section) ?? 0) + 1);
      return line;
    }
    bucket.push(text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text);
    sections.set(section, bucket);
    return line;
  };

  return {
    add,
    addAll: (section, lines) => {
      for (const l of lines) add(section, l);
    },
    build: () => ({
      videoId,
      renderId,
      startedAt,
      finishedAt: new Date().toISOString(),
      sections: Object.fromEntries(sections) as RenderPipelineReport["sections"],
      truncated: Object.fromEntries(dropped) as RenderPipelineReport["truncated"],
    }),
  };
}

/** Human-readable section titles for the admin, so the UI holds no vocabulary of its own. */
export const PIPELINE_SECTION_TITLES: Record<PipelineSection, string> = {
  summary: "Samenvatting",
  beats: "Beats zonder goedgekeurd eigen beeld",
  clips: "Clips in de uiteindelijke video",
  dropped: "Gekozen maar niet gerenderd",
  sourcing: "Bronnen en funnel",
  search: "Zoekopdrachten",
  gates: "Gates",
  timing: "Tijd per stap",
  warnings: "Waarschuwingen",
};

/**
 * The few numbers the "all videos" list shows per row.
 *
 * Deliberately small: a table with one row per video cannot carry a report each, and the whole
 * point of the list is to spot the render worth opening. Everything else lives in the detail view.
 */
export type PipelineGlance = {
  qualityStatus?: string;
  score?: number;
  beats?: number;
  verifiedOwnVisual?: number;
  /**
   * DISTINCT CLIPS THIS RENDER USED — not clips in the delivered file.
   *
   * ── P24: four numbers, four questions, near-identical names ─────────────────────────────
   *
   * A production log carried `finalClips=8`, `final_clips=7`, seven `[RenderAsset]` lines and
   * `[AssetIdentity] TOTAL clips=8`, and read as four answers to one question that disagreed with
   * each other. They are four DIFFERENT questions:
   *
   *   uniqueClips (here)        distinct clip paths the render worked with
   *   final_clips               clips PROVEN in the delivered file — records carrying FINAL_VIDEO,
   *                             the ledger's strictest stage
   *   [AssetIdentity] clips     clips the editor manifest carries, with a rehydratable identity
   *   [RenderAsset] lines       clips a picture-editor verdict was actually recorded for
   *
   * None of those is wrong. `8` and `7` differ because a clip the render used need not have reached
   * the delivered file, and a clip in the file need not have been judged. This field was called
   * `finalClips` while carrying `qualityReport.totalClips`, which is the first of the four — so the
   * one name that promised the delivered file was the one that never described it.
   */
  uniqueClips?: number;
  unverifiedClips?: number;
  gateAttempts?: number;
  gateAnswered?: number;
  warnings?: number;
};
