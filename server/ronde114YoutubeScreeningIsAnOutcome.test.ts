/**
 * RONDE 114 — A REFUSED YOUTUBE CLIP IS REFUSED, NOT VANISHED.
 *
 * ── What render 568 measured ─────────────────────────────────────────────────────────────────
 *
 * Four YouTube downloads succeeded and none was adopted. RONDE 113 traced two of them to one
 * branch: the picture editor refused them before they ever reached a pool, the file was unlinked,
 * and the loop moved on. The render's own numbers show the hole that left:
 *
 *     [ProviderFunnel] provider=youtube_cc judged=2 fits=0 refused=2 accepted=0%
 *     [VisualFunnel]   youtube_cc downloadSucceeded=4 adopted=0 rejected=0
 *     [ProviderFunnelInvariant] provider=youtube_cc tracked=12 terminalOutcomes=10
 *                               unexplained=2 INVARIANT_BROKEN
 *
 * `refused=2` and `rejected=0` in the same render, about the same two clips. The refusal was real;
 * only the record of it was missing.
 *
 * ── What this file guards, and what it does not ──────────────────────────────────────────────
 *
 * It guards the REGISTRATION. The screening decision is untouched: a clip refused before this
 * round is refused after it, by the same gate, at the same threshold. Every test below asserts
 * something about the ledger or about the order of two statements — none of them asserts that
 * more YouTube material is accepted, because none of it is.
 *
 * The lifecycle assertions run the REAL writers — `tagPathWithProviderAsset`,
 * `recordProviderDownloadOutcome`, `recordAssetOutcome` — against a real `VisualSourceLedger`, so
 * "the rejection is a terminal outcome" is answered by the same code the render runs, not by a
 * restatement of it here.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  VisualSourceLedger,
  formatProviderFunnelInvariant,
  recordAssetOutcome,
} from "./visualSourceLineage";
import {
  createSourcingCache,
  recordProviderDownloadOutcome,
  tagPathWithProviderAsset,
} from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const VIDEO_ID = "9V7Zgx4rDDA";
const SCENE = 1;
const BEAT = 2;

/**
 * One YouTube candidate carried to the exact state the refusal branch meets it in: tagged, its
 * record open, its download recorded as succeeded. Nothing here is a stand-in — these are the two
 * calls the cascade makes, in the order it makes them.
 */
function downloadedYoutubeClip() {
  const cache = createSourcingCache(568);
  const tagged = tagPathWithProviderAsset(
    `/w/scene_${SCENE}_yt_${VIDEO_ID}.mp4`,
    "youtube_cc",
    VIDEO_ID,
    cache,
    { sceneIndex: SCENE, beatIndex: BEAT, mediaType: "video" }
  );
  recordProviderDownloadOutcome(cache, tagged, true);
  return { cache, tagged };
}

const stagesFor = (ledger: VisualSourceLedger, lineageId: string) =>
  ledger
    .allEvents()
    .filter((e) => e.lineageId === lineageId)
    .map((e) => `${e.stage}:${e.status}`);

/* ═══════════════ A. the refusal is a terminal outcome ═══════════════ */

describe("A — a screened-out YouTube download has an ending", () => {
  it("files a REJECTED outcome the invariant counts as terminal", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    const id = cache.lineage.resolve(tagged)!.lineageId;

    /** Before: succeeded, and then nothing — render 568's shape exactly. */
    expect(stagesFor(cache.lineage, id)).toEqual([
      "FOUND:OK",
      "DOWNLOAD_STARTED:OK",
      "DOWNLOAD_SUCCEEDED:OK",
    ]);
    expect(
      formatProviderFunnelInvariant(cache.lineage.summary(), cache.lineage.allRecords(), cache.lineage.allEvents())
        .find((l) => l.includes("provider=youtube_cc"))
    ).toContain("unexplained=1 INVARIANT_BROKEN");

    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);

    expect(stagesFor(cache.lineage, id)).toContain("REMOVED:REJECTED");
    const after = formatProviderFunnelInvariant(
      cache.lineage.summary(), cache.lineage.allRecords(), cache.lineage.allEvents()
    ).find((l) => l.includes("provider=youtube_cc"))!;
    expect(after).toContain("unexplained=0");
    expect(after).not.toContain("INVARIANT_BROKEN");
  });

  it("counts as a rejection in the funnel row that read rejected=0", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    const yt = cache.lineage.summary().byProvider["youtube_cc"]!;
    expect(yt.downloadSucceeded).toBe(1);
    expect(yt.rejected).toBe(1);
  });

  it("leaves no VANISHED_WITHOUT_OUTCOME behind", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    const id = cache.lineage.resolve(tagged)!.lineageId;
    cache.lineage.recordEvent(id, "SELECTED", { status: "OK" });
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    /** Flips `finalVideoVerified`, which is what arms the vanished rule at all. */
    cache.lineage.markFinalVideo([]);
    const audit = cache.lineage.reconcile();
    expect(
      [...audit.warnings, ...audit.errors].filter((w) => w.code === "VANISHED_WITHOUT_OUTCOME")
    ).toEqual([]);
  });
});

/* ═══════════════ B. written before the file is gone ═══════════════ */

describe("B — the outcome is filed before the unlink", () => {
  it("records, then deletes — in that order, in the source", () => {
    const gate = PIPE.indexOf("!(await youtubeClipPassesImageGate(outPath, workDir, sceneIndex, videoId, scriptGuided))");
    const record = PIPE.indexOf("recordYoutubeScreeningRefusal(", gate);
    const unlink = PIPE.indexOf("fs.unlinkSync(outPath)", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(gate);
    expect(unlink).toBeGreaterThan(record);
  });

  it("files it under the reason the gate actually gave, not a generic one", () => {
    const helper = PIPE.indexOf("function recordYoutubeScreeningRefusal(");
    const block = PIPE.slice(helper, helper + 700);
    expect(block).toContain("recordAssetOutcome(");
    expect(block).toContain('"vision_rejected"');
    expect(block).toContain("youtube_screening");
  });

  it("leaves the deletion and the continue inside the branch the older tests slice", () => {
    /**
     * RONDE 60's structural test takes 500 bytes from the gate call and expects both. My first
     * version of this fix put 1600 characters of explanation inside that window and pushed them
     * out — the failure this assertion now guards against, kept here so the next edit to this
     * branch finds out immediately instead of at the end of a full suite run.
     */
    const gate = PIPE.indexOf("youtubeClipPassesImageGate(outPath, workDir, sceneIndex, videoId, scriptGuided)");
    const block = PIPE.slice(gate, gate + 500);
    expect(block).toContain("fs.unlinkSync(outPath)");
    expect(block).toContain("continue;");
  });
});

/* ═══════════════ C. a rejected clip cannot come back ═══════════════ */

describe("C — refused means refused", () => {
  it("is flagged if it somehow reaches the final video", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    const id = cache.lineage.resolve(tagged)!.lineageId;
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    /**
     * Not a new rule — `FINAL_AND_REJECTED` has guarded this since RONDE 95. Filing the refusal is
     * what puts a YouTube screening refusal INSIDE that guard's reach; before this round there was
     * no rejection for it to contradict.
     */
    cache.lineage.recordEvent(id, "COMPOSED", { status: "REJECTED", reason: "vision_rejected" });
    cache.lineage.recordEvent(id, "FINAL_VIDEO", { status: "OK" });
    const audit = cache.lineage.reconcile();
    expect([...audit.errors, ...audit.warnings].map((e) => e.code)).toContain("FINAL_AND_REJECTED");
  });

  it("the branch that refuses never reaches the accept branch", () => {
    /** `continue` is what makes C true in production: results.push is unreachable after a refusal. */
    const gate = PIPE.indexOf("!(await youtubeClipPassesImageGate(outPath");
    const block = PIPE.slice(gate, PIPE.indexOf("results.push(outPath)", gate));
    expect(block).toContain("continue;");
  });
});

/* ═══════════════ D. one ending, not two ═══════════════ */

describe("D — a refusal is not also a download failure", () => {
  it("keeps downloadFailed at zero for a clip that arrived and was then refused", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    const yt = cache.lineage.summary().byProvider["youtube_cc"]!;
    expect(yt.downloadFailed).toBe(0);
    expect(yt.rejected).toBe(1);
  });

  it("the download outcome is filed once, above the gate, on success or failure alike", () => {
    const gate = PIPE.indexOf("!(await youtubeClipPassesImageGate(outPath");
    const before = PIPE.lastIndexOf("recordProviderDownloadOutcome(", gate);
    expect(before).toBeGreaterThan(-1);
    /** No second download outcome inside the refusal branch — that would be the double count. */
    const block = PIPE.slice(gate, PIPE.indexOf("fs.unlinkSync(outPath)", gate));
    expect(block).not.toContain("recordProviderDownloadOutcome(");
  });
});

/* ═══════════════ E/F. everything else is untouched ═══════════════ */

describe("E/F — the accepted path and the other providers are unchanged", () => {
  it("a YouTube clip that passes screening keeps its open record and no rejection", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    const yt = cache.lineage.summary().byProvider["youtube_cc"]!;
    expect(yt.downloadSucceeded).toBe(1);
    expect(yt.rejected).toBe(0);
    expect(stagesFor(cache.lineage, cache.lineage.resolve(tagged)!.lineageId)).not.toContain(
      "REMOVED:REJECTED"
    );
  });

  it("the new call sits inside the YouTube refusal branch and nowhere else", () => {
    /**
     * The context string is the marker: it names the gate that produced the refusal, so a count of
     * it is a count of this one site. A second appearance would mean a second route started
     * claiming YouTube screening refusals it did not make.
     */
    expect(PIPE.split("youtube_screening`").length - 1).toBe(2);
  });

  it("does not touch any other provider's outcome writing", () => {
    const other = createSourcingCache(568);
    const tagged = tagPathWithProviderAsset("/w/s1_b2_px.mp4", "pexels", "8811", other, {
      sceneIndex: SCENE, beatIndex: BEAT, mediaType: "video",
    });
    recordProviderDownloadOutcome(other, tagged, true);
    const px = other.lineage.summary().byProvider["pexels"]!;
    expect(px.downloadSucceeded).toBe(1);
    expect(px.rejected).toBe(0);
  });
});

/* ═══════════════ G/H. same asset, visible in the report ═══════════════ */

describe("G/H — same identity, and it shows up where a reader looks", () => {
  it("files the rejection on the record the download succeeded on", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    const id = cache.lineage.resolve(tagged)!.lineageId;
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    const events = cache.lineage.allEvents();
    expect(new Set(events.map((e) => e.lineageId)).size).toBe(1);
    expect(events[events.length - 1]!.lineageId).toBe(id);
    const record = cache.lineage.resolve(tagged)!;
    expect(record.provider).toBe("youtube_cc");
    expect(record.providerAssetId).toBe(VIDEO_ID);
    expect(record.sceneIndex).toBe(SCENE);
    expect(record.beatIndex).toBe(BEAT);
  });

  it("carries the scene, the beat and the gate in the reason", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    const last = cache.lineage.allEvents().at(-1)!;
    expect(last.reason).toBe(`vision_rejected:s${SCENE}b${BEAT}:youtube_screening`);
    expect(last.status).toBe("REJECTED");
  });

  it("survives the render's own census: youtube_cc has no unexplained record left", () => {
    const { cache, tagged } = downloadedYoutubeClip();
    recordAssetOutcome(cache.lineage, tagged, "vision_rejected", `s${SCENE}b${BEAT}:youtube_screening`);
    const lines = formatProviderFunnelInvariant(
      cache.lineage.summary(), cache.lineage.allRecords(), cache.lineage.allEvents()
    );
    expect(lines.join("\n")).not.toContain("INVARIANT_BROKEN");
  });
});

/* ═══════════════ the census: no second black hole ═══════════════ */

describe("the screening refusal census", () => {
  it("has exactly one production site where a screened YouTube clip is deleted", () => {
    expect(PIPE.split("youtubeClipPassesImageGate(outPath").length - 1).toBe(1);
  });

  it("every YouTube screening refusal in production files an outcome first", () => {
    /**
     * Written as a census rather than as one assertion about one line: if a second refusal branch
     * is ever added, this fails naming it instead of quietly passing because the first one is
     * still correct.
     */
    const sites: number[] = [];
    for (let i = PIPE.indexOf("youtubeClipPassesImageGate(outPath"); i > -1; ) {
      sites.push(i);
      i = PIPE.indexOf("youtubeClipPassesImageGate(outPath", i + 1);
    }
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const unlink = PIPE.indexOf("fs.unlinkSync(outPath)", site);
      expect(unlink).toBeGreaterThan(site);
      const branch = PIPE.slice(site, unlink);
      expect(branch).toContain("recordYoutubeScreeningRefusal(");
    }
  });
});
