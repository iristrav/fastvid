/**
 * THE LAST GATE JUDGES THE FILM THAT WAS DELIVERED — RONDE 639.
 *
 * ── Render 603, four seconds apart ──────────────────────────────────────────────────────────
 *
 *     [PlaceholderGate] video=603 refusedFromTimeline=1 clipsOnTimeline=9 placeholdersOnTimeline=0
 *     [DeliveryGate] DELIVERY_GATE_PASS video=603 clips=9 fromArchive=9
 *                    route=cinematic_timeline timeline=present checks=assets+file
 *     [RenderJob] job=20 status=completed output=edits/render_20_352a2dd1.mp4
 *                 published=true clips=9 duration=65.54s
 *     [RenderJob] video=603 job=20 DELIVERED_BY=render_job_worker after 231.9s
 *
 *     [DeliveryGate] DELIVERY_GATE_FAIL video=603 clips=13 fromArchive=12 checks=assets failures=1
 *       PLACEHOLDER_IN_DELIVERY — clip=rmue7f1yp-1#149 is a placeholder or colour fallback
 *     [Video Generation] Error: Delivery blocked for video 603: 1 requirement(s) failed
 *
 * A 25 MB film of nine shots was rendered, published, and passed the gate that read the real
 * bytes. Then the pipeline refused the video over a card the placeholder gate had ALREADY kept
 * off the timeline — `placeholdersOnTimeline=0` says so in the same log.
 *
 * ── Why the last gate saw thirteen ──────────────────────────────────────────────────────────
 *
 * `markFinalVideo` runs at stage 6 over `composedUsedClips`: the COMPOSE montage's clips, which
 * is what the ledger's FINAL_VIDEO marking then describes. `deliveryClipFactsFromLedger` keeps
 * exactly `finalVideoAt != null`, so the last gate judges that marking.
 *
 * The claimed cinematic path already corrects this — `replaceFinalVideo(deliveredPaths)` against
 * what the render job reported it rendered. RONDE 633 added a SECOND way to deliver the cinematic
 * film (waiting on the worker that won the job) and did not carry the correction across. The
 * quality figures were handled on that path; FINAL_VIDEO was in the same position and was missed.
 *
 * That is this codebase's signature defect, committed by the round that was removing it.
 *
 * ── What the correction can and cannot claim ────────────────────────────────────────────────
 *
 * The claimed path knows what the renderer RENDERED. Another process rendered this one, so the
 * strongest list available is the stored timeline the job carried — what was ASKED for. A clip the
 * worker could not rehydrate would still be marked. The log says which of the two it is instead of
 * implying the stronger one, and it is still vastly closer to the delivered film than a montage
 * nobody received.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { deliveryClipFactsFromLedger, deliveryGate } from "./deliveryGate";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════ §2 — both delivery paths correct the marking ═══════════ */

describe("§2 — FINAL_VIDEO is re-proved wherever the cinematic film is delivered", () => {
  it("THE CLAIMED PATH RE-PROVES IT, AS IT ALWAYS DID", () => {
    const at = PIPE.indexOf("if (jobOutcome.ok) {");
    expect(at).toBeGreaterThan(-1);
    expect(PIPE.indexOf("ledger.replaceFinalVideo(deliveredPaths)", at)).toBeGreaterThan(at);
  });

  it("AND SO DOES THE PATH THAT WAITED FOR THE WORKER — RENDER 603'S GAP", () => {
    const at = PIPE.indexOf('if (waited.kind === "DELIVERED") {');
    expect(at).toBeGreaterThan(-1);
    const block = PIPE.slice(at, PIPE.indexOf("} else {", at));
    expect(block).toContain("ledger.replaceFinalVideo(deliveredPaths)");
  });

  it("there are exactly two corrections, one per delivery path", () => {
    expect(PIPE.split("replaceFinalVideo(deliveredPaths)").length - 1).toBe(2);
  });

  it("the wait path builds its list from the timeline the job carried", () => {
    const at = PIPE.indexOf('if (waited.kind === "DELIVERED") {');
    const block = PIPE.slice(at, PIPE.indexOf("} else {", at));
    expect(block).toContain("const timelineClips = videoTrack(outcome.timeline);");
    expect(block).toContain("localFilesForTimelineClips({");
  });

  it("AND SAYS IT IS PLANNED RATHER THAN CONFIRMED RENDERED", () => {
    /**
     * The claimed path knows what was rendered; this one knows what was asked for. Claiming the
     * stronger of the two would be exactly the kind of borrowed certainty this file keeps
     * removing.
     */
    expect(PIPE).toContain(
      "planned rather than confirmed rendered, because another process rendered it"
    );
  });

  it("and a failure to re-prove costs the render nothing", () => {
    const at = PIPE.indexOf("could not re-prove FINAL_VIDEO against the ");
    expect(at).toBeGreaterThan(-1);
    /* It is a warning inside a catch, not a throw. */
    expect(PIPE.slice(at - 400, at)).toContain("} catch (err) {");
  });
});

/* ═══════════ §3 — the stale source is still the stale source ═══════════ */

describe("§3 — what the correction exists to overwrite", () => {
  it("FINAL_VIDEO IS MARKED ONLY FROM WHAT THE TIMELINE DELIVERED", () => {
    /**
     * RONDE 661 — the stage-6 marking from the compose montage's clip list is gone with the
     * compose route. Both delivery paths mark FINAL_VIDEO with `replaceFinalVideo`, from the
     * delivered (or planned) timeline — nothing else writes it.
     */
    expect(PIPE).not.toContain("ledger.markFinalVideo(");
    expect((PIPE.match(/ledger\.replaceFinalVideo\(deliveredPaths\)/g) ?? []).length).toBe(2);
  });
});
