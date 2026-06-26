import { useEffect, useState } from "react";
import { maxGenerationEstimateSec } from "@shared/pipelineProgress";

type Props = {
  progressPercent: number;
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

export function GenerationProgressBar({
  progressPercent,
  generationStartedAt,
  videoLength,
  compact = false,
  className = "",
}: Props) {
  const elapsedSec = useGenerationElapsedSec(generationStartedAt, true);
  const maxSec = maxGenerationEstimateSec(videoLength);
  const nearingLimit = elapsedSec > maxSec * 0.85;
  const pct = Math.max(0, Math.min(100, Math.round(progressPercent)));
  const statusLabel = pct >= 100 ? "Done" : pct <= 0 ? "Starting…" : `${pct}% done`;

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
