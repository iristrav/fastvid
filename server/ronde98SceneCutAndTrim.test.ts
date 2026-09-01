/**
 * RONDE 98 — cut on scenes, not on seconds; and make "Bijknippen" actually stick.
 *
 * Two faults, both real, both measured in the code rather than guessed at:
 *
 *   · The archive splitter DOES detect shot boundaries — scdet, the scene filter, and two rescan
 *     passes looking for interior cuts. It then threw that answer away: "Always split any range
 *     longer than maxClipDurationSec", six seconds, applied to every range whether detected or
 *     not. A 38-second continuous shot became seven clips of 5.4s, stored as seven archive rows,
 *     and nothing downstream could tell they were one scene.
 *
 *   · The trim button re-encoded the file correctly and then wrote only `storageUrl` to the row.
 *     storagePut gives every write a fresh random key, and resolveRemoteDownloadUrl prefers
 *     `storageKey` — which still pointed at the original. The trim was real on disk and invisible
 *     everywhere else, which is what "de knop werkt niet" meant.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  filterClipRangesBelowMinDuration,
  maxClipDurationSec,
  sceneSafetyMaxSec,
  splitLongRanges,
} from "./archiveVideoSplitter";
import { MIN_TRIMMED_CLIP_SEC, validateTrimRange } from "./archiveTrimToScene";

const SPLITTER_SRC = fs.readFileSync(path.join(__dirname, "archiveVideoSplitter.ts"), "utf8");
const TRIM_SRC = fs.readFileSync(path.join(__dirname, "archiveTrimToScene.ts"), "utf8");
const ROUTERS_SRC = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
const UI_SRC = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "components", "admin", "ArchiveClipsGrid.tsx"),
  "utf8"
);

/** The split step as the pipeline runs it: ceiling depends on whether cuts were detected. */
function splitAsPipelineDoes(
  ranges: Array<{ start: number; end: number }>,
  cutsDetected: number
): Array<{ start: number; end: number }> {
  const ceiling = cutsDetected > 0 ? sceneSafetyMaxSec() : maxClipDurationSec();
  return splitLongRanges(ranges, ceiling);
}

/* ═══════════ A/B — a detected scene survives whole ═══════════ */

describe("RONDE 98 §1 — a 38-second scene is one clip", () => {
  it("TEST 1 — a detected 38s shot is not cut into pieces", () => {
    const scene = [{ start: 0, end: 38 }];
    const out = splitAsPipelineDoes(scene, 4);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBe(38);
  });

  it("TEST 2 — nor are 12, 27, 45 or 63 second scenes", () => {
    for (const len of [12, 27, 45, 63]) {
      const out = splitAsPipelineDoes([{ start: 0, end: len }], 3);
      expect(out, `${len}s scene was split`).toHaveLength(1);
      expect(out[0]!.end - out[0]!.start).toBe(len);
    }
  });

  it("TEST 3 — the old six-second rule no longer reaches a detected scene", () => {
    // The value still exists, for the no-detection fallback. What changed is where it applies.
    expect(maxClipDurationSec()).toBeLessThanOrEqual(6);
    expect(sceneSafetyMaxSec()).toBeGreaterThan(maxClipDurationSec() * 5);
    const out = splitAsPipelineDoes([{ start: 0, end: 38 }], 1);
    expect(out).toHaveLength(1);
  });

  it("TEST 4 — the splitter no longer says it always splits", () => {
    // The old call passed no ceiling, so it always used the six-second editorial default.
    expect(SPLITTER_SRC).not.toMatch(/ranges = splitLongRanges\(ranges\);/);
    expect(SPLITTER_SRC).toContain("ranges = splitLongRanges(ranges, splitCeiling);");
    expect(SPLITTER_SRC).toContain("const sceneAware = cuts.length > 0;");
    expect(SPLITTER_SRC).toContain("const splitCeiling = sceneAware ? sceneSafetyMaxSec() : maxClipDurationSec();");
  });
});

/* ═══════════ C/D — same scene combined, new scene split ═══════════ */

describe("RONDE 98 §2 — a new scene starts a clip; a continuing one does not", () => {
  it("TEST 5 — two detected scenes stay two clips", () => {
    const detected = [
      { start: 0, end: 42 },   // SCENE 1
      { start: 42, end: 65 },  // SCENE 2
    ];
    const out = splitAsPipelineDoes(detected, 1);
    expect(out).toHaveLength(2);
    expect(out[0]!.end).toBe(42);
    expect(out[1]!.start).toBe(42);
  });

  it("TEST 6 — one scene is never returned as four ten-second pieces", () => {
    const out = splitAsPipelineDoes([{ start: 0, end: 40 }], 2);
    expect(out).toHaveLength(1);
    // The shape the old code produced, spelled out so a regression is unmistakable.
    expect(out).not.toEqual([
      { start: 0, end: 10 }, { start: 10, end: 20 },
      { start: 20, end: 30 }, { start: 30, end: 40 },
    ]);
  });

  it("TEST 7 — with no cuts detected anywhere, fixed intervals are still the fallback", () => {
    // Nothing was detected, so there is no scene information to preserve. Interval splitting is
    // all that is left, and it stays.
    const out = splitAsPipelineDoes([{ start: 0, end: 38 }], 0);
    expect(out.length).toBeGreaterThan(1);
    for (const r of out) expect(r.end - r.start).toBeLessThanOrEqual(maxClipDurationSec() + 0.2);
  });

  it("TEST 8 — the safety ceiling still catches a scene that cannot be real", () => {
    // A 10-minute "scene" that survived detection and two rescans is a detector failure, not a
    // shot. It is split — which is the documented reason the ceiling exists.
    const out = splitAsPipelineDoes([{ start: 0, end: 600 }], 5);
    expect(out.length).toBeGreaterThan(1);
    for (const r of out) expect(r.end - r.start).toBeLessThanOrEqual(sceneSafetyMaxSec() + 0.2);
  });

  it("TEST 9 — the ceiling is a safety limit, and is documented as one", () => {
    expect(SPLITTER_SRC).toContain("export function sceneSafetyMaxSec()");
    const idx = SPLITTER_SRC.indexOf("const DEFAULT_SCENE_SAFETY_MAX_SEC");
    const doc = SPLITTER_SRC.slice(Math.max(0, idx - 900), idx);
    expect(doc).toMatch(/corrupt|detector failure|something went wrong|not a claim/i);
  });
});

/* ═══════════ split behaviour that must not regress ═══════════ */

describe("RONDE 98 — the rest of the splitter is untouched", () => {
  it("TEST 10 — splitLongRanges still splits evenly when asked to", () => {
    const out = splitLongRanges([{ start: 0, end: 30 }], 10);
    expect(out).toHaveLength(3);
    expect(out.map((r) => Math.round(r.end - r.start))).toEqual([10, 10, 10]);
  });

  it("TEST 11 — a range at or under the ceiling is returned untouched", () => {
    const one = [{ start: 5, end: 11 }];
    expect(splitLongRanges(one, 10)).toEqual(one);
  });

  it("TEST 12 — sub-minimum fragments are still dropped, not glued together", () => {
    const kept = filterClipRangesBelowMinDuration(
      [{ start: 0, end: 0.4 }, { start: 1, end: 9 }],
      2
    );
    expect(kept).toEqual([{ start: 1, end: 9 }]);
  });
});

/* ═══════════ E/F/G — the trim ═══════════ */

describe("RONDE 98 §5 — Bijknippen keeps a chosen range, and it sticks", () => {
  it("TEST 13 — a start point is finally possible", () => {
    const v = validateTrimRange({ startSec: 3, endSec: 12 }, 30);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.startSec).toBe(3);
      expect(v.endSec).toBe(12);
    }
  });

  it("TEST 14 — the ffmpeg call seeks to the start instead of always taking the head", () => {
    expect(TRIM_SRC).toContain("-ss ${startSec.toFixed(3)} -i");
    expect(TRIM_SRC).toContain("-t ${keepSec.toFixed(3)}");
  });

  it("TEST 15 — an end before the start is refused with a reason, not a crash", () => {
    const v = validateTrimRange({ startSec: 10, endSec: 4 }, 30);
    expect(v.ok).toBe(false);
    // SUPERSEDED by RONDE 108: the rule moved to @shared/archiveTrim so the archive panel can ask
    // it BEFORE sending, and its reasons are now the sentence the operator reads on screen — so
    // they are in Dutch, like the rest of that panel. The RULE is unchanged; only the language is.
    if (!v.ok) expect(v.reason).toMatch(/ná het startpunt/i);
  });

  it("TEST 16 — a range shorter than the minimum is refused", () => {
    const v = validateTrimRange({ startSec: 5, endSec: 5.2 }, 30);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(String(MIN_TRIMMED_CLIP_SEC));
  });

  it("TEST 17 — trimming to the whole clip is refused rather than re-encoded for nothing", () => {
    const v = validateTrimRange({ startSec: 0, endSec: 30 }, 30);
    expect(v.ok).toBe(false);
    // SUPERSEDED by RONDE 108 — same reason as TEST 15: the reason is operator-facing text now.
    if (!v.ok) expect(v.reason).toMatch(/hele clip/i);
  });

  it("TEST 18 — THE BUG: both storage columns are written, not just the URL", () => {
    // storagePut returns a NEW key every time (appendHashSuffix is random) and
    // resolveRemoteDownloadUrl prefers storageKey. Writing only storageUrl left the row pointing
    // at two different files, and the loader took the old one.
    const idx = TRIM_SRC.indexOf("await updateMediaArchiveAsset(");
    expect(idx).toBeGreaterThan(-1);
    const call = TRIM_SRC.slice(idx, TRIM_SRC.indexOf("});", idx));
    expect(call).toContain("storageUrl: url");
    expect(call).toContain("storageKey: key");
    expect(call).toContain("durationSec:");
    // And the key actually comes back from the write.
    expect(TRIM_SRC).toContain("const { key, url } = await storagePut(");
  });

  it("TEST 19 — the duration is probed from the produced file, not assumed", () => {
    expect(TRIM_SRC).toContain("const newDuration = await probeVideoDurationSec(outPath);");
    // And the source duration is probed too, rather than trusting a durationSec a previous trim
    // may have left behind.
    expect(TRIM_SRC).toContain("const sourceDur = await probeVideoDurationSec(localPath);");
  });

  it("TEST 20 — a trim that produces no usable file throws instead of updating the row", () => {
    const throwIdx = TRIM_SRC.indexOf('throw new Error("Trim produced no usable file")');
    const updateIdx = TRIM_SRC.indexOf("await updateMediaArchiveAsset(");
    expect(throwIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeLessThan(updateIdx);
  });
});

/* ═══════════ G — lineage and identity survive ═══════════ */

describe("RONDE 98 §6 — the asset keeps its identity through a trim", () => {
  it("TEST 21 — only bytes, location and duration change", () => {
    const idx = TRIM_SRC.indexOf("await updateMediaArchiveAsset(");
    const call = TRIM_SRC.slice(idx, TRIM_SRC.indexOf("});", idx));
    // Nothing that identifies where the asset came from is touched.
    for (const column of ["archiveId", "title", "tags", "sourceUrl", "provider", "mediaType"]) {
      expect(call, `trim rewrites ${column}`).not.toContain(`${column}:`);
    }
  });

  it("TEST 22 — the asset id is never changed, so the render's lineage still resolves it", () => {
    // ensureCuratedAssetLineage keys the render-time record on the archive asset id. A trim that
    // created a NEW row would break that link; this one updates in place.
    expect(TRIM_SRC).toContain("updateMediaArchiveAsset(asset.id,");
    expect(TRIM_SRC).not.toContain("createMediaArchiveAsset(");
    expect(TRIM_SRC).toContain("assetId: asset.id");
  });

  it("TEST 23 — no second lineage system was built for trimming", () => {
    expect(TRIM_SRC).not.toContain("new VisualSourceLedger");
    expect(TRIM_SRC).not.toContain("createLineage(");
  });
});

/* ═══════════ the API and the UI ═══════════ */

describe("RONDE 98 — the flow end to end", () => {
  it("TEST 24 — the endpoint takes a real range, and still honours the old single cut", () => {
    const idx = ROUTERS_SRC.indexOf("trimToSingleScene: adminProcedure");
    const body = ROUTERS_SRC.slice(idx, idx + 3000);
    expect(body).toContain("startSec: z.number().min(0).optional()");
    expect(body).toContain("endSec: z.number().min(0).optional()");
    // Backwards compatible: cutAtSec/cutTimeSec still mean "keep 0 → cut".
    expect(body).toContain("const legacyCut = input.cutAtSec ?? input.cutTimeSec;");
    expect(body).toContain("trimArchiveAsset(");
  });

  it("TEST 25 — a bad range comes back as a reason the operator can read", () => {
    const idx = ROUTERS_SRC.indexOf("trimToSingleScene: adminProcedure");
    const body = ROUTERS_SRC.slice(idx, idx + 3000);
    expect(body).toContain("return { trimmed: false, reason:");
    expect(body).toContain("catch (err)");
  });

  it("TEST 26 — the UI offers a start AND an end, not one cut point", () => {
    /**
     * SUPERSEDED BY RONDE 108, deliberately — the rule is the same, the shape got safer.
     *
     * markStart and markEnd were two functions that each did `if (t == null) return;`: a silent
     * refusal when the playhead could not be read, which is exactly how "de knop werkt niet" was
     * reported. They are one function now, and every refusal names its reason.
     */
    expect(UI_SRC).toContain('function markAt(which: "start" | "end")');
    expect(UI_SRC).toContain('const markStart = () => markAt("start");');
    expect(UI_SRC).toContain('const markEnd = () => markAt("end");');
    expect(UI_SRC).toContain("const [trimStart, setTrimStart]");
    expect(UI_SRC).toContain("const [trimEnd, setTrimEnd]");
    expect(UI_SRC).not.toContain("const [trimAt, setTrimAt]");
  });

  it("TEST 27 — the UI sends the range to the server, not a browser-only preview", () => {
    /**
     * RONDE 108 tightened this. It used to assert `startSec: trimStart ?? 0`, which after this
     * round still matched — but from the VALIDATION call, not from the request. The request now
     * carries the validated bounds, so both are pinned explicitly.
     */
    const send = UI_SRC.indexOf("const result = await trimMutation.mutateAsync({");
    expect(send).toBeGreaterThan(-1);
    const request = UI_SRC.slice(send, send + 300);
    expect(request).toContain("startSec: from,");
    expect(request).toContain("endSec: to,");
    // And it hands the result up so the grid refreshes and the stale scene audit is cleared.
    expect(UI_SRC).toContain("onTrimmed?.(result.newDurationSec!)");
    expect(UI_SRC).toContain("onTrimmed={(newDurationSec) => onTrimmed(asset.id, newDurationSec)}");
  });

  it("TEST 28 — the operator cannot save a start at or past the end", () => {
    /**
     * RONDE 108: the half-second is no longer written into the message — it comes from
     * MIN_TRIMMED_CLIP_SEC in @shared/archiveTrim, the same constant the server validates with,
     * so the two can no longer drift apart.
     */
    expect(UI_SRC).toContain(
      "toast.error(`Startpunt moet minstens ${MIN_TRIMMED_CLIP_SEC}s vóór het eindpunt liggen`)"
    );
    expect(UI_SRC).toContain(
      "toast.error(`Eindpunt moet minstens ${MIN_TRIMMED_CLIP_SEC}s ná het startpunt liggen`)"
    );
  });
});
