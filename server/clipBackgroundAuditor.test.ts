import { describe, expect, it } from "vitest";
import {
  applyBackgroundClipAuditScore,
  clipAuditorEnabled,
  auditorBatchSize,
} from "./clipBackgroundAuditor";

describe("clipBackgroundAuditor", () => {
  it("clipAuditorEnabled follows local vision", () => {
    const prevLocal = process.env.ENABLE_LOCAL_VISION;
    const prevAuditor = process.env.ENABLE_CLIP_BACKGROUND_AUDITOR;
    process.env.ENABLE_LOCAL_VISION = "false";
    expect(clipAuditorEnabled()).toBe(false);
    process.env.ENABLE_LOCAL_VISION = "true";
    process.env.ENABLE_CLIP_BACKGROUND_AUDITOR = "false";
    expect(clipAuditorEnabled()).toBe(false);
    process.env.ENABLE_LOCAL_VISION = prevLocal;
    process.env.ENABLE_CLIP_BACKGROUND_AUDITOR = prevAuditor;
  });

  it("applyBackgroundClipAuditScore returns 0 when no audit file", () => {
    expect(applyBackgroundClipAuditScore(9_999_999)).toBe(0);
  });

  it("auditorBatchSize defaults to 15", () => {
    const prev = process.env.CLIP_AUDITOR_BATCH_SIZE;
    delete process.env.CLIP_AUDITOR_BATCH_SIZE;
    expect(auditorBatchSize()).toBe(15);
    process.env.CLIP_AUDITOR_BATCH_SIZE = prev;
  });
});
