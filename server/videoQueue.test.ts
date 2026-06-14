import { describe, expect, it } from "vitest";
import { readQueueConfig } from "@shared/videoQueue";

describe("video queue config", () => {
  it("reads defaults", () => {
    const config = readQueueConfig({});
    expect(config.maxConcurrentJobs).toBe(6);
    expect(config.maxActiveJobsPerUser).toBe(1);
    expect(config.maxQueuedJobsPerUser).toBe(1);
    expect(config.pollIntervalMs).toBe(5000);
  });

  it("respects env overrides", () => {
    const config = readQueueConfig({
      MAX_CONCURRENT_JOBS: "4",
      MAX_ACTIVE_JOBS_PER_USER: "2",
      MAX_QUEUED_JOBS_PER_USER: "10",
      QUEUE_POLL_INTERVAL_MS: "8000",
    });
    expect(config.maxConcurrentJobs).toBe(4);
    expect(config.maxActiveJobsPerUser).toBe(2);
    expect(config.maxQueuedJobsPerUser).toBe(10);
    expect(config.pollIntervalMs).toBe(8000);
  });
});
