/**
 * "DID A YOUTUBE CLIP THE EDITOR SAID YES TO DISAPPEAR BEFORE THE FILM?"
 *
 * Until this reader existed the only honest answer was INCONCLUSIVE, and not because the facts
 * were missing. They were in two registers that had never been read together:
 *
 *   the verdict    `BeatRelevanceLedger`   — what the picture editor said, per beat, per clip
 *   the lifecycle  `VisualSourceLedger`    — 23 stages from FOUND to DELIVERED
 *
 * `LINEAGE_STAGES` has no stage for a vision verdict, so the lineage alone can report "adopted and
 * then nothing" and can never report "approved and then nothing" — which is the one the question
 * was about. These tests are about the JOIN: that it is made on a key that can carry the claim,
 * that a derived file's ending still counts for the asset it came from, and above all that the
 * three ways of not knowing stay three different answers.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { VisualSourceLedger, type LineageStage } from "./visualSourceLineage";
import type { BeatRelevanceDecision, BeatRelevanceLedger } from "./beatVisualRelevance";
import { beatRelevanceBeatKey } from "./beatVisualRelevance";
import {
  YOUTUBE_PROVIDER,
  traceYoutubeLifecycle,
  youtubeLifecycleVerdict,
  youtubeLifecycleTotals,
  formatYoutubeLifecycle,
  youtubeLifecycleViolations,
} from "./youtubeLifecycleTrace";

/** The shape `providerAssetKey("youtube_cc", id)` writes: provider, then a 16-hex sha256 prefix. */
const key = (hex: string) => `${YOUTUBE_PROVIDER}:${hex.padEnd(16, "0")}`;

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

const emptyRelevance = (): BeatRelevanceLedger => ({
  byClipPath: new Map(),
  byContentKey: new Map(),
  byBeat: new Map(),
  spendByBeat: new Map(),
  finalSayRetried: new Set(),
});

/** A verdict filed the way the gate files one for a particular beat. */
const forBeat = (
  ledger: BeatRelevanceLedger,
  sceneIndex: number,
  beatIndex: number,
  contentKey: string,
  d: Partial<BeatRelevanceDecision>
) => {
  ledger.byBeat.set(beatRelevanceBeatKey(sceneIndex, beatIndex, "content", contentKey), {
    ctx: {} as never,
    decision: decision(d),
  });
  return ledger;
};

/** A verdict filed against the clip only, as `byContentKey` holds it — no beat attached. */
const forClip = (
  ledger: BeatRelevanceLedger,
  contentKey: string,
  d: Partial<BeatRelevanceDecision>
) => {
  ledger.byContentKey.set(contentKey, { ctx: {} as never, decision: decision(d) });
  return ledger;
};

type AssetSpec = {
  contentKey?: string;
  provider?: string | null;
  assetId?: string;
  scene?: number;
  beat?: number;
  stages?: LineageStage[];
  /** Stages filed against a DERIVED record — a trim, a pad, an overlay — instead of the root. */
  derivedStages?: LineageStage[];
};

/** A ledger holding exactly the assets described, with FOUND already filed by `createLineage`. */
const ledgerOf = (assets: AssetSpec[]): VisualSourceLedger => {
  const ledger = new VisualSourceLedger({ renderId: "r1" });
  assets.forEach((a, i) => {
    const contentKey = a.contentKey ?? key(`${i}`.repeat(2));
    const record = ledger.createLineage({
      sceneIndex: a.scene ?? 0,
      beatIndex: a.beat ?? 0,
      candidateId: contentKey,
      contentKey,
      localPath: `/w/clip_${i}__pid_youtube_cc-${contentKey.split(":")[1]}.mp4`,
      provider: a.provider === undefined ? YOUTUBE_PROVIDER : a.provider,
      providerAssetId: a.assetId ?? `vid${i}`,
    });
    for (const stage of a.stages ?? []) ledger.recordEvent(record.lineageId, stage, {});
    if (a.derivedStages?.length) {
      const child = ledger.createLineage({
        sceneIndex: a.scene ?? 0,
        beatIndex: a.beat ?? 0,
        candidateId: `${contentKey}#trim`,
        contentKey,
        localPath: `/w/clip_${i}_trimmed.mp4`,
        parentLineageId: record.lineageId,
      });
      for (const stage of a.derivedStages) ledger.recordEvent(child.lineageId, stage, {});
    }
  });
  return ledger;
};

const ADOPTED_TO_FILM: LineageStage[] = [
  "ADOPTED",
  "COMPOSE_INPUT",
  "COMPOSE_SELECTED",
  "RENDER_INPUT",
  "FINAL_VIDEO",
  "DELIVERED",
];

describe("1. an approved clip that reached the film is not a finding", () => {
  it("FIT → ADOPTED → … → DELIVERED raises nothing and answers NO", () => {
    const k = key("aa");
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, stages: ADOPTED_TO_FILM }]),
      forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vision).toBe("FIT");
    expect(rows[0]!.violation).toBeNull();
    expect(rows[0]!.missingStage).toBeNull();
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
    expect(youtubeLifecycleViolations(rows)).toEqual([]);
  });
});

describe("2. an ending with a reason attached is an ending", () => {
  /**
   * The distinction the whole module turns on. `FIT → ADOPTED → CINEMATIC_DROPPED` is a DECISION
   * somebody made and recorded; `FIT → ADOPTED → COMPOSE_INPUT → nothing` is a DISAPPEARANCE. A
   * reader that reported both would be reporting every render's normal shortlist churn as a defect.
   */
  it.each<LineageStage>(["CINEMATIC_DROPPED", "COMPOSE_DROPPED", "REPLACED", "REMOVED"])(
    "%s explains an approved clip's life, so nothing is reported",
    (terminal) => {
      const k = key("bb");
      const rows = traceYoutubeLifecycle(
        ledgerOf([{ contentKey: k, stages: ["ADOPTED", "COMPOSE_INPUT", terminal] }]),
        forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
      );
      expect(rows[0]!.violation).toBeNull();
      expect(youtubeLifecycleVerdict(rows)).toBe("NO");
    }
  );
});

describe("3. an approved clip whose life simply stops IS the finding", () => {
  const k = key("cc");
  const rows = traceYoutubeLifecycle(
    ledgerOf([{ contentKey: k, scene: 1, beat: 2, assetId: "dQw4", stages: ["ADOPTED", "COMPOSE_INPUT"] }]),
    forBeat(emptyRelevance(), 1, 2, k, { verdict: "fits" })
  );

  it("is named YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION and answers YES", () => {
    expect(rows[0]!.violation).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
    expect(youtubeLifecycleVerdict(rows)).toBe("YES");
  });

  it("says where it was last seen and what was expected next", () => {
    expect(rows[0]!.lastKnownStage).toBe("COMPOSE_INPUT");
    expect(rows[0]!.missingStage).toBe("COMPOSE_SELECTED");
  });

  it("the violation line names the asset, the beat and both stages", () => {
    const [line] = youtubeLifecycleViolations(rows);
    expect(line).toContain("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
    expect(line).toContain("youtube_cc:dQw4");
    expect(line).toContain("scene=1 beat=2");
    expect(line).toContain("lastKnownStage=COMPOSE_INPUT");
    expect(line).toContain("missingStage=COMPOSE_SELECTED");
  });
});

describe("4. an unapproved clip that vanished is a loose end, not the same finding", () => {
  it.each<[Partial<BeatRelevanceDecision>, string]>([
    [{ verdict: "does_not_fit", allowed: false }, "MISMATCH"],
    [{ verdict: "unknown" }, "UNCLEAR"],
    [{ verdict: "unknown", evaluated: false }, "NOT_ASKED"],
  ])("%o is reported as %s under YOUTUBE_ASSET_DOWNSTREAM_GAP", (d, outcome) => {
    const k = key("dd");
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, stages: ["ADOPTED", "COMPOSE_INPUT"] }]),
      forBeat(emptyRelevance(), 0, 0, k, d)
    );
    expect(rows[0]!.vision).toBe(outcome);
    expect(rows[0]!.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
    /** The question is about APPROVED footage. A gap under any other verdict does not answer YES. */
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
  });
});

describe("5. a decline is not a verdict", () => {
  /**
   * `evaluated: false` means the gate did not look — it was off, there was no narration, the
   * per-beat budget was spent. Reading that as `unknown` is the exact collapse `BeatRelevanceStatus`
   * was split apart to end, and it must not be re-made here.
   */
  it("NOT_ASKED is kept apart from UNCLEAR", () => {
    const declined = key("ee");
    const looked = key("ff");
    const rel = emptyRelevance();
    forBeat(rel, 0, 0, declined, { verdict: "unknown", evaluated: false });
    forBeat(rel, 0, 1, looked, { verdict: "unknown", evaluated: true });
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: declined, beat: 0, stages: ["ADOPTED"] },
        { contentKey: looked, beat: 1, stages: ["ADOPTED"] },
      ]),
      rel
    );
    expect(rows.map((r) => r.vision)).toEqual(["NOT_ASKED", "UNCLEAR"]);
    const t = youtubeLifecycleTotals(rows);
    expect(t.NOT_ASKED).toBe(1);
    expect(t.UNCLEAR).toBe(1);
    expect(t.FIT).toBe(0);
  });
});

describe("6. not finding a verdict is a fact about the report", () => {
  it("an asset with no entry anywhere is VISION_RECORD_MISSING, never NOT_ASKED", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("11"), stages: ["ADOPTED"] }]),
      emptyRelevance()
    );
    expect(rows[0]!.vision).toBe("VISION_RECORD_MISSING");
  });

  it("a render whose every row is unjoined answers INCONCLUSIVE, not NO", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("12"), stages: ["ADOPTED"] }]),
      undefined
    );
    expect(youtubeLifecycleVerdict(rows)).toBe("INCONCLUSIVE");
  });

  it("no YouTube at all is INCONCLUSIVE and prints nothing", () => {
    expect(youtubeLifecycleVerdict([])).toBe("INCONCLUSIVE");
    expect(formatYoutubeLifecycle([])).toEqual([]);
    expect(traceYoutubeLifecycle(undefined, emptyRelevance())).toEqual([]);
  });

  it("one joined row is enough to make the render's answer real", () => {
    const joined = key("13");
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: joined, beat: 0, stages: ["ADOPTED", "COMPOSE_INPUT"] },
        { contentKey: key("14"), beat: 1, stages: ["ADOPTED"] },
      ]),
      forBeat(emptyRelevance(), 0, 0, joined, { verdict: "fits" })
    );
    expect(youtubeLifecycleVerdict(rows)).toBe("YES");
  });
});

describe("7. a key that does not name the asset may not carry the claim", () => {
  /**
   * The key ladder's lower rungs are built from a filename and a byte count. An entry found under
   * one of those is evidence about whatever file last had that name — so the row says the join was
   * impossible rather than quoting a verdict it cannot stand behind.
   */
  it.each(["file:4210233:scene_2_b1.mp4", "scene_2_b1.mp4", "stock:vid:7", "still:abc123"])(
    "%s is reported as CONTENT_KEY_NOT_ASSET_IDENTITY",
    (contentKey) => {
      const rel = forClip(emptyRelevance(), contentKey, { verdict: "fits" });
      const rows = traceYoutubeLifecycle(
        ledgerOf([{ contentKey, stages: ["ADOPTED", "COMPOSE_INPUT"] }]),
        rel
      );
      expect(rows[0]!.vision).toBe("CONTENT_KEY_NOT_ASSET_IDENTITY");
      /** And emphatically not the FIT sitting right there under that key. */
      expect(rows[0]!.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
    }
  );

  it("an unjoinable render is INCONCLUSIVE, the same as an unjoined one", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: "file:1:a.mp4", stages: ["ADOPTED"] }]),
      emptyRelevance()
    );
    expect(youtubeLifecycleTotals(rows).CONTENT_KEY_NOT_ASSET_IDENTITY).toBe(1);
    expect(youtubeLifecycleVerdict(rows)).toBe("INCONCLUSIVE");
  });
});

describe("8. a verdict earned under one sentence is not an approval under another", () => {
  const k = key("22");

  it("the beat's own verdict is preferred over the clip-wide one", () => {
    const rel = forClip(emptyRelevance(), k, { verdict: "fits" });
    forBeat(rel, 3, 1, k, { verdict: "does_not_fit", allowed: false });
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, scene: 3, beat: 1, stages: ["ADOPTED"] }]),
      rel
    );
    expect(rows[0]!.vision).toBe("MISMATCH");
    expect(rows[0]!.visionFromOwnBeat).toBe(true);
  });

  it("a clip-wide verdict is still reported, and flagged as another beat's", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, scene: 3, beat: 1, stages: ["ADOPTED", "COMPOSE_INPUT"] }]),
      forClip(emptyRelevance(), k, { verdict: "fits" })
    );
    expect(rows[0]!.vision).toBe("FIT");
    expect(rows[0]!.visionFromOwnBeat).toBe(false);
    expect(formatYoutubeLifecycle(rows)[0]).toContain("(another beat's)");
  });
});

describe("9. a derived file's ending counts for the asset it was made from", () => {
  /**
   * The trim, the pad and the overlay each open a child record, and COMPOSE_INPUT onwards is filed
   * against the CHILD. Reading the root alone would report the parent of every delivered clip as
   * having vanished at adoption — the loudest false finding this module could produce.
   */
  it("a root that was trimmed and then delivered raises nothing", () => {
    const k = key("33");
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        {
          contentKey: k,
          stages: ["ADOPTED", "TRANSFORMED"],
          derivedStages: ["COMPOSE_INPUT", "RENDER_INPUT", "FINAL_VIDEO", "DELIVERED"],
        },
      ]),
      forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.violation).toBeNull();
    expect(rows[0]!.stages).toContain("DELIVERED");
  });

  it("a derived record is not a second asset in the report", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("34"), stages: ["ADOPTED"], derivedStages: ["COMPOSE_DROPPED"] }]),
      emptyRelevance()
    );
    expect(rows).toHaveLength(1);
    expect(youtubeLifecycleTotals(rows).tracked).toBe(1);
  });
});

describe("10. what the trace refuses to talk about", () => {
  it("a clip that was never adopted raises no lifecycle finding", () => {
    const k = key("44");
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, stages: ["ELIGIBLE", "RANKED", "SELECTED"] }]),
      forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
    );
    expect(rows[0]!.adopted).toBe(false);
    expect(rows[0]!.violation).toBeNull();
    expect(rows[0]!.lastKnownStage).toBeNull();
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
  });

  it("other providers are not traced here", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: "pexels:0123456789abcdef", provider: "pexels", stages: ["ADOPTED"] },
        { contentKey: null as never, provider: null, stages: ["ADOPTED"] },
        { contentKey: key("55"), stages: ["ADOPTED"] },
      ]),
      emptyRelevance()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contentKey).toBe(key("55"));
  });
});

describe("11. the report is deterministic and its totals come from its own rows", () => {
  const build = () =>
    traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: key("61"), scene: 2, beat: 0, stages: ["ADOPTED", "COMPOSE_INPUT"] },
        { contentKey: key("62"), scene: 0, beat: 3, stages: ADOPTED_TO_FILM },
        { contentKey: key("63"), scene: 0, beat: 1, stages: ["ADOPTED"] },
      ]),
      emptyRelevance()
    );

  it("rows are ordered by scene, then beat", () => {
    const rows = build();
    expect(rows.map((r) => [r.sceneIndex, r.beatIndex])).toEqual([
      [0, 1],
      [0, 3],
      [2, 0],
    ]);
    expect(formatYoutubeLifecycle(build())).toEqual(formatYoutubeLifecycle(build()));
  });

  it("every total is countable from the printed rows", () => {
    const rows = build();
    const t = youtubeLifecycleTotals(rows);
    expect(t.tracked).toBe(rows.length);
    expect(t.adopted).toBe(rows.filter((r) => r.adopted).length);
    expect(t.delivered).toBe(1);
    expect(t.finalVideo).toBe(1);
    expect(t.downstreamGap).toBe(rows.filter((r) => r.violation).length);
  });

  it("the printed block ends with the question it was built to answer", () => {
    const lines = formatYoutubeLifecycle(build());
    expect(lines.at(-2)).toContain("[YouTubeLifecycle] TOTAL");
    expect(lines.at(-1)).toContain("VERDICT INCONCLUSIVE");
    expect(lines.at(-1)).toContain("vanish before the film");
  });
});

describe("12. a reader, and nothing more than a reader", () => {
  const SRC = readFileSync(join(__dirname, "youtubeLifecycleTrace.ts"), "utf8");
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("files no lineage event and keeps no register of its own", () => {
    expect(CODE).not.toMatch(/recordEvent|recordEventForPath|createLineage|countProvider/);
    /**
     * Module scope holds nothing that can change. A `let` or a mutable collection at the top level
     * would make one render's report depend on the one before it — the exact defect a per-render
     * ledger exists to prevent, re-introduced in the reader instead of the register.
     */
    expect(CODE).not.toMatch(/^(let|var)\s/m);
    expect(CODE).not.toMatch(/^const\s+\w+\s*(:[^=]+)?=\s*new (Map|Array)\b/m);
  });

  it("throws nothing, so no render can fail because this report ran", () => {
    expect(CODE).not.toMatch(/\bthrow\b/);
    expect(CODE).not.toMatch(/pipelineError|assert[A-Z]/);
  });

  it("reads no configuration and writes to no stream", () => {
    expect(CODE).not.toMatch(/process\.env/);
    expect(CODE).not.toMatch(/console\./);
    expect(CODE).not.toMatch(/\bfs\b|readFileSync|writeFileSync/);
  });

  it("is wired into the render's own report, beside the trace it completes", () => {
    expect(PIPELINE).toContain('from "./youtubeLifecycleTrace"');
    const trace = PIPELINE.indexOf("traceYoutubeLifecycle(ledger, visualDedup.beatRelevance)");
    expect(trace).toBeGreaterThan(0);
    expect(PIPELINE.indexOf("formatYoutubeLifecycle(youtubeLifecycle)")).toBeGreaterThan(trace);
    expect(PIPELINE.indexOf("youtubeLifecycleViolations(youtubeLifecycle)")).toBeGreaterThan(trace);
  });

  it("the two registers it joins are the ones the render already keeps", () => {
    expect(CODE).toContain('from "./visualSourceLineage"');
    expect(CODE).toContain('from "./beatVisualRelevance"');
    /** The identity rule is asked for, not re-derived — one definition of what a real key is. */
    expect(CODE).toContain("isCanonicalAssetKey");
  });
});
