/**
 * RONDE 131 — the picture editor already told us what was wrong. Nobody wrote it down.
 *
 * ── The measurement this round starts from ───────────────────────────────────────────────────
 *
 * Video 546 rendered with `raw=17/100`. The score is not a mystery: `computeMeritQualityScore`
 * builds it from the share of beats whose own picture the content decider approved, and that
 * render's decider answered
 *
 *     attempts=34 answered=34 failed=0 (fits=13 does_not_fit=21)
 *
 * Thirty-four questions, thirty-four real answers, and twenty-one of them said the picture does
 * not belong. The gate is healthy. The provider chain is healthy. What the render did not have
 * was BETTER FOOTAGE — and the only way to get better footage is to ask better questions and to
 * look in better places.
 *
 * ── What was being thrown away ───────────────────────────────────────────────────────────────
 *
 * `judgeBeatImage` does not return a bare no. Its schema requires three fields, and two of them
 * are prose written by a model that has just looked at the frame and read the narration:
 *
 *     depicts   "a modern city street with parked cars and road markings, filmed in colour"
 *     reason    "this is present-day footage under narration about Berlin in April 1945"
 *
 * That is a diagnosis. It says whether the SEARCH was wrong (we asked a question that returns
 * modern streets) or whether the ASSET was wrong (a title card, a leader, someone talking to
 * camera) — two failures with opposite fixes. At every one of the twenty-one rejections the
 * pipeline received that sentence, logged it, and moved to the next already-downloaded candidate
 * without using a word of it.
 *
 * ── What this module is, and what it deliberately is not ─────────────────────────────────────
 *
 * It is a reader. It takes the two strings the gate already produced and answers two questions:
 * what kind of mismatch was this, and does that make the QUESTION suspect or the MATERIAL
 * suspect. From that it produces a reordering hint over candidates that are already downloaded
 * and already ranked.
 *
 * It is NOT a new decider, and the distinction is load-bearing:
 *
 *   · It never rejects. `reorderAfterMismatch` is a stable partition — every candidate that went
 *     in comes out, in a different order. A gate that can only reorder cannot empty a montage.
 *   · It never calls a model. There is no second vision engine here; the words are the existing
 *     gate's own output, already paid for.
 *   · It never writes a query. It expresses a PREFERENCE over sources; the queries stay whatever
 *     searchQueryContract minted, which is the only place a query may come from.
 *   · It loosens nothing. No threshold, no ceiling and no gate is defined or read here.
 *
 * And the tally at the bottom is the round's other deliverable. "21 does_not_fit" is a number
 * nobody can act on. "21 does_not_fit: 12 WRONG_PERIOD, 5 TEXT_ON_SCREEN, 4 WRONG_SUBJECT" says
 * where the next round's work is, and it is the first time this pipeline can produce that
 * sentence at all.
 */

/** What kind of wrong the picture was. Named for the fix it implies, not for the words that matched. */
export type MismatchKind =
  /** Modern footage under historical narration, or any plain period error. */
  | "WRONG_PERIOD"
  /** A different person or a different thing than the beat is about. */
  | "WRONG_SUBJECT"
  /** The right sort of thing, somewhere else entirely. */
  | "WRONG_PLACE"
  /** A title card, a logo, a watermark, a screenshot, a countdown leader — text, not footage. */
  | "TEXT_ON_SCREEN"
  /** Someone addressing the camera: an interview, a presenter, a commentary upload. */
  | "TALKING_HEAD"
  /** Plainly unrelated, with nothing more specific said about it. */
  | "UNRELATED"
  /** The gate refused but its words do not say what was wrong. Never acted on. */
  | "UNCLEAR";

/**
 * What the mismatch implies about where the fault lies.
 *
 * `QUESTION` — the search returned the wrong sort of thing, so asking a narrower question is the
 * lever. `MATERIAL` — the question was answered with something real and on-topic that simply is
 * not usable footage, so the next candidate for the SAME question is the lever. Conflating the
 * two is how a render narrows a query that was already right.
 */
export type MismatchFault = "QUESTION" | "MATERIAL" | "UNKNOWN";

/**
 * The phrases each kind is recognised by.
 *
 * Every one of these is wording the gate's own prompt invites: `buildPrompt` asks the model to
 * name "the period it looks like", "any text or graphics visible in it", and lists "a logo, a
 * title card, a screenshot of a webpage or a person talking to camera" among the things that do
 * not belong. So this is not a general-purpose English classifier — it is a reader of one
 * prompt's answers, and it is written against that prompt.
 *
 * Ordered most specific first: "a modern presenter talking to camera" is a TALKING_HEAD whatever
 * else is true of it, because the fix for it is a different candidate rather than a different
 * question.
 */
const MISMATCH_PATTERNS: ReadonlyArray<{ kind: MismatchKind; re: RegExp }> = [
  {
    kind: "TEXT_ON_SCREEN",
    re: /\b(title card|titlecard|text card|end card|credits?|caption card|countdown|leader|slate|watermark|logo|screenshot|screen ?grab|web ?page|website|thumbnail|intro sequence|lower third|subtitle|on-?screen text|text overlay|graphic overlay|placeholder)\b/i,
  },
  {
    kind: "TALKING_HEAD",
    re: /\b(talking (?:to|at) (?:the )?camera|talking head|piece to camera|presenter|newsreader|anchor|vlog|vlogger|youtuber|interview(?:ee|er)?|commentar(?:y|ist)|narrator on screen|person speaking (?:to|into))\b/i,
  },
  {
    kind: "WRONG_PERIOD",
    re: /\b(modern|contemporary|present[- ]day|recent|nowadays|today'?s|21st century|20th century|different (?:century|era|period|decade|time)|wrong (?:century|era|period|decade|time)|anachronis(?:m|tic)|too (?:new|recent|modern)|much later|decades? later)\b/i,
  },
  {
    kind: "WRONG_PLACE",
    // Case-insensitive like every other pattern here: the model capitalises the start of `reason`
    // as often as not, and a place error stated as "Different country entirely" is the same
    // finding as one stated mid-sentence.
    re: /\b(different (?:country|city|place|location|region|continent)|wrong (?:country|city|place|location|region|continent)|another country|somewhere else entirely)\b/i,
  },
  {
    kind: "WRONG_SUBJECT",
    re: /\b(different (?:person|man|woman|subject|figure|individual|topic|event|thing)|wrong (?:person|man|woman|subject|figure|topic|event)|someone else|somebody else|not the (?:same )?(?:person|man|woman|subject)|another (?:person|man|woman|subject)|does not (?:show|depict) (?:the|any)|shows? nothing (?:to do with|related))\b/i,
  },
  {
    kind: "UNRELATED",
    re: /\b(unrelated|irrelevant|nothing to do with|no (?:apparent )?(?:connection|relation|relevance|bearing)|not related|off[- ]topic|does not belong)\b/i,
  },
];

/**
 * Read one refusal.
 *
 * Both strings are searched together because the model splits its answer between them however it
 * likes: sometimes the period error is stated in `reason` ("this is present-day footage"), and
 * sometimes only `depicts` carries it ("a modern city street") while `reason` says nothing more
 * than "it does not belong".
 *
 * Returns UNCLEAR rather than a best guess when nothing matches. A wrong classification would
 * reorder candidates away from a source for a reason that was never given, and there is no
 * version of that which is better than doing nothing.
 */
export function classifyMismatch(params: { depicts?: string; reason?: string }): MismatchKind {
  const text = `${params.depicts ?? ""} ${params.reason ?? ""}`.trim();
  if (!text) return "UNCLEAR";
  for (const { kind, re } of MISMATCH_PATTERNS) {
    if (re.test(text)) return kind;
  }
  return "UNCLEAR";
}

/** Whether this kind indicts the search or the material. */
export function mismatchFault(kind: MismatchKind): MismatchFault {
  switch (kind) {
    case "WRONG_PERIOD":
    case "WRONG_SUBJECT":
    case "WRONG_PLACE":
    case "UNRELATED":
      return "QUESTION";
    case "TEXT_ON_SCREEN":
    case "TALKING_HEAD":
      return "MATERIAL";
    case "UNCLEAR":
      return "UNKNOWN";
  }
}

/**
 * Was this rejection about something the render could have avoided?
 *
 * The audit question RONDE 131 opens with is "wordt hij terecht afgewezen" — is the candidate
 * rightly refused. Every kind here is a rightful refusal: a title card IS text, present-day
 * footage under 1945 narration IS wrong. What differs is whether a better SEARCH would have
 * prevented it, and that is what this answers. A render whose rejections are mostly QUESTION
 * faults has a sourcing problem; one whose rejections are mostly MATERIAL faults has a catalogue
 * problem, and they lead to entirely different work.
 */
export function mismatchWasPreventableBySearch(kind: MismatchKind): boolean {
  return mismatchFault(kind) === "QUESTION";
}

/**
 * Source families, by what their catalogues actually contain.
 *
 * These are not quality rankings and nothing here says one provider is better than another. They
 * are statements about stock: Pexels and Pixabay are libraries of present-day commissioned
 * footage, so on a WRONG_PERIOD refusal the next candidate from one of them is likely to repeat
 * the same mistake. The Bundesarchiv holdings on Wikimedia, the Library of Congress, NARA and
 * the Internet Archive are historical collections, so they are where the alternative lives.
 *
 * The vocabulary is the one `summarizeAdoptAudit` already classifies, so a source string that
 * reaches this module needs no translation and no second naming scheme.
 */
const MODERN_STOCK_SOURCES: ReadonlySet<string> = new Set([
  "pexels", "pixabay", "stock", "rescue_stock",
]);

const HISTORICAL_ARCHIVE_SOURCES: ReadonlySet<string> = new Set([
  "wikimedia", "wikimedia_video", "rescue_wikimedia",
  "internet_archive", "loc", "nara", "nasa", "europeana", "openverse",
  "archive", "archive_fetch", "rescue_archive", "sepiasearch", "mediaccc",
]);

/**
 * Sources that carry a lot of user-uploaded material with leaders, intros and pieces to camera.
 *
 * YouTube is here for one reason and it is measured, not assumed: video 546 retrieved 25 YouTube
 * candidates and 13 of the 14 adopted clips came back UNVERIFIED, and an upload is a whole
 * programme — title sequence, presenter, credits — where an archive item is a reel. The Internet
 * Archive holds full broadcast recordings for the same reason and is included on the same
 * grounds.
 */
const UPLOAD_SHAPED_SOURCES: ReadonlySet<string> = new Set([
  "youtube", "youtube_cc", "internet_archive",
]);

export type SourcePreference = {
  /** Sort these to the front of what remains. */
  prefer: ReadonlySet<string>;
  /** Sort these to the back. Never removed — a deprioritised candidate is still a candidate. */
  avoid: ReadonlySet<string>;
};

const NO_PREFERENCE: SourcePreference = { prefer: new Set(), avoid: new Set() };

/**
 * Which sources to look at first after a refusal of this kind.
 *
 * WRONG_PLACE and WRONG_SUBJECT get no preference on purpose. Both are real faults and both are
 * QUESTION faults, but neither one is a property of a CATALOGUE: every provider holds pictures of
 * the wrong person and the wrong country, so reordering by source would be superstition. Those
 * two are recorded, reported, and left to the ranking that already exists.
 */
export function sourcePreferenceForMismatch(kind: MismatchKind): SourcePreference {
  switch (kind) {
    case "WRONG_PERIOD":
      return { prefer: HISTORICAL_ARCHIVE_SOURCES, avoid: MODERN_STOCK_SOURCES };
    case "TEXT_ON_SCREEN":
    case "TALKING_HEAD":
      return { prefer: new Set(), avoid: UPLOAD_SHAPED_SOURCES };
    default:
      return NO_PREFERENCE;
  }
}

/** Anything with a `source` can be reordered — the funnel's candidates, a pool, a shortlist. */
export type SourcedCandidate = { source: string };

/** The default reading of "which provider is this from". */
function defaultSourceOf(candidate: unknown): string {
  return (candidate as { source?: string })?.source ?? "";
}

/**
 * Reorder what is left after a refusal.
 *
 * A STABLE three-way partition: preferred first, neutral next, avoided last, and within each
 * group the incoming order — which is the ranking every earlier round built — is preserved
 * exactly. Nothing is added, nothing is dropped, and the returned array always has the same
 * length as the one that went in.
 *
 * That last property is the whole safety argument. The pipeline's next act is to take the head of
 * this list and judge it; if this function could remove candidates it would be a gate, it would
 * be able to starve a beat, and it would need every protection a gate needs. It cannot, so it
 * does not.
 *
 * ── Why reordering is enough to change an outcome, and why it cannot overrule a score ─────────
 *
 * `pickBestFunnelCandidate` picks by CLIP score only when the field's scores actually separate;
 * RONDE 65 established that they usually do not — `worstScore10` is `round(similarity * 40)`, an
 * integer, and a whole beat's candidates routinely land within one point of each other. When that
 * happens the picker takes `list[0]`, so the incoming ORDER decides the beat. This reordering
 * therefore lands exactly where it should: it breaks the ties that CLIP cannot break, and it is
 * powerless in the cases where CLIP has something real to say.
 *
 * @param sourceOf how to read the provider off a candidate. Defaults to a `source` field, which is
 *   what the funnel's own candidates carry; passed explicitly by callers whose candidates wrap it.
 */
export function reorderAfterMismatch<T>(
  candidates: readonly T[],
  kind: MismatchKind,
  sourceOf: (candidate: T) => string = defaultSourceOf
): T[] {
  const { prefer, avoid } = sourcePreferenceForMismatch(kind);
  if (prefer.size === 0 && avoid.size === 0) return [...candidates];

  const preferred: T[] = [];
  const neutral: T[] = [];
  const avoided: T[] = [];
  for (const c of candidates) {
    const source = (sourceOf(c) ?? "").trim().toLowerCase();
    // `prefer` is checked first so a source in both sets (internet_archive is a historical
    // archive AND upload-shaped) lands on the side the current mismatch actually argues for.
    if (prefer.has(source)) preferred.push(c);
    else if (avoid.has(source)) avoided.push(c);
    else neutral.push(c);
  }
  return [...preferred, ...neutral, ...avoided];
}

/**
 * Did the reordering actually change anything?
 *
 * Logged rather than assumed: a beat whose candidates all come from one provider gets an
 * identical list back, and a line claiming a reorder happened there would be false.
 */
export function reorderChangedOrder<T>(before: readonly T[], after: readonly T[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return true;
  return false;
}

// ─── The render-wide tally ───────────────────────────────────────────────────────────────────

export type MismatchTally = {
  /** How many refusals of each kind. */
  byKind: Map<MismatchKind, number>;
  /** Which provider produced the refused picture, per kind — `${kind}|${source}`. */
  byKindAndSource: Map<string, number>;
  /** One example per kind, so a report can quote the gate rather than only count it. */
  examples: Map<MismatchKind, { source: string; depicts: string; reason: string }>;
  total: number;
};

export function createMismatchTally(): MismatchTally {
  return { byKind: new Map(), byKindAndSource: new Map(), examples: new Map(), total: 0 };
}

export function recordMismatch(
  tally: MismatchTally,
  params: { kind: MismatchKind; source: string; depicts?: string; reason?: string }
): void {
  const source = (params.source ?? "").trim().toLowerCase() || "unknown";
  tally.total++;
  tally.byKind.set(params.kind, (tally.byKind.get(params.kind) ?? 0) + 1);
  const key = `${params.kind}|${source}`;
  tally.byKindAndSource.set(key, (tally.byKindAndSource.get(key) ?? 0) + 1);
  if (!tally.examples.has(params.kind)) {
    tally.examples.set(params.kind, {
      source,
      depicts: (params.depicts ?? "").slice(0, 120),
      reason: (params.reason ?? "").slice(0, 120),
    });
  }
}

export type MismatchBreakdown = {
  kind: MismatchKind;
  count: number;
  fault: MismatchFault;
};

/** Every kind that occurred, most frequent first. */
export function summarizeMismatchKinds(tally: MismatchTally): MismatchBreakdown[] {
  return [...tally.byKind.entries()]
    .map(([kind, count]) => ({ kind, count, fault: mismatchFault(kind) }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * How the render's refusals split between a sourcing problem and a catalogue problem.
 *
 * This is the number RONDE 131 exists to produce. A render reporting 21 refusals of which 15 are
 * QUESTION faults is telling its operator that better queries would have fixed most of them; one
 * reporting 15 MATERIAL faults is telling them the queries were fine and the archives are full of
 * title cards. Those are different projects.
 */
export function mismatchFaultSplit(tally: MismatchTally): {
  question: number;
  material: number;
  unknown: number;
} {
  let question = 0;
  let material = 0;
  let unknown = 0;
  for (const [kind, count] of tally.byKind) {
    const fault = mismatchFault(kind);
    if (fault === "QUESTION") question += count;
    else if (fault === "MATERIAL") material += count;
    else unknown += count;
  }
  return { question, material, unknown };
}

/** The per-refusal line, printed where the refusal happens. */
export function formatMismatchFeedback(params: {
  sceneIndex: number;
  beatIndex: number;
  source: string;
  kind: MismatchKind;
  reordered: boolean;
  remaining: number;
}): string {
  return (
    `[MismatchFeedback] s${params.sceneIndex}b${params.beatIndex} ` +
    `source=${params.source || "unknown"} kind=${params.kind} ` +
    `fault=${mismatchFault(params.kind)} remaining=${params.remaining} ` +
    `reordered=${params.reordered ? "yes" : "no"}`
  );
}

/** The render-end block. Empty string when nothing was refused — silence is the good outcome. */
export function formatMismatchSummary(tally: MismatchTally): string {
  if (tally.total === 0) return "";
  const split = mismatchFaultSplit(tally);
  const lines = [
    `[MismatchFeedback] ${tally.total} refusal(s) — ` +
      `search-preventable=${split.question} material=${split.material} unclassified=${split.unknown}`,
  ];
  for (const row of summarizeMismatchKinds(tally)) {
    const ex = tally.examples.get(row.kind);
    const quote = ex?.reason ? ` e.g. "${ex.reason}"` : "";
    lines.push(`  ${row.kind.padEnd(15)} ${String(row.count).padStart(3)}  (${row.fault})${quote}`);
  }
  return lines.join("\n");
}
