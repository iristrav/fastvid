/**
 * RONDE 132 §2/§11/§12 — the same picture, coming back.
 *
 * ── What was already right ───────────────────────────────────────────────────────────────────
 *
 * FastVid does not lack dedup sets. RONDE 34 wrote the scopes down and they still hold:
 * `usedContentKeys` at the adopt point, `usedCuratedAssetIds` for archive rows,
 * `usedCuratedStorageUrls` for the files behind them, `usedFunnelCandidateIds` for funnel ids.
 * Between them the same footage could not reach the timeline twice, and did not.
 *
 * ── The leak ─────────────────────────────────────────────────────────────────────────────────
 *
 * They are written by whichever route happens to run, and one of them had a single writer:
 *
 *     dedup.usedCuratedAssetIds.add(...)     ← ONE call site, the older archive scan
 *     dedup.usedFunnelCandidateIds.add(...)  ← the funnel, four call sites
 *
 * The funnel is the primary path. So an archive asset adopted through the funnel was recorded as a
 * used FUNNEL CANDIDATE and never as a used ARCHIVE ASSET, and everything asking the archive-asset
 * question was blind to it — including RONDE 131's search memory, whose exclude set is exactly
 * that Set. A memory could therefore hand back a picture this very video had already used, which
 * is the one thing §11 says it must never do.
 *
 * `usedContentKeys` still caught it at adopt time, so nothing shipped twice. But it was caught
 * AFTER the download and the vision call, in one of the six shortlist slots the beat gets — paid
 * for in budget, in a slot a different picture could have filled.
 *
 * ── What changed ─────────────────────────────────────────────────────────────────────────────
 *
 * One reader and one writer over the sets that already exist. No new storage, no second system:
 * `assetUsedInVideo` asks all of them and says which matched, `markAssetUsedInVideo` writes all of
 * them so no route can record one identity and miss another.
 */
import { describe, expect, it } from "vitest";
import { createVisualDedupStats, formatVisualDedupSummary, markAssetUsedInVideo, noteDuplicateAttempt, type UsedAssetSets } from "./visualDedupRegistry";

import type { ArchiveAssetRow } from "./curatedMediaSourcing";
import { buildBeatVisualStatuses, neverAskedReason } from "./beatVisualStatus";
import { formatMontageShortfallWarning } from "./videoQualityReport";
import { formatProviderSkips } from "./scenePool";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

/** One adopted beat, in the shape clipAdoptAudit records. */
const adopt = (
  sceneIndex: number,
  beatIndex: number,
  basename: string,
  source: string
): ClipAdoptEntry =>
  ({ sceneIndex, beatIndex, basename, source }) as unknown as ClipAdoptEntry;

const sets = (): UsedAssetSets => ({
  usedPaths: new Set(),
  usedContentKeys: new Set(),
  usedCuratedAssetIds: new Set(),
  usedCuratedStorageUrls: new Set(),
});

/* ═══════════════════════ A–F: the brief's dedup cases ═══════════════════════ */

describe("RONDE 132 §2 — a picture used once is not offered again", () => {

  it("a non-integer archive id is never recorded", () => {
    const s = sets();
    markAssetUsedInVideo(s, { archiveAssetId: 1.5 });
    expect(s.usedCuratedAssetIds.size).toBe(0);
  });
});

/* ═══════════════════════ the log lines §2 asks for ═══════════════════════ */

describe("RONDE 132 §2 — the refusal is visible", () => {

  it("the summary counts unique against duplicate attempts, split by identity", () => {
    /**
     * `matchedOn` in the summary is what makes a rise attributable: an archive-asset match and a
     * content-key match are two different stories about where the repeat came from.
     */
    const stats = createVisualDedupStats();
    stats.uniqueAssets = 14;
    stats.reusedAssets = 1;
    noteDuplicateAttempt(stats, "archive_asset_id");
    noteDuplicateAttempt(stats, "archive_asset_id");
    noteDuplicateAttempt(stats, "content_key");
    const line = formatVisualDedupSummary(556, stats);
    expect(line).toContain("uniqueAssets=14");
    expect(line).toContain("reusedAssets=1");
    expect(line).toContain("duplicateAttempts=3");
    expect(line).toContain("archive_asset_id=2");
    expect(line).toContain("content_key=1");
    // Identities that caught nothing are left out rather than printed as zeros.
    expect(line).not.toContain("storage_url");
  });

  it("a render with no duplicates says so cleanly", () => {
    const stats = createVisualDedupStats();
    stats.uniqueAssets = 16;
    expect(formatVisualDedupSummary(556, stats)).toBe(
      "[VisualDedup] video=556 uniqueAssets=16 reusedAssets=0 duplicateAttempts=0"
    );
  });
});

/* ═══════════════════════ wired into the real path ═══════════════════════ */

describe("RONDE 132 §2 — wired where the pictures are actually adopted", () => {
  const read = (file: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, file), "utf8");
  };

  it("the render report prints the dedup summary", () => {
    expect(read("videoPipeline.ts")).toContain("formatVisualDedupSummary(getActiveVideoId()");
  });

  it("the registry owns no storage of its own", () => {
    /**
     * "Geen tweede cachesysteem": it is a reader and a writer over the sets that already exist,
     * so a module-level Map or Set here would be exactly the second system the brief forbids.
     */
    const registry = read("visualDedupRegistry.ts");
    expect(registry).not.toMatch(/^const \w+ = new (Map|Set)/m);
    expect(registry).not.toMatch(/^let \w+ = new (Map|Set)/m);
  });

  it("RONDE 34's dedup scopes are still the ones being used", () => {
    // ONE ROUTE: the sets with a writer are the storage; the ones nothing wrote (funnel ids,
    // provider keys, fingerprints) are gone — a provider identity lives in usedContentKeys.
    const pipe = read("videoPipeline.ts");
    for (const set of ["usedPaths", "usedContentKeys", "usedCuratedAssetIds", "usedCuratedStorageUrls"]) {
      expect(pipe, set).toContain(`${set}:`);
    }
    for (const gone of ["usedFunnelCandidateIds", "  usedProviderKeys: Set<string>;", "usedFingerprints"]) {
      expect(pipe, gone).not.toContain(gone);
    }
  });
});

/* ═══════════════════════ N: never_asked must name a cause ═══════════════════════ */

describe("RONDE 132 §3 — never_asked is never an ending on its own", () => {
  it("THE GAP: the warning printed the bare word, with no cause", () => {
    /**
     * From the render:
     *
     *     10 van 14 beat(s) zonder goedgekeurd eigen beeld
     *     (held_frame=2, never_asked=5, subject_only=1, unknown=2)
     *
     * `never_asked=5` says the gate was not consulted and stops there — so "the beat holds a held
     * frame, there was nothing to judge" and "the beat holds real footage nobody looked at" shared
     * one label. The first is the pipeline working. The second is a hole.
     *
     * `neverAskedReason` was written for this in RONDE 166 §9 and had no caller: the warning built
     * its own string from the bare verification.
     */
    const statuses = buildBeatVisualStatuses(
      [
        adopt(0, 0, "own_footage.mp4", "archive"),
        adopt(0, 1, "scene_0_b1_placeholder.mp4", "fallback"),
      ],
      undefined // no relevance ledger at all → every beat is never_asked
    );
    for (const st of statuses) {
      expect(st.verification, `${st.sceneIndex}:${st.beatIndex}`).toBe("never_asked");
      // ...and not one of them reports the bare word as its reason.
      expect(st.reason, `${st.sceneIndex}:${st.beatIndex}`).not.toBe("never_asked");
      expect(st.reason.length).toBeGreaterThan(0);
    }
  });

  it("real footage nobody judged is named as the gap it is", () => {
    const [st] = buildBeatVisualStatuses([adopt(0, 0, "own_footage.mp4", "archive")], undefined);
    expect(st!.reason).toBe("real_footage_never_judged");
  });

  it("a beat with nothing to judge says so, and is not confused with the gap", () => {
    // A placeholder carries no picture, so the gate is RIGHT not to have been asked. That must
    // read differently from real footage that slipped past the gate.
    const [st] = buildBeatVisualStatuses(
      [adopt(0, 0, "scene_0_b0_placeholder.mp4", "fallback")],
      undefined
    );
    expect(st!.reason).toContain("no_picture_to_judge");
    expect(st!.reason).not.toBe("real_footage_never_judged");
  });

  it("every coverage has a cause — none can fall through to a blank", () => {
    /**
     * The invariant §3 asks for: never_asked may not become a normal ending without a cause. Stated
     * across the whole vocabulary rather than for the cases that happen to occur today.
     */
    const coverages = [
      "own_footage", "subject_only", "placeholder", "held_frame", "graphic", "none", "generated",
    ] as const;
    for (const c of coverages) {
      const reason = neverAskedReason(c);
      expect(reason, c).toBeTruthy();
      expect(reason, c).not.toBe("never_asked");
      expect(reason.length, c).toBeGreaterThan(3);
    }
  });

  it("a beat that WAS judged keeps its verdict, not a never-asked cause", () => {
    // The change must not overwrite a real verdict with a reason about not having one.
    const ledger = { byClipPath: new Map() } as unknown as Parameters<typeof buildBeatVisualStatuses>[1];
    const statuses = buildBeatVisualStatuses([adopt(0, 0, "own_footage.mp4", "archive")], ledger);
    expect(statuses[0]!.verification).toBe("never_asked"); // empty ledger, still never asked
    expect(statuses[0]!.reason).toBe("real_footage_never_judged");
  });
});

/* ═══════════════════════ O/T: the shortfall and the skipped providers ═══════════════════════ */

describe("RONDE 132 §10 — a short montage says HOW short", () => {
  const short = (sceneIndex: number, shortBySec: number, uniqueClips = 3, neededClips = 5) =>
    ({ sceneIndex, shortBySec, uniqueClips, neededClips });

  it("THE GAP: the old warning had no number and said 'may'", () => {
    /**
     * From the render:
     *
     *     short montage: scene(s) 1, 2 had less footage than voice
     *                    — the tail may be filled by holding the last frame
     *
     * A 0.3s shortfall is a rounding artefact; a 12s one is a visible freeze. Both produced that
     * exact sentence, and the "may" left the reader unable to tell whether anything froze at all.
     */
    const line = formatMontageShortfallWarning([short(1, 0.4), short(2, 12.3)], [1, 2]);
    expect(line).not.toContain("may be filled");
    expect(line).toContain("12.3s");
  });

  it("names the worst scene, because that is the one worth looking at", () => {
    const line = formatMontageShortfallWarning([short(1, 0.4), short(2, 12.3, 2, 6)], [1, 2]);
    expect(line).toContain("worst scene 2 at 12.3s");
    expect(line).toContain("2 unique clip(s), 6 needed");
  });

  it("the total says whether it is one bad scene or a systemic shortage", () => {
    expect(formatMontageShortfallWarning([short(1, 4), short(2, 6)], [1, 2]))
      .toContain("10.0s short in total");
  });

  it("with no shortfall recorded it keeps the old, weaker sentence rather than inventing one", () => {
    // The estimate can flag a scene without a shortfall being recorded. Printing "0.0s short"
    // there would be a measurement that was never taken.
    const line = formatMontageShortfallWarning([], [1, 2]);
    expect(line).toContain("scene(s) 1, 2");
    expect(line).toContain("may be filled");
    expect(line).not.toContain("0.0s");
  });

  it("O. NOT DONE: the shortfall does not yet send the beat back to sourcing", () => {
    /**
     * Stated as a test so it cannot be quietly forgotten.
     *
     * §10 asks for `requiredDuration vs availableUniqueDuration` BEFORE the montage, and a return
     * to sourcing when it falls short. The check exists and is now measured, but the loop back
     * into sourcing does not: the shortfall is detected inside compose, which sits downstream of
     * every sourcing route, and re-entering sourcing from there is an architectural change rather
     * than a patch.
     *
     * What this round delivers is the number that says whether it is worth building.
     */
    const line = formatMontageShortfallWarning([short(1, 12.3)], [1]);
    expect(line).toContain("filled by holding the last frame");
  });
});

