/** Visual Matching Engine V2 — Vision Prompt Builder.
 *
 *  Single responsibility: construct the system + user prompts for one LLM Vision scoring
 *  call (one beat, up to 5 candidates). The scorer (llmVisionScorer.ts) knows no prompt
 *  strings — all text is produced here so prompt changes only touch this file and
 *  automatically invalidate the cache via the bumped PROMPT_VERSION constant.
 *
 *  Deliberately receives ONLY VisualIntent and VideoContext — no retrieval scores, no
 *  ranking signals, no candidate metadata other than what the LLM needs to judge the
 *  image visually. The LLM must not be able to "cheat" by reading embeddingSimilarity or
 *  clipSimilarity fields through the prompt. */
import type { VideoContext, VisualIntent } from "./types";
import type { VisionImageInput } from "./visionProvider";

/** Bump this string whenever the prompt text or schema changes so the cache key changes
 *  and old entries are never served against a new prompt. */
export const PROMPT_VERSION = "vision-v1";

/** JSON schema for structured output — passed verbatim to the VisionProvider's
 *  responseSchema field, which wires it into the provider's response_format parameter. */
export const VISION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          subjectMatch: { type: "number" },
          actionMatch: { type: "number" },
          historicalAccuracy: { type: "number" },
          contextMatch: { type: "number" },
          locationMatch: { type: "number" },
          emotionMatch: { type: "number" },
          overallScore: { type: "number" },
          reasoning: { type: "string" },
        },
        required: [
          "candidateId",
          "subjectMatch",
          "actionMatch",
          "historicalAccuracy",
          "contextMatch",
          "locationMatch",
          "emotionMatch",
          "overallScore",
          "reasoning",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

export type BuiltVisionPrompt = {
  systemPrompt: string;
  userPrompt: string;
  promptVersion: string;
  responseSchema: Record<string, unknown>;
  maxTokens: number;
};

/** Per-image label the LLM uses to correlate its response back to a candidateId without
 *  embedding the full (potentially opaque) candidateId in the visible prompt text. */
function imageLabel(index: number): string {
  return `Image ${index + 1}`;
}

export function buildVisionPrompt(
  intent: VisualIntent,
  context: VideoContext | null,
  images: VisionImageInput[]
): BuiltVisionPrompt {
  const systemPrompt = `You are a documentary visual editor scoring candidate images for a specific narration beat.

Your task: score each image on how well it visually illustrates the beat's intent. Judge ONLY what you see in the image — do not infer from filenames, IDs, or any metadata. Score every dimension 0–100.

Scoring dimensions:
- subjectMatch: does the image show the correct subject (person, object, scene)?
- actionMatch: does the image show the right action or moment?
- historicalAccuracy: does the image match the described era, technology, style, clothing?
- contextMatch: does the overall visual context (composition, mood, framing) fit the beat?
- locationMatch: does the setting or environment match the described location?
- emotionMatch: does the image convey the right emotional tone?
- overallScore: weighted synthesis of all dimensions for this beat.
- reasoning: one sentence max explaining the most decisive factor.

Return JSON following the schema exactly. Use the provided candidateId values unchanged.`;

  const contextLine = context
    ? `Era: ${context.era}. Setting: ${context.setting}. Visual style: ${context.visualStyleNotes}.`
    : "";

  const imageList = images
    .map((img, i) => `  ${imageLabel(i)}: candidateId="${img.candidateId}"`)
    .join("\n");

  const userPrompt = `Beat to illustrate:
Subject: ${intent.visualSubject}
Action: ${intent.visualAction}
Location: ${intent.visualLocation}
Time/Era: ${intent.visualTime}
Historical context: ${intent.historicalContext}
Emotion: ${intent.emotion}
Visual description: ${intent.visualDescription}${contextLine ? `\n\nBroader video context:\n${contextLine}` : ""}

Candidates (${images.length} image${images.length === 1 ? "" : "s"} attached in order):
${imageList}

Score every candidate. Return a JSON object with a "candidates" array, one entry per image, using the candidateId values listed above.`;

  return {
    systemPrompt,
    userPrompt,
    promptVersion: PROMPT_VERSION,
    responseSchema: VISION_RESPONSE_SCHEMA,
    maxTokens: 60 * images.length + 80,
  };
}
