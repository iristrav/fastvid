import { describe, expect, it, vi } from "vitest";
import { runFfmpeg } from "./videoRenderer";

vi.mock("../../videoPipeline", () => ({
  exec: vi.fn(),
}));

describe("Video Renderer stage", () => {
  it("runs the given ffmpeg command and returns stdout/stderr, nothing else", async () => {
    const { exec } = await import("../../videoPipeline");
    vi.mocked(exec).mockResolvedValue({ stdout: "done", stderr: "" });

    const result = await runFfmpeg('ffmpeg -y -i in.mp4 out.mp4');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stdout).toBe("done");
    }
    expect(exec).toHaveBeenCalledWith('ffmpeg -y -i in.mp4 out.mp4');
  });

  it("returns a structured error instead of throwing when ffmpeg fails", async () => {
    const { exec } = await import("../../videoPipeline");
    vi.mocked(exec).mockRejectedValue(new Error("ffmpeg exited with code 1"));

    const result = await runFfmpeg('ffmpeg -bad-arg');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exited with code 1");
    }
  });
});
