/**
 * G/H — THE FALLBACK SCENE: A PICTURE THAT FAILED ITS CHECKS IS NEVER SHOWN, AND ITS SLOT IS NEVER LOST.
 *
 * The owner's decisions (15 October):
 *   1. "Replace, then strict" — a picture in a pipeline film that does not show BOTH mandatory checks
 *      (the picture editor's approval for its sentence, and a passed text check) is replaced before
 *      the render by the fallback scene; the delivery gate then refuses any unchecked picture that is
 *      still there. Checks are never skipped and a refused source is never marked approved.
 *   2. "Text scene in brand colours" — the fallback scene is the locally drawn colour field (brand
 *      violet and warm palettes, never blue or grey: `SYNTHETIC_PALETTES`) with the sentence's own
 *      words on it, bottom left at the normal text size. Free (ffmpeg, no provider), always named a
 *      fallback in the log and the report, never presented as footage.
 *
 * Exactly the slot of the picture it replaces: same start, same end, same sentence. The film keeps
 * its planned length. When a sentence has no words to show (no text on the timeline), no scene is
 * made and the gate's strict rule blocks the delivery — a person has to act.
 */
import { ON_SCREEN_TEXT_STYLE, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { keyWordsIn, nameIn, yearIn } from "./animationFloor";
import { graphicIsRenderable } from "./graphicsVocabulary";
import { pictureCheckMissing } from "./deliveryGate";
import { SYNTHETIC_PLACEHOLDER_PROVIDER, syntheticAssetId } from "./genericFootageFallback";

export const FALLBACK_SCENE_ID_PREFIX = "gfx_fallback_";
/** G/H — the most of a film's picture time fallback scenes may fill; past it a person decides. */
export const FALLBACK_SCENE_MAX_SHARE = 0.5;
const GROUND_ID = /_graphic\d+$/;

export type FallbackSceneResult = {
  /** Pictures that failed a mandatory check and were replaced by a fallback scene. */
  replaced: Array<{ clipId: string; sentence: string | null; slot: [number, number]; missing: string }>;
  /** Fallback scenes that got the sentence's words written on them. */
  captioned: Array<{ clipId: string; graphicId: string; text: string; graphicType: string }>;
  /** Fallback scenes left without words: no sentence text to show. The strict gate blocks these. */
  withoutWords: string[];
};

const visible = (c: TimelineVideoClip) =>
  !c.disabled && !GROUND_ID.test(c.id) && !(typeof c.transform?.opacity === "number" && c.transform.opacity <= 0);

export function isFallbackSceneClip(c: Pick<TimelineVideoClip, "source">): boolean {
  return c.source?.provider === SYNTHETIC_PLACEHOLDER_PROVIDER;
}

/** The words a fallback scene shows: the sentence's year, else a name it says, else its key words, else its first words. */
export function fallbackSceneWords(text: string | null | undefined): { graphicType: string; label: string } | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const year = yearIn(t);
  if (year) return { graphicType: "date_card", label: year };
  const name = nameIn(t);
  if (name) return { graphicType: "label", label: name };
  const key = keyWordsIn(t);
  if (key) return { graphicType: "emphasis", label: key };
  const first = t.replace(/[.,;:!?"“”()]/g, " ").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  return first ? { graphicType: "emphasis", label: first } : null;
}

/**
 * Turns one clip into a fallback scene of exactly its slot: a new identity (the drawn colour field),
 * never an edited approval — the refused picture's marks leave with it. Returns what it was.
 */
export function toFallbackScene(clip: TimelineVideoClip): string {
  const dur = Math.max(0.1, clip.timelineEnd - clip.timelineStart);
  const seed = (clip.sceneIndex ?? 0) * 7 + (clip.beatIndex ?? 0);
  const was = `${clip.source.provider}:${clip.source.providerAssetId ?? "?"}`;
  clip.kind = "video";
  clip.source = {
    provider: SYNTHETIC_PLACEHOLDER_PROVIDER,
    providerAssetId: syntheticAssetId(seed, dur),
    contentApproval: "generic_footage",
    title: "FastVid fallback scene (not footage)",
  };
  clip.sourceIn = 0;
  clip.sourceOut = Number(dur.toFixed(3));
  clip.motion = "none";
  delete clip.camera;
  delete clip.holdAtSourceOut;
  return was;
}

/**
 * G/H — a picture of a pipeline film whose file could not be recovered keeps its slot as a fallback
 * scene, drawn locally (`draw`), instead of leaving the film short. A scene that cannot be drawn
 * stays a failure: the clip is then dropped and the duration check refuses the file, as before.
 */
export async function rescueMissingPictures<F extends { clipId: string }>(params: {
  timeline: ProjectTimeline;
  failures: readonly F[];
  byClipId: Map<string, string>;
  draw: (clip: TimelineVideoClip) => Promise<string | null>;
  log?: (line: string) => void;
}): Promise<{ remaining: F[]; rescued: string[] }> {
  const say = params.log ?? (() => undefined);
  const remaining: F[] = [];
  const rescued: string[] = [];
  const clips = params.timeline.tracks.flatMap((t) => (t.kind === "VIDEO" ? t.clips : []));
  for (const f of params.failures) {
    const clip = clips.find((c) => c.id === f.clipId);
    if (!clip || !visible(clip)) {
      remaining.push(f);
      continue;
    }
    const was = isFallbackSceneClip(clip) ? "fallback scene" : toFallbackScene(clip);
    const file = await params.draw(clip).catch(() => null);
    if (!file) {
      remaining.push(f);
      say(`[FallbackScene] clip=${clip.id} file of ${was} missing AND the fallback scene could not be drawn — the clip is dropped; the duration check decides`);
      continue;
    }
    params.byClipId.set(clip.id, file);
    rescued.push(clip.id);
    say(
      `[FallbackScene] clip=${clip.id} slot=${clip.timelineStart.toFixed(2)}-${clip.timelineEnd.toFixed(2)}s ` +
        `file of ${was} could not be recovered — fallback scene drawn for exactly this slot (not footage)`
    );
  }
  return { remaining, rescued };
}

/**
 * Applies both decisions to a pipeline film's timeline, in place, before it is rendered:
 * every visible picture without both checks becomes a fallback scene of the same slot, and every
 * fallback scene gets its sentence's words unless text is already on screen there.
 */
export function applyFallbackScenes(timeline: ProjectTimeline, log: (line: string) => void = () => undefined): FallbackSceneResult {
  const out: FallbackSceneResult = { replaced: [], captioned: [], withoutWords: [] };
  const videoTrack = timeline.tracks.find((t) => t.kind === "VIDEO");
  if (videoTrack?.kind !== "VIDEO") return out;
  const sentenceOf = (c: { sceneIndex?: number; beatIndex?: number }) =>
    (timeline.sentences ?? []).find((s) => s.sceneIndex === c.sceneIndex && s.beatIndex === c.beatIndex) ?? null;
  const keyOf = (c: { sceneIndex?: number; beatIndex?: number }) =>
    typeof c.sceneIndex === "number" && typeof c.beatIndex === "number" ? `s${c.sceneIndex}b${c.beatIndex}` : null;

  /* 1 — replace: the one authority for "both checks shown" is the gate's own `pictureCheckMissing`. */
  for (const clip of videoTrack.clips) {
    if (!visible(clip) || isFallbackSceneClip(clip)) continue;
    const missing = pictureCheckMissing({
      isPlaceholder: false,
      hidden: false,
      contentApproval: clip.source.contentApproval ?? null,
      textCheck: clip.source.textCheck ?? null,
    });
    if (!missing) continue;
    const was = toFallbackScene(clip);
    out.replaced.push({ clipId: clip.id, sentence: keyOf(clip), slot: [clip.timelineStart, clip.timelineEnd], missing });
    log(
      `[FallbackScene] clip=${clip.id} ${keyOf(clip) ?? "no-sentence"} slot=${clip.timelineStart.toFixed(2)}-${clip.timelineEnd.toFixed(2)}s ` +
        `REPLACED ${was} — ${missing}; a fallback scene takes exactly its slot (not footage)`
    );
  }

  /* 2 — words: every visible fallback scene shows its sentence's words, unless text is already there. */
  const gfxTrack = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  const onScreen = (): Array<{ start: number; end: number }> =>
    timeline.tracks.flatMap((t): Array<{ start: number; end: number }> =>
      t.kind === "GRAPHICS" ? (t.graphics ?? []).filter((g) => !g.disabled) : t.kind === "TEXT" ? (t.texts ?? []).filter((x) => !x.disabled) : []
    );
  for (const clip of videoTrack.clips) {
    if (!visible(clip) || !isFallbackSceneClip(clip)) continue;
    const a = clip.timelineStart;
    const b = clip.timelineEnd;
    if (onScreen().some((g) => g.start < b - 0.05 && g.end > a + 0.05)) continue;
    const words = fallbackSceneWords(sentenceOf(clip)?.text);
    if (!words || gfxTrack?.kind !== "GRAPHICS" || !graphicIsRenderable(words.graphicType, {}, words.label)) {
      out.withoutWords.push(clip.id);
      log(`[FallbackScene] clip=${clip.id} ${keyOf(clip) ?? "no-sentence"} has NO words to show — the strict delivery check will refuse it`);
      continue;
    }
    const graphicId = `${FALLBACK_SCENE_ID_PREFIX}${clip.id}`;
    /** A stored timeline may carry the track without its list; the list is the track's own field. */
    gfxTrack.graphics ??= [];
    gfxTrack.graphics.push({
      id: graphicId,
      graphicType: words.graphicType,
      label: words.label,
      data: { sceneIndex: clip.sceneIndex, beatIndex: clip.beatIndex, fallbackScene: true },
      start: Number(a.toFixed(3)),
      end: Number(b.toFixed(3)),
      style: { ...ON_SCREEN_TEXT_STYLE },
      animation: "slide_up",
    });
    out.captioned.push({ clipId: clip.id, graphicId, text: words.label, graphicType: words.graphicType });
    log(`[FallbackScene] clip=${clip.id} ${keyOf(clip) ?? "no-sentence"} words="${words.label}" (${words.graphicType}) — fallback scene, not footage`);
  }
  return out;
}
