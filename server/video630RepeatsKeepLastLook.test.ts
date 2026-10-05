/**
 * P2 (VIDEO 630, third pass) — a repeat never takes a sentence's last look while a later round can
 * still bring a picture nobody has seen.
 *
 * Render 630's s0b3 spent its first round on pictures already refused for other sentences, reached
 * the five-look ceiling, and its main-subject rescue round then brought two SerpAPI pictures that
 * nobody could look at. Ordering cannot fix that: the fresh pictures did not exist yet. The rescue
 * round is the one round the pipeline knows to be the last (it marks those beats in
 * `beatJudgeTextOverride`), so only in a normal round is the last look kept back from a repeat.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  createBeatRelevanceLedger,
  looksLeftOnBeat,
  maxRelevanceLooksPerBeat,
  pictureJudgedOnBeat,
  postponeBehindFresherCandidate,
  putRefusedElsewhereLast,
  repeatWouldTakeLastLook,
  beatRelevanceBeatKey,
  type BeatRelevanceDecision,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import { approvalRestsOnAGuess, MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { onScreenTextRefusesBeforeVision } from "./visualJudge";
import { rejectionStageForReason } from "./rejectionRegistry";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const SLOT = { sceneIndex: 0, beatIndex: 3 };

/**
 * One round of the pipeline's own loop, in the order the pipeline asks: the reorder, the per-look
 * postpone, the last-look reserve, then a look while the ceiling allows. Every look is paid for on
 * the same ledger the pipeline uses, so the ceiling carries across rounds exactly as in a render.
 */
function round(
  ledger: BeatRelevanceLedger,
  candidates: string[],
  refused: (p: string) => boolean,
  finalRound: boolean
): { looked: string[]; keptBack: string[]; postponed: string[] } {
  const queue = putRefusedElsewhereLast(candidates, refused).paths;
  const visited = new Set<string>();
  const postponedSet = new Set<string>();
  const looked: string[] = [];
  const keptBack: string[] = [];
  let guard = 0;
  for (let i = 0; i < queue.length; i++) {
    if (++guard > 100) throw new Error("the loop did not end");
    const p = queue[i]!;
    if (postponeBehindFresherCandidate(queue, i, refused, visited, postponedSet)) {
      postponedSet.add(p);
      queue.push(p);
      continue;
    }
    if (
      repeatWouldTakeLastLook({
        refusedElsewhere: refused(p),
        judgedOnThisBeat: pictureJudgedOnBeat(ledger, p, `test:${p}`, SLOT.sceneIndex, SLOT.beatIndex),
        looksLeft: looksLeftOnBeat(ledger, SLOT.sceneIndex, SLOT.beatIndex),
        finalRound,
      })
    ) {
      keptBack.push(p);
      continue;
    }
    visited.add(p);
    if (looksLeftOnBeat(ledger, SLOT.sceneIndex, SLOT.beatIndex) <= 0) break;
    const key = `s${SLOT.sceneIndex}b${SLOT.beatIndex}`;
    ledger.spendByBeat.set(key, (ledger.spendByBeat.get(key) ?? 0) + 1);
    looked.push(p);
  }
  return { looked, keptBack, postponed: [...postponedSet] };
}

const old = (p: string) => p.startsWith("old_");

describe("P2 — fresh pictures first, repeats only when nothing fresher is left", () => {
  it("A. one repeat + four new → the four new are looked at first", () => {
    const r = round(createBeatRelevanceLedger(), ["old_a", "new_b", "new_c", "new_d", "new_e"], old, false);
    expect(r.looked.slice(0, 4)).toEqual(["new_b", "new_c", "new_d", "new_e"]);
    /** Four looks spent, one left: the repeat may not take it in a normal round. */
    expect(r.looked).not.toContain("old_a");
    expect(r.keptBack).toEqual(["old_a"]);
  });

  it("B. one repeat + one new → the new one first, then the repeat (looks remain)", () => {
    const r = round(createBeatRelevanceLedger(), ["old_a", "new_b"], old, false);
    expect(r.looked).toEqual(["new_b", "old_a"]);
  });

  it("C. only repeats → they are looked at again (all but the last look in a normal round, all in the rescue round)", () => {
    const normal = round(createBeatRelevanceLedger(), ["old_a", "old_b", "old_c"], old, false);
    expect(normal.looked).toEqual(["old_a", "old_b", "old_c"]);
    const ledger = createBeatRelevanceLedger();
    ledger.spendByBeat.set("s0b3", 4);
    expect(round(ledger, ["old_a"], old, false).looked, "normal round: the last look is kept").toEqual([]);
    expect(round(ledger, ["old_a"], old, true).looked, "rescue round: nothing is kept back").toEqual(["old_a"]);
  });

  it("D. video 630 s0b3 replayed: the rescue round's new pictures get the look that was kept", () => {
    const ledger = createBeatRelevanceLedger();
    /** Round 1: one new archive clip and four pictures already refused for other sentences. */
    const r1 = round(ledger, ["new_ia", "old_flag", "old_interview", "old_soldiers", "old_window"], old, false);
    expect(r1.looked).toEqual(["new_ia", "old_flag", "old_interview", "old_soldiers"]);
    expect(r1.keptBack).toEqual(["old_window"]);
    expect(looksLeftOnBeat(ledger, 0, 3)).toBe(1);
    /** Rescue round: two SerpAPI pictures nobody has seen. Before this fix: zero looks left. */
    const r2 = round(ledger, ["old_window", "new_serp_a", "new_serp_b"], old, true);
    expect(r2.looked).toEqual(["new_serp_a"]);
    expect(looksLeftOnBeat(ledger, 0, 3)).toBe(0);
  });

  it("D'. a new picture arriving in a later normal round is not left behind the repeats", () => {
    const ledger = createBeatRelevanceLedger();
    round(ledger, ["old_a", "old_b", "old_c", "old_d"], old, false);
    expect(looksLeftOnBeat(ledger, 0, 3)).toBe(1);
    expect(round(ledger, ["old_e", "new_late"], old, false).looked).toEqual(["new_late"]);
  });

  it("a picture this sentence already judged is never kept back — reading its verdict is free", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set(beatRelevanceBeatKey(0, 3, "content", "test:old_a"), {
      ctx: { sceneIndex: 0, beatIndex: 3, beatText: "x" },
      decision: { verdict: "fits", allowed: true, reprieved: false, cached: false, depicts: "", reason: "", evaluated: true } as BeatRelevanceDecision,
    });
    expect(pictureJudgedOnBeat(ledger, "/tmp/old_a.mp4", "test:old_a", 0, 3)).toBe(true);
    expect(repeatWouldTakeLastLook({ refusedElsewhere: true, judgedOnThisBeat: true, looksLeft: 1, finalRound: false })).toBe(false);
  });

  it("E/F. the ceiling is five looks and the render budget 120 — a kept look is never added anywhere", () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
    const ledger = createBeatRelevanceLedger();
    const r = round(ledger, ["n1", "n2", "n3", "n4", "n5", "n6", "n7"], old, true);
    expect(r.looked).toHaveLength(5);
  });

  it("G/H. a picture is moved back at most once per round, and the round always ends", () => {
    const r = round(createBeatRelevanceLedger(), ["old_a", "old_b", "new_c", "old_d", "new_e"], old, true);
    expect(new Set(r.postponed).size).toBe(r.postponed.length);
    expect(r.looked.slice(0, 2)).toEqual(["new_c", "new_e"]);
    expect(() => round(createBeatRelevanceLedger(), Array.from({ length: 30 }, (_, i) => `old_${i}`), old, false)).not.toThrow();
  });
});

describe("wiring — one check in the loop that spends the looks, on an existing marker", () => {
  it("asked after the postpone and before anything that costs, keyed on the rescue round's own marker", () => {
    const loop = PIPE.slice(PIPE.indexOf("const postponedBehindFresher = new Set<string>();"));
    const postpone = loop.indexOf("postponeBehindFresherCandidate(finalPaths, cursor");
    const reserve = loop.indexOf("repeatWouldTakeLastLook({");
    expect(reserve).toBeGreaterThan(postpone);
    expect(reserve).toBeLessThan(loop.indexOf("let fileRefusal = technicalFileRefusal(p);"));
    expect(loop.slice(reserve, reserve + 600)).toContain("finalRound: Boolean(dedup.beatJudgeTextOverride?.has(`${sceneIndex}:${beatIndex}`)),");
    /** The marker is set by the rescue round only. */
    expect(PIPE.match(/beatJudgeTextOverride \?\?= new Map\(\)\)\.set\(/g)).toHaveLength(1);
  });

  it("I. technical refusals keep their film-wide rule", async () => {
    const { refusalHoldsForEverySentence } = await import("./videoPipeline");
    expect(refusalHoldsForEverySentence("mostly_black")).toBe(true);
    expect(refusalHoldsForEverySentence("baked_edit_text_before_vision")).toBe(true);
    expect(refusalHoldsForEverySentence("refused on s0b2: does not fit")).toBe(false);
    expect(rejectionStageForReason("mostly_black")).toBe("technical");
  }, 120_000);
});

describe("J–N. what was already proven stays proven", () => {
  let pipe: typeof import("./videoPipeline") | undefined;
  afterEach(() => pipe?.setRenderPeopleReadingForTests(null));

  it("J. P0: only a title card is refused before the picture editor", () => {
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "fills_picture" })).toBe(true);
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "overlay" })).toBe(false);
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT" })).toBe(false);
  });

  it("K. P1: a definite refusal of an archive hit sends the beat on; anything else does not", async () => {
    pipe ??= await import("./videoPipeline");
    expect(pipe.archiveHitIsRefused({ verdict: "does_not_fit", evaluated: true, reprieved: false })).toBe(true);
    expect(pipe.archiveHitIsRefused({ verdict: "fits", evaluated: true, reprieved: false })).toBe(false);
    expect(pipe.archiveHitIsRefused(null)).toBe(false);
  }, 120_000);

  it("L/N. events and places are not people; M. a guessed person stays refused", async () => {
    pipe ??= await import("./videoPipeline");
    pipe.setRenderPeopleReadingForTests(["Adolf Hitler", "Joseph Stalin", "Dwight D. Eisenhower"]);
    for (const n of ["D-Day Invasion", "English Channel", "Normandy"]) expect(pipe.personAsRead(n)).toBeNull();
    const line = "As dawn broke on June 6, 1944, the D-Day Invasion launched across the English Channel.";
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "Soldiers onboard a landing craft, likely approaching a beach.", reason: "Soldiers likely approaching a beach, fitting the D-Day invasion across the English Channel." },
        line, undefined, pipe.personAsRead
      )
    ).toBe(false);
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "A man at a podium.", reason: "The speaker appears to be Joseph Stalin." },
        "Joseph Stalin commanded immense forces.", undefined, pipe.personAsRead
      )
    ).toBe(true);
  }, 120_000);
});
