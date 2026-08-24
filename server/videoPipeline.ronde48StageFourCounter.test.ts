import { readFileSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// RONDE 48 (C1) — sceneRescueColorFallbackCount must describe what a scene ENDED UP as, not what
// the pipeline was about to attempt.
//
// assertVisualCoverageExportGate rejects the whole render on any non-zero count. Stage4 used to
// increment the moment there was nothing to reuse — i.e. BEFORE generateGuaranteedBeatClip ran —
// and that call escalates through the topical archive and Wikimedia before it ever reaches a
// placeholder tier, so it routinely returns real footage that is then muxed with the voice-over.
// A perfectly good render was therefore rejected. P5A (RONDE 34 point 7) already counted on the
// outcome; this round aligns Stage4 with it.

const SRC = () => readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The `{...}` block that starts at `from`, matched by braces rather than a character window. */
function blockAt(src: string, from: number): string {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error("unbalanced block");
}

/** Stage4's last-resort branch: the catch that runs when the rescue compose itself failed. */
function stage4LastResortBlock(src: string): string {
  const marker = "rescue compose also failed — last-resort minimal compose";
  const idx = src.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  // Walk back to the enclosing `} catch (rescueComposeErr) {` and take that whole block.
  const catchIdx = src.lastIndexOf("catch (rescueComposeErr)", idx);
  expect(catchIdx).toBeGreaterThan(-1);
  return blockAt(src, catchIdx);
}

/**
 * P5A's rescue block — used only to prove RONDE 34 point 7 was left alone. Brace-matched from its
 * own catch rather than taken as a character window: every round so far has pushed this block
 * further down and quietly invalidated fixed windows.
 */
function p5aRescueBlock(src: string): string {
  const marker = src.indexOf("`P5A composeSceneVideo s${scene.index}`");
  expect(marker).toBeGreaterThan(-1);
  const catchIdx = src.indexOf("catch (rescueErr)", marker);
  expect(catchIdx).toBeGreaterThan(-1);
  return blockAt(src, catchIdx);
}

describe("RONDE 48 (C1) — the export gate is what makes this counter expensive", () => {
  const cleanReport = () =>
    ({
      generatedAt: new Date().toISOString(),
      videoTitle: "test",
      visualTopic: "history",
      totalClips: 8,
      bySource: {},
      byMixKind: {} as any,
      wikimediaCount: 4,
      archiveCount: 4,
      stockCount: 0,
      warnings: [],
      offTopicSuspects: [],
      // A healthy render: every filled beat got a real clip, none fell back.
      adoptAuditSummary: { beatsFilled: 8, fallbackBeats: 0 } as any,
    }) as any;

  it("a render with a healthy report and a zero counter passes the gate", async () => {
    const { assertVisualCoverageExportGate } = await import("./videoQualityReport");
    expect(() => assertVisualCoverageExportGate(cleanReport(), 0)).not.toThrow();
  });

  it("the SAME healthy render is rejected outright once the counter reads 1", async () => {
    const { assertVisualCoverageExportGate } = await import("./videoQualityReport");
    // This is the cost of counting the intent instead of the outcome: nothing about the render
    // changed, only the bookkeeping, and the export is refused.
    expect(() => assertVisualCoverageExportGate(cleanReport(), 1)).toThrow(
      /insufficient real visual coverage/
    );
  });
});

describe("RONDE 48 (C1) — a guaranteed beat clip really does come back with a usable file", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r48-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("resolves to a real file even with no topic, no beat text and no network tier available", async () => {
    const { generateGuaranteedBeatClip } = await import("./videoPipeline");
    // No beatText and no active topic ⇒ the escalation tiers are empty, so no provider is called
    // and the function walks straight to its own placeholder tier. The point is not WHICH tier
    // answers — it is that the call RETURNS a path instead of throwing. That is the premise of
    // C1: the old code had already incremented the counter by the time this succeeded.
    const clip = await generateGuaranteedBeatClip(4242, 9999, 3, dir);
    expect(typeof clip).toBe("string");
    expect(fs.existsSync(clip)).toBe(true);
    expect(fs.statSync(clip).size).toBeGreaterThan(1_000);
  }, 120_000);
});

describe("RONDE 48 (C1) — Stage4 increments only when no clip could be produced", () => {
  it("the counter no longer fires before the guaranteed clip is attempted", () => {
    const block = stage4LastResortBlock(SRC());
    // The pre-fix form: an unconditional increment keyed on the reuse check alone.
    expect(block).not.toMatch(
      /if \(!reusableLastClip\)\s*visualDedup\.sceneRescueColorFallbackCount\+\+;/
    );
  });

  it("the only increment in the block sits AFTER the guaranteed-clip call", () => {
    const block = stage4LastResortBlock(SRC());
    const increments = [...block.matchAll(/visualDedup\.sceneRescueColorFallbackCount\+\+;/g)];
    expect(increments).toHaveLength(1);
    // RONDE 50 split the call across lines (it now passes a tier out-parameter).
    const generate = block.search(/generateGuaranteedBeatClip\(\s*\n?\s*scene\.index,\s*9999,/);
    expect(generate).toBeGreaterThan(-1);
    expect(increments[0].index!).toBeGreaterThan(generate);
  });

  it("that increment is inside the catch of the guaranteed-clip call, so a produced clip cannot reach it", () => {
    const block = stage4LastResortBlock(SRC());
    const catchIdx = block.indexOf("catch (guaranteedErr)");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = blockAt(block, catchIdx);
    // The increment lives here and nowhere else in the branch...
    expect(catchBlock).toContain("visualDedup.sceneRescueColorFallbackCount++;");
    // ...and the failure still propagates exactly as before the fix.
    expect(catchBlock).toContain("throw guaranteedErr;");
    // The try it guards is the guaranteed-clip call itself, not something wider.
    const tryIdx = block.lastIndexOf("try {", catchIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    const tryBlock = block.slice(tryIdx, catchIdx);
    expect(tryBlock).toMatch(/generateGuaranteedBeatClip\(\s*\n?\s*scene\.index,\s*9999,/);
    expect(tryBlock).not.toContain("composeLastResortSceneFromClip(");
  });

  it("a successfully produced clip is still recorded once, and a reused one still is not", () => {
    const block = stage4LastResortBlock(SRC());
    const records = [...block.matchAll(/recordClipAdopt\(\s*\n?\s*visualDedup\.clipAdoptAudit,\s*scene\.index,\s*9999,/g)];
    expect(records).toHaveLength(1);
    // The record sits in the same "nothing to reuse" branch as the generation — a reused rescue
    // clip or survivor was already recorded where it was adopted, so it must not be recorded here.
    const generate = block.search(/generateGuaranteedBeatClip\(\s*\n?\s*scene\.index,\s*9999,/);
    expect(records[0].index!).toBeGreaterThan(generate);
    // And the muxed output is still produced from whatever clip won, reused or generated.
    expect(block).toContain("composeLastResortSceneFromClip(");
    expect(block).toContain("usedClips.push(lastClip);");
  });
});

describe("RONDE 48 (C1) — P5A is untouched and both paths now agree", () => {
  it("P5A still reuses first, then attempts a parity clip, and only then writes the scene off", () => {
    const s = SRC();
    const block = p5aRescueBlock(s);
    const at = (needle: string) => {
      const i = block.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const reuse = at("const reusableLastClip = rescueClips[0] ?? lastResortSurvivors[0];");
    const parity = at("parityClip = await generateGuaranteedBeatClip(");
    const counter = at("visualDedup.sceneRescueColorFallbackCount++;");
    const card = at("result = await generateColorFallback(");
    expect(reuse).toBeLessThan(parity);
    expect(parity).toBeLessThan(counter);
    expect(counter).toBeLessThan(card);
    // The counter still fires only alongside the card it describes.
    expect(card - counter).toBeLessThan(200);
  });

  it("in BOTH rescue paths the counter comes after the guaranteed-clip attempt, never before it", () => {
    const s = SRC();
    for (const block of [stage4LastResortBlock(s), p5aRescueBlock(s)]) {
      const generate = block.search(/generateGuaranteedBeatClip\(/);
      const counter = block.indexOf("visualDedup.sceneRescueColorFallbackCount++;");
      expect(generate).toBeGreaterThan(-1);
      expect(counter).toBeGreaterThan(-1);
      expect(counter).toBeGreaterThan(generate);
    }
  });

  it("the counter exists in exactly these two places in the pipeline", () => {
    const s = SRC();
    const all = [...s.matchAll(/visualDedup\.sceneRescueColorFallbackCount\+\+;/g)];
    expect(all).toHaveLength(2);
  });
});
