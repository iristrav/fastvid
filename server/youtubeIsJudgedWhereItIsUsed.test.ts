import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createBeatImageGateState } from "./beatImageRelevanceGate";
import type { VisionCaller } from "./visionCensus";

/**
 * YOUTUBE IS JUDGED ONCE, WHERE IT IS USED.
 *
 * ── What this file replaces, and why ────────────────────────────────────────────────────────
 *
 * A downloaded YouTube clip used to be shown to the picture editor TWICE. Once in a pre-pool
 * screening, at download time, against one beat's sentence — and again later by the beat gate,
 * after it had won a shortlist slot. No other source was asked twice. This file retires the
 * screening and the rules that guarded it, and keeps what those rounds actually learned.
 *
 * ── What render 578 measured ────────────────────────────────────────────────────────────────
 *
 *     [VisionCensus]  youtube_screening judged=24 unavailable=0 skipped=21
 *     [VisualFunnel]  youtube_cc retrieved=2479 downloadSucceeded=88 eligible=1 composed=0
 *
 * 2479 candidates found, 88 downloaded, none delivered. The screening spent its entire
 * 24-judgement slice first-come — on whichever clips finished downloading first, before any
 * ranking had ordered them — refused 22 of those 24 and DELETED the files. One beat's sentence
 * therefore ended a clip's life for the whole scene, even though `fetchYouTubeCCClips` is called
 * per SCENE and its results serve every beat in it. The remaining ~64 downloads met
 * `if (used >= max) return true;` and entered the pool on a silent yes the caller reads as
 * "passed the image gate".
 *
 * ── The findings the retired rounds are worth keeping ───────────────────────────────────────
 *
 * RONDE 61 — render 532 spent 52 of its 60 judgements on YouTube candidates and refused 48 of
 * them, leaving the funnel — the route the adopted clips actually come from — just 8. That is why
 * a separate YouTube slice existed at all. It is not needed now: the crowding was possible only
 * because the screening ran ahead of the pool, and the per-source share on the beat shortlist
 * (`maxShortlistPerBeatPerSource`) bounds every source's draw on the judgement budget in the one
 * place where the drawing happens.
 *
 * RONDE 114 — a clip refused by the screening was unlinked and the loop moved on, so the ledger
 * held a DOWNLOAD_SUCCEEDED and then nothing: `rejected=0` in the youtube_cc row while two clips
 * had just been rejected, and `unexplained=2 INVARIANT_BROKEN` where the record stopped. The
 * lesson — a refusal is an outcome and must be filed — still stands everywhere a refusal happens.
 * There is simply no refusal at this point any more.
 *
 * RONDE 104 — the screening's verdict was recorded under the clip's CONTENT identity so a refused
 * asset could not walk back in under a new filename. The mechanism it used,
 * `recordExternalRelevanceVerdict`, had no other production caller and now lives in
 * `beatRelevanceSeed.test.support.ts`; see that file for why it was moved rather than deleted.
 *
 * RONDE 569's bottleneck — the screening filed its verdict under `beatIndex: -1`, no real beat
 * ever matched it, and the adoption guard therefore read NOT_ASKED for a clip the editor had
 * already approved. Judging once, at the beat, is what removes that failure rather than patching
 * around it.
 */

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const GATE = readFileSync(join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
const CENSUS = readFileSync(join(__dirname, "visionCensus.ts"), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the pre-pool screening is gone", () => {
  it("NO ROUTE JUDGES A YOUTUBE CLIP BEFORE IT IS IN A BEAT'S POOL", () => {
    expect(code(PIPE)).not.toContain("youtubeClipPassesImageGate");
  });

  it("and nothing deletes a downloaded clip on one beat's verdict", () => {
    /**
     * The deletion was the sharpest edge: `fetchYouTubeCCClips` runs per SCENE, so a clip refused
     * against beat 0's sentence was removed from disk for beats 1..n as well, which never saw it.
     */
    expect(code(PIPE)).not.toContain("recordYoutubeScreeningRefusal");
  });

  it("THE DOWNLOAD STILL GOES INTO THE POOL — the route was not disabled, only the filter", () => {
    const flat = code(PIPE).replace(/\s+/g, " ");
    expect(flat).toContain("if (ok) { results.push(outPath); downloadedIds.add(videoId); fetched++;");
  });

  it("the render still files an outcome for every YouTube download it starts", () => {
    // RONDE 114's real subject, and untouched: the download's own outcome is recorded above the
    // removed branch, on success and on failure alike.
    expect(PIPE).toContain("recordProviderDownloadOutcome(");
    expect(PIPE).toContain("noteYoutubeDownloadRefusal(videoId, dl.status, dl.reason)");
  });
});

describe("the separate YouTube judgement slice is gone with it", () => {
  it("THE SLICE HAS NO DEFINITION LEFT", () => {
    expect(GATE).not.toContain("MAX_YOUTUBE_BEAT_IMAGE_JUDGEMENTS");
    expect(GATE).not.toContain("maxYoutubeBeatImageJudgements");
  });

  it("and no counter that only it could move", () => {
    const state = createBeatImageGateState();
    expect(Object.keys(state)).not.toContain("youtubeJudgementsUsed");
    expect(Object.keys(state)).not.toContain("youtubeUnscreenedAdmissions");
  });

  it("THE TWO BUDGETS THAT DO THE WORK ARE UNCHANGED", () => {
    /**
     * Nothing here raises a budget. RONDE 175 set these two and the reasoning behind them is
     * untouched; what changed is that YouTube now draws on them through the beat shortlist like
     * every other source, instead of out of a slice of its own spent before any ranking.
     */
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS_PER_BEAT", 4, 1, 12)');
    expect(GATE).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS", 120, 0, 500)');
  });

  it("the census no longer offers a caller nobody can be", () => {
    expect(CENSUS).not.toContain('"youtube_screening"');
    const callers: VisionCaller[] = ["funnel_scorer", "beat_judge", "clip_quality_gate", "adopted_clip_quality"];
    for (const c of callers) expect(CENSUS).toContain(`"${c}"`);
  });
});

describe("what the removal left behind was cleared up, not left lying", () => {
  it("SCRIPTGUIDED NO LONGER CARRIES FIELDS WITH NO READER", () => {
    /**
     * `imageGate` and `relevanceLedger` existed so the screening could judge and record. Nine call
     * sites set each of them. With the screening gone they had nine writers and no reader at all —
     * the exact shape this codebase treats as a defect — so they went with it.
     */
    const ctx = PIPE.slice(
      PIPE.indexOf("type ScriptGuidedBeatContext = {"),
      PIPE.indexOf("type YoutubeSearchRow = {")
    );
    expect(ctx.length).toBeGreaterThan(100);
    expect(ctx).not.toContain("imageGate?:");
    expect(ctx).not.toContain("relevanceLedger?:");
    expect(code(PIPE)).not.toContain("imageGate: dedup.beatImageGate");
  });

  it("the ledger seeder is out of production rather than silenced", () => {
    /**
     * `recordExternalRelevanceVerdict` had exactly one production caller and it was the screening.
     * `ronde120MetricsHaveWriters` caught that immediately — "give it a caller, or delete it" —
     * and neither was right alone: eight test files need it to seed a ledger and there is no other
     * synchronous way in. It moved to a file the guard does not read and vitest does not collect,
     * so the rule is intact and nothing was re-implemented eight times.
     */
    expect(existsSync(join(__dirname, "beatRelevanceSeed.test.support.ts"))).toBe(true);
    expect(readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8"))
      .not.toContain("export function recordExternalRelevanceVerdict");
    expect(code(PIPE)).not.toContain("recordExternalRelevanceVerdict");
  });
});
