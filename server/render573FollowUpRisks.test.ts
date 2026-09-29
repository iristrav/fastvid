/**
 * THE FIVE THINGS THE PREVIOUS ROUND'S OWN FIXES COULD BREAK.
 *
 * Found by reading the three commits back against the code they touched, rather than by waiting
 * for a render to show them. Each one is a consequence of a repair, not of the original defect.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { createSourcingCache, withRenderSourcingCacheScope } from "./videoPipeline";
import { recordClipAdopt, bindLineageLedger, bindContentKeyResolver } from "./clipAdoptAudit";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("the archive segment fetch uses a container that holds what the filter accepts", () => {
  it("matroska, not mp4 — the item filter admits Ogg Video and WebM", () => {
    /**
     * Measured with the ffmpeg on this machine, not assumed:
     *
     *     t.ogv  -> mp4 FAIL   t.ogv  -> matroska OK
     *     t.webm -> mp4 FAIL   t.webm -> matroska OK
     *     t.mp4  -> mp4 OK     t.mp4  -> matroska OK
     *
     * `-f mp4` would have fixed h.264 and left the other two failing for the same reason as
     * before, with only a better message.
     */
    const at = PIPE.indexOf("async function fetchArchiveSegmentViaFfmpeg");
    const body = PIPE.slice(at, at + 3_500);
    expect(body).toContain('"-f", "matroska",');
    expect(body).not.toContain('"-f", "mp4",');
    /** An MP4-only flag has no business on a matroska mux. */
    expect(body).not.toContain('"-movflags"');
  });

  it("the accepted format list is the one this container has to cover", () => {
    expect(PIPE).toContain("['h.264', 'MPEG4', 'MP4', 'Ogg Video', 'WebM'].includes(f.format)");
  });
});

describe("an empty query falls through instead of being sent", () => {
  it("the SerpAPI still route uses || so \"\" steps aside", () => {
    /**
     * `simplifyStockSearchWord` now returns "" where it returned the literal "documentary".
     * `??` only steps aside for null and undefined, so an empty entry would have gone out as an
     * empty search.
     */
    const at = PIPE.indexOf("buildPersonSerpQuery(personName, sceneIndex, beat.index, beat.text)");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 300);
    expect(region).toContain("unique[qi] || beat.searchQuery || beat.text.slice(0, 60)");
    expect(region).not.toContain("unique[qi] ?? beat.searchQuery");
  });

  /** The Openverse route that also used it was removed in VIDEO 619; the `??` form stays gone. */
  it("no route falls back with ?? any more", () => {
    expect(PIPE).not.toContain("(unique[0] ?? beat.searchQuery)");
  });
});

describe("a beat with no searchable subject says so before the ladder moves on", () => {

  it("the ladder's contract is unchanged — false still means this route found nothing", () => {
    const at = PIPE.indexOf("if (queries.length === 0) {");
    const region = PIPE.slice(at, at + 1_400);
    /** No throw, no early return of a fabricated clip. */
    expect(region).not.toContain("throw ");
  });
});

describe("the note about resolving by content key says what is actually true", () => {
  const ADOPT = fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");

  it("both resolvers really are the same function", () => {
    expect(PIPE).toContain("cache.lineage.setContentKeyResolver(clipContentKey);");
    expect(PIPE).toContain("bindContentKeyResolver(state.clipAdoptAudit, clipContentKey);");
  });
});
