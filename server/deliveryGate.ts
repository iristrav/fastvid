/**
 * WHAT A RENDER MUST BE ABLE TO SHOW BEFORE IT IS ALLOWED TO SAY COMPLETE.
 *
 * ── The two things this ends ────────────────────────────────────────────────────────────────
 *
 * 1. A cinematic render that failed and delivered the compose montage anyway, marked COMPLETE. The
 *    log said `RENDER_FALLBACK_USED` and the reason, so it was never SILENT — but it was still the
 *    production delivery path, and a viewer had no way to know the film they received is not the
 *    one the pipeline planned. §10: a failed authoritative render is FAILED or BLOCKED.
 *
 * 2. Completion decided from database metadata. A row saying `videoUrl` is not a video; §12 asks for
 *    the delivered MP4 itself to be read. This module does not re-implement that reading —
 *    `checkRenderedFile` and `postRenderSpotCheck` already do it — it REQUIRES it, and refuses a
 *    verdict built from anything less.
 *
 * ── The distinction the whole gate turns on ─────────────────────────────────────────────────
 *
 * `legacy_compose` is two different things wearing one name:
 *
 *     the CONFIGURED route     CINEMATIC_RENDER_PATH is off. There is no authoritative timeline
 *                              render to fail, so compose is not a fallback — it is the route this
 *                              deployment asked for, and blocking it would refuse every render.
 *
 *     the FALLBACK             a cinematic render was attempted and did not deliver. An
 *                              authoritative timeline existed, its render failed, and the film
 *                              being handed over is a different composition than the one planned.
 *
 * Only the second is blocked. The existing pipeline already knows which it is — it carries the
 * cinematic refusal reason — and that fact was reaching a log line and nothing else.
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
  /** "cinematic_timeline" when the authoritative timeline's own render is being delivered. */
  route: "cinematic_timeline" | "legacy_compose";
  /**
   * Set when a cinematic render was ATTEMPTED and did not deliver. Null when none was attempted —
   * the difference between a fallback and a configured route, and the only input that tells them
   * apart.
   */
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

/* ═══════════════════════ the escape hatch, and its limits ═══════════════════════ */

/**
 * §10's development escape hatch, and the reason it is an environment variable and not a default.
 *
 * "A fallback may exist for development/debugging if explicitly requested, but it must never
 * silently become the production delivery path." Explicitly requested is what this is: off unless
 * someone sets it, and the gate says out loud when it is what let a delivery through, so a
 * deployment that left it on cannot mistake the result for a clean render.
 */
export function legacyFallbackDeliveryAllowed(): boolean {
  return process.env.ALLOW_LEGACY_COMPOSE_FALLBACK === "true";
}

/**
 * Was this delivery the FALLBACK, or the configured route?
 *
 * A cinematic refusal is the evidence: it exists only when a cinematic render was attempted and did
 * not deliver. With the cinematic path switched off no attempt is made, no refusal is recorded, and
 * compose is simply what this deployment renders with.
 */
export function isFallbackDelivery(input: {
  route: DeliveryGateInput["route"];
  cinematicRefusal?: string | null;
}): boolean {
  return input.route === "legacy_compose" && Boolean(input.cinematicRefusal?.trim());
}

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

  /* §10 — the authoritative render failed and something else is being handed over. */
  if (isFallbackDelivery(input)) {
    if (legacyFallbackDeliveryAllowed()) {
      lines.push(
        `[DeliveryGate] ${at} LEGACY_FALLBACK_ALLOWED — ALLOW_LEGACY_COMPOSE_FALLBACK is set, so a ` +
          `film the authoritative timeline did not render is being delivered on purpose: ` +
          `${input.cinematicRefusal}`
      );
    } else {
      failures.push({
        code: "AUTHORITATIVE_RENDER_FAILED",
        detail:
          `the cinematic timeline render did not deliver (${input.cinematicRefusal}), so the ` +
          `compose montage would be handed over in its place`,
      });
    }
  }

  /* §11 — an authoritative timeline must exist for a timeline render. */
  if (input.route === "cinematic_timeline" && !input.timelineExists) {
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

/* ═══════════════════════ the other production route ═══════════════════════ */

/**
 * THE CLIPS A COMPOSE RENDER ACTUALLY DELIVERED, AS THE GATE NEEDS TO SEE THEM.
 *
 * ── Why this exists beside the timeline path ────────────────────────────────────────────────
 *
 * Two routes in this codebase can publish a video, and only one of them has a `ProjectTimeline`:
 *
 *     cinematic_timeline   renderJobWorker → gate → upload → publish
 *     legacy_compose       the pipeline composes scene files directly, uploads, and completes
 *
 * The compose route never builds a timeline, so it has no `clip.source.archiveAssetId` to read.
 * Asking it for one would be asking for a document it does not produce — and leaving it ungated
 * would mean the invariant holds on one of the two routes that can hand a film to a viewer, which
 * is exactly the shape of defect this whole programme keeps removing.
 *
 * What it does have is the lineage ledger, and `record.finalVideoAt` is set only for the records
 * `markFinalVideo` proved out of the input list of the concat that produced the validated output.
 * That is a stronger list than a timeline: it is what the file is made of, rather than what it was
 * planned to be made of.
 *
 * ── What `resolved` and `fromArchive` mean here ─────────────────────────────────────────────
 *
 * `resolved` is true by construction: a record with `finalVideoAt` is in the delivered file, so
 * its bytes were read. There is nothing to rehydrate on this route and nothing to be unsure about.
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
