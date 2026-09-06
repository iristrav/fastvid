/**
 * WHY YOUTUBE HAD TO BE APPROVED TWICE, AND SO NEVER WAS.
 *
 * ── Render 569 ──────────────────────────────────────────────────────────────────────────────
 *
 *     [SourcingMetrics] youtube_cc: searches=8 results=70 downloads=3 accepted=0
 *
 * Three clips fetched, none used. The chain, established from the code rather than guessed:
 *
 *   1. `youtubeClipPassesImageGate` shows a downloaded clip to the picture editor and asks whether
 *      it fits `scriptGuided.beatText`. A real vision call, on the beat's own narration.
 *   2. The verdict was recorded with `beatIndex: -1`, because the check runs before the clip is in
 *      any beat's pool and the index was not to hand.
 *   3. `relevanceVerdictForRenderedAsset` accepts a verdict only when its beat matches the asset's
 *      beat — "a verdict earned elsewhere is not one". `-1` matches no beat, ever.
 *   4. So at adoption the guard saw NOT_ASKED. And `youtube` / `youtube_cc` are REAL_FUNNEL, the
 *      one category demanding an explicit APPROVED rather than merely the absence of a refusal.
 *
 * A YouTube clip the editor had already approved therefore arrived at adoption with no approval to
 * show. It had to win one of the beat's eight shortlist slots and be judged all over again — the
 * only source in the pipeline required to pass the same editor twice.
 *
 * ── What the fix is, and what it is not ─────────────────────────────────────────────────────
 *
 * The judgement is filed against the beat whose narration earned it. Same editor, same frames,
 * same sentence — recorded where the beat can find it instead of thrown away.
 *
 * It is NOT a relaxation. REAL_FUNNEL still demands APPROVED; a clip the editor REFUSED is still
 * refused, and one it could not read is still not an approval. Those are asserted below, because
 * "make more YouTube get used" is exactly the request under which a gate quietly gets weakened.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { adoptionGuardVerdict, adoptionPolicyFor } from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const bodyOf = (name: string): string => {
  const at = PIPE.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
};

describe("the screening verdict reaches the beat that earned it", () => {
  const body = () => bodyOf("youtubeClipPassesImageGate");

  it("files the verdict under the real beat, not a sentinel", () => {
    expect(body(), "beatIndex: -1 is what made an approval unusable").toContain(
      "beatIndex: scriptGuided.beatIndex ?? -1"
    );
  });

  /** Both places: the ledger the adoption guard reads, and the cache bucket the beat gate uses. */
  it("does so in both records", () => {
    const occurrences = body().split("scriptGuided.beatIndex ?? -1").length - 1;
    expect(occurrences, "the ledger record and the judgement identity").toBe(2);
  });

  /** A caller with no beat still says so honestly rather than inventing one. */
  it("keeps -1 as the answer when there is genuinely no beat", () => {
    expect(body()).toContain("?? -1");
  });

  /**
   * The context type is optional-by-design, so a missed call site fails silently by falling back
   * to the old behaviour. This counts the call sites instead: every scriptGuided object that
   * carries the render's image gate is one of these screenings, and must carry the beat too.
   */
  it("every screening call site passes the beat index", () => {
    const objects = PIPE.match(/\{[^{}]*imageGate: dedup\.beatImageGate[^{}]*\}/gs) ?? [];
    expect(objects.length, "the screening call sites").toBeGreaterThanOrEqual(9);
    const missing = objects.filter((o) => !o.includes("beatIndex"));
    expect(missing, `${missing.length} call site(s) still file under a sentinel`).toEqual([]);
  });
});

describe("nothing about the adoption bar has moved", () => {
  const ENV = "ENFORCE_FUNNEL_ADOPTION";

  const guard = (vision: "APPROVED" | "REJECTED" | "UNCLEAR" | "NOT_ASKED") => {
    const saved = process.env[ENV];
    try {
      delete process.env[ENV];
      return adoptionGuardVerdict({ source: "youtube_cc", eligible: true, vision });
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  };

  it("YouTube is still REAL_FUNNEL and still needs an approval", () => {
    expect(adoptionPolicyFor("youtube_cc").visionRequirement).toBe("approved");
    expect(adoptionPolicyFor("youtube").visionRequirement).toBe("approved");
    expect(adoptionPolicyFor("youtube_cc").countsAsVerifiedVisual).toBe(true);
  });

  it("an approved clip is adopted — which is the whole point of the fix", () => {
    expect(guard("APPROVED").allowed).toBe(true);
  });

  it.each(["REJECTED", "UNCLEAR", "NOT_ASKED"] as const)(
    "a %s verdict is still refused",
    (vision) => {
      expect(guard(vision).allowed, "this is the bar, and it has not moved").toBe(false);
    }
  );

  /**
   * The budget YouTube may spend on judgements is untouched. RONDE 61 capped it at 24 because
   * render 532 let YouTube take 52 of 60 and starve the funnel; nothing here reopens that.
   */
  it("leaves YouTube's judgement slice where RONDE 61 put it", () => {
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toContain('envInt("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS", 24, 0, 500)');
  });

  /** And the screening still drops what the editor refused, before it can reach a pool. */
  it("a refused clip is still deleted rather than returned", () => {
    expect(bodyOf("youtubeClipPassesImageGate")).toContain('judgement.verdict !== "does_not_fit"');
  });
});
