/**
 * RONDE 139 — the editor can finally change something.
 *
 * ── What existed, and what did not ───────────────────────────────────────────────────────────
 *
 * Every render has written an editor manifest for a long time: buildEditorScenesFromPipeline makes
 * EditorScene[], updateVideoScenes stores it in `videoScenes`, and `editedVideoUrl` sits waiting
 * for a re-render nobody ever asked for.
 *
 * Nothing could CHANGE it. No route read the manifest, none wrote it, and updateEditedVideoUrl had
 * no caller anywhere in the codebase. A render that got seventeen beats right and three wrong was
 * finished — the three wrong ones stayed wrong. Video 558 shipped with 19 of 22 beats lacking their
 * own approved picture and there was no way to fix a single one of them.
 *
 * That is the gap Vidrush closes with "click a visual on the timeline, then Replace Media", and it
 * is why a 70%-correct draft is a usable video for them and a write-off for us.
 *
 * ── The rule these tests exist to protect ────────────────────────────────────────────────────
 *
 * A REPLACEMENT MAY NOT LAUNDER A SOURCE.
 *
 * `source` on a manifest clip is what the quality report counts, what the lineage ledger reconciles
 * against, and what RONDE 87 spent a whole round making impossible to guess. An editor that let a
 * pasted URL inherit the replaced clip's provider would make the manifest the one place in the
 * pipeline where provenance can be invented.
 */
import { describe, expect, it } from "vitest";
import {
  countEditedClips,
  formatClipEdit,
  isAcceptableReplacementUrl,
  replaceClipInScenes,
  replacementToClip,
  type ClipReplacement,
} from "./videoEditorEdits";
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";
import type { EditorClip, EditorScene } from "./db";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

function clip(over: Partial<EditorClip> = {}): EditorClip {
  return { url: "https://cdn.example/a.mp4", type: "video", source: "wikimedia", ...over };
}

function manifest(): EditorScene[] {
  return [
    {
      sceneIndex: 0,
      narration: "In Berlin, amidst the chaos of March 1945",
      durationMs: 21_000,
      clips: [clip({ url: "https://cdn.example/s0c0.mp4" }), clip({ url: "https://cdn.example/s0c1.mp4" })],
      thumbnailUrl: "https://cdn.example/s0c0.jpg",
    },
    {
      sceneIndex: 1,
      narration: "Hermann Göring had already left the city",
      durationMs: 43_000,
      clips: [clip({ url: "https://cdn.example/s1c0.mp4", source: "internet_archive" })],
    },
  ];
}

const ARCHIVE: ClipReplacement = {
  kind: "archive",
  archiveAssetId: 57364,
  url: "/api/admin/archive/media/57364?v=abc",
  mediaType: "video",
  title: "Bundesarchiv Bild 183",
  provider: "WW2",
  storageUrl: "/manus-storage/archive/x.mp4",
};

const PASTED: ClipReplacement = {
  kind: "url",
  url: "https://upload.wikimedia.org/x.jpg",
  mediaType: "image",
  title: "something a person found",
};

/* ═══════════════════════ provenance ═══════════════════════ */

describe("RONDE 139 — a replacement may not launder a source", () => {
  it("a PASTED URL is always UNVERIFIED, whatever it replaced", () => {
    /**
     * The single most important assertion here. The clip being replaced is a wikimedia clip; the
     * replacement must not inherit that name, because nothing verified it.
     */
    const before = manifest();
    expect(before[0]!.clips[0]!.source).toBe("wikimedia");
    const result = replaceClipInScenes(before, 0, 0, PASTED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replaced.source).toBe(UNVERIFIED_PROVIDER);
      expect(result.replaced.archiveAssetId).toBeUndefined();
    }
  });

  it("an ARCHIVE replacement may name its archive, because the row was ingested here", () => {
    const result = replaceClipInScenes(manifest(), 0, 0, ARCHIVE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replaced.source).toBe("ww2");
      expect(result.replaced.archiveAssetId).toBe(57364);
      expect(result.replaced.storageUrl).toBe("/manus-storage/archive/x.mp4");
    }
  });

  it("an archive replacement with a blank provider still falls back to UNVERIFIED", () => {
    // A name that is not there is not a provider; it must not become an empty-string source.
    const r = replacementToClip({ ...ARCHIVE, provider: "   " });
    expect(r.source).toBe(UNVERIFIED_PROVIDER);
  });

  it("every replacement is marked as chosen by a person", () => {
    /**
     * A human override and a sourcing success are different facts. The quality report counts
     * coverage; conflating the two would make an edited video look like the pipeline had found
     * every picture itself.
     */
    expect(replacementToClip(PASTED).editedByUser).toBe(true);
    expect(replacementToClip(ARCHIVE).editedByUser).toBe(true);
    const edited = replaceClipInScenes(manifest(), 0, 1, PASTED);
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(countEditedClips(edited.scenes)).toBe(1);
  });

  it("countEditedClips ignores clips the pipeline chose", () => {
    expect(countEditedClips(manifest())).toBe(0);
    expect(countEditedClips(null)).toBe(0);
  });
});

/* ═══════════════════════ what may be pasted ═══════════════════════ */

describe("RONDE 139 — the URLs a replacement may point at", () => {
  it("accepts http(s) and this system's own storage paths", () => {
    expect(isAcceptableReplacementUrl("https://upload.wikimedia.org/x.jpg")).toBe(true);
    expect(isAcceptableReplacementUrl("http://example.org/a.mp4")).toBe(true);
    expect(isAcceptableReplacementUrl("/manus-storage/archive/x.mp4")).toBe(true);
    expect(isAcceptableReplacementUrl("/local-storage/y.mp4")).toBe(true);
    expect(isAcceptableReplacementUrl("/api/admin/archive/media/57364?v=abc")).toBe(true);
  });

  it("refuses what a worker cannot re-fetch later", () => {
    /**
     * A manifest is read long after the browser that produced it has gone. data: and blob: are
     * meaningless by then, and file: would point at the worker's own disk.
     */
    expect(isAcceptableReplacementUrl("data:image/png;base64,iVBORw0KG")).toBe(false);
    expect(isAcceptableReplacementUrl("blob:https://app/12345")).toBe(false);
    expect(isAcceptableReplacementUrl("file:///etc/passwd")).toBe(false);
    expect(isAcceptableReplacementUrl("javascript:alert(1)")).toBe(false);
  });

  it("refuses credentials in a URL that will be stored and logged", () => {
    expect(isAcceptableReplacementUrl("https://user:pass@example.org/a.mp4")).toBe(false);
  });

  it("refuses empty and absurd input", () => {
    expect(isAcceptableReplacementUrl("")).toBe(false);
    expect(isAcceptableReplacementUrl("   ")).toBe(false);
    expect(isAcceptableReplacementUrl(`https://e.org/${"a".repeat(2100)}`)).toBe(false);
    expect(isAcceptableReplacementUrl("not a url at all")).toBe(false);
  });

  it("a bad URL is refused by the edit itself, not only by the helper", () => {
    const r = replaceClipInScenes(manifest(), 0, 0, { ...PASTED, url: "data:image/png;base64,AA" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_url");
  });
});

/* ═══════════════════════ the edit itself ═══════════════════════ */

describe("RONDE 139 — replacing a clip", () => {
  it("changes exactly one slot and leaves everything else alone", () => {
    const before = manifest();
    const r = replaceClipInScenes(before, 0, 1, ARCHIVE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenes[0]!.clips[0]!.url).toBe("https://cdn.example/s0c0.mp4"); // untouched
    expect(r.scenes[0]!.clips[1]!.archiveAssetId).toBe(57364); // replaced
    expect(r.scenes[1]!.clips[0]!.url).toBe("https://cdn.example/s1c0.mp4"); // other scene untouched
    expect(r.scenes[0]!.narration).toBe(before[0]!.narration);
    expect(r.scenes[0]!.durationMs).toBe(before[0]!.durationMs);
  });

  it("does not mutate the manifest it was given", () => {
    /**
     * The caller persists the result and returns it to the client in one breath. An in-place edit
     * that then failed to persist would leave the two disagreeing about what the video contains.
     */
    const before = manifest();
    const snapshot = JSON.stringify(before);
    replaceClipInScenes(before, 0, 0, ARCHIVE);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("moves the scene thumbnail when clip 0 changes", () => {
    // Otherwise the dashboard keeps showing a picture that is no longer in the video.
    const r = replaceClipInScenes(manifest(), 0, 0, ARCHIVE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scenes[0]!.thumbnailUrl).toBe(ARCHIVE.url);
  });

  it("leaves the thumbnail alone when a later clip changes", () => {
    const r = replaceClipInScenes(manifest(), 0, 1, ARCHIVE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scenes[0]!.thumbnailUrl).toBe("https://cdn.example/s0c0.jpg");
  });

  it("addresses a scene by its OWN index, not by array position", () => {
    /**
     * A manifest may be sparse or reordered. Using position would edit a different scene than the
     * one the user clicked, silently.
     */
    const sparse: EditorScene[] = [
      { sceneIndex: 5, narration: "five", durationMs: 1000, clips: [clip()] },
      { sceneIndex: 2, narration: "two", durationMs: 1000, clips: [clip()] },
    ];
    const r = replaceClipInScenes(sparse, 2, 0, ARCHIVE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scenes[1]!.clips[0]!.archiveAssetId).toBe(57364);
      expect(r.scenes[0]!.clips[0]!.archiveAssetId).toBeUndefined();
    }
  });

  it("REFUSES an out-of-range index rather than clamping it", () => {
    /**
     * Clamping would edit a different clip than the one that was clicked. An error the user can see
     * is better than a silent edit of the wrong thing.
     */
    const tooFar = replaceClipInScenes(manifest(), 0, 99, ARCHIVE);
    expect(tooFar.ok).toBe(false);
    if (!tooFar.ok) expect(tooFar.reason).toBe("clip_out_of_range");

    const noScene = replaceClipInScenes(manifest(), 42, 0, ARCHIVE);
    expect(noScene.ok).toBe(false);
    if (!noScene.ok) expect(noScene.reason).toBe("scene_out_of_range");

    for (const bad of [-1, 1.5, NaN]) {
      const r = replaceClipInScenes(manifest(), 0, bad, ARCHIVE);
      expect(r.ok, `clipIndex ${bad} was accepted`).toBe(false);
    }
  });

  it("says so when there is no manifest at all", () => {
    for (const empty of [null, undefined, [] as EditorScene[]]) {
      const r = replaceClipInScenes(empty, 0, 0, ARCHIVE);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("no_manifest");
    }
  });

  it("returns what was there before, so the edit can be reported", () => {
    const r = replaceClipInScenes(manifest(), 1, 0, PASTED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.previous.source).toBe("internet_archive");
      expect(formatClipEdit(1, 0, r.previous, r.replaced)).toContain("was internet_archive");
      expect(formatClipEdit(1, 0, r.previous, r.replaced)).toContain("s1c0");
    }
  });
});

/* ═══════════════════════ the routes ═══════════════════════ */

describe("RONDE 139 — the tRPC surface", () => {
  const routers = () => read("server/routers.ts");

  it("both routes check ownership with the same guard `get` uses", () => {
    const src = routers();
    const scenes = src.slice(src.indexOf("getScenes: protectedProcedure"), src.indexOf("replaceClip: protectedProcedure"));
    expect(scenes).toContain("requireVideoAccess(await getVideoById(input.id), ctx)");
    const replace = src.slice(src.indexOf("replaceClip: protectedProcedure"), src.indexOf("getVideoUrl: protectedProcedure"));
    expect(replace).toContain("requireVideoAccess(await getVideoById(input.id), ctx)");
  });

  it("THE LAUNDERING GUARD: the provider comes from the ROW, never from the request", () => {
    /**
     * The input schema for an archive replacement accepts an id and a media type and nothing else.
     * A client that could send `provider` would be able to write any name it liked into the
     * manifest, which is exactly what videoEditorEdits refuses to allow.
     */
    const src = routers();
    const replace = src.slice(src.indexOf("replaceClip: protectedProcedure"), src.indexOf("getVideoUrl: protectedProcedure"));
    const archiveSchema = replace.slice(replace.indexOf('kind: z.literal("archive")'), replace.indexOf('kind: z.literal("url")'));
    expect(archiveSchema).toContain("archiveAssetId: z.number().int().positive()");
    expect(archiveSchema, "a client must not be able to name its own provider").not.toContain("provider:");
    expect(archiveSchema, "nor its own URL").not.toContain("url:");
    // ...and the route looks the row up instead.
    expect(replace).toContain("getMediaArchiveAssetById(input.replacement.archiveAssetId)");
    expect(replace).toContain("archiveMediaStreamUrl(asset.id, asset)");
  });

  it("a refused edit answers with its reason instead of throwing", () => {
    // Every rejection is something the person clicking can see and correct.
    const src = routers();
    const replace = src.slice(src.indexOf("replaceClip: protectedProcedure"), src.indexOf("getVideoUrl: protectedProcedure"));
    expect(replace).toContain("return { ok: false as const, reason: result.reason, detail: result.detail };");
    expect(replace).toContain("updateVideoScenes(input.id, result.scenes)");
  });

  it("the decision is not duplicated in the router", () => {
    /**
     * The router persists and reports; videoEditorEdits decides. A second copy of the bounds
     * checking here is how the two would drift apart.
     */
    const src = routers();
    const replace = src.slice(src.indexOf("replaceClip: protectedProcedure"), src.indexOf("getVideoUrl: protectedProcedure"));
    expect(replace).toContain("replaceClipInScenes(scenes, input.sceneIndex, input.clipIndex, replacement)");
    expect(replace).not.toContain("clips.length");
  });
});
