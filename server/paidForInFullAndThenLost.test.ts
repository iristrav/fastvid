/**
 * RONDE 262 — THE ASSET THAT WAS PAID FOR IN FULL AND THEN LOST.
 *
 * ── Render 587, provider=youtube_cc providerAssetId=ODx7fCL6BHw, scene 2 beat 0 ─────────────
 *
 *     YouTube fair-use found 5 relevant videos
 *     ODx7fCL6BHw ok via watchpage dur=43s
 *     ScriptGuided metadata @28.2s
 *     Cloud DL failed — falling back to RapidAPI
 *     ODx7fCL6BHw trim start 28.2s          ← bytes moved, ffmpeg ran, a clip exists
 *
 * And then nothing for that lineage. No VISION, no APPROVED, no REJECTED, no ADOPTED, no PUSHED,
 * no COMPOSED, no CINEMATIC, no DELIVERED.
 *
 * ── Why the ledger could not say so ─────────────────────────────────────────────────────────
 *
 * `lifecyclesOf` ends its ladder with `adoptedAt == null && selectedAt == null → NEVER_SELECTED`,
 * which is the correct and healthy verdict for a candidate the render retrieved and did not use.
 * A DOWNLOADED clip with no judgement landed in that same branch — so the one asset the render had
 * paid for in full was reported beside the hundreds nobody ever touched, and the forensic summary
 * counted it under `neverSelected`.
 *
 * The ledger therefore could not distinguish:
 *
 *     "we never bothered with this one"                          — a render working normally
 *     "we spent a download slot, moved 3.4 MB, ran ffmpeg,
 *      produced a clip, and then no step ever looked at it"      — the most expensive way to
 *                                                                  lose an asset there is
 *
 * ── What this round adds, and what it deliberately does not ─────────────────────────────────
 *
 * One terminal status and one invariant. A clip dropped before Vision FOR A REASON is not this —
 * REJECTED, REPLACED and REMOVED are all read higher up the ladder and keep their own status, and
 * §3 proves each of them still does. What fires here is the state that may never be reached: the
 * bytes arrived and the record is otherwise silent.
 *
 * NOTHING IS LOOSENED. No gate, no threshold, no budget. A render in which this never happens is
 * byte-for-byte unchanged; a render in which it does now says so instead of filing it under a word
 * that means the opposite.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  formatLifecycleInvariants,
  lifecyclesOf,
  type LineageEventStatus,
  type LineageStage,
  type VisualLineageEvent,
  type VisualLineageRecord,
} from "./visualSourceLineage";

const LINEAGE = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");

/** One lineage record, shaped like the ones the YouTube route writes. */
function record(over: Partial<VisualLineageRecord> = {}): VisualLineageRecord {
  return {
    lineageId: "r-1#74",
    renderId: "r-1",
    sceneIndex: 2,
    beatIndex: 0,
    provider: "youtube_cc",
    providerAssetId: "ODx7fCL6BHw",
    ...over,
  } as VisualLineageRecord;
}

const event = (
  stage: LineageStage,
  status: LineageEventStatus = "OK",
  reason?: string
): VisualLineageEvent =>
  ({ lineageId: "r-1#74", stage, status, ...(reason ? { reason } : {}) }) as VisualLineageEvent;

const OK_RENDER = { renderSucceeded: true, deliveryHappened: true };

/** Exactly render 587's trace: found, downloaded, trimmed — and then silence. */
const RENDER_587 = [event("FOUND"), event("DOWNLOAD_STARTED"), event("DOWNLOAD_SUCCEEDED")];

/* ═══════════ 1. the two facts that used to be one word ═══════════ */

describe("R262 §1 — bought and lost is not the same as never wanted", () => {
  it("RENDER 587: a downloaded clip nobody judged has its own terminal status", () => {
    const [life] = lifecyclesOf([record()], RENDER_587);
    expect(life.terminalStatus).toBe("DOWNLOADED_NEVER_JUDGED");
  });

  it("and a candidate that was merely retrieved is still NEVER_SELECTED", () => {
    const [life] = lifecyclesOf([record()], [event("FOUND")]);
    expect(life.terminalStatus, "a healthy render would start reporting errors").toBe(
      "NEVER_SELECTED"
    );
  });

  it("THE DISTINCTION IS THE DOWNLOAD, not the number of events", () => {
    const started = lifecyclesOf([record()], [event("FOUND"), event("DOWNLOAD_STARTED")])[0];
    expect(started, "a claimed slot that moved no bytes is not a bought asset").toMatchObject({
      terminalStatus: "NEVER_SELECTED",
    });
  });

  it("a download that failed keeps its own status, which already existed", () => {
    const [life] = lifecyclesOf(
      [record()],
      [event("FOUND"), event("DOWNLOAD_STARTED"), event("DOWNLOAD_FAILED", "FAILED", "timeout")]
    );
    expect(life.terminalStatus).toBe("DROPPED_AT_DOWNLOAD");
  });
});

/* ═══════════ 2. it is reported as a defect, not as a row ═══════════ */

describe("R262 §2 — the invariant says it out loud", () => {
  it("THE LINE RENDER 587 NEEDED AND DID NOT HAVE", () => {
    const errors = formatLifecycleInvariants(lifecyclesOf([record()], RENDER_587), OK_RENDER);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("DOWNLOADED_ASSET_NEVER_JUDGED");
    expect(errors[0], "an operator cannot find the asset from this line").toContain(
      "asset=youtube_cc:ODx7fCL6BHw"
    );
    expect(errors[0]).toContain("scene=2 beat=0");
  });

  it("a healthy render stays silent — the property every invariant here has to have", () => {
    const delivered = [...RENDER_587, event("ADOPTED"), event("FINAL_VIDEO")];
    expect(
      formatLifecycleInvariants(lifecyclesOf([record({ adoptedAt: 1 })], delivered), OK_RENDER)
    ).toEqual([]);
  });

  it("and so does a render that simply retrieved more than it used", () => {
    expect(
      formatLifecycleInvariants(lifecyclesOf([record()], [event("FOUND")]), OK_RENDER)
    ).toEqual([]);
  });

  it("the forensic summary counts it apart from neverSelected", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE, "it is still hidden inside another count").toContain(
      'downloadedNeverJudged=${count("DOWNLOADED_NEVER_JUDGED")}'
    );
  });
});

/* ═══════════ 3. a drop with a reason is still a legitimate outcome ═══════════ */

describe("R262 §3 — DOWNLOAD_SUCCEEDED → dropped(reason) is allowed and unchanged", () => {
  /**
   * The spec this round implements says so explicitly: `DOWNLOAD_SUCCEEDED → DROPPED_BEFORE_VISION
   * (reason=…)` is permitted, and only `DOWNLOAD_SUCCEEDED → niets` is forbidden. Each of the
   * three ways a route can refuse a downloaded clip is checked here, because a round that made
   * refusals look like defects would push the next one towards refusing less.
   */
  it("REJECTED before adoption keeps its own status", () => {
    const [life] = lifecyclesOf(
      [record()],
      [...RENDER_587, event("COMPOSE_INPUT", "REJECTED", "does_not_fit")]
    );
    expect(life.terminalStatus).not.toBe("DOWNLOADED_NEVER_JUDGED");
  });

  it("REPLACED keeps its own status", () => {
    const [life] = lifecyclesOf([record()], [...RENDER_587, event("REPLACED", "REPLACED", "swap")]);
    expect(life.terminalStatus).toBe("REPLACED");
  });

  it("REMOVED keeps its own status", () => {
    const [life] = lifecyclesOf([record()], [...RENDER_587, event("REMOVED", "REMOVED", "dedup")]);
    expect(life.terminalStatus).toBe("REPLACED");
  });

  it("and a clip that reached compose and was dropped there is unaffected", () => {
    const [life] = lifecyclesOf(
      [record({ selectedAt: 1 })],
      [...RENDER_587, event("COMPOSE_INPUT"), event("COMPOSE_DROPPED", "REMOVED", "overlap")]
    );
    expect(life.terminalStatus).toBe("DROPPED_AT_COMPOSE");
  });
});

/* ═══════════ 4. the ladder still reads in travel order ═══════════ */

describe("R262 §4 — nothing above this branch moved", () => {
  it("a delivered asset is FINAL, downloaded or not", () => {
    expect(lifecyclesOf([record()], [...RENDER_587, event("FINAL_VIDEO")])[0].terminalStatus).toBe(
      "FINAL"
    );
  });

  it("a render input is DELIVERED_INPUT", () => {
    expect(lifecyclesOf([record()], [...RENDER_587, event("RENDER_INPUT")])[0].terminalStatus).toBe(
      "DELIVERED_INPUT"
    );
  });

  it("a cinematic drop is DROPPED_AT_CINEMATIC", () => {
    const evs = [...RENDER_587, event("CINEMATIC_DROPPED", "REMOVED", "no_identity")];
    expect(lifecyclesOf([record()], evs)[0].terminalStatus).toBe("DROPPED_AT_CINEMATIC");
  });

  it("THE NEW BRANCH IS THE LAST ONE BEFORE NEVER_SELECTED, not the first", () => {
    const judged = LINEAGE.indexOf('has("DOWNLOAD_SUCCEEDED") ? "DOWNLOADED_NEVER_JUDGED"');
    const finalV = LINEAGE.indexOf('if (finalVideo) terminalStatus = "FINAL";');
    expect(judged).toBeGreaterThan(-1);
    expect(finalV).toBeGreaterThan(-1);
    expect(judged, "it now outranks the statuses an asset actually reached").toBeGreaterThan(finalV);
  });
});

/* ═══════════ 5. nothing was loosened ═══════════ */

describe("R262 §5 — no gate, threshold or budget moved", () => {
  it("the existing invariants are all still present", () => {
    for (const code of [
      "ADOPTED_ASSET_MISSING_CINEMATIC_TERMINAL_EVENT",
      "ASSIGNED_ASSET_MISSING_COMPOSE_OUTCOME",
      "CINEMATIC_SELECTED_AND_DROPPED",
    ]) {
      expect(LINEAGE, `${code} was removed`).toContain(code);
    }
  });

  it("finalOutputVerified is still the honest UNKNOWN", () => {
    expect(lifecyclesOf([record()], RENDER_587)[0].finalOutputVerified).toBe("UNKNOWN");
    expect(LINEAGE).toContain('finalOutputVerified: "UNKNOWN"');
  });

  it("and the new status is a report, never a permission", () => {
    /**
     * It appears in the terminal-status union, the ladder, the invariant and the summary count —
     * and nowhere that decides whether an asset may be used. A lifecycle verdict that started
     * granting adoption would be this codebase's signature defect wearing a new name.
     */
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const uses = [...PIPE.matchAll(/DOWNLOADED_NEVER_JUDGED/g)];
    expect(uses.length, "the pipeline reads this verdict for something other than reporting").toBe(
      1
    );
  });
});
