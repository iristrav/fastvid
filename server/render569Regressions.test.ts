/**
 * RENDER 569 — THE THREE DEFECTS ITS LOG PROVED, PINNED.
 *
 * VID-0569 "Why Adolf Hitler Chose Suicide Over Capture" ran for 1989 seconds, completed normally,
 * and was then refused by RONDE 89's export gate:
 *
 *     [Watchdog] video=569 stopped normally at 1989s
 *     Error: Render rejected — insufficient real visual coverage: 14/14 filled beat(s) …
 *       at assertVisualCoverageExportGate
 *
 * The gate was right. Every one of the fourteen beats held a colour card. These are the three
 * reasons, each measured in that log rather than reasoned about.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { adoptionGuardVerdict, adoptionPolicyFor } from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const ENV = "ENFORCE_FUNNEL_ADOPTION";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/* ═══════════════ DEFECT 1 — the rescue rungs were refused for a non-answer ═══════════════ */

describe("render 569 defect 1 — an UNCLEAR verdict emptied the film", () => {
  /**
   * 48 of the 52 blocked adoptions in that render read, verbatim:
   *
   *     [AdoptionGuard] scene=1 beat=5 route=subject_fallback eligible=false vision=UNCLEAR
   *     blocked=FUNNEL_WITHOUT_EVIDENCE reason=route "subject_fallback" claims FALLBACK_SUBJECT
   *     without vision (UNCLEAR)
   *
   * `unknown` is what the beat image gate answers when it cannot tell — its own doc says an
   * unknown "adopts the clip exactly as before". RONDE 94 turned that non-answer into a refusal
   * for every category, so the last real rung before a colour card was refused fourteen times.
   */
  const guard = (source: string, vision: "APPROVED" | "REJECTED" | "UNCLEAR" | "NOT_ASKED") => {
    delete process.env[ENV];
    return adoptionGuardVerdict({ source, eligible: false, vision });
  };

  it.each(["subject_fallback", "rescue_wikimedia", "rescue_archive", "archive_similar"])(
    "%s is no longer refused for an UNCLEAR verdict",
    (source) => {
      expect(guard(source, "UNCLEAR").allowed, "this is render 569's 48 refusals").toBe(true);
    }
  );

  it.each(["subject_fallback", "rescue_wikimedia"])(
    "%s is no longer refused for a NOT_ASKED verdict either",
    (source) => {
      expect(guard(source, "NOT_ASKED").allowed).toBe(true);
    }
  );

  /** The veto is what survives: a picture the editor LOOKED AT and refused still stays out. */
  it.each(["subject_fallback", "rescue_wikimedia", "rescue_archive"])(
    "%s is still refused a picture the editor REJECTED",
    (source) => {
      expect(guard(source, "REJECTED").allowed).toBe(false);
    }
  );

  /** And the one category that claims verification keeps the strict requirement. */
  it("REAL_FUNNEL still needs an approval, not merely the absence of a refusal", () => {
    delete process.env[ENV];
    for (const vision of ["UNCLEAR", "NOT_ASKED", "REJECTED"] as const) {
      expect(
        adoptionGuardVerdict({ source: "archive", eligible: true, vision }).allowed,
        `REAL_FUNNEL was allowed on ${vision}`
      ).toBe(false);
    }
    expect(
      adoptionGuardVerdict({ source: "archive", eligible: true, vision: "APPROVED" }).allowed
    ).toBe(true);
  });

  /** The strength follows the CLAIM, and the table says so per category. */
  it("only the category that claims verification demands an approval", () => {
    expect(adoptionPolicyFor("archive").visionRequirement).toBe("approved");
    expect(adoptionPolicyFor("archive").countsAsVerifiedVisual).toBe(true);
    for (const source of ["subject_fallback", "rescue_wikimedia", "ai"]) {
      expect(adoptionPolicyFor(source).visionRequirement).toBe("not_rejected");
      expect(adoptionPolicyFor(source).countsAsVerifiedVisual).toBe(false);
    }
    for (const source of ["rescue_extend", "fallback", "motion_graphic"]) {
      expect(adoptionPolicyFor(source).visionRequirement).toBe("none");
    }
  });
});

/* ═══════════════ DEFECT 2 — the beat searched for its longest word ═══════════════ */

describe("render 569 defect 2 — the search term was chosen by word length", () => {
  /**
   * `extractPowerWordFromSentence`'s last-resort ranked tokens by `w.length`, so the longest word
   * in the sentence became what the beat asked a footage library for. Render 569's allowed
   * queries, with their real counts:
   *
   *     "hitler" ×56  "fuhrerbunker" ×26  "bunker" ×26   ← the good ones
   *     "unmistakable" ×7  "significance" ×4  "planned" ×6  "staunch" ×9  ← the longest words
   *
   * Pexels and Pixabay answered the second group with "A woman drinking on a beach", "A hare on a
   * country path" and "A person on a BMX bike in an urban, graffiti-covered setting", and the
   * picture editor correctly refused 47 of 59 candidates.
   */
  const scorer = () => {
    const at = PIPE.indexOf("function extractPowerWordFromSentence(");
    return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
  };

  it("no longer ranks a candidate term purely by how long it is", () => {
    const body = scorer();
    expect(body).toContain("NON_PICTORIAL_WORD_FORM.test(w)");
    /** The length term survives as the tiebreak; what changed is that it is no longer alone. */
    expect(body.indexOf("NON_PICTORIAL_WORD_FORM.test(w)")).toBeLessThan(
      body.indexOf("return w.length;")
    );
  });

  /** The forms render 569 actually chose, each one pushed below every concrete word. */
  it.each(["unmistakable", "significance", "planned", "relentless", "curious", "decisive"])(
    "%j is recognised as naming a quality rather than a thing",
    (word) => {
      const src = PIPE.slice(PIPE.indexOf("const NON_PICTORIAL_WORD_FORM"));
      const re = new RegExp(src.slice(src.indexOf("/(?:"), src.indexOf("/i;") + 1).slice(1, -1), "i");
      expect(re.test(word)).toBe(true);
    }
  );

  /**
   * The words an archive CAN answer must not be caught by the same rule. `-tion`, `-sion`,
   * `-ment` and `-al` are deliberately absent from it: an invasion, an occupation, a bombardment
   * and a funeral are all things a newsreel shows.
   */
  it.each(["bunker", "invasion", "occupation", "bombardment", "funeral", "hitler", "berlin", "tank"])(
    "%j is still available as a search term",
    (word) => {
      const src = PIPE.slice(PIPE.indexOf("const NON_PICTORIAL_WORD_FORM"));
      const re = new RegExp(src.slice(src.indexOf("/(?:"), src.indexOf("/i;") + 1).slice(1, -1), "i");
      expect(re.test(word)).toBe(false);
    }
  );

  /**
   * WHERE THE RULE STOPS, said out loud.
   *
   * `-ing` is not in it, and cannot be: "bombing", "fighting", "landing" and "shelling" are among
   * the best archive queries a WWII beat can make. So an `-ing` adjective like "devastating" still
   * ranks by length, and so does a bare adjective with no suffix at all — "staunch", which render
   * 569 sent nine times. This rule removes 17 of that render's 26 useless queries, not all 26.
   *
   * Recorded as a test rather than left for the next reader to discover from a log.
   */
  it.each(["devastating", "staunch", "sudden", "grim"])(
    "%j is NOT caught — a known limit of a word-form rule",
    (word) => {
      const src = PIPE.slice(PIPE.indexOf("const NON_PICTORIAL_WORD_FORM"));
      const re = new RegExp(src.slice(src.indexOf("/(?:"), src.indexOf("/i;") + 1).slice(1, -1), "i");
      expect(re.test(word)).toBe(false);
    }
  );

  /** A general rule about English word form — it must not know what any video is about. */
  it("names no topic, person or place", () => {
    const at = PIPE.indexOf("const NON_PICTORIAL_WORD_FORM");
    const decl = PIPE.slice(at, PIPE.indexOf(";", at));
    expect(decl.toLowerCase()).not.toMatch(/hitler|berlin|bunker|war|nazi|german/);
  });
});

/* ═══════════════ DEFECT 3 — the shortlist bound was paid for and then refused ═══════════════ */

describe("render 569 defect 3 — a spent beat kept paying", () => {
  /**
   * 44 lines of `[BeatShortlist] SHORTLIST_FULL (8/8)` and `never_asked=137`. Each of those
   * candidates had already been downloaded, probed and transcoded before the bound refused it,
   * because RONDE 95 placed the check inside the vision gate — after all of that work.
   */
  it("the candidate loop stops before the first expensive call", () => {
    const at = PIPE.indexOf("async function adoptClip(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const loop = body.indexOf("for (const p of finalPaths) {");
    const stop = body.indexOf("beatShortlistExhausted(dedup.beatShortlist", loop);
    const probe = body.indexOf("isValidVideoFile(p)", loop);
    expect(loop).toBeGreaterThan(-1);
    expect(stop, "the loop never checks whether the beat has finished looking").toBeGreaterThan(loop);
    expect(probe).toBeGreaterThan(-1);
    expect(stop, "the beat is still paying for candidates it will refuse").toBeLessThan(probe);
  });

  it("it breaks out rather than skipping one candidate", () => {
    const at = PIPE.indexOf("beatShortlistExhausted(dedup.beatShortlist");
    const block = PIPE.slice(at, at + 400);
    expect(block).toContain("break;");
    expect(block).toContain("[BeatShortlist]");
    expect(block).toContain("stopped looking");
  });
});
