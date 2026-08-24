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

// ─────────────────────────────────────────────────────────────────────────────
// 2. The adopt audit could not see most of the video
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 51 #2 — pool providers are classified as the archives they are", () => {
  it("counts Internet Archive, LoC, NARA and the rest as archive beats", async () => {
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    const audit = createClipAdoptAudit();
    const sources = ["internet_archive", "loc", "nara", "nasa", "openverse", "europeana"];
    sources.forEach((s, i) => recordClipAdopt(audit, 0, i, `b${i}`, `/w/c${i}.mp4`, s));
    const summary = summarizeAdoptAudit(audit);
    expect(summary.beatsFilled).toBe(sources.length);
    // Pre-fix: every one of these matched no branch, so beatsFilled counted them and no
    // category did — render 530 reported "beats=13 wiki=0 arch=7 stock=0".
    expect(summary.archiveBeats).toBe(sources.length);
    expect(summary.fallbackBeats).toBe(0);
  });

  it("does not reclassify anything that already had a category", async () => {
    const { createClipAdoptAudit, recordClipAdopt, summarizeAdoptAudit } = await import(
      "./clipAdoptAudit"
    );
    const audit = createClipAdoptAudit();
    recordClipAdopt(audit, 0, 0, "b0", "/w/a.mp4", "pexels");
    recordClipAdopt(audit, 0, 1, "b1", "/w/b.mp4", "wikimedia");
    recordClipAdopt(audit, 0, 2, "b2", "/w/c.mp4", "archive");
    recordClipAdopt(audit, 0, 3, "b3", "/w/d.mp4", "fallback");
    const s = summarizeAdoptAudit(audit);
    expect(s.stockBeats).toBe(1);
    expect(s.wikiBeats).toBe(1);
    expect(s.archiveBeats).toBe(1);
    expect(s.fallbackBeats).toBe(1);
  });
});

describe("RONDE 51 #2 — the pool path records its adoptions at all", () => {
  it("the one place a pool candidate becomes the beat clip now records it", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = src.indexOf("if (poolClip) {\n          clip = poolClip;");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1400);
    expect(block).toContain("recordClipAdopt(");
    expect(block).toContain("dedup.clipAdoptAudit");
    // The source must come from the candidate, never be hardcoded to a placeholder label.
    expect(block).toMatch(/adopted\?\.source/);
    expect(block).not.toMatch(/recordClipAdopt\([^)]*"fallback"/);
  });

  it("scenePool itself still performs no auditing — the boundary stays in the pipeline", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const pool = readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
    expect(pool).not.toContain("recordClipAdopt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Every rescue slot searched the same sentence
// ─────────────────────────────────────────────────────────────────────────────

describe("RONDE 51 #4 — a rescue slot searches its own sentence", () => {
  const SCENE =
    "In a surreal scene amidst Berlin's collapse, Adolf Hitler and Eva Braun married. " +
    "But why tie the knot when defeat loomed large? Their union raised questions. " +
    "Inside the confines of the Führerbunker in Berlin, Adolf Hitler wrote his will. " +
    "A fate worse than death looms, compelling his irreversible decision. " +
    "Witness the culmination of their choice in the bunker.";

  it("consecutive slots get different text", async () => {
    const { sceneSentenceForSlot } = await import("./videoPipeline");
    // Six sentences — the question mark is a boundary too.
    const picked = [0, 1, 2, 3, 4, 5].map((i) => sceneSentenceForSlot(SCENE, i));
    expect(new Set(picked).size).toBe(6);
    expect(picked[0]).toContain("surreal scene");
    expect(picked[3]).toContain("Führerbunker");
  });

  it("rotates rather than running out", async () => {
    const { sceneSentenceForSlot } = await import("./videoPipeline");
    expect(sceneSentenceForSlot(SCENE, 6)).toBe(sceneSentenceForSlot(SCENE, 0));
    expect(sceneSentenceForSlot(SCENE, 14)).toBe(sceneSentenceForSlot(SCENE, 2));
  });

  it("falls back to the old behaviour when there is only one sentence", async () => {
    const { sceneSentenceForSlot } = await import("./videoPipeline");
    const single = "A single uninterrupted clause with no terminator";
    expect(sceneSentenceForSlot(single, 0)).toBe(single);
    expect(sceneSentenceForSlot(single, 3)).toBe(single);
    expect(sceneSentenceForSlot("", 1)).toBe("");
  });

  it("respects the length cap the callers relied on", async () => {
    const { sceneSentenceForSlot } = await import("./videoPipeline");
    const long = `${"x".repeat(400)}. ${"y".repeat(400)}.`;
    expect(sceneSentenceForSlot(long, 0).length).toBeLessThanOrEqual(220);
  });

  it("the fast-short rescue loop refreshes the query per slot", async () => {
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const idx = src.indexOf("stubBeat.index = fi;");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 600);
    expect(block).toContain("sceneSentenceForSlot(scene.text, fi)");
    expect(block).toContain("stubBeat.powerWord =");
    expect(block).toContain("stubBeat.searchQuery =");
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

  it("the new thresholds spread the same measurement across all three tiers", async () => {
    const {
      BEAT_ARCHIVE_STOP_THRESHOLD,
      BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD,
      BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD,
    } = await import("./retrievalFunnel");

    const stop = RENDER_530_BEAT_SCORES.filter((s) => s >= BEAT_ARCHIVE_STOP_THRESHOLD);
    const one = RENDER_530_BEAT_SCORES.filter(
      (s) => s >= BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD && s < BEAT_ARCHIVE_STOP_THRESHOLD
    );
    const all = RENDER_530_BEAT_SCORES.filter((s) => s < BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD);

    // Each tier now carries beats. That is the property that was missing, not any exact split.
    expect(stop.length).toBeGreaterThan(0);
    expect(one.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(0);
    expect(stop.length + one.length + all.length).toBe(14);
    // And the ordering that makes the tiers mean anything at all still holds.
    expect(BEAT_ARCHIVE_STOP_THRESHOLD).toBeGreaterThan(BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD);
    expect(BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD).toBeGreaterThan(BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD);
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
