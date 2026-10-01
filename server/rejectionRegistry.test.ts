/**
 * ONE ROUTE — the RejectionRegistry is the one writer of a refusal.
 *
 * Every case here registers refusals and reads what the registry and the asset's lineage hold
 * afterwards; none of them reads source text.
 */
import { describe, expect, it, vi } from "vitest";
import {
  beatRejectCount,
  beatRejectReasons,
  createRejectionRegistry,
  registerRejection,
  rejectionStageForReason,
  summarizeRejections,
} from "./rejectionRegistry";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import type { VisualSourceLedger } from "./visualSourceLineage";

/** A lineage that only counts what is filed on it. */
function fakeLineage() {
  const filed: Array<[string, string, string | undefined]> = [];
  const lineage = {
    recordRejection: vi.fn((clipPath: string, reason: string, contentKey?: string) => {
      filed.push([clipPath, reason, contentKey]);
      return true;
    }),
  } as unknown as VisualSourceLedger;
  return { lineage, filed };
}

describe("RejectionRegistry — what, why, where, for which sentence, when, how sure", () => {
  it("one registration is one lineage write, with the asset identity", () => {
    const reg = createRejectionRegistry();
    const { lineage, filed } = fakeLineage();
    reg.lineage = lineage;
    registerRejection(reg, 1, 2, "/w/clip.mp4", "beat_image_gate", "soviet artillery", {
      confidence: 0.9,
      contentKey: "archive:7",
    });
    expect(filed).toEqual([["/w/clip.mp4", "beat_image_gate", "archive:7"]]);
    const [entry] = reg.entries;
    expect(entry).toMatchObject({
      sceneIndex: 1,
      beatIndex: 2,
      basename: "clip.mp4",
      reason: "beat_image_gate",
      source: "soviet artillery",
      stage: "picture",
      confidence: 0.9,
    });
    expect(entry!.at).toBeGreaterThan(0);
  });

  it("a refusal with no sentence still reaches the lineage, and is counted under no sentence", () => {
    const reg = createRejectionRegistry();
    const { lineage, filed } = fakeLineage();
    reg.lineage = lineage;
    registerRejection(reg, 0, undefined, "/w/card.mp4", "FUNNEL_WITHOUT_EVIDENCE");
    expect(filed).toHaveLength(1);
    expect(reg.perBeat.size).toBe(0);
    expect(reg.recorded).toBe(1);
  });

  it("the per-sentence count is never capped, only the named detail is", () => {
    const reg = createRejectionRegistry(3);
    for (let i = 0; i < 10; i++) registerRejection(reg, 0, 0, `/w/c${i}.mp4`, "mostly_black");
    expect(beatRejectCount(reg, 0, 0)).toBe(10);
    expect(reg.entries).toHaveLength(3);
    expect(reg.dropped).toBe(7);
    expect(beatRejectReasons(reg, 0, 0)).toEqual([["mostly_black", 10]]);
    expect(summarizeRejections(reg)).toEqual({ mostly_black: 10 });
  });

  it("the stage is read off the reason every decider already uses", () => {
    expect(rejectionStageForReason("file_missing")).toBe("technical");
    expect(rejectionStageForReason("below_size_floor_1000_bytes")).toBe("technical");
    expect(rejectionStageForReason("already_used_in_render")).toBe("dedup");
    expect(rejectionStageForReason("still_photo_budget")).toBe("usage");
    expect(rejectionStageForReason("shortlist_full")).toBe("budget");
    expect(rejectionStageForReason("documentary_beat_gate")).toBe("metadata");
    expect(rejectionStageForReason("baked_edit_text_before_vision")).toBe("on_screen_text");
    expect(rejectionStageForReason("refused on s1b2: a parking garage")).toBe("picture");
    expect(rejectionStageForReason("archive not ready (no_storage)")).toBe("archive");
    expect(rejectionStageForReason("something new")).toBe("unknown");
  });

  it("without a render ledger it still counts, and writes nothing else", () => {
    const reg = createRejectionRegistry();
    registerRejection(reg, 3, 1, "/w/x.mp4", "entity_evidence");
    expect(beatRejectCount(reg, 3, 1)).toBe(1);
  });
});

describe("RejectionRegistry — the only writer of a refusal to the lineage", () => {
  it("no production module but the registry calls recordRejection", () => {
    const writers = readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /\.recordRejection\(/.test(readFileSync(path.join(__dirname, f), "utf8")));
    expect(writers).toEqual(["rejectionRegistry.ts"]);
  });
});
