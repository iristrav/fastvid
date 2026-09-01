import { useCallback, useEffect, useRef, useState } from "react";
import { maxGenerationEstimateSec } from "@shared/pipelineProgress";

type Props = {
  progressPercent: number;
  /**
   * RONDE 107: which video this bar is for, so its high-water mark survives a remount and the
   * number never steps backwards when a card re-renders. Optional — without it the bar keeps its
   * old per-instance behaviour.
   */
  progressKey?: string;
  generationStartedAt?: Date | string | null;
  videoLength?: string | null;
  /** Smaller layout for video cards and table cells */
  compact?: boolean;
  className?: string;
};

export function useGenerationElapsedSec(
  generationStartedAt: Date | string | null | undefined,
  active: boolean
): number {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!active || !generationStartedAt) {
      setElapsedSec(0);
      return;
    }
    const startMs = new Date(generationStartedAt).getTime();
    const tick = () => setElapsedSec(Math.floor((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, generationStartedAt]);

  return elapsedSec;
}

/**
 * RONDE 107 — the highest percent this browser has shown for a video, per video.
 *
 * The ratchet inside the hook lived in component state, so it lasted exactly as long as the
 * component did. Scrolling the list, switching tabs or a refetch that remounts the card started
 * it again from whatever the backend said at that moment — and the creep below means the display
 * is usually a few points AHEAD of the backend, so a remount reliably showed a lower number than
 * the one just on screen. Keeping the mark outside React is what makes it survive that.
 *
 * A plain module-level Map: it lives for the tab's lifetime, which is the span over which a
 * person can notice the number going backwards. A reload starts fresh, and by then the server's
 * own value is monotonic anyway (see updateVideoProgress).
 */
const progressHighWater = new Map<string, number>();
/** A tab that has watched a lot of renders should not accumulate marks forever. */
const MAX_TRACKED_RUNS = 200;

/**
 * The key a caller should use: one video, one RUN.
 *
 * A retry legitimately starts over, and a high-water mark that outlived the run it belonged to
 * would pin the new attempt to the old attempt's number — which is the same lie in the other
 * direction. Folding the run's start time into the key means a new run gets a fresh mark without
 * anyone having to remember to clear it, and the server agrees: a write that sets
 * `generationStartedAt` is the one write allowed to lower the stored percent.
 */
export function progressRunKey(videoId: number | string, runStartedAt?: Date | string | null): string {
  const run = runStartedAt ? new Date(runStartedAt).getTime() : 0;
  return `video:${videoId}:${Number.isFinite(run) ? run : 0}`;
}

/**
 * Smoothly creeps the displayed percent toward (real + a small buffer) between real backend
 * updates, so the bar never sits visibly frozen during long stages. Never fakes completion —
 * capped below the last known real value + 4, and snaps up immediately once a higher real
 * value arrives.
 *
 * RONDE 107: and it never goes down. `key` identifies the video so the high-water mark survives
 * a remount; without one the hook keeps its old per-instance behaviour.
 */
export function useSmoothedProgressPercent(
  realPercent: number,
  active: boolean,
  key?: string
): number {
  const start = key ? Math.max(progressHighWater.get(key) ?? 0, realPercent) : realPercent;
  const [display, setDisplay] = useState(start);
  const realRef = useRef(realPercent);
  realRef.current = realPercent;

  /** One place raises the mark, so the stored value and the shown value cannot disagree. */
  const raise = useCallback(
    (next: number) => {
      if (!key) return next;
      if (!progressHighWater.has(key) && progressHighWater.size >= MAX_TRACKED_RUNS) {
        // Oldest first — insertion order is exactly the order runs were seen.
        const oldest = progressHighWater.keys().next().value;
        if (oldest !== undefined) progressHighWater.delete(oldest);
      }
      progressHighWater.set(key, Math.max(progressHighWater.get(key) ?? 0, next));
      return next;
    },
    [key]
  );

  useEffect(() => {
    setDisplay((d) => raise(Math.max(d, realPercent)));
  }, [realPercent, raise]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setDisplay((d) => {
        const ceiling = Math.min(99, realRef.current + 4);
        return d < ceiling ? raise(Math.min(ceiling, d + 0.3)) : d;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [active, raise]);

  return Math.min(100, Math.round(display));
}

export function GenerationProgressBar({
  progressPercent,
  progressKey,
  generationStartedAt,
  videoLength,
  compact = false,
  className = "",
}: Props) {
  const elapsedSec = useGenerationElapsedSec(generationStartedAt, true);
  const maxSec = maxGenerationEstimateSec(videoLength);
  const nearingLimit = elapsedSec > maxSec * 0.85;
  const rawPct = Math.max(0, Math.min(100, Math.round(progressPercent)));
  const pct = useSmoothedProgressPercent(rawPct, rawPct < 100, progressKey);
  const statusLabel = `${pct}%`;

  return (
    <div className={`w-full ${className}`}>
      {!compact && (
        <p className="text-xs text-slate-400 mb-2">Generating your video…</p>
      )}
      <div
        className={`w-full bg-white/10 overflow-hidden ${compact ? "h-1 rounded-full" : "h-1.5 rounded-full"}`}
      >
        <div
          className="h-full bg-gradient-to-r from-purple-500 to-cyan-500 transition-all duration-700"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <div
        className={`flex items-center justify-between gap-2 ${compact ? "mt-1.5 text-[10px]" : "mt-2 text-xs"}`}
      >
        <span className={`truncate ${nearingLimit ? "text-amber-400" : "text-slate-400"}`}>
          {statusLabel}
        </span>
      </div>
      {nearingLimit && !compact && (
        <p className="text-[10px] text-amber-500 mt-1">Approaching time limit</p>
      )}
    </div>
  );
}
