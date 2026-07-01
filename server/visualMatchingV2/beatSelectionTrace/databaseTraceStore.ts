/** Visual Matching Engine V2 — Database-backed BeatSelectionTrace store.
 *
 *  Fully passive: serialize → compute hash → insert → return.
 *  No error catching, no business logic, no mutations of the input trace.
 *  Wrap with AsyncTraceWriter (failure isolation + non-blocking) before use. */
import { createHash, randomUUID } from "crypto";
import * as os from "os";
import { beatSelectionTraces } from "../../../drizzle/schema";
import { getDb } from "../../../server/db";
import type { BeatSelectionTraceStore, TraceContext, TraceSerializer, VersionedSelectorTrace } from "./types";
import { JsonTraceSerializer, TRACE_VERSION, SELECTOR_VERSION, VISION_VERSION, RANKING_VERSION, PROMPT_VERSION, SCHEMA_VERSION, ENGINE_VERSION, PIPELINE_VERSION } from "./types";
import type { SelectorTrace } from "../types";

export class DatabaseTraceStore implements BeatSelectionTraceStore {
  private readonly serializer: TraceSerializer;

  constructor(serializer: TraceSerializer = new JsonTraceSerializer()) {
    this.serializer = serializer;
  }

  async save(trace: SelectorTrace, context?: TraceContext): Promise<void> {
    const createdAt = new Date().toISOString();

    const versioned: VersionedSelectorTrace = {
      ...trace,
      traceVersion: TRACE_VERSION,
      selectorVersion: SELECTOR_VERSION,
      visionVersion: VISION_VERSION,
      rankingVersion: RANKING_VERSION,
      promptVersion: PROMPT_VERSION,
      traceId: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      createdAt,
      host: os.hostname(),
      workerId: process.env.WORKER_ID ?? String(process.pid),
    };

    const serialized = this.serializer.serialize(versioned);
    const traceHash = createHash("sha256").update(serialized).digest("hex");

    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await db.insert(beatSelectionTraces).values({
      traceId: versioned.traceId,
      beatId: trace.beatId,
      videoId: context?.videoId ?? null,
      selectedCandidateId: trace.selectedCandidateId,
      needsResearch: trace.needsResearch ? 1 : 0,
      researchReason: trace.researchReason,
      confidenceTier: trace.confidenceTier,
      confidence: trace.confidence !== null ? String(trace.confidence) : null,
      overallScore: trace.winnerSnapshot?.overallScore ?? null,
      winnerSource: trace.winnerSnapshot?.source ?? null,
      candidateCount: trace.candidateCount,
      durationMs: trace.durationMs,
      tieBreakApplied: trace.tieBreakApplied ? 1 : 0,
      traceVersion: TRACE_VERSION,
      selectorVersion: SELECTOR_VERSION,
      visionVersion: VISION_VERSION,
      rankingVersion: RANKING_VERSION,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      host: versioned.host,
      workerId: versioned.workerId,
      traceHash,
      contentType: this.serializer.contentType,
      payload: serialized,
      startedAt: new Date(trace.startedAt),
    });
  }
}
