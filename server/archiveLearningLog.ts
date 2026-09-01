/**
 * RONDE 125 — the one question the logs could not answer.
 *
 * The audit brief asks whether FastVid actually learns from earlier videos and reuses that
 * knowledge. The machinery for it turns out to exist and to run — measured in the worker log of
 * video 544, not assumed:
 *
 *     [EditorialScore] Feedback toegepast: 16 assets ↑, 0 assets ↓
 *     [Embedding] Indexed pexels:… (2 frames)                     ×12
 *     [Funnel] s?b?: archiveScore=0.339 consec=0 strategy=all_external
 *     [FunnelBeatCalib] s?b? strategy=aggressive archiveScore=0.1954 kw=706 asset=57321
 *
 * The archive IS consulted before any external source, it IS scored against the beat, and
 * successful adoptions DO raise editorialScore. What no line anywhere says is the thing the brief
 * actually asks for: for this beat, did we reuse what we already had, or did we go out and search
 * again — and why.
 *
 * ── What the measurement showed ──────────────────────────────────────────────────────────────
 *
 * Every archiveScore in that render fell below the threshold at which external search is skipped:
 *
 *     0.195   0.219   0.339   0.389        (thresholds: 0.50 stop · 0.42 one · 0.30 all)
 *
 * so not one beat reached `archive_only`, and every beat searched externally. That is the whole
 * answer to "why does it not get faster": not a missing store, not a missing read — the archive's
 * relevance score never clears the bar.
 *
 * These lines exist so the NEXT render can be read directly instead of reconstructed. They add no
 * query, no fetch and no embedding call: every value printed is already in hand at the point it is
 * printed, exactly like [FunnelBeatCalib] before them.
 */

/** Where a beat's picture came from, from the learning loop's point of view. */
export type RetrievalOutcome = "reuse" | "external";

export type ArchiveRetrievalFacts = {
  sceneIndex: number;
  beatIndex: number;
  /** The subject actually searched for — the entity key the memory is keyed on. */
  query: string;
  /** Archive assets that were scored for this beat. */
  candidates: number;
  /** Best archive relevance score, or null when nothing scored. */
  bestScore: number | null;
  /** The threshold above which no external source would be queried. */
  stopThreshold: number;
  /** Candidates already proven successful in an earlier render (editorialScore above default). */
  knownSuccessful: number;
  /** Which way the beat went. */
  outcome: RetrievalOutcome;
  /** The funnel's own strategy name, carried through so the two lines can be joined. */
  strategy: string;
};

/**
 * One line per beat, answering "reuse or search again".
 *
 * `externalSearchNeeded` is the field the brief asks for, and it is derived from the same score
 * and threshold the funnel itself used — not recomputed, so the line cannot disagree with the
 * decision it describes.
 */
export function formatArchiveRetrieval(facts: ArchiveRetrievalFacts): string {
  const score = facts.bestScore === null ? "n/a" : facts.bestScore.toFixed(3);
  return (
    `[ArchiveRetrieval] s${facts.sceneIndex}b${facts.beatIndex} query="${facts.query.slice(0, 60)}" ` +
    `candidates=${facts.candidates} bestScore=${score} (stop≥${facts.stopThreshold.toFixed(2)}) ` +
    `knownSuccessful=${facts.knownSuccessful} strategy=${facts.strategy} ` +
    `reused=${facts.outcome === "reuse" ? "yes" : "no"} ` +
    `externalSearchNeeded=${facts.outcome === "external" ? "true" : "false"}`
  );
}

/**
 * The line printed when the archive had nothing worth using.
 *
 * Separate from the one above on purpose: "we looked and found nothing strong" is the case that
 * justifies an external search, and it should read as a sentence rather than as a field with a
 * low number in it.
 */
export function formatNoStrongMatch(facts: {
  sceneIndex: number;
  beatIndex: number;
  query: string;
  bestScore: number | null;
  stopThreshold: number;
}): string {
  const score = facts.bestScore === null ? "no scored candidates" : `best ${facts.bestScore.toFixed(3)}`;
  return (
    `[ArchiveRetrieval] s${facts.sceneIndex}b${facts.beatIndex} no strong existing match ` +
    `(${score}, need ≥${facts.stopThreshold.toFixed(2)}) — searching externally`
  );
}

/** Printed when an asset is added to the semantic index — the write half of the loop. */
export function formatArchiveLearningIndexed(assetId: number, document: string, model: string): string {
  return (
    `[ArchiveLearning] asset=${assetId} indexed model=${model} ` +
    `document="${document.slice(0, 80).replace(/\s+/g, " ").trim()}"`
  );
}

/**
 * Printed once per render: did this render add anything the next one can use?
 *
 * The brief's real criterion is not "was it stored" but "will the next video find it", and a
 * render that indexed nothing new cannot make the next one faster however much it stored before.
 */
export function formatArchiveLearningSummary(facts: {
  newAssetsIndexed: number;
  assetsReused: number;
  beatsFromArchive: number;
  beatsFromExternal: number;
}): string {
  const total = facts.beatsFromArchive + facts.beatsFromExternal;
  const pct = total > 0 ? Math.round((facts.beatsFromArchive / total) * 100) : 0;
  return (
    `[ArchiveLearning] render summary — reused ${facts.assetsReused} known asset(s), ` +
    `indexed ${facts.newAssetsIndexed} new one(s) | ` +
    `beats from archive ${facts.beatsFromArchive}/${total} (${pct}%), external ${facts.beatsFromExternal}`
  );
}
