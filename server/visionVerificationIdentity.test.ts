import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * THE REAL RESOLVER, NOT A STUB.
 *
 * `ronde117VerdictFiledUnderASlot.test.ts` binds `(clipPath) => clipPath === CLIP ? KEY : ""`.
 * That proves the lookup LOGIC and is deliberately kept — but it substitutes the one function
 * whose behaviour is the defect, so it could never see that `clipContentKey` answers differently
 * for a full path and for a bare filename. Every test below uses the production resolver.
 */
import { clipContentKey } from "./videoPipeline";
import {
  createBeatRelevanceLedger,
  isCanonicalAssetKey,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";
import { bindContentKeyResolver, type ClipAdoptEntry } from "./clipAdoptAudit";
import { buildBeatVisualStatuses } from "./beatVisualStatus";

let TMP_A: string;
let TMP_B: string;

/** Real files, because three rungs of the resolver read the filesystem. */
function writeClip(dir: string, name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

const PIXELS = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251));
const OTHER_PIXELS = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 91) % 239));

beforeAll(() => {
  TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), "fv-ident-a-"));
  TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), "fv-ident-b-"));
});

afterAll(() => {
  fs.rmSync(TMP_A, { recursive: true, force: true });
  fs.rmSync(TMP_B, { recursive: true, force: true });
});

/**
 * One beat, adopted from `clipPath`, with the verdict already filed by vision under whatever
 * identity the render computed for the path it judged.
 */
function verificationFor(params: {
  visionPath: string;
  adoptedPath: string;
  beatText: string;
  source?: string;
  /** The slot vision filed under — offset routes deliberately differ from the real beat. */
  visionBeatIndex?: number;
}): { verification: string; verdictGap?: string; coverage: string } {
  const ledger: BeatRelevanceLedger = createBeatRelevanceLedger();
  recordExternalRelevanceVerdict(
    ledger,
    params.visionPath,
    clipContentKey(params.visionPath),
    { sceneIndex: 0, beatIndex: params.visionBeatIndex ?? 9, beatText: params.beatText },
    { verdict: "fits", depicts: "", reason: "test" },
    "test"
  );

  const audit: ClipAdoptEntry[] = [];
  bindContentKeyResolver(audit, clipContentKey);
  audit.push({
    sceneIndex: 0,
    beatIndex: 0,
    beatText: params.beatText,
    basename: path.basename(params.adoptedPath),
    source: params.source ?? "archive",
    contentKey: clipContentKey(params.adoptedPath),
  });

  const [status] = buildBeatVisualStatuses(audit, ledger);
  return {
    verification: status!.verification,
    coverage: status!.coverage,
    ...(status!.verdictGap ? { verdictGap: status!.verdictGap } : {}),
  };
}

describe("TEST A — path independence", () => {
  it("the same asset in two directories resolves to one identity", () => {
    const a = writeClip(TMP_A, "scene_0_b1_curated_a4711.mp4", PIXELS);
    const b = writeClip(TMP_B, "scene_0_b1_curated_a4711.mp4", PIXELS);
    expect(clipContentKey(a)).toBe(clipContentKey(b));
    expect(clipContentKey(a)).toBe("curated:asset:4711");
  });
});

describe("TEST B — temporary filename", () => {
  it("a curated asset keeps its identity under a different scene/beat filename", () => {
    const planned = writeClip(TMP_A, "scene_1_b4_curated_a123.mp4", PIXELS);
    const renamed = writeClip(TMP_B, "scene_7_b0_curated_a123.mp4", PIXELS);
    expect(clipContentKey(planned)).toBe(clipContentKey(renamed));
  });

  it("a clip whose name carries no asset id CANNOT keep an identity across a rename", () => {
    /**
     * The honest half of TEST B. Nothing upstream identified this file, so the resolver falls to
     * its filesystem rungs and a rename genuinely changes the answer. The fix does not pretend
     * otherwise — it makes the reader SAY so, which TEST E checks.
     */
    const one = writeClip(TMP_A, "temporary_random_name.mp4", PIXELS);
    const two = writeClip(TMP_B, "another_random_name.mp4", PIXELS);
    expect(clipContentKey(one)).not.toBe(clipContentKey(two));
    expect(isCanonicalAssetKey(clipContentKey(one))).toBe(false);
  });
});

describe("TEST C — vision APPROVED reaches verification across a path change", () => {
  it("a still judged in the work dir is verified_fit after adoption from another directory", () => {
    /**
     * THE REGRESSION. `_wiki_` makes this a still, so vision files it under `still:<sha256>` —
     * computed by READING THE FILE. Before this round the reader recomputed the key from
     * `basename` alone, both filesystem rungs threw, and the lookup went out under the bare
     * filename: verdict present, verdict unreachable, beat reported never_asked.
     */
    const judged = writeClip(TMP_A, "scene_0_b9_wiki_2.mp4", PIXELS);
    const adopted = writeClip(TMP_B, "scene_0_b9_wiki_2.mp4", PIXELS);
    expect(clipContentKey(judged).startsWith("still:")).toBe(true);

    const got = verificationFor({
      visionPath: judged,
      adoptedPath: adopted,
      beatText: "berlin, april 1945",
    });
    expect(got.verification).toBe("verified_fit");
    expect(got.verdictGap).toBeUndefined();
  });

  it("and the beat then counts as a verified own visual", () => {
    const judged = writeClip(TMP_A, "scene_0_b9_openverse_1.mp4", PIXELS);
    const adopted = writeClip(TMP_B, "scene_0_b9_openverse_1.mp4", PIXELS);
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
    ledger,
    judged,
    clipContentKey(judged),
    { sceneIndex: 0, beatIndex: 2000, beatText: "the crowd gathered" },
    { verdict: "fits", depicts: "", reason: "test" },
    "test"
  );
    const audit: ClipAdoptEntry[] = [];
    bindContentKeyResolver(audit, clipContentKey);
    audit.push({
      sceneIndex: 0, beatIndex: 0, beatText: "the crowd gathered",
      basename: path.basename(adopted), source: "archive",
      contentKey: clipContentKey(adopted),
    });
    const [status] = buildBeatVisualStatuses(audit, ledger);
    expect(status!.verifiedOwnVisual).toBe(true);
  });
});

describe("TEST D / E — the filesystem fallback is explicit, never silently wrong", () => {
  it("a file:-identity clip reports no_asset_key, not never_judged", () => {
    /**
     * D2. `file:` and the bare-basename rung are refused by the asset index, so a beat holding one
     * has no identity a verdict could ever be filed under. Reporting `never_judged` there —
     * "the identity is known and the ledger holds no verdict" — pointed every future investigation
     * at the wrong one of two causes.
     */
    const adopted = writeClip(TMP_A, "scene_0_b0_mystery.mp4", PIXELS);
    expect(isCanonicalAssetKey(clipContentKey(adopted))).toBe(false);

    const audit: ClipAdoptEntry[] = [];
    bindContentKeyResolver(audit, clipContentKey);
    audit.push({
      sceneIndex: 0, beatIndex: 0, beatText: "words",
      basename: path.basename(adopted), source: "archive",
      contentKey: clipContentKey(adopted),
    });
    const [status] = buildBeatVisualStatuses(audit, createBeatRelevanceLedger());
    expect(status!.verification).toBe("never_asked");
    expect(status!.verdictGap).toBe("no_asset_key");
  });

  it("write and read agree about which keys are asset identities", () => {
    expect(isCanonicalAssetKey("curated:asset:12")).toBe(true);
    expect(isCanonicalAssetKey("pexels:abc123")).toBe(true);
    expect(isCanonicalAssetKey("stock:vid:99")).toBe(true);
    expect(isCanonicalAssetKey("still:deadbeef")).toBe(true);
    expect(isCanonicalAssetKey("file:1024:clip.mp4")).toBe(false);
    expect(isCanonicalAssetKey("clip.mp4")).toBe(false);
    expect(isCanonicalAssetKey("")).toBe(false);
    expect(isCanonicalAssetKey(undefined)).toBe(false);
  });
});

describe("TEST F / G / H — the identities that already joined still join", () => {
  it("F — a curated asset joins", () => {
    const judged = writeClip(TMP_A, "scene_0_b9_curated_a56045.mp4", PIXELS);
    const adopted = writeClip(TMP_B, "scene_0_b0_curated_a56045.mp4", PIXELS);
    expect(clipContentKey(adopted)).toBe("curated:asset:56045");
    expect(
      verificationFor({ visionPath: judged, adoptedPath: adopted, beatText: "x" }).verification
    ).toBe("verified_fit");
  });

  it("G — a provider-tagged asset joins", () => {
    /** The `__pid_<provider>-<16 hex>` tag the render writes for a provider asset. */
    const name = "scene_0_b3__pid_pexels-0123456789abcdef.mp4";
    const judged = writeClip(TMP_A, name, PIXELS);
    const adopted = writeClip(TMP_B, name, PIXELS);
    expect(clipContentKey(adopted)).toBe("pexels:0123456789abcdef");
    expect(
      verificationFor({ visionPath: judged, adoptedPath: adopted, beatText: "x" }).verification
    ).toBe("verified_fit");
  });

  it("H — a derived (transformed) clip keeps its parent's identity", () => {
    const parent = writeClip(TMP_A, "scene_0_b1_curated_a900.mp4", PIXELS);
    const derived = writeClip(TMP_B, "scene_0_b1_curated_a900_transformed.mp4", PIXELS);
    expect(clipContentKey(derived)).toBe(clipContentKey(parent));
    expect(
      verificationFor({ visionPath: parent, adoptedPath: derived, beatText: "x" }).verification
    ).toBe("verified_fit");
  });
});

describe("TEST I — no false positive", () => {
  it("two different assets never share an identity", () => {
    const a = writeClip(TMP_A, "scene_0_b0_curated_a1.mp4", PIXELS);
    const b = writeClip(TMP_A, "scene_0_b0_curated_a2.mp4", PIXELS);
    expect(clipContentKey(a)).not.toBe(clipContentKey(b));
  });

  it("two different stills with the same name in different directories differ", () => {
    const a = writeClip(TMP_A, "scene_0_b0_wiki_9.mp4", PIXELS);
    const b = writeClip(TMP_B, "scene_0_b0_wiki_9.mp4", OTHER_PIXELS);
    expect(clipContentKey(a)).not.toBe(clipContentKey(b));
  });

  it("a verdict for another asset cannot settle this beat", () => {
    const judged = writeClip(TMP_A, "scene_0_b9_curated_a10.mp4", PIXELS);
    const adopted = writeClip(TMP_B, "scene_0_b0_curated_a11.mp4", PIXELS);
    const got = verificationFor({ visionPath: judged, adoptedPath: adopted, beatText: "x" });
    expect(got.verification).toBe("never_asked");
  });
});

describe("§14 — unknown stays unknown", () => {
  it("a matching identity under DIFFERENT narration does not become verified_fit", () => {
    /**
     * RONDE 118's guard, re-checked against the real resolver: the asset lookup is allowed only
     * when the beat's own words match, so a verdict earned under another beat cannot be borrowed.
     */
    const judged = writeClip(TMP_A, "scene_0_b9_curated_a77.mp4", PIXELS);
    const adopted = writeClip(TMP_B, "scene_0_b0_curated_a77.mp4", PIXELS);
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
    ledger,
    judged,
    clipContentKey(judged),
    { sceneIndex: 0, beatIndex: 9, beatText: "a completely different sentence" },
    { verdict: "fits", depicts: "", reason: "test" },
    "test"
  );
    const audit: ClipAdoptEntry[] = [];
    bindContentKeyResolver(audit, clipContentKey);
    audit.push({
      sceneIndex: 0, beatIndex: 0, beatText: "the words this beat actually plays",
      basename: path.basename(adopted), source: "archive",
      contentKey: clipContentKey(adopted),
    });
    const [status] = buildBeatVisualStatuses(audit, ledger);
    expect(status!.verification).toBe("never_asked");
    expect(status!.verifiedOwnVisual).toBe(false);
  });
});
