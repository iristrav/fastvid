/**
 * RONDE 114 — the last metadata veto standing in front of the decider.
 *
 * Found by the end-check of rounds 103–113, not by a new audit: one gate had been left behind.
 *
 * RONDE 103 took the veto off `vision_gate` and RONDE 104 off `off_topic_protest`, both for the
 * same stated reason — a check that reads metadata instead of the frame can only take material
 * away once a model that looks at the picture stands behind it. `off_topic_visual` does exactly
 * what those two do: it refuses a candidate whose provider TITLE shares no token with the beat.
 * It was never demoted, and at both of its call sites it sat directly in front of the decider —
 * at one of them, three lines above the comment explaining why CLIP no longer refuses there.
 *
 * What it discarded is not hypothetical. "Bundesarchiv Bild 183-S33882" is the literal catalogue
 * title of the German federal archive's Hitler photographs; a foreign-language or accession-number
 * title is the norm in an archive, not the exception, and every one of them shares zero tokens
 * with an English beat.
 *
 * Demoted, not deleted — the same treatment its two siblings got. The check still runs, still
 * records its verdict and still logs, so how often it WOULD have fired stays measurable.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { INTENTIONALLY_NON_FIRING_GATES, findSilentGates } from "./gateFiringStats";
import { scriptImageFallbackPassesRelevanceFloor } from "./videoPipeline";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Source with comment lines stripped — an assertion must not pass by reading its own note. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("RONDE 114 — the check still runs and still says what it thinks", () => {
  it("it still recognises a title that shares nothing with the beat", () => {
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "An open letter to remove Richard M. Stallman",
        "hitler bunker",
        "Hitler died in his bunker in 1945.",
        "Why Hitler Killed Himself"
      )
    ).toBe(false);
  });

  it("...and a title that does share something still passes", () => {
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "Adolf Hitler in the Reich Chancellery garden",
        "hitler bunker",
        "Hitler died in his bunker in 1945.",
        undefined
      )
    ).toBe(true);
  });

  it("a missing title is never itself evidence", () => {
    expect(scriptImageFallbackPassesRelevanceFloor(undefined, "q", "beat")).toBe(true);
    expect(scriptImageFallbackPassesRelevanceFloor("   ", "q", "beat")).toBe(true);
  });

  it("THE CASE THIS ROUND IS ABOUT: a real archive catalogue title", () => {
    /**
     * The German federal archive titles its Hitler photographs by accession number. Under the old
     * behaviour this exact string caused the picture to be discarded before anything looked at it.
     * The floor still says "no overlap" — it is now a flag, and the frame decides.
     */
    expect(
      scriptImageFallbackPassesRelevanceFloor(
        "Bundesarchiv Bild 183-S33882",
        "hitler bunker 1945",
        "Hitler died in his bunker in 1945.",
        "Why Hitler Killed Himself"
      )
    ).toBe(false);
  });
});

describe("RONDE 114 — but it no longer refuses", () => {
  it("neither call site rejects on it any more", () => {
    const code = codeOnly(PIPELINE);
    expect(code).not.toContain(
      'recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "off_topic_visual", sourceQuery);'
    );
    expect(code).not.toContain(
      'recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clip, "off_topic_visual", similarQuery);'
    );
    // No reject on this reason survives anywhere.
    expect(code).not.toMatch(/recordClipReject\([^)]*"off_topic_visual"/);
  });

  it("the verdict is still recorded at both sites, so the signal is not lost", () => {
    expect(
      (PIPELINE.match(/recordGateVerdict\("off_topic_visual",/g) ?? []).length,
      "both call sites must still record"
    ).toBe(2);
  });

  it("both sites say out loud that they flagged rather than refused", () => {
    expect(
      (PIPELINE.match(/flagged, not rejected; the relevance gate decides/g) ?? []).length
    ).toBeGreaterThanOrEqual(3); // off_topic_protest's line plus this round's two
  });

  it("the decider it used to stand in front of is still there, on both paths", () => {
    // Site 1: adoptClip's own beat image gate.
    expect(PIPELINE).toContain("!(await beatClipPassesImageGate(p, contentKey, beatText, opts, workDir, sceneIndex, beatIndex, dedup))");
    // Site 2: the similar-match path calls the vision gate immediately after the flag.
    const idx = PIPELINE.indexOf("if (similarProviderTitle) recordGateVerdict(");
    expect(idx).toBeGreaterThan(-1);
    expect(PIPELINE.slice(idx, idx + 900)).toContain("const vision = await beatClipPassesVisionGate(");
  });
});

describe("RONDE 114 — the demote list matches reality", () => {
  it("all three metadata gates are listed, and baked_text still is not", () => {
    expect([...INTENTIONALLY_NON_FIRING_GATES].sort()).toEqual([
      "off_topic_protest",
      "off_topic_visual",
      "vision_gate",
    ]);
    // baked_text reads the PIXELS and may still refuse — a silent one is a genuine finding.
    expect(INTENTIONALLY_NON_FIRING_GATES.has("baked_text")).toBe(false);
  });

  it("a demoted gate that never fires raises no false alarm", () => {
    const stats = new Map([
      ["off_topic_visual", { asked: 47, fired: 0 }],
      ["baked_text", { asked: 47, fired: 0 }],
    ]);
    const silent = findSilentGates(stats as never).map((r) => r.gate);
    expect(silent).not.toContain("off_topic_visual");
    // ...while a gate that IS supposed to be able to fire still gets caught.
    expect(silent).toContain("baked_text");
  });

  it("every listed name is one the pipeline actually records", () => {
    /**
     * The list is only a safety net if its entries match real gate names. An entry naming a gate
     * that does not exist protects nothing while looking like it does.
     */
    for (const gate of INTENTIONALLY_NON_FIRING_GATES) {
      expect(PIPELINE, gate).toContain(`recordGateVerdict("${gate}"`);
    }
  });
});

describe("RONDE 114 — the checks that read PIXELS keep their veto", () => {
  it("baked_text still refuses", () => {
    // A burnt-in chyron is a defect in the file, not a claim about the subject.
    expect(PIPELINE).toContain('recordGateVerdict("baked_text", hasBakedText);');
    // Unlike the three demoted gates, this one still refuses — it reads the pixels.
    expect(PIPELINE).toContain(
      'recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, "baked_text", queryLabel);'
    );
    expect(PIPELINE).toContain("return { pass: false, worstScore10: null, skipped: false, fromCache: false };");
  });

  it("the beat image gate is still the one that decides", () => {
    expect(PIPELINE).toContain('recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "beat_image_gate", sourceQuery);');
  });
});
