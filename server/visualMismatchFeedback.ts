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
    /**
     * RONDE 159: `does not (show|depict)` required an article after it, so "does not depict what
     * the narration describes" fell through. The article is now optional — the phrase itself is
     * the finding, and what follows it varies.
     */
    re: /\b(different (?:person|man|woman|subject|figure|individual|topic|event|thing)|wrong (?:person|man|woman|subject|figure|topic|event)|someone else|somebody else|not the (?:same )?(?:person|man|woman|subject)|another (?:person|man|woman|subject)|does not (?:show|depict)|shows? nothing (?:to do with|related))\b/i,
  },
  {
    kind: "UNRELATED",
    /**
     * RONDE 159 — the formulation the gate actually uses, read off two production renders.
     *
     * Video 552 refused 13 candidates and could not classify 8 of them. The prose logged by
     * RONDE 155 shows why, and it is one missing verb form:
     *
     *     "The clip shows a wedding ceremony, which does not relate to the narrative…"
     *     "The images depict children greeting a woman, which does not relate…"
     *
     * The pattern had `not related` — the adjective. The gate writes `does not relate` — the verb.
     * Every one of those refusals is an UNRELATED, which is a QUESTION fault, which is what makes
     * the beat try a different search instead of falling through to a placeholder card. So a
     * missing verb form is why those beats got a coloured card.
     *
     * The additions below are the phrasings observed in those logs plus their immediate
     * variations, and nothing further: a guessed pattern that fires wrongly would reorder
     * candidates away from a source for a reason nobody gave.
     */
    re: /\b(unrelated|irrelevant|nothing to do with|no (?:apparent )?(?:connection|relation|relevance|bearing)|not related|off[- ]topic|does not belong|(?:does|do|did) not (?:relate|correspond|match|align|fit|pertain)|not relevant|bears? no relation|has nothing (?:to do )?with)\b/i,
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
 * RONDE 166 — how wrong the picture was, which is a different question from whose fault it is.
 *
 * `mismatchFault` answers "what should the pipeline do next" and has been right about that since
 * RONDE 131. It cannot answer the question this round is about, which is "may this picture be used
 * anyway when nothing else was found".
 *
 * That question was previously not asked at all. RONDE 67 made a product decision — a real picture
 * beats a grey card — and applied it to every refusal equally, so `reprieveBeatClip` would hand
 * back a title card, a football match and a 1970s newsreel with the same shrug. Video 554 shipped
 * six beats whose picture the gate had refused.
 *
 * The decision is kept, and narrowed to the refusals it was ever defensible for. A picture that is
 * about the right thing and imperfectly so is worth more than a colour card; a picture about
 * something else is not, and no amount of "better than nothing" makes it one.
 *
 * Read off the kind that already exists. No second classifier, no second call to a model, and no
 * new words in the gate's prompt — this is one more question asked of the same answer.
 */
export type MismatchSeverity =
  /** About the right thing, imperfectly. Usable as a last resort, never as a first choice. */
  | "SOFT_MISMATCH"
  /** About something else, or not a picture of anything. Never usable. */
  | "HARD_MISMATCH"
  /** No discernible relation to the beat at all. Never usable. */
  | "TOTALLY_UNRELATED"
  /** The gate refused and its words do not say what was wrong. Never treated as a mismatch. */
  | "UNKNOWN";

export function mismatchSeverity(kind: MismatchKind): MismatchSeverity {
  switch (kind) {
    /**
     * The four that are still ABOUT the beat.
     *
     * WRONG_PERIOD is a different decade of the same subject — a 1970s newsreel under 1945
     * narration is archival material about the right thing. WRONG_PLACE is the right sort of
     * thing somewhere else, WRONG_EVENT is the right people at the wrong occasion, and a
     * TALKING_HEAD discussing the subject is on-topic footage in an unwanted form. Each is a
     * visible imperfection and none of them puts a different topic on screen.
     */
    case "WRONG_PERIOD":
    case "WRONG_PLACE":
    case "WRONG_EVENT":
    case "TALKING_HEAD":
      return "SOFT_MISMATCH";
    /**
     * MODERN_FOOTAGE is deliberately NOT soft, though it shares a correction strategy with
     * WRONG_PERIOD. Present-day colour video under historical narration is the single fault a
     * viewer names without being asked — the brief's own example is a modern wedding under
     * "Hermann Göring joined Hitler in Munich" — and it is the one a documentary cannot absorb.
     *
     * WRONG_SUBJECT is a different person or a different thing: the beat's topic is not on screen.
     *
     * TEXT_ON_SCREEN and TITLE_CARD are both refused outright because this pipeline's standing
     * rule is that no text may be burned into the picture; taking one back as a "last resort"
     * would be overruling that rule rather than the gate.
     *
     * LOW_INFORMATION is a black frame or a blank wall. There is nothing in it to be relevant.
     */
    case "MODERN_FOOTAGE":
    case "WRONG_SUBJECT":
    case "TEXT_ON_SCREEN":
    case "TITLE_CARD":
    case "LOW_INFORMATION":
      return "HARD_MISMATCH";
    case "UNRELATED":
      return "TOTALLY_UNRELATED";
    case "UNCLEAR":
      return "UNKNOWN";
  }
}

/**
 * May a refusal of this kind be overruled when nothing else was found?
 *
 * The single predicate the reprieve is allowed to consult. UNKNOWN keeps the pre-existing
 * behaviour on purpose: the gate refused but said nothing usable about why, and inventing a
 * severity for it would be the guess this module exists to avoid — RONDE 160 already tried acting
 * on UNCLEAR and had to be reverted.
 */
export function reprieveAllowedFor(_kind: MismatchKind): boolean {
  /**
   * RONDE 200 — NO REFUSAL MAY BE OVERRULED. THE OWNER'S RULE, IN THEIR WORDS:
   *
   *     "Er mag nooit een beeld in de video die er niet bij past."
   *
   * ── What this replaces, and why that reasoning is spent ─────────────────────────────────────
   *
   * RONDE 67 decided that an imperfect picture beats a grey card, so a refusal could be taken back
   * when every alternative had failed too. RONDE 166 narrowed it: a refusal that puts a different
   * topic, a title card or a blank frame on screen may not be lifted at any price, but one that is
   * about the right thing and imperfectly so — a different decade, a different place, a different
   * occasion, a talking head — could still be.
   *
   * Each of those four is a picture the editor looked at and said does not belong under this line.
   * "About the right thing" is not "fits": a 1970s newsreel under 1945 narration is a documentary
   * telling the viewer something untrue with its pictures, which is the fault this whole product
   * is judged on. The narrowing was a compromise between two goods; the owner has now said which
   * one wins, twice and without qualification.
   *
   * ── What it costs, stated rather than discovered later ──────────────────────────────────────
   *
   * A refused picture is no longer available anywhere: `composeBarrierAllows` refuses every
   * `does_not_fit` nobody reprieved, and nothing can reprieve one now. Both call sites already
   * handle the decline the right way — the beat keeps every remaining route, the rescue ladder,
   * the curated archive and the research pass, exactly as a beat that found nothing would — so
   * this is "look further", not "take the card". A colour card is what happens when all of those
   * fail too, and RONDE 89's export gate refuses a film made mostly of those.
   *
   * So the direction of failure is: fewer wrong pictures, more beats that find nothing, and some
   * renders that stop at the export gate instead of shipping a picture that does not belong.
   *
   * ── What is deliberately kept ───────────────────────────────────────────────────────────────
   *
   * The severity vocabulary stays and is still printed. It is what tells a reader whether a
   * render's refusals were a sourcing problem or a catalogue problem, and that question did not
   * go away — only the permission to overrule the answer did. And this stays the single choke
   * point: one function decides, so there is no second way in.
   */
  return false;
}

/**
 * One line saying why a picture is on screen, or why it is not (RONDE 166 §7).
 *
 * `decision` is the outcome, `severity` is what it was decided on. Both are printed even when the
 * answer is the dull one, because "this beat's picture was approved" and "this beat's picture was
 * never judged" look identical in a log that only prints problems.
 */
export function formatVisualFitDecision(input: {
  beatLabel: string;
  candidate: string;
  verdict: string;
  severity: MismatchSeverity | "NONE";
  decision: "ADOPTED" | "REJECTED" | "REPRIEVED";
  reason: string;
  fallback?: boolean;
}): string {
  return (
    `[VisualFitDecision] beat=${input.beatLabel} candidate=${input.candidate} ` +
    `verdict=${input.verdict} severity=${input.severity} decision=${input.decision} ` +
    `reason=${input.reason}` +
    (input.fallback ? " fallback=true" : "")
  );
}

// ─── The render-wide tally ───────────────────────────────────────────────────────────────────

export type MismatchTally = {
  /** How many refusals of each kind. */
  byKind: Map<MismatchKind, number>;
  /** Which provider produced the refused picture, per kind — `${kind}|${source}`. */
  byKindAndSource: Map<string, number>;
  /** One example per kind, so a report can quote the gate rather than only count it. */
  examples: Map<MismatchKind, { source: string; depicts: string; reason: string }>;
  /**
   * RONDE 142 — refusals already counted, so one candidate cannot be recorded twice.
   *
   * The gate is consulted from several layers, and a clip refused deep in the adopt path can be
   * seen again by an outer route. Counting it twice would inflate exactly the numbers a render is
   * meant to be judged on. Keyed by the caller — see `dedupeKey` on recordMismatch.
   */
  countedKeys: Set<string>;
  total: number;
};

export function createMismatchTally(): MismatchTally {
  return {
    byKind: new Map(),
    byKindAndSource: new Map(),
    examples: new Map(),
    countedKeys: new Set(),
    total: 0,
  };
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
