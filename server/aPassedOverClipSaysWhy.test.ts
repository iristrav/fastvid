import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { adoptClipForTest, createVisualDedupState, getPipelinePerfProfile } from "./videoPipeline";
import { beatRejectReasons } from "./rejectionRegistry";

/**
 * RONDE 647 — render 610 downloaded `btHJYt5YE9s` nine times, 168 512 bytes each, and it never
 * reached the film or left a reason: the adoption loop's size floor dropped it with a bare
 * `continue`. The floor is unchanged; a real file under it now leaves its reason on the beat.
 */
describe("a candidate the adoption loop passes over says why", () => {
  let dir: string;
  let small: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-passed-over-"));
    small = path.join(dir, "scene_0_ytfu_0__pid_youtube_cc-0123456789abcdef.mp4");
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=25:d=5",
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "150k", small,
    ]);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a real video under the 180 KB floor is refused WITH its size, not silently", async () => {
    const bytes = fs.statSync(small).size;
    expect(bytes, "the fixture must sit under the floor it exercises").toBeLessThan(180_000);
    const dedup = createVisualDedupState(getPipelinePerfProfile("1"));

    const adopted = await adoptClipForTest([small], dedup, 0, 0, "Berlin in 1945", dir, "berlin 1945");

    expect(adopted).toBeNull();
    const reasons = beatRejectReasons(dedup.rejections, 0, 0).map(([reason]) => reason);
    expect(reasons).toContain(`below_size_floor_${bytes}_bytes`);
  });

  it("a file that is gone is refused as missing", async () => {
    const dedup = createVisualDedupState(getPipelinePerfProfile("1"));

    const adopted = await adoptClipForTest([path.join(dir, "gone.mp4")], dedup, 0, 1, "Berlin", dir, "berlin");

    expect(adopted).toBeNull();
    expect(beatRejectReasons(dedup.rejections, 0, 1).map(([r]) => r)).toEqual(["file_missing"]);
  });
});
