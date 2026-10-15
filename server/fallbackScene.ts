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
 * its planned length. When a sentence has no words to show (no text on the timeline), the bare colour
 * field still stands in — owner, 15 October: "er moet wel altijd een video uitkomen" — and the gate
 * names it an EMERGENCY placeholder (QUALITY_PROBLEM SYNTHETIC_PLACEHOLDER), never footage.
 */
import { ON_SCREEN_TEXT_STYLE, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { keyWordsIn, nameIn, phraseIn, yearIn } from "./animationFloor";
import { graphicIsRenderable } from "./graphicsVocabulary";
import { pictureCheckMissing } from "./deliveryGate";
import { sentenceCoverage } from "./sentenceCoverage";
import { SYNTHETIC_PLACEHOLDER_PROVIDER, syntheticAssetId } from "./genericFootageFallback";

export const FALLBACK_SCENE_ID_PREFIX = "gfx_fallback_";
/** G/H — past this share of a film's picture time the worker names the film MOSTLY_FALLBACK (a quality problem; it is still delivered). */
export const FALLBACK_SCENE_MAX_SHARE = 0.5;
const GROUND_ID = /_graphic\d+$/;

export type FallbackSceneResult = {
  /** Pictures that failed a mandatory check and were replaced by a fallback scene. */
  replaced: Array<{ clipId: string; sentence: string | null; slot: [number, number]; missing: string }>;
  /** Fallback scenes that got the sentence's words written on them. */
  captioned: Array<{ clipId: string; graphicId: string; text: string; graphicType: string }>;
  /** Fallback scenes left without words: no sentence text to show. Delivered as a named emergency placeholder. */
  withoutWords: string[];
  /** VIDEO 660 — sentences with no picture of their own that got a fallback scene of exactly their window. */
  carved: Array<{ sentence: string; clipId: string; slot: [number, number]; trimmed: string[] }>;
};

const visible = (c: TimelineVideoClip) =>
  !c.disabled && !GROUND_ID.test(c.id) && !(typeof c.transform?.opacity === "number" && c.transform.opacity <= 0);

export function isFallbackSceneClip(c: Pick<TimelineVideoClip, "source">): boolean {
  return c.source?.provider === SYNTHETIC_PLACEHOLDER_PROVIDER;
}

/**
 * The words a fallback scene shows: the sentence's year, else a name it says — and, under it, a short
 * phrase of the sentence's own key words (VIDEO 660: "ECB" alone on a coloured field said nothing; now
 * "ECB" over "LOOSENING MONETARY CONTROLS"). Without a year or name: its key words, else its first
 * words. Only the sentence's own words; nothing is added.
 */
export function fallbackSceneWords(
  text: string | null | undefined
): { graphicType: string; label: string; phrase?: string } | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const anchor = yearIn(t) ?? nameIn(t);
  if (anchor) {
    const phrase = phraseIn(t.split(anchor).join(","));
    /** a phrase that only repeats part of the anchor adds nothing */
    const adds = phrase && !anchor.toLowerCase().includes(phrase.toLowerCase());
    if (adds) return { graphicType: "lower_third", label: anchor, phrase };
    return { graphicType: yearIn(t) === anchor ? "date_card" : "label", label: anchor };
  }
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
  const out: FallbackSceneResult = { replaced: [], captioned: [], withoutWords: [], carved: [] };
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

  /* 1b — a sentence with no picture of its own gets its own fallback scene (VIDEO 660). */
  out.carved = carveScenesForSentencesWithoutPicture(timeline, log);

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
      log(`[FallbackScene] clip=${clip.id} ${keyOf(clip) ?? "no-sentence"} has NO words to show — the bare colour field stands in, named an emergency placeholder`);
      continue;
    }
    const graphicId = `${FALLBACK_SCENE_ID_PREFIX}${clip.id}`;
    /** A stored timeline may carry the track without its list; the list is the track's own field. */
    gfxTrack.graphics ??= [];
    gfxTrack.graphics.push({
      id: graphicId,
      graphicType: words.graphicType,
      label: words.label,
      data: {
        sceneIndex: clip.sceneIndex,
        beatIndex: clip.beatIndex,
        fallbackScene: true,
        ...(words.phrase ? { subtitle: words.phrase } : {}),
      },
      start: Number(a.toFixed(3)),
      end: Number(b.toFixed(3)),
      style: { ...ON_SCREEN_TEXT_STYLE },
      animation: "slide_up",
    });
    const shown = words.phrase ? `${words.label} — ${words.phrase}` : words.label;
    out.captioned.push({ clipId: clip.id, graphicId, text: shown, graphicType: words.graphicType });
    log(`[FallbackScene] clip=${clip.id} ${keyOf(clip) ?? "no-sentence"} words="${shown}" (${words.graphicType}) — fallback scene, not footage`);
  }
  return out;
}

const MIN_PIECE_SEC = 0.1;
/**
 * VIDEO 660 — render 69 left 0.33 s of a neighbour's held frame (72.26–72.59) between the fallback
 * scene and the next shot: a flash. A remainder the carve itself cuts off that is shorter than this
 * is not kept; the fallback scene runs over it instead. A remainder that is the own picture of the
 * sentence it lies in stays, however short — and a short shot the carve did not cut is never touched.
 */
export const CARVE_FLASH_SEC = 0.75;

/**
 * VIDEO 660 — a sentence the strict delivery check would refuse because NO picture of its own is on
 * screen (only a neighbour's picture held over it, or nothing at all) gets a fallback scene of exactly
 * its spoken window. The neighbour's picture stops where the sentence starts and, if it ran past the
 * sentence, goes on after it; a neighbour's piece left shorter than 0.1 s is switched off (named),
 * and one left shorter than `CARVE_FLASH_SEC` that is no sentence's own picture there goes to the
 * fallback scene. Same rule as the gate: a sentence under its own card, picture or stand-in is left alone.
 */
export function carveScenesForSentencesWithoutPicture(
  timeline: ProjectTimeline,
  log: (line: string) => void = () => undefined
): FallbackSceneResult["carved"] {
  const out: FallbackSceneResult["carved"] = [];
  const track = timeline.tracks.find((t) => t.kind === "VIDEO");
  if (track?.kind !== "VIDEO") return out;
  const rows = sentenceCoverage(timeline).sentences;
  /** The remainder [a, b) of `c` is the own picture of a sentence spoken there. */
  const ownPictureThere = (c: TimelineVideoClip, a: number, b: number) =>
    rows.some(
      (r) =>
        r.sceneIndex === c.sceneIndex &&
        r.beatIndex === c.beatIndex &&
        r.startSec != null &&
        r.endSec != null &&
        Math.min(b, r.endSec) - Math.max(a, r.startSec) > 0.01
    );
  /** A remainder the carve cut off that would only flash: shorter than `CARVE_FLASH_SEC` and no sentence's own picture. */
  const flash = (c: TimelineVideoClip, a: number, b: number) =>
    b - a > 0.001 && b - a < CARVE_FLASH_SEC && !ownPictureThere(c, a, b);
  for (const row of rows) {
    if (row.status !== "uncovered" || row.spokenSec == null || row.startSec == null || row.endSec == null) continue;
    const standIn = Math.max(row.fallbackSceneSec ?? 0, row.syntheticPlaceholderSec ?? 0);
    if (row.coveredSec + row.cardSec + standIn >= row.spokenSec - 0.05) continue;
    const lo = row.startSec;
    const hi = row.endSec;
    if (hi - lo < MIN_PIECE_SEC) continue;
    const trimmed: string[] = [];
    const added: TimelineVideoClip[] = [];
    /** The fallback scene's own slot: the sentence, plus any flash it took over. */
    let sceneLo = lo;
    let sceneHi = hi;
    for (const c of track.clips) {
      if (c.disabled || c.timelineEnd <= lo + 0.001 || c.timelineStart >= hi - 0.001) continue;
      const start = c.timelineStart;
      const end = c.timelineEnd;
      const rate = c.still ? 0 : (c.speed ?? 1);
      const headFlash = start < lo && flash(c, start, lo);
      const tailFlash = end > hi && flash(c, hi, end);
      if (headFlash) sceneLo = Math.min(sceneLo, start);
      if (tailFlash) sceneHi = Math.max(sceneHi, end);
      if ((start >= lo || headFlash) && (end <= hi || tailFlash)) {
        /** nothing of it is left but flashes: the fallback scene takes all of it */
        c.disabled = true;
        trimmed.push(
          start < lo || end > hi
            ? `${c.id} would leave only ${(Math.max(0, lo - start) + Math.max(0, end - hi)).toFixed(2)}s — under ${CARVE_FLASH_SEC}s, the fallback scene takes it`
            : `${c.id} (inside the sentence, another sentence's picture) switched off`
        );
        continue;
      }
      if (headFlash) {
        /** only its tail after the sentence is kept */
        if (typeof c.sourceIn === "number") c.sourceIn = Number((c.sourceIn + (hi - start) * rate).toFixed(3));
        if (typeof c.sourceIn === "number" && typeof c.sourceOut === "number" && c.sourceOut <= c.sourceIn) {
          c.sourceIn = Math.max(0, c.sourceOut - 0.04);
          c.holdAtSourceOut = true;
        }
        c.timelineStart = Number(hi.toFixed(3));
        c.transitionIn = "hard_cut";
        trimmed.push(`${c.id} starts at ${hi.toFixed(2)}s; its ${(lo - start).toFixed(2)}s before the sentence goes to the fallback scene`);
        continue;
      }
      if (tailFlash) {
        /** only its head before the sentence is kept */
        c.timelineEnd = Number(lo.toFixed(3));
        c.transitionOut = "hard_cut";
        trimmed.push(`${c.id} ends at ${lo.toFixed(2)}s; its ${(end - hi).toFixed(2)}s after the sentence goes to the fallback scene`);
        if (c.timelineEnd - c.timelineStart < MIN_PIECE_SEC) {
          c.disabled = true;
          trimmed.push(`${c.id} left shorter than ${MIN_PIECE_SEC}s — switched off`);
        }
        continue;
      }
      if (start < lo && end > hi) {
        /** the neighbour runs through the sentence: its head stays before it, its tail goes on after it */
        const tail: TimelineVideoClip = JSON.parse(JSON.stringify(c));
        tail.id = `${c.id}_after_${row.key}`;
        tail.timelineStart = Number(hi.toFixed(3));
        if (typeof tail.sourceIn === "number") tail.sourceIn = Number((tail.sourceIn + (hi - start) * rate).toFixed(3));
        if (typeof tail.sourceIn === "number" && typeof tail.sourceOut === "number" && tail.sourceOut <= tail.sourceIn) {
          /** past its source already: the tail holds the last frame, as the whole clip did */
          tail.sourceIn = Math.max(0, tail.sourceOut - 0.04);
          tail.holdAtSourceOut = true;
        }
        tail.transitionIn = "hard_cut";
        if (end - hi >= MIN_PIECE_SEC) added.push(tail);
        c.timelineEnd = Number(lo.toFixed(3));
        c.transitionOut = "hard_cut";
        trimmed.push(`${c.id} split around the sentence`);
      } else if (start < lo) {
        c.timelineEnd = Number(lo.toFixed(3));
        c.transitionOut = "hard_cut";
        trimmed.push(`${c.id} ends at ${lo.toFixed(2)}s`);
      } else if (end > hi) {
        if (typeof c.sourceIn === "number") c.sourceIn = Number((c.sourceIn + (hi - start) * rate).toFixed(3));
        if (typeof c.sourceIn === "number" && typeof c.sourceOut === "number" && c.sourceOut <= c.sourceIn) {
          c.sourceIn = Math.max(0, c.sourceOut - 0.04);
          c.holdAtSourceOut = true;
        }
        c.timelineStart = Number(hi.toFixed(3));
        c.transitionIn = "hard_cut";
        trimmed.push(`${c.id} starts at ${hi.toFixed(2)}s`);
      } else {
        c.disabled = true;
        trimmed.push(`${c.id} (inside the sentence, another sentence's picture) switched off`);
        continue;
      }
      if (c.timelineEnd - c.timelineStart < MIN_PIECE_SEC) {
        c.disabled = true;
        trimmed.push(`${c.id} left shorter than ${MIN_PIECE_SEC}s — switched off`);
      }
    }
    const scene: TimelineVideoClip = {
      id: `vc_fallback_${row.key}`,
      kind: "video",
      source: { provider: "synthetic_placeholder" },
      timelineStart: Number(sceneLo.toFixed(3)),
      timelineEnd: Number(sceneHi.toFixed(3)),
      motion: "none",
      transitionIn: "hard_cut",
      transitionOut: "hard_cut",
      previewSource: "asset",
      sceneIndex: row.sceneIndex,
      beatIndex: row.beatIndex,
    } as TimelineVideoClip;
    toFallbackScene(scene);
    track.clips.push(scene, ...added);
    track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    out.push({ sentence: row.key, clipId: scene.id, slot: [sceneLo, sceneHi], trimmed });
    log(
      `[FallbackScene] ${row.key} slot=${sceneLo.toFixed(2)}-${sceneHi.toFixed(2)}s had NO picture of its own (${(row.reasons ?? []).join("; ") || "nothing on screen"}) — ` +
        `a fallback scene of exactly this sentence (not footage)${trimmed.length ? `; ${trimmed.join("; ")}` : ""}`
    );
  }
  return out;
}
