/**
 * RONDE 97 §3 — THE SAME ASSET IS PREPARED ONCE.
 *
 * Render 568 paid for archive asset ww2:57364 thirty-eight times and used it once. RONDE 88A fixed
 * the search half — `adoptClip` wrote one of the two used-asset registers and not the other, so
 * the ranking kept re-picking an asset the render had already refused. This is the other half:
 * even with the search fixed, the funnel, a rescue rung and a scene-level recovery can all
 * legitimately want the same asset for the same duration inside one render, and each ran its own
 * ffmpeg pass because `outPath` carries the scene and beat in its name.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatPreparationCache,
  preparationCounters,
  preparationKey,
  resetPreparationScope,
  runPreparation,
} from "./preparationCache";

const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");

let workDir = "";
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-"));
});
afterEach(() => {
  resetPreparationScope(workDir);
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A preparation that really writes a file, so `runPreparation`'s existence check is exercised. */
const makeFile = (name: string) => async (): Promise<string> => {
  const p = path.join(workDir, name);
  await fs.promises.writeFile(p, "x");
  return p;
};

/* ═══════════════ the key ═══════════════ */

describe("the preparation key is deterministic and made of what changes the bytes", () => {
  it("is stable for the same request", () => {
    const a = preparationKey({ assetIdentity: "archive:57364", holdSec: 3 });
    const b = preparationKey({ assetIdentity: "archive:57364", holdSec: 3 });
    expect(a).toBe(b);
  });

  /**
   * THE RULE THAT KEEPS REUSE HONEST. The same asset prepared for a 3-second slot and an 8-second
   * slot are two different files; returning one for the other would be a silent substitution.
   */
  it("separates two different durations", () => {
    expect(preparationKey({ assetIdentity: "a", holdSec: 3 })).not.toBe(
      preparationKey({ assetIdentity: "a", holdSec: 8 })
    );
  });

  it("separates two different assets", () => {
    expect(preparationKey({ assetIdentity: "a", holdSec: 3 })).not.toBe(
      preparationKey({ assetIdentity: "b", holdSec: 3 })
    );
  });

  it("separates two different transformations", () => {
    expect(preparationKey({ assetIdentity: "a", holdSec: 3, variant: "image" })).not.toBe(
      preparationKey({ assetIdentity: "a", holdSec: 3, variant: "video" })
    );
  });

  /** Floating-point noise must not reintroduce the duplication through the back door. */
  it("treats 3.0000001s and 3.0s as one slot", () => {
    expect(preparationKey({ assetIdentity: "a", holdSec: 3.0000001 })).toBe(
      preparationKey({ assetIdentity: "a", holdSec: 3 })
    );
  });

  it("does not merge 3.0s and 3.1s", () => {
    expect(preparationKey({ assetIdentity: "a", holdSec: 3.0 })).not.toBe(
      preparationKey({ assetIdentity: "a", holdSec: 3.1 })
    );
  });

  /** The scene and the beat change the NAME, never the content — so they are not in the key. */
  it("contains no scene or beat", () => {
    const k = preparationKey({ assetIdentity: "archive:57364", holdSec: 3, variant: "video" });
    expect(k).not.toMatch(/scene|beat|s\d+b\d+/);
  });
});

/* ═══════════════ prepare once, reuse after ═══════════════ */

describe("a second request for the same slot reuses the first", () => {
  it("runs the work once and reports the reuse", async () => {
    let ran = 0;
    const key = preparationKey({ assetIdentity: "archive:57364", holdSec: 3 });
    const prep = async () => {
      ran += 1;
      return makeFile("out.mp4")();
    };
    const first = await runPreparation(workDir, key, prep);
    const second = await runPreparation(workDir, key, prep);
    expect(first.status).toBe("PREPARED");
    expect(second.status).toBe("REUSED");
    expect(ran, "the work ran twice for one slot").toBe(1);
    expect(first.status !== "FAILED" && second.status !== "FAILED" && first.path).toBe(
      second.status !== "FAILED" ? second.path : ""
    );
  });

  /** Render 568's actual shape: many routes, one asset, one slot. */
  it("thirty-eight requests produce one preparation", async () => {
    let ran = 0;
    const key = preparationKey({ assetIdentity: "archive:57364", holdSec: 3 });
    for (let i = 0; i < 38; i++) {
      await runPreparation(workDir, key, async () => {
        ran += 1;
        return makeFile("out.mp4")();
      });
    }
    expect(ran).toBe(1);
    const c = preparationCounters(workDir);
    expect(c.requested).toBe(38);
    expect(c.started).toBe(1);
    expect(c.reused).toBe(37);
  });

  /**
   * TWO ROUTES RACING. The middle state is why this is not a plain Map: without it, two routes
   * that ask at the same moment both start, and render 568's duplication was mostly this case.
   */
  it("two concurrent routes produce one download, not two", async () => {
    let ran = 0;
    const key = preparationKey({ assetIdentity: "archive:57364", holdSec: 3 });
    const prep = async () => {
      ran += 1;
      await new Promise((r) => setTimeout(r, 20));
      return makeFile("out.mp4")();
    };
    const [a, b] = await Promise.all([
      runPreparation(workDir, key, prep),
      runPreparation(workDir, key, prep),
    ]);
    expect(ran).toBe(1);
    expect([a.status, b.status].filter((s) => s === "REUSED").length).toBe(1);
    expect(preparationCounters(workDir).skippedDuplicate).toBe(1);
  });

  it("a different slot really is prepared again", async () => {
    let ran = 0;
    const prep = async () => {
      ran += 1;
      return makeFile(`out${ran}.mp4`)();
    };
    await runPreparation(workDir, preparationKey({ assetIdentity: "a", holdSec: 3 }), prep);
    await runPreparation(workDir, preparationKey({ assetIdentity: "a", holdSec: 8 }), prep);
    expect(ran, "a genuinely different preparation was suppressed").toBe(2);
  });

  /**
   * A cached path whose file has vanished is a miss, not a hit. Work directories are swept and
   * renders are killed; returning a path to a file that is gone turns a saving into a crash.
   */
  it("re-prepares when the cached file has disappeared", async () => {
    let ran = 0;
    const key = preparationKey({ assetIdentity: "a", holdSec: 3 });
    const prep = async () => {
      ran += 1;
      return makeFile("out.mp4")();
    };
    const first = await runPreparation(workDir, key, prep);
    expect(first.status).toBe("PREPARED");
    fs.rmSync(path.join(workDir, "out.mp4"));
    const second = await runPreparation(workDir, key, prep);
    expect(second.status).toBe("PREPARED");
    expect(ran).toBe(2);
  });

  /** A failure is not cached: a network fault is not the asset's fault. */
  it("does not make a failure permanent", async () => {
    const key = preparationKey({ assetIdentity: "a", holdSec: 3 });
    let attempt = 0;
    const flaky = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network");
      return makeFile("out.mp4")();
    };
    const bad = await runPreparation(workDir, key, flaky);
    expect(bad.status).toBe("FAILED");
    const good = await runPreparation(workDir, key, flaky);
    expect(good.status).toBe("PREPARED");
    const c = preparationCounters(workDir);
    expect(c.failed).toBe(1);
    expect(c.succeeded).toBe(1);
  });

  /** Two renders must not see each other's prepared files. */
  it("is scoped to one render's work directory", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "prep2-"));
    try {
      let ran = 0;
      const key = preparationKey({ assetIdentity: "a", holdSec: 3 });
      const prep = async () => {
        ran += 1;
        return makeFile("out.mp4")();
      };
      await runPreparation(workDir, key, prep);
      await runPreparation(other, key, async () => {
        ran += 1;
        const p = path.join(other, "out.mp4");
        await fs.promises.writeFile(p, "x");
        return p;
      });
      expect(ran).toBe(2);
    } finally {
      resetPreparationScope(other);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

/* ═══════════════ the report ═══════════════ */

describe("the render says what preparation cost and what it saved", () => {
  it("prints nothing when nothing was prepared", () => {
    expect(formatPreparationCache(workDir)).toEqual([]);
  });

  it("names the avoided work", async () => {
    const key = preparationKey({ assetIdentity: "a", holdSec: 3 });
    const prep = makeFile("out.mp4");
    await runPreparation(workDir, key, prep);
    await runPreparation(workDir, key, prep);
    const lines = formatPreparationCache(workDir).join(" ");
    expect(lines).toContain("[Preparation] requested=2 started=1");
    expect(lines).toContain("reused=1");
    expect(lines).toContain("preparation(s) avoided");
  });
});

/* ═══════════════ wired where every curated route passes ═══════════════ */

describe("the curated preparation is the one that got idempotent", () => {
  it("prepareCuratedArchiveClip runs its transcode through the cache", () => {
    const at = CURATED.indexOf("export async function prepareCuratedArchiveClip(");
    const body = CURATED.slice(at, CURATED.indexOf("\n}\n", at));
    expect(body).toContain("runPreparation(workDir, prepKey");
    expect(body).toContain("preparationKey({");
  });

  /** The key must not carry the scene or the beat, or nothing would ever be reused. */
  it("keys on the asset and the slot, not on the beat", () => {
    const at = CURATED.indexOf("const prepKey = preparationKey({");
    const block = CURATED.slice(at, at + 420);
    expect(block).toContain("assetIdentity: `archive:${asset.id}`");
    expect(block).toContain("holdSec: duration");
    expect(block).not.toContain("sceneIndex");
    expect(block).not.toContain("beatIndex");
  });

  /**
   * A reuse COPIES to this beat's own path rather than returning the other beat's file. Several
   * places still read a scene and a beat out of a curated filename, and handing beat 3 a file
   * named for beat 0 would fix a performance problem by creating a provenance one.
   */
  it("a reused preparation is copied to this beat's own output path", () => {
    const at = CURATED.indexOf("const prepKey = preparationKey({");
    const block = CURATED.slice(at, at + 1600);
    expect(block).toContain("outcome.path !== outPath");
    expect(block).toContain("copyFile(outcome.path, outPath)");
  });

  /** The existing length-refusal memo keeps its job — reuse must not swallow a real refusal. */
  it("a failed preparation still throws to the existing refusal handling", () => {
    const at = CURATED.indexOf("const prepKey = preparationKey({");
    const block = CURATED.slice(at, at + 1600);
    expect(block).toContain('if (outcome.status === "FAILED") throw outcome.error;');
    expect(CURATED).toContain("noteSourceFloorFailure(getSourceFloorMemo(), asset.id, refusal)");
  });
});
