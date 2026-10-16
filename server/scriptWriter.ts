/**
 * Professional documentary script generation with length budgets tied to video duration.
 * Targets spoken narration length (WPM) so VO matches chosen video length.
 */
import { normalizeVideoLength, type VideoLength } from "../shared/videoLengths";
import { foldSearchText } from "./searchTextNormalize";

export interface ScriptLengthBudget {
  videoLength: string;
  label: string;
  targetSpokenSec: number;
  targetWords: number;
  minWords: number;
  maxWords: number;
  targetChars: number;
  minChars: number;
  maxChars: number;
  hookWords: number;
  ctaWords: number;
  sectionCount: number;
}

/** Documentary voice-over pace (~145 WPM). */
export const NARRATION_WPM = 145;

const SPOKEN_SECONDS: Record<VideoLength, number> = {
  "1": 58,
  "3": 175,
  "5": 290,
  "30": 1740,
  "60": 3480,
  "8-10": 540,
  "10-15": 750,
  "15-20": 1050,
};

const LENGTH_LABELS: Record<VideoLength, string> = {
  "1": "1 minute",
  "3": "3 minutes",
  "5": "5 minutes",
  "30": "30 minutes",
  "60": "60 minutes",
  "8-10": "8–10 minutes",
  "10-15": "10–15 minutes",
  "15-20": "15–20 minutes",
};

export function getScriptLengthBudget(videoLengthRaw: string): ScriptLengthBudget {
  const videoLength = normalizeVideoLength(videoLengthRaw);
  const targetSpokenSec = SPOKEN_SECONDS[videoLength];
  const targetWords = Math.round((targetSpokenSec / 60) * NARRATION_WPM);
  const minWords = Math.round(targetWords * 0.9);
  const maxWords = Math.round(targetWords * 1.1);
  const targetChars = Math.round(targetWords * 5.6);
  const minChars = Math.round(targetChars * 0.9);
  const maxChars = Math.round(targetChars * 1.1);

  /** One section per ~1.5–4 minutes of narration, by the length's target minutes. */
  const minutes = targetSpokenSec / 60;
  const sectionCount =
    minutes <= 1 ? 2
      : minutes <= 5 ? 4
        : minutes <= 10 ? 6
          : minutes <= 15 ? 7
            : minutes <= 20 ? 8
              : minutes <= 30 ? 10
                : 14;

  const hookWords = videoLength === "1" ? 28 : 70;
  const ctaWords = videoLength === "1" ? 18 : 28;

  return {
    videoLength,
    label: LENGTH_LABELS[videoLength] ?? videoLength,
    targetSpokenSec,
    targetWords,
    minWords,
    maxWords,
    targetChars,
    minChars,
    maxChars,
    hookWords,
    ctaWords,
    sectionCount,
  };
}

/** Remove [VISUAL: ...] lines/tags — narration-only scripts for VO and editor. */
export function stripVisualTagsFromScript(script: string): string {
  return script
    .replace(/^\s*\[visual:[^\]]*\]\s*$/gim, "")
    .replace(/\[visual:[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * VIDEO 661 (G) — A WRITER'S INSTRUCTION IS NOT NARRATION.
 *
 * Render 70 (video 661) spoke "Delve into specific economic milestones…" and "What are the broader
 * implications…" — the outline the model was given, read out as if it were the film. Those sentences
 * have no picture (they got chapter cards) and no place in a documentary. Removed from a GENERATED
 * script before the voice-over:
 *
 *  - an instruction to the writer: a sentence that opens with an outline verb ("Delve into", "Explore",
 *    "Discuss", "Highlight", "Examine", "Describe", "Explain", "Summarize", "Transition to", …) or
 *    that talks about the film itself ("in this section", "the viewer", "the audience");
 *  - an outline question: a question that asks about the topic's "implications", "significance",
 *    "key factors", "lessons", "broader impact" — a prompt for the writer, not a line for the viewer.
 *
 * A story question ("But how did it all begin?") stays: only outline wording is removed. Headings,
 * [VISUAL] tags and every other sentence are untouched; a script that would lose more than a third of
 * its words is left as it was (something else is wrong with it, and silence is worse).
 */
const WRITER_INSTRUCTION_RE =
  /^(?:["'“‘(]\s*)?(?:delve|dive (?:into|deeper)|explore|discuss|examine|describe|explain|highlight|outline|summari[sz]e|analy[sz]e|elaborate|detail|introduce|mention|touch (?:on|upon)|transition (?:to|into)|conclude (?:with|by)|wrap up|focus on|emphasi[sz]e|illustrate)\b/i;
const META_REFERENCE_RE =
  /\b(?:in this (?:section|segment|part|chapter|scene|video)|the (?:viewer|viewers|audience)\b|this script|the narrator should|(?:the )?next section)\b/i;
const OUTLINE_QUESTION_RE =
  /\b(?:implications?|significance|key (?:factors|takeaways|lessons|points|drivers)|lessons? (?:can be |were )?learned|broader (?:impact|effects?|consequences|context)|long-term (?:impact|effects?|consequences))\b/i;

export function isWriterInstructionSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;
  if (WRITER_INSTRUCTION_RE.test(s)) return true;
  if (META_REFERENCE_RE.test(s)) return true;
  return /\?\s*["'”’)]?\s*$/.test(s) && OUTLINE_QUESTION_RE.test(s);
}

export function stripWriterInstructions(script: string): { script: string; removed: string[] } {
  const removed: string[] = [];
  const out = script
    .split("\n")
    .map((line) => {
      const t = line.trim();
      /** headings, [VISUAL] lines and blank lines are not narration */
      if (!t || /^#/.test(t) || /^\[visual:/i.test(t)) return line;
      const sentences = t.match(/[^.!?]+[.!?]+["'”’)]*|[^.!?]+$/g) ?? [t];
      /** Only the instruction itself is cut out; the rest of the line keeps its own spelling. */
      let next = line;
      for (const sen of sentences) {
        if (!isWriterInstructionSentence(sen)) continue;
        removed.push(sen.trim());
        next = next.replace(sen, " ");
      }
      return next === line ? line : next.replace(/[ \t]{2,}/g, " ").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bridged = dropClosingBridgeQuestions(out, removed);
  if (!removed.length) return { script, removed };
  return keepUnlessGutted(script, bridged, removed);
}

/**
 * VIDEO 661 (round 4) — A SCENE DOES NOT END ON A QUESTION.
 *
 * Render 70 still spoke "How did these engineering feats transform into economic power?": no outline
 * word in it, so G kept it — but it was the planner's bridge to the next scene, which the writer is
 * told to end every scene with. Such a line has no picture of its own (it got a chapter card) and
 * reads as the outline, not the film. The last sentence of a scene, when it is a question, is
 * removed — except in the opening (the hook may ask its one question), a question in quotation
 * marks (someone's words), and a scene that has nothing else to say.
 */
export function dropClosingBridgeQuestions(script: string, removed: string[]): string {
  const lines = script.split("\n");
  const isHeading = (t: string) => /^#{2,}\s/.test(t);
  let section = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i]!.trim())) section++;
    if (section < 2) continue;
    const t = lines[i]!.trim();
    if (!t || isHeading(t) || /^\[visual:/i.test(t)) continue;
    /** only the scene's last narration line */
    let j = i + 1;
    while (j < lines.length && (!lines[j]!.trim() || /^\[visual:/i.test(lines[j]!.trim()))) j++;
    if (j < lines.length && !isHeading(lines[j]!.trim())) continue;
    const sentences = t.match(/[^.!?]+[.!?]+["'”’)]*|[^.!?]+$/g) ?? [t];
    const last = sentences[sentences.length - 1]!;
    const narrationBefore = lines.slice(0, i).reverse();
    const headingAt = narrationBefore.findIndex((l) => isHeading(l.trim()));
    const sceneHasMore =
      sentences.length > 1 ||
      narrationBefore.slice(0, headingAt < 0 ? undefined : headingAt).some((l) => l.trim() && !/^\[visual:/i.test(l.trim()));
    if (!sceneHasMore) continue;
    if (!/\?\s*["'”’)]?\s*$/.test(last) || /["“”]/.test(last)) continue;
    removed.push(last.trim());
    lines[i] = sentences.length > 1 ? t.slice(0, t.lastIndexOf(last)).trim() : "";
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function keepUnlessGutted(script: string, out: string, removed: string[]): { script: string; removed: string[] } {
  const before = countNarrationWords(script);
  const after = countNarrationWords(out);
  if (before > 0 && after < before * (2 / 3)) return { script, removed: [] };
  return { script: out, removed };
}

export function countNarrationWords(script: string): number {
  const text = script
    .replace(/\[visual:[^\]]*\]/gi, "")
    .replace(/^#+\s+.+$/gm, "")
    .replace(/[#*_`~>]/g, "")
    .trim();
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

export type ScriptBudgetCheck = { ok: true } | { ok: false; words: number; message: string };

/** Spoken narration only — one continuous read order (no duplicate hooks across scenes). */
export function extractFullNarrationText(script: string): string {
  const blocks = parseMarkdownNarrationBlocks(script);
  if (blocks.length > 0) {
    return blocks.map((b) => b.text).filter((t) => t.length > 0).join(" ");
  }
  return plainNarrationText(script);
}

/**
 * VIDEO 623 — the script as plain text, headings and marks removed. Its own function because the
 * block parser's fallback called `extractFullNarrationText`, which called the parser again: a
 * script with no `##` section long enough to keep recursed until the stack ran out.
 */
function plainNarrationText(script: string): string {
  return script
    .replace(/\[visual:[^\]]*\]/gi, "")
    .replace(/^#+\s+.+$/gm, "")
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type MarkdownNarrationBlock = {
  heading: string;
  text: string;
  visualCue: string;
  sectionTitle: string;
};

const META_SECTION_RE =
  /^(opening|hook|intro|call to action|cta|outro|closing|title)\b/i;

export function parseMarkdownNarrationBlocks(script: string): MarkdownNarrationBlock[] {
  const raw = script.replace(/\r\n/g, "\n").trim();
  if (!raw) return [];

  const parts = raw.split(/(?=^##\s+)/m).map((p) => p.trim()).filter(Boolean);
  const blocks: MarkdownNarrationBlock[] = [];

  for (const part of parts) {
    const headingMatch = part.match(/^##\s+(.+?)\s*$/m);
    const heading = (headingMatch?.[1] ?? "Section").trim();
    if (/^#\s+/.test(part) && !headingMatch) continue;

    const body = part
      .replace(/^##\s+.+$/m, "")
      .replace(/^#\s+.+$/m, "")
      .replace(/\[visual:[^\]]*\]/gi, "")
      .replace(/[#*_`~>]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (body.length < 12) continue;

    const sectionTitle = META_SECTION_RE.test(heading) ? "" : heading.toUpperCase().slice(0, 60);

    blocks.push({
      heading,
      text: body,
      visualCue: body.slice(0, 80),
      sectionTitle,
    });
  }

  if (blocks.length === 0) {
    const fallback = plainNarrationText(raw);
    if (fallback.length > 20) {
      blocks.push({
        heading: "Document",
        text: fallback,
        visualCue: fallback.slice(0, 80),
        sectionTitle: "",
      });
    }
  }
  return blocks;
}

export function buildScriptWriterSystemPrompt(videoType: string): string {
  const typeInstructions: Record<string, string> = {
    documentary:
      "Format: premium YouTube documentary (Vox, Wendover, Johnny Harris, Lemmino). Research-backed, cinematic, conversational.",
    listicle:
      "Format: ranked listicle — each item must feel like a reveal with rising stakes, not a lecture.",
    tutorial:
      "Format: tutorial — clarity first, but still use story beats (problem → tension → solution → result).",
    explainer:
      "Format: explainer — analogies and visual metaphors, but with a narrative spine and open loops.",
  };
  const typeInstruction = typeInstructions[videoType] ?? typeInstructions.documentary;

  return `You are an elite YouTube scriptwriter and retention editor. ${typeInstruction}

Your scripts are written for the EAR — one continuous voice-over. Not essays. Not blog posts. Not TV news.

OUTPUT RULES (non-negotiable):
- Write ONLY spoken narration. No [VISUAL: ...] tags, stage directions, bullet lists, or meta-commentary.
- Name real people, companies, places, dates, and events — the video system finds footage from your words automatically.
- Use exact brand/product names — never a generic word when the topic names a specific company or product.

RETENTION SPINE — every script follows this arc:
HOOK → SETUP → COMPLICATION → REVELATION → CONSEQUENCE → CTA

1. HOOK (first 5–15 seconds) — two-part structure in one flow:
   (a) Pattern interrupt: surprising fact, bold contrast, or high-stakes question.
   (b) Retention bridge: stakes (lives, money, reputation, history) + why the viewer must keep watching.
   Line 1 MUST deliver on the title promise. Never open with "Today we're going to…", "In this video…", "Welcome back", "Let's dive in", or "Without further ado".

2. SETUP: Central question + stakes. Open the MACRO LOOP — the one big question only resolved at the end.

3. COMPLICATION: Resistance, paradox, hidden mechanism. Stakes rise. Close a micro-loop, open a bigger one.

4. REVELATION (~60–70% of the video): The value bomb — strongest insight, reframing fact, or reversal. This prevents mid-video drop-off.

5. CONSEQUENCE: What the revelation means today. Resolve the macro loop with one memorable takeaway.

6. CTA: One forward-looking sentence tied to what they just learned — not generic "like and subscribe".
   Whenever possible, callback the opening hook's image, question, or phrase so the ending
   pays off the exact promise the hook opened — the viewer should feel the loop close, not
   just receive a new closing thought.

LOOP ORCHESTRATION:
- MACRO LOOP: The video's spine — the packaging promise (e.g. "How did this really happen?").
- MID LOOPS: One per major section — escalating tension, stated as a claim ("What they hid would cost them everything.").
- MICRO LOOPS: Every 3–5 sentences — "But here's the catch", partial reveals, a sharp contrast.
- Rule: close a loop partially → immediately open a new one. Never resolve everything at once.
- Rule: every section ends with a BRIDGE teasing the next, written as a statement ("But the real cost was still to come.") — never as a question.
- Rule: at most ONE question in the whole script — the hook may ask it. Every other line is a statement the viewer can see.

PATTERN INTERRUPTS (rotate every 45–90 seconds):
- A specific number ($, %, year, count) — concrete, not vague.
- A named person, company, place, or event (full name on first mention).
- A reversal ("Everyone assumed X. They were wrong.").
- A contrast or "But here's what nobody tells you" beat.

WRITING CRAFT:
- Short punchy sentences mixed with longer explanatory ones. Never write more than two
  consecutive sentences of the same length or rhythm — vary sentence openers (not every
  sentence starts with "The" or the subject's name) so the read doesn't fall into a
  monotone, machine-generated cadence.
- Conversational authority — smart friend who did the research, not a professor.
- If the topic is about a named person, use their full name in the hook — never vague "he/she" without context.
- Forbidden filler: "In this section", "As we mentioned", "Moving on", "Interestingly enough".
- Every sentence must create curiosity, deliver value, or advance the story — otherwise cut it.

ANTI-CLICHÉ RULES — these phrases are overused AI/stock-documentary tells. Never use them:
"In a world where", "Little did they/he/she know", "The rest, as they say, is history",
"And it changed everything", "History would remember this moment", "It was a turning point",
"The stage was set", "As fate would have it", "This is the story of", "But there's more to
the story than meets the eye", "At the end of the day", "When all was said and done", "It
makes you wonder", "One thing is clear", "The numbers don't lie", "In the blink of an eye",
"Little did anyone expect", "Only time will tell", "And the rest is history". Also avoid
overusing the "It's not just X, it's Y" contrast formula — use it at most once per script.

LANGUAGE:
- Write all spoken narration in English unless the user explicitly asks for another language (e.g. Dutch, German).`;
}

export type ScriptOutline = {
  title: string;
  hook: string;
  sections: { title: string; keyPoints: string[]; narrativeRole?: string }[];
  cta: string;
};

/** True if spoken narration still reflects the user's topic (guards broken length-refine). */
export function scriptStillOnTopic(topicPrompt: string, script: string): boolean {
  // RONDE 88A: both sides folded. A topic of "Der Führerbunker" tokenised to ["hrerbunker"]
  // against an unfolded narration, found no hit, and reported a perfectly on-topic script as off.
  const narration = foldSearchText(extractFullNarrationText(script));
  const topic = foldSearchText(topicPrompt).trim();
  if (!topic || !narration) return false;

  // ascii-safe: `topic` is already folded above, so nothing non-ASCII reaches this class.
  const tokens = topic
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
  /** VIDEO 623 — the same rule for every name; the list of eight names it used to add is gone. */
  return tokens.some((t) => narration.includes(t));
}

export function buildScriptLengthRefinePrompt(
  script: string,
  budget: ScriptLengthBudget,
  currentWords: number,
  topicPrompt: string
): string {
  const direction = currentWords < budget.minWords ? "EXPAND" : "TRIM";
  return `${direction} the documentary script below to hit the length budget.

TOPIC (mandatory — do NOT change subject; every sentence must stay about this):
"${topicPrompt}"

Current: ~${currentWords} spoken words. Required: ${budget.minWords}–${budget.maxWords} words (target ${budget.targetWords}).
Spoken duration target: ${budget.targetSpokenSec} seconds at ${NARRATION_WPM} WPM.

Rules:
- Revise ONLY the script in SCRIPT TO REVISE — same facts, people, companies, and story as that draft.
- Never replace the topic with a different story (no unrelated art, celebrities, or viral tangents).
- Keep HOOK → sections → CTA structure and all ## headings.
- Preserve retention mechanics: macro loop, mid-loops, bridges between sections, value bomb near 60–70%, pattern interrupts. Bridges stay statements; add no questions.
- Remove any [VISUAL: ...] tags — narration only.
- ${direction === "EXPAND" ? "Add substance: another fact, contrast, micro-hook, or named entity — not padding or filler phrases." : "Cut redundancy only — keep hooks, loops, bridges, and the narrative arc intact."}
- Return the FULL revised script only (markdown).

SCRIPT TO REVISE:
---
${script}
---`;
}
