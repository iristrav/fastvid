/**
 * R191 — THREE THINGS A REPORT MUST NOT BE ABLE TO HIDE.
 *
 * ── §10/§11, and the misreading this file settles ────────────────────────────────────────────
 *
 * "Suspicious clips are filtered" was said about R190 and it was the wrong picture. What R190
 * filters is `offTopicSuspects` — a list of DOUBTS ABOUT clips, narrowed to the clips actually in
 * the delivered film. No clip has ever been dropped from a measurement.
 *
 * Reading it the other way leads somewhere bad. A round that "fixed" it by excluding suspicious
 * clips from the score would improve the number by deleting the evidence, which is the one repair
 * a quality report must never make — and which the round's own rules forbid by name.
 *
 * So the doubt gets a definition (`suspiciousDeliveredClip`), a count and a list, and the three
 * numbers are stated where nobody has to infer them: delivered, measured, excluded. `excluded` is
 * 0 by construction. These tests are what makes that a promise rather than today's behaviour.
 *
 * ── §19 — a bound that says whether it cost anything ─────────────────────────────────────────
 *
 * `SHORTLIST_FULL (8/8)` is true and answers nothing. Render 574's own funnel held the answer:
 *
 *     [BeatFunnel] s0b0 retrieved=2 eligible=43 ranked=2 shortlisted=8/8 notAsked=35
 *
 * Six of eight slots went to candidates nothing had ranked, while thirty-five eligible ones were
 * never asked about. Those numbers now travel with the refusal itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import {
  buildVideoQualityReport,
  recountQualityReportForDeliveredClips,
  suspiciousDeliveredClip,
} from "./videoQualityReport";
import {
  admitToShortlist,
  createBeatShortlistState,
  noteEligible,
  noteRanked,
  noteVisionAsked,
} from "./beatShortlist";

const PIPELINE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const QUALITY = readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");

/* ═══════════════════════ §10 — the doubt has one definition ═══════════════════════ */

describe("a clip is suspicious for a reason the pipeline can establish", () => {
  it("a clip whose source the ledger cannot name", () => {
    expect(suspiciousDeliveredClip("/tmp/a.mp4", { resolveSource: () => null })).toBe(
      "unproven_source"
    );
  });

  it('and "unknown" is the same fact spelled differently', () => {
    expect(suspiciousDeliveredClip("/tmp/a.mp4", { resolveSource: () => "unknown" })).toBe(
      "unproven_source"
    );
  });

  it("a frame the render drew itself is named as that, not as lost provenance", () => {
    /** A colour card has no provider to have lost. Two different findings, two different fixes. */
    expect(
      suspiciousDeliveredClip("/tmp/card.mp4", {
        resolveSource: () => null,
        isGeneratedClip: () => true,
      })
    ).toBe("drawn_not_fetched");
  });

  it("a clip nothing can key is named as that", () => {
    expect(
      suspiciousDeliveredClip("/tmp/a.mp4", {
        resolveSource: () => "pexels",
        contentKeyOf: () => undefined,
      })
    ).toBe("no_content_identity");
  });

  it("a proven clip is not suspicious", () => {
    expect(
      suspiciousDeliveredClip("/tmp/a.mp4", {
        resolveSource: () => "internet_archive",
        contentKeyOf: () => "internet_archive:abc",
      })
    ).toBeNull();
  });

  it("with nothing to ask, it says nothing rather than guessing", () => {
    /** No resolver means no evidence. A doubt with no basis is a guess, and guesses do not belong. */
    expect(suspiciousDeliveredClip("/tmp/a.mp4")).toBeNull();
  });
});

/* ═══════════════════════ §11 — and it can never hide a clip ═══════════════════════ */

describe("delivered, measured and excluded are all stated", () => {
  const clips = ["/tmp/a_pex.mp4", "/tmp/b_pex.mp4", "/tmp/c_arch.mp4"];
  const report = () =>
    buildVideoQualityReport(clips, "Berlin 1945", {
      resolveSource: (p) => (p.includes("pex") ? "pexels" : null),
    });

  it("every delivered clip is measured", () => {
    const r = report();
    expect(r.clipAccounting?.delivered).toBe(3);
    expect(r.clipAccounting?.measured).toBe(3);
  });

  it("nothing is excluded, and the number says so out loud", () => {
    expect(report().clipAccounting?.excluded).toBe(0);
  });

  it("the suspicious one is counted and named, and still measured", () => {
    const r = report();
    expect(r.clipAccounting?.suspicious).toEqual([
      { basename: "c_arch.mp4", reason: "unproven_source" },
    ]);
    expect(r.totalClips).toBe(3);
  });

  it("the accounting follows a recount onto the delivered file", () => {
    const r = report();
    recountQualityReportForDeliveredClips(r, clips.slice(0, 2), {
      resolveSource: () => "pexels",
    });
    expect(r.clipAccounting).toMatchObject({ delivered: 2, measured: 2, excluded: 0 });
    expect(r.clipAccounting?.suspicious).toEqual([]);
  });

  it("measured is never smaller than delivered — the exclusion path does not exist", () => {
    /**
     * A structural claim, not a behavioural one: the only place the three numbers are built sets
     * `measured` from the same list as `delivered`. A future round that wants to exclude has to
     * change that line, and will find the comment explaining why it should not.
     */
    expect(QUALITY).toContain("delivered: unique.length, measured: unique.length, excluded: 0");
  });
});

/* ═══════════════════════ §19 — the bound says what it cost ═══════════════════════ */

describe("SHORTLIST_FULL says why, not just that", () => {
  function fullBeat() {
    const state = createBeatShortlistState();
    /** `noteEligible` counts one at a time, the way the funnel is really filled. */
    for (let i = 0; i < 43; i++) noteEligible(state, 0, 0);
    noteRanked(state, 0, 0, 2);
    for (let i = 0; i < 8; i++) noteVisionAsked(state, 0, 0, `key${i}`);
    for (let i = 0; i < 8; i++) admitToShortlist(state, 0, 0, `key${i}`, 8);
    return admitToShortlist(state, 0, 0, "one-too-many", 8);
  }

  it("the refusal is still SHORTLIST_FULL", () => {
    const out = fullBeat();
    expect(out.admitted).toBe(false);
    expect(out.admitted === false && out.reason).toBe("SHORTLIST_FULL");
  });

  it("it carries how many were eligible", () => {
    expect(fullBeat().admitted === false && fullBeat().eligible).toBe(43);
  });

  it("it carries how many were ranked — the question of best vs earliest", () => {
    expect(fullBeat().admitted === false && fullBeat().ranked).toBe(2);
  });

  it("and how many eligible candidates nobody looked at", () => {
    expect(fullBeat().admitted === false && fullBeat().unreviewed).toBe(35);
  });

  it("the cap itself is unchanged — the bound is not the fault", () => {
    /** §14: raising it is forbidden as a fix. The editor approved 14 of 95 asks on 574. */
    const state = createBeatShortlistState();
    for (let i = 0; i < 8; i++) {
      expect(admitToShortlist(state, 0, 0, `k${i}`, 8).admitted).toBe(true);
    }
    expect(admitToShortlist(state, 0, 0, "k8", 8).admitted).toBe(false);
  });

  it("an admitted candidate carries no explanation, because there is nothing to explain", () => {
    const state = createBeatShortlistState();
    const ok = admitToShortlist(state, 0, 0, "k0", 8);
    expect(ok.admitted).toBe(true);
    expect("eligible" in ok).toBe(false);
  });

  it("the per-candidate line prints the three numbers", () => {
    const at = PIPELINE.indexOf("[BeatShortlist] s${scene.index}b${beat.index} not asked");
    expect(at).toBeGreaterThan(-1);
    const line = PIPELINE.slice(at, at + 1200);
    expect(line).toContain("admission.eligible");
    expect(line).toContain("admission.ranked");
    expect(line).toContain("admission.unreviewed");
  });
});

/* ═══════════════════════ §27 — one rule, one place ═══════════════════════ */

describe("no reader grows its own copy of a shared decision", () => {
  it("every compose reader that can fall back reads clipsForScene", () => {
    /**
     * The seam this codebase keeps rediscovering: four readers, three inline copies of one rule,
     * and a fourth reader with none. A new inline copy is what this looks for.
     */
    const copies = PIPELINE.split("composedUsedClips[i]!.length > 0 ?").length - 1;
    expect(copies, "an inline copy of the compose fallback is back").toBe(0);
    expect(PIPELINE).toContain("const clipsForScene = (i: number): string[] =>");
  });

  it("the editor, the review and the critical review all call it", () => {
    expect(PIPELINE).toContain("const clipsToReview = clipsForScene(i);");
    expect(PIPELINE).toContain("sceneReviewInputs(scenes, scenes.map((_, i) => clipsForScene(i)))");
    const at = PIPELINE.indexOf("editorScenes = await buildEditorScenesFromPipeline(");
    expect(PIPELINE.slice(at, at + 320)).toContain("clipsForScene(i)");
  });

  it("the adapter's self-check runs before the plan is handed on", () => {
    const production = readFileSync(path.join(__dirname, "cinematicProduction.ts"), "utf8");
    const check = production.indexOf("built.adapterIssues.length > 0");
    const validate = production.indexOf("validateTimeline(");
    expect(check, "the adapter self-check is gone").toBeGreaterThan(-1);
    expect(check, "the self-check must precede the global validator").toBeLessThan(validate);
  });

  it("an adapter refusal has its own code, distinct from the validator's", () => {
    const production = readFileSync(path.join(__dirname, "cinematicProduction.ts"), "utf8");
    expect(production).toContain('ADAPTER_INVALID: "CINEMATIC_ADAPTER_INVALID"');
    expect(production).toContain('TIMELINE_INVALID: "CINEMATIC_TIMELINE_INVALID"');
  });

  it("the composed source range is checked where the two trims meet", () => {
    const edl = readFileSync(path.join(__dirname, "edlToTimeline.ts"), "utf8");
    expect(edl).toContain("INVALID_SOURCE_RANGE");
    expect(edl).toContain("const composedIn =");
    expect(edl).toContain("const composedOut =");
  });
});
