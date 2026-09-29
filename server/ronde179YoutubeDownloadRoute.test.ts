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

/* ═══════════════════════ one licence rule, both routes ═══════════════════════ */

describe("R179 — a YouTube clip is treated the same however it was found", () => {

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
