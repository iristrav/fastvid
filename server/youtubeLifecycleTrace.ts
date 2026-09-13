/**
 * WHAT BECAME OF EVERY YOUTUBE CLIP THE EDITOR SAID YES TO.
 *
 * ── The question that could not be answered ─────────────────────────────────────────────────
 *
 * "Did a YouTube asset get a real frame-vision FIT and then vanish before the film?"
 *
 * Both halves of that question are recorded, in two places that have never been read together:
 *
 *   the verdict    `BeatRelevanceLedger` — byContentKey / byBeat, written by the picture editor
 *   the lifecycle  `VisualSourceLineage` — 23 stages from FOUND to DELIVERED
 *
 * `LINEAGE_STAGES` has no stage for a vision verdict, so the lineage alone can say "adopted and
 * then nothing" but never "approved and then nothing". The existing invariant
 * `ADOPTED_ASSET_MISSING_CINEMATIC_TERMINAL_EVENT` is the first of those; this is the second, and
 * it is the one the question was actually about.
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
 * bare basename — are not stable, and a YouTube record that fell to one of those is reported as
 * `CONTENT_KEY_NOT_ASSET_IDENTITY` rather than matched on a key that cannot carry the claim. See
 * `contentKeyIsAssetIdentity`.
 *
 * ── What this module is, and what it deliberately is not ────────────────────────────────────
 *
 * A READER. It holds no state, writes no event, and decides nothing the render acts on.
 *
 *   · It is not a second vision register. Verdicts come from the ledger that already holds them.
 *   · It is not a second lifecycle. Stages come from the lineage that already holds them.
 *   · It is not a gate. Every function here returns strings and rows; nothing throws, nothing is
 *     refused, and no production behaviour changes because this file exists.
 *   · It invents no events. A stage that was never filed is reported as missing BY NAME, never
 *     filled in to make a row look complete.
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
 * The last three are deliberately different from one another, and two of them are not verdicts:
 *
 *   NOT_ASKED                    a decision the gate RECORDED — `evaluated: false` means it
 *                                declined to look: the gate was off, there was no narration, a
 *                                budget was spent. This is a fact about the render.
 *   VISION_RECORD_MISSING        the join was possible and found nothing. A fact about THIS
 *                                REPORT, and it must never be read as "nobody looked".
 *   CONTENT_KEY_NOT_ASSET_IDENTITY
 *                                the join was not possible: this record's key is on a rung of the
 *                                ladder that does not name the asset, so any entry it happened to
 *                                match would be a coincidence of filename. Also a fact about this
 *                                report, and a stronger one — it says the evidence is unusable
 *                                rather than absent.
 */
export type YoutubeVisionOutcome =
  | "FIT"
  | "MISMATCH"
  | "UNCLEAR"
  | "NOT_ASKED"
  | "VISION_RECORD_MISSING"
  | "CONTENT_KEY_NOT_ASSET_IDENTITY";

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

/**
 * Stages that END an asset's life with a reason attached.
 *
 * A row that reached any of these is explained, whatever else is missing — that is the whole point
 * of the distinction the spec draws: `FIT → ADOPTED → CINEMATIC_DROPPED(reason)` is a decision, and
 * `FIT → ADOPTED → COMPOSE_INPUT → nothing` is a disappearance.
 */
const TERMINAL_STAGES: ReadonlySet<LineageStage> = new Set<LineageStage>([
  "COMPOSE_DROPPED",
  "CINEMATIC_DROPPED",
  "REPLACED",
  "REMOVED",
  "FINAL_VIDEO",
  "DELIVERED",
]);

export type YoutubeLifecycleRow = {
  lineageId: string;
  providerAssetId?: string;
  contentKey: string;
  sceneIndex: number;
  beatIndex: number;
  query?: string;
  /** Every stage this record filed, in the order `DOWNSTREAM_ORDER` names them where applicable. */
  stages: LineageStage[];
  vision: YoutubeVisionOutcome;
  /** Whether the editor's verdict was earned at THIS record's beat, or inherited from the clip. */
  visionFromOwnBeat: boolean;
  adopted: boolean;
  /** The furthest downstream stage actually reached. Null when the record never reached adoption. */
  lastKnownStage: LineageStage | null;
  /** The next stage that was expected and never filed. Null when the row ended explainably. */
  missingStage: LineageStage | null;
  /** Set only when the row is a finding. See `YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION`. */
  violation: "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION" | "YOUTUBE_ASSET_DOWNSTREAM_GAP" | null;
};

/** The stages one record filed, folded the same way every other rule in the lineage folds them. */
function stagesById(events: readonly VisualLineageEvent[]): Map<string, Set<LineageStage>> {
  const out = new Map<string, Set<LineageStage>>();
  for (const e of events) {
    let set = out.get(e.lineageId);
    if (!set) out.set(e.lineageId, (set = new Set()));
    set.add(e.stage);
  }
  return out;
}

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
 * Every stage filed by a record OR BY ANYTHING DERIVED FROM IT.
 *
 * A clip is trimmed, padded and overlaid, and each step opens a child record carrying
 * `parentLineageId`. The downstream stages — COMPOSE_INPUT, RENDER_INPUT, FINAL_VIDEO — are then
 * filed against the CHILD. Reading the root alone would report the parent of every delivered clip
 * as having vanished at adoption, which is the loudest possible false finding this module could
 * produce. `unaccountedSelectedAssets` solves the same problem with `accountedThroughDescendant`;
 * this is that walk, bounded the same way, collecting instead of testing.
 */
function stagesWithDescendants(
  lineageId: string,
  filed: Map<string, Set<LineageStage>>,
  childrenOf: Map<string, string[]>,
  seen = new Set<string>()
): Set<LineageStage> {
  const out = new Set<LineageStage>();
  /** Depth-bounded and cycle-safe: a malformed chain must not hang a render's own audit. */
  if (seen.has(lineageId) || seen.size > 64) return out;
  seen.add(lineageId);
  for (const stage of filed.get(lineageId) ?? []) out.add(stage);
  for (const child of childrenOf.get(lineageId) ?? []) {
    for (const stage of stagesWithDescendants(child, filed, childrenOf, seen)) out.add(stage);
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
  const byId = stagesById(ledger.allEvents());
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

    const filed = stagesWithDescendants(record.lineageId, byId, childrenOf);
    const stages = DOWNSTREAM_ORDER.filter((s) => filed.has(s));
    const { outcome, ownBeat } = visionFor(relevance, record);
    const adopted = filed.has("ADOPTED");

    let lastKnownStage: LineageStage | null = null;
    let missingStage: LineageStage | null = null;
    let violation: YoutubeLifecycleRow["violation"] = null;

    if (adopted) {
      const ended = [...filed].some((s) => TERMINAL_STAGES.has(s));
      /** The furthest point on the ordered chain this record actually reached. */
      let furthest = -1;
      DOWNSTREAM_ORDER.forEach((s, i) => { if (filed.has(s)) furthest = i; });
      lastKnownStage = furthest >= 0 ? DOWNSTREAM_ORDER[furthest]! : null;
      if (!ended) {
        missingStage = DOWNSTREAM_ORDER[furthest + 1] ?? null;
        /**
         * The two findings are the same shape and different in one way that matters to a reader:
         * an approved clip that vanished is a defect in the film, and an unapproved one that
         * vanished is a loose end. Both are reported; only the first answers the question this
         * module was built for.
         */
        violation =
          outcome === "FIT"
            ? "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION"
            : "YOUTUBE_ASSET_DOWNSTREAM_GAP";
      }
    }

    rows.push({
      lineageId: record.lineageId,
      providerAssetId: record.providerAssetId,
      contentKey: record.contentKey,
      sceneIndex: record.sceneIndex,
      beatIndex: record.beatIndex,
      query: record.query,
      stages,
      vision: outcome,
      visionFromOwnBeat: ownBeat,
      adopted,
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

/** The counts §9 asks for, every one of them derived from the rows above rather than re-measured. */
export function youtubeLifecycleTotals(rows: readonly YoutubeLifecycleRow[]): Record<string, number> {
  const has = (r: YoutubeLifecycleRow, s: LineageStage) => r.stages.includes(s);
  return {
    tracked: rows.length,
    adopted: rows.filter((r) => r.adopted).length,
    FIT: rows.filter((r) => r.vision === "FIT").length,
    MISMATCH: rows.filter((r) => r.vision === "MISMATCH").length,
    UNCLEAR: rows.filter((r) => r.vision === "UNCLEAR").length,
    NOT_ASKED: rows.filter((r) => r.vision === "NOT_ASKED").length,
    VISION_RECORD_MISSING: rows.filter((r) => r.vision === "VISION_RECORD_MISSING").length,
    CONTENT_KEY_NOT_ASSET_IDENTITY: rows.filter(
      (r) => r.vision === "CONTENT_KEY_NOT_ASSET_IDENTITY"
    ).length,
    composeInput: rows.filter((r) => has(r, "COMPOSE_INPUT")).length,
    composeSelected: rows.filter((r) => has(r, "COMPOSE_SELECTED")).length,
    renderInput: rows.filter((r) => has(r, "RENDER_INPUT")).length,
    finalVideo: rows.filter((r) => has(r, "FINAL_VIDEO")).length,
    delivered: rows.filter((r) => has(r, "DELIVERED")).length,
    vanishedAfterAdoption: rows.filter(
      (r) => r.violation === "YOUTUBE_ASSET_VANISHED_AFTER_ADOPTION"
    ).length,
    downstreamGap: rows.filter((r) => r.violation === "YOUTUBE_ASSET_DOWNSTREAM_GAP").length,
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
      `adopted=${r.adopted ? "yes" : "no"} ${chain}${gap}` +
      `${r.violation ? ` ${r.violation}` : ""}`
    );
  });
  const t = youtubeLifecycleTotals(rows);
  lines.push(
    `[YouTubeLifecycle] TOTAL tracked=${t.tracked} adopted=${t.adopted} ` +
      `FIT=${t.FIT} MISMATCH=${t.MISMATCH} UNCLEAR=${t.UNCLEAR} NOT_ASKED=${t.NOT_ASKED} ` +
      `visionRecordMissing=${t.VISION_RECORD_MISSING} ` +
      `contentKeyNotAssetIdentity=${t.CONTENT_KEY_NOT_ASSET_IDENTITY} composeInput=${t.composeInput} ` +
      `composeSelected=${t.composeSelected} renderInput=${t.renderInput} ` +
      `finalVideo=${t.finalVideo} delivered=${t.delivered} ` +
      `vanishedAfterAdoption=${t.vanishedAfterAdoption} downstreamGap=${t.downstreamGap}`
  );
  lines.push(
    `[YouTubeLifecycle] VERDICT ${youtubeLifecycleVerdict(rows)} — ` +
      `"did a YouTube asset earn a real frame-vision FIT and then vanish before the film?"`
  );
  return lines;
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
