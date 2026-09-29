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
  /**
   * RONDE 110 — HOW the rendered ones were drawn, when the caller can say.
   *
   * `rendered` counts graphics that will put visible ink on screen, which RONDE 160 §7 verified by
   * reading the alpha plane back for every renderable type. What it cannot say is whether each one
   * got its own design or the switch's `default:` text card, and eleven of the thirty-two names
   * reach that default. Two rounds of audit misread `rendered` for want of this split.
   *
   * Optional so the existing callers are untouched: without them the line reads exactly as before.
   */
  explicitRendered?: number;
  genericRendered?: number;
}): string {
  const split =
    params.explicitRendered != null && params.genericRendered != null
      ? ([
          ["explicitRendered", params.explicitRendered],
          ["genericRendered", params.genericRendered],
        ] as Array<[string, number]>)
      : ([] as Array<[string, number]>);
  const head =
    `[Graphics] ` +
    kv([
      ["render", params.renderId],
      ["planned", params.planned],
      ["rendered", params.rendered],
      ...split,
      ["skipped", params.skipped.length],
      ["renderer", params.renderer],
    ]);
  if (params.skipped.length === 0) return head;
  /** Each skip keeps its own reason: a count with no reasons cannot be acted on. */
  return [head, ...params.skipped.map((s) => `[Graphics]   skip: ${scrubForLog(s)}`)].join("\n");
}
