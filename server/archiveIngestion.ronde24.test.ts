import { execFileSync } from "child_process";
import * as fs from "fs";
import { readFileSync } from "fs";
import * as os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

/**
 * A real clip comfortably over `MIN_FILE_BYTES`, so the size gate is not what refuses it.
 *
 * Built with ffmpeg rather than checked in: the test is about the text verdict, and a fixture that
 * silently drifted under 50 000 bytes would make this pass for the wrong reason — the size gate
 * would refuse it first and the assertion would be measuring the wrong rule. Lossless 720p is used
 * because it is large and cheap; a per-pixel noise filter is large and slow enough to spend the
 * test's whole timeout drawing it.
 *
 * Built once, at module load, so the cost is not charged to the test's clock.
 */
const TEXT_LADEN_CLIP = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde24-"));
  const out = path.join(dir, "chyron.mp4");
  execFileSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "0", out,
    ],
    { stdio: "ignore" }
  );
  const size = fs.statSync(out).size;
  if (size < 50_000) throw new Error(`fixture is ${size} bytes — the size gate would refuse it first`);
  return out;
})();

// RONDE 24 — the archive fills ITSELF from what the pipeline finds while searching, so anything
// admitted is permanent and gets re-offered to every later render. Ingestion had no text check at
// all, which is how burnt-in subtitles and news chyrons accumulated: renders 526/527 found 10 of
// 17 assets flagged, leaving only 7 usable out of an already small archive.
//
// RONDE 23 stopped such clips reaching the TIMELINE. This stops them reaching the ARCHIVE, which
// is the part that compounds — a rejected beat costs one beat, a polluted asset costs every
// future render.
//
// The memo moved into archiveClipFilter so both sides share it: videoPipeline (the beat gate)
// cannot be imported by archiveIngestion — that module is imported BY videoPipeline — so a shared
// leaf module is the only place a common cache can live without a cycle.

const ingestionSrc = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
const filterSrc = readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 24 — ingestion refuses text-laden footage", () => {
  const fn = ingestionSrc.slice(
    ingestionSrc.indexOf("async function ingestExternalClipToArchiveInner("),
    ingestionSrc.indexOf("const assetId = await createMediaArchiveAsset("),
  );

  it("checks for baked-in text before admitting the clip", () => {
    /** RONDE 222 re-anchor: ingestion asks for the VERDICT now, not the collapsed boolean. */
    expect(fn).toContain("cachedClipBakedEditTextVerdict(");
    expect(fn).toContain("localPath");
    expect(fn).toContain("baked-in on-screen text");
  });

  /**
   * ROUND 596 SPLIT THE ANSWER IN TWO, SO THIS TEST ASKS BOTH LAYERS.
   *
   * ── What it used to assert, and why that is no longer the contract ──────────────────────
   *
   * It read the source of the `has_text` branch and looked for the literal `return null;`. The
   * refusal is still a refusal, but it now names itself — `refuse("BAKED_EDIT_TEXT", …)` — because
   * eleven different refusals inside this function all returned the same bare `null` and the
   * caller could only report "its own quality gate, or a storage failure" and guess between two.
   *
   * Going back to `return null;` to satisfy a source assertion would trade a real diagnosis for a
   * green line, so the assertion moves to where the behaviour is instead.
   *
   * ── Both layers, because both are contracts somebody depends on ─────────────────────────
   *
   *   internal  `ingestExternalClipToArchiveWithReason` → a named refusal, which is what
   *             `storeForProduction` prints for an operator.
   *   public    `ingestExternalClipToArchive` → still `null`, which is what the pipeline's
   *             fire-and-forget call sites have always been handed and must keep being handed.
   *
   * The guard itself is unchanged: a clip whose pixels carry burnt-in text is refused before the
   * upload and before the row, exactly as RONDE 24 established.
   */
  it("REFUSES A TEXT-LADEN CLIP BY NAME, and still returns null to the public caller", async () => {
    vi.resetModules();
    /**
     * The one thing stubbed is the detector's verdict — the pixels are not the subject here, the
     * ingestion's response to a verdict is. Everything below it (storage, the database, the
     * preview check) is left real and must never be reached.
     */
    vi.doMock("./archiveClipFilter", () => ({
      cachedClipBakedEditTextVerdict: async () => ({
        verdict: "has_text" as const,
        reason: "a chyron across the lower third",
      }),
    }));
    const storagePut = vi.fn();
    vi.doMock("./storage", () => ({ storagePut }));
    const createMediaArchiveAsset = vi.fn();
    vi.doMock("./db", () => ({
      createMediaArchiveAsset,
      findMediaArchiveAssetBySourceUrlHash: async () => null,
      getAllMediaArchives: async () => [{ id: 1, isActive: 1 }],
    }));

    const mod = await import("./archiveIngestion");
    const clip = TEXT_LADEN_CLIP;
    const metadata = {
      title: "a clip with a news chyron",
      tags: [],
      sourceNote: "wikimedia:File_Something.mp4",
      mediaType: "video" as const,
      mimeType: "video/mp4",
    };

    const named = await mod.ingestExternalClipToArchiveWithReason(clip, metadata);
    expect(named.status, "the ingestion admitted a text-laden clip").toBe("refused");
    if (named.status === "refused") {
      expect(named.reasonCode).toBe("BAKED_EDIT_TEXT");
      /** The detector's own words, carried rather than replaced by a restatement of the code. */
      expect(named.reasonDetail).toContain("chyron");
      expect(named.mimeType).toBe("video/mp4");
    }

    /** The public entry point's contract is unchanged for every existing caller. */
    expect(await mod.ingestExternalClipToArchive(clip, metadata)).toBeNull();

    /** And nothing was stored for either call — the guard still runs before the upload. */
    expect(storagePut, "a refused clip reached storage").not.toHaveBeenCalled();
    expect(createMediaArchiveAsset, "a refused clip got a row").not.toHaveBeenCalled();
    vi.doUnmock("./archiveClipFilter");
    vi.doUnmock("./storage");
    vi.doUnmock("./db");
    vi.resetModules();
  });

  it("runs before the upload and the DB insert, so nothing is stored for a rejected clip", () => {
    const guardAt = fn.indexOf("cachedClipBakedEditTextVerdict(");
    const uploadAt = fn.indexOf("storagePut(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(uploadAt);
  });

  it("records the cleared verdict on the new asset so it is never re-analysed", () => {
    /**
     * RONDE 222 re-anchor, and the claim is now stronger rather than weaker.
     *
     * This used to assert a flat `hasBakedEditText: 0` — written for EVERY admitted clip, including
     * the ones no detector ever looked at. The verdict is still recorded so a cleared clip is never
     * re-analysed, which is what RONDE 24 was protecting; what it may no longer do is record a
     * clearance that nobody issued.
     */
    expect(ingestionSrc).toContain(`hasBakedEditText: overlay.verdict === "clean" ? 0 : null,`);
    expect(ingestionSrc, "a clip nobody judged is stored as cleared again").not.toContain(
      "hasBakedEditText: 0,"
    );
  });
});

describe("RONDE 24 — the overlay memo is shared, not duplicated", () => {
  it("lives in archiveClipFilter, reachable from both callers", () => {
    expect(filterSrc).toContain("export async function cachedClipHasBakedEditText(");
    expect(filterSrc).toContain("const overlayVerdictCache = new Map<string, boolean>()");
  });

  it("is used by the beat gate and by ingestion", () => {
    /**
     * RONDE 222 re-anchor: one memo, two callers, still — but they now ask it different questions.
     * The beat gate wants the boolean it can fail open on; ingestion, which writes the answer into
     * a permanent row, wants the verdict.
     */
    expect(pipelineSrc).toMatch(/cachedClipHasBakedEditText\(\s*clipPath/);
    expect(ingestionSrc).toMatch(/cachedClipBakedEditTextVerdict\(\s*localPath/);
    /** Both resolve to the same cache in the same module. */
    expect(filterSrc).toContain("export async function cachedClipBakedEditTextVerdict(");
  });

  it("no longer keeps a second private cache in videoPipeline", () => {
    // A per-module cache would make a winning clip pay two vision calls: one at the beat gate
    // and another when that same clip is ingested moments later.
    expect(pipelineSrc).not.toContain("beatClipBakedTextCache");
  });

  it("fails OPEN so a broken detector cannot block every ingestion", () => {
    /**
     * RONDE 222 re-anchor. The property is unchanged and is what this test exists for: a thrown
     * detector must not refuse the clip. What changed is that the failure is now NAMED rather than
     * spelled `verdict = false` — the boolean the beat gate reads still collapses it to false, and
     * ingestion admits the clip too (it only refuses on a real `has_text`).
     */
    const cached = filterSrc.slice(
      filterSrc.indexOf("export async function cachedClipBakedEditTextVerdict("),
      filterSrc.indexOf("export async function archiveClipBakedEditTextVerdict("),
    );
    expect(cached).toContain("catch (err)");
    /** Scoped to the catch itself: the surrounding function reads and writes the cache by verdict. */
    const catchBlock = cached.slice(cached.indexOf("} catch (err) {"), cached.indexOf("\n  if (result.verdict"));
    expect(catchBlock).toContain("NOT_ASKED(");
    expect(catchBlock, "a thrown detector started refusing clips").not.toContain(`"has_text"`);
    /** The collapse the cascade depends on, at the boolean the beat gate calls. */
    const boolWrapper = filterSrc.slice(
      filterSrc.indexOf("export async function cachedClipHasBakedEditText("),
      filterSrc.indexOf("export async function cachedClipBakedEditTextVerdict("),
    );
    expect(boolWrapper).toContain(`=== "has_text"`);
    /** And ingestion refuses on exactly one condition, which is not the failure. */
    expect(ingestionSrc).toContain(`if (overlay.verdict === "has_text")`);
  });

  it("exposes a reset seam so tests do not leak verdicts between cases", () => {
    expect(filterSrc).toContain("export function __resetOverlayVerdictCacheForTest()");
  });
});
