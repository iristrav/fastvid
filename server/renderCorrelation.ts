/**
 * RONDE 172 — one id, so a production log can be read as one story.
 *
 * ── Why this extends an id rather than adding one ────────────────────────────────────────────
 *
 * A `renderId` already exists: `VisualLineageLedger` mints one per render and `[SourceLineage]` and
 * `[SearchQuery]` already print it. What it does not do is REACH the rest of the chain — the
 * cinematic pipeline, the Director, the render job, Remotion, FFmpeg and the upload all log without
 * it, so the half of a render that decides the edit cannot be joined to the half that produces the
 * file.
 *
 * RULE 5 says reuse what exists, so this carries THAT id rather than minting a second one. The
 * generator here is only for the paths that have no ledger to borrow from.
 *
 * ── The one rule every line here obeys ───────────────────────────────────────────────────────
 *
 * No keys, no tokens, no signed URLs, no local paths. A retrieval line names a provider and an
 * asset id, which are exactly the two things needed to find the asset again and neither of which
 * is a secret. `scrubForLog` is applied to every free-text value, so a reason string that happens
 * to contain a URL cannot smuggle one in.
 */

/** A correlation id for one render. Short, sortable, and not a secret. */
export function newRenderId(now = Date.now()): string {
  return `r${now.toString(36)}`;
}

/**
 * Remove anything that must never reach a log line.
 *
 * Applied to free text — a provider's error message, a fallback reason — because those are the
 * values nobody controls. A URL becomes `<url>` rather than being dropped, so the line still says
 * that there WAS one.
 */
export function scrubForLog(value: string, maxLength = 160): string {
  return value
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b(?:key|token|secret|password|authorization)\s*[=:]\s*\S+/gi, "$1=<redacted>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const kv = (pairs: Array<[string, string | number | boolean | null | undefined]>): string =>
  pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : v}`)
    .join(" ");

/* ═══════════════════════ retrieval ═══════════════════════ */

/**
 * Why THIS asset was chosen for THIS beat, and what it beat.
 *
 * §"Voor iedere gekozen clip kunnen we uiteindelijk zien: beat, query, candidate source, provider,
 * providerAssetId, score, ranking signals, why selected, why alternatives lost." The runner-up is
 * named rather than the whole pool: the question a person actually asks of a log is "why not
 * something better", and the answer is the margin over the next best.
 */
export function formatSelection(params: {
  renderId: string;
  sceneIndex: number;
  beatIndex: number;
  query?: string;
  provider: string;
  providerAssetId?: string | null;
  score?: number | null;
  signals?: readonly string[];
  runnerUpProvider?: string | null;
  runnerUpScore?: number | null;
  duplicatePenalty?: number | null;
}): string {
  const margin =
    params.score != null && params.runnerUpScore != null
      ? (params.score - params.runnerUpScore).toFixed(4)
      : undefined;
  return (
    `[Retrieval] ` +
    kv([
      ["render", params.renderId],
      ["beat", `s${params.sceneIndex}b${params.beatIndex}`],
      ["query", params.query ? scrubForLog(params.query, 80) : undefined],
      ["provider", params.provider],
      ["assetId", params.providerAssetId ?? undefined],
      ["score", params.score != null ? params.score.toFixed(4) : undefined],
      ["signals", params.signals?.length ? params.signals.join("+") : undefined],
      ["dupPenalty", params.duplicatePenalty ? params.duplicatePenalty.toFixed(2) : undefined],
      ["runnerUp", params.runnerUpProvider ?? undefined],
      ["margin", margin],
    ])
  );
}

/** One source attempt: tried, found this many, accepted this many, and why the rest went. */
export function formatSourceAttempt(params: {
  renderId: string;
  sceneIndex: number;
  beatIndex?: number;
  source: string;
  mode?: string;
  attempted: boolean;
  found?: number;
  accepted?: number;
  rejected?: number;
  reason?: string;
}): string {
  return (
    `[Retrieval] ` +
    kv([
      ["render", params.renderId],
      ["beat", params.beatIndex != null ? `s${params.sceneIndex}b${params.beatIndex}` : `s${params.sceneIndex}`],
      ["source", params.source],
      ["mode", params.mode],
      ["attempted", params.attempted],
      ["found", params.found],
      ["accepted", params.accepted],
      ["rejected", params.rejected],
      ["reason", params.reason ? scrubForLog(params.reason) : undefined],
    ])
  );
}

/* ═══════════════════════ graphics ═══════════════════════ */

/**
 * What was planned, what was drawn, and what was not — with the reason.
 *
 * RULE 2: `graphicsDrawn = 1` is not evidence that a graphic is visible. This line does not claim
 * it is; it reports the renderer's own counts so a mismatch between planned and rendered is
 * visible in a log rather than only in a frame nobody looked at.
 */
export function formatGraphics(params: {
  renderId: string;
  planned: number;
  rendered: number;
  skipped: readonly string[];
  renderer: string;
}): string {
  const head =
    `[Graphics] ` +
    kv([
      ["render", params.renderId],
      ["planned", params.planned],
      ["rendered", params.rendered],
      ["skipped", params.skipped.length],
      ["renderer", params.renderer],
    ]);
  if (params.skipped.length === 0) return head;
  /** Each skip keeps its own reason: a count with no reasons cannot be acted on. */
  return [head, ...params.skipped.map((s) => `[Graphics]   skip: ${scrubForLog(s)}`)].join("\n");
}

/* ═══════════════════════ fallbacks ═══════════════════════ */

/**
 * RULE 9 — every fallback says WHY, FROM and TO.
 *
 * The shape is fixed so the three are always present. A fallback that printed only a reason would
 * leave a reader guessing what was replaced with what, which is the half that matters when the
 * output looks wrong.
 */
export function formatFallback(params: {
  renderId: string;
  what: string;
  from: string;
  to: string;
  why: string;
}): string {
  return (
    `[Fallback] ` +
    kv([
      ["render", params.renderId],
      ["what", params.what],
      ["from", params.from],
      ["to", params.to],
      ["why", scrubForLog(params.why)],
    ])
  );
}

/** The route a render actually took, next to the one it was configured for. */
export function formatRoute(params: {
  renderId: string;
  videoId?: number;
  configured: string;
  actual: string;
  reason?: string;
}): string {
  const fellBack = params.configured !== params.actual;
  return (
    `[Route] ` +
    kv([
      ["render", params.renderId],
      ["video", params.videoId],
      ["configured", params.configured],
      ["actual", params.actual],
      ["fallback", fellBack],
      ["reason", params.reason ? scrubForLog(params.reason) : undefined],
    ])
  );
}
