/**
 * A render the export gate refused, and where its file is.
 *
 * The quality gate blocks a film from being PUBLISHED. Until now that also made it
 * invisible: the MP4 was uploaded before `enforceQualityExportGate` ran, the gate threw,
 * and the write that records `videoUrl` sits on the success path far below — so the row
 * ended up `failed` with no URL at all, and the only way to find out what the gate had
 * objected to was to read the worker log. The person who asked for the film could not
 * look at the thing being judged.
 *
 * This record is the missing half. It says: the file exists, here it is, and here is the
 * verdict that stopped it going out. It does not soften the verdict — the video stays
 * `failed`, it is never counted as completed, and nothing downstream treats the presence
 * of a URL as approval. Both sides read the shape from here rather than each guessing at
 * a JSON blob.
 */

export type BlockedExportRecord = {
  /** The gate's own sentence, exactly as it was thrown and stored on `errorMessage`. */
  reason: string;
  /** Where the refused MP4 landed — the same value written to `videos.videoUrl`. */
  videoUrl: string;
  /** ISO timestamp of the refusal. */
  at: string;
};

/** The key this record lives under inside `videos.metadata`. */
export const BLOCKED_EXPORT_METADATA_KEY = "exportBlocked";

/**
 * Read the record back out of a metadata blob, or null.
 *
 * Deliberately strict: a partial object is not a blocked export. A UI that showed a player
 * on the strength of a half-written record would be claiming a file it cannot point at.
 */
export function readBlockedExport(metadata: unknown): BlockedExportRecord | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BLOCKED_EXPORT_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { reason, videoUrl, at } = raw as Record<string, unknown>;
  if (typeof reason !== "string" || !reason.trim()) return null;
  if (typeof videoUrl !== "string" || !videoUrl.trim()) return null;
  if (typeof at !== "string" || !at.trim()) return null;
  return { reason, videoUrl, at };
}

/**
 * The record for a video AS THE VIEWER SHOULD SEE IT.
 *
 * The status is part of the question, not a detail the caller may forget. A retried render
 * leaves the old record in place while it runs, and a render that then succeeds leaves it
 * there beside a real `completed` — in both cases the film on screen is no longer the one
 * that was refused, so the banner must not appear. Only a row that is still `failed` is
 * showing the blocked render.
 */
export function blockedExportForVideo(video: {
  status?: string | null;
  metadata?: unknown;
} | null | undefined): BlockedExportRecord | null {
  if (!video || video.status !== "failed") return null;
  return readBlockedExport(video.metadata);
}
