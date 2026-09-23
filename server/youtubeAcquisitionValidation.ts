/**
 * A FILE THAT ARRIVED IS NOT YET A VIDEO — RONDE 643.
 *
 * The cloud route renames the service's response straight into the beat's clip file. Until now the
 * only thing checked on the way was its size: more than 10 000 bytes, and it counted as a download
 * that succeeded. The RapidAPI route re-encodes through `trimRemoteVideoToClip`, where ffmpeg would
 * have refused a broken file; the cloud route never passes through it, and the shared technical gate
 * deliberately lets an UNMEASURED file through ("no data" is not "bad data" there).
 *
 * For a file this system just received from a third party, unmeasured is the one case that must
 * not pass. So before it is accepted it is asked, by ffprobe and by decoding one real frame:
 *
 *   NO_VIDEO_STREAM     ffprobe found no video stream, or could not read the container
 *   INVALID_DIMENSIONS  a video stream with no width or height
 *   DURATION_TOO_SHORT  shorter than half of what was asked for (a stub, a truncated transfer)
 *   CORRUPT_FILE        the container reads but no frame decodes
 *
 * A refusal here is a failed attempt on this route with its reason attached, and the next route is
 * tried exactly as after any other failure. Never a success, never silent.
 */

export type AcquiredFileVerdict =
  | { ok: true; width: number; height: number; durationSec: number }
  | {
      ok: false;
      code: "NO_VIDEO_STREAM" | "INVALID_DIMENSIONS" | "DURATION_TOO_SHORT" | "CORRUPT_FILE";
      detail: string;
    };

/** The shortest acceptable file for a request of `requestedSec`: half of it, and never under 1s. */
export function minimumAcquiredDurationSec(requestedSec: number): number {
  return Math.max(1, (Number.isFinite(requestedSec) && requestedSec > 0 ? requestedSec : 0) * 0.5);
}

/** Pure: every fact is measured by the caller. */
export function judgeAcquiredFile(p: {
  meta: { width: number; height: number; durationSec: number } | null;
  requestedSec: number;
  frameDecoded: boolean;
}): AcquiredFileVerdict {
  if (!p.meta) return { ok: false, code: "NO_VIDEO_STREAM", detail: "ffprobe found no readable video stream" };
  const { width, height, durationSec } = p.meta;
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, code: "INVALID_DIMENSIONS", detail: `${width}x${height}` };
  }
  const floor = minimumAcquiredDurationSec(p.requestedSec);
  if (!(durationSec >= floor)) {
    return {
      ok: false,
      code: "DURATION_TOO_SHORT",
      detail: `${Number.isFinite(durationSec) ? durationSec.toFixed(2) : "unknown"}s < ${floor.toFixed(2)}s`,
    };
  }
  if (!p.frameDecoded) return { ok: false, code: "CORRUPT_FILE", detail: "no frame decoded at the midpoint" };
  return { ok: true, width, height, durationSec };
}

/** The same judgement against a real file, with the measurements injected so a test can supply them. */
export async function validateAcquiredFile(
  filePath: string,
  requestedSec: number,
  deps: {
    probe: (p: string) => Promise<{ width: number; height: number; durationSec: number } | null>;
    decodeFrame: (p: string) => Promise<boolean>;
  }
): Promise<AcquiredFileVerdict> {
  const meta = await deps.probe(filePath).catch(() => null);
  const early = judgeAcquiredFile({ meta, requestedSec, frameDecoded: true });
  /** No frame is decoded from a file that has already failed on its container. */
  if (!early.ok) return early;
  const frameDecoded = await deps.decodeFrame(filePath).catch(() => false);
  return judgeAcquiredFile({ meta, requestedSec, frameDecoded });
}
