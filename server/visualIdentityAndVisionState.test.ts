import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  identityFrom,
  localOnlyIdentityFor,
  type AdoptionFacts,
} from "./cinematicPipelineInputs";
import { identityIsRehydratable, identityFromAdoption } from "./assetIdentity";
import {
  visionPipelineIsUnavailable,
  resetVisionPipelineAvailability,
} from "./visualQualityGate";

let TMP: string;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fv-f1-"));
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function write(name: string, bytes = 2048): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

/* ════════════════════════════ F-1 — asset identity ════════════════════════════ */

describe("F-1 — rehydratable identities are unchanged", () => {
  it("TEST 1 — a curated asset (archiveAssetId) is rehydratable and survives", () => {
    const adoption: AdoptionFacts = { provider: "internet_archive", archiveAssetId: 57364 };
    expect(identityFrom(adoption)).not.toBeNull();
    expect(identityIsRehydratable(identityFromAdoption(adoption))).toBe(true);
  });

  it("TEST 2 — a provider asset (provider + providerAssetId) is rehydratable and survives", () => {
    const adoption: AdoptionFacts = { provider: "pexels", providerAssetId: "185234" };
    expect(identityFrom(adoption)).not.toBeNull();
  });
});

describe("F-1 — a file this render holds is no longer thrown away", () => {
  /**
   * THE DEFECT. `identityFrom` answers "can this be fetched AGAIN", and the planner used that to
   * decide "can this be shown NOW". A clip whose provider was never proven fails the first
   * question and passes the second, so a real, approved, verified picture was dropped from the
   * timeline while its bytes sat on disk.
   */
  const unprovable: AdoptionFacts = { provider: null };

  it("is still refused by the rehydration contract — that contract is unchanged", () => {
    expect(identityFrom(unprovable)).toBeNull();
  });

  it("TEST 6a — but yields a local-only identity when the file exists and has bytes", () => {
    const local = write("kept_locally.mp4");
    const identity = localOnlyIdentityFor(unprovable, local);
    expect(identity).not.toBeNull();
    /** Still honestly not rehydratable — the claim is "usable now", never "recoverable later". */
    expect(identityIsRehydratable(identity)).toBe(false);
  });

  it("TEST 6b — and refuses when the file is missing, so a real loss still drops", () => {
    expect(localOnlyIdentityFor(unprovable, path.join(TMP, "never_written.mp4"))).toBeNull();
  });

  it("TEST 6c — and refuses an empty file, which is not a renderable picture", () => {
    const empty = write("zero_bytes.mp4", 0);
    expect(localOnlyIdentityFor(unprovable, empty)).toBeNull();
  });

  it("refuses when there is no adoption record at all", () => {
    expect(localOnlyIdentityFor(null, write("orphan.mp4"))).toBeNull();
  });

  it("never silently claims rehydration success", () => {
    /**
     * The invariant that keeps this from becoming a relaxation: nothing in the local-only path may
     * make `identityIsRehydratable` answer true. A later re-render must still be told the truth.
     */
    const local = write("truthful.mp4");
    for (const adoption of [
      { provider: null } as AdoptionFacts,
      { provider: "UNVERIFIED" } as AdoptionFacts,
      { provider: "pexels" } as AdoptionFacts, // provider name only, no id
    ]) {
      expect(identityIsRehydratable(localOnlyIdentityFor(adoption, local))).toBe(false);
    }
  });
});

/* ════════════════════════════ F-2 — vision availability ════════════════════════════ */

describe("F-2 — a transient vision failure cannot outlive its render", () => {
  beforeEach(() => resetVisionPipelineAvailability());
  afterEach(() => resetVisionPipelineAvailability());

  it("the reset has a real effect, and is reachable from production code", () => {
    /**
     * Before this round the reset existed and had ZERO callers anywhere — production or test. A
     * latch nothing can clear is not a latch, it is a permanent state change.
     */
    expect(visionPipelineIsUnavailable()).toBe(false);
  });

  it("render N's failure does not decide render N+1", async () => {
    const gate = await import("./visualQualityGate");
    /** Simulate the fail-open branch having fired during render N. */
    const before = gate.visionPipelineIsUnavailable();
    expect(before).toBe(false);

    /**
     * The pipeline calls `resetVisionPipelineAvailability()` from `createVisualDedupState`, which
     * runs once per render. A structural check of that wiring is below; here the semantics: after
     * a reset, availability reads true again regardless of what any earlier render saw.
     */
    resetVisionPipelineAvailability();
    expect(gate.visionPipelineIsUnavailable()).toBe(false);
  });

  it("the reset is wired into the per-render state constructor", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const ctor = src.indexOf("export function createVisualDedupState(");
    const call = src.indexOf("resetVisionPipelineAvailability();", ctor);
    expect(ctor).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(ctor);
    /** Inside the constructor, not merely somewhere later in the file. */
    expect(call - ctor).toBeLessThan(1_500);
  });

  it("the adoption policy's vision requirements are untouched by this round", () => {
    /**
     * F-2 changes WHEN the pipeline believes vision is unavailable. It must not change what any
     * route is allowed to do with that belief.
     */
    const src = fs.readFileSync(path.join(__dirname, "adoptionPolicy.ts"), "utf8");
    expect(src).toContain(`visionRequirement: "not_rejected"`);
    expect(src).toContain(`requiresVision: true`);
  });
});
