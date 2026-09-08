import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { VisualSourceLedger } from "./visualSourceLineage";

/**
 * THE SECOND A TRANSCRIPT LOCATED HAS TO SURVIVE THE DOWNLOAD THAT USED IT.
 *
 * `downloadYouTubeCCClip` has two branches and they were asymmetric:
 *
 *   RapidAPI (fallback)      whole video → `trimRemoteVideoToClip` → recordSourceTrim   ✓
 *   cloud yt-dlp (PRIMARY)   `/download?start=&duration=` → renameSync → return true    ✗
 *
 * The cloud service returns the window already cut, so the file never passes through the trim
 * helper — and that helper held the only call to `recordSourceTrim`. On the route that runs
 * FIRST, the located second was used to fetch the bytes and then dropped: no `sourceInSec` on the
 * lineage record, no `sourceTrim` on the timeline, `stats.withTrim` under-counting, and no way for
 * any audit to say which passage of the source the film used.
 *
 * RONDE 64 exists to find that second. Discarding it is discarding the evidence for the decision.
 */

const CLOUD = "cloud yt-dlp branch";
const RAPID = "RapidAPI branch";

describe("both YouTube download branches record the window they cut", () => {
  it("the lineage ledger stores inSec/outSec when a branch reports them", () => {
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 1 });
    const clip = "/tmp/scene_0_b0__pid_youtube_cc-abcdef0123456789.mp4";
    ledger.createLineage({
      sceneIndex: 0, beatIndex: 0,
      candidateId: "youtube_cc:abcdef0123456789",
      contentKey: "youtube_cc:abcdef0123456789",
      provider: "youtube_cc", providerAssetId: "abcdef0123456789",
      localPath: clip, mediaType: "video", route: "primary",
    });

    const record = ledger.recordSourceTrim(clip, { inSec: 252.4, outSec: 268.4 });
    expect(record).not.toBeNull();
    expect(record!.sourceInSec).toBe(252.4);
    expect(record!.sourceOutSec).toBe(268.4);
  });

  it("a negative or non-finite start is refused rather than stored", () => {
    /** The window must be a fact about the file, never a placeholder. */
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 1 });
    const clip = "/tmp/x.mp4";
    ledger.createLineage({
      sceneIndex: 0, beatIndex: 0,
      candidateId: "youtube_cc:z", contentKey: "youtube_cc:z",
      provider: "youtube_cc", providerAssetId: "z",
      localPath: clip, mediaType: "video", route: "primary",
    });

    ledger.recordSourceTrim(clip, { inSec: -5, outSec: 10 });
    expect(ledger.resolve(clip, "youtube_cc:z")?.sourceInSec).toBeUndefined();

    ledger.recordSourceTrim(clip, { inSec: Number.NaN });
    expect(ledger.resolve(clip, "youtube_cc:z")?.sourceInSec).toBeUndefined();
  });
});

describe("the primary branch is wired to record, not only the fallback", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("recordSourceTrim has a caller on BOTH download paths", () => {
    const callers = SRC.match(/recordSourceTrim\(/g) ?? [];
    expect(callers.length).toBeGreaterThanOrEqual(2);
  });

  it(`${CLOUD} records the window before it returns success`, () => {
    /**
     * Position matters, not just presence: the record must sit between the rename that publishes
     * the file and the `return true` that ends the branch. A call placed after the return would
     * type-check and never run.
     */
    const rename = SRC.indexOf('fs.renameSync(cloudTmpPath, outPath);');
    expect(rename).toBeGreaterThan(-1);
    const branch = SRC.slice(rename, rename + 3_600);
    const record = branch.indexOf("recordSourceTrim(outPath, {");
    const ret = branch.indexOf("return true;");
    expect(record).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(record);
  });

  it("it records the window it actually asked the service for", () => {
    /**
     * The service is called with `start=${clipStart}&duration=${duration}`, so those two are what
     * the file on disk contains. Recording anything else would describe a different cut.
     */
    const rename = SRC.indexOf('fs.renameSync(cloudTmpPath, outPath);');
    const branch = SRC.slice(rename, rename + 3_600);
    expect(branch).toContain("inSec: clipStart,");
    expect(branch).toContain("outSec: clipStart + duration,");
  });

  it(`${RAPID} keeps recording through the trim helper, unchanged`, () => {
    const helper = SRC.indexOf("export async function trimRemoteVideoToClip");
    expect(helper).toBeGreaterThan(-1);
    const body = SRC.slice(helper, helper + 3_000);
    expect(body).toContain("recordSourceTrim(outputPath, {");
    expect(body).toContain("inSec: clipStart,");
  });

  it("bookkeeping can never fail a clip that downloaded correctly", () => {
    /** Both call sites are wrapped — a provenance write must not cost a good file. */
    const rename = SRC.indexOf('fs.renameSync(cloudTmpPath, outPath);');
    const branch = SRC.slice(rename, rename + 3_600);
    const record = branch.indexOf("recordSourceTrim(outPath, {");
    expect(branch.slice(0, record)).toContain("try {");
    expect(branch.slice(record)).toContain("catch");
  });
});
