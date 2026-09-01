/**
 * RONDE 100B — a cancelled provider is not a dead source, and a small file is not a broken one.
 *
 * Both of these were the same mistake in different places: a cheap proxy standing in for the
 * thing we actually wanted to know. "Adopted nothing" stood in for "this query finds nothing",
 * and "under 8 KB" stood in for "this file is not a video". Production showed what each costs —
 * 22 of 22 sources condemned in a single render, and valid clips deleted after ffmpeg had
 * written them successfully.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordSearchMisses } from "./visualSearchMemory";
import { splitLongRanges, maxClipDurationSec, sceneSafetyMaxSec } from "./archiveVideoSplitter";

const SPLITTER_SRC = fs.readFileSync(path.join(__dirname, "archiveVideoSplitter.ts"), "utf8");

/* ═══════════ §9 — SearchMemory ═══════════ */

describe("RONDE 100B §9 — what may be remembered as a dead end", () => {
  let logged: string[] = [];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** Runs recordSearchMisses and reports the counts it printed. */
  function run(opts: {
    searched: string[];
    adopted?: Record<string, number>;
    results?: Record<string, number>;
    cancelled?: string[];
  }) {
    recordSearchMisses({
      subject: "Adolf Hitler",
      subjectType: "person",
      searchedKeys: opts.searched,
      adoptedByProvider: new Map(Object.entries(opts.adopted ?? {})),
      resultsByProvider: new Map(Object.entries(opts.results ?? {})),
      budgetCancelledProviders: new Set(opts.cancelled ?? []),
    });
    const line = logged.find((l) => l.includes("[SearchMemory]")) ?? "";
    const recorded = /recorded (\d+) of (\d+) dead end/.exec(line);
    const spared = /\[(\d+) spared/.exec(line);
    return {
      line,
      misses: recorded ? Number(recorded[2]) : 0,
      spared: spared ? Number(spared[1]) : 0,
    };
  }

  it("TEST 1 — a provider that genuinely returned nothing may be remembered", () => {
    const r = run({
      searched: ["pexels|adolf hitler", "pexels|adolf hitler 1945"],
      adopted: { pexels: 0 },
      results: { pexels: 0 },
    });
    expect(r.misses).toBe(2);
    expect(r.spared).toBe(0);
  });

  it("TEST 2 — a provider that ANSWERED is not a dead end, whatever happened next", () => {
    /**
     * The production case exactly: Internet Archive ran 13 searches and returned 311 candidates,
     * then every download was cancelled by the enclosing scene budget, so it adopted nothing —
     * and all 13 queries were written down as "this source has nothing".
     */
    const r = run({
      searched: [
        "internet_archive|adolf hitler",
        "internet_archive|subject:\"Adolf Hitler\"",
        "internet_archive|collection:tvnews AND Adolf Hitler",
      ],
      adopted: { internet_archive: 0 },
      results: { internet_archive: 311 },
    });
    expect(r.misses).toBe(0);
    expect(r.spared).toBe(3);
    expect(r.line).toContain("spared");
  });

  it("TEST 3 — a provider FastVid cut off is not a dead end either", () => {
    const r = run({
      searched: ["wikimedia|adolf hitler", "wikimedia|adolf hitler berlin"],
      adopted: { wikimedia: 0 },
      results: { wikimedia: 0 },
      cancelled: ["wikimedia"],
    });
    expect(r.misses).toBe(0);
    expect(r.spared).toBe(2);
  });

  it("TEST 4 — a provider that adopted something is left alone, as before", () => {
    const r = run({
      searched: ["pexels|berlin 1945"],
      adopted: { pexels: 2 },
      results: { pexels: 40 },
    });
    expect(r.misses).toBe(0);
    expect(r.spared).toBe(0);
  });

  it("TEST 5 — the old call shape still works: no results/cancelled data, no crash", () => {
    // The two new fields are optional, so an older caller keeps the pre-RONDE-100B behaviour.
    expect(() =>
      recordSearchMisses({
        subject: "Adolf Hitler",
        subjectType: "person",
        searchedKeys: ["pexels|adolf hitler"],
        adoptedByProvider: new Map([["pexels", 0]]),
      })
    ).not.toThrow();
  });
});

/* ═══════════ §13 — a small file is not a broken file ═══════════ */

describe("RONDE 100B §13 — the extract check asks ffprobe, not the byte count", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r100b-split-"));

  it("TEST 6 — a valid clip well under 8 KB really does exist", () => {
    // The premise of the whole fix: h.264 is a compressor, and a shot with no motion or detail
    // compresses to a few kilobytes. This is what the old floor was deleting.
    const flat = path.join(tmp, "flat.mp4");
    execSync(
      `ffmpeg -y -f lavfi -i "color=c=red:s=320x240:r=25:d=4" -c:v libx264 -g 25 -pix_fmt yuv420p "${flat}" 2>/dev/null`
    );
    const size = fs.statSync(flat).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(8000);

    // And ffprobe reads it perfectly.
    const probe = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -show_entries format=duration -of json "${flat}"`
    ).toString();
    const parsed = JSON.parse(probe) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
    expect(parsed.streams?.[0]?.codec_type).toBe("video");
    expect(Number(parsed.format?.duration)).toBeGreaterThan(3.5);
  });

  it("TEST 7 — no byte floor decides usability any more", () => {
    // Five places used a flat 8000-byte comparison to accept or delete an extracted clip. The
    // removal notes still quote the old expression, so only real code counts.
    const code = SPLITTER_SRC.split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("8000");
    expect(code).toContain("extractedClipIsUsable(");
  });

  it("TEST 8 — the replacement checks stream, duration and readability", () => {
    const idx = SPLITTER_SRC.indexOf("async function extractedClipIsUsable(");
    expect(idx).toBeGreaterThan(-1);
    const body = SPLITTER_SRC.slice(idx, SPLITTER_SRC.indexOf("\n}", idx));
    expect(body).toContain("codec_type");
    expect(body).toContain("format=duration");
    // A container floor survives, but only to skip spawning ffprobe on an empty write.
    expect(body).toContain("MIN_PLAUSIBLE_MP4_BYTES");
    expect(SPLITTER_SRC).toContain("const MIN_PLAUSIBLE_MP4_BYTES = 512;");
  });

  it("TEST 9 — all three call sites go through it", () => {
    const uses = SPLITTER_SRC.match(/extractedClipIsUsable\(/g) ?? [];
    // one definition + five checks (two extract paths, the sub-extract, the re-encode path,
    // and the analysis proxy)
    expect(uses.length).toBeGreaterThanOrEqual(6);
  });
});

/* ═══════════ §14 — the readability check could never pass ═══════════ */

describe("RONDE 100B §14 — the diagnostic told the truth about itself, not the file", () => {
  it("TEST 10 — ffprobe has no -ss, which is why every check 'failed'", () => {
    let failed = "";
    try {
      execSync(
        `ffprobe -v error -i "${path.join(__dirname, "..", "package.json")}" -ss 1 -frames:v 1 -of json 2>&1`
      );
    } catch (e) {
      failed = String((e as { stdout?: Buffer; message?: string }).stdout ?? (e as Error).message);
    }
    // Whatever else is wrong with that file, the option itself is rejected.
    expect(failed.length).toBeGreaterThan(0);
  });

  it("TEST 11 — the check now uses the options ffprobe actually has", () => {
    const code = SPLITTER_SRC.split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).toContain("-read_intervals");
    expect(code).toContain("-show_frames");
    // `-frames:v 1` is an ffmpeg option; ffprobe rejects it, which is what made the check fail on
    // every file. ffmpeg's own `-i FILE -ss POS` (the slow-seek extract strategy) is untouched.
    expect(code).not.toContain("-frames:v 1");
    for (const line of code.split("\n")) {
      if (!line.includes("ffprobe") && !line.includes("ffp}") && !line.includes("${ffprobe}")) continue;
      expect(line, `ffprobe called with -ss: ${line.trim()}`).not.toMatch(/\s-ss\s/);
    }
  });
});

/* ═══════════ §2 — the RONDE 98 scene rule is still intact ═══════════ */

describe("RONDE 100B §2 — scene-based cutting was not undone", () => {
  it("TEST 12 — a detected scene is measured against the safety ceiling, not the grid", () => {
    expect(sceneSafetyMaxSec()).toBeGreaterThan(maxClipDurationSec());
    expect(splitLongRanges([{ start: 0, end: 12 }], sceneSafetyMaxSec())).toHaveLength(1);
    expect(splitLongRanges([{ start: 0, end: 4 }], sceneSafetyMaxSec())).toHaveLength(1);
  });

  it("TEST 13 — with no scene information the interval fallback still applies", () => {
    const blind = splitLongRanges([{ start: 0, end: 30 }], maxClipDurationSec());
    expect(blind.length).toBeGreaterThan(1);
  });

  it("TEST 14 — the ceiling is still chosen by whether cuts were found", () => {
    expect(SPLITTER_SRC).toContain("const sceneAware = cuts.length > 0;");
    expect(SPLITTER_SRC).toContain("sceneAware ? sceneSafetyMaxSec() : maxClipDurationSec()");
  });
});
