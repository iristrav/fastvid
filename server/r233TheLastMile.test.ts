/**
 * RONDE 233 — THE LAST MILE: CAN A CORRECTLY CHOSEN PICTURE STILL VANISH?
 *
 * RONDE 232 proved the selection chain end to end: four candidates in, exactly one out, and the
 * right one. It proved nothing about what happens AFTER adoption. Renders 574, 575 and 576 all
 * died before that point, so the last mile has never been the thing under test —
 *
 *     adoption → preparation → compose → render → export gate → delivery
 *
 * — and it holds at least three historical ways to lose a picture that was already correct:
 *
 *   · RONDE 136 (video 558): `if (sceneFetchAborted()) return false;` inside the compose gate
 *     threw away fourteen already-adopted clips, ten of them downloaded archive files that had
 *     passed the technical gate and been judged. Scene 1 ended with 2 unique clips for 13 beats.
 *   · RONDE 97 §3: one render preparing the same asset thirty-eight times, and the reverse risk —
 *     one render being handed another render's file.
 *   · The delivery write itself: a finished render publishing a URL that is not its own.
 *
 * This file exercises those three, through the real modules, with no network and no ffmpeg.
 *
 * WHAT IS NOT COVERED HERE, AND WHY: the compose gate's own stream check
 * (`montageStreamMetaUsable`) is module-private in videoPipeline.ts. Exporting it purely so a test
 * could reach it would be changing production code for the test's convenience, which this round
 * forbids, so its rules are asserted against the source instead and that is stated as what it is —
 * a weaker form of evidence than the runtime assertions above it.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composeScopeVerdict, formatComposeScopeDecision } from "./composeEligibility";
import {
  preparationCounters,
  preparationKey,
  resetPreparationScope,
  runPreparation,
} from "./preparationCache";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

let dirA = "";
let dirB = "";
beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "r233-a-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "r233-b-"));
});
afterEach(() => {
  for (const d of [dirA, dirB]) {
    resetPreparationScope(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/* ═══════════ 1. an expired budget is not a verdict on what was already found ═══════════ */

describe("R233 §1 — RONDE 136 cannot come back", () => {
  it("AN ADOPTED CLIP SURVIVES AN ABORTED SCOPE", () => {
    const v = composeScopeVerdict({
      scopeAborted: true,
      adopted: true,
      priorMeasurementUsable: null,
    });
    expect(v.decision, "video 558's fourteen discarded clips are possible again").toBe("pass");
    if (v.decision !== "pass") throw new Error("unreachable");
    expect(v.basis).toBe("already_adopted");
  });

  it("A PRIOR MEASUREMENT ALSO CARRIES IT — RONDE 138's rule, intact", () => {
    const v = composeScopeVerdict({
      scopeAborted: true,
      adopted: false,
      priorMeasurementUsable: true,
    });
    expect(v.decision).toBe("pass");
    if (v.decision !== "pass") throw new Error("unreachable");
    expect(v.basis).toBe("prior_measurement");
  });

  it("AN UNEXAMINED FILE STILL DOES NOT GET IN — the gate did not become a door", () => {
    /**
     * `pad_combined_*.mp4` and the text-overlay output are written moments before the gate and
     * never examined. They must not inherit a parent's clearance.
     */
    const v = composeScopeVerdict({
      scopeAborted: true,
      adopted: false,
      priorMeasurementUsable: null,
    });
    expect(v.decision, "an unexamined derivative reached the montage").not.toBe("pass");
  });

  it("A MEASUREMENT THAT SAID NO IS STILL A NO", () => {
    const v = composeScopeVerdict({
      scopeAborted: true,
      adopted: false,
      priorMeasurementUsable: false,
    });
    expect(v.decision).not.toBe("pass");
  });

  it("A LIVE SCOPE CHANGES NOTHING — the full gate still runs", () => {
    for (const adopted of [true, false]) {
      const v = composeScopeVerdict({ scopeAborted: false, adopted, priorMeasurementUsable: null });
      expect(v.decision).toBe("run_full_gate");
    }
  });

  it("every decision is announced — no clip leaves without a line", () => {
    for (const input of [
      { scopeAborted: true, adopted: true, priorMeasurementUsable: null },
      { scopeAborted: true, adopted: false, priorMeasurementUsable: null },
      { scopeAborted: false, adopted: false, priorMeasurementUsable: null },
    ] as const) {
      const line = formatComposeScopeDecision({
        sceneIndex: 1,
        clipIndex: 0,
        basename: "scene_1_b5_archive_0.mp4",
        verdict: composeScopeVerdict(input),
      });
      expect(line.length, "a compose decision was made silently").toBeGreaterThan(0);
      expect(line).toContain("scene_1_b5_archive_0.mp4");
    }
  });

  it("THE PRODUCTION GATE ASKS THIS MODULE, and asks the ledger about the exact path", () => {
    expect(PIPE).toContain("const verdict = composeScopeVerdict({");
    expect(PIPE).toContain("adopted: get_activeSourcingCache()?.lineage?.adoptedAtPath(clipPath) ?? false,");
  });
});

/* ═══════════ 2. one render cannot be handed another render's file ═══════════ */

describe("R233 §2 — preparation is render-scoped", () => {
  const write = (dir: string, name: string, calls: { n: number }) => async (): Promise<string> => {
    calls.n += 1;
    const p = path.join(dir, name);
    await fs.promises.writeFile(p, "clip");
    return p;
  };

  it("RENDER B DOES NOT INHERIT RENDER A'S PREPARATION", async () => {
    const key = preparationKey({
      assetIdentity: "internet_archive:SovietBerlin1945",
      holdSec: 2.5,
      variant: "x.mp4",
    });
    const a = { n: 0 };
    const b = { n: 0 };
    await runPreparation(dirA, key, write(dirA, "prep.mp4", a));
    await runPreparation(dirB, key, write(dirB, "prep.mp4", b));
    expect(a.n).toBe(1);
    expect(b.n, "render B was served render A's file").toBe(1);
    expect(preparationCounters(dirA).reused).toBe(0);
    expect(preparationCounters(dirB).reused).toBe(0);
  });

  it("and within ONE render the same asset is still prepared once", async () => {
    const key = preparationKey({ assetIdentity: "internet_archive:x", holdSec: 2.5 });
    const a = { n: 0 };
    await runPreparation(dirA, key, write(dirA, "one.mp4", a));
    await runPreparation(dirA, key, write(dirA, "one.mp4", a));
    expect(a.n).toBe(1);
    expect(preparationCounters(dirA).reused).toBe(1);
  });

  it("A VANISHED OUTPUT IS A MISS, NOT A FALSE HIT", async () => {
    /** Work directories are swept and renders are killed; a cached path to nothing must not pass. */
    const key = preparationKey({ assetIdentity: "internet_archive:y", holdSec: 2.5 });
    const a = { n: 0 };
    const first = await runPreparation(dirA, key, write(dirA, "gone.mp4", a));
    expect(first.status).toBe("PREPARED");
    if (first.status === "FAILED") throw new Error("unreachable");
    fs.rmSync(first.path);
    await runPreparation(dirA, key, write(dirA, "gone.mp4", a));
    expect(a.n, "a path to a deleted file was handed back as a hit").toBe(2);
  });

  it("THE WORK DIRECTORY IS RENDER-SCOPED — two renders cannot share one", () => {
    /** videoId AND a timestamp, so even a re-render of the same video gets its own directory. */
    expect(PIPE).toContain("const workDir = path.join(TMP_DIR, `fastvid_${videoId}_${Date.now()}`);");
  });

  it("and the scope is released when that directory's life ends", () => {
    expect(PIPE).toContain("resetPreparationScope(workDir);");
  });
});

/* ═══════════ 3. the delivered file is this render's own ═══════════ */

describe("R233 §3 — delivery identity", () => {
  it("THE DELIVERED URL IS CHOSEN FROM THIS RENDER'S OWN TWO OUTPUTS", () => {
    /**
     * `cinematicDeliveredUrl` is set only by the cinematic pass inside this invocation, and `url`
     * is this invocation's compose output. Neither can name an earlier render: both are locals of
     * `_runVideoPipelineInner`, and the files they point at live under this render's own workDir.
     */
    expect(PIPE).toContain("const deliveredUrl = cinematicDeliveredUrl ?? url;");
  });

  it("IT IS PERSISTED AGAINST THIS videoId, and nothing else", () => {
    const at = PIPE.indexOf("const deliveredUrl = cinematicDeliveredUrl ?? url;");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, at + 700);
    expect(block).toContain('await updateVideoStatus(videoId, "completed", {');
    expect(block).toContain("videoUrl: deliveredUrl,");
  });

  it("THE ROUTE IS RECORDED, so a delivered file can always name where it came from", () => {
    const at = PIPE.indexOf("const deliveredUrl = cinematicDeliveredUrl ?? url;");
    const block = PIPE.slice(at, at + 900);
    expect(block).toContain('route: cinematicDeliveredUrl ? "cinematic_timeline" : "legacy_compose"');
    expect(block).toContain("await writeDeliveredLineage({");
  });

  it("A FALLBACK TO COMPOSE IS NEVER SILENT", () => {
    expect(PIPE).toContain("RENDER_FALLBACK_USED");
  });
});

/* ═══════════ 4. the stream check, asserted where it lives ═══════════ */

describe("R233 §4 — the range rules (structural: the validator is module-private)", () => {
  const fn = () => {
    const at = PIPE.indexOf("function montageStreamMetaUsable(");
    expect(at, "the compose stream check is gone").toBeGreaterThan(0);
    return PIPE.slice(at, PIPE.indexOf("\n}", at));
  };

  it("A DEGENERATE FRAME IS REFUSED", () => {
    expect(fn()).toContain("if (meta.width < 2 || meta.height < 2) return false;");
  });

  it("A MEASURED, GENUINELY SHORT CLIP IS REFUSED", () => {
    expect(fn()).toContain(
      "if (Number.isFinite(meta.durationSec) && meta.durationSec > 0 && meta.durationSec <= 0.15)"
    );
  });

  it("A CLIP SHORTER THAN ITS OWN TRIM START IS REFUSED", () => {
    expect(fn()).toContain("if (meta.durationSec > 0.15 && meta.durationSec <= trimStart + 0.15) return false;");
  });

  it("AN UNMEASURABLE DURATION IS NOT TREATED AS A REFUSAL — that distinction is deliberate", () => {
    /**
     * ffprobe reports 0 for streams whose duration it cannot determine. Refusing those would throw
     * away real footage for a property of the probe rather than of the clip.
     */
    expect(fn()).toContain("meta.durationSec > 0 &&");
    expect(fn()).toContain("return true;");
  });

  it("and the gate calls it on both paths through the compose barrier", () => {
    expect((PIPE.match(/montageStreamMetaUsable\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
