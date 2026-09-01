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
import { invokeLLM, isLlmPreflightRefusal, isLlmProviderUnavailable } from "./_core/llm";
import { imageMimeToDataUrl, prepareImageForVision } from "./archiveClipFilter";
import { lookupVerdict, persistVerdict } from "./beatRelevanceVerdictStore";

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
  /**
   * RONDE 119: which provider actually produced this verdict.
   *
   * The chain can move past two providers before one answers, and a log line that names only the
   * verdict cannot say whether the picture editor on duty was Gemini or OpenAI — which is exactly
   * the question a render with an exhausted Groq raises. Absent on a cached or unknown verdict:
   * no provider produced those.
   */
  provider?: string;
};

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

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

/**
 * Judgements per beat before the pipeline stops asking and takes what it has.
 *
 * ── RONDE 175 — why this moved from 2 to 4 ───────────────────────────────────────────────────
 *
 * The gate works. Render 555 measured it:
 *
 *     beat image gate — attempts=50 answered=50 (fits=13 does_not_fit=37) never_asked=38
 *
 * Three quarters of what it saw did not belong under the narration, and it said so. What it did
 * not get was a look: a beat downloads six candidates and only the first two were ever asked. If
 * candidate four was the right picture, the question never reached it, and the beat fell through
 * to a rescue route or a placeholder holding a picture nobody had approved.
 *
 * Two is not a quality setting, it is a budget. Raising it spends LLM calls to buy the one thing
 * this pipeline cannot get any other way — a real answer to "does this picture belong under this
 * sentence" — on candidates that are already downloaded and already paid for.
 *
 * Overridable, and see maxBeatImageJudgementsPerRender below: raising THIS without raising THAT
 * would not add looks, it would move the starvation from inside a beat to the end of the render.
 */
export const MAX_JUDGEMENTS_PER_BEAT = envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12);

/**
 * Render-wide ceiling, so a pathological render cannot spend without bound.
 *
 * ── RONDE 175 — raised with the per-beat budget, and why it had to be ────────────────────────
 *
 * At 60, a 19-beat render allows barely three judgements per beat before the ceiling is reached —
 * and the ceiling is spent in beat order, so the early beats would take four each and the last
 * beats would get none at all. Raising MAX_JUDGEMENTS_PER_BEAT alone does not buy more looks; it
 * moves the starvation from inside a beat to the end of the render, where it is harder to see and
 * lands on whichever beats happen to be last.
 *
 * 120 covers 19 beats × 4 with room for the routes that judge before adoption. The YouTube share
 * below deliberately does NOT move with it, so every added call goes to the funnel — the route the
 * adopted clips actually come from (RONDE 61).
 */
export function maxBeatImageJudgementsPerRender(): number {
  return envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500);
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
   * RONDE 115 — why the gate produced no verdict, counted by reason.
   *
   * The reason was already returned to the caller and logged per clip, but a render that could
   * not get a single verdict prints forty-four separate lines and no total, so the ONE fact that
   * matters — they all say the same thing — is the one nobody could see. Keyed by the message so
   * a summary can say "44x LLM API key is not configured" in a single line.
   */
  noVerdictReasons: Map<string, number>;
  /**
   * RONDE 119 — which provider gave each verdict, counted.
   *
   * One line at the end of a render answers "who was actually judging the pictures". Before this,
   * a render that fell through from Groq to Gemini to OpenAI looked identical in the summary to
   * one where the first provider answered everything.
   */
  verdictsByProvider: Map<string, number>;
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
   *
   * RONDE 104 — this map is render-scoped; the VERDICTS in it are not.
   *
   * RONDE 58 made the whole gate state render-scoped so two concurrent renders could not read
   * each other's verdicts or spend each other's budget. The budget half of that is unchanged and
   * still matters: `judgementsUsed` belongs to one render and nothing else may draw on it.
   *
   * The verdict half was over-strict. "Does this picture belong under this sentence" is a fact
   * about a picture and a sentence — it does not depend on which render is asking, so isolating
   * it bought nothing and cost a re-render every answer it already owned. Verdicts now also go to
   * ./beatRelevanceVerdictStore, which is shared by every render and every replica. This map
   * stays as the render's own hot cache in front of it.
   */
  seen: Map<string, BeatImageJudgement>;
  /**
   * RONDE 105 — five counters that cannot be added up wrongly.
   *
   * There used to be three, and the middle one was a trap. `judgementsUsed` incremented on every
   * ATTEMPT and `judgementsFailed` incremented again when that attempt came back unusable, so a
   * render where the model answered nothing reported used=44 failed=44 — and the quality report
   * printed "44 of 88 could not be fetched", which reads as half. It was all of them. A whole
   * render was assembled with no picture editor and the summary said the gate was doing fine.
   *
   * The fix is not a better sentence, it is counters that partition. The invariant is exact and
   * `judgementTally` asserts it:
   *
   *     judgementAttempts === judgementsFits + judgementsMismatch + judgementsFailed
   *
   * so "how many real answers did we get" is a subtraction that cannot be got wrong, and an
   * attempt is never mistakable for a success.
   */
  judgementAttempts: number;
  /** The model looked and said the picture belongs. The only outcome that is good news. */
  judgementsFits: number;
  /** The model looked and said it does not belong. An answer — just not the one we wanted. */
  judgementsMismatch: number;
  /**
   * RONDE 67: attempts the model could not answer — a 429, a timeout, a malformed reply.
   *
   * Render 533 logged 16 `Gemini API error 429` and 5 `groq 400 Bad Request` while this gate was
   * refusing 34 clips, and nothing in the quality report told the two apart. "The gate looked and
   * said no" and "the gate could not look" lead to opposite conclusions — the first means the
   * sourcing is wrong, the second means the verdicts are noise — and they were being read as one.
   */
  judgementsFailed: number;
  /**
   * RONDE 103: asks this gate declined to even attempt — the render budget was spent, the
   * per-beat ceiling was reached, there was no readable frame, no narration, or the gate is off.
   *
   * Deliberately NOT folded into `judgementsFailed`. "We asked and got nothing back" and "we
   * never asked" have different causes and different fixes, and RONDE 105 keeps them apart in
   * every place the render reports on itself.
   */
  judgementsSkipped: number;
  /** Of the attempts, how many went to YouTube candidates — capped separately. */
  youtubeJudgementsUsed: number;
};

export function createBeatImageGateState(): BeatImageGateState {
  return {
    seen: new Map(),
    judgementAttempts: 0,
    judgementsFits: 0,
    judgementsMismatch: 0,
    judgementsFailed: 0,
    judgementsSkipped: 0,
    youtubeJudgementsUsed: 0,
    noVerdictReasons: new Map(),
    verdictsByProvider: new Map(),
  };
}

/** What the gate actually managed to decide, with the partition made explicit. */
export type JudgementTally = {
  attempts: number;
  fits: number;
  mismatch: number;
  failed: number;
  skipped: number;
  /** attempts - failed. A real answer, whichever way it went. */
  answered: number;
  /** True when the counters do not partition — a bug in the gate, reported rather than hidden. */
  inconsistent: boolean;
};

/**
 * Read the counters as one coherent set.
 *
 * Every consumer goes through this rather than adding fields together at the call site, because
 * adding fields together at the call site is exactly how "44 of 88" happened.
 */
export function judgementTally(state: BeatImageGateState): JudgementTally {
  const { judgementAttempts: attempts, judgementsFits: fits } = state;
  const { judgementsMismatch: mismatch, judgementsFailed: failed, judgementsSkipped: skipped } = state;
  return {
    attempts,
    fits,
    mismatch,
    failed,
    skipped,
    answered: attempts - failed,
    inconsistent: attempts !== fits + mismatch + failed,
  };
}

/**
 * RONDE 175 §3 — what this beat is established to be about, in the judge's own question.
 *
 * The prompt carried the documentary title, the scene paragraph and the narration line, and left
 * the judge to infer the subject and the period from prose. The pipeline already KNOWS them: the
 * subject resolver names the person or place, and the query contract carries the verified years
 * and places. None of it reached the question.
 *
 * That matters because of how this prompt ends — "when you genuinely cannot tell, say it belongs".
 * The tie-break is deliberately permissive, so a vague question does not merely produce a vague
 * answer, it produces an ALLOW. Naming the subject and the period is how the judge stops having to
 * guess at what it is checking against.
 *
 * Every field is optional and every field is something the pipeline verified. Nothing is invented
 * here: an empty anchor prints nothing rather than a placeholder the model could reason from.
 */
export type BeatSubjectAnchors = {
  /**
   * The resolved subject of THIS beat, e.g. "Hermann Göring".
   *
   * Beat-level. Only set when the subject resolver actually named one, so a beat that names
   * nothing prints nothing rather than borrowing the video's subject and telling the judge that
   * this shot is meant to show it.
   */
  subject?: string;
  /**
   * The period the DOCUMENTARY is set in, e.g. "1930s-1940s".
   *
   * Video-level, and labelled as such in the prompt. Presenting it as the beat's own period would
   * be a misattribution: a WWII documentary can legitimately cut to a 1919 shot, and telling the
   * judge the narration places THIS shot in the 1940s would make it refuse a correct picture.
   */
  documentaryPeriod?: string;
  /** Places established for the DOCUMENTARY. Video-level, same caveat as the period. */
  documentaryPlaces?: string[];
};

/**
 * The anchor lines, each labelled with the scope it actually has.
 *
 * The wording matters more than it looks. "The narration places it in 1943" is a claim about this
 * sentence; "the documentary is set in the 1930s-1940s" is a claim about the film. Saying the
 * second in the words of the first would turn a legitimate cutaway into a refusal.
 */
function formatAnchors(anchors: BeatSubjectAnchors | undefined): string[] {
  if (!anchors) return [];
  const lines: string[] = [];
  const subject = anchors.subject?.trim();
  if (subject) lines.push(`This shot is meant to show: ${subject}`);
  const period = anchors.documentaryPeriod?.trim();
  if (period) lines.push(`The documentary is set in: ${period} (the film, not necessarily this shot)`);
  const places = (anchors.documentaryPlaces ?? []).map((p) => p.trim()).filter(Boolean);
  if (places.length > 0) {
    lines.push(`Places this documentary is about: ${places.slice(0, 3).join(", ")}`);
  }
  return lines;
}

function buildPrompt(
  beatText: string,
  frameCount: number,
  videoTitle?: string,
  sceneText?: string,
  anchors?: BeatSubjectAnchors
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
    ...formatAnchors(anchors),
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
  /** RONDE 175 §3: the subject, years and places the pipeline already established for this beat. */
  anchors?: BeatSubjectAnchors;
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
  const unknown = (reason: string): BeatImageJudgement => {
    // RONDE 115: every route out of here without a verdict is counted by its reason, so a render
    // that got none can say WHY in one line instead of forty-four identical ones.
    state.noVerdictReasons.set(reason, (state.noVerdictReasons.get(reason) ?? 0) + 1);
    return { verdict: "unknown", depicts: "", reason };
  };
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
  if (!beatText?.trim()) return declined("no narration to judge against");

  /**
   * RONDE 104 — ask the durable store before spending anything.
   *
   * The render-scoped map above only knows what THIS render has already asked. The store knows
   * what any render ever asked about this exact (picture, narration) pair, which is the same
   * question with the same answer. Checked BEFORE the budget so a re-render of a script does not
   * exhaust its sixty judgements re-earning verdicts it already owns — a hit costs nothing, and
   * refusing to read it would only make the render blinder for no saving at all.
   *
   * A store that is absent, disabled or broken returns null, which is indistinguishable from a
   * miss. It can make the gate cheaper; it can never make it decide differently.
   */
  const stored = await lookupVerdict(seenKey).catch(() => null);
  if (stored) {
    const fromStore: BeatImageJudgement = {
      verdict: stored.verdict,
      depicts: stored.depicts,
      reason: stored.reason,
      cached: true,
    };
    state.seen.set(seenKey, { verdict: stored.verdict, depicts: stored.depicts, reason: stored.reason });
    return fromStore;
  }

  if (state.judgementAttempts >= maxBeatImageJudgementsPerRender()) {
    return declined("render judgement budget spent");
  }

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

  state.judgementAttempts++;
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
                text: buildPrompt(beatText, dataUrls.length, videoTitle, sceneText, params.anchors),
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

    const provider = response.provider;
    const judgement: BeatImageJudgement = {
      verdict: parsed.belongs ? "fits" : "does_not_fit",
      depicts: (parsed.depicts ?? "").slice(0, 160),
      reason: (parsed.reason ?? "").slice(0, 160),
      ...(provider ? { provider } : {}),
    };
    // RONDE 119: the provider that answered is counted here, at the one point where a verdict is
    // known to have come off the wire rather than out of a cache.
    if (provider) {
      state.verdictsByProvider.set(provider, (state.verdictsByProvider.get(provider) ?? 0) + 1);
    }
    // RONDE 105: an answer is recorded as the answer it was. `does_not_fit` is a successful
    // judgement with an unwelcome result, not a failure — conflating the two is how a render
    // whose sourcing is wrong reads the same as a render whose model is down.
    if (judgement.verdict === "fits") state.judgementsFits++;
    else state.judgementsMismatch++;
    state.seen.set(seenKey, judgement);
    /**
     * RONDE 104: only a real answer is written down. `unknown` means the gate could not get one,
     * and persisting that would turn a provider hiccup into a permanent silence for this pair.
     * Fire-and-forget: this render already has its verdict, and a failed write must cost it
     * nothing.
     */
    if (judgement.verdict !== "unknown") {
      void persistVerdict(seenKey, judgement.verdict, judgement.depicts, judgement.reason).catch(
        () => undefined
      );
    }
    return judgement;
  } catch (err) {
    /**
     * RONDE 115 — a question that was never asked is not a question that failed.
     *
     * invokeLLM refuses before it opens a socket when no provider key is configured, when every
     * provider is in cooldown or quota-exhausted, or when the daily spend budget is already
     * spent. `judgementAttempts` was incremented above, before the call, so all three landed here
     * and were counted as `judgementsFailed` — and the render summary then read
     *
     *     attempts=44 answered=0 unavailable=44
     *
     * which says "the model was asked forty-four times and could not answer once": a model
     * outage. The actual condition can be that no provider was ever contacted at all. Those two
     * need entirely different work, and reporting the second as the first is how a whole line of
     * investigation goes to the wrong place.
     *
     * RONDE 105 built this partition for exactly this distinction and put a bucket in it for
     * "the gate never asked". A pre-flight refusal belongs in that bucket, so the attempt is
     * taken back and the judgement is recorded as never asked. The invariant
     * `attempts === fits + mismatch + failed` holds either way.
     *
     * The OUTCOME is unchanged: still `unknown`, still fail-open, never `fits`.
     */
    if (isLlmPreflightRefusal(err)) {
      state.judgementAttempts--;
      return declined(`gate could not ask: ${(err as Error).message?.slice(0, 90)}`);
    }
    /**
     * RONDE 119 — a provider with no capacity did not judge the picture badly. It did not judge.
     *
     * From production:
     *
     *   LLM invoke failed (groq, model=openai/gpt-oss-20b): 429 … on tokens per day (TPD):
     *   Limit 200000, Used 199683, Requested 3630.
     *
     * That reached a provider, so it is not the pre-flight case above — and it landed here, in
     * `judgementsFailed`, where it read as "the vision model was asked and could not answer".
     * The account was simply out of tokens for the day; no model looked at any frame.
     *
     * The two need opposite work — one is a model or prompt problem, the other is a quota or
     * routing problem — so this takes the attempt back and books it on the never-judged side,
     * with its own reason so it can never be confused with a missing key either. `judgementsFailed`
     * now means what it says: a provider answered and the judgement itself failed.
     */
    if (isLlmProviderUnavailable(err)) {
      state.judgementAttempts--;
      return declined(`provider unavailable (no capacity): ${(err as Error).message?.slice(0, 90)}`);
    }
    // Fail open, always. A model outage must not be able to empty a montage — but it is counted,
    // so a render whose verdicts were mostly unobtainable can say so.
    state.judgementsFailed++;
    return unknown(`judgement failed: ${(err as Error).message?.slice(0, 80)}`);
  }
}

/**
 * RONDE 115 — the single line that says why a render got no verdicts.
 *
 * Sorted by how often each reason occurred and capped, because the useful signal in a render with
 * forty-four failures is that forty-four of them say the same thing.
 */
export function formatNoVerdictReasons(state: BeatImageGateState, max = 3): string {
  const rows = [...state.noVerdictReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  if (rows.length === 0) return "";
  return `[BeatImageGate] no verdict: ${rows.map(([r, n]) => `${n}x ${r}`).join(" | ")}`;
}

/**
 * RONDE 119 — the single line that says who did the judging.
 *
 * With a provider chain that silently falls through, "the gate returned 40 verdicts" leaves open
 * whether they came from the model this render was configured to use or from the second fallback
 * behind it. That is not a detail: the providers are different models with different judgement,
 * and a render that quietly ran on the last one in the chain should say so.
 */
export function formatVerdictProviders(state: BeatImageGateState): string {
  const rows = [...state.verdictsByProvider.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return "";
  return `[BeatImageGate] verdicts by provider: ${rows.map(([p, n]) => `${n}x ${p}`).join(" | ")}`;
}
