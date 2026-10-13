/**
 * VIDEO 652 — ONE YOUTUBE VIDEO DOES NOT SPEND A SENTENCE'S LOOKS ON ITSELF.
 *
 * s1b4 ("Was this meteoric rise Elon Musk's ultimate triumph…") was offered four moments of one
 * video ("video of lotus 30 mk 1 chassis 12"), one after another; the picture editor refused each
 * of them (a 1970s Lotus race), and those four refusals took four of the sentence's five looks. The
 * nine moments of the Musk and Tesla videos that were ready for it were never looked at
 * (`BEAT_LOOK_CEILING`), and the sentence ended on a colour field.
 *
 * Every moment is still its own candidate and is judged on its own (a documentary has interviews,
 * factory floors and archive in one file, and one moment can be refused for text on screen). But
 * once TWO moments of the same video were refused for this sentence, the video has answered for it:
 * its other moments are not judged for this sentence, and the looks go to other sources. Per
 * sentence, per video; other sentences are not touched.
 */

/** Moments of one video a sentence refuses before that video's other moments are no longer judged for it. */
export const SAME_VIDEO_REFUSALS_PER_SENTENCE = 2;

/** The video a YouTube moment's content key belongs to (`youtube_cc:<id>@t…d…` → `youtube_cc:<id>`), or null. */
export function youtubeSourceOfKey(contentKey: string | null | undefined): string | null {
  if (!contentKey?.startsWith("youtube_cc:")) return null;
  const at = contentKey.indexOf("@");
  return at > 0 ? contentKey.slice(0, at) : contentKey;
}

/** The refusals one sentence's turn has counted per YouTube video. */
export type SameVideoRefusals = Map<string, number>;

/** A moment of this content key was refused for the sentence by the picture editor. */
export function noteSameVideoRefusal(refusals: SameVideoRefusals, contentKey: string | null | undefined): void {
  const source = youtubeSourceOfKey(contentKey);
  if (source) refusals.set(source, (refusals.get(source) ?? 0) + 1);
}

/** True when this moment's video already had enough moments refused for this sentence. */
export function sameVideoRefusedEnough(
  refusals: SameVideoRefusals,
  contentKey: string | null | undefined,
  limit = SAME_VIDEO_REFUSALS_PER_SENTENCE
): boolean {
  const source = youtubeSourceOfKey(contentKey);
  return source != null && (refusals.get(source) ?? 0) >= limit;
}
