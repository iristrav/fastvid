/**
 * A CACHE ENTRY IS COMPLETE OR ABSENT, NEVER HALF-WRITTEN.
 *
 * ── What render 566 lost ────────────────────────────────────────────────────────────────────
 *
 * Twenty-eight failures across eighteen distinct archive assets, all the same shape:
 *
 *     [Pipeline] Scene 2 beat 1: curated asset 57364 failed: ENOENT: no such file or directory,
 *     copyfile '/app/uploads/archive-s3-cache/media-archive_37_…mp4' -> '/var/tmp/…mp4'
 *
 * The ENOENT is on the SOURCE — the cache file `fs.existsSync` had confirmed one statement earlier.
 * Between the check and the copy it was gone.
 *
 * ── Why it was gone ─────────────────────────────────────────────────────────────────────────
 *
 * The cache was populated with `fs.copyFileSync(destPath, cachePath)` straight onto the live path,
 * and `copyFileSync` TRUNCATES its target before refilling it. Every re-cache of an asset therefore
 * opened a window in which that path held a zero-length or partial file. A scene reuses its best
 * archive clips across many beats and several renders run at once, so landing in that window is not
 * an unlucky edge case — it is the ordinary case, which is why eighteen assets hit it in one render.
 * A SIGTERM mid-copy (this render was killed by a redeploy) leaves the same hole permanently.
 *
 * ── The two halves ──────────────────────────────────────────────────────────────────────────
 *
 * The write goes to a temp name and is `rename`d onto the entry. Within one filesystem that is
 * atomic, so a reader sees the old complete file or the new complete file and never the gap.
 *
 * The read falls through to the download when it fails. That is not papering over the race — it is
 * what a CACHE means: entries may vanish at any moment (eviction, a wiped ephemeral volume, a
 * half-written file from a killed process), and the asset behind them still exists in storage. The
 * miss is logged with its reason, so it is a fallthrough and not a silent one.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");

/** The body of `materializeArchiveAsset`, which is where both halves live. */
function materializeBlock(): string {
  const at = SRC.indexOf("export async function materializeArchiveAsset(");
  expect(at, "materializeArchiveAsset is gone").toBeGreaterThan(-1);
  const end = SRC.indexOf("\nexport ", at + 10);
  return SRC.slice(at, end > at ? end : at + 4000);
}

describe("the cache write is atomic", () => {
  /** The exact defect, by its exact shape: a copy straight onto the live entry. */
  it("never copies straight onto the live cache entry", () => {
    expect(
      materializeBlock(),
      "the cache is written with a truncating copy again — the ENOENT window is back"
    ).not.toContain("fs.copyFileSync(destPath, cachePath)");
  });

  it("writes to a temp name and renames it into place", () => {
    const block = materializeBlock();
    expect(block).toContain("const tmpPath = `${cachePath}.${process.pid}.${archiveCacheWriteSeq++}.tmp`");
    expect(block).toContain("fs.copyFileSync(destPath, tmpPath)");
    expect(block).toContain("fs.renameSync(tmpPath, cachePath)");
    // The copy must precede the rename, or the rename publishes nothing.
    expect(block.indexOf("fs.copyFileSync(destPath, tmpPath)")).toBeLessThan(
      block.indexOf("fs.renameSync(tmpPath, cachePath)")
    );
  });

  /** A failed write must not leave the temp file behind to accumulate on the volume. */
  it("cleans up its temp file when the write fails", () => {
    const block = materializeBlock();
    const at = block.indexOf("fs.copyFileSync(destPath, tmpPath)");
    const after = block.slice(at, at + 400);
    expect(after).toContain("fs.unlinkSync(tmpPath)");
  });

  /** Two writers in one process must not collide on the temp name either. */
  it("gives each write a distinct temp name", () => {
    expect(SRC).toContain("let archiveCacheWriteSeq = 0;");
    expect(materializeBlock()).toContain("archiveCacheWriteSeq++");
  });

  /**
   * `rename` is atomic only within one filesystem. The temp name is derived from `cachePath`, so
   * it is a sibling of the entry by construction and cannot drift onto another mount.
   */
  it("writes the temp file beside the entry it will replace", () => {
    expect(materializeBlock()).toContain("`${cachePath}.");
  });
});

describe("a cache read that fails is a miss, not a dead asset", () => {
  it("catches the read and continues to the download", () => {
    const block = materializeBlock();
    const at = block.indexOf("if (fs.existsSync(cachePath)) {");
    expect(at, "the cache-hit branch is gone").toBeGreaterThan(-1);
    const branch = block.slice(at, block.indexOf("await archiveDownloadLimit(", at));
    expect(branch).toContain("try {");
    expect(branch).toContain("fs.copyFileSync(cachePath, destPath)");
    expect(branch).toContain("} catch (err) {");
    // It must NOT rethrow — falling through to the download is the whole point.
    expect(branch).not.toMatch(/catch \(err\) \{[\s\S]{0,200}throw/);
  });

  /** The download below must actually be reachable from the failed branch. */
  it("returns only on a successful read", () => {
    const block = materializeBlock();
    const at = block.indexOf("if (fs.existsSync(cachePath)) {");
    const branch = block.slice(at, block.indexOf("await archiveDownloadLimit(", at));
    // The `return` sits inside the try, after the copy — not after the if-block.
    const copyAt = branch.indexOf("fs.copyFileSync(cachePath, destPath)");
    const returnAt = branch.indexOf("return;", copyAt);
    expect(returnAt).toBeGreaterThan(copyAt);
    expect(returnAt).toBeLessThan(branch.indexOf("} catch (err) {"));
  });

  /** Not silent: a miss says which key and why. */
  it("says which entry failed and why", () => {
    const block = materializeBlock();
    expect(block).toContain("cache entry for ${key} could not be read");
    expect(block).toContain("re-fetching from storage");
  });

  /** A corrupt entry is removed, so the next render does not pay for the same failure. */
  it("drops the unreadable entry", () => {
    const block = materializeBlock();
    const at = block.indexOf("could not be read");
    expect(block.slice(at, at + 300)).toContain("fs.unlinkSync(cachePath)");
  });
});
