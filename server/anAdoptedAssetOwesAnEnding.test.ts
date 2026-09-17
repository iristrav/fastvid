/**
 * VID-0589 — AN ADOPTED ASSET OWES AN ENDING, AND A REBUILD OWES ITS NAME.
 *
 * ── The asset this is about ─────────────────────────────────────────────────────────────────
 *
 *     [VisualFunnel] youtube_cc retrieved=1751 eligible=1 ranked=1 selected=1
 *       downloadStarted=104 downloadSucceeded=1 adopted=1 composed=0 finalVideo=0
 *     [YouTubeLifecycle] asset=youtube_cc:0fIJzO7EIYI scene=0 beat=0 vision=FIT adopted=yes
 *       prepared=yes compose=no cinematic=no render=no finalVideo=no delivered=no
 *       status=REPLACED reason=scene_resourced:scene_0_resourced ADOPTED→TRANSFORMED
 *
 * One clip out of 1751 candidates and 104 download attempts: found, downloaded, fair-use
 * transformed, judged FIT by the picture editor on its own beat, adopted. It never reached
 * compose. Scene 0 ran on colour fallbacks instead — `realClipRatio=0.20`, `6 kleur-fallback
 * beat(s) — sourcing faalde op die zinnen` — and the cinematic planner then dropped every one of
 * those beats for having no rehydratable identity.
 *
 * ── The two defects these tests hold ────────────────────────────────────────────────────────
 *
 * The asset did NOT vanish silently: `scene_resourced` was filed, which is the rule working. What
 * it could not say is WHICH rebuild did it. Fourteen call sites passed the identical context
 * string, so a compose-ready filter, a strict-voice refill, a guaranteed fill and a last-resort
 * generated card were one indistinguishable answer. Whether the rebuild was entitled to drop a
 * proven, approved asset is undecidable while that is true, so the site is now named and required.
 *
 * And separately, `endingOf` read ANY rejection in a record's history — including one filed after
 * adoption, including one on a derived copy — as `REJECTED_BEFORE_ADOPTION`, an EXPLAINED status.
 * An asset rejected on an earlier beat, adopted later, and then lost with nothing recorded was
 * therefore reported as explained, and the gap counter this module exists to produce could not
 * fire. The order is now asked.
 *
 * Nothing here weakens a gate. No compose barrier, vision threshold, eligibility rule or rights
 * check is touched: both changes are about what the record SAYS, and about making the next render
 * able to name the rebuild that must then be judged on its merits.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { VisualSourceLedger, type LineageStage } from "./visualSourceLineage";
import type { BeatRelevanceDecision, BeatRelevanceLedger } from "./beatVisualRelevance";
import { beatRelevanceBeatKey } from "./beatVisualRelevance";
import { YOUTUBE_PROVIDER, traceYoutubeLifecycle } from "./youtubeLifecycleTrace";

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ the harness, as the existing trace tests build it ═══════════════════════ */

const key = (hex: string) => `${YOUTUBE_PROVIDER}:${hex.padEnd(16, "0")}`;

const decision = (over: Partial<BeatRelevanceDecision> = {}): BeatRelevanceDecision =>
  ({ verdict: "fits", depicts: "", reason: "", evaluated: true, ...over }) as BeatRelevanceDecision;

const relevanceFitOn = (scene: number, beat: number, contentKey: string): BeatRelevanceLedger => {
  const ledger: BeatRelevanceLedger = {
    byBeat: new Map(),
    byContentKey: new Map(),
  } as unknown as BeatRelevanceLedger;
  ledger.byBeat.set(beatRelevanceBeatKey(scene, beat, "content", contentKey), {
    ctx: {} as never,
    decision: decision(),
  });
  return ledger;
};

type Filed = LineageStage | [LineageStage, { status?: string; reason?: string; gate?: string }];

/** One YouTube asset with the events named, filed in the order given. */
const ledgerOf = (opts: {
  contentKey: string;
  assetId: string;
  stages: Filed[];
  derivedStages?: Filed[];
}): VisualSourceLedger => {
  const ledger = new VisualSourceLedger({ renderId: "r1" });
  const file = (lineageId: string, filed: Filed[]) => {
    for (const entry of filed) {
      const [stage, o] = Array.isArray(entry) ? entry : [entry, {}];
      ledger.recordEvent(lineageId, stage, o as never);
    }
  };
  const record = ledger.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: opts.contentKey,
    contentKey: opts.contentKey,
    localPath: `/w/scene_0_ytfu_0__pid_youtube_cc-${opts.contentKey.split(":")[1]}.mp4`,
    provider: YOUTUBE_PROVIDER,
    providerAssetId: opts.assetId,
  });
  file(record.lineageId, opts.stages);
  if (opts.derivedStages?.length) {
    const child = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: `${opts.contentKey}#transformed`,
      contentKey: opts.contentKey,
      localPath: `/w/scene_0_ytfu_0__pid_youtube_cc-${opts.contentKey.split(":")[1]}_transformed.mp4`,
      parentLineageId: record.lineageId,
    });
    file(child.lineageId, opts.derivedStages);
  }
  return ledger;
};

const FOUND_TO_ADOPTED: Filed[] = [
  "ELIGIBLE",
  "RANKED",
  "SELECTED",
  "DOWNLOAD_STARTED",
  "DOWNLOAD_SUCCEEDED",
  "ADOPTED",
];

const traceOne = (led: VisualSourceLedger, k: string) =>
  traceYoutubeLifecycle(led, relevanceFitOn(0, 0, k))[0]!;

/* ═══════════ §1 — a rejection before adoption does not explain what came after ═══════════ */

describe("VID-0589 §1 — the ending is read in the order it happened", () => {
  it("an asset refused earlier, adopted later, then lost is a FINDING and not an explanation", () => {
    /**
     * The shape that made the counter unfireable. A candidate is turned down once — a beat it did
     * not suit, a look budget, an eligibility check — and a later route adopts it anyway. It then
     * leaves with nothing recorded. The old reader found the earlier REJECTED, called it
     * `REJECTED_BEFORE_ADOPTION`, and marked the row explained.
     */
    const k = key("aa");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "0fIJzO7EIYI",
        stages: [
          "ELIGIBLE",
          ["RANKED", { status: "REJECTED", gate: "beat_fit", reason: "another beat won it" }],
          "SELECTED",
          "DOWNLOAD_STARTED",
          "DOWNLOAD_SUCCEEDED",
          "ADOPTED",
        ],
      }),
      k
    );
    expect(row.adopted).toBe(true);
    expect(row.approvedForThisBeat).toBe(true);
    expect(row.status).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
    expect(row.violation).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
  });

  it("an asset never adopted keeps REJECTED_BEFORE_ADOPTION, which is what it is", () => {
    const k = key("bb");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "v2",
        stages: [["ELIGIBLE", { status: "REJECTED", gate: "eligibility", reason: "too short" }]],
      }),
      k
    );
    expect(row.adopted).toBe(false);
    expect(row.status).toBe("REJECTED_BEFORE_ADOPTION");
    expect(row.reason).toContain("eligibility");
    expect(row.violation).toBeNull();
  });

  it("a refusal AFTER adoption is an ending, under its own name", () => {
    /**
     * This one genuinely explains the asset: something was using it and a gate then turned it
     * away, with a reason. It must not be reported as a gap — and it must not be called "before".
     */
    const k = key("cc");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "v3",
        stages: [
          ...FOUND_TO_ADOPTED,
          ["TRIMMED", { status: "REJECTED", gate: "compose_gate", reason: "duration" }],
        ],
      }),
      k
    );
    expect(row.status).toBe("REJECTED_AFTER_ADOPTION");
    expect(row.reason).toContain("compose_gate");
    expect(row.violation).toBeNull();
  });

  it("a download that failed before a later attempt succeeded is not the ending either", () => {
    const k = key("dd");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "v4",
        stages: [
          "ELIGIBLE",
          "RANKED",
          "SELECTED",
          "DOWNLOAD_STARTED",
          ["DOWNLOAD_FAILED", { status: "FAILED", reason: "download_timeout" }],
          "DOWNLOAD_STARTED",
          "DOWNLOAD_SUCCEEDED",
          "ADOPTED",
        ],
      }),
      k
    );
    expect(row.status).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
  });

  it("a download that failed and was never adopted still reports DOWNLOAD_FAILED", () => {
    const k = key("ee");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "v5",
        stages: [
          "ELIGIBLE",
          "RANKED",
          "SELECTED",
          "DOWNLOAD_STARTED",
          ["DOWNLOAD_FAILED", { status: "FAILED", reason: "download_timeout" }],
        ],
      }),
      k
    );
    expect(row.status).toBe("DOWNLOAD_FAILED");
    expect(row.violation).toBeNull();
  });

  it("render 589's own ending still reads as REPLACED, with its reason", () => {
    /**
     * The regression guard on the fix. 589's asset HAS an ending — a rebuild filed one — and this
     * change must not turn a recorded, reasoned ending into a manufactured finding.
     */
    const k = key("ff");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "0fIJzO7EIYI",
        stages: [
          ...FOUND_TO_ADOPTED,
          "TRANSFORMED",
          [
            "REPLACED",
            { status: "REPLACED", reason: "scene_resourced:scene_0_resourced:guaranteed_fill" },
          ],
        ],
      }),
      k
    );
    expect(row.status).toBe("REPLACED");
    expect(row.reason).toContain("guaranteed_fill");
    expect(row.violation).toBeNull();
    expect(row.compose).toBe("no");
  });

  it("a delivered asset is FINAL whatever was said about it earlier", () => {
    const k = key("00aa");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "v7",
        stages: [
          ["ELIGIBLE", { status: "REJECTED", gate: "eligibility", reason: "first pass" }],
          ...FOUND_TO_ADOPTED,
          "COMPOSE_INPUT",
          "COMPOSE_SELECTED",
          "RENDER_INPUT",
          "FINAL_VIDEO",
          "DELIVERED",
        ],
      }),
      k
    );
    expect(row.status).toBe("FINAL");
    expect(row.violation).toBeNull();
  });

  it("a rejection on a DERIVED copy after adoption belongs to the asset, as an ending", () => {
    /**
     * `eventsWithDescendants` folds a transform's events into the root's. That is correct and is
     * also how a refusal of the derived file used to be read as a refusal of the original before
     * it was ever adopted.
     */
    const k = key("00bb");
    const row = traceOne(
      ledgerOf({
        contentKey: k,
        assetId: "v8",
        stages: FOUND_TO_ADOPTED,
        derivedStages: [["TRANSFORMED", { status: "REJECTED", gate: "transform", reason: "no video stream" }]],
      }),
      k
    );
    expect(row.status).toBe("REJECTED_AFTER_ADOPTION");
    expect(row.violation).toBeNull();
  });

  it("an adopted asset that reached compose and stopped there is still a finding", () => {
    /** The exact shape the brief forbids: ADOPTED → COMPOSE_INPUT → nothing. */
    const k = key("00cc");
    const row = traceOne(
      ledgerOf({ contentKey: k, assetId: "v9", stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] }),
      k
    );
    expect(row.composeInput).toBe(true);
    expect(row.compose).toBe("INPUT");
    expect(row.violation).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
    expect(row.missingStage).toBe("COMPOSE_SELECTED");
  });
});

/* ═══════════ §2 — every rebuild that can drop an adopted clip names itself ═══════════ */

describe("VID-0589 §2 — scene_resourced says which rebuild did it", () => {
  const body = (): string => {
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    expect(at, "noteSceneClipsResourced is gone").toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
  };

  it("the site is a required argument of a closed type, not a string a caller composes", () => {
    /**
     * The mechanism, not the spelling. A free-text context is what fourteen call sites copied
     * identically; a required parameter of a union type cannot be copied wrongly in silence, and a
     * fifteenth rebuild does not compile until it names itself.
     */
    expect(PIPELINE).toContain("type SceneResourceSite =");
    expect(body()).toContain("site: SceneResourceSite");
    expect(body()).toContain("const context = `scene_${sceneIndex}_resourced:${site}`");
  });

  it("no call site composes the context itself any more", () => {
    expect(PIPELINE, "a caller is still building the reason by hand").not.toMatch(
      /noteSceneClipsResourced\([^)]*_resourced`\)/
    );
  });

  it("every call site passes a site, and the rebuilds that can drop a clip are distinguishable", () => {
    const calls = [...PIPELINE.matchAll(/noteSceneClipsResourced\(([^;]*?)\);/gs)].map((m) => m[1]!);
    expect(calls.length, "the resourcing call sites moved").toBeGreaterThanOrEqual(14);
    const named = calls.map((c) => /,\s*"([a-z_]+)"\s*$/.exec(c.trim())?.[1] ?? null);
    expect(named.filter((n) => n == null), "an anonymous rebuild is back").toEqual([]);
    /**
     * The four that matter for 589: a compose-ready filter, a strict-voice refill, a guaranteed
     * fill and a single generated card are four different decisions about a proven asset, and the
     * record could not previously tell them apart.
     */
    for (const site of [
      "compose_ready_filter",
      "strict_voice_refill",
      "guaranteed_fill",
      "last_resort_ai_clip",
    ]) {
      expect(named, `${site} is not reachable from any call site`).toContain(site);
    }
  });

  it("the rule that a reasoned ending is never overwritten is untouched", () => {
    /** A clip a compose gate already refused keeps that reason; this never coarsens it. */
    expect(body()).toContain("hasOutcomeFor(clip, contentKey)");
    expect(body()).toContain('recordAssetOutcome(lineage, clip, "scene_resourced"');
  });

  it("a fetched, proven asset leaving by a rebuild is still said out loud and un-stranded", () => {
    /** RONDE 574's two behaviours. Renaming the site must not have cost either of them. */
    expect(body()).toContain("[SceneResourced]");
    expect(body()).toContain('record.providerStatus === "VERIFIED"');
    expect(body()).toContain("usedPaths?.delete(clip)");
    expect(body()).toContain("usedContentKeys?.delete(contentKey)");
  });
});
