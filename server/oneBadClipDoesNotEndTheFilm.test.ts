/**
 * ONE BAD CLIP DOES NOT END THE FILM.
 *
 * ── The production rule this round was given ────────────────────────────────────────────────
 *
 *     "GEEN VIDEO MAG MEER DE HELE PRODUCTIERENDER LATEN FAILEN … Een individuele video/clip die
 *      faalt, mag NOOIT de volledige productie laten falen."
 *
 * and, in the same breath, what that may NOT mean:
 *
 *     "GEEN GATES VERSOEPELEN … Een slechte clip moet uit de film verdwijnen, niet de hele film
 *      laten crashen."
 *
 * Those are the two halves this file holds apart. A refused clip is still refused — same
 * predicate, same reason, same log line. What changes is that the refusal costs one shot instead
 * of the whole render.
 *
 * ── What it cost before ─────────────────────────────────────────────────────────────────────
 *
 *     Delivery blocked for video 595: 11 requirement(s) failed — AUTHORITATIVE_RENDER_FAILED
 *     (ASSET_NOT_REHYDRATABLE — clip vc_999c384232: ASSET_NOT_FOUND —
 *      provider=internet_archive providerAssetId=youtube-r6LB5toWr5I has no fetchable URL)
 *
 * One clip of fifteen, four of them sitting archive-backed and ready, and not one frame was
 * rendered. Render 594 ended the same way on a different clip.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { disableClipsForRender, RENDER_CLIP_DROPPED } from "./renderJobWorker";
import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";
import { videoTrack } from "./projectTimeline";

const WORKER = readFileSync(join(__dirname, "renderJobWorker.ts"), "utf8");

function clip(idx: number, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id: `vc_${idx}`,
    kind: "video",
    timelineStart: idx * 4,
    timelineEnd: idx * 4 + 4,
    sourceIn: 0,
    sourceOut: 4,
    source: { provider: "wikimedia", providerAssetId: `file_${idx}.mp4` },
    ...over,
  } as TimelineVideoClip;
}

function timelineOf(clips: TimelineVideoClip[]): ProjectTimeline {
  return {
    version: 1,
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: clips.length * 4,
    tracks: [{ kind: "VIDEO", clips }],
  } as unknown as ProjectTimeline;
}

/* ═══════════════════ REMOVING ONE CLIP ═══════════════════ */

describe("a refused clip leaves this render's input", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("ONLY THE NAMED CLIP IS REMOVED — the rest of the film is untouched", () => {
    const timeline = timelineOf([clip(0), clip(1), clip(2)]);
    const removed = disableClipsForRender(timeline, [{ clipId: "vc_1", reason: "ASSET_NOT_FOUND" }], 9);
    expect(removed).toBe(1);
    expect(videoTrack(timeline).filter((c) => !c.disabled).map((c) => c.id)).toEqual(["vc_0", "vc_2"]);
  });

  it("THE SURVIVORS KEEP THEIR OWN SLOTS — nothing reflows to hide the loss", () => {
    /**
     * A shorter film is an honest film. Shifting the neighbours to close the gap would be the
     * "stille substitutie" this programme refuses: the viewer would see a complete video and no
     * line anywhere would say a shot had been lost.
     */
    const timeline = timelineOf([clip(0), clip(1), clip(2)]);
    const before = videoTrack(timeline).map((c) => [c.id, c.timelineStart, c.timelineEnd]);
    disableClipsForRender(timeline, [{ clipId: "vc_1", reason: "ASSET_NOT_FOUND" }], 9);
    expect(videoTrack(timeline).map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual(before);
  });

  it("the clip stays ON the plan, disabled — the evidence is not deleted", () => {
    const timeline = timelineOf([clip(0), clip(1)]);
    disableClipsForRender(timeline, [{ clipId: "vc_1", reason: "ASSET_NOT_FOUND" }], 9);
    expect(videoTrack(timeline).map((c) => c.id)).toEqual(["vc_0", "vc_1"]);
    expect(videoTrack(timeline)[1]!.disabled).toBe(true);
  });

  it("EVERY DROP IS WRITTEN DOWN, with the asset's identity and the reason verbatim", () => {
    const timeline = timelineOf([
      clip(0),
      clip(1, {
        source: {
          provider: "internet_archive",
          providerAssetId: "youtube-r6LB5toWr5I",
        } as TimelineVideoClip["source"],
      }),
    ]);
    disableClipsForRender(
      timeline,
      [{ clipId: "vc_1", reason: "ASSET_NOT_FOUND — has no fetchable URL" }],
      595
    );
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes(RENDER_CLIP_DROPPED));
    expect(line, "the drop was silent").toBeTruthy();
    expect(line).toContain("clip=vc_1");
    expect(line).toContain("provider=internet_archive");
    expect(line).toContain("providerAssetId=youtube-r6LB5toWr5I");
    expect(line).toContain("archiveAssetId=null");
    expect(line).toContain("ASSET_NOT_FOUND — has no fetchable URL");
  });

  it("a clip id the timeline does not carry removes nothing, and says so in the count", () => {
    /**
     * The caller's "is anything left" check is built on this number. A drop list that silently
     * matched nothing while reporting successes would make an empty timeline look survivable.
     */
    const timeline = timelineOf([clip(0)]);
    expect(disableClipsForRender(timeline, [{ clipId: "vc_nope", reason: "x" }], 9)).toBe(0);
    expect(videoTrack(timeline)[0]!.disabled).toBeUndefined();
  });

  it("dropping the same clip twice counts once", () => {
    const timeline = timelineOf([clip(0), clip(1)]);
    disableClipsForRender(timeline, [{ clipId: "vc_1", reason: "a" }], 9);
    expect(disableClipsForRender(timeline, [{ clipId: "vc_1", reason: "b" }], 9)).toBe(0);
  });
});

/* ═══════════════════ THE JOB'S OWN BRANCHING ═══════════════════ */

describe("the render job stops only on a GLOBAL fault", () => {
  const body = (() => {
    const at = WORKER.indexOf("export async function runRenderJob(");
    return at < 0 ? "" : WORKER.slice(at, WORKER.indexOf("\nexport ", at + 10));
  })();

  it("A PER-CLIP VALIDATOR FAULT IS ANSWERED PER CLIP, NOT BY FAILING THE JOB", () => {
    expect(body, "runRenderJob is gone").not.toBe("");
    /**
     * The exact conditional, not merely the names. A mutation proved that a presence check passes
     * while the branch is switched off — `if (false && …)` contains every word.
     */
    expect(body).toContain(
      'const perClipFaults = blocking.filter((i) => i.code === "missing_asset" && i.elementId);'
    );
    expect(body).toContain(
      'const globalFaults = blocking.filter((i) => !(i.code === "missing_asset" && i.elementId));'
    );
    expect(body).toContain("if (globalFaults.length > 0) {");
    /** And the per-clip list reaches the remover rather than the failure. */
    const drop = body.indexOf("disableClipsForRender(");
    expect(drop, "the per-clip faults are not removed").toBeGreaterThan(0);
  });

  it("IT NO LONGER STOPS AT THE FIRST UNRECOVERABLE ASSET", () => {
    /**
     * `failFast: true` reported one clip and never attempted the rest, so nobody could tell a
     * single provider outage from a broken render. Every failure is collected now, and each one
     * removes its own clip.
     */
    expect(body).toContain("failFast: false,");
    expect(body, "failFast is back on").not.toContain("failFast: true,");
    expect(body).toContain("rehydration.failures.map((f) => ({");
  });

  it("AND IT STILL FAILS WHEN THERE IS NO PICTURE LEFT AT ALL", () => {
    /**
     * The zero-fail rule keeps its terminal case — "geen bruikbare media/fallback meer". Without
     * these two the round would have replaced a render that fails loudly with one that delivers
     * nothing quietly, which is worse.
     */
    expect(body).toContain("if (videoTrack(timeline).filter((c) => !c.disabled).length === 0) {");
    expect(body).toContain("if (rehydration.byClipId.size === 0) {");
    expect(body).toContain("RENDER_ERROR.ASSET_NOT_REHYDRATABLE");
  });

  it("the old whole-render abort on one clip is gone", () => {
    expect(body).not.toContain("const first = rehydration.failures[0]!;");
    expect(body).not.toContain("`clip ${first.clipId}: ${first.result.errorCode}");
  });
});

/* ═══════════════════ WHAT MAY NOT HAVE CHANGED ═══════════════════ */

describe("no gate was softened to buy this", () => {
  it("THE RENDERER STILL REFUSES A CLIP IT CANNOT RESOLVE", () => {
    /**
     * Zero-fail is about the blast radius, never about accepting the clip. `renderTimeline` skips
     * a clip whose media is null and records it — that is the mechanism the job now relies on, and
     * if it ever started rendering something else in its place this round would have become a
     * silent substitution.
     */
    const renderer = readFileSync(join(__dirname, "timelineRenderer.ts"), "utf8");
    expect(renderer).toContain("const media = await params.resolveMedia(clip);");
    expect(renderer).toContain("if (!media) {");
    expect(renderer).toContain("source could not be recovered");
  });

  it("the delivery gate still demands an archive asset per clip", () => {
    /**
     * The exact code, terminated — a mutation renamed it `CLIP_WITHOUT_ARCHIVE_ASSET_X`, which a
     * bare `toContain` accepts word for word while the requirement no longer matches the code the
     * gate's own type declares. A near-miss name is exactly how a requirement stops firing.
     */
    const gate = readFileSync(join(__dirname, "deliveryGate.ts"), "utf8");
    expect(gate).toContain('| "CLIP_WITHOUT_ARCHIVE_ASSET"');
    expect(gate).toContain('code: "CLIP_WITHOUT_ARCHIVE_ASSET",');
  });

  it("the archive-first invariant at the push boundary is untouched", () => {
    const pipe = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("async function ensureArchiveBackedBeforePush(");
    expect(pipe).toContain('if (!sourceMayEnterCuratedArchive(provider)) return { ok: true, reason: "exempt_source" };');
    expect(pipe).toContain("if (archived.ok) return false;");
  });
});
