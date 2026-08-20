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

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const ingestionSrc = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");
const curatedSrc = readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const scriptSrc = readFileSync(path.join(__dirname, "..", "scripts", "cleanup-poisoned-archive.ts"), "utf8");

// ─── 1. Stock never enters the curated archive ───────────────────────────────────────────────

describe("RONDE 9.1 — stock footage is never archived", () => {
  it("the funnel call site refuses pexels/pixabay winners", () => {
    const idx = pipelineSrc.indexOf("const archiveEligible = !!(");
    expect(idx).toBeGreaterThan(-1);
    const block = pipelineSrc.slice(idx, idx + 500);
    expect(block).toContain('winningExternalCandidate.source !== "pexels"');
    expect(block).toContain('winningExternalCandidate.source !== "pixabay"');
    expect(pipelineSrc).toContain("const willArchive = archiveEligible;");
    expect(pipelineSrc).toContain("if (archiveEligible && funnelClip && winningExternalCandidate) {");
  });

  it("the ingestion itself blocks stock from EVERY caller (defense in depth)", () => {
    expect(ingestionSrc).toContain('platform === "pexels" || platform === "pixabay"');
    expect(ingestionSrc).toContain('sourcePrefix.startsWith("pexels:")');
    expect(ingestionSrc).toContain('sourcePrefix.startsWith("pixabay:")');
    expect(ingestionSrc).toContain("stock footage is never ingested into the curated archive");
  });
});

// ─── 2. Content-true tags ─────────────────────────────────────────────────────────────────────

describe("RONDE 9.2 — tags describe what is SHOWN, never what is SAID", () => {
  it("the funnel call site no longer passes beat narration keywords as tags", () => {
    const idx = pipelineSrc.indexOf("await ingestExternalClipToArchive(clipPath, {");
    expect(idx).toBeGreaterThan(-1);
    const call = pipelineSrc.slice(idx, idx + 1600);
    expect(call).toContain("tags: [],");
    expect(call).not.toContain("tags: beat.keywords");
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

describe("RONDE 9.3 — Rekognition verifies the funnel winner on person-locked renders", () => {
  const helperStart = pipelineSrc.indexOf("async function clipShowsWrongCelebrity(");
  const helperEnd = pipelineSrc.indexOf("function textMentionsPersonName(", helperStart);
  const helper = pipelineSrc.slice(helperStart, helperEnd);

  it("the helper exists and is a NEGATIVE filter only", () => {
    expect(helperStart).toBeGreaterThan(-1);
    // no keys configured -> off; nobody recognized -> pass; locked person recognized -> pass
    expect(helper).toContain("if (!isRekognitionEnabled()) return false;");
    expect(helper).toContain("if (!names.length) return false;");
    expect(helper).toContain("if (locked) return false;");
  });

  it("only ≥90-confidence recognitions can reject, and any error fails open", () => {
    expect(helper).toContain("p.confidence >= 90");
    expect(helper).toMatch(/catch \(err\) \{[\s\S]{0,300}return false;/);
  });

  it("results are cached per clip content key (Rekognition bills per image)", () => {
    expect(helper).toContain("rekognitionClipPersonsCache");
    expect(helper).toContain("clipContentKey(clipPath)");
  });

  it("the funnel winner is vetoed only under a person lock, and the id is registered", () => {
    const idx = pipelineSrc.indexOf("if (winner && dedup.personTopicLock && dedup.primaryPerson) {");
    expect(idx).toBeGreaterThan(-1);
    const block = pipelineSrc.slice(idx, idx + 700);
    expect(block).toContain("await clipShowsWrongCelebrity(");
    expect(block).toContain("dedup.usedFunnelCandidateIds.add(winner.candidate.id);");
    expect(block).toContain("winner = null;");
  });
});

// ─── 4. Negative curated scores are mismatches, not "no signal" ──────────────────────────────

describe("RONDE 9.4 — a negative curated score can never be adopted", () => {
  it("the primary pool floors only true no-signal (score === 0) to 1", () => {
    expect(curatedSrc).toContain(
      "const effectiveScore = score > 0 ? score : score < 0 || metadataBlocks ? 0 : 1;"
    );
  });

  it("the topic-fallback pool skips negative-scored assets entirely", () => {
    const idx = curatedSrc.indexOf("never enters the fallback pool");
    expect(idx).toBeGreaterThan(-1);
    const block = curatedSrc.slice(idx, idx + 300);
    expect(block).toContain("if (score < 0) continue;");
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
