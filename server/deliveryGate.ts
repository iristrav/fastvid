/**
 * WHAT A RENDER MUST BE ABLE TO SHOW BEFORE IT IS ALLOWED TO SAY COMPLETE.
 *
 * ── The two things this ends ────────────────────────────────────────────────────────────────
 *
 * 1. A render whose authoritative timeline render failed, marked COMPLETE with something else in
 *    it. §10: a failed authoritative render is FAILED or BLOCKED. Since RONDE 661 there is no
 *    compose montage to hand over instead, so a recorded refusal can only ever block.
 *
 * 2. Completion decided from database metadata. A row saying `videoUrl` is not a video; §12 asks for
 *    the delivered MP4 itself to be read. This module does not re-implement that reading —
 *    `checkRenderedFile` and `postRenderSpotCheck` already do it — it REQUIRES it, and refuses a
 *    verdict built from anything less.
 */

/* ═══════════════════════ what the gate is asked about ═══════════════════════ */

/** One production media clip, as the gate needs to see it. */
export type DeliveryClipFact = {
  clipId: string;
  /** The internal archive handle. Absent is the condition §9 exists to remove. */
  archiveAssetId?: number | null;
  provider: string;
  providerAssetId?: string | null;
  /** Did rehydration produce a readable local file for this clip? */
  resolved: boolean;
  /** Was it resolved from FastVid's own storage rather than a provider? */
  fromArchive: boolean;
  /** Placeholder, colour card, text overlay — anything that depicts nothing. */
  isPlaceholder: boolean;
};

/** What the delivered file itself was measured to be. Never taken from a database row. */
export type DeliveredFileFacts = {
  exists: boolean;
  readable: boolean;
  durationSec: number | null;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  sizeBytes: number;
};

export type DeliveryGateInput = {
  videoId: number;
  /** The authoritative timeline's own render — since RONDE 661 the only route there is. */
  route: "cinematic_timeline";
  /** Set when the timeline render did not deliver. Any refusal blocks the delivery. */
  cinematicRefusal?: string | null;
  /** Whether an authoritative timeline exists for this video at all. */
  timelineExists: boolean;
  clips: DeliveryClipFact[];
  delivered: DeliveredFileFacts | null;
  /**
   * Run ONLY the asset checks, and say so on the line.
   *
   * The pipeline's final gate sits after the export gate, the stillness audit and the post-render
   * spot check have all already read the delivered file. It has no fresh measurements of its own
   * and passing invented ones — `exists: true, hasVideoStream: true` — would be this gate claiming
   * a check it never made, which is the habit the whole programme exists to remove.
   *
   * So it declares what it is: the asset invariant, on a file whose bytes are somebody else's
   * verdict. `delivered` is then ignored, and the log says `checks=assets` so nobody reads a pass
   * here as a statement about the picture.
   */
  assetsOnly?: boolean;
  /** The voiceover's measured length, for the alignment check. Null when there is no voiceover. */
  voiceoverSec?: number | null;
  /** How far the delivered duration may sit from the voiceover before it is a fault. */
  durationToleranceSec?: number;
};

export type DeliveryGateFailureCode =
  | "AUTHORITATIVE_RENDER_FAILED"
  | "TIMELINE_MISSING"
  | "CLIP_WITHOUT_ARCHIVE_ASSET"
  | "CLIP_UNRESOLVED"
  | "PLACEHOLDER_IN_DELIVERY"
  | "DELIVERED_FILE_MISSING"
  | "DELIVERED_FILE_UNREADABLE"
  | "DELIVERED_FILE_NO_VIDEO"
  | "DELIVERED_FILE_NO_AUDIO"
  | "DELIVERED_DURATION_WRONG";

export type DeliveryGateVerdict =
  | { allow: true; checked: number; lines: string[] }
  | { allow: false; failures: Array<{ code: DeliveryGateFailureCode; detail: string }>; lines: string[] };

/* ═══════════════════════ the gate ═══════════════════════ */

export const DELIVERY_GATE_PASS = "DELIVERY_GATE_PASS";
/** §22 — one line per clip, naming the archive asset the render actually used. */
export const TIMELINE_ARCHIVE_REFERENCE = "TIMELINE_ARCHIVE_REFERENCE";
export const DELIVERY_GATE_FAIL = "DELIVERY_GATE_FAIL";

/**
 * May this render be marked COMPLETE?
 *
 * Pure: every fact is passed in, measured by the caller from the file and the timeline. That is
 * deliberate — a gate that fetches its own evidence is a gate whose evidence cannot be shown in a
 * test, and this one's whole job is to be shown.
 */
export function deliveryGate(input: DeliveryGateInput): DeliveryGateVerdict {
  const failures: Array<{ code: DeliveryGateFailureCode; detail: string }> = [];
  const lines: string[] = [];
  const at = `video=${input.videoId}`;

  /* §10 — the authoritative render failed; there is nothing else to hand over. */
  if (input.cinematicRefusal?.trim()) {
    failures.push({
      code: "AUTHORITATIVE_RENDER_FAILED",
      detail: `the cinematic timeline render did not deliver (${input.cinematicRefusal})`,
    });
  }

  /* §11 — an authoritative timeline must exist for a timeline render. */
  if (!input.timelineExists) {
    failures.push({
      code: "TIMELINE_MISSING",
      detail: "the route claims the authoritative timeline and no timeline was recorded",
    });
  }

  /* §11 — every production media clip, one by one. */
  for (const clip of input.clips) {
    if (clip.isPlaceholder) {
      failures.push({
        code: "PLACEHOLDER_IN_DELIVERY",
        detail: `clip=${clip.clipId} is a placeholder or colour fallback`,
      });
      continue;
    }
    if (clip.archiveAssetId == null) {
      failures.push({
        code: "CLIP_WITHOUT_ARCHIVE_ASSET",
        detail:
          `clip=${clip.clipId} provider=${clip.provider} ` +
          `providerAssetId=${clip.providerAssetId ?? "none"} has no archive asset, so the renderer ` +
          `depends on the provider still being reachable`,
      });
    }
    if (!clip.resolved) {
      failures.push({
        code: "CLIP_UNRESOLVED",
        detail: `clip=${clip.clipId} provider=${clip.provider} produced no readable file`,
      });
    }
  }

  /* §12 — the delivered MP4 itself, unless this caller has no measurement of its own. */
  const d = input.assetsOnly ? null : input.delivered;
  if (input.assetsOnly) {
    /* the file is the export gate's and the spot check's verdict on this route — see `assetsOnly` */
  } else if (!d || !d.exists) {
    failures.push({ code: "DELIVERED_FILE_MISSING", detail: "no delivered file was measured" });
  } else {
    if (!d.readable || d.sizeBytes <= 0) {
      failures.push({
        code: "DELIVERED_FILE_UNREADABLE",
        detail: `the delivered file could not be read (bytes=${d.sizeBytes})`,
      });
    }
    if (!d.hasVideoStream) {
      failures.push({ code: "DELIVERED_FILE_NO_VIDEO", detail: "the delivered file has no video stream" });
    }
    if (input.voiceoverSec != null && !d.hasAudioStream) {
      failures.push({
        code: "DELIVERED_FILE_NO_AUDIO",
        detail: "a voiceover was produced and the delivered file has no audio stream",
      });
    }
    if (input.voiceoverSec != null && d.durationSec != null) {
      const tolerance = input.durationToleranceSec ?? 2;
      const drift = Math.abs(d.durationSec - input.voiceoverSec);
      if (drift > tolerance) {
        failures.push({
          code: "DELIVERED_DURATION_WRONG",
          detail:
            `the delivered file is ${d.durationSec.toFixed(2)}s and the voiceover is ` +
            `${input.voiceoverSec.toFixed(2)}s (drift ${drift.toFixed(2)}s, tolerance ${tolerance}s)`,
        });
      }
    }
  }

  const fromArchive = input.clips.filter((c) => c.fromArchive).length;
  const summary =
    `clips=${input.clips.length} fromArchive=${fromArchive} route=${input.route} ` +
    `timeline=${input.timelineExists ? "present" : "absent"} ` +
    `checks=${input.assetsOnly ? "assets" : "assets+file"}`;

  if (failures.length === 0) {
    lines.push(`[DeliveryGate] ${DELIVERY_GATE_PASS} ${at} ${summary}`);
    return { allow: true, checked: input.clips.length, lines };
  }
  lines.push(`[DeliveryGate] ${DELIVERY_GATE_FAIL} ${at} ${summary} failures=${failures.length}`);
  for (const f of failures) lines.push(`[DeliveryGate]   ${f.code} — ${f.detail}`);
  return { allow: false, failures, lines };
}

/* ═══════════════════════ the pipeline's own check, from the lineage ═══════════════════════ */

/**
 * THE CLIPS THE DELIVERED FILE CARRIES, AS THE GATE NEEDS TO SEE THEM — read from the ledger.
 *
 * The render job gates its timeline itself. The pipeline's final gate reads the lineage ledger
 * instead: `record.finalVideoAt` is set only for the records `replaceFinalVideo` proved against
 * the delivered file's own clip list.
 *
 * ── What `resolved` and `fromArchive` mean here ─────────────────────────────────────────────
 *
 * `resolved` is true by construction: a record with `finalVideoAt` is in the delivered file, so
 * its bytes were read.
 * `fromArchive` is the archive handle's presence, which is the question the gate is really asking.
 */
export type DeliveredLineageRecord = {
  lineageId: string;
  provider?: string | null;
  providerAssetId?: string;
  archiveAssetId?: number;
  route?: string;
  /** Set by `markFinalVideo` for the records proven to be in the delivered file. */
  finalVideoAt?: number | null;
};

export function deliveryClipFactsFromLedger(
  records: readonly DeliveredLineageRecord[]
): DeliveryClipFact[] {
  return records
    .filter((r) => r.finalVideoAt != null)
    .map((r) => ({
      clipId: r.lineageId,
      archiveAssetId: r.archiveAssetId ?? null,
      provider: r.provider?.trim() || "UNVERIFIED",
      providerAssetId: r.providerAssetId ?? null,
      resolved: true,
      fromArchive: r.archiveAssetId != null,
      /**
       * The pipeline's own word for a clip it manufactured rather than sourced. A colour card or a
       * guaranteed slot enters the ledger with `route: "fallback"`, and that is the one route whose
       * output depicts nothing.
       */
      isPlaceholder: r.route === "fallback",
    }));
}

/** The one sentence a blocked delivery reports to the operator and to the job row. */
export function formatDeliveryBlock(verdict: DeliveryGateVerdict, videoId: number): string {
  if (verdict.allow) return "";
  const first = verdict.failures[0];
  return (
    `Delivery blocked for video ${videoId}: ${verdict.failures.length} requirement(s) failed — ` +
    `${first?.code} (${first?.detail})`
  );
}
