/**
 * Render Quality Report — formats an EditorialReview as a terminal report.
 *
 * Printed to stdout after every render (fire-and-forget).
 * Uses ANSI colours for clarity in Railway / local terminals.
 */

import type { EditorialReview } from "./editorialReviewEngine";

// ─── Colour helpers ────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

function scoreColour(score: number): string {
  if (score >= 80) return C.green;
  if (score >= 60) return C.yellow;
  return C.red;
}

function bar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pad(label: string, len = 22): string {
  return label.padEnd(len, " ");
}

function scoreLine(label: string, score: number): string {
  const col = scoreColour(score);
  const scoreStr = String(score).padStart(3, " ");
  return `  ${pad(label)}${col}${bar(score)}${C.reset}  ${col}${scoreStr}${C.reset}`;
}

// ─── Main formatter ────────────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<string, string> = {
  storytelling: "Storytelling",
  visualStorytelling: "Visual Storytelling",
  shotVariety: "Shot Variety",
  motion: "Motion",
  rhythm: "Rhythm",
  visualDiversity: "Visual Diversity",
  historicalAccuracy: "Historical Accuracy",
  emotionalImpact: "Emotional Impact",
};

export function printRenderQualityReport(review: EditorialReview): void {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗${C.reset}`);
  lines.push(`${C.bold}${C.cyan}║       DOCUMENTARY QUALITY REPORT                     ║${C.reset}`);
  lines.push(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════╝${C.reset}`);

  const titleLine = review.videoTitle ? `  ${C.bold}${review.videoTitle}${C.reset}` : "";
  if (titleLine) lines.push(titleLine);

  const overallCol = scoreColour(review.overallScore);
  lines.push(`  ${C.bold}Overall Score:${C.reset}  ${overallCol}${C.bold}${review.overallScore}${C.reset}  ${overallCol}${bar(review.overallScore)}${C.reset}`);
  lines.push("");

  // Dimension scores
  lines.push(`  ${C.bold}${C.white}Dimension Scores${C.reset}`);
  lines.push(`  ${"─".repeat(52)}`);
  for (const [dim, ds] of Object.entries(review.scores)) {
    const label = DIMENSION_LABELS[dim] ?? dim;
    lines.push(scoreLine(label, ds.score));
  }

  // Sourcing breakdown
  lines.push("");
  lines.push(`  ${C.bold}${C.white}Sourcing${C.reset}`);
  lines.push(`  ${"─".repeat(52)}`);
  const { sourcing } = review;
  lines.push(`  Archive: ${(sourcing.archiveFraction * 100).toFixed(0)}%   External: ${(sourcing.externalFraction * 100).toFixed(0)}%   Fallback: ${(sourcing.fallbackFraction * 100).toFixed(0)}%`);
  if (sourcing.repeatedClips > 0) {
    lines.push(`  ${C.dim}Repeated clips: ${sourcing.repeatedClips}   Repeated sources: ${sourcing.repeatedSources}${C.reset}`);
  }
  if (sourcing.fallbackFraction > 0.1) {
    const pct = (sourcing.fallbackFraction * 100).toFixed(0);
    lines.push(`  ${C.yellow}⚠ Fallback rate: ${pct}%${C.reset}`);
  }

  // Dimension feedback (problems + suggestions for lowest scores)
  const dimsSorted = Object.entries(review.scores).sort((a, b) => a[1].score - b[1].score);
  const weakDims = dimsSorted.filter(([, ds]) => ds.score < 75).slice(0, 3);
  if (weakDims.length > 0) {
    lines.push("");
    lines.push(`  ${C.bold}${C.yellow}Weakest Areas${C.reset}`);
    lines.push(`  ${"─".repeat(52)}`);
    for (const [dim, ds] of weakDims) {
      const label = DIMENSION_LABELS[dim] ?? dim;
      lines.push(`  ${C.yellow}▸ ${label} (${ds.score})${C.reset}`);
      if (ds.issue) lines.push(`    ${C.dim}Problem: ${ds.issue}${C.reset}`);
      if (ds.suggestion) lines.push(`    ${C.cyan}→ ${ds.suggestion}${C.reset}`);
    }
  }

  // Auto improvements
  if (review.autoImprovements.length > 0) {
    lines.push("");
    lines.push(`  ${C.bold}${C.magenta}Auto Improvements${C.reset}`);
    lines.push(`  ${"─".repeat(52)}`);
    for (const imp of review.autoImprovements.slice(0, 3)) {
      const rankIcon = imp.rank === 1 ? "🥇" : imp.rank === 2 ? "🥈" : "🥉";
      lines.push(`  ${rankIcon} ${C.bold}${imp.dimension}${C.reset}  ${C.dim}(+${imp.expectedGain})${C.reset}`);
      lines.push(`     ${imp.problem}`);
      lines.push(`     ${C.cyan}→ ${imp.action}${C.reset}`);
      lines.push(`     ${C.dim}Component: ${imp.pipelineComponent}${C.reset}`);
    }
  }

  // Top issues
  if (review.topIssues.length > 0) {
    lines.push("");
    lines.push(`  ${C.bold}${C.red}Top Issues${C.reset}`);
    lines.push(`  ${"─".repeat(52)}`);
    for (const issue of review.topIssues.slice(0, 5)) {
      lines.push(`  • ${issue}`);
    }
  }

  lines.push("");
  lines.push(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════╝${C.reset}`);
  lines.push("");

  // Print all at once
  console.log(lines.join("\n"));
}
