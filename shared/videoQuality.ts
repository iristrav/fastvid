/** Client-safe mirror of server VideoQualityReport (subset). */
export type VideoQualityReportClient = {
  score: number;
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
