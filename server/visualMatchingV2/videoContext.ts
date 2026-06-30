/** Visual Matching Engine V2 — VideoContext layer.
 *  Built once per video (1 LLM call), cached by topic so videos sharing a subject/era
 *  reuse the same context for zero extra LLM calls. Not yet wired into the active
 *  pipeline — gated by visualMatchingV2ContextEnabled() in sourcingPolicy.ts. */

import { createHash } from "crypto";
import { invokeLLM } from "../_core/llm";
import { createVisualContextCache, getVisualContextCacheByTopicHash } from "../db";
import { logVideoContext, timedStep } from "./logging";
import type { VideoContext } from "./types";

function hashTopic(topic: string): string {
  return createHash("sha256").update(topic.trim().toLowerCase()).digest("hex").slice(0, 32);
}

const VIDEO_CONTEXT_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "video_context",
    strict: true,
    schema: {
      type: "object",
      properties: {
        era: { type: "string" },
        setting: { type: "string" },
        keySubjects: { type: "array", items: { type: "string" } },
        recurringLocations: { type: "array", items: { type: "string" } },
        visualStyleNotes: { type: "string" },
      },
      required: ["era", "setting", "keySubjects", "recurringLocations", "visualStyleNotes"],
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

/** Builds (or reuses a cached) VideoContext for the given video/topic. Pure read/build —
 *  does not mutate or get consumed by the active pipeline at this stage. */
export async function buildVideoContext(videoId: string, topic: string): Promise<VideoContext> {
  const topicHash = hashTopic(topic);

  return timedStep("buildVideoContext", async () => {
    try {
      const cached = await getVisualContextCacheByTopicHash(topicHash);
      if (cached) {
        const data = cached.contextJson as Omit<VideoContext, "videoId" | "topicHash" | "cacheHit">;
        logVideoContext("cache_hit", { videoId, topicHash });
        return { videoId, topicHash, cacheHit: true, ...data };
      }
    } catch (err) {
      logVideoContext("error", { videoId, topicHash, stage: "cache_read", error: (err as Error).message });
    }

    logVideoContext("cache_miss", { videoId, topicHash });

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a documentary editor's research assistant. Given a video topic, summarize the " +
            "historical/visual context once so it can be reused for every beat in this video, without " +
            "re-deriving it per scene. era: time period the content covers. setting: general location/political " +
            "context. keySubjects: notable people/things central to this topic. recurringLocations: places likely " +
            "to recur across beats. visualStyleNotes: how footage should look (e.g. black-and-white archival, " +
            "color modern stock).",
        },
        { role: "user", content: `Video topic: ${topic.slice(0, 2000)}` },
      ],
      response_format: VIDEO_CONTEXT_SCHEMA,
      maxTokens: 800,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("buildVideoContext: empty LLM response");
    const parsed = parseJson<Omit<VideoContext, "videoId" | "topicHash" | "cacheHit">>(
      content,
      "VideoContext JSON"
    );

    try {
      await createVisualContextCache({ topicHash, contextJson: parsed });
    } catch (err) {
      logVideoContext("error", { videoId, topicHash, stage: "cache_write", error: (err as Error).message });
    }

    logVideoContext("built", { videoId, topicHash });
    return { videoId, topicHash, cacheHit: false, ...parsed };
  });
}
