/**
 * RONDE 649 — WHY RENDER 606 KEPT 3 OF 21 DOWNLOADED YOUTUBE VIDEOS, AND THE THREE ANSWERS.
 *
 *   A  a line about something no camera can film (a rumour, an investigation, a record) may show
 *      the world it is about — its person or its places, in its period. The period alone still
 *      is not enough.
 *   B  a YouTube result whose title says it is a parody, a reaction, an audiobook… is not
 *      downloaded, and every query asks for footage rather than for the subject alone.
 *   C  a picture a beat already refused is not offered to that beat again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { BEAT_JUDGE_RULES, buildBeatImagePrompt } from "./beatImageRelevanceGate";
import {
  beatAlreadyRefusedPicture,
  beatIdentityKey,
  beatRelevanceBeatKey,
  createBeatRelevanceLedger,
  type BeatRelevanceEntry,
} from "./beatVisualRelevance";
import { askForFootage, youtubeTitleIsNotFootage } from "./youtubeNonFootage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ A — lines no camera can film ═══════════════════════ */

describe("A — the judge may show the world an unfilmable line is about", () => {
  const prompt = buildBeatImagePrompt(
    "The investigation Hugh Trevor-Roper led left little room for doubt.",
    3,
    "What Really Happened to Hitler?",
    undefined,
    { subject: "Adolf Hitler", documentaryPeriod: "1945", documentaryPlaces: ["Berlin"] }
  );

  it("names the case and bounds it to the person or the documentary's own places", () => {
    expect(prompt).toContain("the line is about something no camera can film");
    expect(prompt).toContain("person this shot is meant to show, or one of the places this documentary is about");
    expect(prompt).toContain("This shot is meant to show: Adolf Hitler");
    expect(prompt).toContain("Places this documentary is about: Berlin");
  });

  it("render 563's rule stands: the era alone decides nothing", () => {
    expect(prompt).toContain("The era on its own is never enough.");
    expect(prompt).toContain("It DOES NOT belong when the frame is plainly about something else");
    expect(prompt).toContain("modern footage");
  });

  it("verdicts given under the old rules are not reused under the new ones", () => {
    const REL = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");
    const body = REL.slice(REL.indexOf("export function beatIdentityKey("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("parts.push(BEAT_JUDGE_RULES);");
    expect(BEAT_JUDGE_RULES).toMatch(/^r649/);
    // Still one key per narration, and still empty when there is no narration to judge against.
    const ctx = { sceneIndex: 0, beatIndex: 0, beatText: "A line.", sceneText: "A scene.", videoTitle: "T" };
    expect(beatIdentityKey(ctx)).toBe(beatIdentityKey({ ...ctx, sceneIndex: 4 }));
    expect(beatIdentityKey({ ...ctx, beatText: "" })).toBe("");
  });
});

/* ═══════════════════════ B — the search ═══════════════════════ */

describe("B — what render 606 downloaded, refused before a byte moves", () => {
  it.each([
    ["Hitler Reacts to The Last Guardian Being 'Cancelled'", "reaction"],
    ["Hitler is informed Jane Withers has died", "parody"],
    ["Last Days of Hitler, 7th Edition Audiobook by Hugh Trevor-Roper", "audiobook"],
    ["Downfall parody: the bunker scene", "parody"],
    ["WW2 memes compilation", "meme"],
    ["History podcast #12: Berlin 1945", "podcast"],
  ])("%s → %s", (title, genre) => {
    expect(youtubeTitleIsNotFootage(title)).toBe(genre);
  });

  it.each([
    "Sensationelle Filmaufnahmen von Berlin nach der Kapitulation",
    "Battle for Berlin WW2 Footage",
    "Russians Enter Berlin: Final Months of World War II (1945)",
    "The Last Days of Hitler by Hugh Trevor-Roper (1947)",
    "How the world found out about the bunker",
  ])("real footage and ordinary documentary titles pass: %s", (title) => {
    expect(youtubeTitleIsNotFootage(title)).toBeNull();
  });

  it("a subject-only query asks for footage; a query that already does is left alone", () => {
    expect(askForFootage("hitler Rumors")).toBe("hitler Rumors archival footage");
    expect(askForFootage("Berlin 1945 newsreel")).toBe("Berlin 1945 newsreel");
    expect(askForFootage("hitler documentary footage")).toBe("hitler documentary footage");
    expect(askForFootage("  ")).toBe("");
  });

  it("the filter sits in the one search every YouTube route uses, render and background alike", () => {
    const fn = PIPE.slice(PIPE.indexOf("export async function searchYoutubeVideoCandidates("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("const genre = youtubeTitleIsNotFootage(item.snippet?.title);");
    const PREFETCH = readFileSync(join(__dirname, "youtubePrefetch.ts"), "utf8");
    expect(PREFETCH).toContain("pipeline.searchYoutubeVideoCandidates(");
  });

  it("every beat query asks for footage", () => {
    const fn = PIPE.slice(PIPE.indexOf("function buildBeatYoutubeQueries("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("askForFootage(toQueryString(q))");
  });
});

/* ═══════════════════════ C — not offered again ═══════════════════════ */

function entry(verdict: "fits" | "does_not_fit" | "unknown", extra: Partial<BeatRelevanceEntry["decision"]> = {}): BeatRelevanceEntry {
  return {
    ctx: { sceneIndex: 0, beatIndex: 0, beatText: "Hitler escaped to Argentina, some claimed." },
    decision: {
      verdict,
      allowed: verdict !== "does_not_fit",
      reprieved: false,
      cached: false,
      depicts: "A Nazi official",
      reason: "a specific person, likely a Nazi figure, not Hitler",
      evaluated: true,
      ...extra,
    } as BeatRelevanceEntry["decision"],
  };
}

describe("C — a beat's own no is remembered, and only by that beat", () => {
  const KEY = "curated:asset:57840";

  it("render 606's asset 57840 at s0b0: refused once, not offered again", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set(beatRelevanceBeatKey(0, 0, "content", KEY), entry("does_not_fit"));
    expect(beatAlreadyRefusedPicture(ledger, 0, 0, { contentKey: KEY })).toContain("not Hitler");
  });

  it("the same picture is still offered to every other sentence", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set(beatRelevanceBeatKey(0, 0, "content", KEY), entry("does_not_fit"));
    expect(beatAlreadyRefusedPicture(ledger, 0, 1, { contentKey: KEY })).toBeNull();
    expect(beatAlreadyRefusedPicture(ledger, 1, 0, { contentKey: KEY })).toBeNull();
  });

  it("nobody looking, a yes, or a deliberate reprieve is not a no", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set(beatRelevanceBeatKey(0, 0, "content", "a"), entry("does_not_fit", { evaluated: false }));
    ledger.byBeat.set(beatRelevanceBeatKey(0, 0, "content", "b"), entry("fits"));
    ledger.byBeat.set(beatRelevanceBeatKey(0, 0, "content", "c"), entry("does_not_fit", { reprieved: true }));
    for (const k of ["a", "b", "c"]) expect(beatAlreadyRefusedPicture(ledger, 0, 0, { contentKey: k })).toBeNull();
  });

  it("a file refused under its path is recognised by its path", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set(beatRelevanceBeatKey(2, 1, "path", "/w/extend_s2b1.mp4"), entry("does_not_fit"));
    expect(beatAlreadyRefusedPicture(ledger, 2, 1, { clipPath: "/w/extend_s2b1.mp4" })).not.toBeNull();
  });

  it("asked where every route passes and where the archive picks, before anything is prepared", () => {
    const gate = PIPE.slice(PIPE.indexOf("async function beatClipPassesVisionGate("));
    const ask = gate.indexOf("const refusedHere = beatAlreadyRefusedPicture(dedup.beatRelevance, scene.index, beat.index, {");
    const detector = gate.indexOf("const hasBakedText = await beatClipHasBakedText(clipPath);");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(detector);
    const CURATED = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    const pick = CURATED.indexOf("const refusedHere = curatedAssetRefusedHook?.(sceneIndex, beat.index, picked.asset.id) ?? null;");
    const prepare = CURATED.indexOf("const tryPrepare = async (picked: CuratedCandidatePick)");
    expect(pick).toBeGreaterThan(-1);
    expect(pick).toBeLessThan(prepare);
    expect(PIPE).toContain("setCuratedAssetRefusedHook((sceneIndex, beatIndex, assetId) => {");
    expect(PIPE).toContain("ledgerBySourcingCache.set(state.sourcingCache, state.beatRelevance);");
  });
});
