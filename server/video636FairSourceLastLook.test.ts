/**
 * W1 (VIDEO 636) — YouTube gets a fair look; it never wins without a FIT.
 *
 * Render 636's s0b3: one archive-first look and four Internet Archive looks, all `does_not_fit`, and
 * the YouTube moment 04AEWBdX_cs at rank 6 never seen. It was then adopted UNREVIEWED, refused by the
 * planner, and the sentence became a card.
 *
 *   W1a — when the sentence's last look is about to go to a non-YouTube picture and no YouTube
 *         candidate has been looked at on this sentence, the best eligible YouTube candidate (in the
 *         existing ranked order) takes that look; the candidate that gave way waits directly behind.
 *   W1b — a candidate that is still UNREVIEWED when it comes round again is not adopted.
 *
 * `round` replays the adopt loop with the pipeline's own pure functions (the same reorder, the same
 * last-look rules, the same ledger and ceiling); the wiring tests below pin where the pipeline calls
 * them.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  beatRelevanceBeatKey,
  createBeatRelevanceLedger,
  giveLastLookTo,
  isYoutubeContentKey,
  looksLeftOnBeat,
  maxRelevanceLooksPerBeat,
  pictureJudgedOnBeat,
  pictureLookedAtOnBeat,
  postponeBehindFresherCandidate,
  putRefusedElsewhereLast,
  repeatWouldTakeLastLook,
  youtubeForLastLook,
  youtubeLookedAtOnBeat,
  type BeatRelevanceDecision,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import { MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { maxShortlistPerBeat, maxShortlistPerBeatPerSource } from "./beatShortlist";
import { FOOTAGE_SHARE_TIERS } from "./usageDiversity";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const S = 0;
const B = 3;
const BEAT = `s${S}b${B}`;

/** `yt_*` is a YouTube moment, anything else an archive / open-source picture. */
const keyOf = (p: string) => (p.startsWith("yt_") ? `youtube_cc:${p}` : `internet_archive:${p}`);

type Outcome = "fits" | "does_not_fit" | "gate";

function file(ledger: BeatRelevanceLedger, p: string, verdict: "fits" | "does_not_fit" | "unknown", evaluated: boolean): void {
  const entry = {
    ctx: { sceneIndex: S, beatIndex: B, beatText: "What was Musk's secret weapon?" },
    decision: { verdict, allowed: verdict !== "does_not_fit", reprieved: false, cached: false, depicts: "", reason: "", evaluated } as BeatRelevanceDecision,
    contentKey: keyOf(p),
  };
  ledger.byBeat.set(beatRelevanceBeatKey(S, B, "path", `/tmp/${p}.mp4`), entry as never);
  ledger.byBeat.set(beatRelevanceBeatKey(S, B, "content", keyOf(p)), entry as never);
}

/**
 * One round of the adopt loop. `outcome` is what the gates and the Judge would say for a candidate:
 * `gate` = refused before any look (metadata / entity / technical), otherwise the Judge's verdict —
 * which is only reached while the sentence has a look left; past the ceiling the candidate is
 * UNREVIEWED, exactly as `checkBeatRelevance` declines with BEAT_LOOK_CEILING.
 */
function round(opts: {
  ledger?: BeatRelevanceLedger;
  candidates: string[];
  outcome?: Record<string, Outcome>;
  refusedElsewhere?: (p: string) => boolean;
  /** The pipeline's safety filter for W1 (footage share, fragment memory, already used, …). */
  excluded?: Set<string>;
  finalRound?: boolean;
  w1?: boolean;
}) {
  const ledger = opts.ledger ?? createBeatRelevanceLedger();
  const refused = opts.refusedElsewhere ?? (() => false);
  const w1 = opts.w1 ?? true;
  const queue = putRefusedElsewhereLast(opts.candidates, refused).paths;
  const visited = new Set<string>();
  const postponed = new Set<string>();
  const gaveWay = new Set<string>();
  const held = new Set<string>();
  const looked: string[] = [];
  const fairSource: Array<{ forYoutube: string; gaveWay: string }> = [];
  const notAdoptedUnreviewed: string[] = [];
  let adopted: string | null = null;
  let guard = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (++guard > 200) throw new Error("the loop did not end");
    const p = queue[cursor]!;
    if (postponeBehindFresherCandidate(queue, cursor, refused, visited, postponed)) {
      postponed.add(p);
      queue.push(p);
      continue;
    }
    if (
      repeatWouldTakeLastLook({
        refusedElsewhere: refused(p),
        judgedOnThisBeat: pictureJudgedOnBeat(ledger, `/tmp/${p}.mp4`, keyOf(p), S, B),
        looksLeft: looksLeftOnBeat(ledger, S, B),
        finalRound: Boolean(opts.finalRound),
      })
    ) {
      continue;
    }
    if (w1) {
      const pick = youtubeForLastLook({
        looksLeft: looksLeftOnBeat(ledger, S, B),
        finalRound: Boolean(opts.finalRound),
        currentIsYoutube: isYoutubeContentKey(keyOf(p)),
        currentJudgedOnThisBeat: pictureLookedAtOnBeat(ledger, `/tmp/${p}.mp4`, keyOf(p), S, B),
        currentAlreadyGaveWay: gaveWay.has(p),
        youtubeJudgedOnThisBeat: youtubeLookedAtOnBeat(ledger, S, B),
        later: queue.slice(cursor + 1),
        isYoutube: (q) => isYoutubeContentKey(keyOf(q)),
        eligible: (q) =>
          !visited.has(q) &&
          !postponed.has(q) &&
          !pictureLookedAtOnBeat(ledger, `/tmp/${q}.mp4`, keyOf(q), S, B) &&
          !refused(q) &&
          !(opts.excluded?.has(q) ?? false),
      });
      if (pick) {
        giveLastLookTo(queue, cursor, pick);
        gaveWay.add(p);
        fairSource.push({ forYoutube: pick, gaveWay: p });
        continue;
      }
    }
    visited.add(p);
    const out = opts.outcome?.[p] ?? "does_not_fit";
    if (out === "gate") continue;
    const alreadyLooked = pictureLookedAtOnBeat(ledger, `/tmp/${p}.mp4`, keyOf(p), S, B);
    let evidence: "FIT" | "MISMATCH" | "UNREVIEWED";
    if (alreadyLooked) {
      const e = ledger.byBeat.get(beatRelevanceBeatKey(S, B, "content", keyOf(p)))!;
      evidence = e.decision.verdict === "fits" ? "FIT" : "MISMATCH";
    } else if (looksLeftOnBeat(ledger, S, B) <= 0) {
      file(ledger, p, "unknown", false);
      evidence = "UNREVIEWED";
    } else {
      ledger.spendByBeat.set(BEAT, (ledger.spendByBeat.get(BEAT) ?? 0) + 1);
      looked.push(p);
      file(ledger, p, out, true);
      evidence = out === "fits" ? "FIT" : "MISMATCH";
    }
    if (evidence === "FIT") {
      adopted = p;
      break;
    }
    /** Weaker than FIT on its first visit: held at the back of the queue, as the pipeline does. */
    if (!held.has(p)) {
      held.add(p);
      queue.push(p);
      continue;
    }
    /** W1b — come round again still UNREVIEWED: never adopted. A refusal is not adopted either. */
    if (evidence === "UNREVIEWED") notAdoptedUnreviewed.push(p);
  }
  return { looked, adopted, fairSource, notAdoptedUnreviewed, spent: ledger.spendByBeat.get(BEAT) ?? 0, ledger };
}

/** Render 636's s0b3, in its ranked order (04AE rank 6, xbhq rank 8). */
const S0B3 = ["ia_arch1", "ia_arch3", "ia_arch4", "ia_arch5", "ia_hist0", "ia_hist1", "yt_04AE", "ia_other", "yt_xbhq"];
/** The archive-first look s0b3 had already spent before the loop began (12:14:58, does_not_fit). */
function afterArchiveFirst(): BeatRelevanceLedger {
  const ledger = createBeatRelevanceLedger();
  ledger.spendByBeat.set(BEAT, 1);
  file(ledger, "curated_a58409", "does_not_fit", true);
  return ledger;
}

describe("W1a — the last look for a YouTube candidate nobody has seen", () => {
  it("T1. video 636 s0b3: 04AE gets look 5, archive #5 gets none, never a sixth look", () => {
    const r = round({ ledger: afterArchiveFirst(), candidates: S0B3 });
    expect(r.looked).toEqual(["ia_arch1", "ia_arch3", "ia_arch4", "yt_04AE"]);
    expect(r.spent).toBe(5);
    expect(r.looked).not.toContain("ia_arch5");
    expect(r.fairSource).toEqual([{ forYoutube: "yt_04AE", gaveWay: "ia_arch5" }]);
    /** xbhq (rank 8) gets no guarantee: one YouTube look per sentence is the rule, not two. */
    expect(r.looked).not.toContain("yt_xbhq");
    expect(r.adopted).toBeNull();
  });

  it("T1b. the same sentence when 04AE is a FIT: 04AE fills it", () => {
    const r = round({ ledger: afterArchiveFirst(), candidates: S0B3, outcome: { yt_04AE: "fits" } });
    expect(r.adopted).toBe("yt_04AE");
    expect(r.spent).toBe(5);
  });

  it("T2. archive #1 is a FIT: used at once, W1 never fires, YouTube is not looked at", () => {
    const r = round({ candidates: S0B3, outcome: { ia_arch1: "fits" } });
    expect(r.adopted).toBe("ia_arch1");
    expect(r.looked).toEqual(["ia_arch1"]);
    expect(r.fairSource).toEqual([]);
  });

  it("T2b. an archive FIT ranked above the last look still beats a YouTube candidate", () => {
    const r = round({ ledger: afterArchiveFirst(), candidates: S0B3, outcome: { ia_arch4: "fits", yt_04AE: "fits" } });
    expect(r.adopted).toBe("ia_arch4");
    expect(r.looked).not.toContain("yt_04AE");
  });

  it("T3. four archive does_not_fit, YouTube at rank 6 does_not_fit: exactly 5 looks, nothing adopted", () => {
    const r = round({ candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "ia_6", "yt_a"] });
    expect(r.looked).toEqual(["ia_1", "ia_2", "ia_3", "ia_4", "yt_a"]);
    expect(r.spent).toBe(5);
    expect(r.adopted).toBeNull();
    /** The candidates held unlooked come round UNREVIEWED and are not adopted (W1b). */
    expect(r.notAdoptedUnreviewed).toEqual(expect.arrayContaining(["ia_5", "ia_6"]));
  });

  it("T4. a YouTube candidate already looked at on this sentence: W1 does not fire", () => {
    const ledger = createBeatRelevanceLedger();
    file(ledger, "yt_earlier", "does_not_fit", true);
    ledger.spendByBeat.set(BEAT, 1);
    const r = round({ ledger, candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "yt_b"] });
    expect(r.fairSource).toEqual([]);
    expect(r.looked).toEqual(["ia_1", "ia_2", "ia_3", "ia_4"]);
    /** …and one looked at earlier in the same round counts too. */
    const r2 = round({ candidates: ["yt_a", "ia_1", "ia_2", "ia_3", "ia_4", "yt_b"] });
    expect(r2.fairSource).toEqual([]);
    expect(r2.looked).toEqual(["yt_a", "ia_1", "ia_2", "ia_3", "ia_4"]);
  });

  it("T4b. a decline is not a look: a YouTube candidate declined earlier (no verdict) still leaves W1 free", () => {
    const ledger = createBeatRelevanceLedger();
    file(ledger, "yt_declined", "unknown", false);
    expect(youtubeLookedAtOnBeat(ledger, S, B)).toBe(false);
  });

  it("T5. a YouTube candidate excluded by the existing safety rules is never chosen", () => {
    const base = ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "yt_bad", "yt_ok"];
    /** Refused for another sentence. */
    const elsewhere = round({ candidates: base, refusedElsewhere: (p) => p === "yt_bad" });
    expect(elsewhere.fairSource).toEqual([{ forYoutube: "yt_ok", gaveWay: "ia_5" }]);
    /** Footage share, fragment memory, already used, refused this render — the caller's filter. */
    const filtered = round({ candidates: base, excluded: new Set(["yt_bad"]) });
    expect(filtered.fairSource).toEqual([{ forYoutube: "yt_ok", gaveWay: "ia_5" }]);
    /** Nothing eligible left: the order is untouched. */
    const none = round({ candidates: base, excluded: new Set(["yt_bad", "yt_ok"]) });
    expect(none.fairSource).toEqual([]);
    expect(none.looked).toEqual(["ia_1", "ia_2", "ia_3", "ia_4", "ia_5"]);
  });

  it("T5b. among eligible YouTube candidates the existing ranking decides, not arrival or thumbnail", () => {
    const r = round({ candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "yt_rank5", "ia_6", "yt_rank7"] });
    expect(r.fairSource[0]!.forYoutube).toBe("yt_rank5");
  });

  it("T6. the YouTube candidate is stopped by a gate before any look: the candidate that gave way gets the look", () => {
    const r = round({
      candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "ia_6", "yt_a"],
      outcome: { yt_a: "gate", ia_5: "fits" },
    });
    expect(r.fairSource).toEqual([{ forYoutube: "yt_a", gaveWay: "ia_5" }]);
    expect(r.looked).toEqual(["ia_1", "ia_2", "ia_3", "ia_4", "ia_5"]);
    expect(r.adopted).toBe("ia_5");
    expect(r.spent).toBe(5);
  });

  it("T7. no YouTube candidate: exactly the existing behaviour", () => {
    const cases: Array<{ candidates: string[]; outcome?: Record<string, Outcome> }> = [
      { candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "ia_6"] },
      { candidates: ["ia_1", "ia_2", "ia_3"], outcome: { ia_3: "fits" } },
      { candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "ia_6"], outcome: { ia_6: "fits", ia_2: "gate" } },
    ];
    for (const c of cases) {
      const on = round({ ...c, w1: true });
      const off = round({ ...c, w1: false });
      expect(on.looked).toEqual(off.looked);
      expect(on.adopted).toEqual(off.adopted);
      expect(on.fairSource).toEqual([]);
    }
  });

  it("the rescue round keeps nothing back — the same exception as repeatWouldTakeLastLook", () => {
    const r = round({ candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "yt_a"], finalRound: true });
    expect(r.fairSource).toEqual([]);
  });

  it("a candidate gives its look away at most once", () => {
    const r = round({
      candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "yt_a", "yt_b"],
      outcome: { yt_a: "gate", yt_b: "gate" },
    });
    expect(r.fairSource.map((f) => f.gaveWay)).toEqual(["ia_5"]);
    expect(r.looked).toContain("ia_5");
  });

  it("scenarios: 5 strong archive + 1 weak YouTube / 1 strong YouTube + 5 weak archive / 3 + 3 strong", () => {
    const strongArchive = round({ candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "yt_weak"], outcome: { ia_1: "fits", ia_2: "fits" } });
    expect(strongArchive.adopted).toBe("ia_1");
    const strongYoutube = round({ candidates: ["ia_1", "ia_2", "ia_3", "ia_4", "ia_5", "yt_strong"], outcome: { yt_strong: "fits" } });
    expect(strongYoutube.adopted).toBe("yt_strong");
    expect(strongYoutube.spent).toBe(5);
    const mixed = round({
      candidates: ["ia_1", "yt_1", "ia_2", "yt_2", "ia_3", "yt_3"],
      outcome: { ia_1: "fits", yt_1: "fits", ia_2: "fits", yt_2: "fits", ia_3: "fits", yt_3: "fits" },
    });
    expect(mixed.adopted).toBe("ia_1");
    expect(mixed.fairSource).toEqual([]);
  });
});

describe("W1b — UNREVIEWED is a candidate, never an adopted picture", () => {
  it("T8. the best candidate left is UNREVIEWED: never adopted, and no extra look is spent for it", () => {
    const ledger = createBeatRelevanceLedger();
    ledger.spendByBeat.set(BEAT, 5);
    const r = round({ ledger, candidates: ["yt_a", "ia_1"] });
    expect(r.adopted).toBeNull();
    expect(r.notAdoptedUnreviewed).toEqual(["yt_a", "ia_1"]);
    expect(r.spent).toBe(5);
  });

  it("T8 wiring: the UNREVIEWED exit sits before every adoption step in the loop", () => {
    const loop = PIPE.slice(PIPE.indexOf("pendingEvidence.delete(p);"));
    const exit = loop.indexOf('if (beatEvidence === "UNREVIEWED") {');
    expect(exit).toBeGreaterThan(0);
    const block = loop.slice(exit, loop.indexOf("}", loop.indexOf("continue;", exit)) + 1);
    expect(block).toContain("continue;");
    expect(block).not.toMatch(/markAssetUsedInVideo|registerRejection|noteAdoptedForBeat|refusedAssetsThisRender/);
    for (const step of ["markAssetUsedInVideo(dedup", "noteAdoptedForBeat(dedup", "lineage.markEligible(", "return markAdopted("]) {
      expect(loop.indexOf(step), step).toBeGreaterThan(exit);
    }
    /** Still behind the requeue check that a refused picture takes. */
    expect(exit).toBeLessThan(loop.indexOf("if (requeuedAfterRefusal.has(p)) {"));
  });
});

describe("T9. the ceilings are the ceilings", () => {
  it("constants unchanged: 4 per beat, 5 looks per sentence, 120 per render, shortlist 8 / 4 per source", () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
    expect(maxShortlistPerBeat()).toBe(8);
    expect(maxShortlistPerBeatPerSource()).toBe(4);
    expect(FOOTAGE_SHARE_TIERS).toEqual([0.15, 0.3]);
  });

  it("no sentence ever gets a sixth look, and 24 sentences never pass 120, over many random mixes", () => {
    let seed = 636;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let renderTotal = 0;
    for (let beat = 0; beat < 24; beat++) {
      for (let trial = 0; trial < 20; trial++) {
        const n = 3 + Math.floor(rnd() * 10);
        const candidates = Array.from({ length: n }, (_, i) => (rnd() < 0.35 ? `yt_${i}` : `ia_${i}`));
        const outcome: Record<string, Outcome> = {};
        for (const c of candidates) outcome[c] = rnd() < 0.15 ? "fits" : rnd() < 0.2 ? "gate" : "does_not_fit";
        const ledger = createBeatRelevanceLedger();
        ledger.spendByBeat.set(BEAT, Math.floor(rnd() * 3));
        const r = round({ ledger, candidates, outcome });
        expect(r.spent).toBeLessThanOrEqual(5);
        if (trial === 0) renderTotal += r.spent;
      }
    }
    expect(renderTotal).toBeLessThanOrEqual(maxBeatImageJudgementsPerRender());
  });

  it("W1 itself never spends: the block only reorders and continues", () => {
    const at = PIPE.indexOf("const youtubePick = youtubeForLastLook({");
    const block = PIPE.slice(at, PIPE.indexOf("visitedInLoop.add(p);", at));
    expect(block).not.toMatch(/beatClipPassesImageGate|checkBeatRelevance|judgeBeatImage|spendByBeat|admitToShortlist/);
    expect(block).toContain("giveLastLookTo(finalPaths, cursor, youtubePick)");
    expect(block).toContain("[FairSource]");
  });
});

describe("wiring — W1a sits beside the existing last-look rule and keeps every safety filter", () => {
  const loop = PIPE.slice(PIPE.indexOf("const postponedBehindFresher = new Set<string>();"));

  it("after the postpone and repeatWouldTakeLastLook, before anything that costs", () => {
    const repeat = loop.indexOf("repeatWouldTakeLastLook({");
    const w1 = loop.indexOf("youtubeForLastLook({");
    expect(w1).toBeGreaterThan(repeat);
    expect(w1).toBeGreaterThan(loop.indexOf("postponeBehindFresherCandidate(finalPaths, cursor"));
    expect(w1).toBeLessThan(loop.indexOf("visitedInLoop.add(p);"));
    expect(w1).toBeLessThan(loop.indexOf("let fileRefusal = technicalFileRefusal(p);"));
  });

  it("the eligible filter asks every existing exclusion", () => {
    const at = loop.indexOf("eligible: (q) => {");
    const filter = loop.slice(at, loop.indexOf("},", at));
    for (const check of [
      "visitedInLoop.has(q)",
      "postponedBehindFresher.has(q)",
      "pictureLookedAtOnBeat(dedup.beatRelevance, q,",
      "refusedForAnotherSentence(q)",
      "footageShareSoFar(dedup, key) >= FOOTAGE_SHARE_TIERS[0]",
      "dedup.refusedAssetsThisRender?.has(key)",
      "youtubeFragmentRefusal(fragment)",
      "assetUsedInVideo(dedup, { path: q, contentKey: key })",
    ]) {
      expect(filter, check).toContain(check);
    }
    expect(loop.slice(loop.indexOf("youtubeForLastLook({"), at)).toContain(
      "finalRound: Boolean(dedup.beatJudgeTextOverride?.has(`${sceneIndex}:${beatIndex}`)),"
    );
  });

  it("only fresh youtube_cc moments can be brought forward — never an archive asset (cross-video variety stays in charge)", () => {
    /**
     * Footage a FastVid video already used is archived and comes back as a curated asset, which
     * `preferLessUsed` (recent same-subject videos) orders inside the curated search. W1 does not
     * recognise those keys as YouTube, so it can never promote one past that rule.
     */
    expect(isYoutubeContentKey("youtube_cc:88c1d469295eb581@t2995d40")).toBe(true);
    for (const k of ["curated:58409", "internet_archive:youtube-6vV1n7mOnvU", "wikimedia:File:x.webm", "file:/tmp/a.mp4", "", null, undefined]) {
      expect(isYoutubeContentKey(k as string | null | undefined), String(k)).toBe(false);
    }
  });

  it("the existing rules are untouched", () => {
    // VIDEO 638 (G4) — YouTube first in the pool, then the same footage-share rule.
    expect(PIPE).toContain("const lessFilled = preferLessFilledFootage(youtubeCandidatesFirst(tasteResult.rankedPaths), (p) => clipContentKey(p), dedup);");
    expect(PIPE).toContain("const refusedElsewhere = putRefusedElsewhereLast(finalPaths, (p) =>");
    expect(repeatWouldTakeLastLook({ refusedElsewhere: true, judgedOnThisBeat: false, looksLeft: 1, finalRound: false })).toBe(true);
  });
});

describe("giveLastLookTo / youtubeForLastLook — the pure pieces", () => {
  it("moves the pick next and the giver directly behind it; nothing lost", () => {
    const q = ["a", "b", "c", "yt", "d"];
    giveLastLookTo(q, 1, "yt");
    expect(q).toEqual(["a", "b", "yt", "b", "c", "d"]);
  });

  it("returns null unless every condition holds", () => {
    const base = {
      looksLeft: 1,
      finalRound: false,
      currentIsYoutube: false,
      currentJudgedOnThisBeat: false,
      currentAlreadyGaveWay: false,
      youtubeJudgedOnThisBeat: false,
      later: ["ia_x", "yt_a"],
      isYoutube: (q: string) => q.startsWith("yt_"),
      eligible: () => true,
    };
    expect(youtubeForLastLook(base)).toBe("yt_a");
    expect(youtubeForLastLook({ ...base, looksLeft: 2 })).toBeNull();
    expect(youtubeForLastLook({ ...base, looksLeft: 0 })).toBeNull();
    expect(youtubeForLastLook({ ...base, finalRound: true })).toBeNull();
    expect(youtubeForLastLook({ ...base, currentIsYoutube: true })).toBeNull();
    expect(youtubeForLastLook({ ...base, currentJudgedOnThisBeat: true })).toBeNull();
    expect(youtubeForLastLook({ ...base, currentAlreadyGaveWay: true })).toBeNull();
    expect(youtubeForLastLook({ ...base, youtubeJudgedOnThisBeat: true })).toBeNull();
    expect(youtubeForLastLook({ ...base, eligible: () => false })).toBeNull();
    expect(youtubeForLastLook({ ...base, later: ["ia_x"] })).toBeNull();
  });
});
