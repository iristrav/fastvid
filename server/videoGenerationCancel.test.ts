import { describe, expect, it, afterEach } from "vitest";
import {
  requestVideoGenerationCancel,
  isVideoGenerationCancelRequested,
  clearVideoGenerationCancel,
  throwIfVideoGenerationCancelled,
  runWithActiveVideoId,
  throwIfActiveRenderCancelled,
} from "./videoGenerationCancel";

describe("videoGenerationCancel", () => {
  afterEach(() => {
    clearVideoGenerationCancel(999001);
    clearVideoGenerationCancel(999002);
  });

  it("throwIfVideoGenerationCancelled is a no-op when no cancel was requested", () => {
    expect(() => throwIfVideoGenerationCancelled(999001)).not.toThrow();
  });

  it("throwIfVideoGenerationCancelled throws once a cancel is requested for that videoId", () => {
    requestVideoGenerationCancel(999001);
    expect(isVideoGenerationCancelRequested(999001)).toBe(true);
    expect(() => throwIfVideoGenerationCancelled(999001)).toThrow("Video generation cancelled");
  });

  it("cancelling one videoId does not affect another — this is the exact guarantee the final completed-write checkpoint (F3-01) relies on", () => {
    requestVideoGenerationCancel(999001);
    expect(() => throwIfVideoGenerationCancelled(999001)).toThrow();
    expect(() => throwIfVideoGenerationCancelled(999002)).not.toThrow();
  });

  it("clearVideoGenerationCancel resets the flag so a later normal-completion checkpoint does not throw", () => {
    requestVideoGenerationCancel(999001);
    clearVideoGenerationCancel(999001);
    expect(() => throwIfVideoGenerationCancelled(999001)).not.toThrow();
  });

  it("throwIfActiveRenderCancelled reads the cancellation state via the active-render context, mirroring the checkpoint used inside the render", () => {
    requestVideoGenerationCancel(999001);
    expect(() =>
      runWithActiveVideoId(999001, () => {
        throwIfActiveRenderCancelled();
      })
    ).toThrow("Video generation cancelled");
  });
});
