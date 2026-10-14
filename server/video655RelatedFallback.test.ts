/**
 * VIDEO 655 — THE LAST PICTURE BEFORE THE COLOUR FIELD.
 *
 * 655 put a 7.5 s colour field under "In 2014, Tesla's Palo Alto headquarters sparked seismic
 * shifts …" after the picture editor had refused, for that sentence, a Tesla Model S and a Tesla
 * touchscreen: pictures of the right subject that do not show the exact moment. The generic archive
 * held 0 clips, so nothing stood between "does not fit" and the colour field.
 *
 * The owner's rule (14 October): a video is always delivered, the customer replaces a doubtful shot
 * — "zolang het erbij past". So, only for a sentence that would otherwise get the colour field, its
 * own refusals that are about the right thing come back as the last resort, named for the editor.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import {
  beatRelevanceBeatKey,
  composeBarrierAllows,
  createBeatRelevanceLedger,
  depictsTheSentenceSubject,
  reprieveAsLastResort,
  sentenceSubjectWords,
  softMismatchCandidatesForBeat,
  type BeatRelevanceLedger,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { reprieveAllowedFor, type MismatchKind } from "./visualMismatchFeedback";

const S1B0 = "In 2014, Tesla's Palo Alto headquarters sparked seismic shifts across the industry.";
const ctx = (beatText = S1B0, sceneIndex = 1, beatIndex = 0): BeatVisualContext => ({ sceneIndex, beatIndex, beatText });

/** 655's real refusals for s1b0, word for word, plus one the classifier calls SOFT. */
const REFUSALS = {
  modelS: {
    depicts: "A Tesla car, likely a Model S, parked outdoors in a neutral setting.",
    reason: "The clip shows a Tesla car, but not Tesla's Palo Alto headquarters or any context related to patent opening or a seismic shift. There is no visible connection t",
  },
  touchscreen: {
    depicts: "A Tesla car's touchscreen interface showing navigation and controls.",
    reason: "The clip shows the touchscreen interface of a Tesla car, which does not directly relate to Tesla's headquarters, a seismic shift, or the opening of patents in 2",
  },
  personIndoors: {
    depicts: "A person speaking, likely inside a building with cars in the background.",
    reason: "The frames show a person talking indoors, with a car in the background. There is no visual evidence connecting them to Tesla's headquarters, the specific event",
  },
  logo: {
    depicts: "A person speaking with a Tesla logo visible in the background.",
    reason: "The frames show a person speaking with the Tesla logo visible but do not depict Tesla's Palo Alto headquarters or an event related to opening patents.",
  },
  otherCity: {
    depicts: "An office building at night.",
    reason: "A corporate office, but in a different city than the narration describes.",
  },
};

function refuse(ledger: BeatRelevanceLedger, clipPath: string, r: { depicts: string; reason: string }, c = ctx()): void {
  const entry = {
    ctx: c,
    decision: { verdict: "does_not_fit", allowed: false, reprieved: false, cached: false, depicts: r.depicts, reason: r.reason },
  } as never;
  ledger.byBeat.set(beatRelevanceBeatKey(c.sceneIndex, c.beatIndex, "path", clipPath), entry);
  ledger.byClipPath.set(clipPath, entry);
}

function ledger655(): BeatRelevanceLedger {
  const l = createBeatRelevanceLedger();
  refuse(l, "/w/modelS.mp4", REFUSALS.modelS);
  refuse(l, "/w/touch.mp4", REFUSALS.touchscreen);
  refuse(l, "/w/person.mp4", REFUSALS.personIndoors);
  refuse(l, "/w/logo.mp4", REFUSALS.logo);
  refuse(l, "/w/othercity.mp4", REFUSALS.otherCity);
  /** another sentence's refusal of the same subject is not this sentence's */
  refuse(l, "/w/elsewhere.mp4", REFUSALS.modelS, ctx("Tesla built a factory in Texas.", 2, 1));
  return l;
}

describe("1. what counts as 'about the right thing'", () => {
  it("the sentence's subject words: its names, not its sentence words", () => {
    expect(sentenceSubjectWords(ctx())).toEqual(["tesla", "palo", "alto"]);
    expect(sentenceSubjectWords({ beatText: "In the end, it worked.", anchors: { subject: "Hermann Göring" } })).toEqual(["hermann", "göring"]);
  });

  it("the editor's own description names the subject — a Tesla under a sentence about Tesla", () => {
    expect(depictsTheSentenceSubject(ctx(), REFUSALS.modelS.depicts)).toBe(true);
    expect(depictsTheSentenceSubject(ctx(), REFUSALS.touchscreen.depicts)).toBe(true);
    expect(depictsTheSentenceSubject(ctx(), REFUSALS.personIndoors.depicts)).toBe(false);
    /** a whole word, not a fragment: "Teslas" is not read into "Teslarati" */
    expect(depictsTheSentenceSubject(ctx(), "A Teslarati news studio")).toBe(false);
  });

  it("655 replayed: the Model S, the touchscreen and the other-city office come back; the rest does not", () => {
    expect(softMismatchCandidatesForBeat(ledger655(), 1, 0).sort()).toEqual(["/w/modelS.mp4", "/w/othercity.mp4", "/w/touch.mp4"]);
  });

  it("never a HARD refusal (the logo reads as text on screen), never a picture that names nothing of the sentence", () => {
    const got = softMismatchCandidatesForBeat(ledger655(), 1, 0);
    expect(got).not.toContain("/w/logo.mp4");
    expect(got).not.toContain("/w/person.mp4");
  });

  it("only this sentence's own refusals", () => {
    expect(softMismatchCandidatesForBeat(ledger655(), 1, 0)).not.toContain("/w/elsewhere.mp4");
    expect(softMismatchCandidatesForBeat(ledger655(), 2, 1)).toEqual(["/w/elsewhere.mp4"]);
  });

  it("a picture that fits is not a last resort", () => {
    const l = createBeatRelevanceLedger();
    const entry = { ctx: ctx(), decision: { verdict: "fits", allowed: true, reprieved: false, cached: false, depicts: "A Tesla car", reason: "" } } as never;
    l.byBeat.set(beatRelevanceBeatKey(1, 0, "path", "/w/fit.mp4"), entry);
    expect(softMismatchCandidatesForBeat(l, 1, 0)).toEqual([]);
  });
});

describe("2. placed on the record, so the compose barrier lets it through", () => {
  it("the last resort is reprieved for its own sentence, and the barrier allows it there", () => {
    const l = ledger655();
    expect(composeBarrierAllows(l, "/w/modelS.mp4", undefined, { sceneIndex: 1, beatIndex: 0 }).allow).toBe(false);
    expect(reprieveAsLastResort(l, "/w/modelS.mp4", 1, 0)).toBe(true);
    expect(composeBarrierAllows(l, "/w/modelS.mp4", undefined, { sceneIndex: 1, beatIndex: 0 }).allow).toBe(true);
  });

  it("a HARD refusal or a picture of nothing in the sentence is never reprieved", () => {
    const l = ledger655();
    expect(reprieveAsLastResort(l, "/w/logo.mp4", 1, 0)).toBe(false);
    expect(reprieveAsLastResort(l, "/w/person.mp4", 1, 0)).toBe(false);
    expect(composeBarrierAllows(l, "/w/logo.mp4", undefined, { sceneIndex: 1, beatIndex: 0 }).allow).toBe(false);
  });

  it("the ordinary search still never overrules the editor", () => {
    const kinds: MismatchKind[] = ["WRONG_PERIOD", "WRONG_PLACE", "WRONG_EVENT", "TALKING_HEAD", "MODERN_FOOTAGE", "WRONG_SUBJECT", "TEXT_ON_SCREEN", "TITLE_CARD", "LOW_INFORMATION", "UNRELATED", "UNCLEAR"];
    for (const k of kinds) expect(reprieveAllowedFor(k), k).toBe(false);
  });
});

describe("3. the file still has to be a usable picture", () => {
  it("the first candidate that exists, is valid, not black and not on screen yet", async () => {
    const { pickSoftMismatchFallback } = await import("./videoPipeline");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v655-"));
    const files = ["a.mp4", "b.mp4", "c.mp4"].map((f) => path.join(dir, f));
    for (const f of files) fs.writeFileSync(f, "x");
    const l = createBeatRelevanceLedger();
    refuse(l, files[0]!, REFUSALS.modelS);
    refuse(l, files[1]!, REFUSALS.touchscreen);
    refuse(l, files[2]!, REFUSALS.otherCity);
    const checks = {
      valid: async (p: string) => !p.endsWith("a.mp4"),
      durationSec: async () => 4,
      black: async (p: string) => p.endsWith("b.mp4"),
    };
    const got = await pickSoftMismatchFallback({ beatRelevance: l, usedContentKeys: new Set() }, 1, 0, checks);
    expect(got?.path).toBe(files[2]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

describe("4. wiring: after unjudged footage, before generic footage and the colour field (B); no stale text (C)", () => {
  const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const GENERIC = readFileSync(path.join(__dirname, "genericFootageFallback.ts"), "utf8");

  /**
   * FIX 1+2 (14 October) — the owner's rule: a picture the picture editor REFUSED for its sentence is
   * never placed. 655's rung (a refused picture reprieved as the last resort) no longer places
   * anything; the refusals it would have used are only named, between the checked unjudged rung and
   * the generic floor.
   */
  it("the order in placeGenericMovingFallbacks — and the refused rung places nothing", () => {
    const body = PIPE.slice(PIPE.indexOf("export async function placeGenericMovingFallbacks("));
    const unjudged = body.indexOf("const unjudged = await firstCheckedFallback(");
    const related = body.indexOf("softMismatchCandidatesForBeat(dedup.beatRelevance, scene.index, beat.index)");
    const generic = body.indexOf("genericFootageDecision(");
    expect(unjudged).toBeGreaterThan(-1);
    expect(related).toBeGreaterThan(unjudged);
    expect(generic).toBeGreaterThan(related);
    const rung = body.slice(related, generic);
    expect(rung).toContain("a refused picture is never placed");
    expect(rung).not.toMatch(/reprieveAsLastResort|target\.clips\.push|tally\.placed\+\+/);
  });

  it("the colour field's log lines no longer say it keeps the film from delivery", () => {
    expect(GENERIC).not.toContain("keeps the film from delivery");
    expect(PIPE).not.toContain("the film is not delivered with it");
    expect(PIPE).not.toContain("the delivery gate refuses a film resting on it either way");
  });
});
