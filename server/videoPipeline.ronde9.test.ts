import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 9 — the archive self-poisoning loop, proven by render 519 + the admin screenshots:
// a generic Pexels stock clip that happened to win a Hitler beat was auto-ingested into the
// curated archive TAGGED WITH THE NARRATION KEYWORDS ("adolf hitler", "eva braun"), and from
// then on outranked real archival footage on every render about the same person. Four cuts:
//   1. stock (Pexels/Pixabay) is never ingested into the curated archive — at the funnel call
//      site AND inside the ingestion itself (defense in depth);
//   2. narration keywords are never written as content tags — content-true person tags come
//      from AWS Rekognition celebrity recognition at ingestion time (best-effort, key-gated);
//   3. person-locked renders verify the funnel winner with Rekognition — rejecting ONLY on
//      strong (≥90) evidence of a DIFFERENT celebrity, failing open on everything else;
//   4. a NEGATIVE curated score is an active mismatch and can no longer be laundered into the
//      score=1 "no signal" floor (render 519 adopted assets scoring -65).

import {
  sourceMayEnterCuratedArchive,
  archiveMetadataForExternalClip,
} from "./videoPipeline";

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const ingestionSrc = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
const curatedSrc = readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const scriptSrc = readFileSync(path.join(__dirname, "..", "scripts", "cleanup-poisoned-archive.ts"), "utf8");

// ─── 1. Stock never enters the curated archive ───────────────────────────────────────────────

describe("RONDE 9.1 — stock footage is never archived", () => {


  it("the ingestion itself blocks stock from EVERY caller (defense in depth)", () => {
    expect(ingestionSrc).toContain('platform === "pexels" || platform === "pixabay"');
    expect(ingestionSrc).toContain('sourcePrefix.startsWith("pexels:")');
    expect(ingestionSrc).toContain('sourcePrefix.startsWith("pixabay:")');
    expect(ingestionSrc).toContain("stock footage is never ingested into the curated archive");
  });
});

// ─── 2. Content-true tags ─────────────────────────────────────────────────────────────────────

describe("RONDE 9.2 — tags describe what is SHOWN, never what is SAID", () => {
  /**
   * MEDIA ARCHIVE ROUND — the same claim, at the one place that now decides it.
   *
   * The metadata used to be written inline inside `queueArchiveIngestion`, which was the only
   * caller, so this test read that call. The winner's clip now goes through `storeForProduction`
   * instead — it must be archived and read back BEFORE its identity may enter the production
   * timeline — and both routes take their metadata from `archiveMetadataFor`.
   *
   * That makes RONDE 9's rule easier to hold, not harder: one definition instead of one per route.
   * Neither half of the claim is dropped — `tags: []` is still required and `beat.keywords` is
   * still forbidden — and both are now asserted against the single writer, so a second route
   * growing its own metadata block cannot slip past by not matching the old string.
   */
  it("the funnel call site no longer passes beat narration keywords as tags", () => {
    /**
     * ARCHIVE-FIRST ROUND — the single writer became a module-level function when the scene-pool
     * route needed the same provenance. Same claim, same single definition, now exercised by
     * CALLING it rather than by reading the literal: a builder that is run cannot drift from the
     * string this test greps for.
     */
    const idx = pipelineSrc.indexOf("export function archiveMetadataForExternalClip(");
    expect(idx, "the single metadata writer is gone — has a route grown its own again?").toBeGreaterThan(-1);
    const call = pipelineSrc.slice(idx, idx + 2400);
    expect(call).toContain("tags: [],");
    expect(call).not.toContain("tags: beat.keywords");
    /** And there is exactly one of them, so "the single writer" is measured rather than assumed. */
    expect((pipelineSrc.match(/export function archiveMetadataForExternalClip\(/g) ?? []).length).toBe(1);

    const md = archiveMetadataForExternalClip(
      { source: "wikimedia", providerAssetId: "File:X.webm", title: "X", mediaType: "video" },
      { beatQuery: "berlin 1945", personContext: false, topics: ["berlin"] }
    );
    expect(md.tags, "narration keywords reached the archive as tags").toEqual([]);
  });

  it("ingestion adds Rekognition-recognized person names as content-true tags", () => {
    expect(ingestionSrc).toContain("recognizeCelebritiesInFile(localPath, metadata.mediaType");
    expect(ingestionSrc).toContain("isRekognitionEnabled()");
    expect(ingestionSrc).toMatch(/const contentTags = Array\.from\(\s*new Set\(\[\.\.\.\(metadata\.tags \?\? \[\]\), \.\.\.recognizedPersonTags\]\)\s*\)/);
  });


  it("both the DB row and the embedding index use the content-true tag set", () => {
    expect(ingestionSrc).toContain("tags: contentTags,");
    const embedIdx = ingestionSrc.indexOf("indexArchiveAssetEmbedding({");
    const embedCall = ingestionSrc.slice(embedIdx, embedIdx + 300);
    expect(embedCall).toContain("tags: contentTags,");
  });

  it("Rekognition tagging is best-effort: an error never blocks ingestion", () => {
    expect(ingestionSrc).toContain("Rekognition tagging skipped");
  });
});

// ─── 3. Person-locked winner verification ────────────────────────────────────────────────────


// ─── 4. Negative curated scores are mismatches, not "no signal" ──────────────────────────────

describe("RONDE 9.4 — a negative curated score can never be adopted", () => {
  it("the primary pool asks the VisualJudge, and floors only what it accepted (score 0) to 1", () => {
    /** Code audit P5: the refusal of a negative score is the VisualJudge's, not the matcher's. */
    const at = curatedSrc.indexOf('if (judgeArchiveAssetScore(score).decision === "REJECT") continue;');
    expect(at).toBeGreaterThan(-1);
    expect(curatedSrc.slice(at, at + 300)).toContain("score: Math.max(score, 1),");
  });

  it("the topic-fallback pool asks the same judge, so a negative score never enters it", () => {
    const at = curatedSrc.indexOf("fallback.push({ asset, score: Math.max(score, 1)");
    expect(at).toBeGreaterThan(-1);
    expect(curatedSrc.slice(at - 200, at)).toContain('if (judgeArchiveAssetScore(score).decision === "REJECT") continue;');
  });
});

// ─── 5. Cleanup script ───────────────────────────────────────────────────────────────────────

describe("RONDE 9.5 — the poisoned-archive cleanup script is safe by default", () => {
  it("dry-run is the default; --apply is required to change anything", () => {
    expect(scriptSrc).toContain('process.argv.includes("--apply")');
    expect(scriptSrc).toContain("DRY RUN — nothing changed");
  });

  it("it deactivates (isActive=0), never deletes", () => {
    expect(scriptSrc).toContain(".set({ isActive: 0 })");
    expect(scriptSrc).not.toMatch(/\.delete\(/);
  });

  it("it targets exactly the stock-sourced assets", () => {
    expect(scriptSrc).toContain('eq(mediaArchiveAssets.sourcePlatform, "pexels")');
    expect(scriptSrc).toContain('eq(mediaArchiveAssets.sourcePlatform, "pixabay")');
    expect(scriptSrc).toContain('like(mediaArchiveAssets.sourceNote, "pexels:%")');
    expect(scriptSrc).toContain('like(mediaArchiveAssets.sourceNote, "pixabay:%")');
  });
});
