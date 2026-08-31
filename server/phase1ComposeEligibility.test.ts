/**
 * PHASE 1 — an expired retrieval scope must not invalidate an adopted clip.
 *
 * ── What went wrong ──────────────────────────────────────────────────────────────────────────
 *
 *     if (sceneFetchAborted()) return false;
 *
 * A scene's fetch scope is a budget for LOOKING. When it expires, no new search, download, probe
 * or rescue may start. That line turned it into a verdict on clips that had already been found:
 * video 558 threw away fourteen, ten of them already-downloaded archive files that had passed the
 * technical gate, been judged by Vision and been adopted. Scene 1 finished with 2 unique clips for
 * 13 beats.
 *
 * ── The four tests the brief asks for ────────────────────────────────────────────────────────
 *
 *   A  fetch scope expired + adopted valid clip   → COMPOSE PASS
 *   B  fetch scope expired + invalid clip         → COMPOSE FAIL
 *   C  fetch scope expired                        → no additional retrieval/probe/rescue work
 *   D  existing adopted clips remain available for compose
 *
 * Test C is the one that is easy to fake and hard to prove. It is asserted two ways: the rule is a
 * pure function that cannot touch a disk even if it wanted to, and the pipeline's own abort branch
 * is read to confirm no probe call sits inside it.
 */
import { describe, expect, it } from "vitest";

import {
  composeScopeVerdict,
  formatComposeScopeDecision,
  type ComposeScopeInput,
} from "./composeEligibility";
import { VisualSourceLedger } from "./visualSourceLineage";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, rel), "utf8");
};

const scopeExpired = (over: Partial<ComposeScopeInput> = {}): ComposeScopeInput => ({
  scopeAborted: true,
  adopted: false,
  priorMeasurementUsable: null,
  ...over,
});

/* ═══════════════════════ TEST A ═══════════════════════ */

describe("PHASE 1 / TEST A — scope expired + adopted valid clip → COMPOSE PASS", () => {
  it("an adopted clip passes, with adoption named as the basis", () => {
    const v = composeScopeVerdict(scopeExpired({ adopted: true }));
    expect(v.decision).toBe("pass");
    if (v.decision === "pass") expect(v.basis).toBe("already_adopted");
  });

  it("it passes even with NO measurement memoised for this path", () => {
    /**
     * The gap RONDE 138 left. Its rule answered from a memoised probe, so a clip whose measurement
     * happened not to be cached under this exact path was still thrown away — the outcome depended
     * on a cache rather than on what was known about the clip.
     */
    const v = composeScopeVerdict(scopeExpired({ adopted: true, priorMeasurementUsable: null }));
    expect(v.decision).toBe("pass");
  });

  it("adoption is the stronger fact and is checked first", () => {
    // A measurement says the file decodes. Adoption says the technical gate, the vision gate and
    // the beat all accepted it. When both are present the log must name the stronger one.
    const v = composeScopeVerdict(scopeExpired({ adopted: true, priorMeasurementUsable: true }));
    expect(v.decision).toBe("pass");
    if (v.decision === "pass") expect(v.basis).toBe("already_adopted");
  });
});

/* ═══════════════════════ TEST B ═══════════════════════ */

describe("PHASE 1 / TEST B — scope expired + invalid clip → COMPOSE FAIL", () => {
  it("a clip that was never adopted and has no measurement is refused", () => {
    const v = composeScopeVerdict(scopeExpired());
    expect(v.decision).toBe("fail");
    if (v.decision === "fail") expect(v.basis).toBe("scope_abandoned_unmeasured");
  });

  it("a clip MEASURED AS UNUSABLE is refused — false is not the same as null", () => {
    /**
     * The distinction the whole round turns on. `null` means "not measured"; `false` means
     * "measured, and it failed". Collapsing them would either throw away good clips or admit
     * broken ones, depending on which way the collapse went.
     */
    const v = composeScopeVerdict(scopeExpired({ priorMeasurementUsable: false }));
    expect(v.decision).toBe("fail");
  });

  it("a linked derived file is not adopted in its own right", () => {
    /**
     * pad_combined_*.mp4 and the text-overlay output are written moments before the gate and have
     * never been examined. `linkDerivedPath` gives each of them its OWN record, so neither lookup
     * would confuse one with its parent — worth asserting because the pipeline depends on it, but
     * it is NOT what the exact-path rule is for. The next test is.
     */
    const ledger = new VisualSourceLedger({ renderId: "render-phase1" });
    const parent = ledger.createLineage({
      sceneIndex: 1, beatIndex: 0,
      candidateId: "wikimedia:111", contentKey: "wikimedia:111",
      localPath: "/w/scene_1_b0_wiki.mp4", provider: "wikimedia", providerAssetId: "111",
    });
    ledger.recordEvent(parent.lineageId, "ADOPTED", { status: "OK" });
    ledger.linkDerivedPath("/w/pad_combined_1.mp4", "/w/scene_1_b0_wiki.mp4", "PADDED");

    expect(ledger.adoptedAtPath("/w/scene_1_b0_wiki.mp4"), "the adopted file itself").toBe(true);
    expect(ledger.resolve("/w/pad_combined_1.mp4")).not.toBeNull();
    expect(ledger.adoptedAtPath("/w/pad_combined_1.mp4")).toBe(false);
    expect(composeScopeVerdict(scopeExpired({ adopted: false })).decision).toBe("fail");
  });

  it("THE BOUNDARY: a second file for an adopted ASSET is not itself adopted", () => {
    /**
     * This is what the exact-path lookup is actually for, and the case that separates it from
     * `resolve()`.
     *
     * The curated archive's records are reachable by content key — RONDE 167 added that precisely
     * because the file `scene_N_bM_curated_a<id>.mp4` is never registered as a path. So a SECOND
     * file naming the same asset id resolves, through `deriveContentKey`, to the record that was
     * adopted for the FIRST one. Under `resolve()` that second file would inherit an adoption it
     * never earned, on the strength of a filename.
     *
     * `adoptedAtPath` asks `byPath` and nothing else, so it answers about the file in front of it.
     */
    const ledger = new VisualSourceLedger({ renderId: "render-phase1" });
    // The render's own content-key resolver: a curated filename names its archive asset.
    ledger.setContentKeyResolver((p) => {
      const m = /_curated_a(\d+)\.mp4$/.exec(p);
      return m ? `curated:asset:${m[1]}` : undefined;
    });
    const adopted = ledger.createLineage({
      sceneIndex: 1, beatIndex: 4,
      candidateId: "curated:asset:57618", contentKey: "curated:asset:57618",
      localPath: "/w/scene_1_b4_curated_a57618.mp4", provider: "archive", providerAssetId: "57618",
    });
    ledger.recordEvent(adopted.lineageId, "ADOPTED", { status: "OK" });

    const second = "/w/scene_9_b0_curated_a57618.mp4";
    // resolve() finds the adopted record for it, by content key, from the filename alone...
    expect(ledger.resolve(second)?.adoptedAt).toBeTypeOf("number");
    // ...and the exact-path question answers about the file itself.
    expect(
      ledger.adoptedAtPath(second),
      "a file inherited an adoption from a same-asset sibling"
    ).toBe(false);
    expect(ledger.adoptedAtPath("/w/scene_1_b4_curated_a57618.mp4")).toBe(true);
  });

  it("an unknown path is not adopted", () => {
    const ledger = new VisualSourceLedger({ renderId: "render-phase1" });
    expect(ledger.adoptedAtPath("/w/never-seen.mp4")).toBe(false);
    expect(ledger.adoptedAtPath("")).toBe(false);
  });

  it("a record that exists but was never adopted answers false", () => {
    const ledger = new VisualSourceLedger({ renderId: "render-phase1" });
    ledger.createLineage({
      sceneIndex: 0, beatIndex: 0,
      candidateId: "pexels:9", contentKey: "pexels:9",
      localPath: "/w/found_but_refused.mp4", provider: "pexels", providerAssetId: "9",
    });
    expect(ledger.adoptedAtPath("/w/found_but_refused.mp4")).toBe(false);
  });
});

/* ═══════════════════════ TEST C ═══════════════════════ */

describe("PHASE 1 / TEST C — an expired scope starts no new retrieval, probe or rescue work", () => {
  it("the rule is pure: it cannot probe, because it is given no file to probe", () => {
    /**
     * Asserted structurally rather than by counting spawns. `composeScopeVerdict` receives three
     * booleans and no path, no work directory and no ffmpeg handle, so "did it probe" is not a
     * question that can be answered wrongly.
     */
    // Comments stripped first: this module's own prose says the word "ffmpeg" while explaining why
    // a half-written result must not pass, and a prose match would fail the test for the opposite
    // of the reason it exists. Line-anchored, for the reason RONDE 134/136/138 record.
    const src = read("composeEligibility.ts")
      .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
      .replace(/^[ \t]*\*.*$/gm, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(src).toContain("export function composeScopeVerdict");
    for (const forbidden of [
      "probeVideoStreamMeta", "isValidVideoFile", "probeClipMeanLuma", "ffmpeg",
      "execFile", "spawn", "readFileSync", "existsSync",
    ]) {
      expect(src, `the rule reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the pipeline's abort branch does no probing either", () => {
    /**
     * The branch may read a MEMOISED measurement — that is a map lookup, not work — and may not
     * start one. `memoisedVideoStreamMeta` is the read-only accessor; `probeVideoStreamMeta` and
     * `isValidVideoFile` are the ones that spawn.
     */
    const pipeline = read("videoPipeline.ts");
    const start = pipeline.indexOf("    if (sceneFetchAborted()) {\n      const known = memoisedVideoStreamMeta(clipPath);");
    expect(start, "the abort branch moved — this test must be re-anchored").toBeGreaterThan(0);
    const branch = pipeline.slice(start, pipeline.indexOf("if (!(await isValidVideoFile(clipPath))) return false;", start));
    expect(branch.length).toBeGreaterThan(200);
    expect(branch).toContain("memoisedVideoStreamMeta(clipPath)");
    expect(branch).toContain("composeScopeVerdict({");
    expect(branch, "a probe inside the abort branch").not.toContain("await probeVideoStreamMeta");
    expect(branch, "a validity spawn inside the abort branch").not.toContain("await isValidVideoFile");
    expect(branch, "a luma probe inside the abort branch").not.toContain("probeClipMeanLuma");
    // And nothing in the branch awaits at all — every input is already in hand.
    expect(branch).not.toContain("await ");
  });

  it("with the scope alive nothing here applies — the full gate still runs", () => {
    const v = composeScopeVerdict({
      scopeAborted: false, adopted: false, priorMeasurementUsable: null,
    });
    expect(v.decision).toBe("run_full_gate");
    // Including for an adopted clip: a live scope means the real checks are affordable, and the
    // round must not turn adoption into a way to skip them.
    expect(
      composeScopeVerdict({ scopeAborted: false, adopted: true, priorMeasurementUsable: true })
        .decision
    ).toBe("run_full_gate");
  });
});

/* ═══════════════════════ TEST D ═══════════════════════ */

describe("PHASE 1 / TEST D — existing adopted clips remain available for compose", () => {
  it("video 558's scene 1: ten adopted archive clips all survive an expired scope", () => {
    /**
     * The measured failure, as a test. Each of these had been downloaded, had passed the technical
     * gate, had been judged by Vision and had been adopted; all ten were discarded, and the scene
     * composed from 2 clips for 13 beats.
     */
    const ledger = new VisualSourceLedger({ renderId: "render-558" });
    const paths = Array.from({ length: 10 }, (_, i) => `/w/scene_1_b${i}_curated_a576${i}.mp4`);
    for (const [i, p] of paths.entries()) {
      const rec = ledger.createLineage({
        sceneIndex: 1, beatIndex: i,
        candidateId: `curated:asset:${576 + i}`, contentKey: `curated:asset:${576 + i}`,
        localPath: p, provider: "archive", providerAssetId: String(576 + i),
      });
      ledger.recordEvent(rec.lineageId, "ADOPTED", { status: "OK" });
    }
    const surviving = paths.filter(
      (p) =>
        composeScopeVerdict(scopeExpired({ adopted: ledger.adoptedAtPath(p) })).decision === "pass"
    );
    expect(surviving).toHaveLength(10);
  });

  it("the log says which clips were kept and why, in words a person can act on", () => {
    const adopted = formatComposeScopeDecision({
      sceneIndex: 1, clipIndex: 4, basename: "scene_1_b4_curated_a57618.mp4",
      verdict: composeScopeVerdict(scopeExpired({ adopted: true })),
    });
    expect(adopted).toContain("scene_1_b4_curated_a57618.mp4");
    expect(adopted).toContain("already adopted");
    expect(adopted).toContain("vision gate");

    const measured = formatComposeScopeDecision({
      sceneIndex: 2, clipIndex: 0, basename: "scene_2_b0_wiki.mp4",
      verdict: composeScopeVerdict(scopeExpired({ priorMeasurementUsable: true })),
      detail: "1280x720, 6.20s",
    });
    expect(measured).toContain("measurement already taken");
    expect(measured).toContain("1280x720, 6.20s");

    const refused = formatComposeScopeDecision({
      sceneIndex: 3, clipIndex: 1, basename: "pad_combined_3.mp4",
      verdict: composeScopeVerdict(scopeExpired()),
    });
    // A refusal here is not a judgement that the clip is bad, and the line must not read as one.
    expect(refused).toContain("never adopted");
    expect(refused).toContain("no earlier measurement");
    expect(refused).toContain("scope has ended");
  });

  it("the compose barrier still runs BEFORE any of this — a blocked clip stays blocked", () => {
    /**
     * RONDE 103's barrier answers a different question (did anything object to this clip, and was
     * that objection overruled). It sits above the scope branch and this round must not have moved
     * it: an adopted clip that the relevance ledger blocks is still blocked.
     */
    const pipeline = read("videoPipeline.ts");
    const fn = pipeline.slice(
      pipeline.indexOf("async function montageClipPassesComposeGate("),
      pipeline.indexOf("async function estimateSceneMontageCoverageSec(")
    );
    expect(fn.length).toBeGreaterThan(1000);
    expect(fn.indexOf("composeBarrierAllows(")).toBeLessThan(fn.indexOf("if (sceneFetchAborted())"));
    expect(fn).toContain("if (!barrier.allow) {");
  });

  it("the pipeline actually ASKS the ledger — the rule is not wired to a constant", () => {
    /**
     * A pure rule is only as good as its inputs. `adopted: false` hard-coded at the call site would
     * leave every test in this file green while the render behaved exactly as it did before, which
     * is the one way this round could pass its own tests and change nothing.
     */
    const pipeline = read("videoPipeline.ts");
    const start = pipeline.indexOf("      const verdict = composeScopeVerdict({");
    expect(start).toBeGreaterThan(0);
    const call = pipeline.slice(start, pipeline.indexOf("});", start));
    expect(call).toContain("adoptedAtPath(clipPath)");
    expect(call, "the adoption input was pinned to a constant").not.toMatch(/adopted:\s*(true|false)\s*,/);
    expect(call).toContain("priorMeasurementUsable: usable");
  });
});
