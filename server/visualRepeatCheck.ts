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

export type RepeatCandidate = { id: string; prints: readonly FrameFingerprint[] | null };

/**
 * In film order: every clip that shows the same picture as a clip before it that was kept. A clip
 * without prints (unreadable) is never a repeat and is never compared against.
 */
export function findVisualRepeats(items: readonly RepeatCandidate[]): Array<{ id: string; sameAs: string }> {
  const kept: Array<{ id: string; prints: readonly FrameFingerprint[] }> = [];
  const out: Array<{ id: string; sameAs: string }> = [];
  for (const it of items) {
    if (!it.prints || it.prints.length === 0) continue;
    const earlier = kept.find((k) => sameLookingClips(it.prints!, k.prints));
    if (earlier) {
      out.push({ id: it.id, sameAs: earlier.id });
      continue;
    }
    kept.push({ id: it.id, prints: it.prints });
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
