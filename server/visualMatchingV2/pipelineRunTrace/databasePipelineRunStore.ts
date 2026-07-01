/** Visual Matching Engine V2 — Database-backed PipelineRunTrace store.
 *
 *  Fully passive: serialize stageTimings → insert → return.
 *  Wrap with a try/catch at the call site or use an async writer for failure isolation. */
import { pipelineRunTraces } from "../../../drizzle/schema";
import { getDb } from "../../../server/db";
import { logPipelineRunTrace } from "../logging";
import type { PipelineRunTrace, PipelineRunTraceStore } from "./types";

export class DatabasePipelineRunStore implements PipelineRunTraceStore {
  async save(trace: PipelineRunTrace): Promise<void> {
    try {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.insert(pipelineRunTraces).values({
        pipelineRunId: trace.pipelineRunId,
        videoId: trace.videoId,
        pipelineVersion: trace.pipelineVersion,
        beatsProcessed: trace.beatsProcessed,
        beatsSelected: trace.beatsSelected,
        beatsResearchRequired: trace.beatsResearchRequired,
        totalDurationMs: trace.totalDurationMs,
        videoContextMs: trace.stageTimings.videoContextMs,
        visualIntentMs: trace.stageTimings.visualIntentMs,
        retrievalTotalMs: trace.stageTimings.retrievalTotalMs,
        clipTotalMs: trace.stageTimings.clipTotalMs,
        rankingTotalMs: trace.stageTimings.rankingTotalMs,
        visionTotalMs: trace.stageTimings.visionTotalMs,
        selectionTotalMs: trace.stageTimings.selectionTotalMs,
        startedAt: new Date(trace.startedAt),
        completedAt: new Date(trace.completedAt),
      });

      logPipelineRunTrace("saved", {
        pipelineRunId: trace.pipelineRunId,
        videoId: trace.videoId,
        beatsProcessed: trace.beatsProcessed,
        totalDurationMs: trace.totalDurationMs,
      });
    } catch (err) {
      logPipelineRunTrace("error", {
        pipelineRunId: trace.pipelineRunId,
        videoId: trace.videoId,
        error: (err as Error).message,
      });
      // Do NOT rethrow — trace failure must never block the pipeline result.
    }
  }
}
