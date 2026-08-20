import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 24 — the archive fills ITSELF from what the pipeline finds while searching, so anything
// admitted is permanent and gets re-offered to every later render. Ingestion had no text check at
// all, which is how burnt-in subtitles and news chyrons accumulated: renders 526/527 found 10 of
// 17 assets flagged, leaving only 7 usable out of an already small archive.
//
// RONDE 23 stopped such clips reaching the TIMELINE. This stops them reaching the ARCHIVE, which
// is the part that compounds — a rejected beat costs one beat, a polluted asset costs every
// future render.
//
// The memo moved into archiveClipFilter so both sides share it: videoPipeline (the beat gate)
// cannot be imported by archiveIngestion — that module is imported BY videoPipeline — so a shared
// leaf module is the only place a common cache can live without a cycle.

const ingestionSrc = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
const filterSrc = readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 24 — ingestion refuses text-laden footage", () => {
  const fn = ingestionSrc.slice(
    ingestionSrc.indexOf("async function ingestExternalClipToArchiveInner("),
    ingestionSrc.indexOf("const assetId = await createMediaArchiveAsset("),
  );

  it("checks for baked-in text before admitting the clip", () => {
    expect(fn).toContain("cachedClipHasBakedEditText(localPath, metadata.mimeType");
    expect(fn).toContain("baked-in on-screen text");
  });

  it("rejects by returning null, like the other ingestion gates", () => {
    const guardAt = fn.indexOf("cachedClipHasBakedEditText");
    const after = fn.slice(guardAt, guardAt + 400);
    expect(after).toContain("return null;");
  });

  it("runs before the upload and the DB insert, so nothing is stored for a rejected clip", () => {
    const guardAt = fn.indexOf("cachedClipHasBakedEditText");
    const uploadAt = fn.indexOf("storagePut(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(uploadAt);
  });

  it("records the cleared verdict on the new asset so it is never re-analysed", () => {
    expect(ingestionSrc).toContain("hasBakedEditText: 0,");
  });
});

describe("RONDE 24 — the overlay memo is shared, not duplicated", () => {
  it("lives in archiveClipFilter, reachable from both callers", () => {
    expect(filterSrc).toContain("export async function cachedClipHasBakedEditText(");
    expect(filterSrc).toContain("const overlayVerdictCache = new Map<string, boolean>()");
  });

  it("is used by the beat gate and by ingestion", () => {
    expect(pipelineSrc).toContain("cachedClipHasBakedEditText(clipPath");
    expect(ingestionSrc).toContain("cachedClipHasBakedEditText(localPath");
  });

  it("no longer keeps a second private cache in videoPipeline", () => {
    // A per-module cache would make a winning clip pay two vision calls: one at the beat gate
    // and another when that same clip is ingested moments later.
    expect(pipelineSrc).not.toContain("beatClipBakedTextCache");
  });

  it("fails OPEN so a broken detector cannot block every ingestion", () => {
    const cached = filterSrc.slice(
      filterSrc.indexOf("export async function cachedClipHasBakedEditText("),
      filterSrc.indexOf("export async function archiveClipHasBakedEditText("),
    );
    expect(cached).toContain("catch (err)");
    expect(cached).toContain("verdict = false;");
  });

  it("exposes a reset seam so tests do not leak verdicts between cases", () => {
    expect(filterSrc).toContain("export function __resetOverlayVerdictCacheForTest()");
  });
});
