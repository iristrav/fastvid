/**
 * At most two AI-generated tags may be added to an archive clip per tagging pass.
 *
 * ── What it changes ──────────────────────────────────────────────────────────────────────────
 *
 * The vision pass proposes up to four tags (`selectHighQualityArchiveTags`) and every one of them
 * used to be merged into the clip. The archive is SEARCHED on these tags, so a clip carrying four
 * machine guesses is easier to surface for the wrong beat than a clip carrying two.
 *
 * ── Where the limit sits, and why there ──────────────────────────────────────────────────────
 *
 * In `applySharedAiToClipFields`, which is the single point both vision routes pass through: the
 * bulk "AI titles + 4 tags" button (archiveBulkVisionTagging) and the per-upload tagging
 * (generateArchiveAssetAiMetadata). A limit applied at one call site is a limit the other one —
 * or a third added later — can forget.
 *
 * ── What the limit counts ────────────────────────────────────────────────────────────────────
 *
 * NEW tags, not proposed ones. An AI tag the clip already carries costs nothing to re-state and is
 * not an addition; letting it consume a slot would mean a second pass over the same clip adds
 * nothing, which reads as a bug rather than a rule.
 *
 * And it caps what a pass ADDS, never what a clip may hold. Tags a person put on a clip are never
 * dropped to make room.
 */
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_MAX_TAGS,
  MAX_AI_TAGS_ADDED_PER_CLIP,
  applySharedAiToClipFields,
  mergeArchiveTags,
  mergeArchiveTagsLimited,
  type ArchiveAssetAiMetadata,
} from "./archiveAssetTagging";

const ai = (tags: string[]): ArchiveAssetAiMetadata => ({
  title: "Churchill at Tehran",
  description: "Three leaders seated on a portico in 1943.",
  tags,
});

const fields = (userTags: string[], aiTags: string[]) =>
  applySharedAiToClipFields({
    baseTitle: "clip",
    userTags,
    sourceNote: null,
    ai: ai(aiTags),
    userProvidedTitle: false,
  });

describe("the AI tagging pass adds at most two tags", () => {
  it("the limit is two", () => {
    expect(MAX_AI_TAGS_ADDED_PER_CLIP).toBe(2);
  });

  it("a clip with no tags gains two of the four proposed, best first", () => {
    // The vision pass ranks its own output, so "first two" is "best two".
    expect(fields([], ["tehran conference", "churchill", "stalin", "1943"]).tags)
      .toEqual(["tehran conference", "churchill"]);
  });

  it("a clip with existing tags keeps every one of them", () => {
    const out = fields(["bundesarchiv", "newsreel"], ["tehran conference", "churchill", "stalin"]);
    expect(out.tags).toContain("bundesarchiv");
    expect(out.tags).toContain("newsreel");
    expect(out.tags).toHaveLength(4);
  });

  it("a re-stated tag does not use up a slot", () => {
    /**
     * The clip already carries "churchill". The pass proposes it again plus two others; re-stating
     * costs nothing and must not count as an addition, or a second pass over the same clip would
     * add nothing at all.
     */
    const out = fields(["churchill"], ["churchill", "tehran conference", "stalin"]);
    expect(out.tags).toEqual(["churchill", "tehran conference", "stalin"]);
  });

  it("a second pass adds two more, so a clip can still reach four", () => {
    // Which is what the bulk button's own skip threshold (>= 4 tags) is written against.
    const first = fields([], ["a", "b", "c", "d"]).tags;
    expect(first).toHaveLength(2);
    const second = fields(first, ["a", "b", "c", "d"]).tags;
    expect(second).toEqual(["a", "b", "c", "d"]);
    // And a third pass adds nothing, because nothing is new.
    expect(fields(second, ["a", "b", "c", "d"]).tags).toEqual(second);
  });

  it("fewer proposals than the limit is not padded", () => {
    expect(fields(["old"], ["only-one"]).tags).toEqual(["old", "only-one"]);
    expect(fields(["old"], []).tags).toEqual(["old"]);
  });

  it("duplicates, casing and blanks are still normalised away", () => {
    // The limit runs on normalised tags, so "Churchill" and "churchill" are one tag, not two.
    expect(fields([], ["Churchill", "churchill", " CHURCHILL ", "Stalin"]).tags)
      .toEqual(["churchill", "stalin"]);
  });
});

describe("mergeArchiveTagsLimited on its own", () => {
  it("adds at most `max` new tags", () => {
    expect(mergeArchiveTagsLimited(["a"], ["b", "c", "d"], 2)).toEqual(["a", "b", "c"]);
    expect(mergeArchiveTagsLimited(["a"], ["b", "c", "d"], 1)).toEqual(["a", "b"]);
  });

  it("max 0 adds nothing and still keeps what was there", () => {
    expect(mergeArchiveTagsLimited(["a", "b"], ["c", "d"], 0)).toEqual(["a", "b"]);
  });

  it("never drops an existing tag, however many are proposed", () => {
    const existing = Array.from({ length: 9 }, (_, i) => `user-${i}`);
    const out = mergeArchiveTagsLimited(existing, ["x", "y", "z"]);
    for (const tag of existing) expect(out).toContain(tag);
    expect(out).toHaveLength(existing.length + MAX_AI_TAGS_ADDED_PER_CLIP);
  });

  it("the unlimited merge is still available and still unlimited", () => {
    // Kept for callers that are not the AI pass — the limit is about machine-generated tags.
    expect(mergeArchiveTags(["a"], ["b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("both vision routes go through the one limit", () => {
  it("the replace path is capped too, so it cannot become the way around it", () => {
    /**
     * `replaceTags` has no caller today. Leaving it uncapped would make it the obvious shortcut
     * for the next route that wants "just set the AI tags" — which is exactly how a rule applied
     * at one call site stops holding.
     */
    const out = applySharedAiToClipFields({
      baseTitle: "clip",
      userTags: ["kept"],
      sourceNote: null,
      ai: ai(["a", "b", "c", "d"]),
      userProvidedTitle: false,
      replaceTags: true,
    });
    expect(out.tags).toHaveLength(MAX_AI_TAGS_ADDED_PER_CLIP);
    expect(MAX_AI_TAGS_ADDED_PER_CLIP).toBeLessThanOrEqual(ARCHIVE_MAX_TAGS);
  });

  it("the title and the source note are untouched by this change", () => {
    const out = fields(["kept"], ["a", "b", "c"]);
    expect(out.title).toBe("Churchill at Tehran");
    expect(out.sourceNote).toBeTruthy();
  });
});
