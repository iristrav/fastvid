/**
 * WHERE DOES EVERY YOUTUBE PICTURE STOP?
 *
 * Until this reader existed the render could say how many YouTube assets it found and nothing
 * about what became of any of them — and the facts were not missing, they were in registers that
 * had never been read against one another:
 *
 *   the verdict    `BeatRelevanceLedger`   — what the picture editor said, per beat, per clip
 *   the lifecycle  `VisualSourceLedger`    — 23 stages with statuses and reasons attached
 *   the capacity   `BeatImageGateState`    — whether this render had a picture editor at all
 *
 * `LINEAGE_STAGES` has no stage for a vision verdict, so the lineage alone can report "adopted and
 * then nothing" and can never report "approved and then nothing" — which is the one the question
 * was about. These tests are about the JOIN: that it is made on a key that can carry the claim,
 * on the beat that earned it, within this render; that a derived file's ending still counts for
 * the asset it came from; and above all that six ways of not being in the film stay six different
 * answers.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { VisualSourceLedger, type LineageStage } from "./visualSourceLineage";
import type { BeatRelevanceDecision, BeatRelevanceLedger } from "./beatVisualRelevance";
import { beatRelevanceBeatKey } from "./beatVisualRelevance";
import {
  YOUTUBE_PROVIDER,
  YOUTUBE_LIFECYCLE_COLUMNS,
  traceYoutubeLifecycle,
  youtubeLifecycleVerdict,
  youtubeLifecycleTotals,
  formatYoutubeLifecycle,
  formatYoutubeLifecycleTable,
  formatYoutubeVisionAvailability,
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

type Filed = LineageStage | [LineageStage, { status?: string; reason?: string; gate?: string }];

type AssetSpec = {
  contentKey?: string;
  provider?: string | null;
  assetId?: string;
  scene?: number;
  beat?: number;
  stages?: Filed[];
  /** Stages filed against a DERIVED record — a trim, a pad, an overlay — instead of the root. */
  derivedStages?: Filed[];
};

/** A ledger holding exactly the assets described, with FOUND already filed by `createLineage`. */
const ledgerOf = (assets: AssetSpec[]): VisualSourceLedger => {
  const ledger = new VisualSourceLedger({ renderId: "r1" });
  const file = (lineageId: string, filed: Filed[]) => {
    for (const entry of filed) {
      const [stage, opts] = Array.isArray(entry) ? entry : [entry, {}];
      ledger.recordEvent(lineageId, stage, opts as never);
    }
  };
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
    file(record.lineageId, a.stages ?? []);
    if (a.derivedStages?.length) {
      const child = ledger.createLineage({
        sceneIndex: a.scene ?? 0,
        beatIndex: a.beat ?? 0,
        candidateId: `${contentKey}#trim`,
        contentKey,
        localPath: `/w/clip_${i}_trimmed.mp4`,
        parentLineageId: record.lineageId,
      });
      file(child.lineageId, a.derivedStages);
    }
  });
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

// ── §13 — the eight lifecycles the spec names ──────────────────────────────────────────────

describe("TEST 1 — approved, adopted, composed, cinematic, rendered, delivered", () => {
  const k = key("aa");
  const rows = traceYoutubeLifecycle(
    ledgerOf([
      {
        contentKey: k,
        stages: [
          ...FOUND_TO_ADOPTED,
          "TRIMMED",
          "COMPOSE_INPUT",
          "COMPOSE_SELECTED",
          "CINEMATIC_SELECTED",
          "RENDER_INPUT",
          "FINAL_VIDEO",
          "DELIVERED",
        ],
      },
    ]),
    forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
  );

  it("status is FINAL and no invariant fires", () => {
    expect(rows[0]!.status).toBe("FINAL");
    expect(rows[0]!.violation).toBeNull();
    expect(youtubeLifecycleViolations(rows)).toEqual([]);
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
  });

  it("every stage of the walk is reported, not only the ending", () => {
    const r = rows[0]!;
    expect([r.found, r.eligible, r.ranked, r.selected, r.downloaded, r.prepared]).toEqual([
      true, true, true, true, true, true,
    ]);
    expect([r.compose, r.cinematic, r.render]).toEqual(["SELECTED", "SELECTED", "INPUT"]);
    expect([r.finalVideo, r.delivered]).toEqual([true, true]);
  });
});

describe("TEST 2 — approved, adopted, then the compose filter said no", () => {
  const k = key("bb");
  const rows = traceYoutubeLifecycle(
    ledgerOf([
      {
        contentKey: k,
        stages: [
          ...FOUND_TO_ADOPTED,
          "COMPOSE_INPUT",
          "COMPOSE_SELECTED",
          ["COMPOSE_DROPPED", { status: "REMOVED", reason: "superseded_by_winner" }],
        ],
      },
    ]),
    forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
  );

  it("status is COMPOSE_DROPPED", () => {
    expect(rows[0]!.status).toBe("COMPOSE_DROPPED");
    expect(rows[0]!.compose).toBe("DROPPED");
    expect(rows[0]!.violation).toBeNull();
  });

  it("the reason is the one the render recorded, quoted and not invented", () => {
    expect(rows[0]!.reason).toBe("superseded_by_winner");
  });
});

describe("TEST 3 — approved, adopted, then the cinematic planner said no", () => {
  const k = key("cc");
  const rows = traceYoutubeLifecycle(
    ledgerOf([
      {
        contentKey: k,
        stages: [
          ...FOUND_TO_ADOPTED,
          "CINEMATIC_SELECTED",
          ["CINEMATIC_DROPPED", { status: "REMOVED", reason: "scene_rebuilt_without_clip" }],
        ],
      },
    ]),
    forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
  );

  it("status is CINEMATIC_DROPPED with its own reason", () => {
    expect(rows[0]!.status).toBe("CINEMATIC_DROPPED");
    expect(rows[0]!.cinematic).toBe("DROPPED");
    expect(rows[0]!.reason).toBe("scene_rebuilt_without_clip");
    expect(rows[0]!.violation).toBeNull();
  });
});

describe("TEST 4 — approved, adopted, handed to compose, and then nothing", () => {
  const k = key("dd");
  const rows = traceYoutubeLifecycle(
    ledgerOf([
      { contentKey: k, scene: 1, beat: 2, assetId: "dQw4", stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] },
    ]),
    forBeat(emptyRelevance(), 1, 2, k, { verdict: "fits" })
  );

  it("is YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION", () => {
    expect(rows[0]!.status).toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
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

describe("TEST 5 — refused by the editor and never used", () => {
  const k = key("ee");
  const rows = traceYoutubeLifecycle(
    ledgerOf([{ contentKey: k, stages: ["ELIGIBLE", "RANKED"] }]),
    forBeat(emptyRelevance(), 0, 0, k, { verdict: "does_not_fit", allowed: false })
  );

  it("status is NOT_ADOPTED and no invariant fires", () => {
    expect(rows[0]!.vision).toBe("MISMATCH");
    expect(rows[0]!.adopted).toBe(false);
    expect(rows[0]!.status).toBe("NOT_ADOPTED");
    expect(rows[0]!.violation).toBeNull();
    expect(youtubeLifecycleVerdict(rows)).toBe("NO");
  });
});

describe("TEST 6 — no verdict is not a verdict", () => {
  it("a missing vision record is neither FIT nor a vanished asset", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("ff"), stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] }]),
      emptyRelevance()
    );
    expect(rows[0]!.vision).toBe("VISION_RECORD_MISSING");
    expect(rows[0]!.approvedForThisBeat).toBe(false);
    expect(rows[0]!.status).not.toBe("YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION");
    /** The gap is still reported — under a name that does not claim an approval. */
    expect(rows[0]!.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
    expect(youtubeLifecycleVerdict(rows)).toBe("INCONCLUSIVE");
  });
});

describe("TEST 7 — a FIT belongs to the sentence it was earned under", () => {
  const k = key("11");

  it("a verdict for beat A does not approve the same clip on beat B", () => {
    /** The record sits on s2b5; the only `fits` in the ledger was earned at s1b2. */
    const rel = forBeat(emptyRelevance(), 1, 2, k, { verdict: "fits" });
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, scene: 2, beat: 5, stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] }]),
      rel
    );
    expect(rows[0]!.approvedForThisBeat).toBe(false);
    expect(rows[0]!.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
    /**
     * And the render's answer is INCONCLUSIVE rather than NO: no verdict was found FOR THIS BEAT,
     * so this report has nothing to say about whether an approved picture was lost — which is a
     * statement about the evidence, exactly as it should be.
     */
    expect(rows[0]!.vision).toBe("VISION_RECORD_MISSING");
    expect(youtubeLifecycleVerdict(rows)).toBe("INCONCLUSIVE");
  });

  it("a clip-wide entry is shown as evidence and flagged as another beat's", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, scene: 2, beat: 5, stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] }]),
      forClip(emptyRelevance(), k, { verdict: "fits" })
    );
    expect(rows[0]!.vision).toBe("FIT");
    expect(rows[0]!.visionFromOwnBeat).toBe(false);
    expect(rows[0]!.approvedForThisBeat).toBe(false);
    expect(formatYoutubeLifecycle(rows)[0]).toContain("(another beat's)");
    /** Reported, never promoted: the strong finding needs the beat's own yes. */
    expect(rows[0]!.violation).toBe("YOUTUBE_ASSET_DOWNSTREAM_GAP");
  });

  it("the beat's own verdict wins over the clip-wide one", () => {
    const rel = forClip(emptyRelevance(), k, { verdict: "fits" });
    forBeat(rel, 3, 1, k, { verdict: "does_not_fit", allowed: false });
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, scene: 3, beat: 1, stages: FOUND_TO_ADOPTED }]),
      rel
    );
    expect(rows[0]!.vision).toBe("MISMATCH");
    expect(rows[0]!.visionFromOwnBeat).toBe(true);
  });

  it("the totals keep the two apart", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, scene: 2, beat: 5, stages: FOUND_TO_ADOPTED }]),
      forClip(emptyRelevance(), k, { verdict: "fits" })
    );
    const t = youtubeLifecycleTotals(rows);
    expect(t.youtubeVisionFit).toBe(1);
    expect(t.youtubeVisionFitForThisBeat).toBe(0);
  });
});

describe("TEST 8 — one render's evidence may not explain another render's picture", () => {
  /**
   * The ledger is created per render and discarded with it, so this cannot normally happen — which
   * is exactly why the guard is worth stating rather than assuming. A rehydrated snapshot or a
   * shared cache is all it would take for an approval earned last week to explain a picture missing
   * today.
   */
  const foreign = (renderId: string) => {
    const real = ledgerOf([{ contentKey: key("22"), stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] }]);
    const records = real.allRecords().map((r) => ({ ...r, renderId }));
    return { renderId: "r1", allRecords: () => records, allEvents: () => real.allEvents() } as never;
  };

  it("a record stamped with another renderId is not traced", () => {
    expect(traceYoutubeLifecycle(foreign("r0"), emptyRelevance())).toEqual([]);
  });

  it("the same record stamped with this render's id is traced", () => {
    expect(traceYoutubeLifecycle(foreign("r1"), emptyRelevance())).toHaveLength(1);
  });
});

// ── The rest of the lifecycle vocabulary ───────────────────────────────────────────────────

describe("a gate that refused an asset said so, and that is an ending", () => {
  it("a rejection is read as a refusal, not as passing the stage it was filed on", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        {
          contentKey: key("33"),
          stages: [["ELIGIBLE", { status: "REJECTED", gate: "license_rejected", reason: "LICENSE_UNKNOWN" }]],
        },
      ]),
      emptyRelevance()
    );
    expect(rows[0]!.eligible).toBe(false);
    expect(rows[0]!.status).toBe("REJECTED_BEFORE_ADOPTION");
    expect(rows[0]!.reason).toBe("license_rejected: LICENSE_UNKNOWN");
    expect(rows[0]!.violation).toBeNull();
  });

  it("bytes that never arrived are DOWNLOAD_FAILED, not a disappearance", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        {
          contentKey: key("34"),
          stages: ["SELECTED", "DOWNLOAD_STARTED", ["DOWNLOAD_FAILED", { status: "FAILED", reason: "timeout" }]],
        },
      ]),
      emptyRelevance()
    );
    expect(rows[0]!.status).toBe("DOWNLOAD_FAILED");
    expect(rows[0]!.downloaded).toBe(false);
    expect(rows[0]!.violation).toBeNull();
  });

  it("handed to the renderer and absent from its output is named, not left open", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("35"), stages: [...FOUND_TO_ADOPTED, "COMPOSE_SELECTED", "RENDER_INPUT"] }]),
      emptyRelevance()
    );
    expect(rows[0]!.status).toBe("RENDER_INPUT_NOT_IN_FINAL");
  });

  it.each<LineageStage>(["REPLACED", "REMOVED"])("%s is its own recorded ending", (stage) => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("36"), stages: [...FOUND_TO_ADOPTED, [stage, { reason: "swapped" }]] }]),
      emptyRelevance()
    );
    expect(rows[0]!.status).toBe(stage);
    expect(rows[0]!.violation).toBeNull();
  });
});

describe("the six ways of not being in the film are six different words", () => {
  it("NOT_ASKED, MISMATCH and UNCLEAR are never collapsed into one another", () => {
    const declined = key("41");
    const refused = key("42");
    const unsure = key("43");
    const rel = emptyRelevance();
    forBeat(rel, 0, 0, declined, { verdict: "unknown", evaluated: false });
    forBeat(rel, 0, 1, refused, { verdict: "does_not_fit", allowed: false });
    forBeat(rel, 0, 2, unsure, { verdict: "unknown", evaluated: true });
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: declined, beat: 0, stages: ["ADOPTED"] },
        { contentKey: refused, beat: 1, stages: ["ADOPTED"] },
        { contentKey: unsure, beat: 2, stages: ["ADOPTED"] },
      ]),
      rel
    );
    expect(rows.map((r) => r.vision)).toEqual(["NOT_ASKED", "MISMATCH", "UNCLEAR"]);
  });

  /**
   * VISION_UNAVAILABLE is a fact about the RENDER — a provider that could not be reached — and the
   * gate keeps a counter for it precisely so no reader has to match on the wording of a reason.
   * So it is reported once, for the render, and never guessed at per picture.
   */
  it("VISION_UNAVAILABLE is reported for the render, not claimed per picture", () => {
    const k = key("44");
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, stages: ["ADOPTED"] }]),
      forBeat(emptyRelevance(), 0, 0, k, { verdict: "unknown", evaluated: false })
    );
    expect(rows[0]!.vision).toBe("NOT_ASKED");

    const blind = formatYoutubeVisionAvailability(
      { judgementsProviderUnavailable: 23, askImpossible: true },
      rows
    );
    expect(blind[0]).toContain("renderProviderUnavailable=23");
    expect(blind[0]).toContain("VISION_UNAVAILABLE");

    const thrifty = formatYoutubeVisionAvailability(
      { judgementsProviderUnavailable: 0, askImpossible: false },
      rows
    );
    expect(thrifty[0]).toContain("renderCouldNotAsk=no");
    expect(thrifty[0]).not.toContain("VISION_UNAVAILABLE");
  });

  it("a render with nothing to say about availability says nothing", () => {
    const k = key("45");
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: k, stages: ["ADOPTED"] }]),
      forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
    );
    expect(formatYoutubeVisionAvailability({}, rows)).toEqual([]);
    expect(formatYoutubeVisionAvailability(undefined, [])).toEqual([]);
  });
});

describe("a key that does not name the asset may not carry the claim", () => {
  /**
   * The key ladder's lower rungs are built from a filename and a byte count. An entry found under
   * one of those is evidence about whatever file last had that name — so the row says the join was
   * impossible rather than quoting a verdict it cannot stand behind.
   */
  it.each(["file:4210233:scene_2_b1.mp4", "scene_2_b1.mp4", "stock:vid:7", "still:abc123"])(
    "%s is reported as CONTENT_KEY_NOT_ASSET_IDENTITY",
    (contentKey) => {
      const rows = traceYoutubeLifecycle(
        ledgerOf([{ contentKey, stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] }]),
        forClip(emptyRelevance(), contentKey, { verdict: "fits" })
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
    expect(youtubeLifecycleTotals(rows).youtubeContentKeyNotAssetIdentity).toBe(1);
    expect(youtubeLifecycleVerdict(rows)).toBe("INCONCLUSIVE");
  });
});

describe("a derived file's ending counts for the asset it was made from", () => {
  /**
   * The trim, the pad and the overlay each open a child record, and COMPOSE_INPUT onwards is filed
   * against the CHILD. Reading the root alone would report the parent of every delivered clip as
   * having vanished at adoption — the loudest false finding this module could produce.
   */
  it("a root that was trimmed and then delivered raises nothing", () => {
    const k = key("51");
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        {
          contentKey: k,
          stages: [...FOUND_TO_ADOPTED, "TRANSFORMED"],
          derivedStages: ["COMPOSE_INPUT", "RENDER_INPUT", "FINAL_VIDEO", "DELIVERED"],
        },
      ]),
      forBeat(emptyRelevance(), 0, 0, k, { verdict: "fits" })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("FINAL");
    expect(rows[0]!.violation).toBeNull();
  });

  it("a derived record is not a second asset in the report", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([{ contentKey: key("52"), stages: ["ADOPTED"], derivedStages: ["COMPOSE_DROPPED"] }]),
      emptyRelevance()
    );
    expect(rows).toHaveLength(1);
    expect(youtubeLifecycleTotals(rows).youtubeTracked).toBe(1);
  });
});

describe("what the trace refuses to talk about", () => {
  it("other providers are not traced here", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: "pexels:0123456789abcdef", provider: "pexels", stages: ["ADOPTED"] },
        { contentKey: null as never, provider: null, stages: ["ADOPTED"] },
        { contentKey: key("61"), stages: ["ADOPTED"] },
      ]),
      emptyRelevance()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contentKey).toBe(key("61"));
  });

  it("no YouTube at all prints nothing at all", () => {
    expect(youtubeLifecycleVerdict([])).toBe("INCONCLUSIVE");
    expect(formatYoutubeLifecycle([])).toEqual([]);
    expect(formatYoutubeLifecycleTable([])).toEqual([]);
    expect(traceYoutubeLifecycle(undefined, emptyRelevance())).toEqual([]);
  });
});

describe("the report is deterministic and its totals come from its own rows", () => {
  const build = () =>
    traceYoutubeLifecycle(
      ledgerOf([
        { contentKey: key("71"), scene: 2, beat: 0, stages: [...FOUND_TO_ADOPTED, "COMPOSE_INPUT"] },
        {
          contentKey: key("72"),
          scene: 0,
          beat: 3,
          stages: [...FOUND_TO_ADOPTED, "COMPOSE_SELECTED", "RENDER_INPUT", "FINAL_VIDEO", "DELIVERED"],
        },
        { contentKey: key("73"), scene: 0, beat: 1, stages: ["ELIGIBLE"] },
      ]),
      emptyRelevance()
    );

  it("rows are ordered by scene, then beat", () => {
    expect(build().map((r) => [r.sceneIndex, r.beatIndex])).toEqual([
      [0, 1],
      [0, 3],
      [2, 0],
    ]);
    expect(formatYoutubeLifecycle(build())).toEqual(formatYoutubeLifecycle(build()));
  });

  it("every §10 counter is countable from the printed rows", () => {
    const rows = build();
    const t = youtubeLifecycleTotals(rows);
    expect(t.youtubeTracked).toBe(rows.length);
    expect(t.youtubeFound).toBe(3);
    expect(t.youtubeEligible).toBe(3);
    expect(t.youtubeSelected).toBe(2);
    expect(t.youtubeDownloaded).toBe(2);
    expect(t.youtubeAdopted).toBe(2);
    expect(t.youtubeComposeInput).toBe(1);
    expect(t.youtubeComposeSelected).toBe(1);
    expect(t.youtubeRenderInput).toBe(1);
    expect(t.youtubeFinalVideo).toBe(1);
    expect(t.youtubeDelivered).toBe(1);
    expect(t.youtubeDownstreamGap).toBe(rows.filter((r) => r.violation).length);
  });

  it("the spec's counter names all exist, spelled as the spec spells them", () => {
    const t = youtubeLifecycleTotals(build());
    for (const name of [
      "youtubeFound",
      "youtubeEligible",
      "youtubeRanked",
      "youtubeSelected",
      "youtubeDownloaded",
      "youtubePrepared",
      "youtubeVisionFit",
      "youtubeVisionMismatch",
      "youtubeVisionUnclear",
      "youtubeAdopted",
      "youtubeComposeInput",
      "youtubeComposeSelected",
      "youtubeComposeDropped",
      "youtubeCinematicSelected",
      "youtubeCinematicDropped",
      "youtubeRenderInput",
      "youtubeFinalVideo",
      "youtubeDelivered",
      "youtubeVanishedAfterAdoption",
    ]) {
      expect(t[name], name).toBeTypeOf("number");
    }
  });

  it("the printed block ends with the question it was built to answer", () => {
    const lines = formatYoutubeLifecycle(build());
    expect(lines.at(-2)).toContain("[YouTubeLifecycle] TOTAL");
    expect(lines.at(-1)).toContain("VERDICT INCONCLUSIVE");
    expect(lines.at(-1)).toContain("vanish before the film");
  });

  it("the table carries every §9 column, one row per asset", () => {
    const rows = build();
    const table = formatYoutubeLifecycleTable(rows);
    expect(table).toHaveLength(rows.length + 1);
    for (const column of YOUTUBE_LIFECYCLE_COLUMNS) expect(table[0]).toContain(column);
    expect(table[1]!.split(" | ")).toHaveLength(YOUTUBE_LIFECYCLE_COLUMNS.length);
  });

  it("a reason with a pipe in it cannot break the table's columns", () => {
    const rows = traceYoutubeLifecycle(
      ledgerOf([
        {
          contentKey: key("74"),
          stages: [...FOUND_TO_ADOPTED, ["CINEMATIC_DROPPED", { reason: "a | b\nc" }]],
        },
      ]),
      emptyRelevance()
    );
    const table = formatYoutubeLifecycleTable(rows);
    expect(table[1]!.split(" | ")).toHaveLength(YOUTUBE_LIFECYCLE_COLUMNS.length);
  });
});

// ── §14 — structural ───────────────────────────────────────────────────────────────────────

describe("§14 — a reader, and nothing more than a reader", () => {
  const SRC = readFileSync(join(__dirname, "youtubeLifecycleTrace.ts"), "utf8");
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("files no lineage event and opens no record", () => {
    expect(CODE).not.toMatch(/recordEvent|recordEventForPath|createLineage|countProvider/);
  });

  it("introduces no global mutable state", () => {
    /**
     * Module scope holds nothing that can change. A `let` or a mutable collection at the top level
     * would make one render's report depend on the one before it — the exact defect a per-render
     * ledger exists to prevent, re-introduced in the reader instead of the register.
     */
    expect(CODE).not.toMatch(/^(let|var)\s/m);
    expect(CODE).not.toMatch(/^const\s+\w+\s*(:[^=]+)?=\s*new (Map|Array|WeakMap)\b/m);
  });

  it("throws nothing, so no render can fail because this report ran", () => {
    expect(CODE).not.toMatch(/\bthrow\b/);
    expect(CODE).not.toMatch(/pipelineError|assert[A-Z]/);
  });

  it("changes no production decision — it takes no policy and calls nothing that acts", () => {
    expect(CODE).not.toMatch(/process\.env/);
    expect(CODE).not.toMatch(/console\./);
    expect(CODE).not.toMatch(/\bawait\b|\basync\b/);
    expect(CODE).not.toMatch(/spawn|exec|ffmpeg|fetch\(/);
    expect(CODE).not.toMatch(/readFileSync|writeFileSync/);
  });

  it("duplicates no existing truth source — it joins the ones that exist", () => {
    expect(CODE).toContain('from "./visualSourceLineage"');
    expect(CODE).toContain('from "./beatVisualRelevance"');
    /** The identity rule is asked for, not re-derived — one definition of what a real key is. */
    expect(CODE).toContain("isCanonicalAssetKey");
    /** No second funnel, no second relevance register, no second census. */
    expect(CODE).not.toMatch(/providerVisionFunnel|providerFunnel|visionCensus|judgeBeatImage/);
  });

  it("uses the canonical identity fields rather than parsing a path", () => {
    expect(CODE).toMatch(/record\.contentKey/);
    expect(CODE).toMatch(/record\.providerAssetId/);
    expect(CODE).toMatch(/record\.renderId/);
    expect(CODE).toMatch(/beatRelevanceBeatKey\(/);
    /** Nothing is recovered from a filename — the round that banned that is not undone here. */
    expect(CODE).not.toMatch(/basename|localPath|currentFilename|\.split\("\/"\)/);
  });

  it("is render-scoped: a record from another render is skipped by identity, not by hope", () => {
    expect(CODE).toMatch(/record\.renderId !== ledger\.renderId/);
  });

  it("is wired into the render's own report, beside the trace it completes", () => {
    expect(PIPELINE).toContain('from "./youtubeLifecycleTrace"');
    const trace = PIPELINE.indexOf("traceYoutubeLifecycle(ledger, visualDedup.beatRelevance)");
    expect(trace).toBeGreaterThan(0);
    for (const reader of [
      "formatYoutubeLifecycle(youtubeLifecycle)",
      "formatYoutubeLifecycleTable(youtubeLifecycle)",
      "youtubeLifecycleViolations(youtubeLifecycle)",
    ]) {
      expect(PIPELINE.indexOf(reader)).toBeGreaterThan(trace);
    }
    /** The availability line reads the gate's own counters, not a reason string. */
    expect(PIPELINE).toContain("formatYoutubeVisionAvailability(\n        visualDedup.beatImageGate");
  });
});
