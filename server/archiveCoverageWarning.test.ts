import { describe, expect, it, vi, beforeEach } from "vitest";

const updateVideoProgressMock = vi.fn();
const getVideoByIdMock = vi.fn();
const recordArchiveContentGapMock = vi.fn();

vi.mock("./db", () => ({
  updateVideoProgress: (...args: unknown[]) => updateVideoProgressMock(...args),
  getVideoById: (...args: unknown[]) => getVideoByIdMock(...args),
}));
vi.mock("./archiveContentGaps", () => ({
  recordArchiveContentGap: (...args: unknown[]) => recordArchiveContentGapMock(...args),
}));

import {
  computeArchiveCoverageWarning,
  applyCoverageWarningIfNeeded,
  INSUFFICIENT_FOOTAGE_USER_MESSAGE,
} from "./archiveCoverageWarning";

// F3-26: the warning must only fire on a genuine, final shortfall — never on a raw
// "archive_count < X" snapshot taken before web sourcing had a chance to fill the gap.
describe("computeArchiveCoverageWarning (pure decision logic)", () => {
  it("Test 12 — sufficient archive coverage alone: no warning", () => {
    const result = computeArchiveCoverageWarning({
      entity: "Justin Bieber",
      archiveCount: 12,
      recommendedCount: 12,
      webSearchAttempted: false,
      webFoundCount: 0,
    });
    expect(result.shouldWarnUser).toBe(false);
    expect(result.shouldWarnAdmin).toBe(false);
    expect(result.totalCount).toBe(12);
  });

  it("Test 12b — web sourcing closes the gap: no false warning even though archive alone was short", () => {
    const result = computeArchiveCoverageWarning({
      entity: "Justin Bieber",
      archiveCount: 3,
      recommendedCount: 12,
      webSearchAttempted: true,
      webFoundCount: 9,
    });
    expect(result.totalCount).toBe(12);
    expect(result.shouldWarnUser).toBe(false);
    expect(result.shouldWarnAdmin).toBe(false);
  });

  it("Test 11 — archive insufficient and web search still doesn't close the gap: warns", () => {
    const result = computeArchiveCoverageWarning({
      entity: "Justin Bieber",
      archiveCount: 3,
      recommendedCount: 12,
      webSearchAttempted: true,
      webFoundCount: 4,
    });
    expect(result.totalCount).toBe(7);
    expect(result.shouldWarnUser).toBe(true);
    expect(result.shouldWarnAdmin).toBe(true);
  });

  it("Test 13 — low coverage with no web search attempted still warns (structurally insufficient)", () => {
    const result = computeArchiveCoverageWarning({
      entity: "Some Obscure Topic",
      archiveCount: 1,
      recommendedCount: 8,
      webSearchAttempted: false,
      webFoundCount: 0,
    });
    expect(result.shouldWarnUser).toBe(true);
    expect(result.shouldWarnAdmin).toBe(true);
  });

  it("exactly meeting the recommended count is NOT a shortfall", () => {
    const result = computeArchiveCoverageWarning({
      entity: "X",
      archiveCount: 2,
      recommendedCount: 10,
      webSearchAttempted: true,
      webFoundCount: 8,
    });
    expect(result.totalCount).toBe(10);
    expect(result.shouldWarnUser).toBe(false);
  });
});

describe("applyCoverageWarningIfNeeded — wiring onto existing user/admin surfaces", () => {
  beforeEach(() => {
    updateVideoProgressMock.mockClear();
    getVideoByIdMock.mockClear().mockResolvedValue({ progressPercent: 47 });
    recordArchiveContentGapMock.mockClear();
  });

  it("Test 11 — insufficient footage: writes the exact required English copy to progressStep and logs an admin gap", async () => {
    await applyCoverageWarningIfNeeded(123, {
      entity: "Justin Bieber",
      archiveCount: 3,
      recommendedCount: 12,
      webSearchAttempted: true,
      webFoundCount: 4,
    });

    expect(updateVideoProgressMock).toHaveBeenCalledTimes(1);
    const [videoId, progressStep, progressPercent] = updateVideoProgressMock.mock.calls[0]!;
    expect(videoId).toBe(123);
    expect(progressStep).toBe(INSUFFICIENT_FOOTAGE_USER_MESSAGE);
    expect(progressStep).toContain("Not enough footage available");
    expect(progressStep).toContain("Your video may take longer to generate");
    // Existing progress percentage is preserved, not reset/misrepresented.
    expect(progressPercent).toBe(47);

    expect(recordArchiveContentGapMock).toHaveBeenCalledTimes(1);
    const [, adminNote] = recordArchiveContentGapMock.mock.calls[0]!;
    expect(adminNote).toContain("LOW ARCHIVE COVERAGE");
    expect(adminNote).toContain("Justin Bieber");
    expect(adminNote).toContain("archive: 3");
    expect(adminNote).toContain("recommended: 12");
    expect(adminNote).toContain("web search: completed");
    expect(adminNote).toContain("additional found: 4");
  });

  it("Test 12 — sufficient footage: never touches progressStep or the admin gap log", async () => {
    await applyCoverageWarningIfNeeded(123, {
      entity: "Justin Bieber",
      archiveCount: 12,
      recommendedCount: 12,
      webSearchAttempted: false,
      webFoundCount: 0,
    });
    expect(updateVideoProgressMock).not.toHaveBeenCalled();
    expect(recordArchiveContentGapMock).not.toHaveBeenCalled();
  });

  it("is best-effort — a DB failure never throws", async () => {
    getVideoByIdMock.mockRejectedValue(new Error("db down"));
    await expect(
      applyCoverageWarningIfNeeded(123, {
        entity: "X",
        archiveCount: 0,
        recommendedCount: 5,
        webSearchAttempted: true,
        webFoundCount: 0,
      })
    ).resolves.toBeDefined();
  });
});
