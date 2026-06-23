/** Cooperative cancel for in-flight video generation jobs. */

const cancelRequested = new Set<number>();

export function requestVideoGenerationCancel(videoId: number): void {
  cancelRequested.add(videoId);
}

export function isVideoGenerationCancelRequested(videoId: number): boolean {
  return cancelRequested.has(videoId);
}

export function clearVideoGenerationCancel(videoId: number): void {
  cancelRequested.delete(videoId);
}

export function throwIfVideoGenerationCancelled(videoId: number): void {
  if (isVideoGenerationCancelRequested(videoId)) {
    throw new Error("Video generation cancelled");
  }
}
