/**
 * VID-0589 — A TITLE IS NOT A URL, AND A FLAG IS NOT A CAUSE.
 *
 * ── What render 589 delivered, and what it said about it ────────────────────────────────────
 *
 *     [RenderJob] video=589 job=10 rendering in-process clips=3 alreadyLocal=3
 *     [RenderJob] video=589 route=legacy_compose RENDER_FALLBACK_USED
 *                 reason=CINEMATIC_RENDER_PATH is not enabled
 *     [RenderJob] video=589 the delivered file is the compose montage — ASSET_NOT_REHYDRATABLE —
 *                 clip vc_2c6cad7470: REHYDRATION_DOWNLOAD_FAILED —
 *                 provider=wikimedia host=commons.wikimedia.org (derived)
 *
 * The flag was on. The same deployment's preflight printed `ON CINEMATIC_RENDER_PATH` and the
 * pipeline printed `CINEMATIC_RENDER_PATH=on`. Two lines of the same report named two different
 * causes, and the one built to be grepped named the wrong one.
 *
 * Underneath it, a second defect that is the actual reason the film was lost. The clip's identity
 * was `wikimedia:https://upload.wikimedia.org/wikipedia/commons/9/91/Kardashian-Jenner_family_tree
 * .png?utm_source=commons.wikimedia.org&…` — a MEDIA URL stored where a Commons FILE TITLE
 * belongs. `fetchWikimediaVideos` records the title. `fetchWikimediaImages` recorded the URL. Both
 * readers of a Wikimedia identity are written against the title, so the rehydrator asked Commons
 * for `Special:FilePath/https%3A%2F%2Fupload.wikimedia.org%2F…`, got nothing, and `failFast` ended
 * the cinematic render on its first clip.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That the route line reports the reason it is handed, and that a Wikimedia identity resolves in
 * both the form the fix writes and the form already stored in every existing timeline.
 *
 * RONDE 661 deleted the compose fallback, and `formatRenderRoute` with it. A timeline render that
 * does not deliver now fails the render, and its one route line still carries the render's own
 * reason — which is what §1 below holds.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { sourcePageUrlFor, wikimediaFileTitleFrom } from "./assetIdentity";
import { rehydrationUrlFor } from "./assetRehydrator";

const read = (file: string): string => fs.readFileSync(path.join(__dirname, file), "utf8");

/** The identity render 589 actually carried, character for character. */
const RENDER_589_ID =
  "https://upload.wikimedia.org/wikipedia/commons/9/91/Kardashian-Jenner_family_tree.png" +
  "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original";

/* ═══════════════════ 1. the route line reports the cause it was given ═══════════════════ */

describe("VID-0589 §1 — the route line names what actually happened", () => {
  const PIPE = read("videoPipeline.ts");

  it("a timeline render that did not deliver prints the render's own reason, not a flag", () => {
    expect(PIPE).toContain("route=cinematic_timeline NOT_DELIVERED ");
    expect(PIPE).toContain('`reason=${cinematicRefusalForGate ?? "unknown"}`');
  });

  it("a plan that was not usable is named as such, with the planner's reason", () => {
    expect(PIPE).toContain("`the cinematic plan was not usable: ${outcome.reason}`");
  });

  it("and that same reason is what the render fails with", () => {
    const at = PIPE.indexOf("const deliveredUrl = cinematicDeliveredUrl;");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.slice(at, at + 600)).toContain('cinematicRefusalForGate ?? "no reason was recorded"');
  });

  it("no line claims a fallback that no longer exists", () => {
    expect(PIPE).not.toContain("formatRenderRoute(");
    expect(read("cinematicProduction.ts")).not.toContain("export function formatRenderRoute(");
  });
});

/* ═══════════════════ 2. a Wikimedia identity resolves, in both forms ═══════════════════ */

describe("VID-0589 §2 — the Commons title is read out of whatever was recorded", () => {
  it("render 589's stored identity yields the file Commons indexes", () => {
    expect(wikimediaFileTitleFrom(RENDER_589_ID)).toBe("Kardashian-Jenner_family_tree.png");
  });

  it("a title recorded as a title is returned unchanged, with or without the File: prefix", () => {
    expect(wikimediaFileTitleFrom("File:Reichstag.jpg")).toBe("Reichstag.jpg");
    expect(wikimediaFileTitleFrom("Reichstag.jpg")).toBe("Reichstag.jpg");
  });

  it("a percent-encoded upload URL is decoded to the real file name", () => {
    /** Render 589's other Wikimedia picture; `%40` and `%28` are in the file name itself. */
    const id =
      "https://upload.wikimedia.org/wikipedia/commons/5/59/" +
      "KardashianSisters%40JillStuartShow_9_1110_by_BettinaCirone42_%2810%29.jpg?utm_source=x";
    expect(wikimediaFileTitleFrom(id)).toBe(
      "KardashianSisters@JillStuartShow_9_1110_by_BettinaCirone42_(10).jpg"
    );
  });

  it("a thumbnail URL names the FILE, not the rendition", () => {
    /**
     * `/thumb/` URLs end in a generated `<width>px-` copy. Asking Commons for that name returns
     * nothing; the file is the segment before it. Same class as the round's own rule that a
     * temporary name may never be a canonical identity.
     */
    const id = "https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Berlin_1945.jpg/800px-Berlin_1945.jpg";
    expect(wikimediaFileTitleFrom(id)).toBe("Berlin_1945.jpg");
  });

  it("the two Commons page shapes are read literally", () => {
    expect(wikimediaFileTitleFrom("https://commons.wikimedia.org/wiki/File:Berlin_1945.jpg")).toBe(
      "Berlin_1945.jpg"
    );
    expect(
      wikimediaFileTitleFrom("https://commons.wikimedia.org/wiki/Special:FilePath/Berlin_1945.jpg")
    ).toBe("Berlin_1945.jpg");
  });

  it("a URL no title can be read out of answers null rather than nearly right", () => {
    for (const bad of [
      "",
      "   ",
      "https://example.com/some/picture.jpg",
      "https://commons.wikimedia.org/wiki/Main_Page",
      "https://commons.wikimedia.org/w/api.php?action=query",
      "https://upload.wikimedia.org/",
    ]) {
      expect(wikimediaFileTitleFrom(bad), bad).toBeNull();
    }
  });

  it("the rehydrator asks Commons for a file it has", () => {
    const target = rehydrationUrlFor({ provider: "wikimedia", providerAssetId: RENDER_589_ID });
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("derived");
    expect(target!.url).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Kardashian-Jenner_family_tree.png"
    );
    expect(target!.url, "the URL was being passed off as a title").not.toContain("upload.wikimedia.org");
    expect(target!.url).not.toContain("utm_source");
  });

  it("an id with no title in it falls to the stored media URL instead of a broken derivation", () => {
    /**
     * Declining the derived route is not a silent skip: `mediaUrl` for Wikimedia is a stable upload
     * URL and is the same file. The failure to avoid is asking for a page that cannot exist.
     */
    const target = rehydrationUrlFor({
      provider: "wikimedia",
      providerAssetId: "https://example.com/not-commons.jpg",
      mediaUrl: "https://upload.wikimedia.org/wikipedia/commons/9/91/Held.png",
    });
    expect(target).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/9/91/Held.png",
      kind: "stored",
    });
  });

  it("the rights page points at the file, not at a page named after a URL", () => {
    const page = sourcePageUrlFor("wikimedia", RENDER_589_ID);
    expect(page).toBe(
      "https://commons.wikimedia.org/wiki/File%3AKardashian-Jenner_family_tree.png"
    );
    expect(page).not.toContain("https%3A%2F%2Fupload");
  });

  it("a rights page that cannot be addressed correctly is not offered at all", () => {
    /**
     * The rule `sourcePageUrlFor` already applies to every other provider: a page URL that is
     * nearly right sends a person doing a rights check to the wrong place with no signal.
     */
    expect(sourcePageUrlFor("wikimedia", "https://example.com/elsewhere.jpg")).toBeNull();
  });

  it("a title recorded as a title still resolves exactly as it did", () => {
    expect(sourcePageUrlFor("wikimedia", "File:Reichstag.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/File%3AReichstag.jpg"
    );
    expect(rehydrationUrlFor({ provider: "wikimedia", providerAssetId: "File:Reichstag.jpg" })).toEqual({
      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Reichstag.jpg",
      kind: "derived",
    });
  });
});

/* ═══════════════════ 3. the route that recorded the URL records the title ═══════════════════ */

describe("VID-0589 §3 — every Wikimedia fetcher agrees on what the identity is", () => {
  const pipeline = read("videoPipeline.ts");

  /** Each `tagPathWithProviderAsset(...)` call whose metadata names the given search route. */
  const taggingCalls = (searchRoute: string): string[] => {
    const calls: string[] = [];
    let from = 0;
    for (;;) {
      const idx = pipeline.indexOf(`searchRoute: "${searchRoute}"`, from);
      if (idx < 0) break;
      calls.push(pipeline.slice(pipeline.lastIndexOf("tagPathWithProviderAsset(", idx), idx));
      from = idx + 1;
    }
    return calls;
  };

  /**
   * Both image call sites, not one. The live-search route passed `imageInfo.url` and the
   * scene-candidate-cache route passed `c.url`; fixing either alone leaves the render that takes
   * the other path exactly as broken as 589 was.
   */
  it("every image route tags its download with the Commons title", () => {
    const calls = taggingCalls("fetchWikimediaImages");
    expect(calls.length, "the image tagging call sites moved").toBe(2);
    for (const call of calls) {
      expect(call).toContain('"wikimedia"');
      expect(call, "a media URL is back where the handle belongs").not.toMatch(
        /"wikimedia",\s*\n\s*(imageInfo\.url|c\.url),/
      );
      expect(call).toMatch(/"wikimedia",\s*\n\s*(title|cachedTitle),/);
    }
  });

  it("the video route, which was always right, is unchanged", () => {
    const calls = taggingCalls("fetchWikimediaVideos");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/"wikimedia",\s*\n\s*title,/);
  });

  it("the media URL is still recorded — as the media URL", () => {
    /**
     * `sourceUrl` becomes `mediaUrl` on the identity, which is what it is and where the rehydrator
     * already looks second. Dropping it would trade one loss for another.
     */
    for (const call of taggingCalls("fetchWikimediaImages")) {
      expect(call).toMatch(/sourceUrl: (imageInfo\.url|c\.url),/);
    }
  });

  it("the belief that produced this is gone from the source", () => {
    /**
     * The cached route's own note said "the file URL is Commons' own stable identity for the
     * file". That sentence is the defect; leaving it standing invites the next reader to restore
     * the behaviour it justifies.
     */
    expect(pipeline).not.toContain("own stable identity for the file");
  });
});
