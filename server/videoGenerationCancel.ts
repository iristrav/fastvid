/** Cooperative cancel for in-flight video generation jobs. */
import { AsyncLocalStorage } from "async_hooks";

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

// ─── Active-video-id context ───────────────────────────────────────────────────
// Lets any module (videoPipeline.ts, localClipVision.ts, llm.ts, ...) that needs to know
// "which video/user is this render for?" without threading videoId/userId through every
// function signature, and without a circular import back to videoPipeline.ts (which already
// imports from localClipVision.ts and llm.ts). Set once at the very top of a render; read
// from deep inside any nested async call within that render's call tree — in particular,
// llm.ts's invokeLLM reads the userId here to attribute per-user LLM spend without every one
// of its 24 call sites needing to pass a userId explicitly.
const activeRenderIdentityStorage = new AsyncLocalStorage<{ videoId: number; userId: number | null }>();

export function runWithActiveVideoId<T>(videoId: number, fn: () => T, userId: number | null = null): T {
  return activeRenderIdentityStorage.run({ videoId, userId }, fn);
}

export function getActiveVideoId(): number | undefined {
  return activeRenderIdentityStorage.getStore()?.videoId;
}

export function getActiveUserId(): number | null | undefined {
  return activeRenderIdentityStorage.getStore()?.userId;
}

/** Convenience: throws if the CURRENT active render (from context) has been cancelled.
 *  A no-op if called outside any tracked render (activeVideoId undefined). */
export function throwIfActiveRenderCancelled(): void {
  const videoId = getActiveVideoId();
  if (videoId != null) throwIfVideoGenerationCancelled(videoId);
}
