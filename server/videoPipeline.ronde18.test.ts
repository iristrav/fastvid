import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  extractPersonSurnameAnchor,
  extractPrimaryPersonFromText,
  resolvePersonFromSurnameAnchor,
} from "./videoPipeline";

// RONDE 18 — "De beelden kloppen totaal niet." Two root causes render 524 (a Hitler/WW2 doc)
// exposed:
//
// 18A (source routing): enabling YouTube sourcing (ENABLE_YOUTUBE_SOURCING=true, needed for
//     YouTube CC) silently forced the WHOLE pipeline into "YouTube-only → Pexels" mode, because
//     youtubeOnlySourcingEnabled() defaulted ON (YOUTUBE_ONLY_SOURCING !== "false"). YouTube then
//     returned nothing (RapidAPI 403 + official 429), so 9 of 15 beats fell to modern Pexels stock
//     — impossible to be right for a 1940s subject. Fix: strictly opt-in (=== "true"), so YouTube
//     is ONE source in the cascade and archival footage stays primary. Verified by source scan.
//
// 18B (person lock): the beat locked on the fabricated two-word "name" "Hitler Chose" because the
//     decision verb "chose" was not in TITLE_NON_NAME_WORDS. The lock therefore searched for the
//     phrase "Hitler Chose" instead of resolving the surname anchor "Hitler" against the script's
//     real "Adolf Hitler". Fix: add the title-glue decision verbs (chose/chosen/chooses/decided/
//     planned/wanted/tried/refused/ordered) so they can never be name tokens.

const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 18A — YouTube-only sourcing is strictly opt-in", () => {
  it("youtubeOnlySourcingEnabled requires YOUTUBE_ONLY_SOURCING === 'true' (default OFF)", () => {
    const fn = src.match(/function youtubeOnlySourcingEnabled\(\)[^}]*}/)?.[0] ?? "";
    expect(fn).toContain('process.env.YOUTUBE_ONLY_SOURCING === "true"');
    // The old trap — defaulting ON via `!== "false"` — must be gone.
    expect(fn).not.toContain('!== "false"');
  });
});

describe("RONDE 18B — decision verbs never fabricate a person name", () => {
  it('does not lock "Hitler Chose" as a full person name', () => {
    // Before the fix this returned the fabricated two-word name "Hitler Chose".
    expect(extractPrimaryPersonFromText("Hitler Chose Death")).toBe("");
    expect(extractPrimaryPersonFromText("Why Napoleon Planned The Invasion")).toBe("");
  });

  it("still yields the single-token surname anchor for the real name to resolve against", () => {
    expect(extractPersonSurnameAnchor("Hitler Chose Death").toLowerCase()).toBe("hitler");
    // The anchor resolves against the script's real full name.
    expect(
      resolvePersonFromSurnameAnchor("Hitler", ["Adolf Hitler", "Winston Churchill"]),
    ).toBe("Adolf Hitler");
  });

  it("does not break a genuine two-word person name", () => {
    // Regression guard: real names must still survive.
    expect(extractPrimaryPersonFromText("Rumors about Kylie Jenner")).toBe("Kylie Jenner");
  });

  it("covers the full decision-verb set added in RONDE 18", () => {
    for (const verb of ["Chose", "Chosen", "Chooses", "Decided", "Planned", "Wanted", "Tried", "Refused", "Ordered"]) {
      // "Stalin <verb>" must not survive as a two-word name — only the "Stalin" anchor remains.
      expect(extractPrimaryPersonFromText(`Stalin ${verb} It`)).toBe("");
    }
  });
});
