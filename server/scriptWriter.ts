/**
 * Professional documentary script generation with length budgets tied to video duration.
 * Targets spoken narration length (WPM) so VO matches chosen video length.
 */

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

const SPOKEN_SECONDS: Record<string, number> = {
  "1": 58,
  "2": 118,
  "5-8": 390,
  "8-12": 600,
  "12-15": 810,
  "15-20": 1050,
  "20+": 1200,
};

const LENGTH_LABELS: Record<string, string> = {
  "1": "1 minute",
  "2": "2 minutes",
  "5-8": "5–8 minutes",
  "8-12": "8–12 minutes",
  "12-15": "12–15 minutes",
  "15-20": "15–20 minutes",
  "20+": "20+ minutes",
};

export function getScriptLengthBudget(videoLength: string): ScriptLengthBudget {
  const targetSpokenSec = SPOKEN_SECONDS[videoLength] ?? 1050;
  const targetWords = Math.round((targetSpokenSec / 60) * NARRATION_WPM);
  const minWords = Math.round(targetWords * 0.9);
  const maxWords = Math.round(targetWords * 1.1);
  const targetChars = Math.round(targetWords * 5.6);
  const minChars = Math.round(targetChars * 0.9);
  const maxChars = Math.round(targetChars * 1.1);

  const sectionCount =
    videoLength === "1" ? 2
      : videoLength === "2" ? 3
        : videoLength === "5-8" ? 5
          : videoLength === "8-12" ? 6
            : videoLength === "12-15" ? 7
              : videoLength === "15-20" ? 8
                : 9;

  const hookWords =
    videoLength === "1" ? 28
      : videoLength === "2" ? 42
        : videoLength === "5-8" ? 55
          : 70;
  const ctaWords = videoLength === "1" ? 18 : videoLength === "2" ? 22 : 28;

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

function wordsPerSection(budget: ScriptLengthBudget, sectionIndex: number, sectionTotal: number): number {
  const bodyWords = budget.targetWords - budget.hookWords - budget.ctaWords;
  const base = Math.floor(bodyWords / sectionTotal);
  const extra = bodyWords % sectionTotal;
  return base + (sectionIndex < extra ? 1 : 0);
}

function sectionNarrativeBrief(index: number, total: number, videoLength: string): string {
  if (index === 0) {
    return `BEGINNING (Act 1 — Setup): Ground the viewer in the topic. Make them care immediately. No "welcome" or "in this video".`;
  }
  if (index === total - 1) {
    return `END (Act 3 — Payoff): Deliver the clearest takeaway. Resolve the tension from the middle. Leave a memorable final image in the mind.`;
  }
  if (index === 1 && total >= 3) {
    return `EARLY MIDDLE (Act 2A — Escalation): Introduce the core conflict, paradox, or hidden mechanism. Use a specific fact or contrast.`;
  }
  if (index === Math.floor(total / 2)) {
    return `MIDDLE PEAK (Act 2B — Retention spike): The "why it matters" beat. Pattern interrupt — question, reversal, or number that reframes everything.`;
  }
  return `MIDDLE (Act 2 — Momentum): Keep curiosity high. Partial answers, then new stakes. ${videoLength === "5-8" || videoLength === "8-12" ? "Micro-hook every 3–4 sentences." : "No filler."}`;
}

export function buildScriptWriterSystemPrompt(videoType: string): string {
  const typeInstructions: Record<string, string> = {
    documentary:
      "Format: premium YouTube documentary (Vox, Wendover, Johnny Harris). Research-backed, cinematic narration.",
    listicle:
      "Format: ranked listicle — each beat must feel like a reveal, not a lecture.",
    tutorial:
      "Format: tutorial — clarity first, but still use story beats (problem → steps → result).",
    explainer:
      "Format: explainer — analogies and visual metaphors, but with a narrative spine.",
  };
  const typeInstruction = typeInstructions[videoType] ?? typeInstructions.documentary;

  return `You are an elite YouTube scriptwriter and retention editor. ${typeInstruction}

NON-NEGOTIABLE CRAFT RULES:
- Write ONLY spoken narration (plus [VISUAL: ...] tags). No stage directions, no bullet lists in the body.
- Structure every video as: HOOK → BEGINNING → MIDDLE (with rising tension) → END → CTA.
- HOOK (first seconds): pattern interrupt — surprising fact, bold contrast, or high-stakes question. Never "Today we're going to talk about..."
- MIDDLE: open loops early, close them later; use micro-hooks (rhetorical questions, "But here's the catch", specific numbers, named entities).
- END: one crisp insight the viewer remembers tomorrow.
- Tone: authoritative, vivid, conversational — short punchy sentences mixed with longer explanatory ones.
- Every 2–3 sentences add [VISUAL: ...] with LITERAL, SPECIFIC real-world footage (real brands, places, people when relevant).
- Never use filler: "In this section", "Let's dive in", "Without further ado".
- Write for the ear — the script will be read aloud in one continuous voice-over.`;
}

export function buildOutlineUserPrompt(
  prompt: string,
  videoType: string,
  budget: ScriptLengthBudget
): string {
  return `Topic: "${prompt}"
Video length: ${budget.label} (${budget.targetSpokenSec}s spoken narration target)
Format: ${videoType}

SCRIPT BUDGET (entire video narration, excluding [VISUAL] tags):
- Target: ${budget.targetWords} words (${budget.minWords}–${budget.maxWords} acceptable)
- ~${budget.targetChars} characters of narration (${budget.minChars}–${budget.maxChars})

NARRATIVE ARC (professional retention structure):
1. hook — stops the scroll in under 5 seconds
2. ${budget.sectionCount} body sections mapped to Beginning → Middle (escalation) → End
3. cta — one sentence, forward-looking

Respond with JSON:
{
  "title": "specific, compelling title",
  "hook": "opening narration (${budget.hookWords} words, ${budget.hookWords - 5}–${budget.hookWords + 8} words) — pure spoken script, no labels",
  "sections": EXACTLY ${budget.sectionCount} items, each {
    "title": "section headline",
    "keyPoints": ["2-4 concrete facts or beats to cover"],
    "narrativeRole": "beginning" | "middle" | "middle_peak" | "end"
  },
  "cta": "closing line (${budget.ctaWords} words max)"
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

  const visualCount =
    budget.videoLength === "1" ? 2
      : budget.videoLength === "2" ? 5
        : Math.max(4, Math.ceil(wordTarget / 45));

  return `Video: "${title}" (topic: ${prompt})
Section ${sectionIndex + 1} of ${sectionTotal}: "${sec.title}"
${narrative}
Cover these beats: ${sec.keyPoints.join("; ")}

WORD COUNT (spoken narration only, excluding [VISUAL] tags):
Write EXACTLY ${minW}–${maxW} words (target ${wordTarget}). This section is part of a ${budget.targetWords}-word video — do NOT go short.

Include exactly ${visualCount} [VISUAL: ...] tags — literal footage descriptions matching the sentence before each tag.
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
  const sections =
    budget.sectionCount === 2
      ? "## Act 1 — Setup\n…\n\n## Act 2 — Payoff\n…"
      : "## Act 1 — Setup\n…\n\n## Act 2 — Escalation\n…\n\n## Act 3 — Payoff\n…";
  const brandRule = isMuskTopic
    ? "Use exact names (Tesla Model 3, SpaceX Falcon 9, Gigafactory) — never generic car/rocket."
    : "Use exact real names (people, companies, places) from the topic — never generic stock where a brand is named.";

  return `Topic: "${prompt}"
Video length: ${budget.label} (~${budget.targetSpokenSec}s spoken VO)
Format: ${videoType}

Write the COMPLETE narration script in one pass (markdown).

STRUCTURE (required headings):
# Compelling title
## Opening
Hook narration (${budget.hookWords} words) — pattern interrupt, no "welcome" or "in this video"
[VISUAL: literal opening footage for this topic]
${sections}
## CALL TO ACTION
${budget.ctaWords} words max — forward-looking single beat
[VISUAL: cinematic closing b-roll for the topic]

WORD BUDGET (spoken words only, excluding [VISUAL] tags):
${budget.minWords}–${budget.maxWords} words (target ${budget.targetWords})
Include ${budget.videoLength === "1" ? "6–8" : "12–18"} [VISUAL: ...] tags — specific real-world footage per beat.
${brandRule}

Return ONLY the markdown script.`;
}

export function buildScriptLengthRefinePrompt(
  script: string,
  budget: ScriptLengthBudget,
  currentWords: number
): string {
  const direction = currentWords < budget.minWords ? "EXPAND" : "TRIM";
  return `${direction} this documentary narration to hit the length budget.

Current: ~${currentWords} spoken words. Required: ${budget.minWords}–${budget.maxWords} words (target ${budget.targetWords}).
Spoken duration target: ${budget.targetSpokenSec} seconds at ${NARRATION_WPM} WPM.

Rules:
- Keep HOOK → sections → CTA structure and all ## headings.
- Keep every [VISUAL: ...] tag; add more if expanding.
- ${direction === "EXPAND" ? "Add substance: another fact, contrast, or micro-hook — not padding." : "Cut redundancy only — keep retention beats and the narrative arc."}
- Return the FULL revised script only (markdown).`;
}
