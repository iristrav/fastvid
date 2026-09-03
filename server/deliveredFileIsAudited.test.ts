/**
 * §19 — THE SOURCE AUDIT DESCRIBES THE FILE THAT SHIPS.
 *
 * ── The claim that was about the wrong video ────────────────────────────────────────────────
 *
 * FINAL_VIDEO is the last and strictest stage in the lineage ledger. Its rule, from RONDE 87, is
 * that a clip earns it only when its scene's video is in the input list of the concat that produced
 * the validated output — "DOWNLOADED is not ADOPTED is not COMPOSED is not FINAL_VIDEO".
 *
 * The pipeline proves it at stage 6, from `finalConcatInputs`, and the comment there says why: that
 * is "the first moment FINAL_VIDEO is knowable". It was, once. Since the delivery cutover the
 * compose montage is not necessarily the file anyone receives — the cinematic render runs eight
 * hundred lines later, from its own clip list, and when it succeeds ITS output ships.
 *
 * So `[AssetUsageSummary]`'s `rendered` column, `[VisualFunnel]`'s `finalVideo` and every `unused`
 * figure derived from them described a discarded montage. A clip the cinematic renderer could not
 * recover — named in its own `skipped` list, absent from the delivered picture — was reported as
 * being in the video. It is the same defect as the post-render spot check, one column along.
 *
 * ── What the fix rests on ───────────────────────────────────────────────────────────────────
 *
 * `renderTimeline` already knew the answer and threw it away. `rendered` is index-aligned with the
 * segment list — a clip is pushed to both only once its segment exists on disk — so it IS the
 * delivered file's input list, the exact counterpart of `finalConcatInputs`. It is now returned as
 * `renderedClipIds`, carried on the render job's outcome, and used to prove the claim again.
 *
 * ── What is deliberately not claimed ────────────────────────────────────────────────────────
 *
 * A rendered clip is attributable only when this render holds the local file the timeline named.
 * Clips the render job rehydrated for itself live at paths the lineage never saw; they are counted
 * as unattributable and reported, never guessed at.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { VisualSourceLedger } from "./visualSourceLineage";

const dir = (p: string) => path.join(__dirname, p);

/* ═══════════════════════ the renderer reports its own input list ═══════════════════════ */

describe("the renderer says which clips the join consumed", () => {
  const renderer = () => fs.readFileSync(dir("timelineRenderer.ts"), "utf8");

  it("returns the clips that became segments, not the clips it was given", () => {
    const src = renderer();
    expect(src).toContain("renderedClipIds: rendered.map((r) => r.clip.id)");
  });

  /**
   * `rendered` and `segments` are pushed together, after the segment file is confirmed on disk. A
   * clip whose source could not be recovered, or whose encode threw, reaches neither — which is the
   * property that makes this a proof rather than a restatement of the plan.
   */
  it("a clip that never became a segment is not in the list", () => {
    const src = renderer();
    const at = src.indexOf("if (fs.existsSync(seg) && fs.statSync(seg).size > 1024) {");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("else skipped.push", at));
    expect(block).toContain("segments.push(seg)");
    expect(block).toContain("rendered.push(");
  });

  it("the render job hands it to the caller", () => {
    const worker = fs.readFileSync(dir("renderJobWorker.ts"), "utf8");
    expect(worker).toContain("renderedClipIds: string[];");
    expect(worker).toContain("renderedClipIds: rendered.renderedClipIds,");
  });
});

/* ═══════════════════════ a claim about the wrong file can be withdrawn ═══════════════════════ */

describe("the ledger can be told the delivered file was a different file", () => {
  const ledgerWith = (paths: string[]) => {
    const l = new VisualSourceLedger({ renderId: "r19", videoId: 1 });
    for (const p of paths) {
      const r = l.createLineage({
        videoId: 1,
        sceneIndex: 0,
        beatIndex: 0,
        candidateId: p,
        contentKey: p,
        provider: "pexels",
        providerAssetId: p,
        localPath: p,
        mediaType: "video",
        route: "primary",
      });
      l.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    }
    return l;
  };

  it("replaces the proof rather than adding to it", () => {
    const l = ledgerWith(["/a.mp4", "/b.mp4", "/c.mp4"]);
    expect(l.markFinalVideo(["/a.mp4", "/b.mp4"])).toBe(2);
    expect(l.summary().total.finalVideo).toBe(2);

    // The delivered file turned out to carry only one of them, plus one the montage never had.
    expect(l.replaceFinalVideo(["/c.mp4"])).toBe(1);
    expect(l.summary().total.finalVideo).toBe(1);
  });

  /**
   * `markFinalVideo` deliberately skips a record that already carries the stage, so calling it
   * again can only ADD. Without a withdrawal, correcting the claim was impossible — this is the
   * property that makes the fix a correction and not a second, contradictory marking.
   */
  it("a second markFinalVideo could only ever add, which is why this exists", () => {
    const l = ledgerWith(["/a.mp4", "/b.mp4"]);
    l.markFinalVideo(["/a.mp4"]);
    l.markFinalVideo(["/b.mp4"]);
    expect(l.summary().total.finalVideo).toBe(2);
  });

  /** Only the last link changes. What this render downloaded and adopted is true either way. */
  it("withdraws FINAL_VIDEO and nothing else", () => {
    const l = ledgerWith(["/a.mp4", "/b.mp4"]);
    const adoptedBefore = l.summary().total.adopted;
    l.markFinalVideo(["/a.mp4", "/b.mp4"]);
    l.replaceFinalVideo([]);
    expect(l.summary().total.adopted).toBe(adoptedBefore);
    expect(l.summary().total.finalVideo).toBe(0);
  });

  /**
   * An empty delivered set still counts as HAVING CHECKED. `NOT_VERIFIED` means the render never
   * got far enough to know; zero means it knew and the answer was none, and a report that confuses
   * the two is the reason `finalVideoWasVerified` exists at all.
   */
  it("proving nothing is still proving", () => {
    const l = ledgerWith(["/a.mp4"]);
    l.replaceFinalVideo([]);
    expect(l.finalVideoWasVerified).toBe(true);
    expect(l.summary().total.finalVideo).toBe(0);
  });

  /** The events are the record. A withdrawn stage must leave none behind. */
  it("leaves no FINAL_VIDEO event behind", () => {
    const l = ledgerWith(["/a.mp4", "/b.mp4"]);
    l.markFinalVideo(["/a.mp4", "/b.mp4"]);
    l.replaceFinalVideo(["/a.mp4"]);
    expect(l.allEvents().filter((e) => e.stage === "FINAL_VIDEO")).toHaveLength(1);
  });
});

/* ═══════════════════════ the pipeline re-proves it on the delivering route ═══════════════════════ */

describe("the pipeline proves the delivered file's contents", () => {
  const pipeline = () => fs.readFileSync(dir("videoPipeline.ts"), "utf8");

  it("re-proves from the render job's own clip list", () => {
    const src = pipeline();
    expect(src).toContain("for (const clipId of jobOutcome.renderedClipIds)");
    expect(src).toContain("ledger.replaceFinalVideo(deliveredPaths)");
  });

  /** Only on the delivering path — when compose IS the deliverable, its proof is the right one. */
  it("only when the cinematic render actually delivered", () => {
    const src = pipeline();
    const okAt = src.indexOf("cinematicDeliveredUrl = jobOutcome.outputUrl;");
    const reproveAt = src.indexOf("ledger.replaceFinalVideo(deliveredPaths)");
    const refusalAt = src.indexOf("cinematicRefusal = `${jobOutcome.code}");
    expect(reproveAt).toBeGreaterThan(okAt);
    expect(reproveAt).toBeLessThan(refusalAt);
  });

  /**
   * A clip the render job rehydrated for itself lives at a path the lineage never saw. Counting it
   * against a provider that can be proven would put invented footage on that provider's record —
   * the rule `[AssetUsageSummary]` already follows with UNVERIFIED.
   */
  it("counts what it cannot attribute instead of guessing", () => {
    const src = pipeline();
    expect(src).toContain("else unattributable++;");
    expect(src).toContain("not attributable");
  });

  /**
   * The first table is already in the log. Correcting the ledger in silence would leave two
   * contradictory tables in one render with nothing to tell them apart.
   */
  it("re-prints the corrected table, labelled", () => {
    const src = pipeline();
    expect(src).toContain('`${line} (delivered)`');
  });

  /** An accounting fault must never cost a finished video. */
  it("cannot fail the render", () => {
    const src = pipeline();
    const at = src.indexOf("ledger.replaceFinalVideo(deliveredPaths)");
    const end = src.indexOf("cinematicRefusal = `${jobOutcome.code}", at);
    const block = src.slice(at, end);
    expect(block).toContain("} catch (err) {");
    expect(block).toContain("could not re-prove FINAL_VIDEO");
    expect(block).not.toContain("throw ");
  });
});
