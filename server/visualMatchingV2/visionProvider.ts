/** Visual Matching Engine V2 — VisionProvider interface + default OpenAI implementation.
 *
 *  Mirrors the EmbeddingProvider interface pattern (embeddings/types.ts): the scorer and
 *  prompt builder depend only on VisionProvider, never on a concrete LLM vendor —
 *  swapping to Anthropic/Gemini/Groq later means writing one new class and changing which
 *  provider is wired up, with zero changes to llmVisionScorer.ts or visionPromptBuilder.ts.
 *
 *  The provider knows about HTTP/JSON but nothing about VisualIntent, candidates, or the
 *  scoring schema. It receives a pre-built prompt and returns parsed JSON. */
import { invokeLLM } from "../_core/llm";
import type { VisionScores } from "./types";

export type VisionImageInput = {
  /** Stable id to correlate a result row back to a CandidateAsset. */
  candidateId: string;
  /** base64 data URL ("data:image/jpeg;base64,...") or https:// URL (for providers that
   *  accept remote URLs). The prompt builder decides format; the provider uses it as-is. */
  imageUrl: string;
};

export type VisionScoringRequest = {
  /** System prompt — provider-agnostic. Produced by visionPromptBuilder.ts. */
  systemPrompt: string;
  /** User-turn text portion of the prompt. Produced by visionPromptBuilder.ts. */
  userPrompt: string;
  /** Candidate images in display order. The prompt tells the LLM which index maps to
   *  which candidateId, so the provider doesn't need to understand the scoring schema. */
  images: VisionImageInput[];
  /** JSON schema object for structured output; shape matches VisionScoringResponse. */
  responseSchema: Record<string, unknown>;
  maxTokens: number;
};

export type VisionScoringResponse = {
  scores: Record<string, VisionScores>;
  promptTokens: number;
  completionTokens: number;
  modelUsed: string;
};

export interface VisionProvider {
  /** Stable model identifier used as part of the vision cache key. */
  readonly modelId: string;
  scoreImages(request: VisionScoringRequest): Promise<VisionScoringResponse>;
}

// ─── OpenAI Vision implementation ─────────────────────────────────────────────

const OPENAI_VISION_MODEL = "gpt-4o-mini";

type RawScoreEntry = {
  candidateId?: string;
  subjectMatch?: number;
  actionMatch?: number;
  historicalAccuracy?: number;
  contextMatch?: number;
  locationMatch?: number;
  emotionMatch?: number;
  overallScore?: number;
  reasoning?: string;
};

type RawScoringPayload = {
  candidates?: RawScoreEntry[];
};

function parseVisionScores(raw: RawScoreEntry): VisionScores {
  const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(typeof v === "number" ? v : 0)));
  return {
    subjectMatch: clamp(raw.subjectMatch),
    actionMatch: clamp(raw.actionMatch),
    historicalAccuracy: clamp(raw.historicalAccuracy),
    contextMatch: clamp(raw.contextMatch),
    locationMatch: clamp(raw.locationMatch),
    emotionMatch: clamp(raw.emotionMatch),
    overallScore: clamp(raw.overallScore),
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning.slice(0, 400) : "",
  };
}

export class OpenAIVisionProvider implements VisionProvider {
  readonly modelId: string;

  constructor(modelId: string = OPENAI_VISION_MODEL) {
    this.modelId = modelId;
  }

  async scoreImages(request: VisionScoringRequest): Promise<VisionScoringResponse> {
    const userContent = [
      { type: "text" as const, text: request.userPrompt },
      ...request.images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img.imageUrl, detail: "low" as const },
      })),
    ];

    const result = await invokeLLM({
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "vision_candidate_scores",
          strict: true,
          schema: request.responseSchema,
        },
      },
      maxTokens: request.maxTokens,
    });

    const content = result.choices[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAIVisionProvider: response content is not a string");
    }

    const payload = JSON.parse(content) as RawScoringPayload;
    if (!Array.isArray(payload.candidates)) {
      throw new Error("OpenAIVisionProvider: response missing 'candidates' array");
    }

    const scores: Record<string, VisionScores> = {};
    for (const entry of payload.candidates) {
      if (typeof entry.candidateId === "string") {
        scores[entry.candidateId] = parseVisionScores(entry);
      }
    }

    return {
      scores,
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
      modelUsed: result.model ?? this.modelId,
    };
  }
}
