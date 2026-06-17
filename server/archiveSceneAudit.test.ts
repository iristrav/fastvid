import { describe, expect, it } from "vitest";
import type { ArchiveSceneAuditEntry } from "./archiveSceneAudit";

describe("archiveSceneAudit", () => {
  it("maps interior cut count to scene count", () => {
    const multi: ArchiveSceneAuditEntry = {
      assetId: 1,
      status: "multi_scene",
      sceneCount: 4,
      interiorCutCount: 3,
      cutTimesSec: [2.1, 5.4, 8.0],
    };
    expect(multi.sceneCount).toBe(multi.interiorCutCount + 1);

    const single: ArchiveSceneAuditEntry = {
      assetId: 2,
      status: "single_scene",
      sceneCount: 1,
      interiorCutCount: 0,
    };
    expect(single.status).toBe("single_scene");
  });
});
