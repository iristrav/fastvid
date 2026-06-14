/**
 * Professional documentary script generation with length budgets tied to video duration.
 * Targets spoken narration length (WPM) so VO matches chosen video length.
 */
import { normalizeVideoLength, type VideoLength } from "../shared/videoLengths";

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
const NARRATION_WPM = 145;

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

export function countNarrationChars(script: string): number {
  return script
    .replace(/\[visual:[^\]]*\]/gi, "")
    .replace(/^#+\s+.+$/gm, "")
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

export function countNarrationWords(script: string): number {
  const text = script
    .replace(/\[visual:[^\]]*\]/gi, "")
    .replace(/^#+\s+.+$/gm, "")
    .replace(/[#*_`~>]/g, "")
    .trim();
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Spoken narration only — one continuous read order (no duplicate hooks across scenes). */
export function extractFullNarrationText(script: string): string {
  const blocks = parseMarkdownNarrationBlocks(script);
  if (blocks.length > 0) {
    return blocks.map((b) => b.text).filter((t) => t.length > 0).join(" ");
  }
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
    const fallback = extractFullNarrationText(raw);
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

function wordsPerSection(budget: ScriptLengthBudget, sectionIndex: number, sectionTotal: number): number {
  const bodyWords = budget.targetWords - budget.hookWords - budget.ctaWords;
  const base = Math.floor(bodyWords / sectionTotal);
  const extra = bodyWords % sectionTotal;
  return base + (sectionIndex < extra ? 1 : 0);
}

function sectionNarrativeBrief(index: number, total: number, videoLength: string): string {
  const valueBombIndex = Math.max(1, Math.floor(total * 0.65));
  if (index === 0) {
    return `SETUP (Act 1): Establish the central question and stakes. Ground the viewer — make them care in the first beat. Open a mid-loop that pays off later. End with a bridge teasing what comes next.`;
  }
  if (index === total - 1) {
    return `CONSEQUENCE (Act 4 — Payoff): Resolve the macro loop. Show what the revelation means in the real world today. One crisp insight the viewer remembers tomorrow — not a summary list.`;
  }
  if (index === 1 && total >= 3) {
    return `COMPLICATION (Act 2A): Introduce resistance, paradox, or hidden mechanism. Things get harder — stakes rise. Close one micro-loop, open a bigger one.`;
  }
  if (index === valueBombIndex) {
    return `REVELATION (Value bomb — ~60–70% mark): The strongest insight in the video. Reframe everything with a specific fact, number, or reversal. This is the retention spike — make it unforgettable.`;
  }
  return `ESCALATION (Act 2 — Momentum): Partial payoffs only — answer one question, immediately raise a harder one. ${videoLength === "8-10" ? "Micro-hook every 3–4 sentences." : "Pattern interrupt every 45–90 seconds (number, name, question, or contrast)."} End the section with a bridge to the next beat.`;
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
- Use exact brand/product names — never generic "car" or "rocket" when Tesla or SpaceX exists.

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
- Short punchy sentences mixed with longer explanatory ones.
- Conversational authority — smart friend who did the research, not a professor.
- If the topic is about a named person, use their full name in the hook — never vague "he/she" without context.
- Forbidden filler: "In this section", "As we mentioned", "Moving on", "Interestingly enough".
- Every sentence must create curiosity, deliver value, or advance the story — otherwise cut it.`;
}

export function buildOutlineUserPrompt(
  prompt: string,
  videoType: string,
  budget: ScriptLengthBudget
): string {
  return `Topic: "${prompt}"
Video length: ${budget.label} (${budget.targetSpokenSec}s spoken narration target)
Format: ${videoType}

SCRIPT BUDGET (spoken narration only):
- Target: ${budget.targetWords} words (${budget.minWords}–${budget.maxWords} acceptable)
- ~${budget.targetChars} characters of narration (${budget.minChars}–${budget.maxChars})

TITLE & HOOK:
- Title: specific, curiosity-driven — the hook must deliver on it in line 1.
- Hook (${budget.hookWords} words): two-part — (1) pattern interrupt, (2) retention bridge with stakes + macro loop opened.
- Tease a near-term payoff within the first 60–90 seconds of the full video.

NARRATIVE ARC (4-beat documentary structure):
Map EXACTLY ${budget.sectionCount} body sections across:
  Setup → Complication → Revelation (value bomb at ~section ${Math.max(2, Math.ceil(budget.sectionCount * 0.65))}) → Consequence
Each section's keyPoints must include: concrete names, dates, or numbers + a bridge tease to the next section.
Assign narrativeRole: "setup" | "complication" | "revelation" | "consequence" | "middle" (for escalation beats between acts).

Respond with JSON:
{
  "title": "specific, compelling title that creates a curiosity gap",
  "hook": "full opening narration (${budget.hookWords - 5}–${budget.hookWords + 8} words) — pattern interrupt + retention bridge + macro loop, pure spoken text",
  "sections": EXACTLY ${budget.sectionCount} items, each {
    "title": "section headline",
    "keyPoints": ["2-4 concrete facts with names/dates/numbers", "include bridge tease to next section"],
    "narrativeRole": "setup" | "complication" | "revelation" | "consequence" | "middle"
  },
  "cta": "one forward-looking sentence (${budget.ctaWords} words max) tied to the story — not generic subscribe bait"
}`;
}

export const OUTLINE_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "video_outline",
    strict: true,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        hook: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              keyPoints: { type: "array", items: { type: "string" } },
              narrativeRole: { type: "string" },
            },
            required: ["title", "keyPoints", "narrativeRole"],
            additionalProperties: false,
          },
        },
        cta: { type: "string" },
      },
      required: ["title", "hook", "sections", "cta"],
      additionalProperties: false,
    },
  },
};

export type ScriptOutline = {
  title: string;
  hook: string;
  sections: { title: string; keyPoints: string[]; narrativeRole?: string }[];
  cta: string;
};

export function buildSectionUserPrompt(
  sec: { title: string; keyPoints: string[]; narrativeRole?: string },
  sectionIndex: number,
  sectionTotal: number,
  prompt: string,
  title: string,
  budget: ScriptLengthBudget,
  isMuskTopic: boolean
): string {
  const wordTarget = wordsPerSection(budget, sectionIndex, sectionTotal);
  const minW = Math.max(20, wordTarget - 12);
  const maxW = wordTarget + 15;
  const narrative = sec.narrativeRole
    ? `Narrative role from outline: ${sec.narrativeRole}.`
    : sectionNarrativeBrief(sectionIndex, sectionTotal, budget.videoLength);

  const brandRule = isMuskTopic
    ? "When mentioning vehicles or space, use exact names (Tesla Model 3, SpaceX Falcon 9, Gigafactory) — never generic 'car' or 'rocket'."
    : "Use exact real names (people, companies, places) whenever the topic includes them — never generic stock where a brand is named.";

  return `Video: "${title}" (topic: ${prompt})
Section ${sectionIndex + 1} of ${sectionTotal}: "${sec.title}"
${narrative}
Cover these beats: ${sec.keyPoints.join("; ")}

RETENTION RULES FOR THIS SECTION:
- Open or advance a mid-loop — the viewer must feel unfinished business.
- Include at least one pattern interrupt: a specific number, named entity, question, or reversal.
- Micro-hooks every 3–5 sentences ("But here's the catch…", "So why did nobody stop it?").
- End with a bridge teasing the next section (unless this is the final body section).
- Partial payoffs only — never resolve the macro loop until the consequence/end section.

WORD COUNT (spoken narration only):
Write EXACTLY ${minW}–${maxW} words (target ${wordTarget}). This section is part of a ${budget.targetWords}-word video — do NOT go short.

Do NOT add [VISUAL: ...] tags — footage is matched automatically from your spoken words.
${brandRule}
Do not repeat the hook. Start in medias res for this beat.`;
}

/** Single LLM call for 1–2 min videos (faster than outline + N sections). */
export function buildOneShotScriptUserPrompt(
  prompt: string,
  videoType: string,
  budget: ScriptLengthBudget,
  isMuskTopic: boolean
): string {
  const valueBombSection = Math.max(2, Math.ceil(budget.sectionCount * 0.65));
  const sections =
    budget.sectionCount === 2
      ? "## Setup\n…\n\n## Consequence\n…"
      : budget.sectionCount <= 3
        ? "## Setup\n…\n\n## Complication\n…\n\n## Consequence\n…"
        : `## Setup\n…\n\n## Complication\n…\n\n(middle escalation sections)\n\n## Revelation\n(value bomb — strongest insight, ~section ${valueBombSection})\n…\n\n## Consequence\n…`;
  const brandRule = isMuskTopic
    ? "Use exact names (Tesla Model 3, SpaceX Falcon 9, Gigafactory) — never generic car/rocket."
    : "Use exact real names (people, companies, places) from the topic — never generic stock where a brand is named.";

  return `Topic: "${prompt}"
Video length: ${budget.label} (~${budget.targetSpokenSec}s spoken VO)
Format: ${videoType}

Write the COMPLETE narration script in one pass (markdown).

STRUCTURE (required headings):
# Compelling title — curiosity gap, hook must deliver on it in line 1
## Opening
Two-part hook (${budget.hookWords} words): (1) pattern interrupt, (2) retention bridge with stakes + macro loop. No "welcome" or "in this video". Tease near-term payoff within 60–90s.
${sections}
## CALL TO ACTION
${budget.ctaWords} words max — one forward-looking sentence tied to the story

RETENTION RULES:
- Macro loop open until Consequence section — resolve with one memorable takeaway.
- Mid-loops per section, micro-hooks every 3–5 sentences.
- Pattern interrupt every 45–90 seconds (number, name, question, or contrast).
- Value bomb in Revelation section (~60–70% of script) — strongest reframing insight.
- Every section ends with a bridge to the next.
- Partial payoffs only in the middle — never resolve everything at once.

WORD BUDGET (spoken narration only):
${budget.minWords}–${budget.maxWords} words (target ${budget.targetWords})
No [VISUAL: ...] tags — the editor finds footage from narration automatically.
${brandRule}

Return ONLY the markdown script (narration + headings).`;
}

/** True if spoken narration still reflects the user's topic (guards broken length-refine). */
export function scriptStillOnTopic(topicPrompt: string, script: string): boolean {
  const narration = extractFullNarrationText(script).toLowerCase();
  const topic = topicPrompt.toLowerCase().trim();
  if (!topic || !narration) return false;

  const tokens = topic
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
  const hits = tokens.filter((t) => narration.includes(t));
  if (hits.length >= 1) return true;

  const shortAnchors = [
    "musk",
    "tesla",
    "spacex",
    "kylie",
    "jenner",
    "trump",
    "bezos",
    "zuckerberg",
  ];
  return shortAnchors.some((a) => topic.includes(a) && narration.includes(a));
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
