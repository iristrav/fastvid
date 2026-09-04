/**
 * THE COMPOSE → CINEMATIC HALF OF THE TRACE.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * The retrieval half is traced: `[AssetTrace]`, `[PushTrace]`, `[VisualCoverage]`,
 * `[FillerOverAdopted]` and the lineage ledger together say what became of an asset from FOUND to
 * beat assignment. Past that the log went quiet. The planner printed
 *
 *     [CinematicPipeline] dropped s1b1: adopted clip has no rehydratable identity (provider=unknown)
 *
 * which names a BEAT and a symptom, not an asset — so the one question a reader has, "did MY clip
 * survive", could not be answered by grep. And it printed nothing at all for the clips it KEPT, so
 * absence from the drop list had to be read as presence in the plan, which is exactly the inference
 * this project has been removing all round.
 *
 * ── What is asserted ────────────────────────────────────────────────────────────────────────
 *
 * That both endings exist and both carry canonical identity: `ADOPTED → CINEMATIC_SELECTED` or
 * `ADOPTED → CINEMATIC_DROPPED(reason)`, with no third, silent option. And that the source the
 * planner reads is stated on every scene, with a divergence line when the canonical state holds
 * something compose's output does not — the architectural risk this round makes measurable
 * WITHOUT changing it.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const INPUTS = fs.readFileSync(path.join(__dirname, "cinematicPipelineInputs.ts"), "utf8");
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════ identity, not position ═══════════════ */

describe("the cinematic lines name the asset canonically", () => {
  it("has one label builder, used by every line", () => {
    expect(INPUTS).toContain("function assetLabel(");
    const at = INPUTS.indexOf("function assetLabel(");
    const body = INPUTS.slice(at, INPUTS.indexOf("\n}", at));
    expect(body).toContain("adoption.provider");
    expect(body).toContain("adoption.providerAssetId");
    expect(body).toContain("adoption.archiveAssetId");
  });

  /** A temporary URL identifies where a file was for a few hours, not what it is. */
  it("never falls back to a path or a URL as identity", () => {
    const at = INPUTS.indexOf("function assetLabel(");
    const body = INPUTS.slice(at, INPUTS.indexOf("\n}", at));
    expect(body).not.toContain("sourceUrl");
    expect(body).not.toContain("localPath");
    expect(body).not.toContain("basename");
  });

  /** An unresolvable adoption is an honest gap, never a guessed name. */
  it("says unknown rather than inventing a name", () => {
    const at = INPUTS.indexOf("function assetLabel(");
    const body = INPUTS.slice(at, INPUTS.indexOf("\n}", at));
    expect(body).toContain('"asset=unknown provider=none sourceId=none"');
    expect(body).toContain('|| "unknown"');
  });
});

/* ═══════════════ both endings, never a third ═══════════════ */

describe("every adopted clip gets a cinematic ending", () => {
  /** The three drop paths in the beat loop each name their asset and a stable reason code. */
  it.each([
    ["NOT_REHYDRATABLE", "adopted clip has no rehydratable identity"],
    ["NO_VOICE_WINDOW", "the beat has no voice window and no hold length"],
    ["NO_ADOPTED_CLIP", "no clip was adopted for this beat"],
  ])("drop %s carries a reason code", (code, prose) => {
    expect(INPUTS, `the ${code} drop is gone`).toContain(prose);
    expect(INPUTS, `${code} has no [CinematicDrop] line`).toContain(`reason=${code}`);
  });

  it("the drop lines carry the asset, not only the beat", () => {
    /**
     * Each whole STATEMENT, not each template literal. The lines are built from two backtick
     * segments joined by `+`, so a regex that stops at the first backtick reads half a line and
     * reports a field missing that is plainly there.
     */
    const drops: string[] = [];
    for (let at = INPUTS.indexOf("[CinematicDrop]"); at !== -1; at = INPUTS.indexOf("[CinematicDrop]", at + 1)) {
      drops.push(INPUTS.slice(at, INPUTS.indexOf(");", at)));
    }
    expect(drops.length).toBeGreaterThanOrEqual(3);
    for (const d of drops) {
      expect(d, `a [CinematicDrop] line has no scene: ${d.slice(0, 60)}`).toContain("scene=");
      expect(d, `a [CinematicDrop] line has no beat: ${d.slice(0, 60)}`).toContain("beat=");
      expect(d, `a [CinematicDrop] line has no reason: ${d.slice(0, 60)}`).toContain("reason=");
    }
    // Two of the three name an asset; the "no clip was adopted" case has none to name.
    expect(drops.filter((d) => d.includes("${assetLabel(")).length).toBe(2);
    expect(drops.filter((d) => d.includes("asset=none")).length).toBe(1);
  });

  /**
   * The kept clips are logged too. A drop list alone cannot answer "did my asset survive":
   * absence from it is not presence in the plan.
   */
  it("logs what it KEEPS, with its window", () => {
    expect(INPUTS).toContain("[CinematicSelected]");
    const at = INPUTS.indexOf("[CinematicSelected]");
    const line = INPUTS.slice(at, at + 300);
    expect(line).toContain("${assetLabel(adopted.adoption)}");
    expect(line).toContain("start=");
    expect(line).toContain("duration=");
  });

  /** Selected must be emitted after the drops, or a dropped beat would also report as selected. */
  it("reports selected only past every drop", () => {
    const fn = INPUTS.indexOf("const adopted = sceneFacts.clips[beatIndex]");
    const body = INPUTS.slice(fn, fn + 4000);
    expect(body.lastIndexOf("[CinematicDrop]")).toBeLessThan(body.indexOf("[CinematicSelected]"));
  });
});

/* ═══════════════ the source preference is measurable ═══════════════ */

describe("which source the planner read is stated", () => {
  it("names the preferred source and whether the other was available", () => {
    expect(PIPE).toContain("[CinematicSourceDecision]");
    const at = PIPE.indexOf("[CinematicSourceDecision]");
    const block = PIPE.slice(at, at + 500);
    expect(block).toContain("preferredSource=");
    expect(block).toContain("canonicalSourceAvailable=");
    expect(block).toContain("composedSourceCount=");
    expect(block).toContain("canonicalSourceCount=");
  });

  /** The question this round exists to answer: can compose hide an adopted asset? */
  it("reports files the canonical state holds and compose's output does not", () => {
    expect(PIPE).toContain("[CinematicSourceDivergence]");
    const at = PIPE.indexOf("[CinematicSourceDivergence]");
    const block = PIPE.slice(at, at + 900);
    expect(block).toContain("missingFromCompose=");
    expect(block).toContain("canonicalState=");
    expect(block).toContain("composeState=MISSING");
  });

  /** Divergence is per asset, resolved through the ledger — not a bare count. */
  it("names each missing asset through the ledger", () => {
    const at = PIPE.indexOf("missingFromCompose=");
    const block = PIPE.slice(at, at + 800);
    expect(block).toContain("lineage?.resolve(p, clipContentKey(p))");
    expect(block).toContain("rec?.provider");
    expect(block).toContain("rec?.providerAssetId");
  });

  /**
   * BEHAVIOUR UNCHANGED. This round observes the preference; it does not flip it. A change here
   * is a separate, measured decision and must not ride along with the logging that measures it.
   */
  it("still prefers compose's output exactly as before", () => {
    expect(PIPE).toContain("const usingCompose = composedForScene.length > 0;");
    expect(PIPE).toContain("clipPaths: usingCompose ? composedForScene : canonicalForScene,");
  });

  /** Bounded output: a scene that diverges wholesale must not replace the log with itself. */
  it("bounds the per-asset divergence lines", () => {
    const at = PIPE.indexOf("missingFromCompose=");
    expect(PIPE.slice(at, at + 500)).toContain("missing.slice(0, 10)");
  });
});
