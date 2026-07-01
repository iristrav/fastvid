/** Visual Matching Engine V2 — SelectionFeedback database store.
 *
 *  Writes and reads from selection_feedback + selection_feedback_events.
 *  Imports nothing from pipeline, retrieval, ranking, vision, or selector components.
 *  Traces are referenced by (pipelineRunId, beatId) but never modified. */
import { eq } from "drizzle-orm";
import { selectionFeedback, selectionFeedbackEvents } from "../../../drizzle/schema";
import { getDb } from "../../../server/db";
import { logSelectionFeedback } from "../logging";
import type { InsertSelectionFeedback, SelectionFeedback, SelectionFeedbackStore } from "./types";

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
    });

    const insertId = Number((result as unknown as { insertId: bigint | number }).insertId);

    const rows = await db
      .select()
      .from(selectionFeedback)
      .where(eq(selectionFeedback.id, insertId))
      .limit(1);

    const row = rows[0];
    const stored: SelectionFeedback = {
      id: row.id,
      pipelineRunId: row.pipelineRunId,
      beatId: row.beatId,
      candidateId: row.candidateId,
      feedbackType: row.feedbackType as SelectionFeedback["feedbackType"],
      comment: row.comment ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };

    // Append event log entry (best-effort — does not block or throw on failure).
    await db
      .insert(selectionFeedbackEvents)
      .values({
        feedbackId: stored.id,
        eventType: "created",
        snapshot: JSON.stringify(stored),
        changedBy: stored.createdBy,
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

    return rows.map((row) => ({
      id: row.id,
      pipelineRunId: row.pipelineRunId,
      beatId: row.beatId,
      candidateId: row.candidateId,
      feedbackType: row.feedbackType as SelectionFeedback["feedbackType"],
      comment: row.comment ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async listByBeat(beatId: string): Promise<SelectionFeedback[]> {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select()
      .from(selectionFeedback)
      .where(eq(selectionFeedback.beatId, beatId));

    return rows.map((row) => ({
      id: row.id,
      pipelineRunId: row.pipelineRunId,
      beatId: row.beatId,
      candidateId: row.candidateId,
      feedbackType: row.feedbackType as SelectionFeedback["feedbackType"],
      comment: row.comment ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

/** In-memory implementation for tests. */
export class MemorySelectionFeedbackStore implements SelectionFeedbackStore {
  private rows: SelectionFeedback[] = [];
  private nextId = 1;

  async submit(input: InsertSelectionFeedback): Promise<SelectionFeedback> {
    const stored: SelectionFeedback = {
      ...input,
      id: this.nextId++,
      comment: input.comment ?? null,
      createdAt: new Date().toISOString(),
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
