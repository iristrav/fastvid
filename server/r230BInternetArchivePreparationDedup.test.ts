/**
 * RONDE 230-B — THE LIVE INTERNET ARCHIVE ROUTE JOINS THE PREPARATION BOUNDARY.
 *
 * ── What render 576 measured ────────────────────────────────────────────────────────────────
 *
 * `scene_1_b5_ia_archive_0_tmp` was downloaded and trimmed roughly seventeen times — the same
 * archive item, the same byte count (`contentKey=file:1419318:...`), the same ffmpeg command:
 *
 *     ffmpeg -y -ss 10 -i ".../scene_1_b5_ia_archive_0_tmp" -t 2.5 -vf "scale=1920:1080..."
 *
 * ── Why ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `fetchInternetArchiveClips` has NINE production callers. Each call re-entered the download and
 * trim with a fresh `fetched` counter and a fresh scene/beat tag, so the output was named
 * `scene_<n>_<tag>archive_<i>` and nothing recognised it as an asset already prepared. Its
 * metadata WAS cached (`getCachedProviderAsset`); the two expensive steps were not.
 *
 * Meanwhile `preparationCache.ts` — canonical key, render-scoped, in-flight dedup, failures not
 * cached, vanished output treated as a miss — had exactly ONE caller: the curated route. The rule
 * existed and one of several routes obeyed it. RONDE 229 named this the codebase's signature
 * defect and this is another instance of it.
 *
 * ── What this round did NOT do ──────────────────────────────────────────────────────────────
 *
 * No second cache was built. No threshold, budget or flag moved. The archive size cap, the segment
 * fetch, the trim's fixed start of 10s, the four rejection reasons and the technical gate are all
 * exactly as they were.
 *
 * ── Where the cache's own semantics are proven ──────────────────────────────────────────────
 *
 * Sequential dedup, concurrent dedup, failure-not-cached, missing-output-is-a-miss and render
 * isolation are RONDE 97 §3's contract and are measured in `preparationIsIdempotent.test.ts`.
 * They are not restated here — this file proves what was missing: that the LIVE INTERNET ARCHIVE
 * route now goes through that contract, with an identity that cannot be confused by a scene.
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

let workDir = "";
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "r230b-"));
});
afterEach(() => {
  resetPreparationScope(workDir);
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * The key the live route now builds, written exactly as production writes it. If the production
 * shape changes, §3's structural test fails and this stops standing in for it.
 */
const iaKey = (identifier: string, holdSec: number, fileName: string) =>
  preparationKey({
    assetIdentity: `internet_archive:${identifier}`,
    holdSec,
    variant: fileName,
  });

/* ═══════════ 1. the identity is the asset, never the scene ═══════════ */

describe("R230-B §1 — one archive item, one identity", () => {
  it("TWO SCENES ASKING FOR THE SAME ITEM PRODUCE ONE KEY", () => {
    /**
     * The render-576 case in one line: the same archive item reached beat 5 of scene 1 and beat 7
     * of scene 2 under different temporary filenames.
     */
    expect(iaKey("Medicusc1939_4", 2.5, "Medicusc1939_4.mp4")).toBe(
      iaKey("Medicusc1939_4", 2.5, "Medicusc1939_4.mp4")
    );
  });

  it("THE KEY CARRIES NO SCENE, BEAT, SLOT OR TEMP FILENAME", () => {
    const key = iaKey("Medicusc1939_4", 2.5, "Medicusc1939_4.mp4");
    for (const forbidden of ["scene", "b5", "slot", "_tmp", "prep_ia_"]) {
      expect(key, `${forbidden} leaked into the preparation identity`).not.toContain(forbidden);
    }
    expect(key).toContain("internet_archive:Medicusc1939_4");
  });

  it("two different archive items do NOT merge", () => {
    expect(iaKey("Medicusc1939_4", 2.5, "a.mp4")).not.toBe(iaKey("DuckandC1951", 2.5, "a.mp4"));
  });

  it("two different clip lengths do NOT merge — the trim's output differs", () => {
    expect(iaKey("Medicusc1939_4", 2.5, "a.mp4")).not.toBe(iaKey("Medicusc1939_4", 5.0, "a.mp4"));
  });

  it("two different derivatives do NOT merge — different bytes come back", () => {
    expect(iaKey("Medicusc1939_4", 2.5, "small.mp4")).not.toBe(
      iaKey("Medicusc1939_4", 2.5, "large.mp4")
    );
  });

  it("the start offset is absent, because production passes a fixed 10 on every call", () => {
    expect(PIPE).toContain(
      "trimRemoteVideoToClip(tmpPath, preparedPath, duration, 10, `Internet Archive scene ${sceneIndex}`)"
    );
  });
});

/* ═══════════ 2. render 576's seventeen preparations become one ═══════════ */

describe("R230-B §2 — the same item asked for seventeen times", () => {
  /** A preparation that really writes a file, so the cache's existence check is exercised. */
  const prepare = (calls: { n: number }) => async (): Promise<string> => {
    calls.n += 1;
    const p = path.join(workDir, "prep_ia_fake.mp4");
    await fs.promises.writeFile(p, "clip");
    return p;
  };

  it("MEASURED: seventeen requests, one download and one trim", async () => {
    const calls = { n: 0 };
    const key = iaKey("Medicusc1939_4", 2.5, "Medicusc1939_4.mp4");
    for (let i = 0; i < 17; i++) {
      const outcome = await runPreparation(workDir, key, prepare(calls));
      expect(outcome.status).not.toBe("FAILED");
    }
    expect(calls.n, "the live archive route still re-prepares the same item").toBe(1);
    const counters = preparationCounters(workDir);
    expect(counters.requested).toBe(17);
    expect(counters.succeeded).toBe(1);
    expect(counters.reused).toBe(16);
  });

  it("MEASURED: two beats racing for one item start one preparation, not two", async () => {
    const calls = { n: 0 };
    const key = iaKey("DuckandC1951", 3.0, "DuckandC1951.mp4");
    const slow = async (): Promise<string> => {
      calls.n += 1;
      await new Promise((r) => setTimeout(r, 25));
      const p = path.join(workDir, "prep_ia_race.mp4");
      await fs.promises.writeFile(p, "clip");
      return p;
    };
    const [a, b] = await Promise.all([
      runPreparation(workDir, key, slow),
      runPreparation(workDir, key, slow),
    ]);
    expect(calls.n, "two concurrent beats each ran their own ffmpeg").toBe(1);
    expect(a.status).not.toBe("FAILED");
    expect(b.status).not.toBe("FAILED");
    if (a.status === "FAILED" || b.status === "FAILED") throw new Error("unreachable");
    expect(a.path).toBe(b.path);
  });

  it("MEASURED: five distinct items are still prepared five times", async () => {
    const calls = { n: 0 };
    for (const id of ["ia0", "ia1", "ia2", "ia3", "ia4"]) {
      await runPreparation(workDir, iaKey(id, 2.5, `${id}.mp4`), async () => {
        calls.n += 1;
        const p = path.join(workDir, `prep_${id}.mp4`);
        await fs.promises.writeFile(p, "clip");
        return p;
      });
    }
    expect(calls.n, "over-deduplication — distinct archive items were merged").toBe(5);
  });
});

/* ═══════════ 3. the live route is wired, and cannot go round ═══════════ */

describe("R230-B §3 — no bypass on the live Internet Archive route", () => {
  /**
   * Structural, deliberately. `fetchInternetArchiveClips` talks to archive.org, and this codebase
   * does not simulate providers — a runtime test here would have to invent an archive.org, which
   * is the one thing the standing rules forbid outright. What CAN be proven without a network is
   * that the expensive pair sits inside the cached callback and nowhere else, and §2 above proves
   * at runtime what the callback is then worth.
   */
  /**
   * Bounded at the function's own closing brace — the first `}` in column one after it starts.
   * Slicing to the next `export async function` instead swept in 53k characters of neighbours,
   * including the DEFINITION of `fetchArchiveSegmentViaFfmpeg`, and turned a count of call sites
   * into a count of mentions.
   */
  const fetcher = () => {
    const at = PIPE.indexOf("export async function fetchInternetArchiveClips(");
    expect(at, "the live Internet Archive fetcher is gone").toBeGreaterThan(0);
    const close = PIPE.indexOf("\n}\n", at);
    expect(close).toBeGreaterThan(at);
    return PIPE.slice(at, close);
  };

  it("THE ROUTE CALLS runPreparation", () => {
    expect(fetcher(), "the live archive route bypasses the preparation cache").toContain(
      "await runPreparation(workDir, prepKey,"
    );
  });

  it("THE KEY IS BUILT FROM THE ASSET, THE LENGTH AND THE DERIVATIVE", () => {
    const f = fetcher();
    expect(f).toContain("assetIdentity: `internet_archive:${doc.identifier}`");
    expect(f).toContain("holdSec: duration,");
    expect(f).toContain("variant: videoFile.name,");
  });

  it("THE DOWNLOAD IS INSIDE THE CACHED CALLBACK", () => {
    const f = fetcher();
    const opened = f.indexOf("await runPreparation(workDir, prepKey,");
    const closed = f.indexOf("if (prepared.status === \"FAILED\")");
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(opened);
    const body = f.slice(opened, closed);
    expect(body, "the streaming download escaped the cache").toContain("downloadToFileStreaming(");
    expect(body, "the large-item segment fetch escaped the cache").toContain(
      "fetchArchiveSegmentViaFfmpeg("
    );
    expect(body, "the trim escaped the cache").toContain("trimRemoteVideoToClip(");
  });

  it("AND THERE IS NO SECOND, UNCACHED PAIR LEFT IN THE ROUTE", () => {
    const f = fetcher();
    expect((f.match(/downloadToFileStreaming\(/g) ?? []).length).toBe(1);
    expect((f.match(/trimRemoteVideoToClip\(/g) ?? []).length).toBe(1);
    expect((f.match(/fetchArchiveSegmentViaFfmpeg\(/g) ?? []).length).toBe(1);
    expect((f.match(/runPreparation\(/g) ?? []).length).toBe(1);
  });

  it("the prepared file is named for the PREPARATION, not for a scene", () => {
    const f = fetcher();
    expect(f).toContain("const preparedPath = path.join(workDir, `prep_ia_${prepSlug}.mp4`);");
    expect(f).toContain("const tmpPath = path.join(workDir, `prep_ia_${prepSlug}_tmp`);");
    expect(f, "the temp file is still named for the scene that asked").not.toContain(
      "`scene_${sceneIndex}_${tag}archive_${fetched}_tmp`"
    );
  });

  it("and the DELIVERED file keeps its scene and beat, by copy", () => {
    const f = fetcher();
    /** Provenance is read out of filenames in several places — see the note at the copy. */
    expect(f).toContain("`scene_${sceneIndex}_${tag}archive_${fetched}.mp4`");
    expect(f).toContain("await fs.promises.copyFile(prepared.path, outPath);");
  });

  it("BOTH PREPARATION BOUNDARIES ARE THE SAME ONE — no second cache was built", () => {
    const curated = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(curated).toContain("runPreparation(workDir, prepKey,");
    /**
     * Two callers now, both of `preparationCache`, and no new module beside it. Asserted by
     * counting the boundary rather than by hunting invented names: a substring like "iaCache"
     * matches "tryRestoreFromMed(iaCache)" and would fail on code that has nothing to do with
     * this round.
     */
    /**
     * The invariant that actually matters is not "how many files are named *Cache" — this server
     * has six, most of them unrelated (search results, model verdicts, remote bytes). It is that
     * there is exactly ONE preparation boundary, and that both expensive routes enter through it.
     */
    const owners = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        fs.readFileSync(path.join(__dirname, f), "utf8").includes("export async function runPreparation(")
      );
    expect(owners, "a second preparation boundary was defined").toEqual(["preparationCache.ts"]);
    expect(PIPE).toContain('from "./preparationCache"');
  });
});

/* ═══════════ 4. nothing about the clip changed ═══════════ */

describe("R230-B §4 — the same bytes, for the same reasons", () => {
  it("THE FOUR REJECTION REASONS ALL SURVIVE", () => {
    for (const reason of [
      "archive_segment_fetch_failed",
      "archive_over_size_cap",
      "archive_trim_produced_no_clip",
      "archive_http_",
    ]) {
      expect(PIPE, `${reason} stopped being recorded`).toContain(reason);
    }
  });

  it("a failure still ends the opened lineage record", () => {
    const f = PIPE.slice(PIPE.indexOf('if (prepared.status === "FAILED")'));
    expect(f.slice(0, 400)).toContain("sourcingCache?.lineage?.recordRejection(");
    expect(f.slice(0, 400)).toContain("archiveRejectionReason(prepared.error)");
  });

  it("A FAILURE IS STILL NOT CACHED — a later beat retries rather than inheriting a refusal", async () => {
    let calls = 0;
    const key = iaKey("flaky", 2.5, "flaky.mp4");
    const failing = async (): Promise<string> => {
      calls += 1;
      throw new Error("archive_http_503");
    };
    expect((await runPreparation(workDir, key, failing)).status).toBe("FAILED");
    expect((await runPreparation(workDir, key, failing)).status).toBe("FAILED");
    expect(calls, "the failure became a permanent cache entry").toBe(2);
  });

  it("the size cap, the segment threshold and the technical gate are untouched", () => {
    expect(PIPE).toContain("const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;");
    expect(PIPE).toContain("const segmentSec = Math.max(20, Math.ceil(duration) + 8);");
    /** The two deliberate bars R229 confirmed: 480 lines for stock, 144 for archive. */
    const gate = fs.readFileSync(path.join(__dirname, "technicalMediaGate.ts"), "utf8");
    expect(gate).toContain("VIDEO_QUALITY_BAR_SHORT_SIDE_PX");
    expect(gate).toContain("VIDEO_MIN_SHORT_SIDE_PX");
  });

  it("no budget, threshold or flag moved in this route", () => {
    const f = PIPE.slice(
      PIPE.indexOf("export async function fetchInternetArchiveClips(")
    ).slice(0, 40_000);
    expect(f).toContain("45_000,");
    expect(f).toContain("8_000,");
  });
});
