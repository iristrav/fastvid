import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 15 — "why does Internet Archive fetch 192 results but only download 1?"
//
// Production logs: internet_archive results=192, downloads=1, plus 150+ "Internet Archive
// metadata scene" timeouts. Root cause: each archive.org search hit needs a second /metadata call
// before it can be downloaded, and that call routinely hits the 8s timeout. The historical
// cascade fetched those metadata calls ONE DOC AT A TIME (`for (const doc of docs)` with an await
// inside), so ~12 docs × up to 8s serialised to ~90s/scene and almost nothing was left to
// download. The providerLimiter already permits 4 concurrent IA requests, but the serial loop
// only ever used one. Fix: resolve the metadata for a batch CONCURRENTLY (capped by the same
// limiter), then run the UNCHANGED license/size/download/trim decision over the resolved batch in
// order — same dedup (filtered before the metadata call), same counters, just not serialised.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of fetchInternetArchiveClips (the historical cascade path). */
function iaFnBody(): string {
  const start = pipelineSrc.indexOf("async function fetchInternetArchiveClips");
  expect(start).toBeGreaterThan(-1);
  // stop at the next top-level function decl after it
  const end = pipelineSrc.indexOf("\nasync function ", start + 1);
  return codeOnly(pipelineSrc.slice(start, end === -1 ? start + 8000 : end));
}

describe("RONDE 15 — Internet Archive metadata is resolved concurrently, not one doc at a time", () => {
  const body = iaFnBody();

  it("iterates docs in batches instead of a single sequential per-doc loop", () => {
    expect(body).toContain("IA_METADATA_BATCH");
    expect(body).toContain("batchStart += IA_METADATA_BATCH");
  });

  it("resolves the batch's metadata concurrently via Promise.all", () => {
    expect(body).toContain("const resolvedBatch = await Promise.all(batchDocs.map");
  });

  it("still filters already-used identifiers BEFORE the metadata call (dedup preserved)", () => {
    const filterIdx = body.indexOf("providerAssetAlreadyUsed(usedProviderKeys, sourcingCache, \"internet_archive\"");
    const promiseIdx = body.indexOf("const resolvedBatch = await Promise.all");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(promiseIdx).toBeGreaterThan(-1);
    // the dedup filter is applied to batchDocs, before the concurrent metadata resolve
    expect(filterIdx).toBeLessThan(promiseIdx);
  });

  it("still goes through the shared IA concurrency limiter (archive.org not hit harder)", () => {
    expect(body).toContain('providerLimiter("internetArchive").run');
  });

  it("keeps the 8s metadata timeout (RONDE 11 — 15s stalled whole renders)", () => {
    const metaIdx = body.indexOf("`Internet Archive metadata scene ${sceneIndex}`");
    expect(metaIdx).toBeGreaterThan(-1);
    const window = body.slice(metaIdx - 200, metaIdx);
    expect(window).toContain("8_000");
    expect(window).not.toContain("15_000");
  });

  it("the download/trim decision still runs sequentially over the resolved batch", () => {
    // winner is decided by the same downstream logic; the sequential inner loop consumes resolvedBatch.
    expect(body).toContain("for (const { doc, metaData } of resolvedBatch)");
  });
});
