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

describe("only approved clips are kept", () => {
  it("THE LOOP READS `passingScored`, WHICH IS THE VISION-PASSED SET", () => {
    expect(loop()).toBeTruthy();
    /**
     * The set is built from the verdict, not from the score. A clip Vision refused never appears
     * in it, so it cannot be ingested by this route at all.
     *
     * ── RONDE 631: that claim was only half true, and this is the half it missed ─────────────
     *
     * This assertion used to pin the literal `scored.filter(s => s.visionResult.pass)` — and
     * `visionResult.pass` is only the FUNNEL's verdict, a CLIP-similarity score. The beat image
     * gate is a second judgement, by a model that looks at the frames, and it records refusals in
     * `dedup.beatImageRejectedIds`. That set was not read here.
     *
     * Render 599 is what it cost. Scene 1 beat 1, the same second in the same log:
     *
     *     …providerAssetId=OqFhvKarYjU stage=REMOVED status=REJECTED reason=vision_rejected:s1b1
     *     …providerAssetId=rPCWO-wZaLo stage=REMOVED status=REJECTED reason=vision_rejected:s1b1
     *     [Ingestion] s1b1 keeping 2 approved runner-up clip(s) the picture editor passed
     *
     * Two clips the picture editor refused, queued into the curated archive as approved. The
     * claim this test makes is the right claim; the literal it pinned did not deliver it.
     *
     * So the assertion is WIDENED rather than replaced: both verdicts must now be read, and the
     * second expectation is what would have caught render 599.
     */
    expect(PIPE).toContain(".filter(s => s.visionResult.pass)");
    expect(
      PIPE,
      "a clip the beat image gate refused can still be ingested as approved"
    ).toContain(".filter(s => !dedup.beatImageRejectedIds.has(s.candidate.id));");
  });

  it("A REFUSED CLIP IS STILL DISCARDED — the gate did not become a door", () => {
    /**
     * `scored` holds every judged candidate including the refused ones. Iterating THAT would
     * archive material the editor turned down, which is the one thing this change must not do.
     */
    expect(loop(), "the loop reads the unfiltered set").not.toContain("of scored");
  });

  it("THE WINNER IS NOT INGESTED TWICE", () => {
    expect(loop()).toContain("if (s === winner) continue;");
  });
});

/* ═══════════ 2. RONDE 9's stock ban survived the widening ═══════════ */

describe("stock footage is still never archive material", () => {
  it("PEXELS AND PIXABAY ARE BARRED IN THE NEW LOOP TOO", () => {
    const body = loop();
    expect(body, "the self-poisoning loop is reachable again").toContain(
      'if (src === "pexels" || src === "pixabay") continue;'
    );
  });

  it("AND ON THE WINNER'S OWN PATH, exactly as RONDE 9 wrote it", () => {
    /**
     * ARCHIVE-FIRST ROUND — the inline source names became `sourceMayEnterCuratedArchive` when the
     * scene-pool route needed the same rule. The guard is untouched in substance and now has two
     * readers, so this asserts the RULE (by running it) and that the winner's path asks for it.
     */
    const at = PIPE.indexOf("const archiveEligible = !!(");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.slice(at, at + 900)).toContain(
      "sourceMayEnterCuratedArchive(winningExternalCandidate.source)"
    );
    expect(sourceMayEnterCuratedArchive("pexels")).toBe(false);
    expect(sourceMayEnterCuratedArchive("pixabay")).toBe(false);
  });

  it("THE INGESTION MODULE'S OWN REFUSAL IS ALSO STILL THERE — two independent guards", () => {
    /**
     * `archiveIngestion` refuses stock on the sourceNote prefix regardless of what any caller
     * decides. Both layers matter: this one cannot be bypassed by a future call site.
     */
    const ING = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(ING).toContain('sourcePrefix.startsWith("pexels:") || sourcePrefix.startsWith("pixabay:")');
    expect(ING).toContain("stock footage is never ingested into the curated archive");
  });

  it("a clip already IN the archive is not re-ingested as a copy of itself", () => {
    expect(loop()).toContain('if (src === "archive") continue;');
  });
});

/* ═══════════ 3. one definition, not two ═══════════ */

describe("the ingestion rule has a single writer", () => {
  /**
   * MEDIA ARCHIVE ROUND — THE TWO ROUTES ARE NOW DIFFERENT ON PURPOSE, AND SHARE ONE WRITER.
   *
   * The claim this test has always made is that a rule many call sites must follow is not
   * registered by a few — two hand-written metadata blocks drift the moment one gains a field. That
   * claim is unchanged and is asserted harder below: there is exactly ONE metadata definition.
   *
   * What changed is why the two routes differ. The WINNER is the clip this beat will use, so it has
   * to be in FastVid's archive, read back, and holding an `archiveAssetId` before the cinematic
   * planner reads this beat's identity — otherwise the renderer has to go back to the provider for
   * a file the system already holds, which is the failure this round exists to end. It is awaited.
   * The RUNNERS-UP are kept for future renders' searches; nothing in this render waits on them, and
   * they stay exactly as fire-and-forget as they were.
   */
  it("BOTH THE WINNER AND THE RUNNERS-UP GO THROUGH ONE METADATA WRITER", () => {
    expect((PIPE.match(/const archiveMetadataFor = \(/g) ?? []).length).toBe(1);
    expect(PIPE).toContain("archiveMetadataFor(winningExternalCandidate)");
    /** The runners-up keep their own best-effort helper, with its one call site. */
    expect((PIPE.match(/const queueArchiveIngestion = \(/g) ?? []).length).toBe(1);
    expect((PIPE.match(/queueArchiveIngestion\(/g) ?? []).length).toBe(2);
    expect(PIPE).toContain("queueArchiveIngestion(s.clipPath, s.candidate);");
  });

  it("THE WINNER IS STORED AND AWAITED, so the timeline can reference an archive asset", () => {
    /**
     * ARCHIVE-FIRST ROUND — the store moved behind `storeExternalClipForTimeline` so the funnel,
     * the scene-pool route and the two web-wide rescue routes share ONE persistence semantic.
     * The claim is unchanged and tightened: the winner's clip is still passed, still awaited, and
     * `storeForProduction` now has exactly one call site in the file rather than merely at least
     * one — a second route cannot grow its own store without failing here.
     */
    expect(PIPE, "the winner's archive handle is not obtained before the timeline is planned")
      .toContain("await storeExternalClipForTimeline({");
    /**
     * Anchored on the FUNNEL's own guard: the shared wrapper now has four call sites, and the
     * first one in the file is a web-wide rescue route. An unanchored search reads the wrong one.
     */
    const guard = PIPE.indexOf("if (archiveEligible && funnelClip && winningExternalCandidate) {");
    expect(guard).toBeGreaterThan(-1);
    const at = PIPE.indexOf("await storeExternalClipForTimeline({", guard);
    expect(at).toBeGreaterThan(guard);
    const call = PIPE.slice(at, at + 600);
    expect(call).toContain("clipPath: funnelClip,");
    expect(call).toContain('route: "funnel",');
    expect((PIPE.match(/await storeForProduction\(\{/g) ?? []).length).toBe(1);
    expect(PIPE).toContain("localPath: clipPath,");
    /** And the handle is CARRIED — the line whose absence caused the whole failure. */
    expect(PIPE).toContain("attachArchiveAssetToPath(");
  });

  it("AND STILL EXACTLY ONE CALL TO THE INGESTION HELPER ITSELF on this route", () => {
    const at = PIPE.indexOf("const queueArchiveIngestion = (");
    const body = PIPE.slice(at, PIPE.indexOf("\n        };", at));
    expect((body.match(/await ingestExternalClipToArchive\(/g) ?? []).length).toBe(1);
  });

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

describe("a render is never slowed or failed by what it is learning", () => {
  it("INGESTION IS FIRE-AND-FORGET, and a failure is swallowed", () => {
    const at = PIPE.indexOf("const queueArchiveIngestion = (");
    const body = PIPE.slice(at, PIPE.indexOf("\n        };", at));
    expect(body).toContain("void (async () => {");
    expect(body).toContain("// best-effort: never block video production");
  });

  it("THE LOOP AWAITS NOTHING — the beat moves on", () => {
    expect(loop(), "the beat now waits for an upload").not.toContain("await");
  });

  it("IT IS BOUNDED BY THE EXISTING SHORTLIST CAP, with no new budget invented", () => {
    /**
     * `passingScored` is a subset of the beat's shortlist, so the count per beat is already capped
     * by `maxShortlistPerBeat()`. Adding a second ceiling here would be a budget this round has no
     * evidence for.
     */
    const body = loop();
    expect(body).not.toMatch(/slice\(0,\s*\d+\)/);
    expect(body).not.toMatch(/MAX_[A-Z_]*INGEST/);
    /** And the module's own semaphore is what actually limits concurrency. */
    const ING = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(ING).toContain("const ingestionLimiter = new Semaphore(2);");
  });

  it("IT RESPECTS THE EXISTING OFF SWITCH", () => {
    expect(PIPE).toContain("if (externalAssetIngestionEnabled()) {");
    /** Still default-on, still one env var away from off. */
    expect(externalAssetIngestionEnabled()).toBe(true);
  });

  it("AND IT SAYS WHAT IT KEPT — a silent archive write is one nobody can audit", () => {
    expect(PIPE).toContain("keeping ${approvedKept} approved ");
    expect(PIPE).toContain("they lost the beat, not the judgement");
  });
});

/* ═══════════ 5. YouTube is admitted on the same terms as any other real source ═══════════ */

describe("YouTube is neither privileged nor excluded", () => {
  it("IT IS NOT IN THE BARRED LIST — only stock is", () => {
    const body = loop();
    expect(body).not.toContain("youtube");
  });

  it("THE WINNER PATH DOES NOT BAR IT EITHER", () => {
    const at = PIPE.indexOf("const archiveEligible = !!(");
    const body = PIPE.slice(at, PIPE.indexOf(");", at));
    expect(body).not.toContain("youtube");
  });

  it("SO A YOUTUBE CLIP REACHES THE ARCHIVE ONLY BY PASSING VISION, like everything else", () => {
    /**
     * Stated as a property of the two guards rather than a claim about YouTube: the loop's only
     * source test is the stock ban, and its only quality test is the verdict it inherits from
     * `passingScored`. Nothing in between treats YouTube specially in either direction.
     */
    const body = loop();
    expect(body).toContain('if (src === "pexels" || src === "pixabay") continue;');
    expect(body).toContain("queueArchiveIngestion(s.clipPath, s.candidate);");
  });
});
