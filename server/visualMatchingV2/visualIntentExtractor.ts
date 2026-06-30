/** Visual Matching Engine V2 — VisualIntent Extractor.
 *  Batches all beats of one scene into a single LLM call, using the (cached) VideoContext
 *  as given context rather than re-deriving era/setting per beat. Each resulting intent is
 *  cached by content hash so an identical beat is never re-analyzed. Not wired into the
 *  active pipeline yet — gated by visualMatchingV2IntentEnabled() in sourcingPolicy.ts. */

import { createHash } from "crypto";
import { invokeLLM } from "../_core/llm";
import { createVisualIntentCache, getVisualIntentCacheByIntentHash } from "../db";
import { logVisualIntent, timedStep } from "./logging";
import type { VideoContext, VisualIntent } from "./types";

export type BeatInput = {
  beatId: string;
  spokenText: string;
};

function hashIntentInput(spokenText: string, contextHash: string): string {
  return createHash("sha256")
    .update(`${spokenText.trim().toLowerCase()}::${contextHash}`)
    .digest("hex")
    .slice(0, 32);
}

const VISUAL_INTENT_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "visual_intents",
    strict: true,
    schema: {
      type: "object",
      properties: {
        intents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              beatId: { type: "string" },
              visualSubject: { type: "string" },
              visualAction: { type: "string" },
              visualLocation: { type: "string" },
              visualTime: { type: "string" },
              historicalContext: { type: "string" },
              emotion: { type: "string" },
              visualDescription: { type: "string" },
              primaryKeyword: { type: "string" },
              secondaryKeyword: { type: "string" },
              negativeKeywords: { type: "array", items: { type: "string" } },
            },
            required: [
              "beatId", "visualSubject", "visualAction", "visualLocation", "visualTime",
              "historicalContext", "emotion", "visualDescription", "primaryKeyword",
              "secondaryKeyword", "negativeKeywords",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["intents"],
      additionalProperties: false,
    },
  },
};

function parseJson<T>(content: unknown, label: string): T {
  if (content && typeof content === "object") return content as T;
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}

/** Extracts a VisualIntent per beat for one scene, batched into a single LLM call for
 *  beats not already cached. Beats with a cache hit cost zero LLM tokens. */
export async function extractVisualIntentsForScene(
  beats: BeatInput[],
  videoContext: VideoContext
): Promise<VisualIntent[]> {
  return timedStep("extractVisualIntentsForScene", async () => {
    const results = new Map<string, VisualIntent>();
    const toGenerate: { beat: BeatInput; intentHash: string }[] = [];

    for (const beat of beats) {
      const intentHash = hashIntentInput(beat.spokenText, videoContext.topicHash);
      try {
        const cached = await getVisualIntentCacheByIntentHash(intentHash);
        if (cached) {
          const data = cached.intentJson as Omit<VisualIntent, "beatId" | "spokenText" | "intentHash" | "cacheHit">;
          results.set(beat.beatId, {
            beatId: beat.beatId,
            spokenText: beat.spokenText,
            intentHash,
            cacheHit: true,
            ...data,
          });
          logVisualIntent("cache_hit", { beatId: beat.beatId, intentHash });
          continue;
        }
      } catch (err) {
        logVisualIntent("error", { beatId: beat.beatId, stage: "cache_read", error: (err as Error).message });
      }
      toGenerate.push({ beat, intentHash });
    }

    if (toGenerate.length > 0) {
      logVisualIntent("cache_miss", { beatIds: toGenerate.map((g) => g.beat.beatId) });

      const response = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You are a documentary editor's research assistant. For each beat (one sentence of narration), " +
              "determine exactly what the viewer should see — not keywords, but the literal subject, action, " +
              "location, time, historical context, and emotion of the shot. Use the given video context " +
              "(era/setting/key subjects/locations) as established background — do not re-derive it, only specify " +
              "what is specific to this beat. primaryKeyword/secondaryKeyword are short search terms derived from " +
              "the visual description (not the spoken words). negativeKeywords are things the shot must NOT show.",
          },
          {
            role: "user",
            content:
              `Video context: era=${videoContext.era}; setting=${videoContext.setting}; ` +
              `keySubjects=${videoContext.keySubjects.join(", ")}; ` +
              `recurringLocations=${videoContext.recurringLocations.join(", ")}; ` +
              `visualStyleNotes=${videoContext.visualStyleNotes}\n\n` +
              `Beats:\n${toGenerate.map((g) => `[${g.beat.beatId}] ${g.beat.spokenText}`).join("\n")}`,
          },
        ],
        response_format: VISUAL_INTENT_SCHEMA,
        maxTokens: 4000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("extractVisualIntentsForScene: empty LLM response");
      const parsed = parseJson<{ intents: Array<Omit<VisualIntent, "spokenText" | "intentHash" | "cacheHit">> }>(
        content,
        "VisualIntent JSON"
      );

      const byBeatId = new Map(parsed.intents.map((i) => [i.beatId, i]));
      for (const { beat, intentHash } of toGenerate) {
        const intentData = byBeatId.get(beat.beatId);
        if (!intentData) {
          logVisualIntent("error", { beatId: beat.beatId, stage: "missing_from_response" });
          continue;
        }
        const { beatId: _beatId, ...rest } = intentData;
        const intent: VisualIntent = {
          beatId: beat.beatId,
          spokenText: beat.spokenText,
          intentHash,
          cacheHit: false,
          ...rest,
        };
        results.set(beat.beatId, intent);

        try {
          await createVisualIntentCache({ intentHash, intentJson: rest });
        } catch (err) {
          logVisualIntent("error", { beatId: beat.beatId, stage: "cache_write", error: (err as Error).message });
        }
        logVisualIntent("built", { beatId: beat.beatId, intentHash });
      }
    }

    return beats.map((b) => results.get(b.beatId)).filter((i): i is VisualIntent => Boolean(i));
  });
}
