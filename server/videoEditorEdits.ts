/**
 * RONDE 139 — the editing half of the editor.
 *
 * ── What was already there, and what was not ─────────────────────────────────────────────────
 *
 * FastVid has written an editor manifest at the end of every render for a long time:
 * `buildEditorScenesFromPipeline` produces EditorScene[], `updateVideoScenes` stores it in the
 * `videoScenes` column, and `editedVideoUrl` waits for a re-render that nothing ever asked for.
 *
 * What did not exist is anything that can CHANGE it. No tRPC route reads the manifest, none writes
 * it, and `updateEditedVideoUrl` has no caller. So a render that got seventeen beats right and
 * three wrong was finished — the three wrong ones stayed wrong.
 *
 * That is the gap this module fills, and it is the one Vidrush closes with "click a visual on the
 * timeline, then Replace Media". Their editor is the reason a 70%-correct draft is still a usable
 * video; ours could not be corrected at all.
 *
 * ── Why the rules live here rather than in the router ────────────────────────────────────────
 *
 * Everything below is a pure function over a manifest. A tRPC procedure adds ownership, transport
 * and persistence; it should not also be where "is this a legal edit" is decided, because that is
 * the part with the sharp edges — an out-of-range index silently appending a clip, a replacement
 * that points at an HTML page, an edit that quietly drops the provenance the rest of the pipeline
 * spent RONDE 86/87 establishing.
 *
 * ── The rule that matters most ───────────────────────────────────────────────────────────────
 *
 * A REPLACEMENT MAY NOT LAUNDER A SOURCE.
 *
 * Every clip in the manifest carries `source`, and the quality report counts UNVERIFIED against
 * the render. An edit that let a user paste a URL and inherit the replaced clip's provider would
 * turn the manifest into a place where provenance can be invented — the exact thing RONDE 87 built
 * the lineage ledger to prevent. A pasted URL is therefore always UNVERIFIED, and only an archive
 * asset (a row this system ingested itself) may claim a real provider.
 */
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";
import type { EditorClip, EditorScene } from "./db";

/** What the caller is allowed to put in a slot. */
export type ClipReplacement =
  | {
      kind: "archive";
      /** media_archive_assets.id — the row this system ingested and can vouch for. */
      archiveAssetId: number;
      url: string;
      mediaType: "video" | "image";
      title?: string;
      /** The archive this row belongs to; the only provider name an edit may assert. */
      provider: string;
      storageUrl?: string;
    }
  | {
      kind: "url";
      /** Pasted by a human. Its provenance is exactly nothing, and it is labelled as such. */
      url: string;
      mediaType: "video" | "image";
      title?: string;
    };

export type EditResult =
  | { ok: true; scenes: EditorScene[]; replaced: EditorClip; previous: EditorClip }
  | { ok: false; reason: EditRejectReason; detail: string };

export type EditRejectReason =
  | "no_manifest"
  | "scene_out_of_range"
  | "clip_out_of_range"
  | "bad_url"
  | "unsupported_media_type";

/**
 * URLs a replacement may point at.
 *
 * Deliberately narrow. A manifest entry becomes a download at re-render time, so a value that is
 * not fetchable media is a failure deferred to the slowest possible moment — which is precisely
 * how the Library of Congress catalogue pages wasted slots in video 558 (RONDE 136). Rejecting the
 * shape here costs nothing and is the earliest place the answer is knowable.
 *
 * `data:` and `blob:` are refused: they are not re-fetchable from a worker, and a manifest is read
 * long after the browser that produced it has gone.
 */
export function isAcceptableReplacementUrl(raw: string): boolean {
  const url = (raw ?? "").trim();
  if (!url) return false;
  if (url.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A site-relative path is how this system refers to its own stored objects
    // (/manus-storage/…, /local-storage/…, /api/…), and those are legitimate.
    return /^\/(manus-storage|local-storage|api)\//.test(url);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  // No credentials in a stored URL — it would be persisted in the manifest and logged.
  if (parsed.username || parsed.password) return false;
  return true;
}

/**
 * Turn a replacement into the manifest entry it becomes.
 *
 * The `source` assignment is the whole point — see the module note. An archive replacement carries
 * the archive's own name because the row is one this system ingested; a pasted URL carries
 * UNVERIFIED, which is what every other route in the pipeline says about material it cannot vouch
 * for, and what the quality report already knows how to count.
 */
export function replacementToClip(replacement: ClipReplacement): EditorClip {
  const base: EditorClip = {
    url: replacement.url,
    type: replacement.mediaType,
    source: UNVERIFIED_PROVIDER,
    title: replacement.title?.trim() || undefined,
    available: true,
    editedByUser: true,
  };
  if (replacement.kind === "archive") {
    return {
      ...base,
      source: replacement.provider.trim().toLowerCase() || UNVERIFIED_PROVIDER,
      archiveAssetId: replacement.archiveAssetId,
      storageUrl: replacement.storageUrl,
    };
  }
  return base;
}

/**
 * Put `replacement` in one slot and hand back the whole manifest.
 *
 * Returns a NEW array; the input is never mutated. That is not tidiness — the caller persists the
 * result and returns it to the client in the same breath, and an in-place edit that then failed to
 * persist would leave the two disagreeing.
 *
 * An out-of-range index is refused rather than clamped. Clamping would silently edit a different
 * clip than the one the user clicked, which is worse than an error message.
 */
export function replaceClipInScenes(
  scenes: EditorScene[] | null | undefined,
  sceneIndex: number,
  clipIndex: number,
  replacement: ClipReplacement
): EditResult {
  if (!scenes || scenes.length === 0) {
    return { ok: false, reason: "no_manifest", detail: "this video has no editor manifest" };
  }
  if (replacement.mediaType !== "video" && replacement.mediaType !== "image") {
    return {
      ok: false,
      reason: "unsupported_media_type",
      detail: `${String(replacement.mediaType)} is not a video or an image`,
    };
  }
  if (!isAcceptableReplacementUrl(replacement.url)) {
    return { ok: false, reason: "bad_url", detail: "not a fetchable http(s) or storage URL" };
  }

  // The manifest is addressed by the scene's OWN index, not by its position in the array: a
  // manifest may legitimately be sparse or reordered, and position would then edit the wrong scene.
  const pos = scenes.findIndex((s) => s.sceneIndex === sceneIndex);
  if (pos < 0) {
    return { ok: false, reason: "scene_out_of_range", detail: `no scene with index ${sceneIndex}` };
  }
  const scene = scenes[pos]!;
  if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= (scene.clips?.length ?? 0)) {
    return {
      ok: false,
      reason: "clip_out_of_range",
      detail: `scene ${sceneIndex} has ${scene.clips?.length ?? 0} clip(s), asked for ${clipIndex}`,
    };
  }

  const previous = scene.clips[clipIndex]!;
  const nextClip = replacementToClip(replacement);
  const nextClips = scene.clips.map((c, i) => (i === clipIndex ? nextClip : c));
  const nextScene: EditorScene = {
    ...scene,
    clips: nextClips,
    // The scene thumbnail is the first clip's; replacing clip 0 has to move it too, or the
    // dashboard keeps showing a picture that is no longer in the video.
    thumbnailUrl: clipIndex === 0 ? (nextClip.thumbnailUrl ?? nextClip.url) : scene.thumbnailUrl,
  };
  const nextScenes = scenes.map((s, i) => (i === pos ? nextScene : s));
  return { ok: true, scenes: nextScenes, replaced: nextClip, previous };
}

/** `s2c1 archive:57364 (was wikimedia) — "Bundesarchiv Bild 183"` for the edit log. */
export function formatClipEdit(
  sceneIndex: number,
  clipIndex: number,
  previous: EditorClip,
  next: EditorClip
): string {
  const title = next.title ? ` — "${next.title.slice(0, 60)}"` : "";
  const asset = next.archiveAssetId != null ? `archive:${next.archiveAssetId}` : next.source;
  return `[EditorEdit] s${sceneIndex}c${clipIndex} ${asset} (was ${previous.source})${title}`;
}

/**
 * How many clips in this manifest a person has replaced.
 *
 * Read by the quality report so an edited video is not judged as if the pipeline had chosen every
 * picture itself — a human override is a different fact from a sourcing success, and conflating
 * the two would make the render metrics stop meaning anything.
 */
export function countEditedClips(scenes: EditorScene[] | null | undefined): number {
  if (!scenes) return 0;
  return scenes.reduce(
    (n, s) => n + (s.clips ?? []).filter((c) => c.editedByUser === true).length,
    0
  );
}
