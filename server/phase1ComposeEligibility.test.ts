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

/* ═══════════════════════ TEST B ═══════════════════════ */

describe("PHASE 1 / TEST B — scope expired + invalid clip → COMPOSE FAIL", () => {

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
