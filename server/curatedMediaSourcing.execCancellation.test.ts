import { describe, expect, it, afterEach } from "vitest";
import { exec } from "./curatedMediaSourcing";
import {
  requestVideoGenerationCancel,
  clearVideoGenerationCancel,
  runWithActiveVideoId,
} from "./videoGenerationCancel";

// Production fix: unlike videoPipeline.ts's own exec() (which calls throwIfActiveRenderCancelled()
// before every spawn), curatedMediaSourcing.ts's exec() never checked cancellation at all. A
// Railway production log showed the consequence directly: once a render was cancelled/superseded,
// videoPipeline.ts's ffmpeg calls (e.g. trimRemoteVideoToClip, used for Internet Archive clips)
// correctly started failing with "Video generation cancelled" — but curated-archive trims/Ken
// Burns encodes, which are routed through *this* exec(), kept running successfully for the rest of
// that render's already-cancelled lifetime (18+ minutes in the observed log), each one burning a
// real ffmpegSemaphore slot and CPU time that the actually-still-running attempt for the same video
// needed. These tests exercise the real, exported exec() directly — no mocking of the cancellation
// mechanism itself, same convention as videoGenerationCancel.test.ts (fake videoIds, real
// AsyncLocalStorage context via runWithActiveVideoId).
describe("curatedMediaSourcing exec() cancellation check (production fix)", () => {
  const videoId = 999101;

  afterEach(() => {
    clearVideoGenerationCancel(videoId);
  });

  it("refuses to spawn once the active render has been cancelled, instead of running ffmpeg for a dead render", async () => {
    requestVideoGenerationCancel(videoId);

    await expect(
      runWithActiveVideoId(videoId, () => exec("echo should-not-run", 5_000))
    ).rejects.toThrow("Video generation cancelled");
  });

  it("still runs normally when the render has not been cancelled — no regression to the existing spawn/timeout/retry behavior", async () => {
    const { stdout } = await runWithActiveVideoId(videoId, () => exec("echo still-works", 5_000));

    expect(stdout.trim()).toBe("still-works");
  });

  it("still runs normally outside any tracked render (no active videoId in context) — matches throwIfActiveRenderCancelled's existing no-op-when-untracked contract", async () => {
    const { stdout } = await exec("echo untracked-context", 5_000);

    expect(stdout.trim()).toBe("untracked-context");
  });
});
