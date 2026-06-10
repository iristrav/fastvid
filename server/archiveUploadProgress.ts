/**
 * In-memory progress for archive uploads (split, tag, save).
 * Polled by the admin UI while POST /api/admin/archive/upload runs.
 */

export type ArchiveUploadProgressStage =
  | "queued"
  | "validating"
  | "split_ffmpeg"
  | "split_probe"
  | "split_detect"
  | "split_rescan"
  | "split_extract"
  | "filter_overlay"
  | "ai_tags"
  | "save_clips"
  | "done"
  | "error";

export type ArchiveUploadProgress = {
  jobId: string;
  filename?: string;
  stage: ArchiveUploadProgressStage;
  message: string;
  percent: number;
  clipIndex?: number;
  clipTotal?: number;
  clipsSaved?: number;
  updatedAt: number;
  done: boolean;
  error?: string;
};

const jobs = new Map<string, ArchiveUploadProgress>();
const TTL_MS = 15 * 60 * 1000;

function pruneOldJobs() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}

export function initArchiveUploadJob(jobId: string, filename?: string): void {
  pruneOldJobs();
  jobs.set(jobId, {
    jobId,
    filename,
    stage: "queued",
    message: "Upload ontvangen — voorbereiden…",
    percent: 0,
    updatedAt: Date.now(),
    done: false,
  });
}

export function patchArchiveUploadJob(
  jobId: string | undefined,
  patch: Partial<Omit<ArchiveUploadProgress, "jobId">> & { stage?: ArchiveUploadProgressStage }
): void {
  if (!jobId) return;
  const prev = jobs.get(jobId);
  if (!prev) {
    jobs.set(jobId, {
      jobId,
      stage: patch.stage ?? "queued",
      message: patch.message ?? "",
      percent: patch.percent ?? 0,
      updatedAt: Date.now(),
      done: patch.done ?? false,
      ...patch,
    });
    return;
  }
  jobs.set(jobId, {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  });
  const next = jobs.get(jobId)!;
  console.log(
    `[ArchiveUpload][${jobId}] ${next.stage} ${next.percent}% — ${next.message}` +
      (next.clipTotal ? ` [clip ${next.clipIndex ?? next.clipsSaved ?? 0}/${next.clipTotal}]` : "")
  );
}

export function finishArchiveUploadJob(
  jobId: string | undefined,
  ok: boolean,
  message: string,
  extra?: Partial<ArchiveUploadProgress>
): void {
  if (!jobId) return;
  patchArchiveUploadJob(jobId, {
    stage: ok ? "done" : "error",
    message,
    percent: ok ? 100 : prevPercent(jobId),
    done: true,
    error: ok ? undefined : message,
    ...extra,
  });
}

function prevPercent(jobId: string): number {
  return jobs.get(jobId)?.percent ?? 0;
}

export function getArchiveUploadJob(jobId: string): ArchiveUploadProgress | null {
  return jobs.get(jobId) ?? null;
}

export const ARCHIVE_UPLOAD_STAGE_LABELS: Record<ArchiveUploadProgressStage, string> = {
  queued: "Wachtrij",
  validating: "Bestand controleren",
  split_ffmpeg: "FFmpeg controleren",
  split_probe: "Duur meten",
  split_detect: "Shots detecteren",
  split_rescan: "Extra cuts scannen",
  split_extract: "Clips knippen",
  filter_overlay: "Editor-tekst filteren",
  ai_tags: "AI-tags genereren",
  save_clips: "Clips opslaan",
  done: "Klaar",
  error: "Fout",
};
