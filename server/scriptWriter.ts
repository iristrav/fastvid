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
  "8-10": 540,
  "10-15": 750,
  "15-20": 1050,
};

const LENGTH_LABELS: Record<VideoLength, string> = {
  "1": "1 minute",
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

  const sectionCount =
    videoLength === "1" ? 2
      : videoLength === "8-10" ? 6
        : videoLength === "10-15" ? 7
          : 8;

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
- MID LOOPS: One per major section — escalating questions ("What did they hide?" / "Will it survive?").
- MICRO LOOPS: Every 3–5 sentences — rhetorical questions, "But here's the catch", partial reveals.
- Rule: close a loop partially → immediately open a new one. Never resolve everything at once.
- Rule: every section ends with a BRIDGE teasing the next ("But that raises an even stranger question…").

PATTERN INTERRUPTS (rotate every 45–90 seconds):
- A specific number ($, %, year, count) — concrete, not vague.
- A named person, company, place, or event (full name on first mention).
- A rhetorical question or reversal ("Everyone assumed X. They were wrong.").
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
- Preserve retention mechanics: macro loop, mid-loops, bridges between sections, value bomb near 60–70%, pattern interrupts.
- Remove any [VISUAL: ...] tags — narration only.
- ${direction === "EXPAND" ? "Add substance: another fact, contrast, micro-hook, or named entity — not padding or filler phrases." : "Cut redundancy only — keep hooks, loops, bridges, and the narrative arc intact."}
- Return the FULL revised script only (markdown).

SCRIPT TO REVISE:
---
${script}
---`;
}
