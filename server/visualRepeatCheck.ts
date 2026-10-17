/**
 * VIDEO 661 — THE SAME PICTURE IS NOT SHOWN TWICE, EVEN WHEN IT COMES FROM TWO DIFFERENT FILES.
 *
 * Render 70 (video 661) showed one static book page from a single YouTube video three times: two
 * archive assets (61476, 61477) cut from it at different moments and the raw clip itself. VIDEO 656's
 * `removeRepeatedFootage` compares asset identity and source seconds, so three files with three
 * identities and three different windows passed it — and the page did not move, so every window
 * looked the same. The contact sheet saw it only after delivery (REPEATS=11).
 *
 * So, before the timeline is built, each placed clip is looked at the way the contact sheet looks at
 * the film: one 9×8 grey frame per second (at most `MAX_PRINTS_PER_CLIP`), each a 64-bit difference
 * hash (`fingerprintOf`). A later clip whose non-flat frames match an earlier clip's frames for at
 * least half of the shorter of the two (`SAME_PICTURE_BITS`) is the same picture again. It is taken
 * out of its sentence, and the rungs that follow (generated picture, generic footage, the rest of
 * the sentence) look for another picture — the owner's rule: no repeat, a different picture.
 *
 * Near-flat frames (black, a plain ground) are never compared: they look alike without being the same
 * footage. A clip that could not be read is kept: this check never takes a picture out on a guess.
 */
import { execFile } from "child_process";

import { fingerprintsFromRaw, hammingBits, SAME_PICTURE_BITS, type FrameFingerprint } from "./contactSheet";

/** Clips are short (≤ 11 s); a still gives one frame. */
export const MAX_PRINTS_PER_CLIP = 12;

/** How many of `a`'s non-flat frames look like one of `b`'s. */
function matchingPrints(a: readonly FrameFingerprint[], b: readonly FrameFingerprint[]): number {
  const bLive = b.filter((p) => !p.flat);
  let n = 0;
  for (const p of a) {
    if (p.flat) continue;
    if (bLive.some((q) => hammingBits(p.hash, q.hash) <= SAME_PICTURE_BITS)) n++;
  }
  return n;
}

/**
 * Whether two clips show the same picture: at least half of the shorter clip's non-flat frames
 * (and at least one) match a frame of the other. A clip with no non-flat frame matches nothing.
 */
export function sameLookingClips(a: readonly FrameFingerprint[], b: readonly FrameFingerprint[]): boolean {
  const aLive = a.filter((p) => !p.flat).length;
  const bLive = b.filter((p) => !p.flat).length;
  if (aLive === 0 || bLive === 0) return false;
  const [short, long] = aLive <= bLive ? [a, b] : [b, a];
  const need = Math.max(1, Math.ceil(Math.min(aLive, bLive) / 2));
  return matchingPrints(short, long) >= need;
}

/**
 * VIDEO 662 — two moments of the SAME source video are held to a looser bar. Render 72 showed one
 * boulevard twice (YouTube uOqcqEiSTPE at 30 s and at 149 s, archive 61544 and 61548): different
 * windows, the same street, frames close but not near-identical, so the strict rule let them both
 * through and the contact sheet counted REPEATS=9 after delivery. Within one source, one pair of
 * frames within `SAME_SOURCE_PICTURE_BITS` is the same picture again.
 */
export const SAME_SOURCE_PICTURE_BITS = 12;

export type RepeatCandidate = {
  id: string;
  prints: readonly FrameFingerprint[] | null;
  /** The source the clip was cut from (a YouTube video, an archive item); null when unknown. */
  family?: string | null;
  /** VIDEO 663 — the seconds of that source the clip shows, when the render recorded its cut. */
  window?: { start: number; end: number } | null;
  /** VIDEO 663 — the sentence the clip stands under (`scene:beat`). */
  sentence?: string | null;
};

/** Within one source: any pair of non-flat frames within `SAME_SOURCE_PICTURE_BITS`. */
export function sameSourceLooksAlike(a: readonly FrameFingerprint[], b: readonly FrameFingerprint[]): boolean {
  return a.some((p) => !p.flat && b.some((q) => !q.flat && hammingBits(p.hash, q.hash) <= SAME_SOURCE_PICTURE_BITS));
}

/**
 * In film order: every clip that shows the same picture as a clip before it that was kept. A clip
 * without prints (unreadable) is never a repeat and is never compared against.
 */
/**
 * VIDEO 663 — two moments of one source video less than this far apart show the same people in the
 * same place: render 73 showed one Venice walk at 19–24 s and again, cropped and recoloured, at
 * 31.5–35 s. Its pixels no longer matched (`SAME_SOURCE_PICTURE_BITS`); its seconds in the video did.
 */
export const SAME_SOURCE_NEAR_SEC = 15;

/** Do two windows of one source overlap or lie closer than `SAME_SOURCE_NEAR_SEC`? */
export function sourceWindowsNear(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const gap = Math.max(a.start, b.start) - Math.min(a.end, b.end);
  return gap < SAME_SOURCE_NEAR_SEC;
}

export function findVisualRepeats(items: readonly RepeatCandidate[]): Array<{ id: string; sameAs: string }> {
  const kept: Array<{ id: string; prints: readonly FrameFingerprint[] | null; family: string | null; window: RepeatCandidate["window"]; sentence: string | null }> = [];
  const out: Array<{ id: string; sameAs: string }> = [];
  for (const it of items) {
    const family = it.family ?? null;
    const sentence = it.sentence ?? null;
    const hasPrints = Boolean(it.prints && it.prints.length > 0);
    const earlier = kept.find(
      (k) =>
        (hasPrints && k.prints && k.prints.length > 0 && sameLookingClips(it.prints!, k.prints)) ||
        (hasPrints && family != null && k.family === family && k.prints && k.prints.length > 0 && sameSourceLooksAlike(it.prints!, k.prints)) ||
        /**
         * VIDEO 663 — the same source, nearly the same seconds, under ANOTHER sentence. Within one
         * sentence the next moment of the same scene is its continuation (`coverRestOfSentences`).
         */
        (family != null && k.family === family && it.window != null && k.window != null &&
          sentence != null && k.sentence != null && sentence !== k.sentence && sourceWindowsNear(it.window, k.window))
    );
    if (earlier) {
      out.push({ id: it.id, sameAs: earlier.id });
      continue;
    }
    if (hasPrints || it.window) kept.push({ id: it.id, prints: it.prints ?? null, family, window: it.window, sentence });
  }
  return out;
}

/** One grey 9×8 frame per second of the file, at most `MAX_PRINTS_PER_CLIP`. Null when it cannot be read. */
export async function fingerprintClipFile(filePath: string, ffmpegBin: string, timeoutMs = 30_000): Promise<FrameFingerprint[] | null> {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-threads", "1",
    "-i", filePath,
    "-vf", "fps=1,scale=9:8:flags=area,format=gray",
    "-frames:v", String(MAX_PRINTS_PER_CLIP),
    "-f", "rawvideo", "pipe:1",
  ];
  const raw = await new Promise<Buffer | null>((resolve) => {
    execFile(ffmpegBin, args, { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: timeoutMs }, (err, stdout) =>
      resolve(err ? null : (stdout as Buffer))
    );
  });
  if (!raw || raw.length === 0) return null;
  const prints = fingerprintsFromRaw(new Uint8Array(raw), 1);
  return prints.length ? prints : null;
}
