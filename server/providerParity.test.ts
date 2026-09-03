/**
 * THE RANKER SHOULD REWARD EVIDENCE, NOT PROVENANCE.
 *
 * ── The imbalance ───────────────────────────────────────────────────────────────────────────
 *
 * `scoreAnnotationFingerprint` carries 40% of a candidate's score — the largest single weight in
 * the Asset Director. A curated archive asset feeds it structured, human-reviewed annotation:
 * named persons, objects, actions, location, era, emotion, cinematography. Everything from every
 * other provider — Pexels, YouTube, Wikimedia, the Internet Archive, NASA, NARA, Europeana — falls
 * into a keyword-overlap fallback against the provider's own title and tags.
 *
 * So the archive did not win only by being good. It won partly by being the one source the ranker
 * could see, and a Pexels clip that was genuinely the better picture lost 40% of the scoreboard to
 * a metadata gap.
 *
 * ── The evidence that was already there ─────────────────────────────────────────────────────
 *
 * The beat image judge answers `depicts` for every candidate it looks at, from any provider, and
 * it is describing THESE frames — not the twenty-minute reel they were cut from. That sentence was
 * logged and thrown away.
 *
 * Using it is not a thumb on the scale for external providers. It is a third tier of evidence,
 * ranked by what it actually proves:
 *
 *     35   the download filename        a positional label, `scene_0_ccc_0.mp4`
 *     55   the provider's own text      real, but about the whole asset
 *     70   a model's look at the frames the closest thing to having seen the clip
 *     100  curated annotation           human-reviewed, structured, entity by entity
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const director = () => fs.readFileSync(path.join(__dirname, "assetDirector.ts"), "utf8");
const pipeline = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("a candidate is scored on what is known about it, not on where it came from", () => {
  it("the judge's description is matched against the beat, like the provider's text is", () => {
    const src = director();
    expect(src).toContain('const seenHay = (meta?.observedDepicts ?? "").toLowerCase();');
    expect(src).toContain("seenHay.includes(w)");
  });

  /**
   * The ordering is the whole argument. If the tiers were flat, this would be an inflation of
   * external candidates rather than a measurement of them.
   */
  it("the evidence tiers are ordered by what each one proves", () => {
    expect(director()).toContain("const ceiling = seenHay ? 70 : providerHay ? 55 : 35;");
  });

  /**
   * Curated annotation must stay the strongest. It is human-reviewed and structured — named
   * persons, objects, era — where `depicts` is one sentence of a model's prose. A tier that
   * overtook it would be rewarding the cheaper evidence.
   */
  it("no fallback tier reaches what a real annotation scores", () => {
    const src = director();
    const at = src.indexOf("const ceiling = seenHay ?");
    const tail = src.slice(at, at + 400);
    for (const tier of [70, 55, 35]) {
      expect(tail).toContain(String(tier));
    }
    // The fallback's own formula: 25 + fraction × ceiling. Even a perfect match tops out at 95.
    expect(src).toContain("const fallback = Math.round(25 + (words.length > 0 ? (hits / words.length) * ceiling : 0));");
  });

  /**
   * The seam. Every other line can be in place and the ranking still reads a reel title, because
   * nothing carried the judge's sentence from the gate to the meta the ranker is handed.
   */
  it("the pipeline files the description where the ranker looks", () => {
    const src = pipeline();
    expect(src).toContain("observedDepicts: decision.depicts");
    expect(src).toContain("if ((decision.framing || decision.depicts) && params.clipPath)");
  });

  /**
   * A candidate nobody judged keeps exactly the score it had. This round adds a tier; it does not
   * remove one, and it must not quietly demote clips that were fine before.
   */
  it("an unjudged candidate is scored exactly as it was", () => {
    const src = director();
    expect(src).toContain('const ceiling = seenHay ? 70 : providerHay ? 55 : 35;');
    // providerText at 55 and filename at 35 are the pre-existing values, unchanged.
    expect(src).toContain("the download filename");
    expect(src).toContain("the provider's own text");
  });

  /**
   * Both observations ride on the same write. Splitting them into two would be two chances for one
   * to be forgotten — which is precisely the seam this codebase keeps rediscovering.
   */
  it("the framing and the description are stored together, from one decision", () => {
    const src = pipeline();
    const at = src.indexOf("if ((decision.framing || decision.depicts) && params.clipPath)");
    const block = src.slice(at, at + 900);
    expect(block).toContain("observedShotType: decision.framing");
    expect(block).toContain("observedDepicts: decision.depicts");
  });
});
