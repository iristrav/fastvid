import { CheckCircle2, Loader2 } from "lucide-react";
import {
  PIPELINE_DISPLAY_STAGES,
  pipelineStageIndex,
  resolvePipelineDisplayStage,
} from "@shared/pipelineProgress";

type ProgressLogEntry = {
  step: string;
  startedAt: number;
  completedAt?: number;
  status: string;
};

type Props = {
  progressStep?: string | null;
  progressPercent?: number;
  progressLog?: ProgressLogEntry[];
  compact?: boolean;
  isComplete?: boolean;
};

export function PipelineProgressSteps({
  progressStep,
  progressPercent = 0,
  progressLog = [],
  compact = false,
  isComplete = false,
}: Props) {
  const current = resolvePipelineDisplayStage(progressStep ?? "", progressPercent);
  const activeIdx = isComplete ? PIPELINE_DISPLAY_STAGES.length : pipelineStageIndex(current.key);

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      {PIPELINE_DISPLAY_STAGES.map((stage, i) => {
        const logEntry = progressLog.find((e) => e.step === stage.label);
        const isDone = isComplete || i < activeIdx || logEntry?.status === "done";
        const isActive = !isComplete && stage.key === current.key;
        return (
          <div
            key={stage.key}
            className={`flex items-center gap-2 ${compact ? "text-[10px]" : "text-xs"} transition-colors ${
              isDone ? "text-green-400/90" : isActive ? "text-purple-300" : "text-slate-600"
            }`}
          >
            <div
              className={`${compact ? "w-4 h-4" : "w-5 h-5"} rounded-full flex items-center justify-center border shrink-0 ${
                isDone
                  ? "bg-green-500/20 border-green-500/40"
                  : isActive
                    ? "bg-purple-500/20 border-purple-500/40"
                    : "bg-white/3 border-white/10"
              }`}
            >
              {isDone ? (
                <CheckCircle2 className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
              ) : isActive ? (
                <Loader2 className={`${compact ? "w-2.5 h-2.5" : "w-3 h-3"} animate-spin`} />
              ) : (
                <span className="text-[9px]">{i + 1}</span>
              )}
            </div>
            <span className={isActive ? "font-medium truncate" : "truncate"}>{stage.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function pipelineProgressHeadline(
  progressStep?: string | null,
  progressPercent = 0
): string {
  return resolvePipelineDisplayStage(progressStep ?? "", progressPercent).label;
}
