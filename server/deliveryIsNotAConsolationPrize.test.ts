/**
 * §10/§11 — A FILM THE AUTHORITATIVE TIMELINE DID NOT RENDER IS NOT A DELIVERY.
 *
 * ── What the pipeline did ───────────────────────────────────────────────────────────────────
 *
 *     [RenderJob] video=574 route=legacy_compose RENDER_FALLBACK_USED reason=…
 *     [RenderJob] video=574 the delivered file is the compose montage — …
 *     status: COMPLETE
 *
 * The fallback was never silent — both lines are greppable and the reason is the renderer's own
 * words. The objection is not to the silence: it is that the video was marked COMPLETE with a
 * composition the planner did not produce, and a viewer had no way to tell.
 *
 * ── Since RONDE 661 ─────────────────────────────────────────────────────────────────────────
 *
 * The compose route is deleted. A timeline render that did not deliver has nothing to fall back
 * to, so any recorded refusal blocks — and the old development escape hatch
 * (`ALLOW_LEGACY_COMPOSE_FALLBACK`) no longer opens anything.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  deliveryGate,
  formatDeliveryBlock,
  DELIVERY_GATE_FAIL,
  DELIVERY_GATE_PASS,
  type DeliveryClipFact,
  type DeliveryGateInput,
} from "./deliveryGate";

const saved = process.env.ALLOW_LEGACY_COMPOSE_FALLBACK;
afterEach(() => {
  if (saved === undefined) delete process.env.ALLOW_LEGACY_COMPOSE_FALLBACK;
  else process.env.ALLOW_LEGACY_COMPOSE_FALLBACK = saved;
});

const goodClip = (id: string): DeliveryClipFact => ({
  clipId: id,
  archiveAssetId: 57001,
  provider: "internet_archive",
  providerAssetId: "youtube-r6LB5toWr5I",
  resolved: true,
  fromArchive: true,
  isPlaceholder: false,
});

const goodFile = {
  exists: true,
  readable: true,
  durationSec: 60,
  hasVideoStream: true,
  hasAudioStream: true,
  sizeBytes: 4_000_000,
};

const input = (over: Partial<DeliveryGateInput> = {}): DeliveryGateInput => ({
  videoId: 10108,
  route: "cinematic_timeline",
  timelineExists: true,
  clips: [goodClip("c1"), goodClip("c2")],
  delivered: goodFile,
  voiceoverSec: 60,
  ...over,
});

/* ═════════════ Test 11 — a failed timeline render is BLOCKED ═════════════ */

describe("Test 11 — the delivery gate", () => {
  it("MEASURED: a clean cinematic render passes", () => {
    const v = deliveryGate(input());
    expect(v.allow).toBe(true);
    expect(v.lines.join("\n")).toContain(DELIVERY_GATE_PASS);
  });

  it("MEASURED: a cinematic render that failed blocks the delivery", () => {
    const v = deliveryGate(input({ cinematicRefusal: "the cinematic render threw: ffmpeg exit 1" }));
    expect(v.allow, "a film the timeline did not render was delivered anyway").toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("AUTHORITATIVE_RENDER_FAILED");
    expect(v.lines.join("\n")).toContain(DELIVERY_GATE_FAIL);
  });

  it("MEASURED: the block names the reason, so the failure can be repaired", () => {
    const v = deliveryGate(input({ cinematicRefusal: "ASSET_NOT_FOUND — clip 3" }));
    expect(formatDeliveryBlock(v, 10108)).toContain("AUTHORITATIVE_RENDER_FAILED");
    expect(formatDeliveryBlock(v, 10108)).toContain("ASSET_NOT_FOUND");
  });

  it("MEASURED: a blank refusal is not a refusal", () => {
    expect(deliveryGate(input({ cinematicRefusal: "   " })).allow).toBe(true);
    expect(deliveryGate(input({ cinematicRefusal: null })).allow).toBe(true);
  });

  it("MEASURED: the old escape hatch opens nothing — there is no fallback left to let through", () => {
    process.env.ALLOW_LEGACY_COMPOSE_FALLBACK = "true";
    const v = deliveryGate(input({ cinematicRefusal: "threw" }));
    expect(v.allow).toBe(false);
    expect(v.lines.join("\n")).not.toContain("LEGACY_FALLBACK_ALLOWED");
  });
});

/* ═════════════ §11 — every production clip ═════════════ */

describe("§11 — what the gate requires of each clip", () => {
  it("MEASURED: a clip with no archive asset blocks the delivery", () => {
    const v = deliveryGate(
      input({ clips: [goodClip("c1"), { ...goodClip("c2"), archiveAssetId: null, fromArchive: false }] })
    );
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures[0]?.code).toBe("CLIP_WITHOUT_ARCHIVE_ASSET");
    expect(v.failures[0]?.detail).toContain("depends on the provider still being reachable");
  });

  it("MEASURED: an unresolved clip blocks the delivery", () => {
    const v = deliveryGate(input({ clips: [{ ...goodClip("c1"), resolved: false }] }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("CLIP_UNRESOLVED");
  });

  it("MEASURED: a placeholder blocks the delivery", () => {
    const v = deliveryGate(input({ clips: [{ ...goodClip("c1"), isPlaceholder: true }] }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("PLACEHOLDER_IN_DELIVERY");
  });

  it("MEASURED: the cinematic route with no timeline blocks", () => {
    const v = deliveryGate(input({ timelineExists: false }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("TIMELINE_MISSING");
  });
});

/* ═════════════ §12 — the delivered file itself ═════════════ */

describe("§12 — the verdict is read from the file, not from a row", () => {
  it("MEASURED: no measured file at all blocks", () => {
    const v = deliveryGate(input({ delivered: null }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("DELIVERED_FILE_MISSING");
  });

  it("MEASURED: an empty file blocks", () => {
    const v = deliveryGate(input({ delivered: { ...goodFile, sizeBytes: 0 } }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("DELIVERED_FILE_UNREADABLE");
  });

  it("MEASURED: no video stream blocks", () => {
    const v = deliveryGate(input({ delivered: { ...goodFile, hasVideoStream: false } }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("DELIVERED_FILE_NO_VIDEO");
  });

  it("MEASURED: a voiceover with no audio in the delivered file blocks", () => {
    const v = deliveryGate(input({ delivered: { ...goodFile, hasAudioStream: false } }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("DELIVERED_FILE_NO_AUDIO");
  });

  it("MEASURED: a delivered duration that does not match the voiceover blocks", () => {
    const v = deliveryGate(input({ delivered: { ...goodFile, durationSec: 41 }, voiceoverSec: 60 }));
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("DELIVERED_DURATION_WRONG");
  });

  it("MEASURED: a small drift inside the tolerance does not block", () => {
    const v = deliveryGate(input({ delivered: { ...goodFile, durationSec: 61.4 }, voiceoverSec: 60 }));
    expect(v.allow).toBe(true);
  });

  /** A video with no voiceover has nothing to align to, and must not be failed for the absence. */
  it("MEASURED: no voiceover means no audio or duration requirement", () => {
    const v = deliveryGate(
      input({ voiceoverSec: null, delivered: { ...goodFile, hasAudioStream: false, durationSec: 12 } })
    );
    expect(v.allow).toBe(true);
  });
});

/* ═════════════ the gate reports what it checked ═════════════ */

describe("the gate says what it looked at", () => {
  it("MEASURED: a pass names the clip count and how many came from the archive", () => {
    const v = deliveryGate(input());
    const line = v.lines.join("\n");
    expect(line).toContain("clips=2");
    expect(line).toContain("fromArchive=2");
    expect(line).toContain("video=10108");
  });

  it("MEASURED: a failure lists every requirement that failed, not just the first", () => {
    const v = deliveryGate(
      input({
        clips: [{ ...goodClip("c1"), archiveAssetId: null, resolved: false }],
        delivered: { ...goodFile, hasVideoStream: false },
      })
    );
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.length).toBeGreaterThanOrEqual(3);
    const codes = v.failures.map((f) => f.code);
    expect(codes).toContain("CLIP_WITHOUT_ARCHIVE_ASSET");
    expect(codes).toContain("CLIP_UNRESOLVED");
    expect(codes).toContain("DELIVERED_FILE_NO_VIDEO");
  });

  it("MEASURED: a passing verdict formats no block sentence", () => {
    expect(formatDeliveryBlock(deliveryGate(input()), 10108)).toBe("");
  });
});
