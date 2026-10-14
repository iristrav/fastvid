/**
 * FIX 1+2 (14 October) — EVERY PICTURE IN THE FILM HAS PASSED BOTH MANDATORY CHECKS.
 *
 * Render 658 put six pictures under eleven sentences that no model had looked at
 * (`[UNJUDGED_FOOTAGE_FALLBACK]`, `judge:UNREVIEWED judge=0ms`) while 64 of the render's 120 looks
 * were left, and its emergency rungs never asked whether a picture carries text. The owner's rule:
 * a picture reaches the film only when
 *
 *   1. the picture editor judged it for THIS sentence and called it a fit or acceptable
 *      (`checkBeatRelevance`, the verdict cached per clip AND sentence — never another sentence's);
 *   2. the on-screen-text check (`judgeOnScreenText`) looked at it and found no text that IS the
 *      picture (`fills_picture`); a logo, subtitle or watermark over real footage (`overlay`) goes on
 *      to the picture editor exactly as before — the criteria are unchanged.
 *
 * A missing, empty, failed or never-made answer is NOT a pass. A technical check (valid file, not
 * black) never stands in for either. This module decides nothing else and fetches nothing itself:
 * the caller hands it what the render already knows and the two ways to ask, and it asks only what
 * is still unknown — a recorded refusal costs no call, a recorded verdict is reused, the text check
 * runs before the (dearer) look, and a text failure skips the look.
 */

/** What the picture editor established about one picture under one sentence. */
export type ContentCheck = "fit" | "acceptable" | "refused" | "not_judged";
/** What the on-screen-text check established about one picture. */
export type TextCheck = "clean" | "overlay" | "fills_picture" | "unchecked";

export const MANDATORY_CHECKS = "MandatoryChecks";

export function contentPasses(c: ContentCheck | null | undefined): boolean {
  return c === "fit" || c === "acceptable";
}

export function textPasses(t: TextCheck | null | undefined): boolean {
  return t === "clean" || t === "overlay";
}

/**
 * `judgeOnScreenText`'s answer as a check result. No answer, or an answer that says nobody looked
 * (`evaluated: false` — the budget, an outage, a timeout), is `unchecked`, never `clean`.
 */
export function textCheckFromVerdict(
  v: { decision: "ACCEPT" | "REJECT"; evaluated?: boolean; textKind?: string } | null | undefined
): TextCheck {
  if (!v || v.evaluated === false) return "unchecked";
  if (v.decision === "REJECT") return v.textKind === "fills_picture" ? "fills_picture" : "overlay";
  return "clean";
}

/**
 * The picture editor's decision as a check result. A decline (`evaluated: false`) is `not_judged`;
 * a look that could not tell (`unknown`) is a refusal — the prompt's own rule is "when you cannot
 * tell, it does NOT belong" — and a reprieved refusal is still a refusal.
 */
export function contentCheckFromDecision(
  d: { verdict: string; evaluated?: boolean } | null | undefined
): ContentCheck {
  if (!d || d.evaluated === false) return "not_judged";
  if (d.verdict === "fits") return "fit";
  if (d.verdict === "acceptable") return "acceptable";
  return "refused";
}

export type MandatoryCheckIo = {
  /** What the render's ledger already holds for this picture under THIS sentence. */
  recordedContent: () => ContentCheck;
  /** Ask the picture editor once, for this picture under this sentence. Never throws to the caller. */
  judgeContent: () => Promise<ContentCheck>;
  /** A text verdict already on record for this exact picture, or null. */
  recordedText: () => TextCheck | null;
  /** Run the text check for this picture. */
  checkText: () => Promise<TextCheck>;
};

export type MandatoryCheckOutcome = {
  pass: boolean;
  content: ContentCheck;
  text: TextCheck;
  /** Which checks cost a call here (for the cost line). */
  askedContent: boolean;
  askedText: boolean;
  /** Why it failed; null on a pass. */
  reason: string | null;
};

export async function runMandatoryChecks(io: MandatoryCheckIo): Promise<MandatoryCheckOutcome> {
  let content = io.recordedContent();
  let text: TextCheck = io.recordedText() ?? "unchecked";
  const out = (pass: boolean, reason: string | null, askedContent: boolean, askedText: boolean): MandatoryCheckOutcome => ({
    pass, content, text, askedContent, askedText, reason,
  });
  /** A refusal on record for this sentence ends it for free. */
  if (content === "refused") return out(false, "the picture editor refused it for this sentence", false, false);
  let askedText = false;
  if (!textPasses(text) && text !== "fills_picture") {
    askedText = true;
    text = await io.checkText().catch((): TextCheck => "unchecked");
  }
  if (text === "fills_picture") return out(false, "text fills the picture", false, askedText);
  if (!textPasses(text)) return out(false, "the text check gave no answer", false, askedText);
  let askedContent = false;
  if (content === "not_judged") {
    askedContent = true;
    content = await io.judgeContent().catch((): ContentCheck => "not_judged");
  }
  if (content === "refused") return out(false, "the picture editor refused it for this sentence", askedContent, askedText);
  if (!contentPasses(content)) return out(false, "the picture editor gave no verdict", askedContent, askedText);
  return out(true, null, askedContent, askedText);
}

/** One line per decision, so the log shows every picture's two checks. */
export function formatMandatoryCheck(where: string, file: string, route: string, o: MandatoryCheckOutcome): string {
  return (
    `[${MANDATORY_CHECKS}] ${where} ${o.pass ? "PASS" : "FAIL"} route=${route} file=${file} ` +
    `content=${o.content} text=${o.text} asked=${[o.askedText ? "text" : "", o.askedContent ? "judge" : ""].filter(Boolean).join("+") || "none"}` +
    (o.reason ? ` — ${o.reason}` : "")
  );
}

/**
 * Take the clips that failed out of a scene's parallel lists (`clips`, `beatDurations`,
 * `clipBeatIndices`). Returns the removed paths.
 */
export function removeClipsAt<T extends { clips: string[]; beatDurations: number[]; clipBeatIndices?: number[] }>(
  vr: T,
  remove: (clipPath: string, beatIndex: number | undefined, i: number) => boolean
): string[] {
  const removed: string[] = [];
  for (let i = vr.clips.length - 1; i >= 0; i--) {
    if (!remove(vr.clips[i]!, vr.clipBeatIndices?.[i], i)) continue;
    removed.push(vr.clips[i]!);
    vr.clips.splice(i, 1);
    vr.beatDurations.splice(i, 1);
    vr.clipBeatIndices?.splice(i, 1);
  }
  return removed.reverse();
}
