/**
 * VIDEO 619 — existing archive rows are brought back to two tags, except tags an operator typed.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { handTagsWithAutomaticFill, trimExistingArchiveTags, type TagBackfillRow } from "./archiveTagRule";
import { archiveUpdateRespectingHandTags } from "./db";
import { typedTagsRow } from "./archiveUpload";

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

describe("Video 619 — tags an operator typed are kept", () => {
  it("keeps every typed tag, even more than two", () => {
    expect(handTagsWithAutomaticFill(["kylie jenner", "interview", "vogue", "2019"], ["kylie jenner", "interview", "vogue", "2019", "hd", "red carpet"]))
      .toEqual(["kylie jenner", "interview", "vogue", "2019"]);
  });

  it("fills up to two with automatic tags when fewer were typed", () => {
    expect(handTagsWithAutomaticFill(["kylie jenner"], ["kylie jenner", "footage", "interview", "vogue"])).toEqual([
      "kylie jenner",
      "interview",
    ]);
  });

  it("an upload with typed tags is marked by hand; without typed tags it is not", () => {
    expect(typedTagsRow(["a b", "c", "d"], ["a b", "c", "d", "e"])).toEqual({ tags: ["a b", "c", "d"], tagsSetByHand: 1 });
    expect(typedTagsRow([], ["x", "y", "z"])).toEqual({ tags: ["x", "y", "z"], tagsSetByHand: 0 });
  });

  it("an automatic write leaves a hand-tagged row's tags alone but writes the rest", () => {
    expect(archiveUpdateRespectingHandTags({ tags: ["x"], durationSec: 4 }, true)).toEqual({ durationSec: 4 });
  });

  it("an automatic write to an ordinary row is held to two tags", () => {
    expect(archiveUpdateRespectingHandTags({ tags: ["kylie jenner", "interview", "vogue", "2019"] }, false)).toEqual({
      tags: ["kylie jenner", "2019"],
    });
  });

  it("an operator edit is written as typed, also over an ordinary row", () => {
    const typed = { tags: ["a", "b", "c", "d"], tagsSetByHand: 1 };
    expect(archiveUpdateRespectingHandTags(typed, false)).toEqual(typed);
  });
});

describe("Video 619 — existing rows back to two tags", () => {
  it("trims every listed row, page by page, and stops when none are left", async () => {
    const rows: TagBackfillRow[] = [
      { id: 3, tags: ["kylie jenner", "interview", "vogue", "hd"], title: null, entities: null },
      { id: 7, tags: ["speech", "white house", "2009", "news"], title: null, entities: ["Barack Obama"] },
    ];
    const written = new Map<number, string[]>();
    const n = await trimExistingArchiveTags(
      {
        list: async (limit, afterId) => rows.filter((r) => r.id > afterId).slice(0, limit),
        update: async (id, tags) => void written.set(id, tags),
      },
      1
    );
    expect(n).toBe(2);
    expect(written.get(3)).toEqual(["kylie jenner", "interview"]);
    expect(written.get(7)).toEqual(["barack obama", "2009"]);
  });

  it("hand-tagged rows are never listed for trimming", () => {
    const db = read("server/db.ts");
    const fn = db.slice(db.indexOf("export async function listArchiveAssetsWithTooManyTags"));
    expect(fn.slice(0, 1200)).toContain("eq(mediaArchiveAssets.tagsSetByHand, 0)");
  });

  it("the worker runs the trim, the admin edit and pieces carry the hand mark, the migration adds it", () => {
    expect(read("server/worker.ts")).toContain("trimExistingArchiveTags");
    expect(read("server/routers.ts")).toContain("patch.tagsSetByHand = 1");
    expect(read("server/archiveShotPieces.ts")).toContain("parent.tagsSetByHand === 1");
    expect(read("drizzle/0063_video619_archive_shot_pieces.sql")).toContain("ADD `tagsSetByHand` int DEFAULT 0 NOT NULL");
  });
});
