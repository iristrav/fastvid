/**
 * RONDE 264 — FULL VISUAL PIPELINE ACCEPTANCE.
 *
 * The spec's own closing rule: the test that matters is not "VisualIntent exists" but whether ONE
 * real image can travel the whole route and arrive as THE SAME ASSET.
 *
 *     BEAT → INTENT → QUERY → CANDIDATE → ELIGIBLE → RANKED → SHORTLISTED → VISION FIT
 *          → ADOPTED → PREPARED → PUSHED → COMPOSED → CINEMATIC → RENDER INPUT → DELIVERED
 *
 *     sameCanonicalAssetAtStartAndEnd = true
 *     missingStages = 0
 *
 * ── WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────
 *
 * It drives the REAL ledger — `VisualSourceLedger`, `lifecyclesOf`, `formatLifecycleInvariants` —
 * with no stub in the path, and checks the sixteen stage assertions plus canonical identity at
 * both ends. So it proves three things:
 *
 *   · the route is REPRESENTABLE end to end, with one identity throughout;
 *   · a complete route is recognised as complete, with zero lineage errors;
 *   · A MISSING STAGE IS DETECTED. §5 removes each stage in turn and requires the acceptance to
 *     fail. An acceptance test that still passes with a hole in it proves nothing, and this
 *     codebase has been burned by exactly that shape more than once.
 *
 * IT DOES NOT PROVE THAT THE LIVE PIPELINE EMITS THESE EVENTS. That needs a production render,
 * which this round is forbidden to run. This is LEDGER-PROVEN, and the report says so rather than
 * calling it a passing pipeline.
 *
 * ── Why the ledger is the right surface for it ──────────────────────────────────────────────
 *
 * Every stage of every asset's life already funnels through this one object; it is where the
 * render's own invariants are computed and where `[LINEAGE_ERROR]` comes from. An acceptance test
 * that invented its own tracking would be a second reader of a contract that already has one, and
 * the whole defect class this project keeps finding is exactly that.
 */
import { describe, expect, it } from "vitest";

import {
  VisualSourceLedger,
  formatLifecycleInvariants,
  lifecyclesOf,
  type LineageStage,
} from "./visualSourceLineage";

/* ── the fixture: one 2024 celebrity-lawsuit beat and one YouTube candidate ────────────────── */

const BEAT = {
  sceneIndex: 2,
  beatIndex: 0,
  beatText: "Kim Kardashian was involved in a 2024 defamation lawsuit in Los Angeles County.",
};
const PROVIDER = "youtube_cc";
const PROVIDER_ASSET_ID = "ODx7fCL6BHw";
const QUERY = "Kim Kardashian Los Angeles County 2024 lawsuit";

/** Every stage the happy path must pass through, in the order the asset travels them. */
const HAPPY_PATH: LineageStage[] = [
  "FOUND",
  "ELIGIBLE",
  "RANKED",
  "SELECTED",
  "DOWNLOAD_STARTED",
  "DOWNLOAD_SUCCEEDED",
  "ADOPTED",
  "TRIMMED",
  "COMPOSED",
  "COMPOSE_INPUT",
  "COMPOSE_SELECTED",
  "CINEMATIC_SELECTED",
  "RENDER_INPUT",
  "DELIVERED",
];

type Acceptance = {
  checks: Record<string, boolean | string>;
  missingStages: LineageStage[];
  sameCanonicalAssetAtStartAndEnd: boolean;
  lineageErrors: string[];
  terminalStatus: string;
};

/**
 * Run one asset through the ledger and read back what the ledger says happened.
 *
 * `skip` omits stages, which is how §5 proves the acceptance can actually fail.
 */
function runAcceptance(opts: {
  visionVerdict: "FIT" | "MISMATCH";
  skip?: ReadonlySet<LineageStage>;
} = { visionVerdict: "FIT" }): Acceptance {
  const skip = opts.skip ?? new Set<LineageStage>();
  const ledger = new VisualSourceLedger({ renderId: "acceptance-1", videoId: 999 });

  const record = ledger.createLineage({
    ...BEAT,
    candidateId: `${PROVIDER}:${PROVIDER_ASSET_ID}`,
    contentKey: `provider:${PROVIDER}:${PROVIDER_ASSET_ID}`,
    localPath: "/tmp/acceptance/scene_2_b0_yt.mp4",
    provider: PROVIDER,
    providerAssetId: PROVIDER_ASSET_ID,
    sourceUrl: `https://www.youtube.com/watch?v=${PROVIDER_ASSET_ID}`,
    query: QUERY,
    searchRoute: "fetchYouTubeCCClips",
    route: "REAL_FUNNEL",
  });

  /** The identity the beat started from, captured before a single stage is recorded. */
  const identityAtStart = `${record.provider}:${record.providerAssetId}`;

  const visionFits = opts.visionVerdict === "FIT";
  for (const stage of HAPPY_PATH) {
    if (skip.has(stage)) continue;
    /** A mismatch stops the asset at Vision, exactly as the negative acceptance requires. */
    if (!visionFits && HAPPY_PATH.indexOf(stage) > HAPPY_PATH.indexOf("DOWNLOAD_SUCCEEDED")) break;
    ledger.recordEvent(record.lineageId, stage, { status: "OK" });
  }
  if (!visionFits) {
    ledger.recordEvent(record.lineageId, "REMOVED", {
      status: "REMOVED",
      reason: "vision_does_not_fit",
      gate: "vision",
    });
  }

  const records = ledger.allRecords();
  const events = ledger.allEvents();
  const [life] = lifecyclesOf(records, events);
  const seen = new Set(events.map((e) => e.stage));
  const reached = (s: LineageStage) => seen.has(s);

  const identityAtEnd = `${life!.provider}:${life!.providerAssetId}`;

  return {
    checks: {
      intentGenerated: Boolean(record.beatText && record.beatText.length > 0),
      queryGenerated: Boolean(record.query),
      contentAnchorPresent: Boolean(record.query?.includes("Kim Kardashian")),
      candidateRetrieved: reached("FOUND"),
      candidateEligible: reached("ELIGIBLE"),
      candidateRanked: reached("RANKED"),
      candidateShortlisted: reached("SELECTED"),
      visionExecuted: reached("DOWNLOAD_SUCCEEDED"),
      visionVerdict: opts.visionVerdict,
      adoptionApproved: reached("ADOPTED"),
      preparationCompleted: reached("TRIMMED"),
      pushCompleted: reached("COMPOSED"),
      composeSelected: reached("COMPOSE_SELECTED"),
      cinematicSelected: reached("CINEMATIC_SELECTED"),
      renderInputPresent: reached("RENDER_INPUT"),
      deliveryLineagePresent: reached("DELIVERED"),
    },
    missingStages: visionFits ? HAPPY_PATH.filter((s) => !seen.has(s)) : [],
    sameCanonicalAssetAtStartAndEnd:
      identityAtStart === identityAtEnd && identityAtEnd === `${PROVIDER}:${PROVIDER_ASSET_ID}`,
    lineageErrors: formatLifecycleInvariants([life!], {
      renderSucceeded: true,
      deliveryHappened: visionFits,
    }),
    terminalStatus: life!.terminalStatus,
  };
}

/* ═══════════ 1. the happy path — all sixteen ═══════════ */

describe("R264 §1 — fullVisualPipelineAcceptance", () => {
  const run = runAcceptance({ visionVerdict: "FIT" });

  it("ALL SIXTEEN CHECKS PASS", () => {
    expect(run.checks).toEqual({
      intentGenerated: true,
      queryGenerated: true,
      contentAnchorPresent: true,
      candidateRetrieved: true,
      candidateEligible: true,
      candidateRanked: true,
      candidateShortlisted: true,
      visionExecuted: true,
      visionVerdict: "FIT",
      adoptionApproved: true,
      preparationCompleted: true,
      pushCompleted: true,
      composeSelected: true,
      cinematicSelected: true,
      renderInputPresent: true,
      deliveryLineagePresent: true,
    });
  });

  it("missingStages = 0", () => {
    expect(run.missingStages).toEqual([]);
  });

  it("sameCanonicalAssetAtStartAndEnd = true", () => {
    expect(run.sameCanonicalAssetAtStartAndEnd).toBe(true);
  });

  it("and the ledger raises no lineage error on a complete route", () => {
    expect(run.lineageErrors).toEqual([]);
  });

  it("the terminal status is the one a delivered asset earns", () => {
    expect(run.terminalStatus).toBe("DELIVERED_INPUT");
  });
});

/* ═══════════ 2. the wrong visual ═══════════ */

describe("R264 §2 — a mismatched candidate travels no further", () => {
  const run = runAcceptance({ visionVerdict: "MISMATCH" });

  it("visionVerdict = MISMATCH", () => {
    expect(run.checks.visionVerdict).toBe("MISMATCH");
  });

  it("adoption = 0", () => {
    expect(run.checks.adoptionApproved).toBe(false);
  });

  it("renderInput = 0", () => {
    expect(run.checks.renderInputPresent).toBe(false);
  });

  it("delivery = 0", () => {
    expect(run.checks.deliveryLineagePresent).toBe(false);
  });

  it("AND IT IS NOT A LOSS — the refusal is a recorded terminal outcome", () => {
    expect(run.terminalStatus, "a refused candidate vanished instead of being refused").toBe(
      "REPLACED"
    );
    expect(run.lineageErrors, "a correct rejection was reported as a defect").toEqual([]);
  });
});

/* ═══════════ 3. identity survives the whole route ═══════════ */

describe("R264 §3 — the same asset at both ends", () => {
  it("the canonical identity is provider + providerAssetId, not a temp filename", () => {
    const ledger = new VisualSourceLedger({ renderId: "identity-1" });
    const rec = ledger.createLineage({
      ...BEAT,
      candidateId: `${PROVIDER}:${PROVIDER_ASSET_ID}`,
      contentKey: `provider:${PROVIDER}:${PROVIDER_ASSET_ID}`,
      localPath: "/tmp/scene_2_b0_yt_tmp.mp4",
      provider: PROVIDER,
      providerAssetId: PROVIDER_ASSET_ID,
    });
    for (const s of HAPPY_PATH) ledger.recordEvent(rec.lineageId, s, { status: "OK" });
    const [life] = lifecyclesOf(ledger.allRecords(), ledger.allEvents());
    expect(life!.providerAssetId).toBe(PROVIDER_ASSET_ID);
    expect(
      life!.providerAssetId,
      "the temporary filename became the asset's identity"
    ).not.toContain("scene_2_b0");
  });

  it("and the beat it belongs to is still the beat it started from", () => {
    const run = lifecyclesOf(
      (() => {
        const l = new VisualSourceLedger({ renderId: "identity-2" });
        l.createLineage({
          ...BEAT,
          candidateId: "c",
          contentKey: "k",
          localPath: "/tmp/x.mp4",
          provider: PROVIDER,
          providerAssetId: PROVIDER_ASSET_ID,
        });
        return l.allRecords();
      })(),
      []
    );
    expect(run[0]!.sceneIndex).toBe(2);
    expect(run[0]!.beatIndex).toBe(0);
  });
});

/* ═══════════ 4. what the acceptance is worth: it can fail ═══════════ */

describe("R264 §4 — a hole in the route is detected", () => {
  /**
   * The point of this section. An acceptance test that still reports sixteen passes with a stage
   * removed measures nothing, and every stage below is a place a real render has been observed to
   * lose an asset. Each one is removed in turn and the acceptance must notice.
   */
  /**
   * FOUND is excluded, and the exclusion is the finding. `createLineage` records it itself, so a
   * TRACKED candidate cannot lack it by construction — the first version of this section asserted
   * that removing FOUND would fail the acceptance, and it did not. That is the ledger being right
   * and the test being wrong, so the property is stated below rather than worked around.
   */
  const REMOVABLE = HAPPY_PATH.filter((s) => s !== "FOUND");

  it("FOUND cannot be missing: the ledger writes it when the record is opened", () => {
    const run = runAcceptance({ visionVerdict: "FIT", skip: new Set<LineageStage>(["FOUND"]) });
    expect(run.missingStages, "a tracked candidate existed without ever being found").toEqual([]);
  });

  it.each(REMOVABLE)("removing %s makes the acceptance fail", (stage) => {
    const run = runAcceptance({ visionVerdict: "FIT", skip: new Set([stage]) });
    const sixteenPass =
      Object.entries(run.checks).every(([k, v]) => (k === "visionVerdict" ? v === "FIT" : v === true));
    expect(
      sixteenPass && run.missingStages.length === 0,
      `a route missing ${stage} was accepted as complete`
    ).toBe(false);
    expect(run.missingStages).toContain(stage);
  });

  it("AND A DROPPED ADOPTED ASSET IS A REPORTED LINEAGE ERROR, not a quiet gap", () => {
    /**
     * Render 587's shape: adopted, and then nothing. The invariants added in RONDE 262 have to
     * catch it from inside the acceptance harness too, or the harness is checking a different
     * ledger from the one the render uses.
     */
    const run = runAcceptance({
      visionVerdict: "FIT",
      skip: new Set<LineageStage>([
        "COMPOSE_INPUT",
        "COMPOSE_SELECTED",
        "CINEMATIC_SELECTED",
        "RENDER_INPUT",
        "DELIVERED",
      ]),
    });
    expect(run.terminalStatus).toBe("UNEXPLAINED");
    expect(run.lineageErrors.join(" ")).toContain(
      "ADOPTED_ASSET_MISSING_CINEMATIC_TERMINAL_EVENT"
    );
  });
});
