/**
 * RONDE 177 — why a saved trim looked unsaved.
 *
 * ── The report ───────────────────────────────────────────────────────────────────────────────
 *
 *     "Hij slaat het bijknippen per clip in het archief nog niet op."
 *
 * ── What was actually happening ──────────────────────────────────────────────────────────────
 *
 * Everything on the write side worked. The range was validated, ffmpeg cut the file, storagePut
 * stored it under a fresh key, both storage columns were updated, the mutation returned
 * `trimmed: true`, the toast fired, and `listAssets` was invalidated and refetched.
 *
 * And then the grid handed the <video> element this:
 *
 *     /api/admin/archive/media/57330
 *
 * — byte for byte the same string it had a second earlier, because the address was built from the
 * asset id and nothing else. The endpoint answers with `Cache-Control: private, max-age=3600`
 * (or a 307 to a signed URL with max-age=300). So the browser never asked: it replayed the
 * untrimmed clip out of its own cache, for the next hour. The whole operation succeeded and left
 * no visible trace, which is indistinguishable from not saving.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * The URL carries which version of the file it means. storagePut gives every write a fresh random
 * key suffix, so the storage identity IS the version — it changes on exactly the events that
 * change the bytes, and on no others. A clip nobody touched keeps its address and stays cached,
 * which is what the hour-long cache is there for.
 */
import { describe, expect, it } from "vitest";
import { archiveMediaVersion, withArchiveMediaVersion } from "@shared/archiveMediaVersion";
import { archiveMediaStreamUrl, editorArchiveMediaUrl } from "./archiveMediaStream";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

/** The same asset before and after a trim: storagePut moved it to a new key. */
const BEFORE = {
  storageUrl: "/local-storage/archive_bundesarchiv-1926_a1b2c3d4.mp4",
  storageKey: "archive/bundesarchiv-1926_a1b2c3d4.mp4",
  durationSec: 20,
};
const AFTER = {
  storageUrl: "/local-storage/archive_bundesarchiv-1926_a1b2c3d4_9f8e7d6c.mp4",
  storageKey: "archive/bundesarchiv-1926_a1b2c3d4_9f8e7d6c.mp4",
  durationSec: 8.52,
};

/* ═══════════════════════ the bug, stated as a fact ═══════════════════════ */

describe("THE BUG: an id-only URL cannot tell the two files apart", () => {
  it("the address the browser cached is identical before and after the trim", () => {
    /**
     * This is the whole defect in one line. Both sides of this comparison are what the grid used
     * to send, and the browser has no way to know the second one means different bytes.
     */
    const idOnly = (id: number) => `/api/admin/archive/media/${id}`;
    expect(idOnly(57330)).toBe(idOnly(57330));
  });

  it("with the version token they differ", () => {
    expect(archiveMediaStreamUrl(57330, BEFORE)).not.toBe(archiveMediaStreamUrl(57330, AFTER));
  });
});

/* ═══════════════════════ the token ═══════════════════════ */

describe("the version token tracks the file, not the clock", () => {
  it("a clip nobody touched keeps its token, so it stays cached", () => {
    // Re-rendering the grid must not bust the cache for 48 untouched clips.
    expect(archiveMediaVersion(BEFORE)).toBe(archiveMediaVersion({ ...BEFORE }));
  });

  it("a new storage key is a new token", () => {
    expect(archiveMediaVersion(BEFORE)).not.toBe(archiveMediaVersion(AFTER));
  });

  it("a changed duration alone is also a new token", () => {
    // Belt and braces: a re-encode that somehow reused a key still busts the cache.
    expect(archiveMediaVersion(BEFORE)).not.toBe(archiveMediaVersion({ ...BEFORE, durationSec: 8.52 }));
  });

  it("it is short and URL-safe — it goes in a query string", () => {
    const token = archiveMediaVersion(AFTER);
    expect(token).toMatch(/^[0-9a-z]{1,8}$/);
  });

  it("a row with no storage identity at all still produces a token rather than throwing", () => {
    expect(() => archiveMediaVersion({})).not.toThrow();
    expect(archiveMediaVersion({})).toBeTruthy();
  });
});

describe("withArchiveMediaVersion appends without mangling the address", () => {
  it("adds ?v= to a bare path", () => {
    expect(withArchiveMediaVersion("/api/admin/archive/media/9", BEFORE)).toBe(
      `/api/admin/archive/media/9?v=${archiveMediaVersion(BEFORE)}`
    );
  });

  it("adds &v= when the path already carries a query", () => {
    const out = withArchiveMediaVersion("/api/admin/archive/media/9?x=1", BEFORE);
    expect(out).toContain("?x=1&v=");
    expect(out).not.toContain("??");
  });

  it("leaves the address alone when no row is available", () => {
    // The editor manifest has call sites with only an id. They must keep working, unversioned.
    expect(withArchiveMediaVersion("/api/editor/archive/media/9", undefined)).toBe(
      "/api/editor/archive/media/9"
    );
  });
});

/* ═══════════════════════ both routes ═══════════════════════ */

describe("both stream helpers version their URL", () => {
  it("the admin route keeps its own prefix", () => {
    expect(archiveMediaStreamUrl(57330, AFTER)).toMatch(/^\/api\/admin\/archive\/media\/57330\?v=/);
  });

  it("the editor route keeps its own prefix", () => {
    expect(editorArchiveMediaUrl(57330, AFTER)).toMatch(/^\/api\/editor\/archive\/media\/57330\?v=/);
  });

  it("the two routes stay distinct for the same asset", () => {
    expect(archiveMediaStreamUrl(57330, AFTER)).not.toBe(editorArchiveMediaUrl(57330, AFTER));
  });

  it("the id is still the only thing the SERVER reads", () => {
    /**
     * The token exists to be different, not to be read. If the route ever started resolving the
     * asset through `v`, a stale bookmark would serve the wrong clip.
     */
    const src = read("server/archiveMediaStream.ts");
    const route = src.slice(src.indexOf("async function streamArchiveAsset("), src.indexOf("export function registerArchiveMediaRoute"));
    expect(route).toContain("getMediaArchiveAssetById(assetId)");
    expect(route, "the stream must not resolve anything from the version token").not.toContain("req.query");
  });
});

/* ═══════════════════════ the call sites that had the bug ═══════════════════════ */

describe("the archive grid builds its preview URL from the row", () => {
  const grid = () => read("client/src/components/admin/ArchiveClipsGrid.tsx");

  it("archiveClipMediaUrl takes the asset, not a bare id", () => {
    const src = grid();
    const idx = src.indexOf("function archiveClipMediaUrl(");
    expect(idx).toBeGreaterThan(0);
    const sig = src.slice(idx, src.indexOf("\n}", idx));
    expect(sig).toContain("withArchiveMediaVersion");
    expect(sig, "an id-only signature cannot know which file it means").not.toMatch(
      /function archiveClipMediaUrl\(assetId: number\)/
    );
  });

  it("every call site passes the asset", () => {
    const src = grid();
    const calls = src.match(/archiveClipMediaUrl\([^)]*\)/g) ?? [];
    // The definition plus its call sites; none of them may pass `asset.id`.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call, `${call} still passes an id`).not.toContain("asset.id");
    }
  });

  it("the video element's effect re-runs when that URL changes", () => {
    /**
     * A new URL that never reaches the element changes nothing. LazyArchiveMedia computes
     * `mediaSrc` and sets it from an effect — mediaSrc has to be in that effect's dependencies.
     */
    const src = grid();
    const idx = src.indexOf("function LazyArchiveMedia(");
    const body = src.slice(idx, src.indexOf("const issue = mediaIssueLabel", idx));
    expect(body).toContain("[asset.id, canLoad, mediaSrc, mode]");
  });

  it("the rule has ONE definition, in shared/", () => {
    /**
     * The admin grid, the stream helpers and the editor manifest all build this URL. Three copies
     * is how one of them silently stops matching — the same reason RONDE 108 moved
     * validateTrimRange to shared/.
     */
    expect(grid()).toContain('from "@shared/archiveMediaVersion"');
    expect(read("server/archiveMediaStream.ts")).toContain('from "@shared/archiveMediaVersion"');
  });
});

describe("the editor manifest versions from the live row", () => {
  it("editorClipFromArchiveAsset passes the asset it was handed", () => {
    const src = read("server/editorClips.ts");
    const idx = src.indexOf("export function editorClipFromArchiveAsset(");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, src.indexOf("\n}", idx));
    expect(body).toContain("editorArchiveMediaUrl(asset.id, asset)");
  });
});
