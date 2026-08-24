/**
 * RONDE 54 — does this candidate's own metadata say it belongs to this video?
 *
 * Render 531 shipped "white-lives-matter-montana-sticker", "faces-of-ancient-europe-1-500-a.d"
 * and "bulgarian-national-union-customs" inside a documentary about Hitler's death in the
 * Führerbunker. None of them was filtered, because nothing filtered them: the scene pool logs
 * "45 raw → 45 deduped → 45 capped" — no relevance step at all — and mergeCandidates gives every
 * external candidate the identical flat score
 *
 *     internetWeight * (0.7 + tierBonus + movingBonus)
 *
 * with no reference to what the candidate is actually about. Its title, description and tags are
 * copied onto the FunnelCandidate and never read again.
 *
 * The tie-break after that is the CLIP vision score, and render 531 proves it cannot do this job.
 * Measured beat similarities:
 *
 *     white-lives-matter-montana-sticker    0.2226   ← wrong
 *     faces-of-ancient-europe-1-500-a.d     0.2225   ← wrong
 *     Signed Photograph of Adolf Hitler     0.2116   ← right, scores LOWER
 *     Bundesarchiv Bild 183-1989-0322       0.2077   ← right, scores LOWEST
 *
 * The correct images score below the wrong ones. Raising the CLIP threshold would delete the
 * Hitler photograph and keep the sticker. So the decision has to be made on the one signal that
 * is genuinely informative and currently unused: the words the provider itself attached.
 *
 * ── Why this is a three-way verdict, not a filter ────────────────────────────────────────────
 *
 * "Bundesarchiv Bild 183-1989-0322-506" is a real WWII photograph whose title is a catalogue
 * number. It shares no word with "Hitler" or "bunker", exactly like the sticker does not. A rule
 * that demands topical evidence would throw both away.
 *
 * So a candidate is only rejected when its metadata argues AGAINST it. RONDE 57 narrowed what
 * counts as arguing against it down to one thing: an era this video cannot be about.
 *
 * The rule that went with it — "enough descriptive words, none of them topical, therefore wrong"
 * — was measured against realistic B-roll before it ever reached a render, and it had the answer
 * backwards. "Ruins of a bombed city", "Soldiers marching" and "Typewriter close up" were all
 * rejected for a documentary about Berlin in 1945, while "Dark concrete room with dim light" was
 * accepted because the video is titled "The Dark End of the Third Reich".
 *
 * "Ruins of a bombed city" and "white-lives-matter-montana-sticker" both describe themselves at
 * length and both share no word with the topic. Keyword overlap cannot separate them; that needs
 * meaning. Rather than guess, the sticker now survives as unjudged and simply ranks below
 * everything that did name the subject — which is the safer half of the trade, because a wrong
 * clip ranked last is recoverable and a right clip deleted is not.
 */

import { foldSearchText } from "./searchTextNormalize";

export type TopicalVerdict = "topical" | "neutral" | "off_topic";

export type TopicalAssessment = {
  verdict: TopicalVerdict;
  /** Topic tokens the candidate's metadata matched. */
  matched: string[];
  /** Meaningful words the candidate says about itself, topical or not. */
  descriptiveTokens: number;
  /** Set when the metadata names a period this video cannot be about. */
  eraConflict: boolean;
  /** Short, log-safe explanation. */
  reason: string;
};

export type TopicMatcher = {
  tokens: Set<string>;
  /** Years the video is about, when its own text names any. */
  years: number[];
};

/** Words that carry no topical information — matching on them would make everything "topical". */
const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "his", "her", "its", "was", "were", "are",
  "you", "your", "our", "their", "who", "why", "how", "what", "when", "where", "into", "over",
  "under", "after", "before", "during", "while", "about", "video", "clip", "footage", "film",
  "movie", "scene", "part", "full", "hd", "new", "old", "best", "top", "official", "original",
  "documentary", "archive", "archival", "history", "historical", "stock", "free", "download",
  "com", "www", "http", "https", "mp4", "jpg", "png", "webm", "mov",
  // Where a thing is kept, and what kind of object it is, says nothing about what it DEPICTS.
  // "Bundesarchiv Bild 121-0723, Marburg" is a real WWII photograph whose entire title is the
  // name of an archive plus a shelf number; counting those as descriptive words made it look
  // like a candidate that had described itself and turned out to be about something else.
  "bundesarchiv", "archives", "archivo", "national", "federal", "state", "library", "museum",
  "collection", "collections", "fonds", "bild", "bilder", "foto", "fotos", "photo", "photos",
  "photograph", "photographs", "image", "images", "picture", "pictures", "videos", "films",
  "reel", "reels", "record", "records", "item", "items", "digital", "public", "domain",
]);

/**
 * Words common enough that matching one proves nothing about the subject.
 *
 * They are perfectly good words for a title to contain — that is the problem. A candidate
 * sharing only one of these with the video has not identified itself as being about the same
 * thing; it has used ordinary English. A candidate matching one of these AND something specific
 * still counts, because the specific token carries the match.
 */
const GENERIC_TOPIC_WORDS = new Set([
  "dark", "death", "dead", "died", "dying", "end", "final", "last", "chose", "choice", "decision",
  "story", "life", "lives", "living", "day", "days", "night", "time", "times", "hour", "hours",
  "great", "world", "man", "men", "woman", "women", "people", "real", "truth", "secret", "hidden",
  "mystery", "why", "how", "what", "inside", "beneath", "behind", "final", "moment", "moments",
]);

/** Era words that pin a candidate to a period no modern-era documentary can be describing. */
const ANCIENT_ERA_RE = /\b(a\.?\s?d\.?|b\.?\s?c\.?|bce|ce|ancient|antiquity|medieval|prehistoric|neolithic|bronze age|iron age|roman empire|middle ages)\b/;

/** A four-digit year standing on its own — never a fragment of a catalogue number. */
const STANDALONE_YEAR_RE = /(?<![\d-])((?:1[5-9]|20)\d{2})(?![\d-])/g;

function tokenize(text: string): string[] {
  // Deduplicated: title, description, tags and assetId routinely repeat the same words
  // ("WLP-Videos" as both title and identifier), and counting them twice made a two-word title
  // look like four words of description and pushed it over the judging threshold.
  return [
    ...new Set(
      foldSearchText(text)
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
    ),
  ];
}

function yearsIn(text: string): number[] {
  return [...text.matchAll(STANDALONE_YEAR_RE)].map((m) => Number.parseInt(m[1]!, 10));
}

/**
 * The topic this video is about, from whatever text describes it.
 *
 * `anchors` are the topic tags the pipeline already extracts (extractTopicAnchorTags); title and
 * scene text widen that so a candidate matching any real subject word counts as topical.
 */
export function buildTopicMatcher(
  videoTitle: string | undefined,
  anchors: string[] = [],
  extraText = ""
): TopicMatcher {
  const tokens = new Set<string>();
  for (const anchor of anchors) for (const t of tokenize(anchor)) tokens.add(t);
  for (const t of tokenize(videoTitle ?? "")) tokens.add(t);
  for (const t of tokenize(extraText)) tokens.add(t);
  const years = [...yearsIn(`${videoTitle ?? ""} ${extraText}`)];
  return { tokens, years };
}

/** How many years apart a candidate may be before its period contradicts the video's. */
const ERA_TOLERANCE_YEARS = 40;
export function assessCandidateTopicality(
  candidate: { title?: string | null; description?: string | null; tags?: string[] | null; assetId?: string | null },
  matcher: TopicMatcher
): TopicalAssessment {
  const raw = [
    candidate.title ?? "",
    candidate.description ?? "",
    (candidate.tags ?? []).join(" "),
    // The provider's own identifier often carries the only real words there are
    // ("faces-of-ancient-europe-1-500-a.d"), so it counts as metadata too.
    candidate.assetId ?? "",
  ].join(" ");

  const tokens = tokenize(raw);
  const matched = [...new Set(tokens.filter((t) => matcher.tokens.has(t)))];

  const folded = foldSearchText(raw);
  const candidateYears = yearsIn(raw);
  let eraConflict = false;
  let reason = "";

  if (matcher.years.length > 0 && candidateYears.length > 0) {
    const nearest = Math.min(
      ...candidateYears.map((cy) => Math.min(...matcher.years.map((ty) => Math.abs(cy - ty))))
    );
    if (nearest > ERA_TOLERANCE_YEARS) {
      eraConflict = true;
      reason = `year ${candidateYears[0]} is ${nearest}y from the topic period`;
    }
  }
  if (!eraConflict && matcher.years.length > 0 && ANCIENT_ERA_RE.test(folded)) {
    eraConflict = true;
    reason = "metadata names an ancient/medieval era";
  }

  if (eraConflict) {
    return { verdict: "off_topic", matched, descriptiveTokens: tokens.length, eraConflict, reason };
  }
  // RONDE 57: one everyday word from the title is not evidence.
  //
  // extractTopicAnchorTags on "Why Hitler Chose Death: The Dark End of the Third Reich" returns
  // ["hitler","chose","death","dark","third","reich"] — half of it generic. That made
  // "Dark concrete room with dim light" and "Candle burning in the dark" read as topical purely
  // because the title contains the word "dark", while "Ruins of a bombed city" did not. The
  // match has to rest on something that actually identifies this subject.
  const evidence = matched.filter((t) => !GENERIC_TOPIC_WORDS.has(t));
  if (evidence.length > 0) {
    return {
      verdict: "topical",
      matched,
      descriptiveTokens: tokens.length,
      eraConflict: false,
      reason: `matches ${evidence.slice(0, 3).join(", ")}`,
    };
  }
  // RONDE 57: no longer rejected for merely failing to mention the topic.
  //
  // The earlier rule — "enough descriptive words and none of them topical, therefore wrong" —
  // was tested against realistic B-roll metadata before this went anywhere near a render, and it
  // had it backwards:
  //
  //     off_topic  Ruins of a bombed city     6 descriptive words, none about this topic
  //     off_topic  Soldiers marching          4 descriptive words, none about this topic
  //     off_topic  Typewriter close up        5 descriptive words, none about this topic
  //
  // Those are exactly the shots a documentary about Berlin in 1945 needs. And the candidates it
  // waved through were worse than the ones it dropped (see topicalEvidence below).
  //
  // "Ruins of a bombed city" and "white-lives-matter-montana-sticker" both have descriptive
  // metadata and both share no word with the topic. Keyword overlap cannot tell them apart —
  // that needs meaning, not word matching. So absence of overlap is no longer treated as
  // evidence of anything: it leaves the candidate unjudged, ranked below the ones that DID name
  // the subject, and the only hard rejection left is a period this video cannot be about.
  return {
    verdict: "neutral",
    matched,
    descriptiveTokens: tokens.length,
    eraConflict: false,
    reason: matched.length > 0 ? "matched only generic words" : "no topical evidence either way",
  };
}

/**
 * Ranking multiplier for a verdict.
 *
 * Topical metadata is real evidence and outranks silence; silence is left exactly where it was so
 * this never reorders candidates it cannot judge.
 */
export function topicalRankingBonus(verdict: TopicalVerdict): number {
  switch (verdict) {
    case "topical":
      return 0.6;
    case "off_topic":
      return -0.5;
    default:
      return 0;
  }
}

/**
 * Drops the candidates whose metadata argues against them — but never empties the list.
 *
 * A beat with nothing left becomes a colour card, which is worse than a weak clip, so when every
 * candidate is off-topic they all stay and the ranking penalty decides the order instead. That is
 * the same principle the archive's exhaustion rule already uses.
 */
export function rejectOffTopicCandidates<T>(
  candidates: T[],
  assess: (c: T) => TopicalAssessment
): { kept: T[]; dropped: Array<{ candidate: T; assessment: TopicalAssessment }> } {
  const dropped: Array<{ candidate: T; assessment: TopicalAssessment }> = [];
  const kept: T[] = [];
  for (const c of candidates) {
    const assessment = assess(c);
    if (assessment.verdict === "off_topic") dropped.push({ candidate: c, assessment });
    else kept.push(c);
  }
  if (kept.length === 0) return { kept: candidates, dropped: [] };
  return { kept, dropped };
}
