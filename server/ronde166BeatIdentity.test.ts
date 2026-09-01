/**
 * RONDE 166 (§10) — an array index is not an identity.
 *
 * ── The assumption §10 asked to remove or prove ──────────────────────────────────────────────
 *
 * `alignMontageMetaWithClips` exists BECAUSE compose drops clips — invalid ones, duplicates — so
 * the position of a kept clip is precisely the thing that cannot be trusted to name its beat. Both
 * of its answers used to rely on it anyway:
 *
 *   · with no usable `beatDurations` it returned `keptClips.map((_, i) => i)`, so one dropped clip
 *     shifted every beat index after it;
 *   · a kept clip whose content key was unknown got `?? 0` — attributed to the scene's FIRST BEAT,
 *     a specific wrong answer that looks deliberate.
 *
 * These tests build the exact situation the function is for — a clip dropped from the middle — and
 * assert the surviving clips still name their own beats.
 *
 * The function is module-private, so the behaviour is exercised through a real temp-file fixture
 * and the exported wrapper that uses it. `clipContentKey` hashes file CONTENT, which is why each
 * fixture clip has different bytes: two identical files are legitimately one asset.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { alignMontageMetaWithClipsForTest } from "./videoPipeline";

let dir: string;
let clips: string[];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r166-identity-"));
  clips = ["a", "b", "c", "d"].map((name, i) => {
    const p = path.join(dir, `${name}.mp4`);
    /** Distinct bytes per file: the key is a content hash, so identical files are one asset. */
    fs.writeFileSync(p, Buffer.alloc(2048 + i * 64, i + 1));
    return p;
  });
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("R166 §10 — a dropped clip does not shift every beat after it", () => {
  /**
   * The case the whole function exists for. Four clips are cut for beats 0..3, compose drops the
   * second, and the two clips after it must still be beats 2 and 3 — not 1 and 2.
   */
  it("keeps each surviving clip on its own beat when one is dropped", () => {
    const kept = [clips[0]!, clips[2]!, clips[3]!];
    const out = alignMontageMetaWithClipsForTest(clips, kept, [4, 4, 4, 4], [0, 1, 2, 3]);
    expect(out.clipBeatIndices).toEqual([0, 2, 3]);
  });

  /**
   * The same, with NO explicit beat indices supplied — the branch that used to return raw
   * positions. Position in the ORIGINAL list is the beat; position in the kept list is not.
   */
  it("uses the original position as the beat when no mapping was supplied", () => {
    const kept = [clips[0]!, clips[2]!, clips[3]!];
    const out = alignMontageMetaWithClipsForTest(clips, kept);
    expect(out.clipBeatIndices, "beat indices collapsed to kept-list positions").toEqual([0, 2, 3]);
  });

  /** And with no durations either — the other half of the old early return. */
  it("still maps by identity when durations are missing or the wrong length", () => {
    const kept = [clips[0]!, clips[3]!];
    expect(alignMontageMetaWithClipsForTest(clips, kept, [], [0, 1, 2, 3]).clipBeatIndices).toEqual([0, 3]);
    expect(alignMontageMetaWithClipsForTest(clips, kept, [4, 4], [0, 1, 2, 3]).clipBeatIndices).toEqual([0, 3]);
  });

  it("drops from the front as correctly as from the middle", () => {
    const kept = [clips[2]!, clips[3]!];
    expect(alignMontageMetaWithClipsForTest(clips, kept, [4, 4, 4, 4], [0, 1, 2, 3]).clipBeatIndices).toEqual([2, 3]);
  });

  /** Nothing dropped: the answer is the identity mapping, unchanged. */
  it("is a no-op when compose kept everything", () => {
    const out = alignMontageMetaWithClipsForTest(clips, clips, [4, 4, 4, 4], [0, 1, 2, 3]);
    expect(out.clipBeatIndices).toEqual([0, 1, 2, 3]);
    expect(out.unmapped).toEqual([]);
  });

  /** A non-contiguous beat mapping is honoured rather than renumbered. */
  it("preserves a beat mapping that is not 0,1,2,3", () => {
    const kept = [clips[1]!, clips[3]!];
    expect(alignMontageMetaWithClipsForTest(clips, kept, [4, 4, 4, 4], [5, 9, 11, 14]).clipBeatIndices)
      .toEqual([9, 14]);
  });
});

describe("R166 §10 — an unmappable clip is reported, never attributed to beat 0", () => {
  /**
   * The second bug. A composed clip the source list does not contain used to be answered with `0`
   * — the scene's first beat — which is a specific wrong claim rather than an admission.
   */
  it("does not silently claim beat 0 for a clip it cannot place", () => {
    const stranger = path.join(dir, "stranger.mp4");
    fs.writeFileSync(stranger, Buffer.alloc(4096, 99));
    const kept = [clips[0]!, stranger, clips[3]!];
    const out = alignMontageMetaWithClipsForTest(clips, kept, [4, 4, 4, 4], [0, 1, 2, 3]);

    expect(out.unmapped, "an unmappable clip was not reported").toHaveLength(1);
    expect(out.unmapped[0]).toContain("stranger");
    /** The two it CAN place are still right, and the stranger is not called beat 0. */
    expect(out.clipBeatIndices[0]).toBe(0);
    expect(out.clipBeatIndices[2]).toBe(3);
    expect(out.clipBeatIndices[1], "an unplaceable clip was attributed to the first beat").not.toBe(0);
  });

  it("reports nothing when every clip could be placed", () => {
    const out = alignMontageMetaWithClipsForTest(clips, [clips[1]!, clips[2]!], [4, 4, 4, 4], [0, 1, 2, 3]);
    expect(out.unmapped).toEqual([]);
  });
});

describe("R166 §10 — durations follow the same identity, not the same position", () => {
  it("a surviving clip keeps its own duration after a drop", () => {
    const kept = [clips[0]!, clips[2]!];
    const out = alignMontageMetaWithClipsForTest(clips, kept, [2, 5, 9, 3], [0, 1, 2, 3]);
    expect(out.beatDurations).toEqual([2, 9]);
  });
});
