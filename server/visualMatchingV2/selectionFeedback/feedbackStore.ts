/** Visual Matching Engine V2 — SelectionFeedback database store.
 *
 *  Writes and reads from selection_feedback + selection_feedback_events.
 *  Imports nothing from pipeline, retrieval, ranking, vision, or selector components.
 *  Traces are referenced by (pipelineRunId, beatId) but never modified. */
import { eq } from "drizzle-orm";
import { selectionFeedback, selectionFeedbackEvents } from "../../../drizzle/schema";
import { getDb } from "../../../server/db";
import { logSelectionFeedback } from "../logging";
import { PIPELINE_VERSION, ENGINE_VERSION, RANKING_VERSION } from "../beatSelectionTrace";
import type { InsertSelectionFeedback, SelectionFeedback, SelectionFeedbackStore } from "./types";

function rowToFeedback(row: typeof selectionFeedback.$inferSelect): SelectionFeedback {
  return {
    id: row.id,
    pipelineRunId: row.pipelineRunId,
    beatId: row.beatId,
    candidateId: row.candidateId,
    feedbackType: row.feedbackType as SelectionFeedback["feedbackType"],
    comment: row.comment ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    pipelineVersion: row.pipelineVersion ?? null,
    engineVersion: row.engineVersion ?? null,
    visionModel: row.visionModel ?? null,
    embeddingModel: row.embeddingModel ?? null,
    rankingConfigVersion: row.rankingConfigVersion ?? null,
  };
}

export class DatabaseSelectionFeedbackStore implements SelectionFeedbackStore {
  async submit(input: InsertSelectionFeedback): Promise<SelectionFeedback> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(selectionFeedback).values({
      pipelineRunId: input.pipelineRunId,
      beatId: input.beatId,
      candidateId: input.candidateId,
      feedbackType: input.feedbackType,
      comment: input.comment ?? null,
      createdBy: input.createdBy,
      pipelineVersion: input.pipelineVersion ?? PIPELINE_VERSION,
      engineVersion: input.engineVersion ?? ENGINE_VERSION,
      visionModel: input.visionModel ?? null,
      embeddingModel: input.embeddingModel ?? null,
      rankingConfigVersion: input.rankingConfigVersion ?? RANKING_VERSION,
    });

    const insertId = Number((result as unknown as { insertId: bigint | number }).insertId);

    const rows = await db
      .select()
      .from(selectionFeedback)
      .where(eq(selectionFeedback.id, insertId))
      .limit(1);

    const stored = rowToFeedback(rows[0]);

    // Append event log entry — best-effort, never throws to caller.
    await db
      .insert(selectionFeedbackEvents)
      .values({
        feedbackId: stored.id,
        eventType: "created",
        snapshot: JSON.stringify(stored),
        actor: stored.createdBy,
      })
      .catch((err: unknown) => {
        logSelectionFeedback("error", {
          action: "event_log",
          feedbackId: stored.id,
          error: (err as Error).message,
        });
      });

    logSelectionFeedback("submitted", {
      feedbackId: stored.id,
      pipelineRunId: stored.pipelineRunId,
      beatId: stored.beatId,
      feedbackType: stored.feedbackType,
      createdBy: stored.createdBy,
      pipelineVersion: stored.pipelineVersion,
    });

    return stored;
  }

  async listByRun(pipelineRunId: string): Promise<SelectionFeedback[]> {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(selectionFeedback)
      .where(eq(selectionFeedback.pipelineRunId, pipelineRunId));
    return rows.map(rowToFeedback);
  }

  async listByBeat(beatId: string): Promise<SelectionFeedback[]> {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(selectionFeedback)
      .where(eq(selectionFeedback.beatId, beatId));
    return rows.map(rowToFeedback);
  }
}

/** In-memory implementation for tests. */
export class MemorySelectionFeedbackStore implements SelectionFeedbackStore {
  private rows: SelectionFeedback[] = [];
  private nextId = 1;

  async submit(input: InsertSelectionFeedback): Promise<SelectionFeedback> {
    const now = new Date().toISOString();
    const stored: SelectionFeedback = {
      id: this.nextId++,
      pipelineRunId: input.pipelineRunId,
      beatId: input.beatId,
      candidateId: input.candidateId,
      feedbackType: input.feedbackType,
      comment: input.comment ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      pipelineVersion: input.pipelineVersion ?? PIPELINE_VERSION,
      engineVersion: input.engineVersion ?? ENGINE_VERSION,
      visionModel: input.visionModel ?? null,
      embeddingModel: input.embeddingModel ?? null,
      rankingConfigVersion: input.rankingConfigVersion ?? RANKING_VERSION,
    };
    this.rows.push(stored);
    return stored;
  }

  async listByRun(pipelineRunId: string): Promise<SelectionFeedback[]> {
    return this.rows.filter((r) => r.pipelineRunId === pipelineRunId);
  }

  async listByBeat(beatId: string): Promise<SelectionFeedback[]> {
    return this.rows.filter((r) => r.beatId === beatId);
  }

  getAll(): readonly SelectionFeedback[] { return [...this.rows]; }
  clear(): void { this.rows = []; this.nextId = 1; }
}
