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
     * The set itself is unchanged and still built from the verdict, not from the score. A clip
     * Vision refused never appears in it, so it cannot be ingested by this route at all.
     */
    expect(PIPE).toContain("const passingScored = scored.filter(s => s.visionResult.pass);");
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
    /** The original guard is untouched; the new loop did not replace it. */
    expect(PIPE).toContain('winningExternalCandidate.source !== "pexels" &&');
    expect(PIPE).toContain('winningExternalCandidate.source !== "pixabay"');
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
  it("BOTH THE WINNER AND THE RUNNERS-UP GO THROUGH ONE FUNCTION", () => {
    /**
     * The defect this codebase keeps removing is a rule N call sites must follow, registered by a
     * few. Two hand-written metadata blocks would drift the moment one gained a field.
     */
    expect((PIPE.match(/const queueArchiveIngestion = \(/g) ?? []).length).toBe(1);
    /** Two call sites, and only two: the winner and the runner-up loop. */
    expect((PIPE.match(/queueArchiveIngestion\(/g) ?? []).length).toBe(2);
    expect(PIPE).toContain("queueArchiveIngestion(funnelClip, winningExternalCandidate);");
    expect(PIPE).toContain("queueArchiveIngestion(s.clipPath, s.candidate);");
  });

  it("AND STILL EXACTLY ONE CALL TO THE INGESTION HELPER ITSELF on this route", () => {
    const at = PIPE.indexOf("const queueArchiveIngestion = (");
    const body = PIPE.slice(at, PIPE.indexOf("\n        };", at));
    expect((body.match(/await ingestExternalClipToArchive\(/g) ?? []).length).toBe(1);
  });

  it("THE TAGS RULE IS UNCHANGED — narration keywords never become archive tags", () => {
    /** RONDE 9 again: those describe what is SAID, not what is SHOWN. */
    const at = PIPE.indexOf("const queueArchiveIngestion = (");
    const body = PIPE.slice(at, PIPE.indexOf("\n        };", at));
    expect(body).toContain("tags: [],");
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
