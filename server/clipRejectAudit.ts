/**
 * Per-video audit trail — why candidate clips were rejected during adopt.
 */
import * as path from "path";

export type ClipRejectEntry = {
  sceneIndex: number;
  beatIndex: number;
  basename: string;
  reason: string;
  source?: string;
};

const MAX_ENTRIES = 80;

export function createClipRejectAudit(): ClipRejectEntry[] {
  return [];
}

export function recordClipReject(
  audit: ClipRejectEntry[],
  sceneIndex: number,
  beatIndex: number,
  clipPath: string,
  reason: string,
  source?: string
): void {
  if (audit.length >= MAX_ENTRIES) return;
  audit.push({
    sceneIndex,
    beatIndex,
    basename: path.basename(clipPath),
    reason,
    source,
  });
}

export function summarizeClipRejectAudit(audit: ClipRejectEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of audit) {
    counts[e.reason] = (counts[e.reason] ?? 0) + 1;
  }
  return counts;
}
