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
  /** A plain period error: a different century, a different decade. */
  | "WRONG_PERIOD"
  /**
   * RONDE 135 — present-day footage specifically, split out from WRONG_PERIOD.
   *
   * Both are period errors and both argue for the same correction, so they share a strategy. What
   * they do NOT share is what they say about the SOURCE: "this is a 1970s newsreel under 1945
   * narration" is an archive that reached for the wrong decade, while "this is present-day colour
   * video" is a modern catalogue answering a historical question. The second is a property of
   * where we looked, and RONDE 135 uses it to rank sources — which needs it counted separately.
   */
  | "MODERN_FOOTAGE"
  /** A different person or a different thing than the beat is about. */
  | "WRONG_SUBJECT"
  /** The right sort of thing, somewhere else entirely. */
  | "WRONG_PLACE"
  /**
   * RONDE 135 — the right people in the right place, at the wrong occasion.
   *
   * "This is the Nuremberg rally, not the Reichstag fire." Neither the subject nor the place nor
   * the period is wrong; the EVENT is. Previously this fell to WRONG_SUBJECT, which corrects by
   * adding the person — and the person was already right.
   */
  | "WRONG_EVENT"
  /** Text over footage: a watermark, a lower third, burnt-in subtitles. */
  | "TEXT_ON_SCREEN"
  /**
   * RONDE 135 — the frame IS the text: a title card, a leader, a countdown, an end card.
   *
   * Split from TEXT_ON_SCREEN because the two are different material problems. Text over footage
   * means there is footage under it; a title card means there is none. Both are MATERIAL faults
   * and both look for other material, so the response is shared — but a render whose refusals are
   * mostly title cards is being handed whole programmes rather than clips, which is a different
   * finding from one whose refusals are watermarked footage.
   */
  | "TITLE_CARD"
  /** Someone addressing the camera: an interview, a presenter, a commentary upload. */
  | "TALKING_HEAD"
  /**
   * RONDE 135 — nothing wrong with it, and nothing in it.
   *
   * A black frame, a blank wall, an out-of-focus smear. The gate is right to refuse it and the
   * question was never the problem, so it is a MATERIAL fault like the others.
   */
  | "LOW_INFORMATION"
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
    /**
     * The frame IS the text. Checked before TEXT_ON_SCREEN so "a title card with white lettering"
     * is a title card rather than footage that happens to carry text.
     */
    kind: "TITLE_CARD",
    re: /\b(title card|titlecard|text card|end card|title screen|intro (?:card|screen|sequence)|credits? (?:roll|screen|sequence)?|caption card|countdown|leader|slate|blank screen with text|screenshot|screen ?grab|web ?page|website|thumbnail)\b/i,
  },
  {
    /** Text OVER footage — there is a picture underneath, it is just spoiled. */
    kind: "TEXT_ON_SCREEN",
    re: /\b(watermark|logo|lower third|subtitles?|on-?screen text|text overlay|graphic overlay|burnt[- ]in text|station ident|channel bug|placeholder)\b/i,
  },
  {
    kind: "TALKING_HEAD",
    re: /\b(talking (?:to|at) (?:the )?camera|talking head|piece to camera|presenter|newsreader|anchor|vlog|vlogger|youtuber|interview(?:ee|er)?|commentar(?:y|ist)|narrator on screen|person speaking (?:to|into))\b/i,
  },
  {
    /** Nothing wrong with it, and nothing in it. */
    kind: "LOW_INFORMATION",
    re: /\b(black (?:frame|screen)|blank (?:frame|screen|wall)|empty frame|out of focus|blurr?(?:ed|y)|too dark to|nothing (?:is )?(?:visible|discernible)|featureless|shows (?:almost )?nothing)\b/i,
  },
  {
    /**
     * Present-day footage specifically. Checked before the general period rule so a render can
     * tell "a modern catalogue answered a historical question" from "an archive reached for the
     * wrong decade" — see MODERN_FOOTAGE's note above.
     */
    kind: "MODERN_FOOTAGE",
    re: /\b(modern|contemporary|present[- ]day|nowadays|today'?s|21st century|20\d\d footage|recent(?:ly)? (?:filmed|shot|recorded)|high definition colour video|hd colour video)\b/i,
  },
  {
    kind: "WRONG_PERIOD",
    re: /\b(different (?:century|era|period|decade|time)|wrong (?:century|era|period|decade|time)|anachronis(?:m|tic)|too (?:new|recent|modern|old|early|late)|much later|decades? (?:later|earlier)|years? (?:later|earlier)|\d{4}s? rather than|not (?:the )?(?:right )?period)\b/i,
  },
  {
    /**
     * The right people, the right place, the wrong occasion. Checked before WRONG_SUBJECT, which
     * would otherwise "correct" it by adding a person who is already in the frame.
     */
    kind: "WRONG_EVENT",
    re: /\b(different (?:event|occasion|ceremony|battle|rally|meeting|speech|conference|campaign)|wrong (?:event|occasion|ceremony|battle|rally|meeting|speech|conference|campaign)|another (?:event|occasion|ceremony|rally|battle)|not (?:the )?(?:same )?(?:event|occasion|battle|rally|ceremony))\b/i,
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
    case "MODERN_FOOTAGE":
    case "WRONG_SUBJECT":
    case "WRONG_PLACE":
    case "WRONG_EVENT":
    case "UNRELATED":
      return "QUESTION";
    /**
     * All four are answers to a question that was asked correctly. RONDE 135 §14: the response is
     * to look for other MATERIAL first — which is what the pipeline already does, because the
     * research pass only runs once the beat's candidates are exhausted.
     */
    case "TEXT_ON_SCREEN":
    case "TITLE_CARD":
    case "TALKING_HEAD":
    case "LOW_INFORMATION":
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
    case "MODERN_FOOTAGE":
      return { prefer: HISTORICAL_ARCHIVE_SOURCES, avoid: MODERN_STOCK_SOURCES };
    case "TEXT_ON_SCREEN":
    case "TITLE_CARD":
    case "TALKING_HEAD":
      return { prefer: new Set(), avoid: UPLOAD_SHAPED_SOURCES };
    /**
     * LOW_INFORMATION gets no source preference. A black frame or an out-of-focus shot is not a
     * property of a catalogue — every provider holds some — so reordering by source would be
     * superstition, exactly as it would be for WRONG_PLACE and WRONG_SUBJECT.
     */
    default:
      return NO_PREFERENCE;
  }
}

// ─── RONDE 135 §15 — what this render has learned about its own sources ──────────────────────

/**
 * Sources that keep failing the same way, this render.
 *
 * RONDE 131's source preference is a static table: it says where present-day footage tends to
 * live, and that is a fact about catalogues rather than about today. This adds the render's own
 * evidence on top. If Pexels has been refused four times for MODERN_FOOTAGE on this documentary,
 * the fifth Pexels candidate is not a good bet, whatever the table says.
 *
 * Three deliberate limits:
 *
 *  · It is a RANKING signal, never a veto. The caller reorders; nothing is removed, and a beat
 *    whose only candidates come from a penalised source still gets them.
 *  · It is render-scoped, read from the tally that already exists. No second cache, no blacklist,
 *    and nothing survives to poison the next render.
 *  · It needs real evidence. One refusal is noise; the threshold is where a pattern starts.
 */
export const REPEAT_OFFENDER_MIN_REFUSALS = 3;

/**
 * Sources this render has seen fail repeatedly for faults of the same family.
 *
 * Only QUESTION-family period faults count. A source that returns title cards is not a source
 * that returns the wrong century, and lumping them together would penalise an archive for the
 * shape of its uploads rather than for the content of its holdings.
 */
export function repeatOffenderSources(
  tally: MismatchTally,
  minRefusals: number = REPEAT_OFFENDER_MIN_REFUSALS
): Set<string> {
  const perSource = new Map<string, number>();
  for (const [key, count] of tally.byKindAndSource) {
    const [kind, source] = key.split("|");
    if (!kind || !source) continue;
    if (kind !== "MODERN_FOOTAGE" && kind !== "WRONG_PERIOD") continue;
    perSource.set(source, (perSource.get(source) ?? 0) + count);
  }
  const out = new Set<string>();
  for (const [source, count] of perSource) {
    if (count >= minRefusals) out.add(source);
  }
  return out;
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
  sourceOf: (candidate: T) => string = defaultSourceOf,
  /**
   * RONDE 135 §15 — sources this render has already seen fail this way, from
   * `repeatOffenderSources`. Merged into `avoid`, so a source the render has learned to distrust
   * sorts last even when the static table has nothing to say about it. Optional: a caller with no
   * tally behaves exactly as RONDE 131 did.
   */
  learnedOffenders?: ReadonlySet<string>
): T[] {
  const preference = sourcePreferenceForMismatch(kind);
  const prefer = preference.prefer;
  const avoid =
    learnedOffenders && learnedOffenders.size > 0
      ? new Set([...preference.avoid, ...learnedOffenders])
      : preference.avoid;
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
