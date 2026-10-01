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
import { prefetchOneVideo, type PrefetchDeps } from "./youtubePrefetch";
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

describe("§4 — wired, and the archive's refusal is untouched", () => {
  const SRC = readFileSync(join(__dirname, "youtubePrefetch.ts"), "utf8");
  /** VIDEO 619 — the gate still refuses a clip with text; only a longer video is cut for its clean pieces. */
  it("the text gate itself is not touched here", () => {
    expect(readFileSync(join(__dirname, "archiveIngestion.ts"), "utf8")).toContain('if (overlay?.decision === "REJECT") {');
  });
});
