/**
 * VIDEO 630 (second production run on ef50e07) — two findings, one fix each.
 *
 * 1. `approvalRestsOnAGuess` read every run of capitalised words as a person. Under "As dawn broke
 *    on June 1944, the D-Day Invasion launched … across the English Channel" the picture editor
 *    approved landing craft on a beach twice, and both approvals were turned into
 *    "identity guessed, not seen" for "D-Day Invasion" and "English Channel". The render's own
 *    reading of who is a person (`personAsRead`, already used by `namedEntityRules` since video
 *    623) now decides; without a reading the capital letters decide as before.
 *
 * 2. P2 ordered a beat's list once, before the beat waited for the shared lock; candidates refused
 *    for another sentence during that wait were judged again. The order is now read again when a
 *    look is about to be spent.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  approvalRestsOnAGuess,
  createBeatImageGateState,
  MAX_JUDGEMENTS_PER_BEAT,
  maxBeatImageJudgementsPerRender,
  storedGuessAsGiven,
} from "./beatImageRelevanceGate";
import {
  maxRelevanceLooksPerBeat,
  postponeBehindFresherCandidate,
  putRefusedElsewhereLast,
} from "./beatVisualRelevance";
import { rejectionStageForReason } from "./rejectionRegistry";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");

type PersonAsRead = (name: string) => string | null | undefined;
let pipe: typeof import("./videoPipeline");
async function readingOf(people: string[] | null): Promise<PersonAsRead> {
  pipe ??= await import("./videoPipeline");
  pipe.setRenderPeopleReadingForTests(people);
  return pipe.personAsRead;
}
afterEach(() => pipe?.setRenderPeopleReadingForTests(null));

/** The 630 reading: the five people the model named in that narration. */
const PEOPLE_630 = ["Adolf Hitler", "Franklin D. Roosevelt", "Joseph Stalin", "Dwight D. Eisenhower", "Erwin Rommel"];
/** A reading of a different, non-WWII film — the rule is generic. */
const PEOPLE_COLD_WAR = ["Ronald Reagan", "Mikhail Gorbachev", "Günter Schabowski"];

const DDAY = "As dawn broke on June 6, 1944, the D-Day Invasion launched with ferocity across the English Channel.";
const LANDING_CRAFT = {
  verdict: "fits" as const,
  depicts: "Soldiers onboard a landing craft, likely approaching a beach.",
  reason: "The frames show soldiers on a landing craft likely approaching a beach, fitting the description of the D-Day invasion across the English Channel.",
};
const ALLIED_TROOPS = {
  verdict: "fits" as const,
  depicts: "Allied troops landing on a beach, possibly Normandy, during WWII.",
  reason: "The frames depict what appears to be Allied troops on a beach, under conditions likely similar to the D-Day landings at Normandy.",
};

/* ═══════════════════════════ 1. who is a person ═══════════════════════════ */

describe("entity classification — a capital letter does not make a person", () => {
  it("events, places and organisations are not people", async () => {
    for (const reading of [PEOPLE_630, PEOPLE_COLD_WAR]) {
      const isPerson = await readingOf(reading);
      for (const notAPerson of ["D-Day Invasion", "English Channel", "Normandy", "United Nations", "Battle of Berlin", "Berlin Wall", "Brandenburg Gate"]) {
        expect(isPerson(notAPerson), `${notAPerson} read as a person`).toBeNull();
      }
    }
  }, 120_000);

  it("people the reading names are people, by full name, part of it, or possessive", async () => {
    let isPerson = await readingOf(PEOPLE_630);
    expect(isPerson("Joseph Stalin")).toBe("Joseph Stalin");
    expect(isPerson("Adolf Hitler")).toBe("Adolf Hitler");
    expect(isPerson("Franklin Roosevelt")).toBe("Franklin D. Roosevelt");
    expect(isPerson("Under Dwight Eisenhower's")).toBe("Dwight D. Eisenhower");
    isPerson = await readingOf(PEOPLE_COLD_WAR);
    expect(isPerson("Ronald Reagan")).toBe("Ronald Reagan");
  });

  it("video 630 s1b4: the two landing-craft approvals are no longer refused as a guessed identity", async () => {
    const isPerson = await readingOf(PEOPLE_630);
    expect(approvalRestsOnAGuess(LANDING_CRAFT, DDAY, undefined, isPerson)).toBe(false);
    expect(approvalRestsOnAGuess(ALLIED_TROOPS, DDAY, undefined, isPerson)).toBe(false);
  });

  it("without a reading the capital letters decide, exactly as before (the old refusal is reproduced)", async () => {
    const isPerson = await readingOf(null);
    expect(isPerson("D-Day Invasion")).toBeUndefined();
    expect(approvalRestsOnAGuess(LANDING_CRAFT, DDAY, undefined, isPerson)).toBe(true);
    expect(approvalRestsOnAGuess(LANDING_CRAFT, DDAY)).toBe(true);
  });
});

describe("the protection against a guessed person stays", () => {
  const LINE = "Leaders like Franklin Roosevelt and Joseph Stalin commanded immense forces.";

  it("a hedged identification of a person the frame does not name is still refused", async () => {
    const isPerson = await readingOf(PEOPLE_630);
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "A man in a coat speaking at a podium.", reason: "The speaker appears to be Joseph Stalin addressing his forces." },
        LINE, undefined, isPerson
      )
    ).toBe(true);
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "A man speaking, likely an interview.", reason: "The subject is a person mentioned in the narration." },
        "Ronald Reagan spoke at the Brandenburg Gate.", undefined, await readingOf(PEOPLE_COLD_WAR)
      )
    ).toBe(true);
  });

  it("a person the frame plainly names stays approved", async () => {
    const isPerson = await readingOf(PEOPLE_630);
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "Joseph Stalin reviewing troops at a parade.", reason: "Stalin is likely shown commanding forces, as the line describes." },
        LINE, undefined, isPerson
      )
    ).toBe(false);
  });

  it("a person the reading names keeps the rule even in a sentence that also names a place", async () => {
    const isPerson = await readingOf(PEOPLE_COLD_WAR);
    const line = "Ronald Reagan stood before the Brandenburg Gate in West Berlin.";
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "A man in a suit at a lectern outdoors.", reason: "This is likely Ronald Reagan giving his speech." },
        line, undefined, isPerson
      )
    ).toBe(true);
  });

  it("the pipeline hands the render's reading to the gate; the rule is applied to fresh and stored verdicts", () => {
    expect(PIPE).toContain("beatImageGate: createBeatImageGateState(),");
    expect(PIPE).toContain("state.beatImageGate.personAsRead = personAsRead;");
    expect(GATE).toContain("refuseGuessedIdentity(storedGuessAsGiven(storedRaw), beatText, params.anchors?.subject, state.personAsRead)");
    expect(GATE).toContain("refuseGuessedIdentity(judgementAfterSituation, beatText, params.anchors?.subject, state.personAsRead)");
    expect(createBeatImageGateState().personAsRead, "outside a render nothing changes").toBeUndefined();
  });
});

describe("a refusal this rule stored under the old reading is judged again", () => {
  it("the stored 'identity guessed' refusal is read back as the model's approval", () => {
    const stored = { verdict: "does_not_fit" as const, depicts: LANDING_CRAFT.depicts, reason: `identity guessed, not seen: ${LANDING_CRAFT.reason}`.slice(0, 160) };
    const back = storedGuessAsGiven(stored);
    expect(back.verdict).toBe("fits");
    expect(back.reason.startsWith("The frames show soldiers")).toBe(true);
  });

  it("…and refused again when it still rests on a guessed person", async () => {
    const isPerson = await readingOf(PEOPLE_630);
    const stored = { verdict: "does_not_fit" as const, depicts: "A man at a podium.", reason: "identity guessed, not seen: The speaker appears to be Joseph Stalin." };
    expect(approvalRestsOnAGuess(storedGuessAsGiven(stored), "Joseph Stalin commanded immense forces.", undefined, isPerson)).toBe(true);
  });

  it("every other stored verdict is returned untouched — the model's own refusals stay refusals", () => {
    for (const stored of [
      { verdict: "does_not_fit" as const, depicts: "x", reason: "The frames show a telescope." },
      { verdict: "does_not_fit" as const, depicts: "x", reason: "only a logo: Twitter logo" },
      { verdict: "does_not_fit" as const, depicts: "x", reason: "situation not shown: soldiers" },
      { verdict: "fits" as const, depicts: "x", reason: "fine" },
    ]) {
      expect(storedGuessAsGiven(stored)).toBe(stored);
    }
  });
});

/* ═══════════════════ 2. P2 — the order at the moment a look is spent ═══════════════════ */

describe("P2 — a candidate refused elsewhere while the beat waited goes behind fresh ones", () => {
  it("video 630 s0b3: refused on s0b2 after the list was ordered → moved back at its turn", () => {
    /** Ordered at 14:04:12 — nothing refused yet. */
    const refused = new Set<string>();
    const queue = putRefusedElsewhereLast(["ia_flag", "ia_interview", "fresh_serp"], (p) => refused.has(p)).paths;
    expect(queue).toEqual(["ia_flag", "ia_interview", "fresh_serp"]);
    /** 14:04:15 and 14:04:21 — s0b2 refuses the two archive clips; s0b3's loop starts later. */
    refused.add("ia_flag");
    refused.add("ia_interview");
    expect(postponeBehindFresherCandidate(queue, 0, (p) => refused.has(p), new Set(), new Set())).toBe(true);
  });

  it("a fresh candidate from later in the queue comes before a refused one", () => {
    const refused = (p: string) => p.startsWith("old_");
    const queue = ["old_a", "new_b", "old_c", "new_d"];
    const visited = new Set<string>();
    const postponed = new Set<string>();
    const order: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]!;
      if (postponeBehindFresherCandidate(queue, i, refused, visited, postponed)) {
        postponed.add(p);
        queue.push(p);
        continue;
      }
      visited.add(p);
      order.push(p);
    }
    expect(order).toEqual(["new_b", "new_d", "old_a", "old_c"]);
  });

  it("a refused candidate is still looked at when nothing better is left", () => {
    const refused = () => true;
    expect(postponeBehindFresherCandidate(["old_a"], 0, refused, new Set(), new Set())).toBe(false);
    expect(postponeBehindFresherCandidate(["old_a", "old_b"], 0, refused, new Set(), new Set())).toBe(false);
    /** Postponed once, it is not postponed again — no loop. */
    expect(postponeBehindFresherCandidate(["old_a", "new_b"], 0, (p) => p === "old_a", new Set(), new Set(["old_a"]))).toBe(false);
    /** A later candidate this loop already looked at is not "fresh". */
    expect(postponeBehindFresherCandidate(["old_a", "seen_b"], 0, (p) => p === "old_a", new Set(["seen_b"]), new Set())).toBe(false);
  });

  it("wired in the loop that spends the looks, before any cost, and the queue is the same array", () => {
    const loop = PIPE.slice(PIPE.indexOf("const postponedBehindFresher = new Set<string>();"));
    const check = loop.indexOf("postponeBehindFresherCandidate(finalPaths, cursor, refusedForAnotherSentence, visitedInLoop, postponedBehindFresher)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(loop.indexOf("let fileRefusal = technicalFileRefusal(p);"));
    expect(check).toBeGreaterThan(loop.indexOf("beatShortlistExhausted(dedup.beatShortlist, sceneIndex, beatIndex)"));
    expect(loop.slice(check, check + 400)).toContain("finalPaths.push(p);");
  });

  it("the ceiling, the render budget and the technical refusals are exactly what they were", async () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
    pipe ??= await import("./videoPipeline");
    expect(pipe.refusalHoldsForEverySentence("mostly_black")).toBe(true);
    expect(pipe.refusalHoldsForEverySentence("baked_edit_text_before_vision")).toBe(true);
    expect(pipe.refusalHoldsForEverySentence("refused on s0b2: does not fit")).toBe(false);
    expect(rejectionStageForReason("refused on s0b2: does not fit")).toBe("picture");
  }, 120_000);
});
