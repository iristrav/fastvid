/**
 * RONDE 129 — "it failed" was one word for six different situations.
 *
 * Two production lines, and the same missing distinction under both.
 *
 * ── A. Wikimedia kept being asked after it said stop ─────────────────────────────────────────
 *
 *     [Pipeline] Wikimedia imageinfo for scene 0: HTTP 429 Too Many Requests
 *                — counting as a provider failure
 *
 * "Counting as a provider failure" is exactly what happened, and it is the problem: the breaker
 * needs THREE consecutive failures before it stands down, and it counts a 429 the same as a
 * timeout or an empty result. A timeout is ambiguous — maybe the next one works. A 429 is not
 * ambiguous: the server has said, in words, that it is being asked too often. Waiting for two
 * more before believing it means sending two more requests into a server that already refused,
 * and because scenes are searched in parallel those two can be in flight before the first is
 * even counted.
 *
 * ── B. A cancelled render was retried three times ────────────────────────────────────────────
 *
 *     [Pipeline] Scene 4: fallback attempt 1 failed (transient) — retry 1/3 in 3.6s:
 *                Video generation cancelled
 *     [Pipeline] Scene 4: fallback attempt 1 failed (transient) — retry 2/3 in 7.1s:
 *                Video generation cancelled
 *
 * `throwIfVideoGenerationCancelled` throws `Error("Video generation cancelled")` when the render
 * has been cancelled. The retry loop calls every error "transient" unless it recognises fork
 * pressure, so it slept 4 seconds and asked again — for something that cannot possibly succeed,
 * because the cancel flag is still set and will stay set. Three sleeps and three guaranteed
 * failures per command variant, on a render that had already been told to stop.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * One place that answers "what kind of failure was that, and may we try again". It has no
 * imports: the callers pass in what they know. It creates no second retry engine — the existing
 * loops keep their own shape, their own limits and their own backoff, and simply ask this before
 * sleeping.
 */

/** What kind of failure this was. Named for what it means, not for what threw it. */
export type ProviderFailureKind =
  | "RETRYABLE"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PERMANENT"
  | "BUDGET_EXCEEDED";

/**
 * Was this a cancellation?
 *
 * Matched on the message because that is what `throwIfVideoGenerationCancelled` throws — a plain
 * Error with no marker on it. The wording is checked in two forms so a caller that wraps it
 * ("Aborted: … cancelled by the enclosing scene budget") is recognised too; both mean the same
 * thing here, which is that the work was called off and asking again cannot change that.
 */
export function isCancellationError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  return /video generation cancelled|cancelled by the enclosing|was cancelled|aborted:/i.test(msg);
}

/** Was this a deadline rather than a fault? */
export function isBudgetExhaustedError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  return /budget (exceeded|spent|exhausted)|deadline (exceeded|passed)|out of time/i.test(msg);
}

/**
 * RONDE 223 — was this file refused for being too big?
 *
 * `downloadToFileStreaming` refuses a response whose Content-Length is over the caller's cap,
 * before a single byte is transferred, and again from the running byte counter when the header
 * lied or was absent. Both are facts about the FILE, not about the moment: the same URL will be
 * exactly as large the next time it is asked for.
 *
 * Render 575 (rmtulyr50) asked 108 times anyway — one Pixabay asset, `Content-Length: 92216473`
 * against an 83886080 cap, 111 identical refusals in 164 seconds, roughly one every second and a
 * half — while the beat it was for ran out of time and the export gate then refused the scene for
 * having no usable footage.
 *
 * Matched on the message, for the same reason `isCancellationError` is: the throw site is a plain
 * Error, and a marker property would have to be threaded through a helper that several providers
 * share. Both spellings are covered — "exceeds" is the Content-Length refusal and "exceeded" the
 * streaming one.
 */
export function isOversizedResponseError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  return /response exceed(s|ed) maximum size of \d+ bytes/i.test(msg);
}

/**
 * Classify one failure.
 *
 * `status` is the HTTP status when there was one. A 429 is RATE_LIMITED whatever else is true of
 * it, because that classification is the whole point: it is the one failure the server itself
 * explained.
 */
export function classifyProviderFailure(params: {
  err?: unknown;
  status?: number;
}): ProviderFailureKind {
  const { status } = params;
  if (isCancellationError(params.err)) return "CANCELLED";
  if (isBudgetExhaustedError(params.err)) return "BUDGET_EXCEEDED";
  /**
   * Before the status checks: a size refusal is thrown by our own code after a perfectly good
   * 200, so the status says "fine" while the outcome is permanent.
   */
  if (isOversizedResponseError(params.err)) return "PERMANENT";

  if (typeof status === "number" && status > 0) {
    if (status === 429) return "RATE_LIMITED";
    // 401/403/404 will answer the same way however often they are asked.
    if (status === 401 || status === 403 || status === 404) return "PERMANENT";
    if (status >= 500) return "RETRYABLE";
    if (status >= 400) return "PERMANENT";
  }

  const msg = (params.err as { message?: string })?.message ?? String(params.err ?? "");
  if (/timed? ?out|etimedout|timeout/i.test(msg)) return "TIMEOUT";
  return "RETRYABLE";
}

/** Only these are worth asking again. */
export function isRetryableFailure(kind: ProviderFailureKind): boolean {
  return kind === "RETRYABLE" || kind === "TIMEOUT";
}

export type RetryDecision = {
  retry: boolean;
  reason:
    | "OK"
    | "NOT_RETRYABLE"
    | "ATTEMPTS_EXHAUSTED"
    | "INSUFFICIENT_BUDGET";
  kind: ProviderFailureKind;
};

/**
 * May this operation be tried again?
 *
 * Three questions, in the order that makes the cheapest one first:
 *
 *  1. is the failure the kind that could go away — a cancellation and a 403 cannot;
 *  2. are there attempts left;
 *  3. is there enough time left for the retry to finish. A retry that is going to be cut off by
 *     the render deadline costs its wait AND its work and delivers nothing, which is how a render
 *     that is already late makes itself later.
 *
 * `remainingBudgetMs` omitted means the caller does not track one; the budget question is then
 * skipped rather than guessed at.
 */
export function shouldRetryAfterFailure(params: {
  kind: ProviderFailureKind;
  attempt: number;
  maxAttempts: number;
  waitMs?: number;
  estimatedCostMs?: number;
  remainingBudgetMs?: number;
}): RetryDecision {
  const { kind, attempt, maxAttempts } = params;
  if (!isRetryableFailure(kind)) return { retry: false, reason: "NOT_RETRYABLE", kind };
  if (attempt + 1 >= maxAttempts) return { retry: false, reason: "ATTEMPTS_EXHAUSTED", kind };

  const remaining = params.remainingBudgetMs;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    const needed = (params.waitMs ?? 0) + (params.estimatedCostMs ?? 0);
    if (needed > remaining) return { retry: false, reason: "INSUFFICIENT_BUDGET", kind };
  }
  return { retry: true, reason: "OK", kind };
}

/** The line the pipeline logs when it decides NOT to retry. */
export function formatRetryGuard(params: {
  operation: string;
  attempt: number;
  maxAttempts: number;
  decision: RetryDecision;
  remainingBudgetMs?: number;
  estimatedCostMs?: number;
}): string {
  const { decision } = params;
  const budget =
    typeof params.remainingBudgetMs === "number"
      ? ` remainingBudget=${(params.remainingBudgetMs / 1000).toFixed(1)}s`
      : "";
  const cost =
    typeof params.estimatedCostMs === "number"
      ? ` estimatedCost=${(params.estimatedCostMs / 1000).toFixed(1)}s`
      : "";
  return (
    `[RetryGuard] ${params.operation} attempt=${params.attempt + 1}/${params.maxAttempts} ` +
    `failure=${decision.kind} retryable=${isRetryableFailure(decision.kind)}${budget}${cost} ` +
    `action=${decision.retry ? "RETRY" : "SKIP"} reason=${decision.reason}`
  );
}

/**
 * How long a provider should be left alone after one failure of this kind.
 *
 * Returns 0 for the kinds that carry no rate information — those keep the existing
 * three-strikes-then-cool-off behaviour, which is right for an ambiguous failure. A 429 is not
 * ambiguous and stands the provider down on the first one.
 *
 * `retryAfterSec` is honoured as a FLOOR when the server sent one, for the same reason as
 * RONDE 117: a provider's own hint is the minimum it will accept, not a promise about the next
 * request.
 */
export function cooldownMsForFailure(kind: ProviderFailureKind, retryAfterSec?: number | null): number {
  if (kind !== "RATE_LIMITED") return 0;
  const hintMs = Math.max(0, (retryAfterSec ?? 0) * 1000);
  const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
  return Math.max(hintMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS);
}

/** The line the pipeline logs when a provider is stood down. */
export function formatProviderCooldown(provider: string, kind: ProviderFailureKind, ms: number): string {
  return (
    `[ProviderCooldown] provider=${provider} reason=${kind} ` +
    `standing down for ${Math.round(ms / 1000)}s — other providers are unaffected`
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * RONDE 223 — A FILE THAT IS TOO BIG IS STILL TOO BIG THE SECOND TIME.
 *
 * `shouldRetryAfterFailure` above answers "ask again?" for ONE failure. It cannot help when the
 * same asset is re-offered by an outer loop that never saw the first refusal — and that is what
 * render 575 did: an inner loop of three attempts, wrapped by a candidate loop that handed the
 * same URL back thirty-six times over.
 *
 * So the refusal is remembered for the render. A URL refused for a PERMANENT reason is not asked
 * for again; the memo is cleared when the next render starts, exactly like the overlay budget, so
 * nothing is inherited across renders and a provider that fixes its file is asked afresh.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** url → why it was refused. Cleared per render. */
const permanentDownloadRefusals = new Map<string, string>();

/** How many repeat requests the memo has prevented this render — for the log, and for tests. */
let permanentRefusalsPrevented = 0;

/**
 * Record that this URL will never succeed this render.
 *
 * Keyed on the URL rather than on a provider or an asset id because the URL is the one identity
 * every download path already has in hand at the moment of failure.
 */
export function notePermanentDownloadRefusal(url: string, reason: string): void {
  if (!url) return;
  if (!permanentDownloadRefusals.has(url)) permanentDownloadRefusals.set(url, reason);
}

/**
 * The reason this URL was already refused, or null when it has not been.
 *
 * Every call that returns a reason is counted, because "how much work did this save" is the only
 * evidence that the memo is doing anything, and a silent optimisation is one nobody can check.
 */
export function permanentDownloadRefusal(url: string): string | null {
  const reason = permanentDownloadRefusals.get(url);
  if (reason === undefined) return null;
  permanentRefusalsPrevented++;
  return reason;
}

/** Start of a render: forget what the last one learned. */
export function resetPermanentDownloadRefusals(): void {
  permanentDownloadRefusals.clear();
  permanentRefusalsPrevented = 0;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * RONDE 235 — THE ONE DOWNLOAD ROUTE THE CHOKE POINT CANNOT SPEAK FOR.
 *
 * The memo above is written at exactly one place, `downloadToFileStreaming`, and RONDE 223 asserts
 * that count on purpose: a rule registered by N loops is the defect this codebase keeps removing.
 *
 * `downloadYouTubeCCClip` is the one route whose refusals cannot arrive there. Its most useful
 * "no" answers are decided BEFORE or AFTER any transfer — no mp4 format offered, no usable
 * metadata, bytes that would not trim — so no stream failure exists for the choke point to
 * classify. Render 576 is what that costs: twenty download slots spent on ten videos, every one
 * asked for roughly twice, because nothing between the calls remembered the first answer.
 *
 * So the YouTube route gets a named pair here, beside the memo, rather than its own call to it in
 * the pipeline. The pipeline keeps ONE writer of `notePermanentDownloadRefusal`; this file keeps
 * the rule about WHICH YouTube statuses are permanent, in one place, with the reasoning attached.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The three YouTube outcomes that are about the VIDEO rather than about the moment.
 *
 *   DOWNLOAD_UNSUPPORTED       no mp4 format, no usable metadata, past the size ceiling
 *   DOWNLOAD_EMPTY             the route answered with no video
 *   DOWNLOAD_INVALID_CONTENT   bytes arrived and would not trim
 *
 * The other four are excluded deliberately, and each exclusion is load-bearing:
 *
 *   DOWNLOAD_TIMEOUT       usually the scene budget standing a whole-video fetch aside — 75 of
 *                          render 576's 79 refusals came at literally 0s left. A later scene with
 *                          room may fetch the same video perfectly well, and writing it off here
 *                          would be a silent narrowing of retrieval.
 *   DOWNLOAD_FAILED        an HTTP status or an unclassified throw: ambiguous by definition, and
 *                          this memo is for PERMANENT reasons.
 *   DOWNLOAD_UNAVAILABLE   a fact about the deployment, not about the video — memoising it would
 *                          blacklist every video on the platform.
 *   DOWNLOAD_SUCCESS       nothing to remember.
 *
 * Plain strings rather than the `YoutubeDownloadStatus` union: that type lives in videoPipeline.ts,
 * which imports this module, and this module deliberately imports nothing from it.
 */
export const YOUTUBE_PERMANENT_DOWNLOAD_STATUSES: ReadonlySet<string> = new Set([
  "DOWNLOAD_UNSUPPORTED",
  "DOWNLOAD_EMPTY",
  "DOWNLOAD_INVALID_CONTENT",
]);

/** The memo key for a YouTube video, so the read and the write can never disagree about it. */
function youtubeRefusalKey(videoId: string): string {
  return `youtube_cc:${videoId}`;
}

/**
 * Remember a YouTube download refusal, when — and only when — it was about the video.
 *
 * Returns whether it was remembered, so a caller can log the distinction rather than guess at it.
 */
export function noteYoutubeDownloadRefusal(
  videoId: string,
  status: string | undefined,
  reason?: string
): boolean {
  if (!videoId || !status || !YOUTUBE_PERMANENT_DOWNLOAD_STATUSES.has(status)) return false;
  notePermanentDownloadRefusal(youtubeRefusalKey(videoId), `${status}${reason ? `:${reason}` : ""}`);
  return true;
}

/** Why this video was already written off this render, or null when it has not been. */
export function youtubeDownloadRefusal(videoId: string): string | null {
  if (!videoId) return null;
  return permanentDownloadRefusal(youtubeRefusalKey(videoId));
}

/** What the memo holds and what it saved — reported at the end of a render. */
export function permanentDownloadRefusalStats(): { refused: number; prevented: number } {
  return { refused: permanentDownloadRefusals.size, prevented: permanentRefusalsPrevented };
}

/** The line the render logs so the saving is visible rather than merely believed. */
export function formatPermanentDownloadRefusals(): string | null {
  const { refused, prevented } = permanentDownloadRefusalStats();
  if (refused === 0) return null;
  return (
    `[DownloadRefusals] ${refused} asset(s) refused for good this render, ` +
    `${prevented} repeat request(s) not made`
  );
}

/* ═══════════ what the yt-dlp service actually said, kept instead of thrown away ═══════════ */

/**
 * THE SERVICE EXPLAINS ITSELF AND THE CLIENT RECORDED A NUMBER.
 *
 * ── What was lost ───────────────────────────────────────────────────────────────────────────
 *
 * `services/ytdlp-download/main.py` answers 502 in four different situations and puts the reason
 * in the body every time — yt-dlp's own message, "yt-dlp produced no file", a size floor, a size
 * ceiling. The four need completely different responses from an operator: a bot check is a
 * network-identity problem, an unavailable video is a fact about that video, and a size refusal
 * is a failed cut.
 *
 * `downloadYouTubeCCClip` read that body into `errText`, printed a hundred characters of it to
 * the console, and recorded `http_502` as the attempt's reason. So the render's own account of
 * itself could say only that a number came back — and the explanation lived in a service log on
 * another machine, which is exactly where a diagnosis is least likely to be read.
 *
 * ── Why a CLASS and not the raw text ────────────────────────────────────────────────────────
 *
 * The reason is counted: identical reasons group, and "44 of them say the same thing" is the
 * signal RONDE 115 exists to preserve. Raw yt-dlp messages carry video ids and URLs, so every one
 * would be unique and the histogram would collapse into a list. A stable class groups; the raw
 * line is still printed beside it for the one case where the class is `other`.
 *
 * Reporting only. Nothing here decides whether a video is retried — that is
 * `YOUTUBE_PERMANENT_DOWNLOAD_STATUSES`, which is deliberately conservative and untouched.
 */
export type YoutubeServiceRefusal =
  | "bot_check"
  | "unavailable"
  | "private"
  | "members_only"
  | "geo_blocked"
  | "no_format"
  | "rate_limited"
  | "no_file"
  | "below_floor"
  | "over_ceiling"
  | "auth"
  /**
   * The service could not REACH YouTube: a proxy refused the tunnel, a connection was reset, DNS
   * failed, the transfer timed out. Named because it is the failure a PROXY deployment produces,
   * and because it is about the route rather than the video — retrying the same id later is
   * sensible, which is the opposite of what `unavailable` implies.
   *
   * Found by running the real service against a real /download and reading what came back. It
   * classified as `other`, which is the honest answer for an unrecognised message and the wrong
   * one for a message this specific:
   *
   *     ERROR: [youtube] dQw4w9WgXcQ: Unable to download API page: ('Unable to connect to
   *     proxy', OSError('Tunnel connection failed: 403 Forbidden'))
   */
  | "network"
  | "service_error"
  | "other";

/**
 * Strip anything that could carry a secret out of a service message before it is logged.
 *
 * Query strings are the real risk — a signed format URL carries a token — and a bearer value
 * could be echoed by a misconfigured proxy. Both are removed rather than truncated, because a
 * truncated secret is still a secret.
 */
export function sanitizeServiceDetail(body: string, max = 60): string {
  return body
    .replace(/[Bb]earer\s+\S+/g, "Bearer …")
    .replace(/\?[^\s"']*/g, "?…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Which of the service's refusals this is. `status` is the HTTP status; `body` its response text.
 */
export function classifyYoutubeServiceRefusal(
  status: number,
  body: string | undefined
): YoutubeServiceRefusal {
  /**
   * Trimmed, because a body of blanks is a body that said nothing — `"   "` used to be truthy
   * here and fell through to `other`, which claims the service said something unrecognised when
   * it said nothing at all. Found by its own test.
   */
  const text = (body ?? "").toLowerCase().trim();
  if (status === 401 || status === 403) return "auth";
  if (/sign in to confirm|not a bot|confirm you'?re not/.test(text)) return "bot_check";
  if (/private video/.test(text)) return "private";
  if (/members[- ]only|join this channel/.test(text)) return "members_only";
  /**
   * YouTube phrases this as "has not made this video available in your country", so a pattern
   * anchored on "not available" misses it — the negation sits on the verb, not on the adjective.
   * Matched on the country clause itself, and `geo.?block` kept for the shorter wordings.
   */
  if (/available in your country|geo.?block|blocked it on copyright/.test(text)) {
    return "geo_blocked";
  }
  if (/requested format is not available|no video formats/.test(text)) return "no_format";
  if (/too many requests|http error 429|rate.?limit/.test(text)) return "rate_limited";
  if (/video unavailable|has been removed|no longer available|does not exist/.test(text)) {
    return "unavailable";
  }
  /**
   * Checked before the service's own three refusals and after the platform's, because a transport
   * failure can quote anything: the text that follows "caused by" is the network's, not YouTube's.
   */
  if (
    /unable to connect to proxy|tunnel connection failed|proxyerror|connection reset|connection refused|name or service not known|temporary failure in name resolution|timed out|read timeout|network is unreachable|unable to download api page/.test(
      text
    )
  ) {
    return "network";
  }
  if (/produced no file/.test(text)) return "no_file";
  if (/below floor/.test(text)) return "below_floor";
  if (/over ceiling/.test(text)) return "over_ceiling";
  if (status >= 500 && !text) return "service_error";
  return "other";
}

/**
 * The attempt reason to record: the status, the class, and — only when the class is `other` — a
 * sanitised scrap of what was actually said, because that is the one case the class cannot carry.
 */
export function youtubeServiceRefusalReason(status: number, body: string | undefined): string {
  const kind = classifyYoutubeServiceRefusal(status, body);
  const tail = kind === "other" && body?.trim() ? `:${sanitizeServiceDetail(body)}` : "";
  return `http_${status}:${kind}${tail}`;
}
