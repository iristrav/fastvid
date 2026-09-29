/**
 * THE ARCHIVE KEPT ONE CLIP PER BEAT AND THREW AWAY EVERY OTHER ONE IT HAD APPROVED.
 *
 * ── The production evidence ──────────────────────────────────────────────────────────────────
 *
 * Render 576, measured in its own log:
 *
 *     downloads                311
 *     clips in the film         14
 *     [Ingestion] lines          0
 *
 * Three hundred and eleven fetches and not one thing learned. The cause is not that ingestion was
 * off — `externalAssetIngestionEnabled()` defaults on — but that the only clip it could ever reach
 * was the beat's WINNER, and then only when that winner came from outside the curated archive.
 * Render 576's beats were largely won by curated archive material, so `winningExternalCandidate`
 * was null and the whole branch was skipped, taking every approved Wikimedia and Internet Archive
 * runner-up with it.
 *
 * Those runners-up were not rejects. `passingScored` is `scored.filter(s => s.visionResult.pass)` —
 * the picture editor looked at them and said they fit. They lost to a clip that fit better, which
 * RONDE 131 already names as a non-verdict in the search-memory context: "Losing to a better
 * candidate is not the memory being wrong."
 *
 * ── What this file pins ──────────────────────────────────────────────────────────────────────
 *
 * That the widening kept every rule it was widened around. RONDE 9's stock ban is the one that
 * matters most: a generic Pexels clip tagged "adolf hitler" once outranked real archive footage on
 * every later Hitler render, and an ingestion path that forgot that would rebuild the same trap
 * with more sources feeding it.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { externalAssetIngestionEnabled } from "./sourcingPolicy";

import { sourceMayEnterCuratedArchive } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The runner-up loop, bounded to itself so a match elsewhere cannot satisfy these. */
const loop = (): string => {
  const at = PIPE.indexOf("for (const s of passingScored) {");
  expect(at, "the approved runners-up are discarded again").toBeGreaterThan(0);
  return PIPE.slice(at, PIPE.indexOf("\n        }", at));
};

/* ═══════════ 1. only what the picture editor approved ═══════════ */

/* ═══════════ 2. RONDE 9's stock ban survived the widening ═══════════ */

describe("stock footage is still never archive material", () => {

  it("THE INGESTION MODULE'S OWN REFUSAL IS ALSO STILL THERE — two independent guards", () => {
    /**
     * `archiveIngestion` refuses stock on the sourceNote prefix regardless of what any caller
     * decides. Both layers matter: this one cannot be bypassed by a future call site.
     */
    const ING = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(ING).toContain('sourcePrefix.startsWith("pexels:") || sourcePrefix.startsWith("pixabay:")');
    expect(ING).toContain("stock footage is never ingested into the curated archive");
  });

});

/* ═══════════ 3. one definition, not two ═══════════ */

describe("the ingestion rule has a single writer", () => {

  it("THE TAGS RULE IS UNCHANGED — narration keywords never become archive tags", () => {
    /**
     * RONDE 9 again: those describe what is SAID, not what is SHOWN. Read at the single writer
     * both routes now use, so the rule is asserted once for both rather than once per route.
     */
    const at = PIPE.indexOf("export function archiveMetadataForExternalClip(");
    expect(at, "the single metadata writer is gone").toBeGreaterThan(-1);
    const body = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(body).toContain("tags: [],");
    expect(body).not.toContain("tags: beat.keywords");
  });
});

/* ═══════════ 4. it stays best-effort and bounded ═══════════ */

/* ═══════════ 5. YouTube is admitted on the same terms as any other real source ═══════════ */

describe("YouTube is neither privileged nor excluded", () => {

  it("THE WINNER PATH DOES NOT BAR IT EITHER", () => {
    const at = PIPE.indexOf("const archiveEligible = !!(");
    const body = PIPE.slice(at, PIPE.indexOf(");", at));
    expect(body).not.toContain("youtube");
  });

});
