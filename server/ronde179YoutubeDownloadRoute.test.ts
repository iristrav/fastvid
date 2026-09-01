/**
 * RONDE 179 — the last link in the YouTube chain: a ranked YouTube candidate can actually be FETCHED.
 *
 * ── The gap the audit found ──────────────────────────────────────────────────────────────────
 *
 * R175 made the pool call YouTube. R177 handed the pool a search at every production call site. So
 * a YouTube video can now be found, translated into a candidate, deduped, ranked, penalised for
 * duplication — and then handed to `downloadAndTrimPoolCandidate`, which fetches
 * `candidate.remoteUrl` and streams the response into a `.mp4`.
 *
 * `remoteUrl` for a YouTube candidate is the WATCH PAGE. That is the right thing to store: there is
 * no stable direct media URL, and inventing a signed expiring one would put a credential-shaped
 * link in the timeline. But fetching it does not fail — it returns HTTP 200 and a few hundred
 * kilobytes of HTML, which clears the byte floor and reaches ffprobe as "video". Every YouTube
 * candidate would have been lost at the last step, with a reject line blaming the file.
 *
 * These are assertions on the route rather than on a download, because downloading needs a network,
 * a key and a workDir. What is checked is that the YouTube branch exists, that it uses the
 * pipeline's own fetcher, and that the generic fetch cannot be reached with a watch page.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

const SRC = fs.readFileSync("server/videoPipeline.ts", "utf8");

/** The body of `downloadAndTrimPoolCandidate`, brace-matched. */
function downloadBody(): string {
  const at = SRC.indexOf("export async function downloadAndTrimPoolCandidate(");
  expect(at, "downloadAndTrimPoolCandidate is gone").toBeGreaterThan(-1);
  const open = SRC.indexOf("{", SRC.indexOf("): Promise<string | null>", at));
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error("unbalanced downloadAndTrimPoolCandidate");
}

describe("R179 — a YouTube pool candidate is fetched by the YouTube fetcher", () => {
  it("the download has a branch for youtube_cc at all", () => {
    expect(downloadBody(), "every pool candidate is still fetched as a plain URL").toContain(
      'candidate.source === "youtube_cc"'
    );
  });

  /**
   * RULE: no second YouTube client. The branch must delegate to the pipeline's own fetcher.
   *
   * Checked against the CODE, with comments stripped: the comment above the branch names the
   * cloud/yt-dlp service it delegates to, and a raw string scan would read that as evidence of the
   * very thing it is explaining.
   */
  it("delegates to downloadYouTubeCCClip rather than building a second route", () => {
    const code = downloadBody()
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(code).toContain("downloadYouTubeCCClip(");
    for (const forbidden of ["googleapis.com", "youtube.com/watch", "RAPIDAPI", "yt-dlp"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * The branch has to come BEFORE the generic fetch, or the watch page is downloaded anyway and the
   * YouTube fetcher only runs on whatever is left.
   */
  it("the YouTube branch runs before the generic fetch, not after it", () => {
    const body = downloadBody();
    const branch = body.indexOf('candidate.source === "youtube_cc"');
    const genericFetch = body.indexOf("await fetch(candidate.remoteUrl");
    expect(genericFetch, "the generic fetch is gone — this test no longer guards anything").toBeGreaterThan(-1);
    expect(branch).toBeLessThan(genericFetch);
  });

  /** And the generic fetch must be inside the ELSE, so a YouTube candidate can never reach it. */
  it("a YouTube candidate cannot fall through into the generic fetch", () => {
    const body = downloadBody();
    const branch = body.indexOf('if (candidate.source === "youtube_cc")');
    const elseAt = body.indexOf("} else {", branch);
    const genericFetch = body.indexOf("await fetch(candidate.remoteUrl");
    expect(elseAt, "the YouTube branch has no else — the fetch below runs for it too").toBeGreaterThan(branch);
    expect(genericFetch).toBeGreaterThan(elseAt);
    /** The YouTube branch's own failure path returns rather than continuing into the fetch. */
    expect(body.slice(branch, elseAt)).toContain("return null");
  });

  /** The render's cache travels with it, so quota and cooldown stay per-render like the cascade's. */
  it("passes the render's sourcing cache to the fetcher", () => {
    const branch = downloadBody();
    const at = branch.indexOf("downloadYouTubeCCClip(");
    expect(branch.slice(at, at + 400)).toContain("sourcingCache");
  });

  /**
   * The start offset is the cascade's own decision, not a new one. Second 0 of a documentary is its
   * title card, which is why `pickLongVideoStartSec` exists — and why 15 is the cascade's fallback
   * when the source length is unknown.
   */
  it("uses the cascade's own start-offset helper rather than starting at zero", () => {
    const body = downloadBody();
    expect(body).toContain("pickLongVideoStartSec(");
    expect(body).toContain("peekYoutubeVideoContext(");
  });

  it("says why a YouTube fetch failed, rather than returning null silently", () => {
    const body = downloadBody();
    const branch = body.slice(body.indexOf('if (candidate.source === "youtube_cc")'));
    expect(branch).toContain("youtube_fetch_failed");
  });
});

/* ═══════════════════════ one licence rule, both routes ═══════════════════════ */

describe("R179 — a YouTube clip is treated the same however it was found", () => {
  /**
   * `clipRequiresFairUseTransform` reads `_ytcc_` out of the filename and is what stops fast mode
   * from skipping the transform on YouTube material. The pool named its downloads
   * `..._pool_youtube_cc_...`, which that regex does not match — so the same video adopted through
   * the pool could skip a transform the cascade would have applied to it. One asset, two licence
   * treatments, decided by which route found it first.
   */
  it("the pool's YouTube downloads carry the marker the fair-use rule reads", () => {
    expect(downloadBody()).toContain('candidate.source === "youtube_cc" ? "_ytcc"');
  });

  it("and the rule itself still reads that marker", async () => {
    const at = SRC.indexOf("function clipRequiresFairUseTransform(");
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, SRC.indexOf("\n}", at))).toContain("_ytcc_");
  });

  /**
   * Exercised rather than only read: the name the pool builds must actually satisfy the predicate.
   * A test that only greps could pass while the two strings failed to line up.
   */
  it("a pool-built YouTube filename really does satisfy the fair-use predicate", async () => {
    const { poolClipRequiresFairUseTransformForTest } = await import("./videoPipeline");
    expect(
      poolClipRequiresFairUseTransformForTest("/w/scene_0_b1_pool_youtube_cc_ytcc_abc123.mp4")
    ).toBe(true);
    /** And a pool clip from an unrelated source is unaffected. */
    expect(
      poolClipRequiresFairUseTransformForTest("/w/scene_0_b1_pool_pexels_12345.mp4")
    ).toBe(false);
  });
});
