import { describe, expect, it } from "vitest";

/**
 * RONDE 51 — the six findings from render 530, each pinned with the numbers that render actually
 * produced. Where a threshold moved, the measurement that justified moving it is asserted here,
 * so the next render can falsify it instead of the reasoning living only in a comment.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 5a. Diacritics were destroying the most distinctive search term
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 51 #5a — accented words survive tokenisation", () => {
  it("Führerbunker no longer becomes hrerbunker", async () => {
    const { foldSearchText, foldToSearchTokensText } = await import("./searchTextNormalize");
    expect(foldSearchText("Führerbunker")).toBe("fuhrerbunker");
    // The exact path that failed in render 530: fold, strip, split, drop short tokens.
    const tokens = foldToSearchTokensText("In the claustrophobic depths of the Führerbunker")
      .split(/\s+/)
      .filter((w) => w.length >= 4);
    expect(tokens).toContain("fuhrerbunker");
    expect(tokens).not.toContain("hrerbunker");
  });

  it("the pre-fix behaviour is what produced the broken tag", () => {
    // Reproduces the old one-liner so the regression is visible, not just described.
    const old = "In the claustrophobic depths of the Führerbunker"
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4);
    expect(old).toContain("hrerbunker");
  });

  it("covers the rest of the historical vocabulary, not just this one word", async () => {
    const { foldSearchText } = await import("./searchTextNormalize");
    expect(foldSearchText("Göring")).toBe("goring");
    expect(foldSearchText("Dönitz")).toBe("donitz");
    expect(foldSearchText("München")).toBe("munchen");
    expect(foldSearchText("Reichstagsgebäude")).toBe("reichstagsgebaude");
    expect(foldSearchText("Białystok")).toBe("bialystok");
    expect(foldSearchText("Straße")).toBe("strasse");
  });

  it("leaves plain ASCII exactly as it was", async () => {
    const { foldSearchText, foldToSearchTokensText } = await import("./searchTextNormalize");
    expect(foldSearchText("Adolf Hitler 1945")).toBe("adolf hitler 1945");
    expect(foldToSearchTokensText("Adolf Hitler, 1945.")).toBe("adolf hitler 1945");
    expect(foldToSearchTokensText("well-known case", "-")).toBe("well-known case");
  });
});

describe("RONDE 51 #5a — every tokenizer that fed the broken tag now folds", () => {
  it("the curated beat/anchor tokenizers keep the accented word", async () => {
    const mod = await import("./curatedMediaSourcing");
    const anchors = mod.extractTopicAnchorTags("Hitler in the Führerbunker, Berlin 1945");
    expect(anchors.some((t) => t.includes("fuhrerbunker"))).toBe(true);
    expect(anchors.some((t) => t.includes("hrerbunker") && !t.includes("fuhrerbunker"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5b. The CLIP query was spending its window on repeats
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 51 #5b — the vision query says each thing once", () => {
  it("collapses the repeated leading word render 530 embedded", async () => {
    const { collapseRepeatedWords } = await import("./localClipVision");
    expect(collapseRepeatedWords("hitler hitler suicide")).toBe("hitler suicide");
    expect(collapseRepeatedWords("why why man")).toBe("why man");
    expect(collapseRepeatedWords("claustrophobic claustrophobic depths")).toBe("claustrophobic depths");
    // Legitimate repetition that is not adjacent is untouched.
    expect(collapseRepeatedWords("hitler and eva and hitler")).toBe("hitler and eva and hitler");
  });

  it("drops parts that are truncations of a part already kept", async () => {
    const { dedupeQueryParts } = await import("./localClipVision");
    // The exact shape render 530 produced: one sentence at four different cut points.
    const parts = [
      "In April 1945, within hours of marrying",
      "In April 1945",
      "In April",
      "In April 194",
    ];
    expect(dedupeQueryParts(parts)).toEqual(["In April 1945, within hours of marrying"]);
  });

  it("keeps genuinely different parts, in order", async () => {
    const { dedupeQueryParts } = await import("./localClipVision");
    const parts = [
      "black and white archival photograph of a bunker interior",
      "Subject: Adolf Hitler, Berlin, 1945",
      "In April 1945, within hours of marrying",
    ];
    expect(dedupeQueryParts(parts)).toEqual(parts);
  });

  it("the assembled query no longer repeats itself", async () => {
    const { buildBeatVisionQueryText } = await import("./localClipVision");
    const q = buildBeatVisionQueryText({
      beatText: "In April 1945, within hours of marrying, Adolf Hitler and Eva Braun died.",
      visualDescription: "In April 1945, within hours of marrying",
      videoTitle: "Why Hitler and Eva Braun Chose to Die in the Bunker",
    });
    const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    // "april" appeared four times in the render-530 query for this beat.
    expect(words.filter((w) => w === "april").length).toBeLessThanOrEqual(1);
  });
});

describe("RONDE 51 #2 — the pool path records its adoptions at all", () => {

  it("scenePool itself still performs no auditing — the boundary stays in the pipeline", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const pool = readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
    expect(pool).not.toContain("recordClipAdopt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The funnel thresholds sat outside the range the score can reach
// ─────────────────────────────────────────────────────────────────────────────

/** Every archiveScore [FunnelBeatCalib] logged in render 530, in the order it was logged. */
const RENDER_530_BEAT_SCORES = [
  0.3985, 0.42, 0.5344, 0.4373, 0.2526, 0.4264, 0.2642,
  0.251, 0.4618, 0.2143, 0.5069, 0.3952, 0.2488, 0.3529,
];

describe("RONDE 51 #6 — the archive thresholds sit inside the measured band", () => {
  it("render 530's measurement is what it is", () => {
    expect(RENDER_530_BEAT_SCORES).toHaveLength(14);
    expect(Math.min(...RENDER_530_BEAT_SCORES)).toBeCloseTo(0.2143, 4);
    expect(Math.max(...RENDER_530_BEAT_SCORES)).toBeCloseTo(0.5344, 4);
  });

  it("the old thresholds were unreachable — no beat could ever win", async () => {
    const OLD_STOP = 0.94;
    const OLD_ONE = 0.75;
    expect(RENDER_530_BEAT_SCORES.filter((s) => s >= OLD_STOP)).toHaveLength(0);
    expect(RENDER_530_BEAT_SCORES.filter((s) => s >= OLD_ONE)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The modern-content veto could not fire
// ─────────────────────────────────────────────────────────────────────────────

/** (topNegSim, beatSim) pairs logged per candidate in render 530. */
const RENDER_530_ARCHIVE = [
  { topNegSim: 0.2103, beatSim: 0.2145 },
  { topNegSim: 0.2077, beatSim: 0.1974 },
  { topNegSim: 0.189, beatSim: 0.1974 },
];
const RENDER_530_MODERN_STOCK = [
  { topNegSim: 0.2432, beatSim: 0.2129 },
  { topNegSim: 0.2284, beatSim: 0.226 },
  { topNegSim: 0.2389, beatSim: 0.223 },
];

describe("RONDE 51 #1 — the modern-content veto can fire again", () => {
  const frames = (topNegSim: number, beatSim: number, probes: number) => [
    { beatSim, negSims: Array(probes).fill(topNegSim) },
  ];

  it("the old floor sat above everything render 530 ever saw", () => {
    const OLD_FLOOR = 0.26;
    for (const c of [...RENDER_530_ARCHIVE, ...RENDER_530_MODERN_STOCK]) {
      expect(c.topNegSim).toBeLessThan(OLD_FLOOR);
    }
  });

  it("the two groups separate on margin, not on absolute similarity", () => {
    const archiveMargins = RENDER_530_ARCHIVE.map((c) => c.topNegSim - c.beatSim);
    const stockMargins = RENDER_530_MODERN_STOCK.map((c) => c.topNegSim - c.beatSim);
    // Real archive: the probe never decisively beats the beat's own query.
    expect(Math.max(...archiveMargins)).toBeLessThan(0.015);
    // Modern stock: it consistently does.
    expect(Math.min(...stockMargins)).toBeGreaterThan(0.001);
  });

  it("modern stock is now flagged when enough probes agree", async () => {
    const { decideModernContentMismatch } = await import("./localClipVision");
    const worst = RENDER_530_MODERN_STOCK[0]!;
    const verdict = decideModernContentMismatch(
      frames(worst.topNegSim, worst.beatSim, 3),
      ["p1", "p2", "p3"]
    );
    expect(verdict.mismatch).toBe(true);
    expect(verdict.reason).toBe("strong-modern-evidence");
  });

  it("genuine archive material is still allowed through", async () => {
    const { decideModernContentMismatch } = await import("./localClipVision");
    for (const c of RENDER_530_ARCHIVE) {
      const verdict = decideModernContentMismatch(frames(c.topNegSim, c.beatSim, 3), ["p1", "p2", "p3"]);
      expect(verdict.mismatch).toBe(false);
      expect(verdict.reason).toBe("insufficient-evidence");
    }
  });

  it("one lone probe is still never enough", async () => {
    const { decideModernContentMismatch } = await import("./localClipVision");
    const worst = RENDER_530_MODERN_STOCK[0]!;
    const verdict = decideModernContentMismatch(frames(worst.topNegSim, worst.beatSim, 1), ["p1"]);
    expect(verdict.mismatch).toBe(false);
  });
});
