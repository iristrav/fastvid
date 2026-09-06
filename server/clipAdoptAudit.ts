/**
 * Per-video audit trail — clips successfully adopted per beat (for quality report geo checks).
 */
import * as path from "path";
import { recordGoodClipAdoption } from "./clipGoodCache";
import {
  relevanceVerdictForRenderedAsset,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import type { VisualSourceLedger } from "./visualSourceLineage";
import {
  adoptionPolicyFor,
  visionVerdictFromGate,
  type AdoptCategory,
  type AdoptionVisionVerdict,
} from "./adoptionPolicy";

export type ClipAdoptEntry = {
  sceneIndex: number;
  beatIndex: number;
  beatText: string;
  basename: string;
  source: string;
  assetTitle?: string;
  segmentGeoLock?: string | null;
  /** Worst CLIP frame score (0–10) when vision gate ran on adopt. */
  visionScore10?: number;
  /** DB asset ID — only set for own_archive clips, used for editorial score feedback. */
  assetId?: number;
};

export type AdoptAuditSummary = {
  beatsFilled: number;
  /**
   * RONDE 87: counts of ADOPT-ROUTE LABELS ("archive", "rescue_wikimedia", "fallback"), not of
   * providers. The two look alike and are not the same thing: "archive" here means the beat was
   * filled by the curated-archive route, and says nothing about which archive. The official
   * per-provider attribution is VisualSourceLedger.summary(); this stays what it has always been —
   * a breakdown of how beats were filled — and must not be read as a source statistic.
   */
  bySource: Record<string, number>;
  stockBeats: number;
  wikiBeats: number;
  archiveBeats: number;
  klingBeats: number;
  /** Beats whose ONLY adoption was a colour/text card — see the rule in `summarizeAdoptAudit`. */
  fallbackBeats: number;
  /**
   * Beats that got real footage AND a card, because the footage was shorter than the narration.
   * Counted under their real source above; here so the card is reported rather than dropped.
   */
  mixedBeats: number;
  /**
   * RONDE 177 — YouTube gets its own bucket, because it belongs in none of the others.
   *
   * R169 added `youtube_cc` to `FunnelCandidateSource` and the pool started producing it, but no
   * branch below matched the label, so a YouTube-filled beat counted toward `beatsFilled` and
   * toward no category at all. That is precisely the render-530 shape this function was fixed for
   * once already ("beats=13 wiki=0 arch=7 stock=0"), reappearing for a new source.
   *
   * A sixth bucket rather than a home in an existing one: YouTube is neither an archive nor stock
   * footage, and folding it into `archiveBeats` would put a number in front of a person that says
   * the render found archival material when it found a YouTube video.
   */
  youtubeBeats: number;
  hints: string[];
};

const MAX_ENTRIES = 120;

export function createClipAdoptAudit(): ClipAdoptEntry[] {
  return [];
}

/**
 * RONDE 86 — the audit array and the lineage ledger are two views of one event.
 *
 * Every adoption in the pipeline already flows through recordClipAdopt, and every call site
 * hands it `dedup.clipAdoptAudit`. Binding the render's ledger to that array means the lineage
 * is written at all ~20 of those sites without any of them changing, and — more importantly —
 * without a future adoption route being able to record an audit entry and forget the lineage.
 * A WeakMap keyed on the array keeps the ledger's lifetime exactly the render's: when the
 * VisualDedupState goes, so does the entry.
 */
const ledgerByAudit = new WeakMap<ClipAdoptEntry[], VisualSourceLedger>();

/**
 * How many adoptions this render could not trace to an existing lineage record.
 *
 * Keyed on the audit array, which is the render's own scope — the same handle `ledgerByAudit`
 * uses — so two concurrent renders count separately without either knowing the other exists.
 */
const untracedByAudit = new WeakMap<ClipAdoptEntry[], number>();

/** Name this many, then only count. A render that lost its lineage must not replace its own log. */
const UNTRACED_TO_NAME = 5;

export function bindLineageLedger(audit: ClipAdoptEntry[], ledger: VisualSourceLedger): void {
  ledgerByAudit.set(audit, ledger);
}

export function lineageLedgerFor(audit: ClipAdoptEntry[]): VisualSourceLedger | undefined {
  return ledgerByAudit.get(audit);
}

/**
 * RENDER 563 — WHICH ROUTE ADOPTED A PICTURE NOBODY LOOKED AT.
 *
 * ── What the render said about itself ───────────────────────────────────────────────────────
 *
 *     beat image gate — attempts=38 answered=38 (fits=20 does_not_fit=18) failed=0 never_asked=21
 *
 *     [BeatVisual] scene=0 beat=0 verification=never_asked reason=real_footage_never_judged source=archive
 *     [BeatVisual] scene=1 beat=0 verification=never_asked reason=real_footage_never_judged source=archive
 *     [BeatVisual] scene=1 beat=1 verification=never_asked reason=real_footage_never_judged source=rescue_stock
 *     [BeatVisual] scene=1 beat=2 verification=never_asked reason=real_footage_never_judged source=archive
 *
 * Real footage in the delivered video that the picture editor was never asked about. Not an
 * outage — `failed=0`, and every one of the 38 questions put was answered. Not the budget either:
 * 38 of a possible 120. The questions were simply never asked.
 *
 * ── Why this is measured rather than guessed ────────────────────────────────────────────────
 *
 * `recordClipAdopt` has 35 call sites. Two routes are known to do the right thing — the funnel's
 * look loop judges each candidate and puts an unjudged winner back, and the adopt loop requeues a
 * refused clip instead of dropping it. Reading the other thirty-three by eye and deciding which
 * ones can reach an adoption without a verdict is exactly the kind of reasoning that has been
 * wrong before in this file's own history.
 *
 * So the render answers it. Every adoption already passes through here — that is the whole
 * argument for `bindLineageLedger` directly above — and here the relevance ledger can be asked
 * whether THIS clip was judged for THIS beat. When it was not, the adoption is recorded with its
 * ROUTE LABEL, and the render prints the list. The next render names the guilty routes instead of
 * anyone inferring them.
 *
 * Nothing is blocked and no verdict is invented: this observes. Deciding what a route should do
 * instead — keep searching until something passes — is the change that follows, and it needs to
 * know where to be made.
 */
export type UnjudgedAdoption = {
  sceneIndex: number;
  beatIndex: number;
  basename: string;
  /** The adopt-route label, which is the thing this measurement exists to name. */
  source: string;
};

const relevanceByAudit = new WeakMap<ClipAdoptEntry[], BeatRelevanceLedger>();
const unjudgedByAudit = new WeakMap<ClipAdoptEntry[], UnjudgedAdoption[]>();

export function bindRelevanceLedger(audit: ClipAdoptEntry[], ledger: BeatRelevanceLedger): void {
  relevanceByAudit.set(audit, ledger);
}

export function unjudgedAdoptions(audit: ClipAdoptEntry[]): readonly UnjudgedAdoption[] {
  return unjudgedByAudit.get(audit) ?? [];
}

/**
 * One line per route, so the report says WHERE rather than merely HOW MANY.
 *
 * Returns [] when every adopted picture was judged — the state this is meant to reach, and one
 * that must not print a line claiming a clean render is worth reading about.
 */
export function formatUnjudgedAdoptions(audit: ClipAdoptEntry[]): string[] {
  const found = unjudgedAdoptions(audit);
  if (found.length === 0) return [];
  const byRoute = new Map<string, UnjudgedAdoption[]>();
  for (const entry of found) {
    const list = byRoute.get(entry.source) ?? [];
    list.push(entry);
    byRoute.set(entry.source, list);
  }
  const lines = [
    `[UnjudgedAdoption] ${found.length} clip(s) became a beat's picture with no verdict on that beat`,
  ];
  for (const [source, entries] of [...byRoute.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const where = entries
      .slice(0, 6)
      .map((e) => `s${e.sceneIndex}b${e.beatIndex}`)
      .join(",");
    lines.push(
      `[UnjudgedAdoption]   route=${source} count=${entries.length} beats=${where}` +
        (entries.length > 6 ? ",…" : "")
    );
  }
  return lines;
}

/** Records an adoption the relevance ledger holds no verdict for. Never throws, never blocks. */
function noteIfUnjudged(
  audit: ClipAdoptEntry[],
  sceneIndex: number,
  beatIndex: number,
  clipPath: string,
  source: string,
  contentKey?: string
): void {
  const relevance = relevanceByAudit.get(audit);
  /** No ledger bound is not evidence of anything — a caller outside a render records nothing. */
  if (!relevance) return;
  const verdict = relevanceVerdictForRenderedAsset(relevance, {
    localPath: clipPath,
    currentFilename: path.basename(clipPath),
    ...(contentKey ? { contentKey } : {}),
    sceneIndex,
    beatIndex,
  });
  if (verdict) return;
  const list = unjudgedByAudit.get(audit) ?? [];
  list.push({ sceneIndex, beatIndex, basename: path.basename(clipPath), source });
  unjudgedByAudit.set(audit, list);
}

/**
 * RONDE 92 — IS THIS ROUTE'S CLAIM ACTUALLY BACKED?
 *
 * `adoptionPolicy` says what a route MAY claim. This asks whether the render holds the evidence.
 * A REAL_FUNNEL route declares `requiresEligibility` and `requiresVision`; the ledger knows
 * whether the asset ever reached ELIGIBLE, and the relevance ledger knows whether the picture
 * editor judged it for this beat.
 *
 * ── The read side that never existed ────────────────────────────────────────────────────────
 *
 * `ELIGIBLE` has been a lineage stage since RONDE 87 and is written at two places in the whole
 * pipeline. Nothing ever asked the question back, which is why render 568 could report
 * `wikimedia retrieved=400 eligible=0 adopted=2` without any part of the render objecting.
 * `VisualSourceLedger.hasStage` is that query; this is its first caller.
 *
 * ── Measured now, enforced next — and why that order is not a hedge ─────────────────────────
 *
 * RONDE 92's own prohibition list forbids blocking adoption before eligibility is correctly
 * registered. Today it is not: two write sites against 35 adoption routes. Refusing or demoting
 * every unbacked REAL_FUNNEL claim right now would hit essentially all of them, drive
 * `verifiedOwnVisual` to zero, and make RONDE 89's export gate refuse every render — a brick,
 * not a repair.
 *
 * So this produces the one number that decides when enforcement is safe: how many adoptions claim
 * the funnel, and how many of those the ledger can back. The invariants are already named (H, I)
 * and the guard is one `if` away once that number says so.
 */
export type AdoptionEvidence = {
  sceneIndex: number;
  beatIndex: number;
  source: string;
  basename: string;
  category: AdoptCategory;
  /** Did the ledger ever record ELIGIBLE for this asset (or the asset it derives from)? */
  eligible: boolean;
  /** Did the picture editor return a verdict for this clip on this beat? */
  judged: boolean;
  /**
   * RONDE 94 — WHAT the editor said, not merely whether it spoke.
   *
   * `judged` is kept because it answers a different question the funnel audit still asks ("was
   * this picture ever put to the editor at all"), and because collapsing the two would lose the
   * distinction between a picture nobody looked at and one that was looked at and refused. Only
   * APPROVED backs a REAL_FUNNEL claim.
   */
  vision: AdoptionVisionVerdict;
  /** True when the route's declared requirements are all met by the evidence above. */
  backed: boolean;
};

const evidenceByAudit = new WeakMap<ClipAdoptEntry[], AdoptionEvidence[]>();

export function adoptionEvidence(audit: ClipAdoptEntry[]): readonly AdoptionEvidence[] {
  return evidenceByAudit.get(audit) ?? [];
}

function noteAdoptionEvidence(
  audit: ClipAdoptEntry[],
  sceneIndex: number,
  beatIndex: number,
  clipPath: string,
  source: string
): void {
  const policy = adoptionPolicyFor(source);
  const ledger = ledgerByAudit.get(audit);
  const relevance = relevanceByAudit.get(audit);

  /**
   * No ledger bound is a caller outside a render; it proves nothing either way.
   *
   * RONDE 94: the same central helper the montage guard asks, so the evidence line and the
   * refusal can never disagree about whether a clip was eligible.
   */
  const eligible = Boolean(ledger?.isEligible(clipPath));
  const judgement = relevance
    ? relevanceVerdictForRenderedAsset(relevance, {
        localPath: clipPath,
        currentFilename: path.basename(clipPath),
        sceneIndex,
        beatIndex,
      })
    : null;
  const judged = Boolean(judgement);
  const vision = visionVerdictFromGate(judgement?.verdict);

  /**
   * RONDE 94: `backed` now means what the guard means by it — APPROVED, not "spoken about".
   * The two readings must agree, or the evidence line would report as backed exactly the
   * adoptions the montage guard refuses.
   */
  const backed =
    (!policy.requiresEligibility || eligible) &&
    (!policy.requiresVision || vision === "APPROVED");

  const list = evidenceByAudit.get(audit) ?? [];
  list.push({
    sceneIndex,
    beatIndex,
    source,
    basename: path.basename(clipPath),
    category: policy.category,
    eligible,
    judged,
    vision,
    backed,
  });
  evidenceByAudit.set(audit, list);
}

/**
 * Invariants H and I, as counted findings rather than prose.
 *
 * H — a route claiming REAL_FUNNEL that the ledger cannot show ever became eligible.
 * I — a route claiming REAL_FUNNEL whose picture the editor never judged for its beat.
 *
 * A render where every funnel claim is backed prints one clean line and no warnings, which is the
 * state this is aiming at and the reason the warnings are separate from the census.
 */
export function formatAdoptionEvidence(audit: ClipAdoptEntry[]): string[] {
  const all = adoptionEvidence(audit);
  if (all.length === 0) return [];
  const funnel = all.filter((e) => e.category === "REAL_FUNNEL");
  const backed = funnel.filter((e) => e.backed).length;
  const noEligibility = funnel.filter((e) => !e.eligible);
  const noVision = funnel.filter((e) => !e.judged);
  const lines = [
    `[AdoptionEvidence] adoptions=${all.length} realFunnel=${funnel.length} ` +
      `backed=${backed} withoutEligibility=${noEligibility.length} ` +
      `withoutVision=${noVision.length}`,
  ];
  const name = (list: readonly AdoptionEvidence[]) =>
    [...new Set(list.map((e) => e.source))].sort().join(",");
  if (noEligibility.length > 0) {
    lines.push(
      `[AdoptionEvidence] INVARIANT_H REAL_FUNNEL_ADOPTION_WITHOUT_ELIGIBILITY ` +
        `count=${noEligibility.length} routes=${name(noEligibility)} — ` +
        `the ledger holds no ELIGIBLE event for these assets`
    );
  }
  if (noVision.length > 0) {
    lines.push(
      `[AdoptionEvidence] INVARIANT_I REAL_FUNNEL_ADOPTION_WITHOUT_VISION ` +
        `count=${noVision.length} routes=${name(noVision)} — ` +
        `no verdict was recorded for these pictures on their beats`
    );
  }
  return lines;
}

export function recordClipAdopt(
  audit: ClipAdoptEntry[],
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  clipPath: string,
  source: string,
  assetTitle?: string,
  segmentGeoLock?: string | null,
  assetId?: number,
  visionScore10?: number
): void {
  // Deliberately BEFORE the MAX_ENTRIES guard. That cap exists to bound a log array that is
  // summarised for a report; the lineage is the record of what is in the finished video, and a
  // long render must not stop recording provenance at clip 120.
  const ledger = ledgerByAudit.get(audit);
  const route = adoptRouteForSource(source);
  /**
   * RENDER 563 — before anything else, and outside the `if (ledger)` below.
   *
   * The lineage may be absent; whether a picture was looked at is a separate question with its own
   * ledger, and a render missing one must still be able to answer the other. Placed with the same
   * reasoning as the MAX_ENTRIES note above: this is the record of what went into the video, and
   * it must not stop at clip 120 either.
   */
  noteIfUnjudged(audit, sceneIndex, beatIndex, clipPath, source);
  noteAdoptionEvidence(audit, sceneIndex, beatIndex, clipPath, source);
  if (ledger) {
    const record = ledger.resolve(clipPath);
    if (record) {
      // The route and the beat identity are facts this call carries; the PROVIDER is not. It
      // stays whatever the record was opened with, because `source` here is an adopt-route label
      // ("archive", "rescue_wikimedia", "fallback") and treating a route label as a provider is
      // the specific mistake RONDE 87 exists to make impossible.
      record.route = route;
      record.sceneIndex = sceneIndex;
      record.beatIndex = beatIndex;
      record.sourceLabel = source;
      record.beatText ??= beatText?.slice(0, 240) || undefined;
      record.assetTitle ??= assetTitle?.trim() || undefined;
      record.archiveAssetId ??= typeof assetId === "number" ? assetId : undefined;
      record.visionScore ??=
        typeof visionScore10 === "number" && visionScore10 > 0 ? Math.round(visionScore10) : undefined;
      ledger.recordEvent(record.lineageId, "ADOPTED", { status: "OK", currentPath: clipPath });
    } else {
      /**
       * RONDE 87: an adoption of a clip the ledger has never seen.
       *
       * This is a real hole in the instrumentation, not something to paper over. A record is
       * opened so the clip is at least accounted for and reconcile() can find it — with NO
       * provider, so it is counted in the UNVERIFIED bucket and shows up in the audit as a clip
       * whose origin this render cannot prove. Passing `source` as the provider here would have
       * turned every such hole into a confident, wrong answer.
       *
       * ── P11: and it now SAYS SO, which it never did ──────────────────────────────────────
       *
       * `resolve` is generous before it gives up: the exact path, then the derivation chain, then
       * the content key. Reaching here means all three missed, and the usual cause is a file
       * written from another file by a site that registered neither — `linkDerivedPath`'s contract
       * is "call it at every site that writes a new file from an existing one", and a contract kept
       * by convention is a contract that drifts. One asset then becomes several records: one for
       * the original and one for every copy, each of the copies UNVERIFIED.
       *
       * The aggregate was visible — `[AssetLifecycleAudit]` counts the UNVERIFIED bucket — and
       * WHICH clip and WHICH route were not, so the number could be watched and never diagnosed.
       * Render 555's eighteen unexplained assets took a production log and a whole round to trace
       * to one cause.
       *
       * Bounded, because a render that loses its lineage wholesale would otherwise replace its own
       * log with this line. The first few name the clip; after that only the count grows, and the
       * bucket in the audit remains the authority on how many there were.
       */
      const seen = (untracedByAudit.get(audit) ?? 0) + 1;
      untracedByAudit.set(audit, seen);
      if (seen <= UNTRACED_TO_NAME) {
        console.warn(
          `[Lineage] UNTRACED_ADOPTION s${sceneIndex}b${beatIndex} route=${route} ` +
            `source=${source} clip=${path.basename(clipPath)} — no record for this path, its ` +
            "derivation chain or its content key; adopted as UNVERIFIED"
        );
      } else if (seen === UNTRACED_TO_NAME + 1) {
        console.warn(
          `[Lineage] UNTRACED_ADOPTION — further occurrences are counted, not named. ` +
            "See the UNVERIFIED bucket in [AssetLifecycleAudit] for the total."
        );
      }
      const created = ledger.createLineage({
        sceneIndex,
        beatIndex,
        beatText: beatText?.slice(0, 240) || undefined,
        candidateId: path.basename(clipPath),
        contentKey: "",
        localPath: clipPath,
        route,
        sourceLabel: source,
        assetTitle: assetTitle?.trim() || undefined,
        archiveAssetId: typeof assetId === "number" ? assetId : undefined,
        visionScore:
          typeof visionScore10 === "number" && visionScore10 > 0 ? Math.round(visionScore10) : undefined,
      });
      ledger.recordEvent(created.lineageId, "ADOPTED", { status: "OK", currentPath: clipPath });
    }
  }

  if (audit.length >= MAX_ENTRIES) return;
  const entry: ClipAdoptEntry = {
    sceneIndex,
    beatIndex,
    beatText,
    basename: path.basename(clipPath),
    source,
    assetTitle: assetTitle?.trim() || undefined,
    segmentGeoLock: segmentGeoLock ?? undefined,
    visionScore10:
      typeof visionScore10 === "number" && visionScore10 > 0 ? Math.round(visionScore10) : undefined,
    assetId: typeof assetId === "number" ? assetId : undefined,
  };
  audit.push(entry);
  recordGoodClipAdoption(entry, assetId);
}

/**
 * Which of the ledger's routes an adopt-audit source label describes.
 *
 * The labels are the pipeline's own vocabulary and already encode this: "rescue_*" is the rescue
 * ladder, "fallback"/"rescue_placeholder" is a colour card, and everything else is a beat filled
 * by the route that was supposed to fill it.
 */
export function adoptRouteForSource(source: string): "primary" | "fallback" | "rescue" | "backfill" | "graphic" {
  const s = (source ?? "").trim().toLowerCase();
  if (s === "fallback" || s === "rescue_placeholder") return "fallback";
  if (s.startsWith("rescue_")) return "rescue";
  if (
    s === "guaranteed" || s.startsWith("backfill") || s === "rescue_extend" || s === "extend" ||
    // RONDE 112: real footage, but not of what the beat claimed — the beat was filled by
    // something other than the route that was supposed to fill it, which is what "backfill"
    // means here. Calling it "primary" would report a match that was never made.
    s === "subject_fallback"
  ) {
    return "backfill";
  }
  if (s === "motion_graphic" || s === "graphic" || s === "mgfx") return "graphic";
  return "primary";
}

/** Summarize adopt audit for qualityReport — sourcing mix per beat. */
/**
 * A colour or text card, as opposed to media something chose.
 *
 * The two labels every per-beat guaranteed-fill site records — see `guaranteedAdoptSource` and the
 * placeholder rung beside it.
 */
export function isFillerAdoptSource(source: string): boolean {
  return source === "fallback" || source === "rescue_placeholder";
}

/**
 * WHICH ENTRY SPEAKS FOR A BEAT — one definition, because two summarisers needed it and only one
 * had it.
 *
 * `pushClip` APPENDS, so a beat can hold real footage AND a card. "The last entry wins" then keeps
 * the card and discards the footage. `summarizeAdoptAudit` was fixed for that; `buildBeatVisualStatuses`
 * was not, and it is the one RONDE 89's export gate reads:
 *
 *     NO_VERIFIED_OWN_VISUAL: 0 of 16 beat(s) got an approved picture of their own
 *     (never_asked=15, own_footage=3)
 *
 * Fifteen of sixteen beats reported "nothing to judge — placeholder" while their real clips sat in
 * the same audit, one entry earlier. A beat cannot earn a verified visual for a picture the
 * bookkeeping threw away, so the gate refused a film that had footage.
 *
 * Sentinel indices (scene padding, never a narrative beat) are excluded here so both callers agree
 * about what a beat even is.
 */
export function representativeAdoptEntryPerBeat(audit: readonly ClipAdoptEntry[]): {
  entries: Map<string, ClipAdoptEntry>;
  /** Beats that held real footage AND a card. Counted as real; reported so the card is not lost. */
  mixedBeats: number;
} {
  const isSentinel = (beatIndex: number): boolean =>
    beatIndex >= 2000 || beatIndex === 999 || beatIndex === 1001 || beatIndex === 8888 || beatIndex === 9999;

  const perBeat = new Map<string, ClipAdoptEntry[]>();
  for (const entry of audit) {
    if (isSentinel(entry.beatIndex)) continue;
    const key = `${entry.sceneIndex}:${entry.beatIndex}`;
    const seen = perBeat.get(key);
    if (seen) seen.push(entry);
    else perBeat.set(key, [entry]);
  }

  const entries = new Map<string, ClipAdoptEntry>();
  let mixedBeats = 0;
  for (const [key, all] of perBeat) {
    const real = all.filter((e) => !isFillerAdoptSource(e.source));
    /** Among real adoptions the newest still wins — the case the old rule was right about. */
    entries.set(key, real.length > 0 ? real[real.length - 1]! : all[all.length - 1]!);
    if (real.length > 0 && real.length < all.length) mixedBeats += 1;
  }
  return { entries, mixedBeats };
}

export function summarizeAdoptAudit(audit: ClipAdoptEntry[]): AdoptAuditSummary {
  const bySource: Record<string, number> = {};
  for (const entry of audit) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
  }

  // Production finding: recordClipAdopt can be called more than once for the SAME
  // sceneIndex+beatIndex — independent recovery layers (compose-time rescue, strict-refill
  // "already attempted" guaranteed-fill, emergency-finish, Path A/B rescue loops, ...) can each
  // re-attempt the same beat and each record their own adopt entry. Counting every entry toward
  // fallbackBeats/stockBeats/etc. double-counted those re-attempts as separate beats — a real
  // render logged "35/14 filled beat(s) used the color/text fallback", which is impossible if
  // beatsFilled (14) is genuinely the number of unique beats. Each unique beat now contributes
  // its FINAL recorded source exactly once — later entries for the same beat are presumed to
  // reflect that beat's more current state (the same assumption the render pipeline itself makes
  // when a later recovery layer re-adopts a beat).
  // Final review round — Bug 2: several guaranteed-fill call sites record scene-level "padding"
  // adopt entries under a sentinel beatIndex (999, 1001, 8888, 9999, and the 2000+slot range used
  // by appendGuaranteedSceneClips) specifically so they can never collide with a real narrative
  // beatIndex. Those sentinel entries don't correspond to one of the scene's actual narrative
  // beats — counting them here would inflate beatsFilled past the true beat count (e.g. 14 real
  // narrative beats + 6 sentinel entries must still report beatsFilled = 14, not 20).
  const isSentinelBeatIndex = (beatIndex: number): boolean =>
    beatIndex >= 2000 || beatIndex === 999 || beatIndex === 1001 || beatIndex === 8888 || beatIndex === 9999;

  /**
   * RENDER 569 — "LATER WINS" IS WRONG WHEN THE LATER ENTRY IS A FILLER.
   *
   * ── What the log showed ─────────────────────────────────────────────────────────────────────
   *
   * One render, two summaries of the same events, saying opposite things:
   *
   *     [VisualCoverageFinal] scene=1 beat=1 status=adopted coverage=REAL_PLUS_FILLER
   *                           fillTier=color_fallback origin=archive selected=scene_1_b1_curated_a57649.mp4
   *     …ten such beats: archive x6, wikimedia x2, serpapi x2…
   *     [Quality] Video 569: adopt audit beats=14 wiki=0 arch=0 stock=0 kling=0
   *
   * The per-beat ledger named ten adopted files. This function reported none, and
   * `assertVisualCoverageExportGate` — which decides on `fallbackBeats / beatsFilled` — refused the
   * film for "14/14 filled beat(s) used the color/text fallback".
   *
   * ── Why both were reading the same events ───────────────────────────────────────────────────
   *
   * A beat is not one slot. `pushClip` APPENDS, so a colour card is added to whatever the beat
   * already holds rather than replacing it — established by render 562 and encoded in
   * `resolveBeatCoverage`, which is exactly why REAL_PLUS_FILLER exists as a category. Every one of
   * the three per-beat guaranteed-fill sites therefore records a SECOND adopt entry, `fallback` or
   * `rescue_placeholder`, under the beat's REAL index, after the real adoption.
   *
   * "Later wins" then discarded the archive clip and kept the card. The rule was written for a
   * different problem — the same beat re-adopted by successive recovery layers, which produced an
   * impossible "35/14" — and for real-to-real transitions it is still right. It was never true for
   * real-to-filler, because that is not a re-adoption: both are on screen.
   *
   * ── The rule ────────────────────────────────────────────────────────────────────────────────
   *
   * A beat counts as a fallback beat only when a filler is ALL it ever got. Where real media and a
   * filler both landed, the beat is counted under its real source and also counted in `mixedBeats`,
   * so the filler is reported rather than dropped — losing it would trade one dishonest number for
   * another.
   *
   * This does not open the export gate. Render 569 would still be refused, by RONDE 89's
   * NO_VERIFIED_OWN_VISUAL block: `verifiedOwnVisual=0` is a fact about approvals, untouched here.
   * What changes is that a film with real footage on most of its beats stops being described as a
   * film of colour cards.
   */
  const representative = representativeAdoptEntryPerBeat(audit);
  const finalSourceByBeat = new Map<string, string>();
  for (const [key, entry] of representative.entries) finalSourceByBeat.set(key, entry.source);
  /** Beats the viewer saw real footage on AND a filler — counted as real, reported as mixed. */
  const mixedBeats = representative.mixedBeats;

  let stockBeats = 0;
  let wikiBeats = 0;
  let archiveBeats = 0;
  let klingBeats = 0;
  let fallbackBeats = 0;
  let youtubeBeats = 0;

  for (const source of finalSourceByBeat.values()) {
    if (source === "pexels" || source === "pixabay" || source === "stock" || source === "rescue_stock") {
      stockBeats += 1;
    } else if (
      source === "wikimedia" || source === "wikimedia_video" ||
      /**
       * RONDE 90 — the guaranteed ladder's Commons rung, under its honest label.
       *
       * `guaranteedAdoptSource("wikimedia")` used to return the bare string "wikimedia", so a
       * last-resort rescue image and a retrieved, ranked, judged Wikimedia asset were recorded as
       * the same thing — which is how render 568 reported `wikimedia eligible=0 adopted=2`. It now
       * returns `rescue_wikimedia`, and the ROUTE is honest.
       *
       * The MEDIA is still a Commons file, and RONDE 50's claim about it stands: a beat the ladder
       * saved with real media is not a fallback beat and belongs in this bucket. Splitting the
       * route label without splitting the provider count would have moved a real Commons picture
       * into "no wiki, no archive" and made the sourcing hints below say the opposite of the truth.
       */
      source === "rescue_wikimedia"
    ) {
      wikiBeats += 1;
    } else if (
      source === "archive" || source === "archive_fetch" ||
      source.startsWith("rescue_similar") || source === "rescue_archive" ||
      // RONDE 51: the real provider names the scene-pool path reports. These are archives —
      // Internet Archive, Library of Congress, NARA, NASA, Openverse, media.ccc.de — but none of
      // them matched any branch, so a beat filled from one of them counted toward beatsFilled
      // and toward no category at all. Render 530 reported "beats=13 wiki=0 arch=7 stock=0"
      // while six of those thirteen beats had come from exactly these sources.
      source === "internet_archive" || source === "loc" || source === "nara" ||
      source === "nasa" || source === "openverse" || source === "mediaccc" ||
      source === "europeana" || source === "gdelt" || source === "sepiasearch" ||
      source === "flickr" || source === "rescue_wikimedia"
    ) {
      archiveBeats += 1;
    } else if (source === "youtube_cc" || source === "youtube") {
      /**
       * Both spellings, because both exist in this codebase already: the pool emits `youtube_cc`
       * and `assetRehydrator` fetches a clip back under either provider name. Pairing them here
       * follows what the rehydrator already treats as one source rather than inventing a second
       * vocabulary for the same thing.
       */
      youtubeBeats += 1;
    } else if (source === "kling" || source === "rescue_ai") {
      klingBeats += 1;
    } else if (source === "fallback" || source === "rescue_placeholder") {
      fallbackBeats += 1;
    }
  }

  const beatsFilled = finalSourceByBeat.size;
  const hints: string[] = [];
  /**
   * RONDE 177 — the hint names what actually filled the beats.
   *
   * "Alle beats via stock/Kling" was true while those were the only two non-archive buckets. With
   * YouTube counted it can be false, and a hint that misnames the source sends the reader off to
   * upload archive material to fix something that is not the problem. So the hint only fires when
   * no YouTube beat is in the mix either, and there is a separate line for that case.
   */
  if (beatsFilled > 0 && wikiBeats === 0 && archiveBeats === 0 && youtubeBeats === 0) {
    hints.push("Alle beats via stock/Kling — upload meer relevant archief (vision + semantic match).");
  } else if (youtubeBeats > 0 && wikiBeats === 0 && archiveBeats === 0) {
    hints.push(
      `${youtubeBeats}/${beatsFilled} beats van YouTube — geen archief/Commons materiaal gevonden voor deze scènes.`
    );
  }
  if (stockBeats > beatsFilled * 0.5 && beatsFilled >= 3) {
    hints.push(`${stockBeats}/${beatsFilled} beats uit stock — meer archiefclips helpen (geen geo-tags nodig).`);
  }
  if (klingBeats > 0) {
    hints.push(`${klingBeats} Kling-clip(s) — controleer of archief/stock beter kan matchen.`);
  }
  if (fallbackBeats > 0) {
    hints.push(`${fallbackBeats} kleur-fallback beat(s) — sourcing faalde op die zinnen.`);
  }
  /**
   * Named separately from `fallbackBeats`, because they are a different problem with a different
   * fix: the beat DID find footage, and the footage was shorter than the narration it plays under.
   * Folding these into the fallback count is what made render 569 read as fourteen colour cards.
   */
  if (mixedBeats > 0) {
    hints.push(
      `${mixedBeats} beat(s) met echt beeld én een kleurkaart — het beeld was korter dan de zin.`
    );
  }

  return {
    beatsFilled,
    bySource,
    stockBeats,
    wikiBeats,
    archiveBeats,
    klingBeats,
    fallbackBeats,
    mixedBeats,
    youtubeBeats,
    hints,
  };
}
