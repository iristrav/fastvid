import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBeatImageGateState } from "./beatImageRelevanceGate";
import { fetchYoutubeVideoContext, _resetYoutubeVideoContextCache } from "./youtubeVideoContext";

/**
 * RONDE 67 — I overshot, and render 533 shows exactly how far.
 *
 *     [VisualCoverage] s1b4: rejected=7 topRejects=beat_image_gate:6,vision_gate:1
 *                      fallback=PLACEHOLDER (all real sourcing strategies exhausted)
 *
 * 34 rejections on the picture gate, eight beats ending on a grey placeholder, archive
 * contributing nothing at all (arch=0, was arch=9). Three rounds stacked — refusals made
 * permanent, the gate put on every route, the text rule tightened — and together they refuse
 * more than the sources can supply.
 *
 * The design error is one thing: the gate applied the same standard to the first candidate and
 * to the last. Refusing the first is free, another follows. Refusing the last means a grey card,
 * which matches the narration worse than the imperfect picture it replaced.
 *
 * Two more from that log: 197 context calls, 89 of them http=429 and not one usable, against a
 * provider with no breaker; and 16 Gemini 429s while the gate was refusing, with nothing in the
 * report to tell "said no" from "could not look".
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetYoutubeVideoContextCache();
});

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 67 — a refused clip beats a placeholder", () => {
  it("the adoption loop moves a refusal to the back of the queue instead of dropping it", () => {
    const src = PIPELINE();
    const idx = src.indexOf("const gateReprieved = new Set<string>();");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 14000);
    expect(block).toContain("gateReprieved.add(p);");
    expect(block).toContain("finalPaths.push(p);");
    // The gate is not applied a second time to a clip that has already been refused.
    expect(block).toContain("!gateReprieved.has(p) &&");
  });

  it("the queue it appends to is a copy it owns", () => {
    const src = PIPELINE();
    // Pushing onto tasteResult.rankedPaths would mutate a caller's array.
    expect(src).toContain("const finalPaths = [...tasteResult.rankedPaths];");
  });

  it("for...of really does visit an item appended during iteration", () => {
    // The whole reprieve rests on this being true of JS arrays.
    const seen: number[] = [];
    const xs = [1, 2];
    for (const x of xs) {
      seen.push(x);
      if (x === 1) xs.push(99);
    }
    expect(seen).toEqual([1, 2, 99]);
  });

  it("a reprieve is announced, so it is never silent", () => {
    const src = PIPELINE();
    expect(src).toContain("[BeatImageGate] reprieve s${sceneIndex}b${beatIndex}");
    expect(src).toContain("a real picture beats a placeholder");
  });

  it("the rejection is still recorded — the reprieve does not hide it from the audit", () => {
    const src = PIPELINE();
    const idx = src.indexOf("const gateReprieved = new Set<string>();");
    const block = src.slice(idx, idx + 14000);
    expect(block).toContain('recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, p, "beat_image_gate", sourceQuery);');
  });

  it("the funnel keeps its refused winner instead of discarding it", () => {
    const src = PIPELINE();
    expect(src).toContain("let gateReprieveWinner: typeof winner = null;");
    expect(src).toContain("gateReprieveWinner = winner;");
    expect(src).toContain("held as reprieve");
    // Used only once nothing else has been found.
    expect(src).toContain("if (!winner && gateReprieveWinner) {");
    expect(src).toContain("winner = gateReprieveWinner;");
  });

  it("the funnel still tries every other source first — the reprieve is last", () => {
    const src = PIPELINE();
    const held = src.indexOf("gateReprieveWinner = winner;");
    const used = src.indexOf("if (!winner && gateReprieveWinner) {");
    expect(held).toBeGreaterThan(-1);
    expect(used).toBeGreaterThan(held);
    // winner is still nulled at the point of refusal, so the normal cascade runs unchanged.
    expect(src.slice(held, held + 120)).toContain("winner = null;");
  });
});

describe("RONDE 67 — the context lookup stops knocking", () => {
  const refuse = () => vi.fn(async () => ({ ok: false, status: 429 }));

  it("stands down after a run of failures instead of asking two hundred times", async () => {
    const f = refuse();
    vi.stubGlobal("fetch", f);
    for (let i = 0; i < 20; i++) await fetchYoutubeVideoContext(`v${i}`, 1_000);
    // Six failures trip it; each failure is one player attempt plus one page attempt.
    expect(f.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("says so once, rather than logging two hundred refusals", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", refuse());
    for (let i = 0; i < 20; i++) await fetchYoutubeVideoContext(`w${i}`, 1_000);
    const standDowns = warn.mock.calls.flat().filter((c) => String(c).includes("standing down"));
    expect(standDowns).toHaveLength(1);
    warn.mockRestore();
  });

  it("a success resets the count, so one bad video does not trip it", async () => {
    const good = JSON.stringify({
      videoDetails: { lengthSeconds: "300" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    });
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).includes("youtubei")) return { ok: false, status: 429 };
        // Every other video answers.
        return ++n % 2 === 0
          ? { ok: true, json: async () => JSON.parse(good) }
          : { ok: false, status: 429 };
      })
    );
    for (let i = 0; i < 12; i++) {
      const ctx = await fetchYoutubeVideoContext(`x${i}`, 1_000);
      if (i % 2 === 1) expect(ctx.durationSec).toBe(300);
    }
    // Never tripped: the alternating successes keep resetting the streak.
    const last = await fetchYoutubeVideoContext("x-final", 1_000);
    expect(last).toBeDefined();
  });

  it("what is already cached is still served while it is standing down", async () => {
    const good = JSON.stringify({ videoDetails: { lengthSeconds: "611" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => JSON.parse(good) })));
    expect((await fetchYoutubeVideoContext("cached", 1_000)).durationSec).toBe(611);
    vi.stubGlobal("fetch", refuse());
    for (let i = 0; i < 20; i++) await fetchYoutubeVideoContext(`y${i}`, 1_000);
    // Standing down now, but the known answer costs nothing and is still given.
    expect((await fetchYoutubeVideoContext("cached", 1_000)).durationSec).toBe(611);
  });

  it("the cooldown is not cleared per render — a rate limit belongs to the address", () => {
    const src = fs.readFileSync(path.join(__dirname, "youtubeVideoContext.ts"), "utf8");
    expect(src).toContain("Deliberately NOT cleared per render");
    // The only place that clears it is the test seam — not any per-render reset.
    const seam = src.indexOf("export function _resetYoutubeVideoContextCache()");
    expect(seam).toBeGreaterThan(-1);
    expect(src.slice(seam, seam + 220)).toContain("cooldownUntilMs = 0;");
    // Outside the declaration and that seam, nothing assigns it to zero.
    const assignments = [...src.matchAll(/^\s*(let )?cooldownUntilMs = 0;/gm)];
    expect(assignments).toHaveLength(2);
    expect(assignments[0]![0]).toContain("let ");
  });
});

describe("RONDE 67 — 'said no' and 'could not look' are different numbers now", () => {
  it("the state counts judgements the model could not deliver", () => {
    const state = createBeatImageGateState();
    expect(state.judgementsFailed).toBe(0);
  });

  it("every way a judgement can fail is counted", () => {
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    const bumps = [...src.matchAll(/state\.judgementsFailed\+\+/g)];
    // A thrown error, a missing answer, an answer with no verdict.
    expect(bumps).toHaveLength(3);
  });

  it("it still fails OPEN — counting is not rejecting", () => {
    const src = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    const idx = src.indexOf("state.judgementsFailed++;\n    return unknown(`judgement failed");
    expect(idx).toBeGreaterThan(-1);
    expect(src).toContain("A model outage must not be able to empty a montage");
  });

  it("the quality report separates the two, and warns when the verdicts were mostly unobtainable", () => {
    const src = PIPELINE();
    expect(src).toContain("beat image gate — judged=${g.judgementsUsed} unavailable=${g.judgementsFailed}");
    expect(src).toContain("ONGEZIEN aangenomen");
  });

  it("the warning does not fire on a render where the model was merely slow once or twice", () => {
    const src = PIPELINE();
    // Needs at least 3 failures AND a quarter of the total before it is worth saying.
    expect(src).toContain("g.judgementsFailed >= Math.max(3, g.judgementsUsed * 0.25)");
  });
});
