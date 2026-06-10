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
  | "split_filter"
  | "split_extract"
  | "filter_overlay"
  | "filter_subject"
  | "ai_tags"
  | "save_clips"
  | "done"
  | "cancelled"
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
  resultClipCount?: number;
  resultSplit?: boolean;
  updatedAt: number;
  done: boolean;
  error?: string;
  cancelled?: boolean;
};

const jobs = new Map<string, ArchiveUploadProgress>();
const cancelRequested = new Set<string>();
const TTL_MS = 2.5 * 60 * 60 * 1000;

function pruneOldJobs() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}

export function initArchiveUploadJob(jobId: string, filename?: string): void {
  pruneOldJobs();
  cancelRequested.delete(jobId);
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
  cancelRequested.delete(jobId);
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

export function isArchiveUploadCancelRequested(jobId: string | undefined): boolean {
  return jobId != null && cancelRequested.has(jobId);
}

/** Request cooperative cancel — processing stops at next checkpoint. */
export function requestArchiveUploadCancel(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.done) return false;
  cancelRequested.add(jobId);
  patchArchiveUploadJob(jobId, {
    message: "Annuleren…",
  });
  return true;
}

export function finishArchiveUploadJobCancelled(jobId: string | undefined): void {
  if (!jobId) return;
  cancelRequested.delete(jobId);
  patchArchiveUploadJob(jobId, {
    stage: "cancelled",
    message: "Upload geannuleerd",
    done: true,
    cancelled: true,
    error: undefined,
  });
}

export const ARCHIVE_UPLOAD_STAGE_LABELS: Record<ArchiveUploadProgressStage, string> = {
  queued: "Wachtrij",
  validating: "Bestand controleren",
  split_ffmpeg: "FFmpeg controleren",
  split_probe: "Duur meten",
  split_detect: "Shots detecteren",
  split_rescan: "Extra cuts scannen",
  split_filter: "Onderwerp filteren",
  split_extract: "Clips knippen",
  filter_overlay: "Editor-tekst filteren",
  filter_subject: "Archief-onderwerp filteren",
  ai_tags: "AI-tags genereren",
  save_clips: "Clips opslaan",
  done: "Klaar",
  cancelled: "Geannuleerd",
  error: "Fout",
};
