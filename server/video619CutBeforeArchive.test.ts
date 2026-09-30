/**
 * VIDEO 619 — a download is cut into single shots before it enters the archive, and the archive
 * sweep takes each old clip once, longest first.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  cutLocalVideoIntoShots,
  splitArchiveAssetIntoShots,
  shotSourceUrl,
  type LocalShotCutter,
  type ShotPieceDeps,
} from "./archiveShotPieces";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

function cutter(durationSec: number, cutsSec: number[], incomplete?: string): LocalShotCutter & { extracted: string[] } {
  const extracted: string[] = [];
  return {
    extracted,
    detect: async () => ({ durationSec, cutsSec, ...(incomplete ? { incomplete } : {}) }),
    extract: async (_in, out, a, b) => {
      extracted.push(`${a}-${b}`);
      fs.writeFileSync(out, "x");
    },
  };
}

describe("Video 619 — cut before the archive", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cut-before-"));

  it("a 30-second download with cuts becomes single shots of at most eleven seconds", async () => {
    const c = cutter(30, [4, 18]);
    const r = await cutLocalVideoIntoShots("/src.mp4", dir(), c);
    expect(r.kind).toBe("pieces");
    if (r.kind !== "pieces") return;
    expect(r.pieces.length).toBe(5);
    for (const p of r.pieces) {
      expect(p.endSec - p.startSec).toBeLessThanOrEqual(11);
      expect(fs.existsSync(p.path)).toBe(true);
    }
  });

  it("one short shot is stored as it is, not re-encoded", async () => {
    const c = cutter(5, []);
    expect(await cutLocalVideoIntoShots("/src.mp4", dir(), c)).toEqual({ kind: "one_shot", durationSec: 5 });
    expect(c.extracted).toEqual([]);
  });

  it("a clip whose every shot is too short gives nothing to store", async () => {
    const r = await cutLocalVideoIntoShots("/src.mp4", dir(), cutter(4, [1.3, 2.6]));
    expect(r.kind).toBe("no_clean_shot");
  });

  it("an unfinished cut scan is said so, not guessed", async () => {
    const r = await cutLocalVideoIntoShots("/src.mp4", dir(), cutter(30, [], "stopped"));
    expect(r).toEqual({ kind: "unmeasured", reason: "stopped" });
  });

  it("each shot is found again by the seconds it covers", () => {
    expect(shotSourceUrl("https://youtu.be/x?t=10", "youtube_cc:x", { startSec: 4.12, endSec: 11 })).toBe(
      "https://youtu.be/x?t=10#shot=4.12-11.00"
    );
    expect(shotSourceUrl(undefined, "wikimedia:File", { startSec: 0, endSec: 3 })).toBe(
      "fastvid-source:wikimedia:File#shot=0.00-3.00"
    );
  });
});

describe("Video 619 — the archive sweep", () => {
  const parent = { id: 7, archiveId: 1, mediaType: "video" as const, isActive: 1, title: "t", tags: [] };
  const deps = (over: Partial<ShotPieceDeps>): ShotPieceDeps & { marked: Array<{ deactivate: boolean }> } => {
    const marked: Array<{ deactivate: boolean }> = [];
    return {
      marked,
      getAsset: async () => parent,
      fetchAsset: async (_id, dest) => (fs.writeFileSync(dest, "x"), true),
      detect: async () => ({ durationSec: 4, cutsSec: [1.3, 2.6] }),
      extract: async (_i, out) => fs.writeFileSync(out, "x"),
      textVerdict: async () => "clean",
      storePiece: async () => 1,
      markParent: async (_id, change) => void marked.push(change),
      ...over,
    };
  };

  it("a clip another worker has taken is left alone", async () => {
    const d = deps({ claim: async () => false });
    expect(await splitArchiveAssetIntoShots(7, d)).toEqual({ status: "skipped", reason: "another worker is cutting it" });
    expect(d.marked).toEqual([]);
  });

  it("a clip with transitions and no usable shot is switched off", async () => {
    const d = deps({ claim: async () => true });
    const r = await splitArchiveAssetIntoShots(7, d);
    expect(r.status).toBe("split");
    expect(d.marked).toEqual([{ deactivate: true }]);
  });

  it("the sweep takes the longest clips first, ten at a time, and each clip is claimed once", () => {
    const db = read("db.ts");
    expect(db).toContain(".orderBy(desc(mediaArchiveAssets.durationSec), asc(mediaArchiveAssets.id))");
    expect(db).toContain("isNull(mediaArchiveAssets.splitIntoShotsAt)));");
    expect(read("archiveShotPieces.ts")).toContain("batch = 10");
  });
});
