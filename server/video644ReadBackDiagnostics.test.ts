/**
 * VIDEO 644 — H5: A FAILED ARCHIVE READ-BACK SAYS WHY, AND NEVER SAYS WHERE.
 *
 * Render 644 refused two approved YouTube shots with `ARCHIVE_NOT_READABLE:MISSING` (assets 60476
 * and 60518) and the log could not say whether the object store answered 403, the download timed
 * out, or the pipeline's own downloader refused before the wire (the sentence's download budget, a
 * URL refused earlier, a byte cap). Diagnostics only: the classes and the line, and the two places
 * that print them. No retry, no behaviour change.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { archiveReadBackFailureClass, formatArchiveReadBackLine } from "./productionMediaArchive";

describe("H5 — the failure class of a read-back that threw", () => {
  it("the downloader's own refusals each get their own class", () => {
    expect(archiveReadBackFailureClass(new Error("productionArchive:readBack: beat s0b0 has spent its download budget (12) — stopped asking"))).toBe("download_budget");
    expect(archiveReadBackFailureClass(new Error("productionArchive:readBack: 403 Forbidden (already refused this render)"))).toBe("refused_before");
    expect(archiveReadBackFailureClass(new Error("productionArchive:readBack: response exceeds maximum size of 500 bytes (Content-Length: 900)"))).toBe("byte_cap");
    expect(archiveReadBackFailureClass(new Error("productionArchive:readBack timed out after 120000ms"))).toBe("timeout");
    expect(archiveReadBackFailureClass(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe("timeout");
    expect(archiveReadBackFailureClass(new Error("fetch failed: ECONNRESET"))).toBe("network");
  });

  it("an unknown error is reported by its name, never by its message", () => {
    const err = Object.assign(new Error("GET https://s3.test/archive/asset_60518.mp4?X-Amz-Signature=secret failed"), { name: "TypeError" });
    const cls = archiveReadBackFailureClass(err);
    expect(cls).toBe("thrown:TypeError");
    expect(cls).not.toContain("http");
    expect(cls).not.toContain("Signature");
    expect(archiveReadBackFailureClass(undefined)).toBe("thrown");
  });
});

describe("H5 — the read-back line", () => {
  it("names the asset, the route and the outcome, and nothing that could be an address", () => {
    const line = formatArchiveReadBackLine({ assetId: 60518, via: "signed", outcome: "download_budget", ms: 46_000 });
    expect(line).toBe("[ProductionArchive] read-back asset=60518 via=signed outcome=download_budget ms=46000");
    expect(line).not.toMatch(/https?:/);
  });
});

describe("H5 — where the lines are printed (source text, so a later edit cannot silence them)", () => {
  const ARCHIVE = fs.readFileSync(path.join(__dirname, "productionMediaArchive.ts"), "utf8");
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("readBack reports every exit — the local copy, the signed object, a direct URL, an unresolvable key, a missing row", () => {
    const readBack = ARCHIVE.slice(ARCHIVE.indexOf("readBack: async (assetId, destPath) => {"), ARCHIVE.indexOf("findByChecksum: async (checksum) => {"));
    for (const via of ['"local"', '"signed"', '"direct"', '"unresolvable"', '"no_row"']) expect(readBack).toContain(via);
    expect(readBack).toContain("archiveReadBackFailureClass(err)");
    expect(readBack).toContain("formatArchiveReadBackLine(");
    /** The retries are what they were: two, 1 s and 3 s apart. */
    expect(ARCHIVE).toContain("export const ARCHIVE_READBACK_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];");
  });

  it("the pipeline's read-back fetch logs the object store's status and the bytes, not the URL", () => {
    const dep = PIPE.slice(PIPE.indexOf('"productionArchive:readBack"') - 400, PIPE.indexOf('"productionArchive:readBack"') + 700);
    expect(dep).toContain("[ProductionArchive] read-back fetch status=${got?.response?.status ?? \"none\"}");
    expect(dep).toContain("bytes=${got?.bytesWritten ?? 0}");
    expect(dep).not.toContain("${url}");
  });
});
