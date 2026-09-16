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
 * RONDE 261 — THE PIPELINE REMEMBERED ITS FAILURES AND FORGOT ITS SUCCESSES.
 *
 * ── What the render after RONDE 260 measured ────────────────────────────────────────────────
 *
 *     ODx7fCL6BHw   3 405 471 bytes   downloaded SIX times, scene 2
 *     each one preceded by:  "Cloud DL failed … exceeded 21s — falling back to RapidAPI"
 *
 * Six identical transfers of one file, each paying twenty-odd seconds to the cloud route first.
 * Two minutes and seventeen megabytes for a file that was on disk after the first one.
 *
 * ── Why it appeared only now ────────────────────────────────────────────────────────────────
 *
 * The memo above remembers what FAILED, and nothing remembers what worked. While the downloads
 * were failing that asymmetry was invisible: the refusal memo skipped the repeats and did the job
 * of a dedup by accident. RONDE 260 made the transfers succeed, the refusal memo stopped firing,
 * and there was nothing underneath it.
 *
 * It is also why render 586 skipped a video it had successfully downloaded with the reason
 * "already refused this render" — the only memory of that video was of its failed cloud leg.
 *
 * ── What is remembered, and what deliberately is not ────────────────────────────────────────
 *
 * The UNTRIMMED SOURCE, not the clip. Two beats asking for the same video ask for different
 * seconds of it — `downloadYouTubeCCClip` takes `clipStart` and `duration` and cuts to them — so
 * handing the second beat the first beat's clip would be a silent substitution, and this codebase
 * forbids those for good reason. The source file is identical for every request; the cut is not.
 *
 * So a repeat request re-cuts from the file already on disk, at ITS OWN start and duration. The
 * content of the render does not change by a frame. Only the transfer is skipped.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** videoId → the untrimmed source this render already fetched. Cleared per render. */
const youtubeSourceFiles = new Map<string, { path: string; bytes: number }>();

/** How many transfers the memo has saved this render — the evidence that it does anything. */
let youtubeSourceReuses = 0;

/**
 * Remember where this render put a video's untrimmed source.
 *
 * First writer wins, matching the refusal memo beside it: a second successful download of the
 * same video is the thing this exists to prevent, so if one happens anyway the first path is
 * still the one to re-cut from.
 */
export function noteYoutubeSourceFile(videoId: string, filePath: string, bytes: number): void {
  if (!videoId || !filePath || !(bytes > 0)) return;
  if (!youtubeSourceFiles.has(videoId)) youtubeSourceFiles.set(videoId, { path: filePath, bytes });
}

/**
 * The source this render already has for this video, or null.
 *
 * Every hit is counted, for the same reason the refusal memo counts its own: an optimisation
 * nobody can measure is one nobody can check.
 */
export function youtubeSourceFile(videoId: string): { path: string; bytes: number } | null {
  if (!videoId) return null;
  const hit = youtubeSourceFiles.get(videoId);
  if (!hit) return null;
  youtubeSourceReuses++;
  return hit;
}

/** Start of a render: the files are in a work directory that is about to be deleted. */
export function resetYoutubeSourceFiles(): void {
  youtubeSourceFiles.clear();
  youtubeSourceReuses = 0;
}

/** What the memo holds and what it saved — reported at the end of a render. */
export function youtubeSourceReuseStats(): { held: number; reused: number } {
  return { held: youtubeSourceFiles.size, reused: youtubeSourceReuses };
}

/** The line the render logs, so the saving is visible rather than merely believed. */
export function formatYoutubeSourceReuse(): string | null {
  const { held, reused } = youtubeSourceReuseStats();
  if (held === 0) return null;
  return (
    `[YouTubeSourceReuse] ${held} source file(s) kept this render, ` +
    `${reused} transfer(s) not repeated`
  );
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

/**
 * THE SERVICE ANSWERS THAT CANNOT CHANGE WITHIN ONE RENDER.
 *
 * ── Why the status alone was not enough ─────────────────────────────────────────────────────
 *
 * The set above is keyed on STATUS, and the yt-dlp cloud service's refusals all arrive as
 * `DOWNLOAD_FAILED` — deliberately excluded there as "ambiguous by definition". They are not
 * ambiguous once the body has been read, and `classifyYoutubeServiceRefusal` has been reading it
 * since RONDE 223. Render 581, one video, four attempts:
 *
 *     Cloud DL service error 502 for ynJoy1OCeVQ: {"detail":"ERROR: [youtube] ynJoy1OCeVQ:
 *     Sign in to confirm you're not a bot. Use --cookies-from-bro…
 *
 *     [YouTubeDownload] video=ynJoy1OCeVQ status=DOWNLOAD_TIMEOUT
 *                       attempts=cloud:DOWNLOAD_FAILED(http_502:bot_check),rapidapi:…
 *
 * The classifier said `bot_check`, the memo never saw it — the render's headline status is
 * `DOWNLOAD_TIMEOUT`, because the fallback's budget stand-aside wins the summary — and the same
 * video was asked for four times. YouTube does not change its mind about a bot check in fifty
 * seconds.
 *
 * ── What is in, and what is deliberately out ────────────────────────────────────────────────
 *
 *   private, members_only, unavailable, geo_blocked, no_format
 *                  facts about the VIDEO. True on the first ask and true on the fiftieth.
 *   bot_check      a fact about the SERVICE's network identity rather than the video, so the key
 *                  is arguably too narrow — it will be true of every video this render asks for.
 *                  Memoising per video is still right and still safe: it cannot wrongly skip a
 *                  video that would have worked, and it stops one video being asked four times.
 *                  The render-wide reading belongs in a latch, not here.
 *
 *   rate_limited   the one refusal that lifts on its own. Excluded, and this is the whole reason
 *                  the list is explicit rather than "everything the classifier named".
 *   auth, proxy/transport, no_file, below_floor, over_ceiling, other
 *                  about the deployment, the network or the cut — not about this video's
 *                  availability. `over_ceiling` and `no_file` already reach the memo through
 *                  DOWNLOAD_UNSUPPORTED / DOWNLOAD_EMPTY where they belong.
 */
export const YOUTUBE_DURABLE_SERVICE_REFUSALS: ReadonlySet<string> = new Set<string>([
  "bot_check",
  "private",
  "members_only",
  "unavailable",
  "geo_blocked",
  "no_format",
]);

/**
 * Does this refusal mean "not this render", whatever status it arrived under?
 *
 * The reason string is `http_<code>:<class>` (see `youtubeServiceRefusalReason`), so the class is
 * read off the end rather than the caller being asked to take it apart.
 */
export function isDurableYoutubeServiceRefusal(reason: string | undefined): boolean {
  if (!reason) return false;
  const cls = reason.includes(":") ? reason.slice(reason.lastIndexOf(":") + 1) : reason;
  return YOUTUBE_DURABLE_SERVICE_REFUSALS.has(cls.trim());
}

/* ═══════════ the cloud service's network identity, which is not about any one video ═══════════
 *
 * A bot check is not a fact about the video that happened to be asked for. It is a fact about the
 * machine doing the asking: YouTube has decided this IP is automated, and it will decide that
 * again for the next video and the one after. Render 581 asked 2609 candidates' worth of
 * questions and moved zero bytes.
 *
 * The per-video memo above stops one video being asked four times. It cannot stop the render
 * asking the same dead route about a different video, because a per-video key cannot express
 * "this route is dead". That is what this latch is for — the same shape as the beat image gate's
 * `askImpossible`: a fact about the render, recorded once, read everywhere.
 *
 * Deliberately NOT persisted beyond the render: an IP's reputation can recover, a proxy can be
 * fixed, and a latch that outlived its render would turn a bad hour into a permanent outage. It is
 * reset with everything else at the start of a render.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

let cloudEgressBlocked: { videoId: string; reason: string } | null = null;
let consecutiveEgressRefusals = 0;

/**
 * HOW MANY REFUSALS IN A ROW MEAN THE ROUTE IS DEAD.
 *
 * ── Why this is not one ─────────────────────────────────────────────────────────────────────
 *
 * It was one, and that was right for the network this was written against: no proxy, so every
 * request left from the same address, and one "Sign in to confirm you're not a bot" was the same
 * answer the next 2608 would get. Closing after the first refusal saved render 581 from asking a
 * dead route about every candidate it had.
 *
 * A residential proxy changes the fact the rule was built on. The address ROTATES — a refusal is
 * now about one IP out of a pool of ninety million, and the next request gets a different one. A
 * single flagged address no longer says anything about the route.
 *
 * Render 582 is what the old rule cost once the proxy existed: one bot check closed the cloud
 * route, and all 48 later attempts fell to RapidAPI, which downloads the WHOLE source before it
 * trims. Scene 2 reached them with 11 seconds left against a 12-second floor, so every one was
 * refused before it started — while the cloud route, which fetches only the seconds a beat needs,
 * would have fitted comfortably. The latch closed the only door that could still have opened.
 *
 * ── Why it is still bounded ─────────────────────────────────────────────────────────────────
 *
 * Without a proxy the address does not rotate, so the refusals arrive in an unbroken run and the
 * latch still closes — after three attempts instead of one. Three wasted calls against 2609 is the
 * same protection to two significant figures, and it buys a rotating pool the retries it needs.
 *
 * CONSECUTIVE is the whole of it: any success resets the count, because a success proves the route
 * is alive whatever the last refusal said.
 */
function maxConsecutiveEgressRefusals(): number {
  const raw = process.env.MAX_CLOUD_EGRESS_REFUSALS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 3;
}

/**
 * Record that the yt-dlp cloud service was refused by YouTube on this attempt.
 *
 * Returns whether this call was the one that closed the latch, so the caller can log it once
 * instead of on every subsequent video.
 */
export function noteCloudEgressBlocked(videoId: string, reason: string): boolean {
  if (cloudEgressBlocked) return false;
  consecutiveEgressRefusals += 1;
  if (consecutiveEgressRefusals < maxConsecutiveEgressRefusals()) return false;
  cloudEgressBlocked = { videoId, reason };
  return true;
}

/**
 * The cloud route answered. Whatever it was refused for before, it is not refused now.
 *
 * Called on every successful cloud download. Without this the counter is a lifetime tally rather
 * than a run, and a route that fails once per twenty videos would eventually be closed by
 * arithmetic instead of by evidence.
 */
export function noteCloudEgressOk(): void {
  consecutiveEgressRefusals = 0;
}

/** How many refusals in a row the cloud route has seen — for the render's own report. */
export function cloudEgressRefusalStreak(): number {
  return consecutiveEgressRefusals;
}

/** Why the cloud route is being skipped for the rest of this render, or null while it is alive. */
export function cloudEgressRefusal(): { videoId: string; reason: string } | null {
  return cloudEgressBlocked;
}

/** Cleared at the start of every render, beside the per-video memo. */
export function resetCloudEgressBlocked(): void {
  cloudEgressBlocked = null;
  consecutiveEgressRefusals = 0;
}

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
  /**
   * Two rules, one memo. The status rule is RONDE 223's and is untouched; the reason rule is
   * what lets the cloud service's own verdict through — see `YOUTUBE_DURABLE_SERVICE_REFUSALS`
   * for why `DOWNLOAD_FAILED` alone had to stay ambiguous and why these classes are not.
   */
  const durable =
    (status && YOUTUBE_PERMANENT_DOWNLOAD_STATUSES.has(status)) ||
    isDurableYoutubeServiceRefusal(reason);
  if (!videoId || !status || !durable) return false;
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
