/**
 * A LOGO IS A REASON TO LOOK ELSEWHERE — RONDE 645.
 *
 * Render 603's background fetch: six of the first eight YouTube videos refused by the archive for
 * burnt-in text, four of them after all three segments had been fetched. The refusal is right and
 * stays. What changes: stop at the first text refusal, and look for another video.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  alternativeClaimKey,
  alternativeQueries,
  prefetchOneVideo,
  queueAlternativesFor,
  relevanceWordsFor,
  shouldSearchAlternatives,
  type AlternativeDeps,
  type PrefetchDeps,
} from "./youtubePrefetch";
import type { IngestOutcome } from "./archiveIngestion";

const refusedText: IngestOutcome = { status: "refused", reasonCode: "BAKED_EDIT_TEXT", reasonDetail: "logo" } as IngestOutcome;
const refusedSmall: IngestOutcome = { status: "refused", reasonCode: "FILE_TOO_SMALL", reasonDetail: "x" } as IngestOutcome;

function fetchDeps(ingest: (n: number) => IngestOutcome, log: string[]): PrefetchDeps {
  let n = 0;
  return {
    isIdle: () => true,
    sourceDurationSec: async () => 600,
    download: async (p) => {
      log.push(`download ${p.startSec}`);
      const fs = await import("fs");
      fs.writeFileSync(p.outPath, "x");
      return { ok: true };
    },
    videoRefusal: () => null,
    probeDurationSec: async () => 30,
    ingest: async () => ingest(n++),
    release: () => {},
    makeWorkDir: () => {
      const fs = require("fs") as typeof import("fs");
      const os = require("os") as typeof import("os");
      const path = require("path") as typeof import("path");
      return fs.mkdtempSync(path.join(os.tmpdir(), "prefetch-logo-"));
    },
    removeWorkDir: (d) => (require("fs") as typeof import("fs")).rmSync(d, { recursive: true, force: true }),
  };
}

const row = { videoId: "abcDEF12345", title: "Hitler Berlin 1945", query: "Hitler Berlin", licenseMode: null };

describe("§1 — the first text refusal ends the video", () => {
  it("ONE segment fetched, not three, when the first carries text", async () => {
    const log: string[] = [];
    const r = await prefetchOneVideo(row, fetchDeps(() => refusedText, log), 3);
    expect(log.filter((l) => l.startsWith("download"))).toHaveLength(1);
    expect(r.stoppedEarlyFor).toBe("BAKED_EDIT_TEXT");
  });

  it("a refusal about ONE file (too small) does not end the video", async () => {
    const log: string[] = [];
    const r = await prefetchOneVideo(row, fetchDeps(() => refusedSmall, log), 3);
    expect(log.filter((l) => l.startsWith("download"))).toHaveLength(3);
    expect(r.stoppedEarlyFor).toBeNull();
  });

  it("a clean first segment lets the others be fetched", async () => {
    const log: string[] = [];
    await prefetchOneVideo(row, fetchDeps(() => ({ status: "ingested", assetId: 1, storageKey: "k" }), log), 3);
    expect(log.filter((l) => l.startsWith("download"))).toHaveLength(3);
  });
});

describe("§2 — which refusals ask for another video, and what is searched", () => {
  it("only burnt-in text", () => {
    expect(shouldSearchAlternatives({ status: "refused", lastError: "ingest:BAKED_EDIT_TEXT" })).toBe(true);
    expect(shouldSearchAlternatives({ status: "refused", lastError: "download:DOWNLOAD_FAILED:x" })).toBe(false);
    expect(shouldSearchAlternatives({ status: "failed", lastError: "ingest:BAKED_EDIT_TEXT" })).toBe(false);
  });

  it("the same query, asking for original material", () => {
    expect(alternativeQueries("Hitler Berlin")).toEqual(["Hitler Berlin archive footage", "Hitler Berlin newsreel"]);
  });

  it("NO RECURSION — an alternative query never searches for alternatives of its own", () => {
    expect(alternativeQueries("Hitler Berlin archive footage")).toEqual([]);
    expect(alternativeQueries("Hitler Berlin newsreel")).toEqual([]);
    expect(alternativeQueries(null)).toEqual([]);
  });

  it("results must mention the base query's own words", () => {
    expect(relevanceWordsFor("Hitler Berlin 1945")).toEqual(["hitler", "berlin", "1945"]);
  });
});

function altDeps(over: Partial<AlternativeDeps> & { claimed?: Set<string> } = {}) {
  const claimed = over.claimed ?? new Set<string>();
  const searched: string[] = [];
  const queued: Array<{ videoId: string; query?: string | null }> = [];
  const deps: AlternativeDeps = {
    claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
    search: async (q) => {
      searched.push(q);
      return [
        { videoId: "abcDEF12345", title: "the refused one" },
        { videoId: "newVIDEO001", title: "Berlin 1945 newsreel" },
        { videoId: "newVIDEO002", title: "Hitler archive" },
      ];
    },
    enqueue: (c) => queued.push(...c),
    takeDailySlot: () => true,
    log: () => {},
    ...over,
  };
  return { deps, searched, queued, claimed };
}

describe("§3 — search once, queue what is new, bounded", () => {
  it("one search, the refused video itself excluded, rows carry the alternative query", async () => {
    const { deps, searched, queued } = altDeps();
    const r = await queueAlternativesFor(row, deps);
    expect(searched).toEqual(["Hitler Berlin archive footage"]);
    expect(queued.map((q) => q.videoId)).toEqual(["newVIDEO001", "newVIDEO002"]);
    expect(queued.every((q) => q.query === "Hitler Berlin archive footage")).toBe(true);
    expect(r.queued).toBe(2);
  });

  it("A (query, suffix) ALREADY SEARCHED — by any worker, ever — is not searched again; the next suffix is", async () => {
    const claimed = new Set([alternativeClaimKey("Hitler Berlin archive footage")]);
    const { deps, searched } = altDeps({ claimed });
    await queueAlternativesFor(row, deps);
    expect(searched).toEqual(["Hitler Berlin newsreel"]);
  });

  it("both already searched → no search at all", async () => {
    const claimed = new Set(alternativeQueries("Hitler Berlin").map(alternativeClaimKey));
    const { deps, searched } = altDeps({ claimed });
    expect(await queueAlternativesFor(row, deps)).toEqual({ query: null, queued: 0 });
    expect(searched).toEqual([]);
  });

  it("the daily allowance spent → no search", async () => {
    const { deps, searched } = altDeps({ takeDailySlot: () => false });
    await queueAlternativesFor(row, deps);
    expect(searched).toEqual([]);
  });

  it("a search that throws costs nothing but a log line", async () => {
    const { deps } = altDeps({ search: async () => { throw new Error("quota"); } });
    expect(await queueAlternativesFor(row, deps)).toEqual({ query: null, queued: 0 });
  });
});

describe("§4 — wired, and the archive's refusal is untouched", () => {
  const SRC = readFileSync(join(__dirname, "youtubePrefetch.ts"), "utf8");
  it("the batch asks for alternatives after a text refusal", () => {
    expect(SRC).toContain("if (shouldSearchAlternatives(verdict)) {");
  });
  it("new rows go through the same queue — the same fetch, validation and archive gates", () => {
    expect(SRC).toContain("enqueue: (cands) => enqueueYoutubePrefetch(cands,");
  });
  it("the text gate itself is not touched here", () => {
    const INGEST = readFileSync(join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(INGEST).toContain('const hasText = overlay.verdict === "has_text";');
    // RONDE 648: only a clip the picture editor approved for its beat passes with text — and the
    // prefetch never approves anything, so for this batch the refusal is exactly what it was.
    expect(INGEST).toContain("if (hasText && !metadata.approvedForBeat) {");
    expect(SRC).not.toContain("approvedForBeat");
  });
});
