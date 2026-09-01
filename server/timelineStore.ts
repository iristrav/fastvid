/**
 * RONDE 148 §3/§4/§6 — the timeline as a stored document with a version.
 *
 * ── What is new here and what is not ──────────────────────────────────────────────────────────
 *
 * `ProjectTimeline` already has a `version` (RONDE 147 §10: "Bumped on every save. A render names
 * the version it was made from"), and `timelineFromEditorScenes` already turns an old manifest
 * into one. §3 asked for a timelineVersion; it exists, and this module uses it rather than adding a
 * second number that could disagree with the first. What did not exist is anywhere to PUT a saved
 * timeline, and any rule about two people saving one.
 *
 * ── The concurrency rule, and why it refuses ─────────────────────────────────────────────────
 *
 * A save carries the version the editor was opened at. If the stored version has moved on, the save
 * is REFUSED — the other person's edits are not overwritten and this person's are not silently
 * dropped either. They get told, and they still hold their own changes in the browser.
 *
 * The alternative everyone reaches for first is last-write-wins, which in an editor means the two
 * minutes someone spent retyping a caption vanish with no error and no way to know it happened.
 *
 * ── This module does not validate ────────────────────────────────────────────────────────────
 *
 * `timelineValidator` does, and the ROUTE runs it before calling `saveTimeline`. Keeping them
 * apart means the validator stays a pure function over a document — testable without a database —
 * and this stays a store. What this module does guarantee is that it will not write a timeline
 * whose version does not follow from the one it replaces.
 */
import {
  TIMELINE_SCHEMA_VERSION,
  normaliseGraphicsTrack,
  type AssetSourceIdentity,
  type ProjectTimeline,
} from "./projectTimeline";

/* ═══════════════════════ what a caller gets back ═══════════════════════ */

export type TimelineSaveResult =
  | { ok: true; timeline: ProjectTimeline; timelineVersion: number }
  | {
      ok: false;
      code: "TIMELINE_VERSION_CONFLICT";
      /** What the server actually holds, so the client can offer to reload. */
      storedVersion: number;
      expectedVersion: number;
      reason: string;
    };

/**
 * The next document to store, or a refusal — the pure half of a save.
 *
 * Separated from the database write so the rule can be tested exhaustively over integers, which is
 * where the interesting cases are: version 0 (nothing saved yet), a version from the future, a
 * repeat of a save that already landed.
 */
export function nextTimelineToStore(params: {
  /** What the database holds. 0 when the editor has never saved this video. */
  storedVersion: number;
  /** The version the editing session was opened at. */
  expectedVersion: number;
  /** The document the user wants stored. Its own `version` is ignored — the server assigns it. */
  incoming: ProjectTimeline;
}): TimelineSaveResult {
  const { storedVersion, expectedVersion, incoming } = params;

  if (expectedVersion !== storedVersion) {
    return {
      ok: false,
      code: "TIMELINE_VERSION_CONFLICT",
      storedVersion,
      expectedVersion,
      reason:
        `this editor was opened at version ${expectedVersion} and the saved version is now ` +
        `${storedVersion}. Saving would overwrite the newer edits, so nothing was written — ` +
        "reload to get the current timeline.",
    };
  }

  /**
   * The version is assigned by the SERVER, from what it holds, and the client's own `version` is
   * discarded.
   *
   * A client that could name its own version could name one, save twice at the same number, and
   * leave two different documents both claiming to be version 5 — after which "render version 5"
   * has no single answer. `expectedVersion` is the client's only say in the matter, and it is a
   * check rather than an instruction.
   */
  const version = storedVersion + 1;
  return {
    ok: true,
    timelineVersion: version,
    timeline: {
      ...incoming,
      version,
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
    },
  };
}

/* ═══════════════════════ reading a stored document back ═══════════════════════ */

/**
 * A stored JSON blob, checked before it is treated as a timeline.
 *
 * The column is `json` and nothing stops an older build, a manual fix or a failed partial write
 * from leaving something else in it. Returning null for anything that is not shaped like a
 * timeline means the caller falls back to rebuilding from the manifest, which is a working editor;
 * handing a malformed object to the renderer is a crash halfway through a render.
 */
export function parseStoredTimeline(raw: unknown): ProjectTimeline | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Partial<ProjectTimeline>;
  if (typeof t.videoId !== "number") return null;
  if (typeof t.version !== "number" || !Number.isFinite(t.version)) return null;
  if (!Array.isArray(t.tracks)) return null;
  if (!t.format || typeof t.format !== "object") return null;
  if (typeof t.durationSec !== "number" || !Number.isFinite(t.durationSec)) return null;
  return raw as ProjectTimeline;
}

/**
 * Is this timeline one this build can render?
 *
 * Separate from `parseStoredTimeline` because the answers differ: a document from a NEWER build is
 * perfectly well-formed and still must not be rendered, since this build would drop the fields it
 * does not know about and produce a video that quietly differs from what the person edited.
 */
export function storedTimelineIsReadable(t: ProjectTimeline): boolean {
  const schema = t.schemaVersion ?? 1;
  return Number.isInteger(schema) && schema >= 1 && schema <= TIMELINE_SCHEMA_VERSION;
}

/* ═══════════════════════ §17 — replacing a shot on the TIMELINE ═══════════════════════ */

export type ClipReplacementResult =
  | { ok: true; timeline: ProjectTimeline; clipId: string }
  | { ok: false; code: "CLIP_NOT_FOUND"; reason: string };

/**
 * Put a different source in an existing slot, and change NOTHING else.
 *
 * §17's requirement in one function: the slot keeps its id, its `timelineStart`, its
 * `timelineEnd`, its transitions and its motion; only `source` (and the trim, when the caller
 * knows one) changes. Nothing after it moves.
 *
 * That last part is the whole point. Replacing a shot with a longer one and letting everything
 * slide is how a caption ends up over the wrong picture and the voiceover stops matching — the
 * edit the person asked for was "this shot, not that one", not "and shift the rest of my video".
 * The new source is TRIMMED to the slot instead, which is what `sourceIn`/`sourceOut` are for.
 */
export function replaceTimelineClipSource(params: {
  timeline: ProjectTimeline;
  clipId: string;
  source: AssetSourceIdentity;
  /** In/out inside the NEW media, when the caller knows them. Absent stays absent — §15. */
  sourceIn?: number;
  sourceOut?: number;
}): ClipReplacementResult {
  const tracks = params.timeline.tracks.map((track) => {
    if (track.kind !== "VIDEO") return track;
    return {
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.id !== params.clipId) return clip;
        const next = {
          ...clip,
          source: params.source,
          /** A replaced clip is a human's decision, and the manifest has always recorded that. */
          editedByUser: true,
          /**
           * The new media is a real source again, so the preview stops falling back to the
           * previously rendered MP4 — that file still shows the OLD shot, and leaving the preview
           * pointed at it would show the person the thing they just replaced.
           */
          previewSource: "asset" as const,
        };
        if (params.sourceIn != null) next.sourceIn = params.sourceIn;
        else delete next.sourceIn;
        if (params.sourceOut != null) next.sourceOut = params.sourceOut;
        else delete next.sourceOut;
        return next;
      }),
    };
  });

  const found = tracks.some(
    (t) => t.kind === "VIDEO" && t.clips.some((c) => c.id === params.clipId)
  );
  if (!found) {
    return {
      ok: false,
      code: "CLIP_NOT_FOUND",
      reason: `no video clip with id ${params.clipId} on this timeline`,
    };
  }
  return { ok: true, timeline: { ...params.timeline, tracks }, clipId: params.clipId };
}

/* ═══════════════════════ §16 — editing one text element ═══════════════════════ */

export type TextEditResult =
  | { ok: true; timeline: ProjectTimeline }
  | { ok: false; code: "ELEMENT_NOT_FOUND"; reason: string };

/**
 * Change one text or caption element, leaving every other element byte-identical.
 *
 * The test §23 asks for ("text edit verandert alleen het betreffende timeline-item") is really a
 * test of this function, and the way to pass it is to build the new tracks by mapping rather than
 * by rebuilding: an element that is not the target comes through as the SAME object, so a deep
 * comparison of the others cannot fail even in principle.
 */
export function editTimelineText(params: {
  timeline: ProjectTimeline;
  elementId: string;
  text?: string;
  start?: number;
  end?: number;
}): TextEditResult {
  let found = false;
  const patch = <T extends { id: string; text: string; start: number; end: number }>(el: T): T => {
    if (el.id !== params.elementId) return el;
    found = true;
    return {
      ...el,
      ...(params.text != null ? { text: params.text } : {}),
      ...(params.start != null ? { start: params.start } : {}),
      ...(params.end != null ? { end: params.end } : {}),
    };
  };

  const tracks = params.timeline.tracks.map((track) => {
    if (track.kind === "CAPTIONS") return { ...track, captions: track.captions.map(patch) };
    if (track.kind === "TEXT") return { ...track, texts: track.texts.map(patch) };
    /**
     * RONDE 148 — a graphic's words live in `label`, not `text`.
     *
     * A location card is a graphic with a payload; only its label is editable as words, and the
     * payload it draws from is the planner's, not something a text edit may reach into.
     */
    if (track.kind === "GRAPHICS") {
      /**
       * `normaliseGraphicsTrack`, not `track.graphics` directly.
       *
       * RONDE 148 changed this track's shape, and every timeline saved before it still carries the
       * old `texts` array — reading `.graphics` on one of those gives undefined and `.map` throws.
       * Normalising here means an edit to a legacy document works and quietly writes the new shape.
       */
      return {
        ...track,
        graphics: normaliseGraphicsTrack(track).map((g) => {
          if (g.id !== params.elementId) return g;
          found = true;
          return {
            ...g,
            ...(params.text != null ? { label: params.text } : {}),
            ...(params.start != null ? { start: params.start } : {}),
            ...(params.end != null ? { end: params.end } : {}),
          };
        }),
      };
    }
    return track;
  });

  if (!found) {
    return {
      ok: false,
      code: "ELEMENT_NOT_FOUND",
      reason: `no text or caption element with id ${params.elementId} on this timeline`,
    };
  }
  return { ok: true, timeline: { ...params.timeline, tracks } };
}
