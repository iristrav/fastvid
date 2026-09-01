/**
 * RONDE 177 — "hij slaat het bijknippen per clip in het archief nog niet op."
 *
 * The trim DID write. Every time. `trimToSingleScene` built the range, `trimArchiveAsset` re-encoded
 * with ffmpeg, storagePut stored the result, and both storage columns were updated — RONDE 98 had
 * already fixed the half-write that pointed the row at two different files.
 *
 * What survived the trim was everything AROUND the bytes, and that is what the operator saw:
 *
 *   1. The duration column was INT. The trim probes the file it just produced and writes back
 *      8.53s; MySQL rounded that to 9. So the number in the row was never the number the operator
 *      was shown, and a trim that shortened a clip by less than half a second wrote back the SAME
 *      integer — a row that genuinely looked untouched. (Fixed by widening the column to FLOAT,
 *      migration 0048; media_asset_cache.durationSec had been FLOAT for these same values all
 *      along.)
 *
 *   2. Every verdict reached about the OLD footage stayed on the row: the clip annotation, the
 *      baked-text check, the RONDE 118 preview check. A clip is usually trimmed BECAUSE of what
 *      those verdicts recorded, so keeping them is keeping the complaint about footage that no
 *      longer exists.
 *
 * The third cause — the preview URL never changing, which is what made the whole thing LOOK
 * unsaved — is in ronde177TrimPreviewUrl.test.ts, because it needs the db module unmocked.
 *
 * This file runs the real thing: real ffmpeg, real storagePut against the local backend, real
 * ffprobe. Only the database write is captured, because there is no database in this session.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { describe, expect, it, vi, beforeAll } from "vitest";

const hoisted = vi.hoisted(() => {
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "r177-uploads-"));
  // storageLocal resolves LOCAL_UPLOADS_DIR at module load and ESM imports hoist above ordinary
  // statements, so this has to be set from inside the hoisted block.
  process.env.UPLOADS_DIR = dir;
  return { UPLOADS: dir, dbWrites: [] as Array<{ id: number; patch: Record<string, unknown> }> };
});

vi.mock("./db", () => ({
  updateMediaArchiveAsset: async (id: number, patch: Record<string, unknown>) => {
    hoisted.dbWrites.push({ id, patch });
    return true;
  },
}));

import { trimArchiveAsset } from "./archiveTrimToScene";
import { probeVideoDurationSec } from "./archiveVideoSplitter";
import { resolveLocalStorageFilePath } from "./storageLocal";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

/** The asset row block in the schema, bounded by its own table declaration and the next one. */
function archiveAssetsSchemaBlock(): string {
  const schema = read("drizzle/schema.ts");
  const start = schema.indexOf("export const mediaArchiveAssets = mysqlTable(");
  expect(start, "mediaArchiveAssets table not found in schema").toBeGreaterThan(0);
  const next = schema.indexOf("mysqlTable(", start + 60);
  return schema.slice(start, next === -1 ? schema.length : next);
}

const SRC_KEY = "archive/r177-source.mp4";
let sourcePath = "";

beforeAll(() => {
  sourcePath = path.join(hoisted.UPLOADS, SRC_KEY.replace(/\//g, "_"));
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=25:duration=20 ` +
      `-c:v libx264 -g 25 -pix_fmt yuv420p "${sourcePath}" 2>/dev/null`
  );
});

/** A clip that has been fully examined: annotated, overlay-checked, preview-checked. */
function examinedAsset() {
  return {
    id: 90177,
    archiveId: 1,
    title: "R177 trim source",
    mediaType: "video" as const,
    mimeType: "video/mp4",
    storageUrl: `/local-storage/${SRC_KEY.replace(/\//g, "_")}`,
    storageKey: SRC_KEY,
    durationSec: 20,
    annotationJson: { summary: "opens on a title card" },
    annotationVersion: "v1",
    editorialScore: 72,
    hasBakedEditText: 1,
    previewCheckedAt: new Date("2026-01-01T00:00:00Z"),
    previewIssue: "no_preview_frame",
  };
}

/* ═══════════════════════ the write itself, run for real ═══════════════════════ */

describe("RONDE 177 — what a real trim writes back", () => {
  let patch: Record<string, unknown>;

  beforeAll(async () => {
    hoisted.dbWrites.length = 0;
    // 6.0s–14.5s: a range whose length (8.5s) is deliberately NOT a whole number, which is the
    // case the INT column could not represent.
    await trimArchiveAsset(examinedAsset() as never, { startSec: 6, endSec: 14.5 });
    expect(hoisted.dbWrites, "the trim wrote nothing at all").toHaveLength(1);
    patch = hoisted.dbWrites[0]!.patch;
    console.log(`[R177] db write = ${JSON.stringify(patch)}`);
  }, 120_000);

  it("THE DURATION: writes the fractional duration it actually produced", () => {
    /**
     * Not 8, not 9 — the length of the file on disk. An INT column silently rounded this, which is
     * why a sub-second trim used to leave the row unchanged.
     */
    const written = Number(patch.durationSec);
    expect(written).toBeGreaterThan(8.3);
    expect(written).toBeLessThan(8.7);
    expect(Number.isInteger(written), "a whole number here means the fraction was thrown away").toBe(false);
  });

  it("...and the column can hold it: media_archive_assets.durationSec is FLOAT", () => {
    const block = archiveAssetsSchemaBlock();
    expect(block).toContain('durationSec: float("durationSec")');
    expect(block, "an INT column rounds every trim").not.toContain('durationSec: int("durationSec")');
  });

  it("...with a migration that actually widens the live column", () => {
    const sql = read("drizzle/0048_ronde177_archive_trim_duration.sql");
    expect(sql).toContain("ALTER TABLE `media_archive_assets`");
    expect(sql.toLowerCase()).toContain("modify column `durationsec` float");
    // A migration drizzle-kit does not know about is a migration that never runs.
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0048_ronde177_archive_trim_duration");
  });

  it("THE STALE VERDICTS: the clip annotation is cleared, so the annotator looks again", () => {
    /**
     * The annotation describes frames that no longer exist. Its own re-computation rule is
     * "never re-computed unless annotationVersion changes", so clearing the version is the
     * documented way to ask for a fresh look — not an extra checker, the existing one.
     */
    expect(patch).toHaveProperty("annotationJson", null);
    expect(patch).toHaveProperty("annotationVersion", null);
  });

  it("...the baked-text verdict is cleared", () => {
    // null = "not yet checked", which is the honest state for footage nobody has looked at.
    expect(patch).toHaveProperty("hasBakedEditText", null);
  });

  it("...and the RONDE 118 preview check is cleared, both columns together", () => {
    expect(patch).toHaveProperty("previewCheckedAt", null);
    expect(patch).toHaveProperty("previewIssue", null);
  });

  it("editorialScore deliberately SURVIVES the trim", () => {
    /**
     * The one derived field that is not cleared, and it is a decision rather than an oversight:
     * a null editorialScore is read as 50 at the montage filter in videoPipeline, so clearing it
     * would demote every freshly trimmed clip until the annotator got round to it. The annotator
     * overwrites it on its next pass anyway.
     */
    expect(Object.keys(patch)).not.toContain("editorialScore");
  });

  it("RONDE 98 still holds: both storage columns move together", () => {
    expect(typeof patch.storageKey).toBe("string");
    expect(typeof patch.storageUrl).toBe("string");
    expect(patch.storageKey).not.toBe(SRC_KEY);
  });

  it("the file behind those columns really is the trimmed one", async () => {
    const onDisk = resolveLocalStorageFilePath({
      storageUrl: patch.storageUrl as string,
      storageKey: patch.storageKey as string,
    });
    expect(onDisk, "trimmed file not found on disk").toBeTruthy();
    const dur = await probeVideoDurationSec(onDisk!);
    expect(dur).toBeGreaterThan(8.3);
    expect(dur).toBeLessThan(8.7);
    // And the original is untouched — the trim is not destructive to the source bytes.
    expect(await probeVideoDurationSec(sourcePath)).toBeGreaterThan(19.5);
  }, 60_000);
});

/* ═══════════════════════ the clearing is at the write, not beside it ═══════════════════════ */

describe("the verdicts are cleared in the same statement that moves the file", () => {
  it("one updateMediaArchiveAsset call carries all of it", () => {
    /**
     * Two writes could half-apply: the file moves, the process dies, and the row keeps a verdict
     * about footage it no longer points at. There is exactly one call, and the real trim above
     * proves it by capturing exactly one write.
     */
    const src = read("server/archiveTrimToScene.ts");
    const body = src.slice(
      src.indexOf("export async function trimArchiveAsset("),
      src.indexOf("/** Backwards-compatible alias")
    );
    expect((body.match(/await updateMediaArchiveAsset\(/g) ?? []).length).toBe(1);
  });
});
