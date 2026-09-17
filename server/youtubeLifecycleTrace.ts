/**
 * WHERE EVERY YOUTUBE PICTURE STOPS — FOUND TO DELIVERED, ONE LINE EACH.
 *
 * ── The question that could not be answered ─────────────────────────────────────────────────
 *
 * "A YouTube asset was found, and may even have been FIT and ADOPTED. Why is it, or why is it
 * not, in the delivered film?"
 *
 * Everything needed to answer that has been recorded for rounds, in registers that were never read
 * against one another:
 *
 *   the verdict    `BeatRelevanceLedger`  — byBeat / byContentKey, written by the picture editor
 *   the lifecycle  `VisualSourceLedger`   — 23 stages, FOUND to DELIVERED, with reasons attached
 *   the capacity   `BeatImageGateState`   — whether this render had a picture editor at all
 *
 * `LINEAGE_STAGES` has no stage for a vision verdict, so the lineage alone can say "adopted and
 * then nothing" and can never say "APPROVED and then nothing" — which is the one the question was
 * about. `[YouTubeTrace]` reports the first; this reports the second, and names the exact point at
 * which each asset's life stops.
 *
 * ── The join, and why it is trustworthy for YouTube specifically ────────────────────────────
 *
 * Both sides carry `contentKey`, and `clipContentKey` is a LADDER whose upper rungs name the ASSET
 * and survive a rename, a re-trim and a copy. A YouTube clip is tagged
 * `__pid_youtube_cc-<sha256(videoId)[0:16]>` by `tagPathWithProviderAsset`, so it matches
 * `PROVIDER_ASSET_TAG_RE` and lands on rung two — the same string `providerAssetKey` produces:
 *
 *     youtube_cc:<16 hex>
 *
 * That is stable across every transform between download and delivery, which is exactly what a
 * lifecycle join needs. The ladder's LOWER rungs — `stock:vid:<n>`, `file:<size>:<basename>` and a
 * bare basename — are not, and a YouTube record that fell to one of those is reported as
 * `CONTENT_KEY_NOT_ASSET_IDENTITY` rather than matched on a key that cannot carry the claim. See
 * `contentKeyIsAssetIdentity`.
 *
 * The join is RENDER-SCOPED twice over. The ledger holds one render's records and is discarded
 * with it, and every record carries the `renderId` it was opened under — checked here, so a record
 * that somehow arrived from another render cannot become evidence about this one. The relevance
 * ledger has the same lifetime by construction: it lives on `VisualDedupState`.
 *
 * And BEAT-SCOPED. The editor judges a (picture, sentence) pair; a FIT earned at s1b2 is not an
 * approval at s2b5. The beat-specific entry is preferred, and a clip-wide entry that stands in for
 * it is reported as another beat's rather than quoted as this beat's.
 *
 * ── What this module is, and what it deliberately is not ────────────────────────────────────
 *
 * A READER. It holds no state, writes no event, and decides nothing the render acts on.
 *
 *   · It is not a second vision register. Verdicts come from the ledger that already holds them.
 *   · It is not a second lifecycle. Stages, statuses and reasons come from the lineage.
 *   · It is not a second funnel. `[VisualFunnel]` and `[ProviderFunnel]` keep their own counts;
 *     nothing here is re-measured from a different source.
 *   · It is not a gate. Every function returns strings and rows; nothing throws, nothing is
 *     refused, and no production behaviour changes because this file exists.
 *   · It invents nothing. A stage that was never filed is reported missing BY NAME; a reason is
 *     quoted from the event that carried it or left empty.
 */
import type {
  VisualSourceLedger,
  VisualLineageRecord,
  VisualLineageEvent,
  LineageStage,
} from "./visualSourceLineage";
import type { BeatRelevanceLedger } from "./beatVisualRelevance";
import { beatRelevanceBeatKey, isCanonicalAssetKey } from "./beatVisualRelevance";

/** The provider this trace is about. One string, so a typo cannot silently match nothing. */
export const YOUTUBE_PROVIDER = "youtube_cc";

/**
 * The editor's answer about a clip, as this trace reports it.
 *
 * The last three are deliberately different from one another, and none of them is a verdict:
 *
 *   NOT_ASKED                    a decline the gate RECORDED — `evaluated: false` means it did
 *                                not look: the gate was off, there was no narration, a budget was
 *                                spent, no provider could be reached. A fact about the render.
 *   VISION_RECORD_MISSING        the join was possible and found nothing. A fact about THIS
 *                                REPORT, and it must never be read as "nobody looked".
 *   CONTENT_KEY_NOT_ASSET_IDENTITY
 *                                the join was not possible: this record's key is on a rung of the
 *                                ladder that does not name the asset. Also a fact about this
 *                                report, and a stronger one — the evidence is unusable rather
 *                                than absent.
 *
 * VISION_UNAVAILABLE is deliberately NOT a member. Whether a provider could be reached is recorded
 * render-wide on `BeatImageGateState` and nowhere per decision, and the only per-asset trace of it
 * is the prose in `decision.reason` — which `judgementsProviderUnavailable` exists precisely so
 * that no reader has to match on. It is therefore reported once, for the render, by
 * `formatYoutubeVisionAvailability`, and never guessed at per picture.
 */
export type YoutubeVisionOutcome =
  | "FIT"
  | "MISMATCH"
  | "UNCLEAR"
  | "NOT_ASKED"
  | "VISION_RECORD_MISSING"
  | "CONTENT_KEY_NOT_ASSET_IDENTITY";

/**
 * WHERE THIS ASSET'S LIFE ENDED — one value, and the reason this module exists.
 *
 * Every member except the last two is an ENDING SOMEBODY RECORDED. The last two are the absence of
 * one, which is a different kind of fact and is why they are named differently:
 *
 *   FINAL                        reached the delivered film
 *   RENDER_INPUT_NOT_IN_FINAL    handed to the renderer and not in its output
 *   CINEMATIC_DROPPED            the cinematic planner turned it down, with a reason
 *   COMPOSE_DROPPED              the compose filter turned it down, with a reason
 *   REPLACED / REMOVED           swapped out or taken out, with a reason
 *   REJECTED_BEFORE_ADOPTION     a gate refused it before it could be used, with a reason
 *   REJECTED_AFTER_ADOPTION      a gate refused it once it was already in use, with a reason —
 *                                separate because the two call for opposite work, and because
 *                                reading the second as the first is what let an adopted asset's
 *                                disappearance be reported as explained (see `endingOf`)
 *   DOWNLOAD_FAILED              the bytes never arrived
 *   NOT_ADOPTED                  nothing refused it and nothing used it
 *   ADOPTED_NO_TERMINAL_OUTCOME  in use, then no ending at all
 *   YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION
 *                                the same, for a picture the editor had APPROVED — the finding
 */
export type YoutubeLifecycleStatus =
  | "FINAL"
  | "RENDER_INPUT_NOT_IN_FINAL"
  | "CINEMATIC_DROPPED"
  | "COMPOSE_DROPPED"
  | "REPLACED"
  | "REMOVED"
  | "REJECTED_BEFORE_ADOPTION"
  | "REJECTED_AFTER_ADOPTION"
  | "DOWNLOAD_FAILED"
  | "NOT_ADOPTED"
  | "ADOPTED_NO_TERMINAL_OUTCOME"
  | "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION";

/** The endings that need no explaining: something decided, and said why. */
const EXPLAINED_STATUSES: ReadonlySet<YoutubeLifecycleStatus> = new Set<YoutubeLifecycleStatus>([
  "FINAL",
  "CINEMATIC_DROPPED",
  "COMPOSE_DROPPED",
  "REPLACED",
  "REMOVED",
  "REJECTED_BEFORE_ADOPTION",
  "REJECTED_AFTER_ADOPTION",
  "DOWNLOAD_FAILED",
]);

/**
 * The stages an adopted asset moves through, in order, after adoption.
 *
 * Used only to name the NEXT stage that was expected when a row stops early. It is not a contract
 * the render must follow — several of these are optional in practice — so a row is only ever
 * reported as stopping at the furthest stage it actually reached.
 */
const DOWNSTREAM_ORDER: readonly LineageStage[] = [
  "ADOPTED",
  "TRANSFORMED",
  "TRIMMED",
  "PADDED",
  "OVERLAYED",
  "COMPOSE_INPUT",
  "COMPOSE_SELECTED",
  "COMPOSED",
  "CINEMATIC_SELECTED",
  "RENDER_INPUT",
  "FINAL_VIDEO",
  "DELIVERED",
];

/** The transforms that turn a downloaded file into something a montage can use. */
const PREPARATION_STAGES: readonly LineageStage[] = [
  "TRANSFORMED",
  "TRIMMED",
  "PADDED",
  "OVERLAYED",
];

export type YoutubeLifecycleRow = {
  lineageId: string;
  provider: string;
  providerAssetId?: string;
  contentKey: string;
  sceneIndex: number;
  beatIndex: number;
  query?: string;
  /** Every stage this record (or anything derived from it) reached, in lifecycle order. */
  stages: LineageStage[];
  vision: YoutubeVisionOutcome;
  /** Whether the editor's verdict was earned at THIS record's beat, or inherited from the clip. */
  visionFromOwnBeat: boolean;
  /**
   * A FIT THIS BEAT ACTUALLY EARNED — the only thing that counts as approval here.
   *
   * The editor judges a (picture, sentence) pair. A `fits` earned at s1b2 says nothing about s2b5,
   * so a clip-wide entry standing in for a beat's own is reported (it is real evidence about the
   * file) and is never treated as an approval for the beat it is standing in on. The finding this
   * module exists to raise rests on this field, not on `vision`.
   */
  approvedForThisBeat: boolean;
  found: boolean;
  eligible: boolean;
  ranked: boolean;
  selected: boolean;
  downloaded: boolean;
  prepared: boolean;
  adopted: boolean;
  /** Whether the montage was ever handed this clip, whatever it then did with it. */
  composeInput: boolean;
  /** `SELECTED` | `INPUT` | `DROPPED` | `COMPOSED` | `no` — the furthest compose state reached. */
  compose: string;
  /** `SELECTED` | `DROPPED` | `no`. */
  cinematic: string;
  /** `INPUT` | `no`. */
  render: string;
  finalVideo: boolean;
  delivered: boolean;
  status: YoutubeLifecycleStatus;
  /** Quoted from the event that ended this asset's life. Empty when that event carried none. */
  reason: string;
  /** The furthest downstream stage actually reached. Null when the record never reached adoption. */
  lastKnownStage: LineageStage | null;
  /** The next stage that was expected and never filed. Null when the row ended explainably. */
  missingStage: LineageStage | null;
  /** Set only when the row is a finding. See `YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION`. */
  violation: "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION" | "YOUTUBE_ASSET_DOWNSTREAM_GAP" | null;
};

/**
 * `providerAssetKey("youtube_cc", videoId)` and nothing else.
 *
 * Two rules, and only the second is new. The first is the ledger's own — `isCanonicalAssetKey`,
 * which is where this codebase already decides whether a key names an asset or only fingerprints
 * one file — asked rather than re-derived, so there is no second opinion about `file:` keys.
 *
 * The second is specific to this trace. A YouTube record whose key is `stock:vid:7` is canonical
 * and is still not this asset's identity: it means the key ladder fell past the `__pid_` rung, so
 * whatever the ledger answers under it is evidence about some other picture that happened to land
 * on the same rung. A claim as strong as "the editor approved this and the film lost it" may only
 * be made on the key the provider tag itself produced.
 */
function contentKeyIsAssetIdentity(contentKey: string): boolean {
  if (!isCanonicalAssetKey(contentKey)) return false;
  return ASSET_IDENTITY_RE.test(contentKey.trim());
}

/** The exact shape `providerAssetKey` writes: the provider, then a 16-hex sha256 prefix. */
const ASSET_IDENTITY_RE = new RegExp(`^${YOUTUBE_PROVIDER}:[0-9a-f]{16}$`);

/**
 * What one record actually filed — stages AND statuses AND reasons.
 *
 * Folding to a set of stage names would lose the distinction this report is built on: a rejection
 * is written as an `ELIGIBLE` or `COMPOSED` event with `status: "REJECTED"` and a reason attached
 * (see `rejectionStageForGate`). Read as a bare stage name it becomes indistinguishable from the
 * asset passing that stage, which would turn every refusal into a silent disappearance.
 */
type FiledEvents = Map<string, VisualLineageEvent[]>;

function eventsById(events: readonly VisualLineageEvent[]): FiledEvents {
  const out: FiledEvents = new Map();
  for (const e of events) {
    const list = out.get(e.lineageId);
    if (list) list.push(e);
    else out.set(e.lineageId, [e]);
  }
  return out;
}

/**
 * Every event filed by a record OR BY ANYTHING DERIVED FROM IT.
 *
 * A clip is trimmed, padded and overlaid, and each step opens a child record carrying
 * `parentLineageId`. The downstream stages — COMPOSE_INPUT, RENDER_INPUT, FINAL_VIDEO — are then
 * filed against the CHILD. Reading the root alone would report the parent of every delivered clip
 * as having vanished at adoption, which is the loudest possible false finding this module could
 * produce. `unaccountedSelectedAssets` solves the same problem with `accountedThroughDescendant`;
 * this is that walk, bounded the same way, collecting instead of testing.
 */
function eventsWithDescendants(
  lineageId: string,
  filed: FiledEvents,
  childrenOf: Map<string, string[]>,
  seen = new Set<string>()
): VisualLineageEvent[] {
  /** Depth-bounded and cycle-safe: a malformed chain must not hang a render's own audit. */
  if (seen.has(lineageId) || seen.size > 64) return [];
  seen.add(lineageId);
  const out = [...(filed.get(lineageId) ?? [])];
  for (const child of childrenOf.get(lineageId) ?? []) {
    out.push(...eventsWithDescendants(child, filed, childrenOf, seen));
  }
  return out;
}

/**
 * Read the editor's answer for one record.
 *
 * The beat-specific entry is preferred and reported as such: the gate judges PER BEAT, and a `fits`
 * earned under one sentence is not an approval under another. The clip-wide entry is the fallback
 * and is flagged, so a reader can tell a verdict about this beat from a verdict about this file.
 */
function visionFor(
  relevance: BeatRelevanceLedger | undefined,
  record: VisualLineageRecord
): { outcome: YoutubeVisionOutcome; ownBeat: boolean } {
  if (!contentKeyIsAssetIdentity(record.contentKey)) {
    return { outcome: "CONTENT_KEY_NOT_ASSET_IDENTITY", ownBeat: false };
  }
  if (!relevance) return { outcome: "VISION_RECORD_MISSING", ownBeat: false };
  const own = relevance.byBeat.get(
    beatRelevanceBeatKey(record.sceneIndex, record.beatIndex, "content", record.contentKey)
  );
  const entry = own ?? relevance.byContentKey.get(record.contentKey);
  if (!entry) return { outcome: "VISION_RECORD_MISSING", ownBeat: false };
  const ownBeat = Boolean(own);
  const d = entry.decision;
  /** A decline is not a verdict — `evaluated: false` means the gate did not look. */
  if (d.evaluated === false) return { outcome: "NOT_ASKED", ownBeat };
  if (d.verdict === "fits") return { outcome: "FIT", ownBeat };
  if (d.verdict === "does_not_fit") return { outcome: "MISMATCH", ownBeat };
  return { outcome: "UNCLEAR", ownBeat };
}

/** An asset reached a stage when it filed that stage without being refused at it. */
function reached(events: readonly VisualLineageEvent[], stage: LineageStage): boolean {
  return events.some((e) => e.stage === stage && e.status === "OK");
}

/**
 * Whether a stage was filed at all, whatever status it carried.
 *
 * For the DROP stages only, and the difference is not cosmetic. A stage like `ELIGIBLE` means one
 * thing with `status: "OK"` and the opposite with `status: "REJECTED"`, so progress must be read
 * with `reached`. A stage like `COMPOSE_DROPPED` IS the outcome — the status beside it varies by
 * call site (compose writes `REJECTED`, the cinematic planner writes `OK`) and says nothing extra.
 * Reading those with `reached` made a real drop look like a disappearance for one of the two.
 */
function filedStage(events: readonly VisualLineageEvent[], stage: LineageStage): boolean {
  return events.some((e) => e.stage === stage);
}

/**
 * The ending this asset was given, and the words whoever gave it used.
 *
 * Order is the lifecycle's own, latest first: an asset that reached the film is FINAL whatever was
 * said about it earlier, and a rejection before adoption only speaks for an asset that has no
 * later ending. Nothing here decides anything — it reads which of the recorded endings happened.
 */
function endingOf(
  events: readonly VisualLineageEvent[]
): { status: YoutubeLifecycleStatus; reason: string } | null {
  const last = (stage: LineageStage, status?: VisualLineageEvent["status"]) =>
    [...events].reverse().find((e) => e.stage === stage && (!status || e.status === status));

  const delivered = last("DELIVERED", "OK") ?? last("FINAL_VIDEO", "OK");
  if (delivered) return { status: "FINAL", reason: delivered.reason ?? "" };

  for (const [stage, status] of [
    ["CINEMATIC_DROPPED", "CINEMATIC_DROPPED"],
    ["COMPOSE_DROPPED", "COMPOSE_DROPPED"],
    ["REPLACED", "REPLACED"],
    ["REMOVED", "REMOVED"],
  ] as Array<[LineageStage, YoutubeLifecycleStatus]>) {
    const e = last(stage);
    if (e) return { status, reason: e.reason ?? "" };
  }

  /**
   * A refusal is filed as REJECTED on the stage the gate belongs to, never as its own stage.
   *
   * ── The word BEFORE was doing no work ───────────────────────────────────────────────────────
   *
   * This used to be `events.reverse().find((e) => e.status === "REJECTED")` and return
   * `REJECTED_BEFORE_ADOPTION` — a name asserting an order that nothing checked. A YouTube record
   * accumulates refusals: a candidate turned down on one beat, a derived copy a gate refused, an
   * eligibility check that said no before a later route said yes. `eventsWithDescendants` folds
   * every one of those in. So an asset REJECTED at some earlier moment, ADOPTED afterwards, and
   * then lost with nothing recorded came back as "rejected before adoption" — an EXPLAINED status,
   * which suppressed the very finding this module exists to make. The gap counter read zero
   * because it could not fire, not because there was no gap.
   *
   * ── The order, now asked ────────────────────────────────────────────────────────────────────
   *
   * Adoption is the dividing line. A refusal AFTER it is a real ending and gets its own name — it
   * says who refused and why, so it explains the asset. A refusal BEFORE it explains nothing about
   * an asset that went on to be adopted, so for an adopted asset it is not an ending at all, and
   * the row falls through to the missing-outcome finding it always should have made.
   *
   * `DOWNLOAD_FAILED` is read the same way for the same reason: one attempt failing does not
   * account for an asset a later attempt delivered, adopted and then lost.
   *
   * ── Why the position and not the timestamp ──────────────────────────────────────────────────
   *
   * `recordEvent` stamps `Date.now()`, and a gate that refuses a clip it has just adopted files
   * both inside the same millisecond — so a timestamp comparison decides those coin-flips by
   * rounding. The array is the ledger's own filing order for a record, with each derived record's
   * events appended after its parent's, and a derived file cannot exist before the adoption that
   * produced it. That makes position the order these events actually happened in, for every shape
   * this reader sees.
   */
  const adoptedIndex = events.findIndex((e) => e.stage === "ADOPTED" && e.status === "OK");
  const adopted = adoptedIndex >= 0;
  const refusal = (after: boolean) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.status !== "REJECTED") continue;
      if (!adopted) {
        if (!after) return e;
        continue;
      }
      if (after ? i > adoptedIndex : i < adoptedIndex) return e;
    }
    return undefined;
  };

  const rejectedAfter = adopted ? refusal(true) : undefined;
  if (rejectedAfter) {
    return {
      status: "REJECTED_AFTER_ADOPTION",
      reason: rejectedAfter.gate
        ? `${rejectedAfter.gate}: ${rejectedAfter.reason ?? ""}`
        : rejectedAfter.reason ?? "",
    };
  }
  if (!adopted) {
    const rejected = refusal(false);
    if (rejected) {
      return {
        status: "REJECTED_BEFORE_ADOPTION",
        reason: rejected.gate ? `${rejected.gate}: ${rejected.reason ?? ""}` : rejected.reason ?? "",
      };
    }

    const failed = last("DOWNLOAD_FAILED");
    if (failed) return { status: "DOWNLOAD_FAILED", reason: failed.reason ?? "" };
  }

  return null;
}

/**
 * Every YouTube asset this render tracked, with the editor's answer beside its lifecycle.
 *
 * Deterministic: records are ordered by scene, then beat, then lineage id, so two runs over the
 * same ledgers produce the same report — including when one YouTube video has several records,
 * which happens legitimately whenever a second beat fetches the same video.
 */
export function traceYoutubeLifecycle(
  ledger: VisualSourceLedger | undefined,
  relevance: BeatRelevanceLedger | undefined
): YoutubeLifecycleRow[] {
  if (!ledger) return [];
  const filed = eventsById(ledger.allEvents());
  const records = ledger.allRecords();
  const childrenOf = new Map<string, string[]>();
  for (const r of records) {
    if (!r.parentLineageId) continue;
    const list = childrenOf.get(r.parentLineageId);
    if (list) list.push(r.lineageId);
    else childrenOf.set(r.parentLineageId, [r.lineageId]);
  }
  const rows: YoutubeLifecycleRow[] = [];

  for (const record of records) {
    if (record.provider !== YOUTUBE_PROVIDER) continue;
    /** A derived file is not a second asset — only roots are traced, as the funnel rules do. */
    if (record.parentLineageId) continue;
    /**
     * A record from another render is not evidence about this one. The ledger is per-render and
     * discarded with it, so this cannot normally fire — which is exactly why it is cheap to state
     * rather than assume: a rehydrated snapshot or a shared cache would otherwise let one render's
     * approval explain another render's missing picture.
     */
    if (record.renderId !== ledger.renderId) continue;

    const events = eventsWithDescendants(record.lineageId, filed, childrenOf);
    const stages = DOWNSTREAM_ORDER.filter((s) => reached(events, s));
    const { outcome, ownBeat } = visionFor(relevance, record);
    const approvedForThisBeat = outcome === "FIT" && ownBeat;
    const adopted = reached(events, "ADOPTED");
    const ending = endingOf(events);

    let lastKnownStage: LineageStage | null = null;
    let missingStage: LineageStage | null = null;
    let violation: YoutubeLifecycleRow["violation"] = null;
    let status: YoutubeLifecycleStatus = ending?.status ?? "NOT_ADOPTED";

    if (adopted) {
      /** The furthest point on the ordered chain this record actually reached. */
      let furthest = -1;
      DOWNSTREAM_ORDER.forEach((s, i) => {
        if (reached(events, s)) furthest = i;
      });
      lastKnownStage = furthest >= 0 ? DOWNSTREAM_ORDER[furthest]! : null;
      if (!ending || !EXPLAINED_STATUSES.has(ending.status)) {
        missingStage = DOWNSTREAM_ORDER[furthest + 1] ?? null;
        /**
         * The two findings are the same shape and differ in one way that matters to a reader: an
         * approved clip that vanished is a defect in the film, and an unapproved one that vanished
         * is a loose end. Both are reported; only the first answers the question this module was
         * built for.
         */
        violation = approvedForThisBeat
          ? "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION"
          : "YOUTUBE_ASSET_DOWNSTREAM_GAP";
        status = approvedForThisBeat
          ? "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION"
          : "ADOPTED_NO_TERMINAL_OUTCOME";
      }
    }

    /**
     * An asset handed to the renderer and absent from its output stopped at a NAMED place — case
     * F — which is more useful than "no terminal outcome". Applied only where the status is still
     * one of the two open ones: a recorded drop or a delivery says who decided and why, and an
     * approved picture that vanished keeps the stronger name of the two.
     */
    if (
      (status === "NOT_ADOPTED" || status === "ADOPTED_NO_TERMINAL_OUTCOME") &&
      reached(events, "RENDER_INPUT") &&
      !reached(events, "FINAL_VIDEO")
    ) {
      status = "RENDER_INPUT_NOT_IN_FINAL";
    }

    const composeState = filedStage(events, "COMPOSE_DROPPED")
      ? "DROPPED"
      : reached(events, "COMPOSE_SELECTED")
        ? "SELECTED"
        : reached(events, "COMPOSED")
          ? "COMPOSED"
          : reached(events, "COMPOSE_INPUT")
            ? "INPUT"
            : "no";

    rows.push({
      lineageId: record.lineageId,
      provider: YOUTUBE_PROVIDER,
      providerAssetId: record.providerAssetId,
      contentKey: record.contentKey,
      sceneIndex: record.sceneIndex,
      beatIndex: record.beatIndex,
      query: record.query,
      stages,
      vision: outcome,
      visionFromOwnBeat: ownBeat,
      approvedForThisBeat,
      found: reached(events, "FOUND"),
      eligible: reached(events, "ELIGIBLE"),
      ranked: reached(events, "RANKED"),
      selected: reached(events, "SELECTED"),
      downloaded: reached(events, "DOWNLOAD_SUCCEEDED"),
      prepared: PREPARATION_STAGES.some((s) => reached(events, s)),
      adopted,
      composeInput: reached(events, "COMPOSE_INPUT"),
      compose: composeState,
      cinematic: filedStage(events, "CINEMATIC_DROPPED")
        ? "DROPPED"
        : reached(events, "CINEMATIC_SELECTED")
          ? "SELECTED"
          : "no",
      render: reached(events, "RENDER_INPUT") ? "INPUT" : "no",
      finalVideo: reached(events, "FINAL_VIDEO"),
      delivered: reached(events, "DELIVERED"),
      status,
      reason: ending?.reason ?? "",
      lastKnownStage,
      missingStage,
      violation,
    });
  }

  rows.sort(
    (a, b) =>
      a.sceneIndex - b.sceneIndex ||
      a.beatIndex - b.beatIndex ||
      a.lineageId.localeCompare(b.lineageId)
  );
  return rows;
}

/**
 * The outcomes that mean the join SUCCEEDED — the ledger was reachable and answered about this
 * asset. The other two say the report could not look, and a report full of those is INCONCLUSIVE
 * however many rows it has.
 */
const JOINED_OUTCOMES: ReadonlySet<YoutubeVisionOutcome> = new Set<YoutubeVisionOutcome>([
  "FIT",
  "MISMATCH",
  "UNCLEAR",
  "NOT_ASKED",
]);

/**
 * THE ONE ANSWER THIS MODULE EXISTS TO GIVE.
 *
 *   YES           at least one FIT + ADOPTED asset stopped with no terminal outcome
 *   NO            every FIT + ADOPTED asset ended explainably or reached the film
 *   INCONCLUSIVE  the join could not be made — no records, or not one of them could be joined to
 *                 the ledger, which is a statement about the evidence and not about the render
 *
 * INCONCLUSIVE is returned rather than NO when nothing could be joined, because "we found no
 * violations" and "we could not look" are the two answers this whole investigation has been about
 * telling apart.
 */
export function youtubeLifecycleVerdict(
  rows: readonly YoutubeLifecycleRow[]
): "YES" | "NO" | "INCONCLUSIVE" {
  if (rows.length === 0) return "INCONCLUSIVE";
  if (rows.every((r) => !JOINED_OUTCOMES.has(r.vision))) return "INCONCLUSIVE";
  return rows.some((r) => r.violation === "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION") ? "YES" : "NO";
}

/**
 * The counters §10 asks for, every one derived from the rows above rather than re-measured.
 *
 * Named with the `youtube` prefix the spec uses so they cannot be mistaken for the render-wide
 * `[VisualFunnel]` and `[AssetUsageSummary]` numbers, which count different populations by
 * different rules. These are one provider's assets as THIS trace joined them; where the two
 * disagree, that disagreement is itself the finding, and hiding it behind a shared name would be
 * the metric-cosmetics this codebase keeps refusing.
 */
export function youtubeLifecycleTotals(
  rows: readonly YoutubeLifecycleRow[]
): Record<string, number> {
  const count = (p: (r: YoutubeLifecycleRow) => boolean) => rows.filter(p).length;
  return {
    youtubeTracked: rows.length,
    youtubeFound: count((r) => r.found),
    youtubeEligible: count((r) => r.eligible),
    youtubeRanked: count((r) => r.ranked),
    youtubeSelected: count((r) => r.selected),
    youtubeDownloaded: count((r) => r.downloaded),
    youtubePrepared: count((r) => r.prepared),
    youtubeVisionFit: count((r) => r.vision === "FIT"),
    /** Of those, the ones whose FIT was earned under the beat's own narration. */
    youtubeVisionFitForThisBeat: count((r) => r.approvedForThisBeat),
    youtubeVisionMismatch: count((r) => r.vision === "MISMATCH"),
    youtubeVisionUnclear: count((r) => r.vision === "UNCLEAR"),
    youtubeVisionNotAsked: count((r) => r.vision === "NOT_ASKED"),
    youtubeVisionRecordMissing: count((r) => r.vision === "VISION_RECORD_MISSING"),
    youtubeContentKeyNotAssetIdentity: count((r) => r.vision === "CONTENT_KEY_NOT_ASSET_IDENTITY"),
    youtubeAdopted: count((r) => r.adopted),
    youtubeComposeInput: count((r) => r.composeInput),
    youtubeComposeSelected: count((r) => r.compose === "SELECTED"),
    youtubeComposeDropped: count((r) => r.compose === "DROPPED"),
    youtubeCinematicSelected: count((r) => r.cinematic === "SELECTED"),
    youtubeCinematicDropped: count((r) => r.cinematic === "DROPPED"),
    youtubeRenderInput: count((r) => r.render === "INPUT"),
    youtubeFinalVideo: count((r) => r.finalVideo),
    youtubeDelivered: count((r) => r.delivered),
    youtubeVanishedAfterAdoption: count(
      (r) => r.violation === "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION"
    ),
    youtubeDownstreamGap: count((r) => r.violation === "YOUTUBE_ASSET_DOWNSTREAM_GAP"),
  };
}

/** One line per asset, then the totals and the verdict. Empty when the render used no YouTube. */
export function formatYoutubeLifecycle(rows: readonly YoutubeLifecycleRow[]): string[] {
  if (rows.length === 0) return [];
  const lines = rows.map((r) => {
    const chain = r.stages.length > 0 ? r.stages.join("→") : "no stage after FOUND";
    const gap = r.missingStage
      ? ` lastKnownStage=${r.lastKnownStage ?? "none"} missingStage=${r.missingStage}`
      : "";
    return (
      `[YouTubeLifecycle] asset=${YOUTUBE_PROVIDER}:${r.providerAssetId ?? "unknown"} ` +
      `scene=${r.sceneIndex} beat=${r.beatIndex} vision=${r.vision}` +
      `${JOINED_OUTCOMES.has(r.vision) && !r.visionFromOwnBeat ? "(another beat's)" : ""} ` +
      `adopted=${r.adopted ? "yes" : "no"} prepared=${r.prepared ? "yes" : "no"} ` +
      `compose=${r.compose} cinematic=${r.cinematic} render=${r.render} ` +
      `finalVideo=${r.finalVideo ? "yes" : "no"} delivered=${r.delivered ? "yes" : "no"} ` +
      `status=${r.status}${r.reason ? ` reason=${r.reason}` : ""} ${chain}${gap}`
    );
  });
  const t = youtubeLifecycleTotals(rows);
  lines.push(
    `[YouTubeLifecycle] TOTAL ` +
      Object.entries(t)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
  );
  lines.push(
    `[YouTubeLifecycle] VERDICT ${youtubeLifecycleVerdict(rows)} — ` +
      `"did a YouTube asset earn a real frame-vision FIT and then vanish before the film?"`
  );
  return lines;
}

/** The §9 columns, one row per asset, for reading a whole render at a glance. */
export const YOUTUBE_LIFECYCLE_COLUMNS = [
  "asset",
  "scene",
  "beat",
  "provider",
  "providerAssetId",
  "contentKey",
  "vision",
  "adopted",
  "prepared",
  "compose",
  "cinematic",
  "render",
  "finalVideo",
  "delivered",
  "terminalStatus",
  "reason",
] as const;

/**
 * The same rows as a table. `|`-separated rather than column-aligned: a render log is read with
 * grep and a spreadsheet, and padding turns both into guesswork about where a field ends.
 */
export function formatYoutubeLifecycleTable(rows: readonly YoutubeLifecycleRow[]): string[] {
  if (rows.length === 0) return [];
  const cell = (s: string | undefined) => (s ?? "").replace(/[|\n]/g, " ").trim();
  const out = [`[YouTubeLifecycleTable] ${YOUTUBE_LIFECYCLE_COLUMNS.join(" | ")}`];
  for (const r of rows) {
    out.push(
      `[YouTubeLifecycleTable] ` +
        [
          `${YOUTUBE_PROVIDER}:${r.providerAssetId ?? "unknown"}`,
          `${r.sceneIndex}`,
          `${r.beatIndex}`,
          r.provider,
          cell(r.providerAssetId) || "unknown",
          cell(r.contentKey),
          r.vision,
          r.adopted ? "yes" : "no",
          r.prepared ? "yes" : "no",
          r.compose,
          r.cinematic,
          r.render,
          r.finalVideo ? "yes" : "no",
          r.delivered ? "yes" : "no",
          r.status,
          cell(r.reason),
        ].join(" | ")
    );
  }
  return out;
}

/**
 * WHETHER THIS RENDER HAD A PICTURE EDITOR AT ALL — reported once, for the render.
 *
 * `NOT_ASKED` on a row says the gate declined; it does not say why, and per asset there is no
 * structured record of why. There is one for the RENDER: `judgementsProviderUnavailable` counts
 * the declines that mean no provider could be reached, and `askImpossible` says the render gave up
 * on asking entirely. Both are counters the gate keeps deliberately so that no reader has to match
 * on the wording of a reason string, and both are read here exactly as the export gate reads them.
 *
 * So a render whose YouTube pictures are all NOT_ASKED can tell the two cases apart — a spent
 * budget, or a blind render — without this module ever claiming, per picture, which one it was.
 */
export function formatYoutubeVisionAvailability(
  gate: { judgementsProviderUnavailable?: number; askImpossible?: boolean } | undefined,
  rows: readonly YoutubeLifecycleRow[]
): string[] {
  if (rows.length === 0) return [];
  const notAsked = rows.filter((r) => r.vision === "NOT_ASKED").length;
  const unavailable = gate?.judgementsProviderUnavailable ?? 0;
  const blind = gate?.askImpossible === true;
  if (notAsked === 0 && unavailable === 0 && !blind) return [];
  return [
    `[YouTubeLifecycle] VISION_AVAILABILITY notAsked=${notAsked} ` +
      `renderProviderUnavailable=${unavailable} renderCouldNotAsk=${blind ? "yes" : "no"} — ` +
      (blind || unavailable > 0
        ? "this render had no reachable picture editor for at least part of its work, so NOT_ASKED " +
          "on the rows above is VISION_UNAVAILABLE and not a spent budget"
        : "no provider outage was recorded, so NOT_ASKED above means the gate declined to look " +
          "for a reason of its own — a budget, a ceiling, no narration")
  ];
}

/** Only the findings, for the render's violation channel. Empty on a healthy render. */
export function youtubeLifecycleViolations(rows: readonly YoutubeLifecycleRow[]): string[] {
  return rows
    .filter((r) => r.violation)
    .map(
      (r) =>
        `[YouTubeLifecycleInvariant] ${r.violation} ` +
        `asset=${YOUTUBE_PROVIDER}:${r.providerAssetId ?? "unknown"} ` +
        `scene=${r.sceneIndex} beat=${r.beatIndex} vision=${r.vision} ` +
        `lastKnownStage=${r.lastKnownStage ?? "none"} missingStage=${r.missingStage ?? "none"}`
    );
}
