import { useEffect, useState } from "react";
import type { CanonicalProgressStage } from "@shared/pipelineProgress";

export type VideoProgressEvent = {
  status: string;
  progressStep: string | null;
  progressPercent: number;
  stage: CanonicalProgressStage;
};

/**
 * Real-time video generation progress via SSE (GET /api/events/video/:id, Phase 1).
 * Additive to the existing trpc.video.pollStatus 5s polling, not a replacement — callers
 * merge this into whatever local state the poll already drives, so nothing regresses if
 * SSE is ever blocked by a proxy or browser extension (the poll still covers that case).
 */
export function useVideoProgressStream(videoId: number | null, enabled: boolean): VideoProgressEvent | null {
  const [event, setEvent] = useState<VideoProgressEvent | null>(null);

  useEffect(() => {
    if (!enabled || videoId == null) return;
    setEvent(null);
    const source = new EventSource(`/api/events/video/${videoId}`);
    source.onmessage = (e) => {
      try {
        setEvent(JSON.parse(e.data) as VideoProgressEvent);
      } catch {
        /* ignore malformed payloads */
      }
    };
    source.onerror = () => {
      // Let EventSource's built-in reconnect handle transient drops — pollStatus's
      // refetchInterval fallback covers the gap regardless.
    };
    return () => source.close();
  }, [videoId, enabled]);

  return event;
}
