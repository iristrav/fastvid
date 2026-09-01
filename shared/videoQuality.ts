/** Client-safe mirror of server VideoQualityReport (subset). */
export type VideoQualityReportClient = {
  score: number;
  /**
   * RONDE 105 — what the score is allowed to claim.
   *
   * A number on its own cannot say "nobody checked this", and a render whose vision model
   * answered nothing once shipped as `100/100 (Excellent)` because of that. The status can say
   * it, so the card shows it.
   */
  qualityStatus?: "VERIFIED" | "PARTIALLY_VERIFIED" | "INSUFFICIENT_VERIFICATION";
  qualityReason?: string;
  visualTopic?: string;
  totalClips?: number;
  wikimediaCount?: number;
  archiveCount?: number;
  stockCount?: number;
  warnings?: string[];
  bySource?: Record<string, number>;
  rejectSummary?: Record<string, number>;
  pipelineSec?: number;
};

export function readQualityReportFromMetadata(metadata: unknown): VideoQualityReportClient | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const qr = (metadata as { qualityReport?: unknown }).qualityReport;
  if (!qr || typeof qr !== "object" || Array.isArray(qr)) return null;
  const r = qr as VideoQualityReportClient;
  if (typeof r.score !== "number") return null;
  return r;
}

export function qualityScoreColor(score: number): string {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-amber-400";
  return "text-red-400";
}

export function qualityScoreLabel(score: number): string {
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 55) return "Fair";
  return "Needs work";
}

/**
 * RONDE 105 — the label a reader sees, which is the status when there is one worth showing.
 *
 * A VERIFIED render reads as before. Anything else says why the number is what it is, because
 * "Needs work" and "nobody looked at any of this" are different messages and the second one is
 * the one that got a broken render shipped.
 */
export function qualityStatusLabel(report: VideoQualityReportClient): string {
  switch (report.qualityStatus) {
    case "INSUFFICIENT_VERIFICATION":
      return "Onvoldoende geverifieerd";
    case "PARTIALLY_VERIFIED":
      return "Deels geverifieerd";
    default:
      return qualityScoreLabel(report.score);
  }
}
