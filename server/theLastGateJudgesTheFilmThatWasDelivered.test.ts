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

/* ═══════════ §1 — the gate's own reading is unchanged and still right ═══════════ */

describe("§1 — the gate judges what the ledger says is in the final video", () => {
  const rec = (over: Record<string, unknown>) =>
    ({
      lineageId: "x",
      provider: "ww2",
      providerAssetId: "1",
      archiveAssetId: 1,
      route: "primary",
      finalVideoAt: 1,
      ...over,
    }) as never;

  it("ONLY RECORDS MARKED AS IN THE FINAL VIDEO ARE JUDGED", () => {
    const facts = deliveryClipFactsFromLedger([
      rec({ lineageId: "in" }),
      rec({ lineageId: "out", finalVideoAt: null }),
    ]);
    expect(facts.map((f) => f.clipId)).toEqual(["in"]);
  });

  it("and a card the pipeline drew is still a placeholder to it", () => {
    const facts = deliveryClipFactsFromLedger([rec({ lineageId: "card", route: "fallback" })]);
    expect(facts[0]?.isPlaceholder).toBe(true);
  });

  it("A PLACEHOLDER IN THE JUDGED LIST STILL BLOCKS — THAT RULE IS NOT TOUCHED", () => {
    const verdict = deliveryGate({
      videoId: 603,
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: deliveryClipFactsFromLedger([rec({ lineageId: "card", route: "fallback" })]),
      delivered: null,
      assetsOnly: true,
      voiceoverSec: null,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.failures.map((f) => f.code)).toContain("PLACEHOLDER_IN_DELIVERY");
  });

  it("and a film of real clips passes it", () => {
    const verdict = deliveryGate({
      videoId: 603,
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: deliveryClipFactsFromLedger([rec({ lineageId: "a" }), rec({ lineageId: "b" })]),
      delivered: null,
      assetsOnly: true,
      voiceoverSec: null,
    });
    expect(verdict.allow).toBe(true);
  });
});

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
  it("MARKFINALVIDEO IS STILL FED FROM THE COMPOSE MONTAGE", () => {
    /**
     * Unchanged on purpose. On the compose route that list IS the delivered film, and the stage-6
     * marking is the only FINAL_VIDEO that route ever gets. What was missing was the correction on
     * the cinematic routes, not a different marking here.
     */
    const at = PIPE.indexOf("const proven = ledger.markFinalVideo(deliveredClips);");
    expect(at).toBeGreaterThan(-1);
    const before = PIPE.slice(at - 700, at);
    expect(before).toContain("composedUsedClips[i]");
  });

  it("and the last gate still reads the ledger, not a second list of its own", () => {
    expect(PIPE).toContain("clips: deliveryClipFactsFromLedger(deliveredRecords),");
    expect(PIPE).toContain(
      "const deliveredRecords = visualDedup.sourcingCache?.lineage?.allRecords() ?? [];"
    );
  });
});
