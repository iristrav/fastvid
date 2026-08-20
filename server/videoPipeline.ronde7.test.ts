import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  extractPersonNamesFromText,
  extractPersonSurnameAnchor,
  extractPrimaryPersonFromText,
  resolvePersonFromSurnameAnchor,
} from "./videoPipeline";

// RONDE 7 — the two defects render 518 proved.
//
// P1-A2: the title "Why Hitler Killed Himself — And His Wife" produced the person lock
// `[person lock: His Wife]`. RONDE 6 cleaned the TITLE extraction, but the final fallback in
// the lock chain — extractPersonNamesFromText(script)[0] — still accepted any capitalized
// bigram from the script verbatim, and the surname anchor then CONFIRMED the junk ("Wife"
// matched "His Wife" in surname position). The script scan now runs the same framing-word
// cleanup as the title path.
//
// RONDE 7-B: scene 0 finished its visual stage with 4 compose-ready winner clips, yet composed
// with 1 clip + a gray pad ("Scene 0: 1/5 clip(s) cached on disk for compose"). Cause: every
// fill stage in finalizeLocalClipCacheForScene REPLACED `result` with only its own output, so
// the last (thinnest) stage won. Fill stages may only ever ADD clips.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

// ─── P1-A2: script-name extraction rejects title framing fragments ───────────────────────────

describe("RONDE 7 P1-A2 — extractPersonNamesFromText no longer fabricates persons", () => {
  const SCRIPT_518 =
    "# Why Hitler Killed Himself — And His Wife\n\n" +
    "Adolf Hitler married Eva Braun in the bunker. Within 40 hours His Wife and the dictator " +
    "were dead. Albert Speer had already left Berlin.";

  it("render-518 regression: 'His Wife' is never a person", () => {
    const names = extractPersonNamesFromText(SCRIPT_518);
    expect(names).not.toContain("His Wife");
    expect(names.every((n) => !n.toLowerCase().includes("wife"))).toBe(true);
  });

  it("render-518 regression: the title fragment 'Why Hitler Killed Himself' is never a person", () => {
    const names = extractPersonNamesFromText(SCRIPT_518);
    expect(names.every((n) => !n.toLowerCase().startsWith("why"))).toBe(true);
    expect(names.every((n) => !n.toLowerCase().includes("himself"))).toBe(true);
  });

  it("the real script-stated names survive the cleanup", () => {
    const names = extractPersonNamesFromText(SCRIPT_518);
    expect(names).toContain("Adolf Hitler");
    expect(names).toContain("Eva Braun");
    expect(names).toContain("Albert Speer");
  });

  it("the FIRST surviving script name is now a real person (the chain's final fallback)", () => {
    expect(extractPersonNamesFromText(SCRIPT_518)[0]).toBe("Adolf Hitler");
  });

  it("a run led by a relationship word is trimmed to the real name ('His Wife Eva Braun')", () => {
    const names = extractPersonNamesFromText("Suddenly His Wife Eva Braun appeared.");
    expect(names).toContain("Eva Braun");
    expect(names.every((n) => !n.toLowerCase().includes("wife"))).toBe(true);
  });

  it("existing celebrity extraction is untouched", () => {
    const names = extractPersonNamesFromText("Elon Musk once met Kylie Jenner backstage.");
    expect(names).toContain("Elon Musk");
    expect(names).toContain("Kylie Jenner");
  });
});

describe("RONDE 7 P1-A2 — the full render-518 lock chain now lands on the real person", () => {
  const TITLE_518 = "Why Hitler Killed Himself — And His Wife";
  const SCRIPT_NAMES = ["Adolf Hitler", "Eva Braun"];

  it("the title yields no full name", () => {
    expect(extractPrimaryPersonFromText(TITLE_518)).toBe("");
  });

  it("the title yields the surname anchor 'Hitler' (not 'Wife')", () => {
    // "Why Hitler Killed Himself" → strip Why/Killed/Himself → exactly "Hitler".
    // "His Wife" reduces to zero clean tokens, so it can no longer become the anchor.
    expect(extractPersonSurnameAnchor(TITLE_518)).toBe("Hitler");
  });

  it("anchor + cleaned script names = 'Adolf Hitler' — the lock render 518 should have had", () => {
    const anchor = extractPersonSurnameAnchor(TITLE_518);
    expect(resolvePersonFromSurnameAnchor(anchor, SCRIPT_NAMES)).toBe("Adolf Hitler");
  });

  it("even without an anchor match, the fallback scriptNames[0] is now clean", () => {
    // The chain's last resort — previously the source of "His Wife".
    const names = extractPersonNamesFromText(
      `# ${TITLE_518}\n\nAdolf Hitler married Eva Braun.`
    );
    expect(names[0]).toBe("Adolf Hitler");
  });
});

// ─── RONDE 7-B: pre-compose fill stages merge instead of replace ─────────────────────────────

describe("RONDE 7-B — finalizeLocalClipCacheForScene keeps every compose-ready clip", () => {
  const fnStart = pipelineSrc.indexOf("async function finalizeLocalClipCacheForScene(");
  const fnEnd = pipelineSrc.indexOf("async function ensureFastShortScenesReadyForCompose(");
  const fn = pipelineSrc.slice(fnStart, fnEnd);

  it("the function exists where expected", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  it("every fill stage merges into the union instead of replacing the result", () => {
    expect(fn).toContain("await mergeIntoResult(rescued)");
    expect(fn).toContain("await mergeIntoResult(refilled.clips)");
    expect(fn).toContain("await mergeIntoResult(recovered.clips)");
  });

  it("the union starts with the clips that already passed the gate", () => {
    expect(fn).toContain("const union = [...result.clips, ...extraClips];");
  });

  it("a merge can never shrink the result (render-518 regression)", () => {
    expect(fn).toContain("if (merged.clips.length > result.clips.length) result = merged;");
  });

  it("the old replace pattern is gone from every fill stage", () => {
    // Only the initial pass may assign applyReady's output directly.
    const assigns = fn.match(/result = await applyReady\(/g) ?? [];
    expect(assigns).toHaveLength(1);
    expect(fn).toContain("let result = await applyReady(vr.clips ?? [], vr);");
  });

  it("the early-exit thresholds are unchanged (minNeeded checks still gate each stage)", () => {
    const checks = fn.match(/if \(result\.clips\.length >= minNeeded\) return result;/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3);
  });
});
