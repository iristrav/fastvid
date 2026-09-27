import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * SETTING YOUTUBE_ONLY_SOURCING=true DOES NOTHING ON ITS OWN, AND SAID SO NOWHERE.
 *
 * `beatPrimaryFetch` opens with `if (curatedArchiveOnlyVisuals())` and RETURNS inside that branch
 * — curated archive, then Wikimedia, then Pexels. The `if (youtubeOnlySourcingEnabled())` that
 * follows is therefore unreachable while the curated mode is on, and the curated mode is on by
 * default (`CURATED_ARCHIVE_ONLY !== "false"`).
 *
 * So an operator who turns YouTube-only on to make a film out of YouTube gets a render that
 * behaves exactly as before, with nothing anywhere saying the setting was overruled. These tests
 * pin the structure that makes that true, and the line that now reports it.
 */

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const POLICY = readFileSync(join(__dirname, "sourcingPolicy.ts"), "utf8");

describe("the conflict is real, and these are the facts behind the warning", () => {

  it("YouTube-only is strictly opt-in", () => {
    expect(PIPE).toContain('return youtubeSourcingEnabled() && envFlagIsOn("YOUTUBE_ONLY_SOURCING");');
  });

  /**
   * RONDE 233 — YOUTUBE-FIRST WAS THE SECOND CASUALTY, AND IS NO LONGER ONE.
   *
   * The bounded YouTube-first slice — built precisely so YouTube would stop arriving at a scene
   * with no budget left — carried `&& !curatedArchiveOnlyVisuals()` and so never ran either. This
   * test used to assert that dead condition verbatim, which is how a defect ends up with a passing
   * test guarding it.
   *
   * It is fixed at the source now, and the distinction is worth stating: the two YouTube flags were
   * silenced by the same default for DIFFERENT reasons. `YOUTUBE_ONLY_SOURCING` is unreachable
   * because the curated branch above it returns — a control-flow fact this file still pins, and
   * still does not resolve. `YOUTUBE_FIRST` was switched off by an explicit clause, which was a
   * mistake: asking YouTube inside its own slice before the cascade takes nothing away from an
   * archive that is still asked first within it.
   */
  it("YouTube-FIRST is no longer switched off by the same flag", () => {
    const fn = PIPE.indexOf("async function youtubeFirstBeatSlice(");
    expect(fn, "the YouTube-first slice is gone").toBeGreaterThan(0);
    const body = PIPE.slice(fn, PIPE.indexOf("\n}\n", fn));
    expect(body, "it must not stand down for the default-on curated flag")
      .not.toContain("curatedArchiveOnlyVisuals");
    // Narrowed, not widened: the mode that skips the archive entirely still stands it down.
    expect(body).toContain("youtubeOnlySourcingEnabled()");
    expect(POLICY).toContain('return process.env.YOUTUBE_FIRST !== "false";');
  });

  /**
   * RONDE 234 — AND THE CURATED BRANCH BELOW NOW ASKS IT.
   *
   * The branch this file exists to describe still returns from every exit, and this file still
   * does not resolve that. What changed is that it no longer takes YouTube down with it: the
   * branch asks for its bounded slice before the archive lookup, so "YouTube first, then the
   * archive" holds on this route too. `YOUTUBE_ONLY_SOURCING` remains unreachable from here, for
   * the control-flow reason pinned above — that is a different question, still open.
   */
  it("and the curated branch asks for its slice before the archive", () => {
    const at = PIPE.indexOf("async function beatPrimaryFetchInner(");
    const curatedAt = PIPE.indexOf("if (curatedArchiveOnlyVisuals()) {", at);
    const sliceAt = PIPE.indexOf("youtubeFirstBeatSlice(", curatedAt);
    const archiveAt = PIPE.indexOf("fetchCuratedArchiveBeatClipWithLineage(", curatedAt);
    const youtubeOnlyAt = PIPE.indexOf("if (youtubeOnlySourcingEnabled()) {", at);
    expect(sliceAt, "the slice is asked inside the curated branch").toBeGreaterThan(curatedAt);
    expect(sliceAt, "inside it, not after it").toBeLessThan(youtubeOnlyAt);
    expect(archiveAt, "and before the archive, not after").toBeGreaterThan(sliceAt);
  });
});
