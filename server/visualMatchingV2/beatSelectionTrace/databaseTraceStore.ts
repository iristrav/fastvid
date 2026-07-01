/** Visual Matching Engine V2 — Database-backed BeatSelectionTrace store.
 *
 *  Writes one row per beat to `beat_selection_traces` via drizzle + mysql2.
 *  Failure is fully isolated: if the DB write fails, save() logs a warning and returns
 *  without throwing so the Selector result and video production are unaffected. */
import { beatSelectionTraces } from "../../../drizzle/schema";
import { getDb } from "../../../server/db";
import { logBeatSelectionTrace } from "../logging";
import type { BeatSelectionTraceStore, TraceSerializer, VersionedSelectorTrace } from "./types";
import { JsonTraceSerializer, TRACE_VERSION, SELECTOR_VERSION, VISION_VERSION, RANKING_VERSION, PROMPT_VERSION } from "./types";
import type { SelectorTrace } from "../types";

export class DatabaseTraceStore implements BeatSelectionTraceStore {
  private readonly serializer: TraceSerializer;

  constructor(serializer: TraceSerializer = new JsonTraceSerializer()) {
    this.serializer = serializer;
  }

  async save(trace: SelectorTrace): Promise<void> {
    const versioned: VersionedSelectorTrace = {
      ...trace,
      traceVersion: TRACE_VERSION,
      selectorVersion: SELECTOR_VERSION,
      visionVersion: VISION_VERSION,
      rankingVersion: RANKING_VERSION,
      promptVersion: PROMPT_VERSION,
    };

    try {
      const serialized = this.serializer.serialize(versioned);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.insert(beatSelectionTraces).values({
        beatId: trace.beatId,
        selectedCandidateId: trace.selectedCandidateId,
        needsResearch: trace.needsResearch ? 1 : 0,
        researchReason: trace.researchReason,
        confidenceTier: trace.confidenceTier,
        confidence: trace.confidence !== null ? String(trace.confidence) : null,
        overallScore: trace.winnerSnapshot?.overallScore ?? null,
        candidateCount: trace.candidateCount,
        durationMs: trace.durationMs,
        tieBreakApplied: trace.tieBreakApplied ? 1 : 0,
        traceVersion: TRACE_VERSION,
        selectorVersion: SELECTOR_VERSION,
        visionVersion: VISION_VERSION,
        rankingVersion: RANKING_VERSION,
        promptVersion: PROMPT_VERSION,
        contentType: this.serializer.contentType,
        payload: serialized,
        startedAt: new Date(trace.startedAt),
      });

      logBeatSelectionTrace("saved", {
        beatId: trace.beatId,
        selectedCandidateId: trace.selectedCandidateId,
        needsResearch: trace.needsResearch,
        durationMs: trace.durationMs,
      });
    } catch (err) {
      logBeatSelectionTrace("error", {
        beatId: trace.beatId,
        error: (err as Error).message,
      });
      // Do NOT rethrow — trace failure must never block video production.
    }
  }
}
