import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * RONDE 653 — with the cinematic path on, the compose montage is the fallback, yet two audits of up
 * to three minutes each measured it on every render and then had their figures marked as
 * describing the wrong file.
 */
const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("the stillness and repeat audits wait for the montage to be the delivery", () => {
  it("runs them at stage 6 only when the cinematic route will not deliver", () => {
    expect(SRC).toContain("const auditComposeMontage = async (): Promise<void> => {");
    expect(SRC).toContain("return cinematicPlanningEnabled() && cinematicRenderPathEnabled();");
    expect(SRC).toMatch(/if \(composeAuditDeferred\) \{[\s\S]{0,400}\} else \{\s*await auditComposeMontage\(\);/);
  });

  it("runs them after all when the montage is what gets delivered", () => {
    const at = SRC.indexOf("cinematicRefusalForGate = cinematicRefusal;");
    expect(SRC.slice(at, at + 300)).toContain(
      "if (!cinematicDeliveredUrl && composeAuditDeferred) await auditComposeMontage();"
    );
  });

  it("keeps both audits in the one function, unchanged", () => {
    const at = SRC.indexOf("const auditComposeMontage = async");
    const body = SRC.slice(at, SRC.indexOf("const composeAuditDeferred", at));
    expect(body).toContain("auditVideoStillness({ videoPath: finalVideoPath");
    expect(body).toContain("auditVideoRepeats({ videoPath: finalVideoPath");
    expect(body).toContain("stillness/repeat audit could not run");
  });
});
