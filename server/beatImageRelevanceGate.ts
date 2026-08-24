/**
 * RONDE 58 — look at the picture and say whether it belongs.
 *
 * Everything the pipeline used before this judged an image without seeing it:
 *
 *   · the provider's title, matched word-for-word against the video's words. That cannot
 *     separate "Ruins of a bombed city" (right) from "white-lives-matter-montana-sticker"
 *     (wrong) — neither shares a word with "Hitler", and one of them is exactly the shot the
 *     video needs.
 *   · the CLIP image-text similarity, which for this material is not merely weak but inverted.
 *     Render 531 measured, on the same beat:
 *
 *         white-lives-matter-montana-sticker    0.2226   wrong
 *         faces-of-ancient-europe-1-500-a.d     0.2225   wrong
 *         Signed Photograph of Adolf Hitler     0.2116   right, scores LOWER
 *         Bundesarchiv Bild 183-1989-0322       0.2077   right, scores LOWEST
 *
 *     Tightening that threshold deletes the Hitler photograph and keeps the sticker.
 *
 * So this asks a vision model what is actually in the frame and whether that belongs in a
 * documentary saying this sentence. It is the only judge in the pipeline that has seen the
 * image and understood the narration at the same time.
 *
 * ── Cost and safety ──────────────────────────────────────────────────────────────────────────
 *
 * This runs on the clip a beat is about to ADOPT, not on every candidate — one call per beat in
 * the ordinary case, and never more than MAX_JUDGEMENTS_PER_BEAT even when it keeps saying no.
 * A render-wide ceiling bounds the worst case. Verdicts are cached by content identity, so the
 * same clip reappearing on a later beat is free.
 *
 * It fails OPEN in every direction: no frame, no API key, a timeout, a malformed answer, the
 * budget spent — all of them return "unknown", which adopts the clip exactly as before. A model
 * outage must never be able to empty a montage; the worst this gate can do when it breaks is
 * leave the pipeline no worse than it was.
 */

import fs from "fs";
import { invokeLLM } from "./_core/llm";
import { imageMimeToDataUrl, prepareImageForVision } from "./archiveClipFilter";

export type BeatImageVerdict = "fits" | "does_not_fit" | "unknown";

export type BeatImageJudgement = {
  verdict: BeatImageVerdict;
  /** What the model says is in the frame — logged so a wrong verdict is diagnosable. */
  depicts: string;
  reason: string;
};

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "beat_image_relevance",
    strict: true,
    schema: {
      type: "object",
      properties: {
        depicts: { type: "string" },
        belongs: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["depicts", "belongs", "reason"],
      additionalProperties: false,
    },
  },
};

/** Judgements per beat before the pipeline stops asking and takes what it has. */
export const MAX_JUDGEMENTS_PER_BEAT = 2;

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Render-wide ceiling, so a pathological render cannot spend without bound. */
export function maxBeatImageJudgementsPerRender(): number {
  return envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 60, 0, 500);
}

export function beatImageRelevanceGateEnabled(): boolean {
  return process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false";
}

/**
 * Per-render state. Held by the caller rather than module-level so two concurrent renders cannot
 * spend each other's budget or read each other's verdicts.
 */
export type BeatImageGateState = {
  /** contentKey -> verdict, so the same clip is judged once per render. */
  seen: Map<string, BeatImageJudgement>;
  judgementsUsed: number;
};

export function createBeatImageGateState(): BeatImageGateState {
  return { seen: new Map(), judgementsUsed: 0 };
}

function buildPrompt(beatText: string, videoTitle?: string, sceneText?: string): string {
  return [
    "You are the picture editor on a documentary. You are shown one frame from a clip that is",
    "about to be cut under a line of narration. Decide whether this image belongs there.",
    "",
    videoTitle ? `Documentary: "${videoTitle}"` : "",
    sceneText && sceneText !== beatText ? `Scene: "${sceneText.slice(0, 300)}"` : "",
    `Narration for this shot: "${beatText.slice(0, 300)}"`,
    "",
    "First say plainly what the frame shows — the subject, the period it looks like, and any",
    "text or graphics visible in it.",
    "",
    "Then decide. It BELONGS when a viewer would accept it under this narration: the subject, the",
    "place or the period fits, or it is honest atmospheric footage of the right era and setting.",
    "Archive material with no caption still belongs if what it shows fits.",
    "",
    "It DOES NOT belong when the frame is plainly about something else — a different subject,",
    "a different century, a different country with nothing to do with the story, modern footage",
    "under historical narration, a logo, a title card, a screenshot of a webpage or a person",
    "talking to camera about an unrelated topic.",
    "",
    "Judge the picture, not its file name. When you genuinely cannot tell, say it belongs.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Judges one frame. Never throws.
 *
 * `contentKey` identifies the clip's content (not its path) so a clip renamed or re-trimmed
 * between beats is recognised as already judged.
 */
export async function judgeBeatImage(params: {
  framePath: string;
  beatText: string;
  videoTitle?: string;
  sceneText?: string;
  contentKey: string;
  state: BeatImageGateState;
  timeoutMs?: number;
}): Promise<BeatImageJudgement> {
  const { framePath, beatText, videoTitle, sceneText, contentKey, state } = params;
  const unknown = (reason: string): BeatImageJudgement => ({ verdict: "unknown", depicts: "", reason });

  if (!beatImageRelevanceGateEnabled()) return unknown("gate disabled");
  const cached = state.seen.get(contentKey);
  if (cached) return cached;
  if (state.judgementsUsed >= maxBeatImageJudgementsPerRender()) {
    return unknown("render judgement budget spent");
  }
  if (!beatText?.trim()) return unknown("no narration to judge against");
  if (!framePath || !fs.existsSync(framePath)) return unknown("no frame available");

  let dataUrl: string;
  try {
    const raw = fs.readFileSync(framePath);
    const prepared = await prepareImageForVision(raw, "image/jpeg");
    if (!prepared) return unknown("frame not usable as an image");
    dataUrl = imageMimeToDataUrl(prepared.buffer, prepared.mimeType);
  } catch (err) {
    return unknown(`frame unreadable: ${(err as Error).message?.slice(0, 60)}`);
  }

  state.judgementsUsed++;
  const timeoutMs = params.timeoutMs ?? 12_000;
  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You judge whether a single frame belongs under a line of documentary narration. " +
              "Return only JSON matching the schema.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt(beatText, videoTitle, sceneText) },
              // "low" detail: enough to recognise subject, period and on-screen text, at a
              // fraction of the tokens a full-resolution read would cost.
              { type: "image_url" as const, image_url: { url: dataUrl, detail: "low" as const } },
            ],
          },
        ],
        response_format: RESPONSE_SCHEMA,
        maxTokens: 200,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("beat image relevance timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return unknown("no answer");
    const parsed = JSON.parse(content) as { depicts?: string; belongs?: boolean; reason?: string };
    if (typeof parsed.belongs !== "boolean") return unknown("answer had no verdict");

    const judgement: BeatImageJudgement = {
      verdict: parsed.belongs ? "fits" : "does_not_fit",
      depicts: (parsed.depicts ?? "").slice(0, 160),
      reason: (parsed.reason ?? "").slice(0, 160),
    };
    state.seen.set(contentKey, judgement);
    return judgement;
  } catch (err) {
    // Fail open, always. A model outage must not be able to empty a montage.
    return unknown(`judgement failed: ${(err as Error).message?.slice(0, 80)}`);
  }
}
