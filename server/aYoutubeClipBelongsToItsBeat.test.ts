import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * A CLIP FETCHED FOR A BEAT IS FILED UNDER THAT BEAT.
 *
 * ── What render 579 measured ────────────────────────────────────────────────────────────────
 *
 * All thirty-two YouTube lineage records were opened with `beat=-1`:
 *
 *     [YouTubeTrace] assets=32 delivered=0 refused=20 openEnded=12
 *     [VisualFunnel] youtube_cc retrieved=3250 downloadStarted=32 downloadSucceeded=17
 *                               eligible=0 ranked=0 adopted=0 composed=0 finalVideo=0
 *
 * And every trace block held the same four lines and no others:
 *
 *     FOUND               OK
 *     DOWNLOAD_STARTED    OK
 *     DOWNLOAD_FAILED     FAILED   reason=download_timeout
 *     DOWNLOAD_SUCCEEDED  OK
 *
 * No ELIGIBLE, no VISION, no ADOPTED — for any of the thirty-two. Eligibility, the shortlist, the
 * vision verdict and adoption are all keyed BY BEAT, so a record filed under `beat=-1` has no
 * funnel to enter. Seventeen clips were fetched successfully and every one of them had nowhere to
 * go. That, not the download, is why no YouTube footage reaches the film.
 *
 * ── Why it was one line ─────────────────────────────────────────────────────────────────────
 *
 * The beat was never missing. Both research-round callers fill
 * `ScriptGuidedBeatContext.beatIndex` with `beat.index`; it travels into `fetchYouTubeCCClips` as
 * `scriptGuided`, and the one call that opens the lineage record did not read it. The same shape
 * as `recordClipAdopt` at one call site of five (RONDE 53), the beat audit at one (RONDE 70), and
 * `metadata.publishedAt` written as null while the ranking engine read it (this week): a value
 * computed, carried the whole way, and dropped by the single reader that needed it.
 */

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
/** Comments stripped: this file's own prose quotes the shapes it is about. */
const code = PIPE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the YouTube fetch files its clip under the beat it was fetched for", () => {
  it("THE TAG CALL READS THE BEAT FROM THE CONTEXT IT WAS GIVEN", () => {
    expect(
      code,
      "the lineage record is opened without the beat again — every clip will be filed under -1"
    ).toContain("...(scriptGuided?.beatIndex != null ? { beatIndex: scriptGuided.beatIndex } : {})");
  });

  it("and carries the beat's own sentence with it", () => {
    /**
     * `beatText` is what makes a trace block readable: "this clip was fetched for THIS line of
     * narration". The ledger has had the field all along.
     */
    expect(code).toContain("...(scriptGuided?.beatText ? { beatText: scriptGuided.beatText } : {})");
  });

  it("the scene was always passed and still is", () => {
    /**
     * Asserted because the fix must not trade one identity for another: render 579's records had
     * the right scene and the wrong beat, and a change that fixed the beat by dropping the scene
     * would read as success in the trace and be a different bug.
     */
    const tag = code.slice(code.indexOf('searchRoute: "fetchYouTubeCCClips"') - 900);
    expect(tag.slice(0, 900)).toContain("sceneIndex");
  });

  it("MINUS ONE SURVIVES FOR A CALLER THAT GENUINELY HAS NO BEAT", () => {
    /**
     * The hero fetch and the scene-level ladders have no beat, and inventing one for them would be
     * worse than -1: it would attach a clip to a sentence nobody chose it for. The default in
     * `tagPathWithProviderAsset` is therefore untouched, and the spread above adds the field only
     * when the caller actually has it.
     */
    expect(code).toContain("beatIndex: meta?.beatIndex ?? -1");
    expect(code).toContain("sceneIndex: meta?.sceneIndex ?? -1");
  });

  it("and both research-round callers still fill the context they are read from", () => {
    /**
     * The other half of the chain. If a caller stopped setting `beatIndex`, the spread above would
     * silently go back to filing -1 — and the trace would look exactly as it did in render 579.
     */
    expect(code.split("beatIndex: beat.index").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("nothing about the download was changed to achieve this", () => {
  it("the timeout is untouched — the clips that arrived late still arrive late", () => {
    /**
     * Render 579's twenty-three failures were all `download_timeout`, and five clips filed
     * DOWNLOAD_SUCCEEDED *after* their own timeout. That is a real and separate defect. Raising a
     * timeout in the same change that fixes the beat binding would make it impossible to tell which
     * of the two produced any improvement — and "raise the budget" is the forbidden first answer.
     */
    expect(code).not.toContain("download_timeout_raised");
    expect(code).toContain("AbortSignal.timeout");
  });

  it("and no gate, cap or threshold moved", () => {
    expect(code).toContain("const maxTasks = archivalFirst");
    expect(code).toContain("? (perf.fastStockMode ? 14 : 18)");
  });
});
