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
  /**
   * RONDE 103: true when this verdict was read back from `state.seen` rather than earned by a
   * call. Logging it is not cosmetic — a log line that says `fits` without saying `cached=true`
   * cannot be told apart from a fresh look, and that is exactly how a stale verdict hides.
   */
  cached?: boolean;
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

/**
 * RONDE 61: how much of that ceiling YouTube may take.
 *
 * Render 532 spent 52 of its 60 judgements on YouTube candidates and refused 48 of them, leaving
 * the funnel — the route the adopted clips actually come from — just 8. YouTube is judged BEFORE
 * a clip is accepted into the pool, so it burns calls on material that was never going to be
 * used; the funnel is judged on the clip about to go into the video. When the two compete for
 * one budget, the wrong one wins.
 */
export function maxYoutubeBeatImageJudgements(): number {
  return envInt("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS", 24, 0, 500);
}

export function beatImageRelevanceGateEnabled(): boolean {
  return process.env.ENABLE_BEAT_IMAGE_RELEVANCE_GATE !== "false";
}

/**
 * Per-render state. Held by the caller rather than module-level so two concurrent renders cannot
 * spend each other's budget or read each other's verdicts.
 */
export type BeatImageGateState = {
  /**
   * `contentKey|beatIdentity` -> verdict.
   *
   * RONDE 103 — this key used to be the contentKey alone, and that was wrong in the one way that
   * matters. The question this gate asks is "does THIS picture belong under THIS narration": the
   * prompt is built from the beat's own text, the scene's text and the documentary title. Keying
   * the answer on the picture alone means the first beat to look at a clip decides for every
   * later beat, so a clip that genuinely fits "Berlin, April 1945" comes back as `fits` on a beat
   * about a boardroom in 2019 — never re-examined, and logged as though it had been.
   *
   * See `beatIdentityKey` in ./beatVisualRelevance for what the second half is derived from and
   * why it is the narration rather than the beat's position.
   */
  seen: Map<string, BeatImageJudgement>;
  judgementsUsed: number;
  /** Of those, how many went to YouTube candidates — capped separately. */
  youtubeJudgementsUsed: number;
  /**
   * RONDE 67: how many judgements the model could not deliver — a 429, a timeout, a malformed
   * answer, a refused image.
   *
   * Render 533 logged 16 `Gemini API error 429` and 5 `groq 400 Bad Request` while this gate was
   * refusing 34 clips, and nothing in the quality report told the two apart. "The gate looked and
   * said no" and "the gate could not look" lead to opposite conclusions — the first means the
   * sourcing is wrong, the second means the verdicts are noise — and they were being read as one.
   */
  judgementsFailed: number;
  /**
   * RONDE 103: asks this gate declined to even attempt — the render budget was spent, there was
   * no readable frame, no narration, or the gate is switched off.
   *
   * These were invisible before. `judgementsUsed` counts calls that were made and
   * `judgementsFailed` counts calls that came back unusable, so a render that spent its budget on
   * scene 0 and then adopted forty unexamined clips reported "60 judged, 0 unavailable" — a
   * perfect score for a render where most of the timeline was never looked at. Counting the
   * declines is what lets the end-of-render summary say so.
   */
  judgementsSkipped: number;
};

export function createBeatImageGateState(): BeatImageGateState {
  return {
    seen: new Map(),
    judgementsUsed: 0,
    youtubeJudgementsUsed: 0,
    judgementsFailed: 0,
    judgementsSkipped: 0,
  };
}

function buildPrompt(
  beatText: string,
  frameCount: number,
  videoTitle?: string,
  sceneText?: string
): string {
  const many = frameCount > 1;
  return [
    "You are the picture editor on a documentary. You are shown " +
      (many
        ? `${frameCount} frames sampled in order from across one clip`
        : "one frame from a clip") +
      " that is about to be cut under a line of narration. Decide whether this belongs there.",
    many
      ? "The frames are from the SAME clip at different moments — a long source can change shot" +
        " part-way through, so judge what is on screen across all of them, not one instant."
      : "",
    "",
    videoTitle ? `Documentary: "${videoTitle}"` : "",
    sceneText && sceneText !== beatText ? `Scene: "${sceneText.slice(0, 300)}"` : "",
    `Narration for this shot: "${beatText.slice(0, 300)}"`,
    "",
    many
      ? "First say plainly what the clip shows — the subject, the period it looks like, any text" +
        " or graphics visible in it, and whether the frames show the same thing or change."
      : "First say plainly what the frame shows — the subject, the period it looks like, and any" +
        " text or graphics visible in it.",
    "",
    "Then decide. It BELONGS when a viewer would accept it under this narration: the subject, the",
    "place or the period fits, or it is honest atmospheric footage of the right era and setting.",
    "Archive material with no caption still belongs if what it shows fits.",
    "",
    "It DOES NOT belong when the frame is plainly about something else — a different subject,",
    "a different century, a different country with nothing to do with the story, modern footage",
    "under historical narration, a logo, a title card, a screenshot of a webpage or a person",
    "talking to camera about an unrelated topic.",
    many
      ? "If most of what is on screen is a title card, a leader or a countdown rather than actual" +
        " footage, it does not belong: the viewer would be looking at text, not at the story."
      : "",
    "",
    "Judge the picture, not its file name. When you genuinely cannot tell, say it belongs.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Judges a clip from one or more frames sampled across it. Never throws.
 *
 * RONDE 59: a single frame is not a clip. A 272-second archive source cut down to three and a
 * half seconds can still change shot inside that cut, and the frame that happens to sit at 45%
 * is not necessarily what the viewer sees. Several frames from across the clip mean the verdict
 * covers all of what will be on screen. Frames that cannot be read are simply left out; only
 * when NONE are readable does the gate fall back to "unknown".
 *
 * `contentKey` identifies the clip's content (not its path) so a clip renamed or re-trimmed
 * between beats is recognised as already judged.
 */
export async function judgeBeatImage(params: {
  /** Frames sampled across the clip, in order. A single-element array is a single frame. */
  framePaths: string[];
  beatText: string;
  videoTitle?: string;
  sceneText?: string;
  contentKey: string;
  /**
   * RONDE 103 — identity of the narration this clip is being judged against. See
   * `beatIdentityKey` in ./beatVisualRelevance.
   *
   * Optional only so a caller that has genuinely no beat context (the YouTube pre-pool check
   * judges against a scene-level line) keeps working; such a caller gets its own bucket rather
   * than sharing one with every other beat.
   */
  beatIdentity?: string;
  state: BeatImageGateState;
  timeoutMs?: number;
}): Promise<BeatImageJudgement> {
  const { framePaths, beatText, videoTitle, sceneText, contentKey, state } = params;
  const unknown = (reason: string): BeatImageJudgement => ({ verdict: "unknown", depicts: "", reason });
  /** A decline: the gate never looked. Counted so the render summary cannot claim it did. */
  const declined = (reason: string): BeatImageJudgement => {
    state.judgementsSkipped++;
    return unknown(reason);
  };

  if (!beatImageRelevanceGateEnabled()) return declined("gate disabled");
  /**
   * The verdict belongs to a (picture, narration) pair, not to the picture. `beatIdentity` is
   * hashed from the beat's own words, so the same clip arriving on a different beat is a cache
   * MISS and gets looked at again — which is the entire point of the gate.
   */
  const seenKey = `${contentKey}|${params.beatIdentity ?? ""}`;
  const cached = state.seen.get(seenKey);
  if (cached) return { ...cached, cached: true };
  if (state.judgementsUsed >= maxBeatImageJudgementsPerRender()) {
    return declined("render judgement budget spent");
  }
  if (!beatText?.trim()) return declined("no narration to judge against");

  const usable = (framePaths ?? []).filter((p) => p && fs.existsSync(p));
  if (usable.length === 0) return declined("no frame available");

  const dataUrls: string[] = [];
  for (const framePath of usable) {
    try {
      const raw = fs.readFileSync(framePath);
      const prepared = await prepareImageForVision(raw, "image/jpeg");
      if (!prepared) continue;
      dataUrls.push(imageMimeToDataUrl(prepared.buffer, prepared.mimeType));
    } catch {
      // One unreadable frame does not sink the judgement — the others still describe the clip.
    }
  }
  if (dataUrls.length === 0) return declined("frames not usable as images");

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
              {
                type: "text",
                text: buildPrompt(beatText, dataUrls.length, videoTitle, sceneText),
              },
              // "low" detail: enough to recognise subject, period and on-screen text, at a
              // fraction of the tokens a full-resolution read would cost. That is what makes
              // three frames per clip affordable where one full-resolution read would not be.
              ...dataUrls.map((url) => ({
                type: "image_url" as const,
                image_url: { url, detail: "low" as const },
              })),
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
    if (typeof content !== "string") {
      state.judgementsFailed++;
      return unknown("no answer");
    }
    const parsed = JSON.parse(content) as { depicts?: string; belongs?: boolean; reason?: string };
    if (typeof parsed.belongs !== "boolean") {
      state.judgementsFailed++;
      return unknown("answer had no verdict");
    }

    const judgement: BeatImageJudgement = {
      verdict: parsed.belongs ? "fits" : "does_not_fit",
      depicts: (parsed.depicts ?? "").slice(0, 160),
      reason: (parsed.reason ?? "").slice(0, 160),
    };
    state.seen.set(seenKey, judgement);
    return judgement;
  } catch (err) {
    // Fail open, always. A model outage must not be able to empty a montage — but it is counted,
    // so a render whose verdicts were mostly unobtainable can say so.
    state.judgementsFailed++;
    return unknown(`judgement failed: ${(err as Error).message?.slice(0, 80)}`);
  }
}
