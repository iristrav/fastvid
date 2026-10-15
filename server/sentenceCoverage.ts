/**
 * HARD QUALITY GATE — DOES EVERY SPOKEN SENTENCE HAVE A PICTURE THAT FITS, FOR ALL OF ITS TIME?
 *
 * Measured on the timeline the file is rendered from, sentence by sentence, against the sentence's
 * spoken window (`ProjectTimeline.sentences`). What counts as cover:
 *
 *   approved_footage   a visible video/image clip the picture editor approved for THIS sentence
 *                      (`source.contentApproval === "judge_fit"` AND the clip's `sceneIndex`/`beatIndex`
 *                      name this sentence), for the seconds its SOURCE really has — a clip held past
 *                      its source window (`sourceOut − sourceIn`) is a frozen frame from there on, and
 *                      those seconds are `stretched`, not cover;
 *   content_graphic    a graphic placed as THIS sentence's picture (`data.primaryVisual`, its
 *                      `sceneIndex`/`beatIndex`) that is NOT a chapter card: a chart, map, timeline,
 *                      counter … drawn from the sentence's facts;
 *   acceptable_footage VIDEO 650 — a clip the picture editor called ACCEPTABLE for THIS sentence (the
 *                      subject shown, the situation not; `contentApproval === "judge_acceptable"`),
 *                      adopted because no fit was found. Counted as cover and named on every row;
 *   generic_footage    VIDEO 650 — rights-clear moving footage placed for THIS sentence as the floor
 *                      under the sourcing ladder (`source.contentApproval === "generic_footage"`,
 *                      genericFootageFallback.ts). Counted as cover and NAMED as generic on every row,
 *                      because it is visual coverage and explicitly not a content fit;
 *   ai_generated       VIDEO 659 — a picture generated for THIS sentence and placed by the owner's rule
 *                      (`source.contentApproval === "ai_generated"`): cover, named as AI-generated;
 *   synthetic_placeholder  PRE-DEPLOY — the subset of generic cover whose provider is the synthetic
 *                      colour field (`source.provider === "synthetic_placeholder"`): an EMERGENCY
 *                      placeholder, not footage. NOT cover: a coloured field under a spoken sentence
 *                      is no picture, so the sentence is uncovered (reason "synthetic placeholder …"),
 *                      the delivery gate refuses the film, and the row, `problems` and the gate name
 *                      it as a QUALITY PROBLEM — never passed off as a picture.
 *
 * TIMING — `timing` says what the spoken windows rest on: "exact" (every sentence from the TTS word
 * alignment), "approximate" (every sentence measured, at least one from the pauses in the scene's
 * audio — `measured_silence`, a boundary inside a pause rather than a word timestamp), "unproven"
 * (an estimated or missing window, or a sentence not covered). `proven` is true for "exact" only.
 *
 * What does NOT count: a chapter card (the blue-grey `PRIMARY_GROUND` of Graphics.tsx), a clip without
 * the approval mark (technically present, fit not established), a clip or graphic approved for ANOTHER
 * sentence that happens to run under this one (the editor never asked whether it fits here — the
 * end-to-end test found a neighbour's clip passing as cover), a clip without a sentence mark, a card
 * ground (opacity 0), nothing.
 *
 * The decision — deliver or block — is the DeliveryGate's (deliveryGate.ts). This module only measures,
 * and says when it cannot: no sentences on the timeline, an estimated (laid-out) spoken window, or a
 * clip whose source window is unknown all make a sentence `unknown`, never `covered`.
 */
import type { ProjectTimeline, TimelineGraphic, TimelineSentence, TimelineVideoClip } from "./projectTimeline";
import { graphicsTrack, videoTrack } from "./projectTimeline";
import { isAiGeneratedProvider } from "./generatedImageFallback";

export type SentenceCoverageStatus = "covered" | "partial" | "uncovered" | "unknown";
export type SentencePictureKind = "approved_footage" | "acceptable_footage" | "ai_generated_footage" | "content_graphic" | "generic_footage" | "synthetic_placeholder" | "chapter_card" | "unverified_footage" | "other_sentence_picture" | "stretched_footage" | "none";

export type SentenceTimingVerdict = "exact" | "approximate" | "unproven";

export type SentenceCoverageRow = {
  key: string;
  sceneIndex: number;
  beatIndex: number;
  text: string | null;
  startSec: number | null;
  endSec: number | null;
  spokenSec: number | null;
  timingBasis: "measured" | "measured_silence" | "estimated" | "missing";
  status: SentenceCoverageStatus;
  /** Seconds of the spoken window under approved footage or a content graphic. */
  coveredSec: number;
  approvedFootageSec: number;
  /** VIDEO 650 — a picture the judge called acceptable (subject shown, situation not), adopted without a fit. */
  acceptableFootageSec: number;
  /** The approved or acceptable seconds whose picture is AI-GENERATED (AI_GENERATED_PROVIDERS): cover, named as generated. */
  aiGeneratedSec: number;
  /** VIDEO 650 — rights-clear moving footage placed as the floor under the ladder: cover, not a content fit. */
  genericFootageSec: number;
  /** PRE-DEPLOY — the part of the generic cover that is the synthetic colour field: an emergency placeholder, NOT footage. */
  syntheticPlaceholderSec: number;
  contentGraphicSec: number;
  /** Seconds under footage without the approval mark, or an approved picture without a sentence mark (fit not established). */
  unverifiedSec: number;
  /** Seconds under a picture the editor approved for ANOTHER sentence: known not to be this sentence's. */
  otherSentenceSec: number;
  /** Seconds under a clip held past its source window (a frozen frame). */
  stretchedSec: number;
  /** Seconds under a chapter card — the blue-grey placeholder. */
  cardSec: number;
  /** Seconds with nothing visible at all. */
  emptySec: number;
  kinds: SentencePictureKind[];
  reasons: string[];
};

export type CardInterval = { startSec: number; endSec: number; graphicId: string; sceneIndex: number | null; beatIndex: number | null };

export type SentenceCoverageReport = {
  basis: "timeline";
  sentences: SentenceCoverageRow[];
  total: number;
  covered: number;
  partial: number;
  uncovered: number;
  unknown: number;
  /** Clips on the timeline held past their source window. */
  stretchedClips: number;
  /** Chapter cards placed as a sentence's picture: planned placeholder time. */
  cardIntervals: CardInterval[];
  plannedCardSec: number;
  /** True only when every sentence is `covered` on measured timing: the one state that can pass the gate. */
  proven: boolean;
  /** PRE-DEPLOY — what the windows rest on: exact (word timestamps), approximate (pauses), unproven. */
  timing: SentenceTimingVerdict;
  problems: string[];
};

type Span = [number, number];
const EPS = 0.05;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function union(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const clip = (spans: Span[], lo: number, hi: number): Span[] => spans.map(([a, b]): Span => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a);
const measure = (spans: Span[]): number => union(spans).reduce((s, [a, b]) => s + (b - a), 0);
/** `spans` minus `cover` */
function subtract(spans: Span[], cover: Span[]): Span[] {
  let rest = union(spans);
  for (const [c, d] of union(cover)) {
    const next: Span[] = [];
    for (const [a, b] of rest) {
      if (d <= a || c >= b) next.push([a, b]);
      else {
        if (c > a) next.push([a, c]);
        if (d < b) next.push([d, b]);
      }
    }
    rest = next;
  }
  return rest;
}

const CARD_TYPES = new Set(["chapter_card", "chapter_title"]);
const GRAPHIC_BACKDROP_RE = /_graphic\d+$/;

export function isChapterCardGraphic(g: Pick<TimelineGraphic, "graphicType" | "data" | "disabled">): boolean {
  return !g.disabled && g.data?.primaryVisual === true && CARD_TYPES.has(g.graphicType);
}
export function isContentGraphic(g: Pick<TimelineGraphic, "graphicType" | "data" | "disabled">): boolean {
  return !g.disabled && g.data?.primaryVisual === true && !CARD_TYPES.has(g.graphicType);
}

/** The seconds of source a clip really has, or null when the timeline does not say. */
export function sourceWindowSec(c: Pick<TimelineVideoClip, "sourceIn" | "sourceOut" | "speed" | "kind">): number | null {
  if (c.kind === "image") return Number.POSITIVE_INFINITY; // a still has no source end
  if (c.sourceIn == null || c.sourceOut == null) return null;
  const w = c.sourceOut - c.sourceIn;
  if (!Number.isFinite(w) || w <= 0) return null;
  const speed = c.speed && c.speed > 0 ? c.speed : 1;
  return w / speed;
}

/** The chapter cards placed as a sentence's picture, with their windows: what the MP4 check must look at. */
export function chapterCardIntervals(timeline: Pick<ProjectTimeline, "tracks">): CardInterval[] {
  return graphicsTrack(timeline as ProjectTimeline)
    .filter(isChapterCardGraphic)
    .map((g) => ({
      startSec: Number(g.start) || 0,
      endSec: Number(g.end) || 0,
      graphicId: g.id,
      sceneIndex: typeof g.data?.sceneIndex === "number" ? (g.data.sceneIndex as number) : null,
      beatIndex: typeof g.data?.beatIndex === "number" ? (g.data.beatIndex as number) : null,
    }))
    .filter((c) => c.endSec > c.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/** The content graphics placed as a sentence's picture (a chart, a counter, a map): the MP4 scan reads their ground as theirs, not as placeholder. */
export function contentGraphicIntervals(timeline: Pick<ProjectTimeline, "tracks">): CardInterval[] {
  return graphicsTrack(timeline as ProjectTimeline)
    .filter(isContentGraphic)
    .map((g) => ({
      startSec: Number(g.start) || 0,
      endSec: Number(g.end) || 0,
      graphicId: g.id,
      sceneIndex: typeof g.data?.sceneIndex === "number" ? (g.data.sceneIndex as number) : null,
      beatIndex: typeof g.data?.beatIndex === "number" ? (g.data.beatIndex as number) : null,
    }))
    .filter((c) => c.endSec > c.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

export function sentenceCoverage(timeline: ProjectTimeline): SentenceCoverageReport {
  const problems: string[] = [];
  const live = videoTrack(timeline).filter((c) => !c.disabled);
  const graphics = graphicsTrack(timeline);
  const cardIntervals = chapterCardIntervals(timeline);
  const plannedCardSec = r3(measure(cardIntervals.map((c): Span => [c.startSec, c.endSec])));

  /* the pictures, by kind — an approved picture is tagged with the sentence it was approved FOR */
  const sentenceKeyOf = (o: { sceneIndex?: unknown; beatIndex?: unknown }): string | null =>
    typeof o.sceneIndex === "number" && typeof o.beatIndex === "number" ? `s${o.sceneIndex}b${o.beatIndex}` : null;
  const approved: Array<{ span: Span; forSentence: string | null }> = [];
  const acceptable: Array<{ span: Span; forSentence: string | null }> = [];
  /** the approved/acceptable spans whose picture a model generated — a subset, named apart */
  const aiGenerated: Array<{ span: Span; forSentence: string | null }> = [];
  /** VIDEO 659 — a picture generated for its sentence and kept by the owner's rule (`ai_generated`): cover, named as AI */
  const aiKept: Array<{ span: Span; forSentence: string | null }> = [];
  const generic: Array<{ span: Span; forSentence: string | null }> = [];
  const synthetic: Array<{ span: Span; forSentence: string | null }> = [];
  const unverified: Span[] = [];
  const stretched: Span[] = [];
  let stretchedClips = 0;
  const unknownWindow: Span[] = [];
  for (const c of live) {
    if (GRAPHIC_BACKDROP_RE.test(c.id)) continue; // a card's ground, not a picture
    if (typeof c.transform?.opacity === "number" && c.transform.opacity <= 0) continue; // hidden
    const start = Number(c.timelineStart) || 0;
    const end = Number(c.timelineEnd) || 0;
    if (end <= start) continue;
    const window = sourceWindowSec(c);
    let shownEnd = end;
    if (window == null) {
      unknownWindow.push([start, end]);
    } else if (end - start > window + EPS) {
      shownEnd = start + window;
      stretched.push([shownEnd, end]);
      stretchedClips++;
    }
    if (c.source?.contentApproval === "judge_fit") approved.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
    else if (c.source?.contentApproval === "judge_acceptable") acceptable.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
    else if (c.source?.contentApproval === "ai_generated") {
      aiKept.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
      aiGenerated.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
    } else if (c.source?.contentApproval === "generic_footage") {
      generic.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
      if (c.source?.provider === "synthetic_placeholder") synthetic.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
    } else unverified.push([start, shownEnd]);
    if ((c.source?.contentApproval === "judge_fit" || c.source?.contentApproval === "judge_acceptable") && isAiGeneratedProvider(c.source?.provider)) {
      aiGenerated.push({ span: [start, shownEnd], forSentence: sentenceKeyOf(c) });
    }
  }
  const contentGraphics: Array<{ span: Span; forSentence: string | null }> = graphics
    .filter(isContentGraphic)
    .map((g) => ({ span: [Number(g.start) || 0, Number(g.end) || 0] as Span, forSentence: sentenceKeyOf(g.data ?? {}) }));
  const cards: Span[] = cardIntervals.map((c): Span => [c.startSec, c.endSec]);

  const sentences = timeline.sentences ?? [];
  if (sentences.length === 0) problems.push("the timeline carries no sentences: coverage cannot be measured");

  const rows: SentenceCoverageRow[] = sentences.map((s: TimelineSentence) => {
    const key = `s${s.sceneIndex}b${s.beatIndex}`;
    const base: Omit<SentenceCoverageRow, "status" | "kinds" | "reasons"> = {
      key,
      sceneIndex: s.sceneIndex,
      beatIndex: s.beatIndex,
      text: s.text ?? null,
      startSec: s.startSec,
      endSec: s.endSec,
      spokenSec: s.startSec != null && s.endSec != null && s.endSec > s.startSec ? r3(s.endSec - s.startSec) : null,
      timingBasis: s.startSec == null || s.endSec == null ? "missing" : s.timingBasis,
      coveredSec: 0,
      approvedFootageSec: 0,
      acceptableFootageSec: 0,
      aiGeneratedSec: 0,
      genericFootageSec: 0,
      syntheticPlaceholderSec: 0,
      contentGraphicSec: 0,
      unverifiedSec: 0,
      otherSentenceSec: 0,
      stretchedSec: 0,
      cardSec: 0,
      emptySec: 0,
    };
    if (base.spokenSec == null) {
      return { ...base, status: "unknown", kinds: [], reasons: ["no spoken window for this sentence"] };
    }
    const lo = s.startSec!;
    const hi = s.endSec!;
    const win: Span[] = [[lo, hi]];
    /** approved FOR THIS sentence; a neighbour's approved picture or an unmarked one is not established here */
    const approvedIn = clip(approved.filter((a) => a.forSentence === key).map((a) => a.span), lo, hi);
    const graphicIn = clip(contentGraphics.filter((g) => g.forSentence === key).map((g) => g.span), lo, hi);
    /** VIDEO 650 — an acceptable picture and generic footage placed FOR this sentence: cover, named below */
    const acceptableIn = clip(acceptable.filter((g) => g.forSentence === key).map((g) => g.span), lo, hi);
    const genericIn = clip(generic.filter((g) => g.forSentence === key).map((g) => g.span), lo, hi);
    const syntheticIn = clip(synthetic.filter((g) => g.forSentence === key).map((g) => g.span), lo, hi);
    const aiIn = clip(aiGenerated.filter((g) => g.forSentence === key).map((g) => g.span), lo, hi);
    const aiKeptIn = clip(aiKept.filter((g) => g.forSentence === key).map((g) => g.span), lo, hi);
    const otherSentenceIn = clip(
      [...approved, ...acceptable, ...generic, ...aiKept, ...contentGraphics].filter((a) => a.forSentence != null && a.forSentence !== key).map((a) => a.span),
      lo,
      hi
    );
    const unmarkedIn = clip([...approved, ...acceptable, ...generic, ...aiKept, ...contentGraphics].filter((a) => a.forSentence == null).map((a) => a.span), lo, hi);
    /** the synthetic colour field is placed as generic, but it is not a picture: never cover */
    const coverSpans = union([...approvedIn, ...graphicIn, ...acceptableIn, ...aiKeptIn, ...subtract(genericIn, syntheticIn)]);
    const rest = subtract(win, coverSpans);
    const unverifiedIn = clip([...unverified, ...unmarkedIn], lo, hi);
    const stretchedIn = clip(stretched, lo, hi);
    const cardsIn = clip(cards, lo, hi);
    const unknownIn = clip(unknownWindow, lo, hi);
    const row: Omit<SentenceCoverageRow, "status" | "kinds" | "reasons"> = {
      ...base,
      coveredSec: r3(measure(coverSpans)),
      approvedFootageSec: r3(measure(approvedIn)),
      acceptableFootageSec: r3(measure(subtract(acceptableIn, union([...approvedIn, ...graphicIn])))),
      aiGeneratedSec: r3(measure(aiIn)),
      genericFootageSec: r3(measure(subtract(genericIn, union([...approvedIn, ...graphicIn, ...acceptableIn])))),
      syntheticPlaceholderSec: r3(measure(subtract(syntheticIn, union([...approvedIn, ...graphicIn, ...acceptableIn])))),
      contentGraphicSec: r3(measure(graphicIn)),
      unverifiedSec: r3(measure(clip(unverifiedIn, lo, hi).length ? subtract(unverifiedIn, coverSpans) : [])),
      otherSentenceSec: r3(measure(subtract(otherSentenceIn, coverSpans))),
      stretchedSec: r3(measure(subtract(stretchedIn, coverSpans))),
      cardSec: r3(measure(subtract(cardsIn, coverSpans))),
      emptySec: r3(measure(subtract(rest, [...unverifiedIn, ...otherSentenceIn, ...stretchedIn, ...cardsIn, ...syntheticIn]))),
    };
    const kinds: SentencePictureKind[] = [];
    if (row.approvedFootageSec > 0) kinds.push("approved_footage");
    if (row.contentGraphicSec > 0) kinds.push("content_graphic");
    if (row.acceptableFootageSec > 0) kinds.push("acceptable_footage");
    if (row.aiGeneratedSec > 0) kinds.push("ai_generated_footage");
    if (row.genericFootageSec > 0) kinds.push("generic_footage");
    if (row.syntheticPlaceholderSec > 0) kinds.push("synthetic_placeholder");
    if (row.cardSec > 0) kinds.push("chapter_card");
    if (row.unverifiedSec > 0) kinds.push("unverified_footage");
    if (row.otherSentenceSec > 0) kinds.push("other_sentence_picture");
    if (row.stretchedSec > 0) kinds.push("stretched_footage");
    if (row.emptySec > 0 || kinds.length === 0) kinds.push("none");
    const reasons: string[] = [];
    if (row.cardSec > 0) reasons.push(`chapter card placeholder ${row.cardSec.toFixed(2)}s`);
    if (row.syntheticPlaceholderSec > 0) reasons.push(`synthetic placeholder (colour field, not footage) ${row.syntheticPlaceholderSec.toFixed(2)}s`);
    if (row.otherSentenceSec > 0) reasons.push(`picture approved for another sentence ${row.otherSentenceSec.toFixed(2)}s`);
    const unmarkedSec = r3(measure(subtract(clip(unmarkedIn, lo, hi), coverSpans)));
    if (unmarkedSec > 0) reasons.push(`approved picture without a sentence mark ${unmarkedSec.toFixed(2)}s`);
    if (row.unverifiedSec - unmarkedSec > 0.0005) reasons.push(`footage without the picture editor's approval ${(row.unverifiedSec - unmarkedSec).toFixed(2)}s`);
    if (row.stretchedSec > 0) reasons.push(`clip held past its source ${row.stretchedSec.toFixed(2)}s`);
    if (row.emptySec > 0) reasons.push(`no picture ${row.emptySec.toFixed(2)}s`);
    if (measure(unknownIn) > 0) reasons.push(`clip without a known source window ${measure(unknownIn).toFixed(2)}s`);
    if (row.timingBasis === "estimated") reasons.push("spoken window is the planner's estimate, not measured narration");

    const full = row.coveredSec >= row.spokenSec! - EPS;
    /** something KNOWN not to be this sentence's picture: a card, a hold, nothing, or a neighbour's approved picture */
    const knownGap = row.cardSec > 0 || row.syntheticPlaceholderSec > 0 || row.emptySec > 0 || row.stretchedSec > 0 || row.otherSentenceSec > 0;
    let status: SentenceCoverageStatus;
    if (row.timingBasis === "estimated" || measure(unknownIn) > 0) status = "unknown";
    else if (full) status = "covered";
    else if (row.coveredSec <= EPS) status = row.unverifiedSec > 0 && !knownGap ? "unknown" : "uncovered";
    else status = row.unverifiedSec > 0 && !knownGap ? "unknown" : "partial";
    /** a fully covered window with nothing else under it has no reasons */
    return { ...row, status, kinds, reasons: status === "covered" ? [] : reasons };
  });

  const count = (st: SentenceCoverageStatus) => rows.filter((r) => r.status === st).length;
  const allCovered = rows.length > 0 && rows.every((r) => r.status === "covered");
  /** PRE-DEPLOY — exact only from word timestamps; windows cut at pauses are approximate, never "proven" */
  const proven = allCovered && rows.every((r) => r.timingBasis === "measured");
  const timing: SentenceTimingVerdict = proven
    ? "exact"
    : allCovered && rows.every((r) => r.timingBasis === "measured" || r.timingBasis === "measured_silence")
      ? "approximate"
      : "unproven";
  if (rows.some((r) => r.timingBasis === "estimated")) problems.push("spoken windows are estimated (no narration alignment): coverage in time cannot be proven");
  const fromPauses = rows.filter((r) => r.timingBasis === "measured_silence");
  if (fromPauses.length > 0) {
    problems.push(`spoken windows of ${fromPauses.length} sentence(s) are measured from pauses in the audio (measured_silence), not word timestamps: timing is approximate`);
  }
  const placeholders = rows.filter((r) => r.syntheticPlaceholderSec > 0);
  if (placeholders.length > 0) {
    problems.push(
      `synthetic placeholder (an emergency colour field, NOT footage) under ${placeholders.length} sentence(s), ` +
        `${placeholders.reduce((t, r) => t + r.syntheticPlaceholderSec, 0).toFixed(2)}s (${placeholders.map((r) => r.key).join(",")}): a quality problem, not a picture choice`
    );
  }
  return {
    basis: "timeline",
    sentences: rows,
    total: rows.length,
    covered: count("covered"),
    partial: count("partial"),
    uncovered: count("uncovered"),
    unknown: count("unknown"),
    stretchedClips,
    cardIntervals,
    plannedCardSec,
    proven,
    timing,
    problems,
  };
}

/** One log line per sentence and one total, read back by railwayLogAnalyser.ts. */
export function formatSentenceCoverage(videoId: number, report: SentenceCoverageReport): string[] {
  const lines = report.sentences.map(
    (r) =>
      `[SentenceCoverage] video=${videoId} ${r.key} spoken=${r.startSec == null || r.endSec == null ? "unknown" : `${r.startSec.toFixed(2)}-${r.endSec.toFixed(2)}s`} ` +
      `timing=${r.timingBasis} status=${r.status} covered=${r.coveredSec.toFixed(2)}s kinds=${r.kinds.join("+")} ` +
      `approvedFootage=${r.approvedFootageSec.toFixed(2)}s graphic=${r.contentGraphicSec.toFixed(2)}s acceptable=${r.acceptableFootageSec.toFixed(2)}s ai=${r.aiGeneratedSec.toFixed(2)}s generic=${r.genericFootageSec.toFixed(2)}s card=${r.cardSec.toFixed(2)}s ` +
      `unverified=${r.unverifiedSec.toFixed(2)}s otherSentence=${r.otherSentenceSec.toFixed(2)}s stretched=${r.stretchedSec.toFixed(2)}s empty=${r.emptySec.toFixed(2)}s` +
      (r.syntheticPlaceholderSec > 0 ? ` syntheticPlaceholder=${r.syntheticPlaceholderSec.toFixed(2)}s` : "") +
      (r.reasons.length ? ` reason="${r.reasons.join("; ")}"` : "")
  );
  lines.push(
    `[SentenceCoverage] video=${videoId} TOTAL sentences=${report.total} covered=${report.covered} partial=${report.partial} uncovered=${report.uncovered} unknown=${report.unknown} ` +
      `stretchedClips=${report.stretchedClips} plannedCardSec=${report.plannedCardSec.toFixed(2)} proven=${report.proven ? "yes" : "no"} timing=${report.timing}` +
      (report.problems.length ? ` problems="${report.problems.join("; ")}"` : "")
  );
  return lines;
}
