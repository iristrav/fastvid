/**
 * VIDEO 652 — NO PIECE IS CUT THAT ADOPTION AND THE ARCHIVE WOULD ALWAYS REFUSE.
 *
 * The YouTube stock and the archive split cut with a 2 s floor; the archive admits nothing under 3 s
 * (`MIN_VIDEO_DURATION_SEC`) and adoption refuses the same pieces before the picture editor looks
 * (`belowArchiveMinimumDuration`, `invalid_duration_before_review`: 7× in render 652, the same files
 * 9× more as `not_a_valid_video`). The cutting floor is now the admission floor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ARCHIVE_PIECE_MIN_SEC, cutLocalVideoIntoShots, shotPieceRanges, type LocalShotCutter } from "./archiveShotPieces";
import { MIN_VIDEO_DURATION_SEC, belowArchiveMinimumDuration } from "./archiveIngestion";

const len = (p: { startSec: number; endSec: number }) => p.endSec - p.startSec;

describe("VIDEO 652 — the cutting floor is the admission floor", () => {
  it("1. the piece minimum equals the archive's minimum duration, 3 s", () => {
    expect(MIN_VIDEO_DURATION_SEC).toBe(3);
    expect(ARCHIVE_PIECE_MIN_SEC).toBe(MIN_VIDEO_DURATION_SEC);
  });

  it("2. shotPieceRanges(20, [2.6]) drops the 2.48 s opening scene instead of cutting it", () => {
    const pieces = shotPieceRanges(20, [2.6]);
    expect(pieces).toEqual([
      { startSec: 2.72, endSec: 11.36 },
      { startSec: 11.36, endSec: 20 },
    ]);
    expect(pieces.some((p) => Math.abs(len(p) - 2.48) < 0.01)).toBe(false);
  });

  it("3. the edge: a 2.99 s scene is no piece, a 3.00 s scene is one", () => {
    expect(shotPieceRanges(2.99, [])).toEqual([]);
    expect(shotPieceRanges(3, [])).toEqual([{ startSec: 0, endSec: 3 }]);
    /** Between cuts, after the 0.12 s pad: 3.12 → 3.00 s kept, 3.11 → 2.99 s dropped. */
    expect(shotPieceRanges(10, [3.12])[0]).toEqual({ startSec: 0, endSec: 3 });
    expect(shotPieceRanges(10, [3.11]).some((p) => p.startSec === 0)).toBe(false);
  });

  it("4. no cut piece is ever below the archive minimum", () => {
    const layouts: Array<[number, number[]]> = [
      [20, [2.6]], [30, [4, 18]], [20, [9.4, 10.2]], [12, [2.2, 4.5, 6.8, 9.9]], [40, [3.05, 6.2, 6.9, 30]],
    ];
    for (const [d, cuts] of layouts) {
      for (const p of shotPieceRanges(d, cuts)) expect(belowArchiveMinimumDuration(len(p))).toBe(false);
    }
  });

  it("5. a file with only sub-3 s shots is not stored as a piece at all (no_clean_shot)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video652-floor-"));
    const extracted: string[] = [];
    const cutter: LocalShotCutter = {
      detect: async () => ({ durationSec: 5.5, cutsSec: [2.6] }),
      extract: async (_in, out) => {
        extracted.push(out);
        fs.writeFileSync(out, "x");
      },
    };
    try {
      const cut = await cutLocalVideoIntoShots("/unused.mp4", dir, cutter);
      expect(cut.kind).toBe("no_clean_shot");
      expect(extracted).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
