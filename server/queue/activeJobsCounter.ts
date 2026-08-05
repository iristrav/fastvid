/**
 * Active-jobs-in-this-process counter, shared by both queue backends
 * (server/videoQueue.ts's DB-polling implementation and server/queue/bullmqQueue.ts).
 * Several background tasks (archiveClipIndexBackfill.ts, clipBackgroundAuditor.ts) defer
 * CPU/memory-heavy CLIP work while a real video render is active in this process — they
 * read this via videoQueue.ts's workerLocalActiveJobs(), which now proxies here so the
 * heuristic stays correct regardless of which queue backend is driving job execution.
 */
let count = 0;

export function incrementActiveJobs(): void {
  count += 1;
}

export function decrementActiveJobs(): void {
  count = Math.max(0, count - 1);
}

export function activeJobsCount(): number {
  return count;
}
