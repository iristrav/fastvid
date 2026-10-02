/**
 * Automatic replacement: archive candidates in ranked order, each asked the Visual Judge against the
 * narration under the slot; the first that FITS takes the slot. The judge and the archive are mocked
 * here — what is tested is the decision, not a model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const verdicts = new Map<number, { decision: "ACCEPT" | "REJECT"; verdict: string }>();
const looked: number[] = [];

vi.mock("./archiveAssetLoad", () => ({
  loadArchiveAssetFile: async (asset: { id: number }) => ({ ok: true, result: { localPath: `/tmp/asset-${asset.id}.mp4`, mimeType: "video/mp4" } }),
}));
vi.mock("./visualJudge", () => ({
  judgePicture: async (p: { contentKey: string; ctx: { beatText: string } }) => {
    const id = Number(p.contentKey.split(":").pop());
    looked.push(id);
    const v = verdicts.get(id) ?? { decision: "ACCEPT", verdict: "unknown" };
    return {
      decision: { verdict: v.verdict, allowed: v.decision === "ACCEPT", reason: `${v.verdict} for "${p.ctx.beatText}"` },
      verdict: { decision: v.decision },
    };
  },
}));

import { firstCandidateTheJudgeAccepts } from "./timelineRouter";

const pool = [1, 2, 3, 4].map((id) => ({ id, storageUrl: null, storageKey: null, mimeType: "video/mp4", mediaType: "video" }));
const ask = (candidates: number[]) =>
  firstCandidateTheJudgeAccepts({ candidates, pool, beatText: "The wall fell in 1989", sceneIndex: 0, beatIndex: 2 });

beforeEach(() => {
  verdicts.clear();
  looked.length = 0;
});

describe("auto-replace asks the Visual Judge, in ranked order", () => {
  it("takes the first candidate the judge says FITS, and stops looking there", async () => {
    verdicts.set(1, { decision: "REJECT", verdict: "does_not_fit" });
    verdicts.set(2, { decision: "ACCEPT", verdict: "unclear" });
    verdicts.set(3, { decision: "ACCEPT", verdict: "fits" });
    const r = await ask([1, 2, 3, 4]);
    expect(r.assetId).toBe(3);
    expect(looked).toEqual([1, 2, 3]);
    expect(r.why).toContain("fits");
  });

  it("with no definite fit, the best-ranked shot the judge did not refuse — and it says so", async () => {
    verdicts.set(1, { decision: "REJECT", verdict: "does_not_fit" });
    verdicts.set(2, { decision: "ACCEPT", verdict: "unclear" });
    verdicts.set(3, { decision: "ACCEPT", verdict: "unclear" });
    const r = await ask([1, 2, 3]);
    expect(r.assetId).toBe(2);
    expect(r.why).toContain("no definite fit");
  });

  it("refuses to replace when the judge refused every candidate, or there is none", async () => {
    for (const id of [1, 2]) verdicts.set(id, { decision: "REJECT", verdict: "does_not_fit" });
    expect((await ask([1, 2])).assetId).toBeNull();
    expect((await ask([])).assetId).toBeNull();
  });
});
