/**
 * R194 — THE PICTURE EDITOR'S ANSWER DECIDES THE PICTURE.
 *
 * ── The defect, in one line of the adoption loop ─────────────────────────────────────────────
 *
 * `beatVisualRelevance` builds every decision as
 *
 *     allowed: judgement.verdict !== "does_not_fit"
 *
 * and `adoptClip` walks its ranked candidates and adopts the first one whose `allowed` is true.
 * `allowed` folds two completely different answers together — "this fits" and "I cannot tell" —
 * so the loop stops at the first candidate the editor merely FAILED TO REFUSE. A picture the
 * editor could not read, at cheap rank 2, ends the search before the picture it would have called
 * a fit, at cheap rank 5, is ever reached.
 *
 * That is not a threshold to move or a budget to raise. The evidence was gathered, written to the
 * relevance ledger, printed in the log — and then not used for the one decision it exists to
 * inform. It is this codebase's signature defect: a value computed and then not carried.
 *
 * ── What replaces it ────────────────────────────────────────────────────────────────────────
 *
 * Explicit tiers, not a score. R194 §27 asks for exactly this and says why: inventing `FIT = +100`
 * would put the editor's answer into the same arithmetic as the cheap ranking and make the two
 * negotiable against each other. They are not the same kind of fact. The cheap ranking says which
 * candidate looks most promising; the editor says whether the picture is right. So the editor's
 * answer picks the TIER and the cheap ranking orders WITHIN it:
 *
 *     FIT         the editor looked and said yes
 *     UNREVIEWED  nobody looked — no evidence either way
 *     UNCLEAR     the editor looked and could not tell
 *     MISMATCH    the editor looked and said no
 *
 * UNREVIEWED above UNCLEAR is the one ordering worth defending. An UNCLEAR is weak NEGATIVE
 * evidence: a model with the frames in front of it failed to recognise the subject. An unreviewed
 * candidate carries no evidence at all, and the cheap ranking that put it high is then the best
 * information anyone has about it. Ranking "we looked and could not tell" above "we never looked"
 * would be treating a failed look as a partial pass.
 *
 * MISMATCH is not a tier a candidate can be selected from. It stays in the list because the
 * existing reprieve — a real picture beats a grey card when every alternative failed too — is a
 * deliberate, documented override, and an override has to have something to override.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────────────────────
 *
 * A second ranking engine. It computes no scores, reads no candidate metadata, retrieves nothing
 * and re-orders nothing that the existing ranking ordered. It takes the ranking as given, takes
 * the editor's verdicts as given, and answers one question neither of them answered alone: given
 * both, which candidate should this beat use.
 */

/** What the picture editor established about a candidate. Four answers, never folded. */
export type VisionEvidence = "FIT" | "UNREVIEWED" | "UNCLEAR" | "MISMATCH";

/**
 * Selection order, best first. The array IS the priority — a tier's rank is its index — so the
 * ordering cannot be stated in one place and implemented differently in another.
 */
export const VISION_EVIDENCE_ORDER: readonly VisionEvidence[] = [
  "FIT",
  "UNREVIEWED",
  "UNCLEAR",
  "MISMATCH",
];

export function evidenceTier(evidence: VisionEvidence): number {
  const at = VISION_EVIDENCE_ORDER.indexOf(evidence);
  /** An unknown value sorts last rather than first: a name nobody recognises is not a promotion. */
  return at < 0 ? VISION_EVIDENCE_ORDER.length : at;
}

/** MISMATCH is the only evidence a beat may not simply select from. */
export function isSelectableEvidence(evidence: VisionEvidence): boolean {
  return evidence !== "MISMATCH";
}

/**
 * Read the editor's answer off the relevance ledger's own verdict.
 *
 * `evaluated === false` is a DECLINE, not a verdict — the gate was off, there was no narration,
 * the look budget was spent. `beatVisualRelevance` documents that distinction and this is the one
 * place that acts on it: a decline is UNREVIEWED, and `unknown` from a model that actually looked
 * is UNCLEAR. Collapsing the two is the bug `evaluated` was added to fix.
 *
 * A missing verdict is UNREVIEWED for the same reason. Absent is absent; inferring a fit or a
 * mismatch from silence is the guess this whole round exists to stop.
 */
export function evidenceFromVerdict(input: {
  verdict?: string | null;
  evaluated?: boolean;
}): VisionEvidence {
  if (input.evaluated === false) return "UNREVIEWED";
  if (input.verdict === "fits") return "FIT";
  if (input.verdict === "does_not_fit") return "MISMATCH";
  if (input.verdict === "unknown") return "UNCLEAR";
  return "UNREVIEWED";
}

/** A candidate the cheap ranking has already placed. `cheapRank` 0 is the ranking's own best. */
export type ReviewCandidate = {
  contentKey: string;
  cheapRank: number;
};

export type ReviewedCandidate = ReviewCandidate & {
  evidence: VisionEvidence;
  clipPath?: string;
};

/**
 * THE BOUNDED REVIEW POOL — which candidates this beat may spend the editor's attention on.
 *
 * Deterministic by construction: sorted on `cheapRank`, ties broken on `contentKey`, then cut at
 * the cap. `contentKey` is the asset's canonical identity (`provider:assetId`), so two candidates
 * the ranking could not separate are separated by something stable across renders rather than by
 * whichever route happened to finish first — R194 §22, and the reason a random tiebreak and arrival
 * order are both wrong answers to the same question.
 *
 * The cap is the caller's existing vision budget. Nothing here raises it, and a pool larger than
 * the budget would be a promise the render cannot keep.
 */
export function buildVisionReviewPool<T extends ReviewCandidate>(
  ranked: readonly T[],
  cap: number
): T[] {
  if (cap <= 0) return [];
  return [...ranked]
    .sort((a, b) => a.cheapRank - b.cheapRank || a.contentKey.localeCompare(b.contentKey))
    .slice(0, cap);
}

/**
 * THE VISION-AWARE FINAL SHORTLIST — the reviewed candidates in the order the beat should use
 * them.
 *
 * Tier first, cheap rank within the tier, content key to break a tie. MISMATCH candidates are
 * kept, last, and never at the front of a list that has anything else in it: the reprieve needs
 * them, and dropping them here would hide a beat whose every candidate was refused.
 */
export function visionAwareFinalShortlist<T extends ReviewedCandidate>(
  reviewed: readonly T[]
): T[] {
  return [...reviewed].sort(
    (a, b) =>
      evidenceTier(a.evidence) - evidenceTier(b.evidence) ||
      a.cheapRank - b.cheapRank ||
      a.contentKey.localeCompare(b.contentKey)
  );
}

/** The candidate this beat should adopt, or null when every candidate was refused. */
export function bestByVisionEvidence<T extends ReviewedCandidate>(
  reviewed: readonly T[]
): T | null {
  const selectable = visionAwareFinalShortlist(reviewed).filter((c) =>
    isSelectableEvidence(c.evidence)
  );
  return selectable[0] ?? null;
}

/* ═══════════════════════ the render-scoped, beat-scoped record ═══════════════════════ */

export type BeatReviewPool = {
  sceneIndex: number;
  beatIndex: number;
  cap: number;
  /** Content keys the cheap ranking nominated, best first. Intent, before anything was asked. */
  declared: string[];
  /** What the editor was actually asked about, and what it answered. */
  reviewed: ReviewedCandidate[];
  /** The content key this beat ended up using, once it is known. */
  adopted?: string;
};

/**
 * One pool per beat, one state per render.
 *
 * Held on the render's own dedup state exactly as `beatShortlist` is — no module-level array, no
 * `currentBeat`, nothing a second render in the same process could reach. R194 §39/§40 ask for
 * both scopes and the map key is what enforces the second: a beat can only ever read its own row.
 */
export type VisionReviewPoolState = {
  beats: Map<string, BeatReviewPool>;
};

export function createVisionReviewPoolState(): VisionReviewPoolState {
  return { beats: new Map() };
}

const poolKey = (sceneIndex: number, beatIndex: number): string => `${sceneIndex}:${beatIndex}`;

export function beatReviewPool(
  state: VisionReviewPoolState,
  sceneIndex: number,
  beatIndex: number,
  cap = 0
): BeatReviewPool {
  const k = poolKey(sceneIndex, beatIndex);
  const existing = state.beats.get(k);
  if (existing) {
    if (cap > existing.cap) existing.cap = cap;
    return existing;
  }
  const fresh: BeatReviewPool = { sceneIndex, beatIndex, cap, declared: [], reviewed: [] };
  state.beats.set(k, fresh);
  return fresh;
}

/**
 * Say which candidates this beat intends to put to the editor, before it asks anything.
 *
 * Declared separately from what was reviewed because the two can differ for an honest reason: a
 * declared candidate can fail a cheap technical gate — an unreadable file, a duplicate already
 * used — and never reach the editor at all, and the next-best candidate then takes the freed slot.
 * Recording only the asks would make that substitution invisible; recording both makes it a
 * number.
 */
export function declareVisionReviewPool(
  state: VisionReviewPoolState | undefined,
  sceneIndex: number,
  beatIndex: number,
  ranked: readonly ReviewCandidate[],
  cap: number
): void {
  if (!state) return;
  const pool = beatReviewPool(state, sceneIndex, beatIndex, cap);
  /** A route that runs after another has already declared adds nothing — the first cut stands. */
  if (pool.declared.length > 0) return;
  pool.declared = buildVisionReviewPool(ranked, cap).map((c) => c.contentKey);
}

/** One candidate was put to the editor and answered. Re-answering replaces, never appends. */
export function noteVisionReviewed(
  state: VisionReviewPoolState | undefined,
  sceneIndex: number,
  beatIndex: number,
  candidate: ReviewedCandidate
): void {
  if (!state) return;
  const pool = beatReviewPool(state, sceneIndex, beatIndex);
  const at = pool.reviewed.findIndex((c) => c.contentKey === candidate.contentKey);
  if (at >= 0) pool.reviewed[at] = candidate;
  else pool.reviewed.push(candidate);
}

/** What the beat used in the end, so the selection can be checked against its own evidence. */
export function noteVisionAdopted(
  state: VisionReviewPoolState | undefined,
  sceneIndex: number,
  beatIndex: number,
  contentKey: string
): void {
  if (!state) return;
  beatReviewPool(state, sceneIndex, beatIndex).adopted = contentKey;
}

export function evidenceCounts(pool: BeatReviewPool): Record<VisionEvidence, number> {
  const counts: Record<VisionEvidence, number> = {
    FIT: 0,
    UNREVIEWED: 0,
    UNCLEAR: 0,
    MISMATCH: 0,
  };
  for (const c of pool.reviewed) counts[c.evidence] = (counts[c.evidence] ?? 0) + 1;
  return counts;
}

/* ═══════════════════════ what the render says about its own choices ═══════════════════════ */

/** One line per beat that reviewed anything, plus a total. A beat with no pool prints nothing. */
export function formatVisionSelection(state: VisionReviewPoolState | undefined): string[] {
  if (!state || state.beats.size === 0) return [];
  const beats = [...state.beats.values()].sort(
    (a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex
  );
  const lines: string[] = [];
  const total = { declared: 0, reviewed: 0, FIT: 0, UNREVIEWED: 0, UNCLEAR: 0, MISMATCH: 0 };
  for (const pool of beats) {
    const counts = evidenceCounts(pool);
    total.declared += pool.declared.length;
    total.reviewed += pool.reviewed.length;
    for (const e of VISION_EVIDENCE_ORDER) total[e] += counts[e];
    const best = bestByVisionEvidence(pool.reviewed);
    lines.push(
      `[VisionSelection] s${pool.sceneIndex}b${pool.beatIndex} cap=${pool.cap} ` +
        `reviewPool=${pool.declared.length} reviewed=${pool.reviewed.length} ` +
        `FIT=${counts.FIT} UNREVIEWED=${counts.UNREVIEWED} UNCLEAR=${counts.UNCLEAR} ` +
        `MISMATCH=${counts.MISMATCH} finalShortlisted=${
          pool.reviewed.filter((c) => isSelectableEvidence(c.evidence)).length
        } best=${best ? `${best.evidence}@rank${best.cheapRank}` : "none"} ` +
        `adopted=${pool.adopted ?? "none"}`
    );
  }
  lines.push(
    `[VisionSelection] TOTAL beats=${beats.length} reviewPool=${total.declared} ` +
      `reviewed=${total.reviewed} FIT=${total.FIT} UNREVIEWED=${total.UNREVIEWED} ` +
      `UNCLEAR=${total.UNCLEAR} MISMATCH=${total.MISMATCH}`
  );
  return lines;
}

/**
 * The invariants this record exists to make checkable. Empty on a healthy render.
 *
 * Each one is a statement that could not be made before, because the editor's answers and the
 * beat's choice were never held side by side.
 */
export function visionSelectionViolations(state: VisionReviewPoolState | undefined): string[] {
  if (!state) return [];
  const out: string[] = [];
  for (const pool of state.beats.values()) {
    const at = `s${pool.sceneIndex}b${pool.beatIndex}`;
    /** §19/§33 — the pool may never promise more looks than the budget allows. */
    if (pool.cap > 0 && pool.declared.length > pool.cap) {
      out.push(
        `[VisionSelectionInvariant] ${at} REVIEW_POOL_OVER_BUDGET pool=${pool.declared.length} cap=${pool.cap}`
      );
    }
    if (pool.cap > 0 && pool.reviewed.length > pool.cap) {
      out.push(
        `[VisionSelectionInvariant] ${at} REVIEWED_OVER_BUDGET reviewed=${pool.reviewed.length} cap=${pool.cap}`
      );
    }
    if (!pool.adopted) continue;
    const chosen = pool.reviewed.find((c) => c.contentKey === pool.adopted);
    if (!chosen) continue;
    const best = bestByVisionEvidence(pool.reviewed);
    /**
     * §25 — a refused picture may still be used, but only when nothing else was available. The
     * reprieve is legitimate; a reprieve WHILE a candidate the editor did not refuse was on the
     * list is not, and this is the only place the two can be told apart.
     */
    if (chosen.evidence === "MISMATCH" && best) {
      out.push(
        `[VisionSelectionInvariant] ${at} MISMATCH_ADOPTED_OVER_AVAILABLE ` +
          `adopted=${pool.adopted} available=${best.evidence}@${best.contentKey}`
      );
    }
    /** §24 — a FIT was on the list and the beat used something weaker. */
    if (
      chosen.evidence !== "FIT" &&
      pool.reviewed.some((c) => c.evidence === "FIT")
    ) {
      out.push(
        `[VisionSelectionInvariant] ${at} FIT_NOT_PREFERRED adopted=${chosen.evidence} ` +
          `key=${pool.adopted} — a candidate the editor called a fit was passed over`
      );
    }
  }
  return out;
}
