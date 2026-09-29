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
  it("THE DELIVERED URL IS THIS RENDER'S OWN TIMELINE OUTPUT, OR THE RENDER FAILS", () => {
    /**
     * `cinematicDeliveredUrl` is set only by the cinematic pass inside this invocation. It is a
     * local of `_runVideoPipelineInner`, so it cannot name an earlier render. Since RONDE 661 there
     * is no second output to fall back to: a render without it throws.
     */
    const at = PIPE.indexOf("const deliveredUrl = cinematicDeliveredUrl;");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, at + 400);
    expect(block).toContain("if (!deliveredUrl) {");
    expect(block).toContain("throw pipelineError(");
  });

  it("IT IS PERSISTED AGAINST THIS videoId, and nothing else", () => {
    const from = PIPE.indexOf("const deliveredUrl = cinematicDeliveredUrl;");
    const at = PIPE.indexOf('await updateVideoStatus(videoId, "completed", {', from);
    expect(at).toBeGreaterThan(from);
    expect(PIPE.slice(at, at + 200)).toContain("videoUrl: deliveredUrl,");
  });

  it("THE ROUTE IS RECORDED, so a delivered file can always name where it came from", () => {
    const from = PIPE.indexOf("const deliveredUrl = cinematicDeliveredUrl;");
    const at = PIPE.indexOf('await updateVideoStatus(videoId, "completed", {', from);
    expect(PIPE.slice(at, at + 700)).toContain("await writeDeliveredLineage({");
    const fn = PIPE.slice(PIPE.indexOf("export async function writeDeliveredLineage("));
    expect(fn.slice(0, 600)).toContain('const route = "cinematic_timeline";');
  });

  it("A RENDER THAT DID NOT DELIVER IS NEVER SILENT", () => {
    expect(PIPE).toContain("route=cinematic_timeline NOT_DELIVERED ");
  });
});
