/**
 * THE SAME SEAM, A SECOND TIME — AND WHAT IT COST.
 *
 * ── Fixed once, in the morning ──────────────────────────────────────────────────────────────
 *
 * `pushClip` APPENDS, so a beat can hold real footage AND a colour card. "The last entry per beat
 * wins" then keeps the card and discards the footage. `summarizeAdoptAudit` was fixed for exactly
 * that, and the export gate stopped reporting a film of fourteen colour cards.
 *
 * ── And it was still there, in the other summariser ─────────────────────────────────────────
 *
 * `buildBeatVisualStatuses` kept the same rule, with a comment saying so: "Later entries for the
 * same beat win, matching the assumption clipAdoptAudit already makes." That assumption had just
 * been disproved. This is the function RONDE 89's export gate reads, and the next production
 * render was refused by it:
 *
 *     NO_VERIFIED_OWN_VISUAL: 0 of 16 beat(s) got an approved picture of their own
 *     (never_asked=15, own_footage=3)
 *
 * Fifteen of sixteen beats reported "no_picture_to_judge:placeholder" while their real clips sat
 * one entry earlier in the same audit. A beat cannot earn a verified visual for a picture the
 * bookkeeping threw away.
 *
 * ── So the rule has one home now ────────────────────────────────────────────────────────────
 *
 * `representativeAdoptEntryPerBeat`. These tests hold that both callers ask it, rather than each
 * carrying a copy that can drift — which is the actual defect, twice over.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  isFillerAdoptSource,
  representativeAdoptEntryPerBeat,
  summarizeAdoptAudit,
  type ClipAdoptEntry,
} from "./clipAdoptAudit";
import { buildBeatVisualStatuses, tallyBeatVisualStatuses } from "./beatVisualStatus";

const entry = (
  sceneIndex: number,
  beatIndex: number,
  source: string,
  basename = `${source}_s${sceneIndex}b${beatIndex}.mp4`
): ClipAdoptEntry => ({
  sceneIndex,
  beatIndex,
  beatText: `s${sceneIndex}b${beatIndex}`,
  basename,
  source,
});

describe("which entry speaks for a beat", () => {
  it("a real adoption is not displaced by a card recorded after it", () => {
    const { entries } = representativeAdoptEntryPerBeat([
      entry(0, 0, "archive"),
      entry(0, 0, "fallback"),
    ]);
    expect(entries.get("0:0")?.source).toBe("archive");
  });

  it("and the answer does not depend on the order they arrived in", () => {
    const { entries } = representativeAdoptEntryPerBeat([
      entry(0, 0, "fallback"),
      entry(0, 0, "archive"),
    ]);
    expect(entries.get("0:0")?.source).toBe("archive");
  });

  it("a beat that only ever got a card is represented by the card", () => {
    const { entries } = representativeAdoptEntryPerBeat([entry(0, 0, "fallback")]);
    expect(entries.get("0:0")?.source).toBe("fallback");
  });

  it("among real adoptions the newest still wins", () => {
    const { entries } = representativeAdoptEntryPerBeat([
      entry(0, 0, "pexels"),
      entry(0, 0, "archive"),
    ]);
    expect(entries.get("0:0")?.source).toBe("archive");
  });

  it.each(["fallback", "rescue_placeholder"])("%j is the filler vocabulary", (source) => {
    expect(isFillerAdoptSource(source)).toBe(true);
  });

  it.each(["archive", "wikimedia", "serpapi", "youtube_cc", "rescue_wikimedia"])(
    "%j is not",
    (source) => {
      expect(isFillerAdoptSource(source)).toBe(false);
    }
  );

  it.each([999, 1001, 2000, 2007, 8888, 9999])("sentinel beat %i is excluded", (beatIndex) => {
    const { entries } = representativeAdoptEntryPerBeat([
      entry(0, 0, "archive"),
      entry(0, beatIndex, "fallback"),
    ]);
    expect([...entries.keys()]).toEqual(["0:0"]);
  });
});

describe("the render that was refused, replayed", () => {
  /**
   * Sixteen beats as the production log described them: three whose last entry was real, thirteen
   * that also carried a card. Every one of the thirteen reported "placeholder" before this fix.
   */
  const RENDER = [
    ...[0, 1, 2].map((i) => [entry(0, i, "archive")]),
    ...[3, 4, 5].map((i) => [entry(0, i, "archive"), entry(0, i, "fallback")]),
    ...[0, 1, 2, 3, 4].map((i) => [entry(1, i, "wikimedia"), entry(1, i, "rescue_placeholder")]),
    ...[0, 1, 2, 3, 4].map((i) => [entry(2, i, "fallback")]),
  ].flat();

  it("beats holding real footage are no longer read as placeholders", () => {
    const statuses = buildBeatVisualStatuses(RENDER, undefined);
    const ownFootage = statuses.filter((s) => s.coverage === "own_footage").length;
    expect(statuses).toHaveLength(16);
    expect(ownFootage, "three of sixteen was the reported number").toBe(11);
  });

  /**
   * WHAT THIS DOES NOT DO, and the production message is the reason to say it plainly.
   *
   * `verifiedOwnVisual` is own_footage AND verified_fit. This fix restores the first half only.
   * With no ledger — nothing judged — every beat is still `never_asked`, and RONDE 89's gate still
   * refuses. Real footage becoming visible to the gate is a precondition for an approval, not an
   * approval.
   */
  it("but an unjudged picture is still not a verified one", () => {
    const tally = tallyBeatVisualStatuses(buildBeatVisualStatuses(RENDER, undefined));
    expect(tally.verifiedOwnVisual).toBe(0);
    expect(tally.byVerification.never_asked).toBe(16);
  });

  /**
   * And the reason each beat gives is now the honest one. "no_picture_to_judge:placeholder" says
   * the gate was right not to look; "real_footage_never_judged" says a picture went unexamined.
   * Thirteen beats were giving the first answer about the second situation.
   */
  it("names the gap instead of excusing it", () => {
    const statuses = buildBeatVisualStatuses(RENDER, undefined);
    const real = statuses.filter((s) => s.coverage === "own_footage");
    expect(real.every((s) => s.reason === "real_footage_never_judged")).toBe(true);
  });
});

describe("both summarisers ask the same function", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

  it.each(["beatVisualStatus.ts", "clipAdoptAudit.ts"])("%s uses the shared rule", (file) => {
    expect(read(file)).toContain("representativeAdoptEntryPerBeat");
  });

  /** Neither may keep a private copy — that duplication is what cost two renders. */
  it("neither reimplements last-entry-wins", () => {
    const status = read("beatVisualStatus.ts");
    const at = status.indexOf("export function buildBeatVisualStatuses");
    const body = status.slice(at, status.indexOf("\n}\n", at));
    expect(body).not.toContain("byBeat.set(");
  });

  /** And the two agree on the same audit, which is the property that actually matters. */
  it("agree about which beats held real footage", () => {
    const audit = [entry(0, 0, "archive"), entry(0, 0, "fallback"), entry(0, 1, "fallback")];
    const summary = summarizeAdoptAudit(audit);
    const statuses = buildBeatVisualStatuses(audit, undefined);
    expect(summary.archiveBeats).toBe(1);
    expect(summary.fallbackBeats).toBe(1);
    expect(statuses.filter((s) => s.coverage === "own_footage")).toHaveLength(1);
    expect(statuses.filter((s) => s.coverage === "placeholder")).toHaveLength(1);
  });
});
