/**
 * RONDE 258 — ASKING THE DOWNLOAD SERVICE WHY, AT THE MOMENT IT MATTERS.
 *
 * ── The question nobody asked ───────────────────────────────────────────────────────────────
 *
 * Render 585 filed 103 YouTube failures, every one of them `reason=download_timeout`. Six rounds
 * were spent looking at budgets because of that word. The service knew better the whole time:
 *
 *     13:48:52  [Preflight] OK  youtube_egress  the yt-dlp service reached YouTube
 *     13:55:45  [Preflight] NO  youtube_egress  … CANNOT reach YouTube (bot_check)
 *     13:55:48  ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot.
 *
 * Seven minutes apart, same machine, same proxy, and the video refused was the most cached one on
 * YouTube — refused for a metadata call. The address is blocked intermittently.
 *
 * The cloud download route already classifies a refusal correctly and latches the dead route shut,
 * but that branch needs a RESPONSE. When yt-dlp meets the bot check it retries with backoff, the
 * beat's budget expires first, the client aborts before any response arrives, and execution goes to
 * a catch that files `DOWNLOAD_TIMEOUT` from the error object and asks nothing further.
 *
 * So the answer existed, was published at `/health/egress`, and was never fetched at the moment a
 * decision depended on it. That is this codebase's signature defect, and this module is the one
 * line it was missing.
 *
 * ── Why a module, and why it caches ─────────────────────────────────────────────────────────
 *
 * `worker.ts` already asks this endpoint at boot, inline. A second copy in the pipeline would be a
 * second reader of one contract, free to drift; both now call this.
 *
 * It caches because render 585 had 105 candidates and the answer is about the SERVICE, not about
 * any one of them — a probe per candidate would be a hundred questions to learn one fact, each one
 * spending budget the beat has already overspent. The TTL is short because the answer genuinely
 * changes: it was yes at 13:48 and no at 13:55.
 *
 * A FAILURE TO ASK IS NOT CACHED. "The service did not answer" and "the service answered that it
 * is blocked" are different facts — the preflight already draws that line — and only the second is
 * worth remembering.
 */

/** What the service says about its own reach, or null when it could not be asked. */
export type YoutubeEgressVerdict = { ok: boolean; reason?: string } | null;

/**
 * Short, because this runs on a beat that has just lost its budget to a transfer that never
 * arrived. The probe must answer or get out of the way; it may never become a second wait.
 */
export const YOUTUBE_EGRESS_PROBE_TIMEOUT_MS = 3_000;

/**
 * How long one answer stands. The boot log shows the verdict flipping inside seven minutes, so a
 * long cache would report a blocked route as healthy for most of a render, and a healthy one as
 * blocked for the rest of it.
 */
export const YOUTUBE_EGRESS_CACHE_MS = 30_000;

let cached: { at: number; verdict: Exclude<YoutubeEgressVerdict, null> } | null = null;
/** One in-flight probe at a time, so a hundred simultaneous callers produce one request. */
let inFlight: Promise<YoutubeEgressVerdict> | null = null;

/** Test-only, and used by a render that wants the question asked fresh. */
export function resetYoutubeEgressProbeCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * HOW LONG THE ANSWER TOOK, BECAUSE THE NEXT DECISION DEPENDS ON IT AND NOBODY HAS MEASURED IT.
 *
 * The open question after the de1c88b audit is whether a BLOCKED service is slower to answer than
 * a healthy one. If it is, and if it is slower than `YOUTUBE_EGRESS_PROBE_TIMEOUT_MS`, then the
 * render-time probe returns null exactly when YouTube is blocking — and RONDE 258's latch, which
 * exists for that case, never arms.
 *
 * That is a hypothesis. The honest response to a hypothesis is a measurement, not a larger
 * timeout: raising the number would hide the question and cost every blocked beat three more
 * seconds of the budget it has already overspent. So the duration is recorded and the timeout is
 * untouched, and the next production log answers it.
 *
 * Nothing sensitive: a status code, the service's own one-word reason, and a duration. The bearer
 * token is sent and never printed, here or anywhere.
 */
function noteProbeTiming(startedAt: number, status: number | "no_answer", reason?: string): void {
  console.log(
    `[YouTubeEgress] status=${status}` +
      (reason ? ` reason=${reason}` : "") +
      ` durationMs=${Date.now() - startedAt}`
  );
}

async function probe(timeoutMs: number): Promise<YoutubeEgressVerdict> {
  const base = process.env.YOUTUBE_CC_DL_SERVICE?.trim().replace(/\/$/, "");
  if (!base) return null;
  const token = process.env.YOUTUBE_CC_DL_TOKEN?.trim();
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/health/egress`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    /**
     * The STATUS is not the answer; the BODY is. RONDE 258 gives this endpoint an honest status
     * code — 503 when the probe failed — and a service that has not been redeployed still answers
     * 200 with the same body. Reading the body works against both, and reading the status would
     * discard the very verdict this call exists to fetch.
     */
    const body = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;
    if (typeof body?.ok !== "boolean") {
      noteProbeTiming(startedAt, res.status, "unreadable_body");
      return null;
    }
    noteProbeTiming(startedAt, res.status, body.reason ?? (body.ok ? "reachable" : "blocked"));
    return { ok: body.ok, reason: body.reason ?? undefined };
  } catch {
    /** Could not ask. Nothing is claimed and nothing is remembered. */
    noteProbeTiming(startedAt, "no_answer");
    return null;
  }
}

/**
 * Can the download service reach YouTube right now?
 *
 * `null` means the question could not be asked, which a caller must treat as "no new information"
 * rather than as either answer.
 */
export async function askYoutubeEgress(
  timeoutMs: number = YOUTUBE_EGRESS_PROBE_TIMEOUT_MS
): Promise<YoutubeEgressVerdict> {
  if (cached && Date.now() - cached.at < YOUTUBE_EGRESS_CACHE_MS) return cached.verdict;
  if (inFlight) return inFlight;
  inFlight = probe(timeoutMs)
    .then((verdict) => {
      if (verdict) cached = { at: Date.now(), verdict };
      return verdict;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The reason to file INSTEAD of a timeout, or null to leave the timeout standing.
 *
 * Null on a healthy route is the important half: the service can reach YouTube, so a transfer that
 * did not finish really was a slow transfer, and relabelling it would trade one wrong word for
 * another. Every blocked verdict is carried under its own name — a proxy fault and a rate limit
 * send an operator to two different places, and both beat "timeout".
 */
export async function egressRefusalReason(
  timeoutMs: number = YOUTUBE_EGRESS_PROBE_TIMEOUT_MS
): Promise<string | null> {
  const verdict = await askYoutubeEgress(timeoutMs);
  if (!verdict || verdict.ok) return null;
  return `cloud_egress_${verdict.reason ?? "blocked"}`;
}
