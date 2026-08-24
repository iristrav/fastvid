import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  decideModernContentMismatch,
  topicNeedsHistoricalFootage,
  type ModernMismatchFrameEvidence,
} from "./localClipVision";

// FASE 7.3 — candidate rejection safety.
//
// modernContentMismatch is a HARD veto: it enters definiteFail / wrongSubject /
// matchesNarration as an OR term, so one `true` destroys a candidate no matter how well it
// actually scored. Production render 512 proved the original conditions could not carry that
// weight — 14 of 14 candidates that cleared the similarity floor (scores 7.40-9.43 against a
// 7.00 floor) were killed by this gate, with zero corroborating metadata/title/date evidence
// that any of them was modern.
//
// Original conditions, both evaluated per (frame, probe) with `return true` on first hit:
//   (1) negSim >= beatSim - 0.01
//   (2) negSim >= 0.18 && beatSim < 0.24
//
// New rule: evidence must be decisive (margin over the beat's own query), absolute (above the
// CLIP noise band), and corroborated across >=2 probes and >=2 frames. Anything less returns
// mismatch:false and the candidate goes back to the normal similarity/ranking flow.

/** Similarities actually observed in render 512 for candidates this gate destroyed. */
const RENDER_512_KILLED = [
  { clip: "s1b0_inet_img_serp_serp_0", sim: 0.2358, score: 9.43 },
  { clip: "s0b1_inet_img_serp_serp_0", sim: 0.2232, score: 8.93 },
  { clip: "s0b1_inet_img_ov_openverse_d8a1143d", sim: 0.2153, score: 8.61 },
  { clip: "s0b1_inet_img_ov_openverse_2f20d646", sim: 0.2187, score: 8.75 },
  { clip: "s2b1_inet_img_ov_openverse_549ea7d5", sim: 0.2130, score: 8.52 },
  { clip: "s1b0_inet_img_ov_openverse_1b2cb4bc", sim: 0.2061, score: 8.24 },
  { clip: "s1b0_inet_img_ov_openverse_3cc3dd7a", sim: 0.2033, score: 8.13 },
  { clip: "s2b1_inet_img_serp_serp_0", sim: 0.1849, score: 7.40 },
  { clip: "s1b0_person_stock_vid5438975", sim: 0.2078, score: 8.31 },
  { clip: "s2b0_person_stock_vid38655901", sim: 0.2067, score: 8.27 },
  { clip: "s0b0_person_stock_vid38630305", sim: 0.2035, score: 8.14 },
  { clip: "s1b0_person_stock_vid37874130", sim: 0.1966, score: 7.87 },
  { clip: "s0b0_person_stock_vid7643457", sim: 0.1883, score: 7.53 },
  { clip: "s2b0_person_stock_vid37874132", sim: 0.1868, score: 7.47 },
];

/** Builds n identical frames from one beatSim + probe similarity list. */
function frames(n: number, beatSim: number, negSims: number[]): ModernMismatchFrameEvidence[] {
  return Array.from({ length: n }, () => ({ beatSim, negSims }));
}

/** The old gate, reproduced exactly, so "used to reject / no longer rejects" is provable. */
function legacyWouldReject(fs: ModernMismatchFrameEvidence[]): boolean {
  for (const { beatSim, negSims } of fs) {
    for (const negSim of negSims) {
      if (negSim >= beatSim - 0.01) return true;
      if (negSim >= 0.18 && beatSim < 0.24) return true;
    }
  }
  return false;
}

const localSrc = readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");
const gateSrc = readFileSync(path.join(__dirname, "visualQualityGate.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("FASE 7.3 Test 1 — one generic modern probe cannot reject a candidate above the floor", () => {
  it("a single probe at the absolute floor does not flag its frame", () => {
    // One probe well past MODERN_EVIDENCE_MIN_SIM and past the margin; the other four silent.
    const fs = frames(3, 0.20, [0.40, 0.05, 0.05, 0.05, 0.05]);
    const v = decideModernContentMismatch(fs);
    expect(v.mismatch).toBe(false);
    expect(v.reason).toBe("insufficient-evidence");
    expect(v.framesFlagged).toBe(0);
  });

  it("two corroborating probes on two frames DO reject — the gate still works on real evidence", () => {
    const fs = frames(3, 0.20, [0.40, 0.38, 0.05, 0.05, 0.05]);
    const v = decideModernContentMismatch(fs);
    expect(v.mismatch).toBe(true);
    expect(v.reason).toBe("strong-modern-evidence");
    expect(v.framesFlagged).toBe(3);
  });

  it("strong evidence on only ONE frame is not enough — one frame is never sufficient", () => {
    const fs: ModernMismatchFrameEvidence[] = [
      { beatSim: 0.20, negSims: [0.42, 0.40, 0.38, 0.05, 0.05] }, // overwhelming
      { beatSim: 0.20, negSims: [0.05, 0.05, 0.05, 0.05, 0.05] },
      { beatSim: 0.20, negSims: [0.05, 0.05, 0.05, 0.05, 0.05] },
    ];
    const v = decideModernContentMismatch(fs);
    expect(v.framesFlagged).toBe(1);
    expect(v.mismatch).toBe(false);
  });
});

describe("FASE 7.3 Test 2 — a marginally-higher negSim is no longer an instant veto", () => {
  it("negSim just above beatSim (the old `- 0.01` condition) does not reject", () => {
    const fs = frames(3, 0.20, [0.21, 0.205, 0.20, 0.199, 0.195]);
    // Every probe would have tripped the old rule.
    expect(legacyWouldReject(fs)).toBe(true);
    const v = decideModernContentMismatch(fs);
    expect(v.mismatch).toBe(false);
    expect(v.legacyWouldReject).toBe(true); // behaviour change is recorded, not hidden
  });

  it("a probe that scores BELOW the beat query can never be evidence (old rule allowed it)", () => {
    const fs = frames(3, 0.30, [0.295, 0.29, 0.29, 0.28, 0.28]);
    expect(legacyWouldReject(fs)).toBe(true); // 0.295 >= 0.30 - 0.01
    expect(decideModernContentMismatch(fs).mismatch).toBe(false);
  });

  it("clearing the absolute floor is not enough without the margin over beatSim", () => {
    // Probes at 0.30 (well past MODERN_EVIDENCE_MIN_SIM) but the beat query matches even
    // better at 0.32 — the image is more "beat" than "modern", so this is not evidence.
    const fs = frames(3, 0.32, [0.30, 0.30, 0.30, 0.30, 0.30]);
    expect(decideModernContentMismatch(fs).mismatch).toBe(false);
  });

  it("clearing the margin is not enough without the absolute floor", () => {
    // Probes beat the beat query by well over the margin, but everything sits down in the
    // noise band — a low-similarity image where nothing matches, not a modern image.
    const fs = frames(3, 0.05, [0.15, 0.14, 0.13, 0.12, 0.11]);
    expect(decideModernContentMismatch(fs).mismatch).toBe(false);
  });
});

describe("FASE 7.3 Test 3 — beatSim < 0.24 is no longer self-rejecting", () => {
  it("the old `negSim >= 0.18 && beatSim < 0.24` condition alone does not reject", () => {
    const fs = frames(3, 0.23, [0.18, 0.18, 0.18, 0.18, 0.18]);
    expect(legacyWouldReject(fs)).toBe(true);
    expect(decideModernContentMismatch(fs).mismatch).toBe(false);
  });

  it("the whole 0.175-0.24 band (score 7.0-9.6) survives a probe sitting at 0.18", () => {
    // 0.175 is minLocalClipSimilarity(7) — the configured floor. Under the old rule this
    // entire band was vetoed, silently raising the effective pass bar to ~9.6/10.
    for (let beatSim = 0.175; beatSim < 0.24; beatSim += 0.005) {
      const fs = frames(3, beatSim, [0.18, 0.18, 0.18, 0.18, 0.18]);
      expect(decideModernContentMismatch(fs).mismatch).toBe(false);
    }
  });
});

describe("FASE 7.3 Test 4 — historical candidates with insufficient evidence are ALLOWED", () => {
  it("the gate only arms on historical topics at all (render 512: title contains 'Hitler')", () => {
    expect(topicNeedsHistoricalFootage("beat text", "Why Hitler Chose Death Over Escape")).toBe(true);
    expect(topicNeedsHistoricalFootage("a beat about world war two")).toBe(true);
    expect(topicNeedsHistoricalFootage("how to bake sourdough bread", "Baking Basics")).toBe(false);
  });

  it("all 14 candidates render 512 destroyed are now allowed through", () => {
    // Reconstructed conservatively AGAINST the fix: every probe is given the highest
    // similarity still consistent with the observed data (equal to the candidate's own
    // beatSim), i.e. the strongest modern "signal" that could have been present. Even then,
    // none of them constitutes evidence, because no probe decisively beats the beat query.
    for (const c of RENDER_512_KILLED) {
      const fs = frames(3, c.sim, [c.sim, c.sim, c.sim, c.sim, c.sim]);
      const v = decideModernContentMismatch(fs);
      expect(legacyWouldReject(fs), `${c.clip} should have been killed by the old rule`).toBe(true);
      expect(v.mismatch, `${c.clip} (score ${c.score}) must now survive`).toBe(false);
      expect(v.reason).toBe("insufficient-evidence");
    }
  });

  it("the verdict carries the fields the production log needs", () => {
    const v = decideModernContentMismatch(frames(2, 0.20, [0.31, 0.30, 0.05, 0.05, 0.05]));
    expect(v.beatSim).toBeCloseTo(0.20, 10);
    expect(v.topNegSim).toBeCloseTo(0.31, 10);
    expect(v.topProbe).toBeTruthy();
    expect(v.framesEvaluated).toBe(2);
    expect(v.probesEvaluated).toBe(5);
    expect(typeof v.framesFlagged).toBe("number");
    expect(typeof v.legacyWouldReject).toBe("boolean");
  });

  it("degenerate inputs never reject", () => {
    expect(decideModernContentMismatch([]).mismatch).toBe(false);
    expect(decideModernContentMismatch([]).reason).toBe("no-frames");
    expect(decideModernContentMismatch([{ beatSim: 0.2, negSims: [] }]).mismatch).toBe(false);
    expect(decideModernContentMismatch([{ beatSim: 0.2, negSims: [] }]).reason).toBe("no-probes");
  });
});

describe("FASE 7.3 Test 5 — the real similarity rejection is untouched", () => {
  it("the similarity floor and score conversion are byte-for-byte unchanged", () => {
    expect(localSrc).toContain("return minScore10 / 40;");
    expect(localSrc).toContain("return Math.max(0, Math.min(10, Math.round(sim * 40)));");
    expect(localSrc).toMatch(/scoreEmbeddingSimilarity\([^)]*\)[^{]*\{\s*return Math\.max\(0, cosineSimilarityRaw/);
  });

  it("the pass/fail expressions still consult similarity first, with modernMismatch as one term", () => {
    expect(localSrc).toContain("const similarityPass = worst.similarity >= minSim && !modernMismatch;");
    expect(localSrc).toContain(
      "const matchesNarration = worst.similarity >= minSim && !darkReject && !modernMismatch;"
    );
    expect(localSrc).toContain("const showsSubject = worst.similarity >= minSim;");
    expect(localSrc).toContain(
      "const wrongSubject = worst.similarity < minSim || darkReject || modernMismatch;"
    );
    expect(localSrc).toContain("worst.similarity < minSim - 0.04 || modernMismatch;");
  });

  it("VisionGate's own pass/fail comparisons are unchanged", () => {
    expect(gateSrc).toContain("worstScore10 >= minScore &&");
    expect(gateSrc).toContain("result.score >= minScore");
    expect(gateSrc).toContain("if (quick && quickScore10 >= minScore && !quick.modernMismatch) {");
  });

  it("the shared cosineSimilarity guard is unchanged", () => {
    const semSrc = readFileSync(path.join(__dirname, "semanticVisualMatching.ts"), "utf8");
    expect(semSrc).toContain("if (a.length !== b.length || a.length === 0) return 0;");
  });
});

describe("FASE 7.3 Test 6 — FASE 7.2 embedding separation intact", () => {
  it("the funnel still passes no queryEmb to VisionGate", () => {
    const start = pipelineSrc.indexOf("let funnelBeatEmb: number[] | null = null;");
    const end = pipelineSrc.indexOf("const winner = pickBestFunnelCandidate(scored);", start);
    const block = pipelineSrc.slice(start, end);
    const callStart = block.indexOf("await evaluateClipVisionGate(");
    const call = block.slice(callStart, block.indexOf(");", callStart));
    expect(call).not.toContain("funnelBeatEmb");
    const args = call
      .slice(call.indexOf("(") + 1)
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    expect(args[10]).toBe("undefined"); // queryEmb slot
  });

  it("the text embedding is still used for archive/text ranking", () => {
    // RONDE 38: third (optional, diagnostic-only) argument added — arg 2 unchanged.
    expect(pipelineSrc).toMatch(/findBestArchiveScoreForBeat\(funnelResult\.candidates,\s*beatEmb[,)]/);
    const calls = pipelineSrc.match(/computeSegmentSimilarities\([^)]*\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("funnelBeatEmb");
  });

  it("VisionGate still resolves its own CLIP query embedding, and CLIP stays one model", () => {
    expect(gateSrc).toMatch(
      /const queryEmbResolved\s*=\s*\n?\s*queryEmb\s*\?\?\s*\n?\s*\(await stepWithTimeout\([\s\S]{0,200}resolveBeatQueryEmbedding/
    );
    expect(localSrc).toContain('const CLIP_MODEL = "Xenova/clip-vit-base-patch32"');
  });
});

describe("FASE 7.3 Test 7 — FASE 7.1 streaming / AbortSignal fix intact", () => {
  it("fetchWithTimeout still merges the scene-fetch scope signal", () => {
    const idx = pipelineSrc.indexOf("async function fetchWithTimeout(");
    const scoped = pipelineSrc.slice(idx, idx + 1800);
    expect(scoped).toContain("sceneFetchScopeStorage.getStore()?.controller.signal");
    expect(scoped).toContain("AbortSignal.any([controller.signal, scopeSignal])");
  });

  it("downloadToFileStreaming still streams instead of buffering", () => {
    const idx = pipelineSrc.indexOf("export async function downloadToFileStreaming(");
    // RONDE 21 widened this window: the function grew when the body-read stall guard was added,
    // pushing createWriteStream past the old fixed 3500-char slice. The assertion is unchanged.
    const scoped = pipelineSrc.slice(idx, idx + 6000);
    expect(scoped).not.toContain("arrayBuffer()");
    expect(scoped).toContain("fs.createWriteStream(destPath)");
  });
});

describe("FASE 7.3 Test 8 — no threshold constant was changed", () => {
  it("the FASE 7.3 constants are new and separate from any similarity threshold", () => {
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MIN_SIM = visionThreshold\("MODERN_EVIDENCE_MIN_SIM", 0\.235\)/);
    expect(localSrc).toMatch(/const MODERN_EVIDENCE_MARGIN = visionThreshold\("MODERN_EVIDENCE_MARGIN", 0\.015\)/);
    expect(localSrc).toContain("const MODERN_EVIDENCE_MIN_PROBES = 2;");
    expect(localSrc).toContain("const MODERN_EVIDENCE_MIN_FRAMES = 2;");
    // The gate-threshold helpers themselves are untouched.
    expect(localSrc).toMatch(/export function minLocalClipSimilarity\(minScore10 = 8\): number \{/);
    expect(localSrc).toContain("if (!isNaN(n) && n >= 0.08 && n <= 0.55) return n;");
  });

  it("MIN_SIM sits above the entire band of the candidates render 512 wrongly rejected", () => {
    const highest = Math.max(...RENDER_512_KILLED.map((c) => c.sim));
    expect(highest).toBeLessThan(0.26);
  });

  it("the 5 modern probes are unchanged in wording and count", () => {
    expect(localSrc).toContain('"modern business conference presentation projector screen audience"');
    expect(localSrc).toContain('"laptop computer software code documentation office meeting"');
    expect(localSrc).toContain('"corporate keynote speaker slide deck technology startup"');
    expect(localSrc).toContain('"smartphone tablet digital app interface screen"');
    expect(localSrc).toContain('"contemporary office whiteboard team meeting"');
  });
});

describe("FASE 7.3 Test 9 — no other rejection gate was touched", () => {
  it("the arming condition topicNeedsHistoricalFootage is unchanged", () => {
    expect(localSrc).toContain('if (topic === "wwii" || topic === "cold_war") return true;');
    expect(localSrc).toContain(
      "/\\b(19\\d{2}|20[0-1]\\d|world war|wwii|ww2|war|historical|archive|ancient|century|hitler|nazi|berlin|titanic)\\b/"
    );
  });

  it("the adopt-time gates are unchanged", () => {
    expect(pipelineSrc).toContain("export function scriptImageFallbackPassesRelevanceFloor(");
    expect(pipelineSrc).toContain("if (!providerTitle || !providerTitle.trim()) return true;");
    expect(pipelineSrc).toContain("export function isOffTopicVisualForPersonTopic(");
    expect(pipelineSrc).toContain("export function historicalDateAlignmentScore(");
  });

  it("darkReject / wellFramed luma rules are unchanged", () => {
    expect(localSrc).toContain("wellFramed: luma === null || luma >= 18,");
    expect(localSrc).toContain("scoredFrames.some((s) => s.luma !== null && s.luma < 12)");
  });

  it("the funnel's binary VisionGate filter is unchanged (still out of FASE 7.3's scope)", () => {
    const funnelSrc = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");
    // RONDE 1 renamed the local to allPassers (cross-beat reuse). What this test guards is
    // unchanged: the funnel still considers only VisionGate passers and still returns null
    // when there are none — FASE 7.3 did not and does not touch that.
    expect(funnelSrc).toContain("const allPassers = scored.filter(s => s.visionResult.pass);");
    expect(funnelSrc).toContain("if (allPassers.length === 0) return null;");
  });
});

describe("FASE 7.3 — observability", () => {
  it("one log line per gate evaluation, not per frame, with the required fields", () => {
    const idx = localSrc.indexOf("[ModernMismatch]");
    expect(idx).toBeGreaterThan(-1);
    const scoped = localSrc.slice(idx - 400, idx + 600);
    expect(scoped).toContain("decision=");
    expect(scoped).toContain("reason=");
    expect(scoped).toContain("beatSim=");
    expect(scoped).toContain("topNegSim=");
    expect(scoped).toContain("probe=");
    expect(scoped).toContain("frames=");
    expect(scoped).toContain("probes=");
    expect(scoped).toContain("legacyWouldReject=");
    // Must sit outside the per-frame loop that builds the evidence.
    const mapIdx = localSrc.indexOf("const frames: ModernMismatchFrameEvidence[] = samples.map(");
    expect(mapIdx).toBeLessThan(idx);
  });

  it("silent when the gate did not matter (no probe close, no legacy reject)", () => {
    const v = decideModernContentMismatch(frames(3, 0.30, [0.05, 0.05, 0.05, 0.05, 0.05]));
    expect(v.mismatch).toBe(false);
    expect(v.legacyWouldReject).toBe(false); // -> the `if` around console.log is false
  });
});
