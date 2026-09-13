/**
 * CAN THE PICTURE EDITOR BE REACHED AT ALL — ASKED BEFORE THE RENDER, NOT AFTER IT.
 *
 * ── What render 580 cost ────────────────────────────────────────────────────────────────────
 *
 *     [Pipeline] Stage 4 (compose): 3 scenes in 3788.7s
 *     [BeatImageGate] no verdict: 219x gate could not ask: No vision-capable provider is
 *                     available | 7x provider unavailable (gemini 403) | 4x timeout
 *     [Video Generation] Error: Render rejected — the picture editor was unreachable
 *
 * Sixty-three minutes of rendering to discover a condition that was already true when the render
 * started. Every one of those 228 declines had the same cause, and the first one knew it.
 *
 * ── Why a configuration check would not have caught it ──────────────────────────────────────
 *
 * `GEMINI_API_KEY` was set. The chain builder would have included Gemini, because it checks for a
 * key and a cooldown, not for permission. The 403 PERMISSION_DENIED — "project has been denied
 * access" — exists only in the answer to a real call. So this probe makes one: a single tiny image
 * put to the same `invokeLLM` the gate itself uses, over the same provider chain, with the same
 * Groq exclusion applied by the same code.
 *
 * That is the point of doing it this way rather than re-deriving availability here. A second
 * opinion about which providers are usable would drift from the first, and a preflight that
 * disagrees with the thing it is protecting is worse than none.
 *
 * ── What it costs, and what it refuses to do ────────────────────────────────────────────────
 *
 * One call, a handful of tokens on a 1×1 image at `detail: "low"`, bounded by its own timeout. It
 * asks nothing about the render's content and reads no frames from it.
 *
 * It does NOT decide whether a render may ship. That remains `assertVisionCoverageExportGate`,
 * which knows something this cannot: whether real footage actually reached a beat with no verdict.
 * This only answers "is there a judge", early, so an operator is not told after an hour.
 *
 * And it never reports a key. Only whether a judge answered, which provider answered, and — when
 * none did — the provider's own reason, which is exactly what the failing render already printed.
 */
import { invokeLLM } from "./_core/llm";

/**
 * A 1×1 transparent PNG.
 *
 * The smallest thing that is still an image: every provider that accepts vision accepts this, and
 * a probe that needed a real frame would have to wait for the render to produce one — which is the
 * hour this exists to save.
 */
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type VisionJudgeReachability = {
  reachable: boolean;
  /** Which provider answered. Absent when none did. */
  provider?: string;
  /** The provider's own words when nothing answered — never a key, never a configuration dump. */
  reason?: string;
};

/** Long enough for a cold provider, short enough that a dead one does not delay the render. */
export const VISION_PROBE_TIMEOUT_MS = 20_000;

/**
 * Put one trivial image to the picture editor and see whether anything answers.
 *
 * Never throws: a probe that could fail a render by failing itself would be a new way to lose a
 * video, which is the opposite of why it exists. Every failure comes back as `reachable: false`
 * with the reason attached.
 */
export async function probeVisionJudge(
  timeoutMs = VISION_PROBE_TIMEOUT_MS
): Promise<VisionJudgeReachability> {
  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Reply with the single word: ok" },
              { type: "image_url" as const, image_url: { url: PROBE_IMAGE, detail: "low" as const } },
            ],
          },
        ],
        maxTokens: 5,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`vision probe timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    const answered = typeof response.choices?.[0]?.message?.content === "string";
    if (!answered) {
      return { reachable: false, reason: "a provider was reached but returned no content" };
    }
    return { reachable: true, provider: response.provider ?? "unknown" };
  } catch (err) {
    /**
     * The message is the provider's own — "No vision-capable provider is available: Groq is
     * excluded from image calls…", "gemini 403", a timeout. Truncated because a provider can
     * return a page of HTML, and never inspected for secrets because it is an error string the
     * failing render already printed verbatim.
     */
    const reason = (err as Error)?.message?.slice(0, 300) ?? String(err).slice(0, 300);
    return { reachable: false, reason };
  }
}

/**
 * What to tell the operator, in the words the export gate would have used an hour later.
 *
 * Deliberately the same two remedies and the same warning about the escape hatch: two different
 * sentences for one condition is how an operator ends up fixing the wrong thing.
 */
export function formatVisionJudgeUnreachable(result: VisionJudgeReachability): string {
  return (
    `Render not started — the picture editor cannot be reached, so every beat would be judged by ` +
    `nobody and the export gate would refuse the finished film. ` +
    `${result.reason ?? "No provider answered."} ` +
    `Restore a vision provider (OpenAI credit, or a Gemini key whose project is not denied) and ` +
    `re-render; set ENABLE_BEAT_IMAGE_RELEVANCE_GATE=false only if you accept unjudged footage.`
  );
}
