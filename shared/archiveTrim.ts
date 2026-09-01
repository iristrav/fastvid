/**
 * RONDE 108 — one definition of "is this a trim we can actually perform".
 *
 * The rule lived in server/archiveTrimToScene.ts, where the browser cannot reach it. So the trim
 * panel in the archive offered its "Bijknippen toepassen" button for ranges the server was always
 * going to refuse — the operator clicked, waited, and got a message about a range they could not
 * see was wrong. The button was there and it did not work, which is exactly how it was reported.
 *
 * The check is pure arithmetic over two numbers and a duration. It belongs where both sides can
 * ask it, so the panel can grey the button out and SAY why before anything is sent, and the
 * server can still refuse independently — a UI check is a courtesy, never a guarantee.
 */

/** A trimmed clip shorter than this is not footage, it is an accident. */
export const MIN_TRIMMED_CLIP_SEC = 0.5;

export type ArchiveTrimRange = {
  /** Seconds into the source where the kept footage begins. 0 keeps the head. */
  startSec?: number;
  /** Seconds into the source where the kept footage ends. Omitted keeps the tail. */
  endSec?: number;
};

export type TrimRangeVerdict =
  | { ok: true; startSec: number; endSec: number }
  | { ok: false; reason: string };

/**
 * Validate a requested range against the clip's own duration.
 *
 * Returns the reason as a string rather than throwing, because every one of these is an operator
 * mistake the UI should show, not a server fault.
 */
export function validateTrimRange(
  range: ArchiveTrimRange,
  sourceDurationSec: number
): TrimRangeVerdict {
  const start = Math.max(0, range.startSec ?? 0);
  const end = range.endSec ?? sourceDurationSec;
  if (!(end > 0)) return { ok: false, reason: "Eindpunt moet groter dan nul zijn" };
  if (end <= start) return { ok: false, reason: "Eindpunt moet ná het startpunt liggen" };
  if (end - start < MIN_TRIMMED_CLIP_SEC) {
    return { ok: false, reason: `De clip zou korter worden dan ${MIN_TRIMMED_CLIP_SEC}s` };
  }
  if (sourceDurationSec > 0 && start >= sourceDurationSec - 0.05) {
    return { ok: false, reason: "Startpunt ligt op of voorbij het einde van de clip" };
  }
  // A trim that changes nothing is refused rather than silently re-encoding the file: it would
  // move the asset to a new storage key for no reason.
  if (sourceDurationSec > 0 && start <= 0.05 && end >= sourceDurationSec - 0.05) {
    return { ok: false, reason: "Dit bereik is de hele clip — er valt niets bij te knippen" };
  }
  return { ok: true, startSec: start, endSec: Math.min(end, sourceDurationSec || end) };
}
