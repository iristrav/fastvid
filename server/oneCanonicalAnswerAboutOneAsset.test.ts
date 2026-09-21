/**
 * ONE CANONICAL ANSWER ABOUT ONE ASSET.
 *
 * ── What render 595 said about `vc_999c384232`, twice, minutes apart ────────────────────────
 *
 *     [AssetIdentity]   … provider=internet_archive assetId=youtube-r6LB5toWr5I
 *                         archiveAssetId=null mediaHost=null page=yes rehydratable=true
 *     [AssetRehydrator] clip=vc_999c384232 … ARCHIVE_REHYDRATE_FAILED status=ASSET_NOT_FOUND
 *                         reason="provider=internet_archive providerAssetId=youtube-r6LB5toWr5I
 *                                 has no fetchable URL"
 *
 * `rehydratable=true` came from `provider && providerAssetId` — "enough to ask the provider
 * again". Nothing in this system asks `internet_archive` for an id: its route IS the stored URL,
 * and that identity had none. The planner believed the first line, planned a 48-second shot around
 * it, and the render died on the second.
 *
 * The rule under test: THE PREDICATE NAMES THE BRANCHES THE REHYDRATOR ACTUALLY TAKES. Where
 * `rehydrateAsset` has no branch, `identityIsRehydratable` says false.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import {
  identityIsRehydratable,
  identityRehydrationRoutes,
  type RehydrationRoute,
} from "./assetIdentity";
import { identityHasRehydrationRoute, rehydrateAsset, rehydrationUrlFor } from "./assetRehydrator";
import { validateTimeline } from "./timelineValidator";
import type { AssetSourceIdentity, ProjectTimeline } from "./projectTimeline";

const id = (over: Partial<AssetSourceIdentity> & { provider: string }): AssetSourceIdentity =>
  over as AssetSourceIdentity;

/* ═══════════════════ THE DEFECT ═══════════════════ */

describe("render 595's clip", () => {
  const CLIP = id({ provider: "internet_archive", providerAssetId: "youtube-r6LB5toWr5I" });

  it("IS NOT REHYDRATABLE, because nothing can fetch it", () => {
    expect(identityRehydrationRoutes(CLIP)).toEqual([]);
    expect(identityIsRehydratable(CLIP)).toBe(false);
  });

  it("and the rehydrator agrees, which is the whole point", () => {
    /**
     * The two answers that disagreed. `rehydrationUrlFor` is the function that would have had to
     * produce a URL, and it produces none — so any predicate that says "yes" is describing work
     * that does not exist.
     */
    expect(rehydrationUrlFor(CLIP)).toBeNull();
    expect(identityHasRehydrationRoute(CLIP)).toBe(false);
  });

  it("A PAGE URL IS NOT A ROUTE — archive.org/details/<id> is for a human", () => {
    /**
     * `sourcePageUrlFor` builds `https://archive.org/details/youtube-r6LB5toWr5I` for this id, and
     * `identityFromAdoption` puts it in `sourcePageUrl`. It is a rights-check destination, not
     * media: fetching it returns a web page. It must never make a clip look recoverable.
     */
    const withPage = id({
      provider: "internet_archive",
      providerAssetId: "youtube-r6LB5toWr5I",
      sourcePageUrl: "https://archive.org/details/youtube-r6LB5toWr5I",
    });
    expect(identityIsRehydratable(withPage)).toBe(false);
    expect(rehydrationUrlFor(withPage)).toBeNull();
  });

  it("the SAME clip with the stored media URL is recoverable, and by that route", () => {
    /** Nothing was made stricter about a clip that can actually be fetched. */
    const withUrl = id({
      provider: "internet_archive",
      providerAssetId: "youtube-r6LB5toWr5I",
      mediaUrl: "https://archive.org/download/youtube-r6LB5toWr5I/file.mp4",
    });
    expect(identityRehydrationRoutes(withUrl)).toEqual(["stored_url"]);
    expect(rehydrationUrlFor(withUrl)?.kind).toBe("stored");
  });

  it("and so is the same clip once FastVid holds it", () => {
    const archived = id({
      provider: "internet_archive",
      providerAssetId: "youtube-r6LB5toWr5I",
      archiveAssetId: 57770,
    });
    expect(identityRehydrationRoutes(archived)).toEqual(["archive"]);
  });
});

/* ═══════════════════ EVERY ROUTE, AGAINST THE BRANCH THAT SERVES IT ═══════════════════ */

describe("each route exists because a branch of rehydrateAsset exists", () => {
  const cases: Array<{ what: string; identity: AssetSourceIdentity; routes: RehydrationRoute[] }> = [
    {
      what: "an archive handle, whatever the provider is called",
      identity: id({ provider: "wwii_archive", archiveAssetId: 57770 }),
      routes: ["archive"],
    },
    {
      what: "an archive handle on an UNVERIFIED clip — render 585's receipt",
      identity: id({ provider: "UNVERIFIED", archiveAssetId: 57449 }),
      routes: ["archive"],
    },
    {
      what: "youtube, through the existing licence layer",
      identity: id({ provider: "youtube_cc", providerAssetId: "gPOOfUxvc0w" }),
      routes: ["youtube"],
    },
    {
      what: "pexels, looked up by id because its CDN link expires",
      identity: id({ provider: "pexels", providerAssetId: "12345" }),
      routes: ["provider_api"],
    },
    {
      what: "wikimedia, when a File: title can be read out of the id",
      identity: id({ provider: "wikimedia", providerAssetId: "Kris_Jenner_2012.jpg" }),
      routes: ["wikimedia_title"],
    },
    {
      what: "a stored URL, for a provider with no id lookup",
      identity: id({ provider: "europeana", providerAssetId: "abc", mediaUrl: "https://e.eu/a.mp4" }),
      routes: ["stored_url"],
    },
  ];

  for (const c of cases) {
    it(c.what, () => {
      expect(identityRehydrationRoutes(c.identity)).toEqual(c.routes);
      expect(identityIsRehydratable(c.identity)).toBe(true);
    });
  }

  it("A PROVIDER NAME ALONE IS NOT A ROUTE", () => {
    expect(identityRehydrationRoutes(id({ provider: "wikimedia" }))).toEqual([]);
    expect(identityRehydrationRoutes(id({ provider: "loc" }))).toEqual([]);
    expect(identityRehydrationRoutes(null)).toEqual([]);
  });

  it("NOR IS AN ID FOR A PROVIDER NOTHING LOOKS UP", () => {
    /**
     * The defect class, stated once for every provider it applies to: `loc`, `nara`, `nasa`,
     * `europeana`, `openverse` and `internet_archive` are all in `REHYDRATABLE_PROVIDERS` — their
     * stored URLs are stable — and for all of them the route IS the stored URL.
     */
    for (const provider of ["loc", "nara", "nasa", "europeana", "openverse", "internet_archive"]) {
      expect(identityRehydrationRoutes(id({ provider, providerAssetId: "x1" })), provider).toEqual([]);
    }
  });

  it("an UNVERIFIED provider cannot be gone back to, media URL or not", () => {
    expect(identityIsRehydratable(id({ provider: "UNVERIFIED", mediaUrl: "https://x/a.mp4" }))).toBe(false);
    /** Case-insensitively, because `identityFromAdoption` lower-cases on the way in. */
    expect(identityIsRehydratable(id({ provider: "unverified", mediaUrl: "https://x/a.mp4" }))).toBe(false);
  });

  it("a wikimedia id no title can be read from is not a route — render 589", () => {
    const unreadable = id({
      provider: "wikimedia",
      providerAssetId: "https://example.invalid/nothing",
    });
    expect(identityRehydrationRoutes(unreadable)).toEqual([]);
  });
});

/* ═══════════════════ THE TWO PREDICATES ARE NOW ONE ═══════════════════ */

describe("nothing may disagree about one asset again", () => {
  const SAMPLES: AssetSourceIdentity[] = [
    id({ provider: "internet_archive", providerAssetId: "youtube-r6LB5toWr5I" }),
    id({ provider: "serpapi", mediaUrl: "https://x/a.jpg" }),
    id({ provider: "wwii_archive", archiveAssetId: 1 }),
    id({ provider: "youtube_cc", providerAssetId: "abc" }),
    id({ provider: "pexels", providerAssetId: "9" }),
    id({ provider: "loc", providerAssetId: "9" }),
    id({ provider: "UNVERIFIED", providerAssetId: "9", mediaUrl: "https://x/a.mp4" }),
    id({ provider: "wikimedia", providerAssetId: "A_file.jpg" }),
  ];

  it("THE PLANNER'S QUESTION AND THE VALIDATOR'S QUESTION HAVE ONE ANSWER", () => {
    /**
     * `identityFrom` asks both — `identityIsRehydratable` and `identityHasRehydrationRoute`. When
     * they could differ, a beat was admitted by one and the whole plan refused by the other, which
     * is render 585. They are the same function now and this is what says so.
     */
    for (const s of SAMPLES) {
      expect(identityHasRehydrationRoute(s), s.provider).toBe(identityIsRehydratable(s));
    }
  });

  it("A FILE THIS RENDER IS HOLDING IS NOT A FILE THIS RENDER HAS LOST", async () => {
    /**
     * F-1, and the ordering defect the honest predicate exposed.
     *
     * `localOnlyIdentityFor` keeps a beat whose clip has NO fetch route because the bytes are on
     * disk now — exactly render 595's `internet_archive` clip. `rehydrateAsset` used to judge the
     * routes in its opening lines, ABOVE the `existingLocalPath` block, so once the predicate
     * stopped over-promising every one of those clips would have been refused over a file we were
     * holding. The file is checked first now.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-"));
    const held = path.join(dir, "held.mp4");
    execFileSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=2",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", held],
      { stdio: "ignore" }
    );
    const noRoute = id({
      provider: "internet_archive",
      providerAssetId: "youtube-r6LB5toWr5I",
      heldLocallyAtRender: true,
    });
    expect(identityIsRehydratable(noRoute)).toBe(false);

    let downloads = 0;
    const result = await rehydrateAsset({
      identity: noRoute,
      workDir: path.join(dir, "work"),
      existingLocalPath: held,
      deps: {
        download: async () => {
          downloads++;
          return false;
        },
      },
    });
    expect(result.status, "a clip on our own disk was refused").toBe("ok");
    if (result.status === "ok") expect(result.localPath).toBe(held);
    expect(downloads, "the network was asked for a file we were holding").toBe(0);
  });

  it("AND THE VALIDATOR ASKS IN THAT SAME ORDER", () => {
    /**
     * The same reversal, one layer up: `local_only_asset` is non-blocking and `missing_asset`
     * blocks, so asking the blocking question first would refuse the whole timeline over the clip
     * `localOnlyIdentityFor` deliberately kept.
     */
    const timeline = {
      version: 1, fps: 30, width: 1920, height: 1080, durationSec: 4,
      tracks: [{
        kind: "VIDEO",
        clips: [{
          id: "vc_held", kind: "video", timelineStart: 0, timelineEnd: 4, sourceIn: 0, sourceOut: 4,
          source: {
            provider: "internet_archive",
            providerAssetId: "youtube-r6LB5toWr5I",
            heldLocallyAtRender: true,
          },
        }],
      }],
    } as unknown as ProjectTimeline;
    const codes = validateTimeline(timeline).issues.map((i) => i.code);
    expect(codes).toContain("local_only_asset");
    expect(codes, "a held clip was reported as missing").not.toContain("missing_asset");
  });

  it("AND A CLIP WITH A ROUTE CAN ALWAYS BE ASKED FOR SOMETHING", () => {
    /**
     * The one direction that must hold structurally: if the predicate says yes, some branch of
     * `rehydrateAsset` can act. Either it is a handle the function resolves itself (archive,
     * youtube, provider_api, wikimedia_title) or `rehydrationUrlFor` produces a URL.
     */
    for (const s of SAMPLES) {
      if (!identityIsRehydratable(s)) continue;
      const routes = identityRehydrationRoutes(s);
      const resolvedElsewhere = routes.some((r) => r !== "stored_url");
      expect(resolvedElsewhere || rehydrationUrlFor(s) != null, s.provider).toBe(true);
    }
  });
});
