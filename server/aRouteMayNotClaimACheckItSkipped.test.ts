/**
 * THE THREE WW2 CLIPS IN A VIDEO ABOUT KYLIE JENNER.
 *
 * ── What video 580 delivered, and what its own report said about it ─────────────────────────
 *
 *     bySource = {"ww2":3, "serpapi":1, "wikimedia":3, "UNVERIFIED":9}
 *
 *     s0b0  cov=own_footage  ver=never_asked  src=rescue_archive  scene_0_b0_curated_a57692_still.mp4
 *     s1b1  cov=own_footage  ver=unknown      src=rescue_archive  scene_1_b1_curated_a57446.mp4
 *
 * `own_footage` is the value that means "this beat has its own real picture" — the one coverage
 * the type's own comment calls "not a compromise". Bombers under a sentence about a lip-kit were
 * counted as that.
 *
 * ── How they got in, which is not the obvious way ───────────────────────────────────────────
 *
 * Not past the picture editor. They never met it. RONDE 199 already forbids adopting an unjudged
 * RESCUE_REAL clip — `visionRequirementMet` returns false for NOT_ASKED — but
 * `adoptionGuardRefusesPush` SUSPENDS the requirement when `ensureVerdictBeforeCompose` reports
 * `no_scope`, `beat_unknown` or `no_narration`: there is no sentence behind the slot, so no amount
 * of asking can produce a verdict. That reasoning is right, RONDE 215 measured what refusing costs,
 * and it stays. The adoption is then recorded under the beat the clip was fetched FOR, and the
 * suspension does not travel with it.
 *
 * So a stricter rule in the guard would have changed nothing — the requirement is suspended before
 * it is read. What these tests pin down instead is the distinction the render was missing:
 *
 *   the picture may enter   — refusing it empties the film, which is the worse outcome
 *   the claim may not       — nobody may report an unexamined picture as an approved one
 *   and the exemption is counted, out loud, every render
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { buildBeatVisualStatuses, tallyBeatVisualStatuses, neverAskedReason } from "./beatVisualStatus";
import { formatSuspendedVisionAdoptions } from "./videoPipeline";
import type { ClipAdoptEntry } from "./clipAdoptAudit";
import type { BeatRelevanceDecision, BeatRelevanceLedger } from "./beatVisualRelevance";

const decision = (over: Partial<BeatRelevanceDecision> = {}): BeatRelevanceDecision => ({
  verdict: "fits",
  allowed: true,
  reprieved: false,
  cached: false,
  depicts: "",
  reason: "",
  route: "adopt",
  evaluated: true,
  ...over,
});

const emptyLedger = (): BeatRelevanceLedger => ({
  byClipPath: new Map(),
  byContentKey: new Map(),
  byBeat: new Map(),
  spendByBeat: new Map(),
  finalSayRetried: new Set(),
});

/** A verdict filed the way the gate files one for the clip that is actually on screen. */
const judged = (
  ledger: BeatRelevanceLedger,
  clipPath: string,
  sceneIndex: number,
  beatIndex: number,
  d: Partial<BeatRelevanceDecision>
) => {
  ledger.byClipPath.set(clipPath, {
    ctx: { sceneIndex, beatIndex } as never,
    decision: decision(d),
  });
  return ledger;
};

const adopt = (over: Partial<ClipAdoptEntry> = {}): ClipAdoptEntry =>
  ({
    sceneIndex: 0,
    beatIndex: 0,
    source: "rescue_archive",
    basename: "scene_0_b0_curated_a57692_still.mp4",
    beatText: "In 2023, a viral rumor claimed Kylie Jenner had",
    ...over,
  }) as ClipAdoptEntry;

describe("1. real footage nobody looked at may not be called the beat's own", () => {
  it("own_footage + never_asked is reported as unjudged_footage — video 580's s0b0", () => {
    const [status] = buildBeatVisualStatuses([adopt()], emptyLedger());
    expect(status!.coverage).toBe("unjudged_footage");
    expect(status!.verification).toBe("never_asked");
    expect(status!.verifiedOwnVisual).toBe(false);
  });

  it("the tally stops counting it as own footage", () => {
    const tally = tallyBeatVisualStatuses(buildBeatVisualStatuses([adopt()], emptyLedger()));
    expect(tally.byCoverage.own_footage).toBe(0);
    expect(tally.byCoverage.unjudged_footage).toBe(1);
    expect(tally.ownFootage).toBe(0);
    expect(tally.verifiedOwnVisual).toBe(0);
  });

  it("the beat still names its gap, so the downgrade hides nothing", () => {
    const [status] = buildBeatVisualStatuses([adopt()], emptyLedger());
    expect(status!.reason).toBe("real_footage_never_judged");
    expect(status!.verdictGap).toBeDefined();
    expect(neverAskedReason("unjudged_footage")).toBe("real_footage_never_judged");
  });
});

describe("2. the downgrade is narrow, and every edge of it is deliberate", () => {
  const clip = "/w/scene_0_b0_curated_a57692_still.mp4";

  it("a FIT keeps own_footage and its verified visual", () => {
    const ledger = judged(emptyLedger(), clip, 0, 0, { verdict: "fits" });
    const [status] = buildBeatVisualStatuses([adopt()], ledger);
    expect(status!.coverage).toBe("own_footage");
    expect(status!.verifiedOwnVisual).toBe(true);
  });

  /**
   * RONDE 97 measured what refusing `unknown` costs: the editor LOOKED and could not tell, which
   * is a fact about the picture rather than about the render. Video 580's s1b1 is exactly this
   * case, and it keeps its claim — the round that would change that is not this one.
   */
  it("UNKNOWN keeps own_footage — the editor looked, it simply could not tell", () => {
    const ledger = judged(emptyLedger(), clip, 0, 0, { verdict: "unknown", evaluated: true });
    const [status] = buildBeatVisualStatuses([adopt()], ledger);
    expect(status!.coverage).toBe("own_footage");
    expect(status!.verification).toBe("unknown");
    expect(status!.verifiedOwnVisual).toBe(false);
  });

  it("a REFUSAL keeps own_footage and reports the mismatch, rather than hiding it", () => {
    const ledger = judged(emptyLedger(), clip, 0, 0, { verdict: "does_not_fit", allowed: false });
    const [status] = buildBeatVisualStatuses([adopt()], ledger);
    expect(status!.coverage).toBe("own_footage");
    expect(status!.verification).toBe("verified_mismatch");
  });

  it("subject_only is untouched — it earned a verdict about its subject", () => {
    const [status] = buildBeatVisualStatuses(
      [adopt({ source: "subject_fallback", basename: "scene_0_slot1_guaranteed.mp4" })],
      emptyLedger()
    );
    expect(status!.coverage).not.toBe("unjudged_footage");
  });

  it.each([
    ["rescue_placeholder", "scene_0_slot3_guaranteed.mp4"],
    ["rescue_graphic", "scene_0_graphic.mp4"],
  ])("%s is a stand-in and never claimed a check, so nothing moves", (source, basename) => {
    const [status] = buildBeatVisualStatuses([adopt({ source, basename })], emptyLedger());
    expect(status!.coverage).not.toBe("unjudged_footage");
    expect(status!.coverage).not.toBe("own_footage");
  });
});

describe("3. every rescue route that reaches for real footage is covered, not just the archive", () => {
  /**
   * The WW2 clips arrived on `rescue_archive`, but the suspension is a property of the GUARD, not
   * of one route. A fix that only named the route that happened to be caught would leave the same
   * hole open on its four siblings — this codebase's signature defect, written down.
   */
  it.each(["rescue_archive", "rescue_wikimedia", "rescue_stock", "rescue_similar"])(
    "%s cannot claim own_footage without a verdict",
    (source) => {
      const [status] = buildBeatVisualStatuses(
        [adopt({ source, basename: `scene_0_b0_${source}.mp4` })],
        emptyLedger()
      );
      expect(status!.coverage).toBe("unjudged_footage");
    }
  );
});

describe("4. the exemption is counted, and a clean render says so in words", () => {
  it("a render where every picture was judged states that, rather than staying silent", () => {
    const line = formatSuspendedVisionAdoptions(new Map());
    expect(line).toContain("[UnjudgedFootage] adopted=0");
    expect(line).toContain("every picture in this film was put to the picture editor");
  });

  it("zeroes never masquerade as an untouched render", () => {
    expect(formatSuspendedVisionAdoptions(new Map([["rescue_archive", 0]]))).toContain("adopted=0");
  });

  it("video 580's shape: three on one route, named and totalled", () => {
    const line = formatSuspendedVisionAdoptions(new Map([["rescue_archive", 3]]));
    expect(line).toContain("adopted=3");
    expect(line).toContain("rescue_archive=3");
    expect(line).toContain("coverage=unjudged_footage");
  });

  it("routes are ordered by size, so the worst offender reads first", () => {
    const line = formatSuspendedVisionAdoptions(
      new Map([
        ["rescue_wikimedia", 2],
        ["rescue_archive", 7],
      ])
    );
    expect(line.indexOf("rescue_archive=7")).toBeLessThan(line.indexOf("rescue_wikimedia=2"));
    expect(line).toContain("adopted=9");
  });
});

describe("5. what this round deliberately does NOT do", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const GUARD = SRC.slice(
    SRC.indexOf("async function adoptionGuardRefusesPush"),
    SRC.indexOf("function noteDuplicateClipRefused")
  );
  const POLICY = readFileSync(join(__dirname, "adoptionPolicy.ts"), "utf8");

  /**
   * The picture still enters. RONDE 215 measured what refusing an unjudgeable adoption costs —
   * scene 0 finished with no picture at all and the export gate refused the film — and the owner
   * has been explicit that an empty video is the worst outcome there is.
   */
  it("the suspension still allows the adoption — the counting is beside it, not instead of it", () => {
    expect(GUARD).toContain("if (verdict.allowed) return false;");
    const counted = GUARD.indexOf("UNJUDGED_REAL_FOOTAGE_ADOPTED");
    const allowed = GUARD.indexOf("if (verdict.allowed) return false;");
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThan(allowed);
  });

  it("no gate threshold, vision requirement or policy was relaxed", () => {
    expect(POLICY).toContain('visionRequirement: "not_rejected"');
    expect(POLICY).toMatch(/case "not_rejected":\s*\n\s*return vision !== "REJECTED" && vision !== "NOT_ASKED";/);
    expect(POLICY).toContain('case "approved":');
  });

  it("only a route that claims REAL FOOTAGE is counted — a drawn card was never a claim", () => {
    expect(GUARD).toContain("countsAsRealFootage");
  });

  it("the suspension keeps its own explanation, which this round did not remove", () => {
    expect(GUARD).toContain("the vision requirement is suspended for this adoption, not waived for the render");
  });
});
