/**
 * RONDE 144 — the renderer that turns a timeline into an MP4.
 *
 * ── The rule this module exists to keep ──────────────────────────────────────────────────────
 *
 * THE RENDERER MAKES NO DECISIONS. §11.
 *
 * Everything about the finished picture is read from the timeline: which clip, when, how long,
 * what text, what size, what level. Nothing is chosen here, nothing is random, nothing is looked
 * up. Render the same timeline twice and you get the same edit — which is not a nice property but
 * the whole basis of an editor: a user who changes one word and re-renders must get their video
 * back with one word changed, not a different video that also has the new word.
 *
 * The existing pipeline decides. This executes. That separation is the reason this is a new file
 * rather than another branch inside `composeSceneVideo`, whose job is to compose the OUTPUT of a
 * set of decisions being made around it.
 *
 * ── What v1 does and does not do ─────────────────────────────────────────────────────────────
 *
 * Does: video clips with in/out points, absolute placement, scale-and-pad to the timeline format,
 * hard cuts, crossfades, text overlays, captions, a voice track, a music track with a fixed gain,
 * effect clips, fades.
 *
 * Does not: Ken Burns motion (the timeline carries the field and the renderer ignores it), the
 * remaining transition families, per-clip crop and position, sidechain ducking. Each is listed in
 * `UNIMPLEMENTED` below and reported by the render, so a timeline asking for one is answered with
 * "not yet" rather than with silence. A renderer that quietly drops half of its input is worse
 * than one that says what it skipped.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { resolveFFmpegBin } from "./ffmpegBinary";
import {
  DEFAULT_TEXT_STYLE,
  audioTrackOf,
  captionTrack,
  graphicsTrack,
  graphicsWithLabels,
  textTrackOf,
  videoTrack,
  type ProjectTimeline,
  type TextStyle,
  type AssetSourceIdentity,
  type TimelineLook,
  type TimelineVideoClip,
} from "./projectTimeline";
import { docGradeSourceKindForProvider } from "./documentaryStyle";
import {
  buildAudioGraph,
  buildTransitionGraph,
  buildVideoFilter,
  cameraChain,
  lookUnsupportedReason,
  transitionIsRenderable,
  unsupportedEffects,
  type MixInput,
} from "./timelineFilters";

const execFileAsync = promisify(execFile);
/**
 * RONDE 146 — the SHARED resolution, not `ffmpeg-static` straight from the package.
 *
 * This module used to take the bundled binary unconditionally, which made the newest renderer the
 * one guaranteed to run without `drawtext` even on a host where /usr/bin/ffmpeg was sitting right
 * there. The audit recorded it as BUG B2. `resolveFFmpegBin` is the same function the rest of the
 * pipeline has always used, and it prefers a system build for exactly this reason.
 *
 * Resolved lazily, per call, so a test can change the environment and be believed — the resolver
 * memoises internally, so this costs one lookup per process and not one per render.
 */
const ffmpeg = (): string => resolveFFmpegBin();
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/**
 * Fields the timeline can carry that this renderer does not yet execute.
 *
 * RONDE 148 emptied most of this list by implementing it: camera moves run through zoompan,
 * crossfade/dissolve/dip through xfade, crop/cover/scale/position/opacity through the fit chain,
 * and music now ducks under voice with the sidechain filter `cinematicAudio` already used. What
 * remains is named per-render in `skipped` with the planner's own reason — see
 * `unsupported_effect`, `unsupported_transition` and `unsupported_graphic`.
 */
export const UNIMPLEMENTED = [
  "visual effects other than film_grain, noise, vignette, letterbox, glow, bloom and chromatic_aberration",
  "transitions other than hard_cut, crossfade, dissolve, dip_to_black and dip_to_white",
  /**
   * RONDE 150 — still true of the ASS route, and no longer the end of the story.
   *
   * libass draws words. A lower third with a role in a second colour underneath the name, a
   * counter that counts, a card whose subtitle only appears when the payload has one — those are
   * layout, and layout is what a browser is for. When a Remotion overlay is supplied (see
   * `graphicsOverlay` on `renderTimeline`) the graphics come from there instead and this line
   * describes only the fallback.
   */
  "motion graphics that are not words on screen (maps, charts, animated icons) — on the ASS route",
] as const;

/**
 * RONDE 150 §5/§6 — a pre-rendered transparent graphics layer, ready to be composited.
 *
 * Passed IN rather than produced here, for the same reason `resolveMedia` is: this module must not
 * acquire an opinion about browsers. A deployment with no chrome-headless-shell simply does not
 * supply one, the ASS route runs, and the video still gets its captions.
 */
export type GraphicsOverlayFile = {
  /** A video with an alpha channel, exactly as long and as large as the timeline. */
  overlayPath: string;
  /** Anything the overlay renderer was asked for and did not draw, with the planner's reason. */
  skipped: string[];
};

/** Which engine actually drew this video's text and graphics. */
export type GraphicsRenderer = "remotion" | "ffmpeg_ass" | "none";

export type RenderedTimeline = {
  outputPath: string;
  durationSec: number;
  clipsRendered: number;
  textsDrawn: number;
  captionsDrawn: number;
  audioTracks: number;
  /** RONDE 148 — how many joins were rendered as a real transition rather than a cut. */
  transitionsRendered: number;
  /** How many music/ambient tracks were ducked under the voice with sidechaincompress. */
  duckedTracks: number;
  /** How many clips had a camera move that actually produced a zoompan pass. */
  camerasExecuted: number;
  /**
   * RONDE 150 — which engine drew the text and graphics.
   *
   * Reported rather than inferred, because the two routes produce visibly different typography and
   * an operator looking at a video that suddenly lost its lower thirds needs to know which one ran.
   */
  graphicsRenderer: GraphicsRenderer;
  skipped: string[];
  ffmpegCommands: number;
};

export class TimelineRenderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NO_VIDEO_CLIPS"
      | "MISSING_MEDIA"
      | "FFMPEG_FAILED"
      | "EMPTY_TIMELINE"
  ) {
    super(message);
    this.name = "TimelineRenderError";
  }
}

/* ═══════════════════════ text escaping ═══════════════════════ */

/**
 * ── Why text is rendered with libass and not with drawtext ──────────────────────────────────
 *
 * MEASURED, not assumed: the ffmpeg binary this application ships (`ffmpeg-static` 7.0.2) does
 * NOT have the `drawtext` filter. Its build string advertises `--enable-libfreetype`, and the
 * filter is still absent from `-filters`; the first version of this renderer used drawtext and
 * every text render failed with `No such filter: 'drawtext'`.
 *
 * Nobody had noticed because RONDE 113 switched all ten text engines off, so no production render
 * has drawn a character in a long time. Turning text back on without checking would have shipped a
 * feature that cannot run.
 *
 * The same binary DOES have `subtitles` (libass), and libass is the better tool regardless: real
 * line breaking, per-element styles, an opaque box mode, alignment, margins, and fades expressed
 * in the format itself rather than in filter-graph arithmetic. One ASS file also means ONE filter
 * for a hundred captions, where drawtext needs a hundred chained filters.
 *
 * Verified in this environment: an ASS overlay through the shipped binary produces a frame four
 * times the size of the same frame without it — the characters are really there.
 */

/**
 * Escape a string for an ASS `Dialogue` line.
 *
 * This is the one place in the round where USER-SUPPLIED text reaches a rendering engine, and ASS
 * has exactly three characters that mean something: `{` and `}` open and close an override block
 * (where `{\pos(0,0)}` would move the caller's text, and a malformed one silently swallows it), and
 * `\` starts an escape. Braces are REPLACED rather than escaped because ASS offers no escape for
 * them — a caption containing a brace is vanishingly rare and a caption that silently vanishes is
 * not acceptable.
 *
 * Newlines become `\N`, which is ASS's own hard line break, so a two-line caption stays two lines.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

/** `1:02:03.45` — the timestamp format ASS wants, centisecond precision. */
export function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

/**
 * A colour as ASS wants it: `&HAABBGGRR`, with alpha INVERTED (00 is opaque).
 *
 * Both halves of that sentence are easy to get wrong and neither fails loudly — a byte-swapped
 * colour renders in the wrong hue and an un-inverted alpha renders invisible text, and both look
 * like "the overlay didn't work".
 */
export function assColour(colour: string, alpha = 0): string {
  const named: Record<string, string> = {
    white: "FFFFFF", black: "000000", red: "FF0000", yellow: "FFFF00",
    grey: "808080", gray: "808080",
  };
  const hex = (named[colour.trim().toLowerCase()] ?? colour.trim().replace(/^#/, "")).padEnd(6, "0");
  const rr = hex.slice(0, 2);
  const gg = hex.slice(2, 4);
  const bb = hex.slice(4, 6);
  const aa = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${aa}${bb}${gg}${rr}`.toUpperCase();
}

/** ASS alignment (numpad layout) for a style's position. */
export function assAlignment(position: TextStyle["position"]): number {
  switch (position) {
    case "top": return 8;
    case "center": return 5;
    case "lower_third": return 2;
    case "lower_center": return 2;
    case "bottom":
    default: return 2;
  }
}

/**
 * How far a bottom-anchored ASS line sits above the bottom of the frame, in pixels.
 *
 * ── RONDE 160 §12 — the two renderers used to disagree ──────────────────────────────────────
 *
 * `TextPosition` has six values. The ASS path handled four and let the other two fall through to
 * the plain bottom margin, in silence. For `lower_center` that meant the SAME timeline produced
 * two different videos depending on which graphics engine ran: Remotion's `positionStyle` puts it
 * at 28% of the frame height above the bottom, libass put it at 40 pixels.
 *
 * The fractions below are the ones `captionLayout.boxForPosition` already computes from (a
 * lower third is anchored at 0.78 of the frame, lower centre at 0.72) and the ones
 * `Text.tsx/positionStyle` already renders with. A test asserts the two renderers agree.
 *
 * `custom` is not here. `captionLayout` places it inside a caller-supplied `safeZone`, and NEITHER
 * renderer implements that — Remotion's `positionStyle` also falls through to the bottom. Giving
 * libass an approximation would make the two disagree again in the other direction, so `custom`
 * stays at the bottom in both, which is what `TextPosition`'s own doc comment says it does.
 */
export function assMarginV(position: TextStyle["position"], heightPx: number): number {
  switch (position) {
    case "lower_third": return Math.round(heightPx * 0.22);
    case "lower_center": return Math.round(heightPx * 0.28);
    default: return 40;
  }
}

/** Wrap text to a maximum line length, on word boundaries. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Vertical placement as an ffmpeg y-expression.
 *
 * Retained and exported, unused by the ASS path: it is the drawtext equivalent of `assAlignment`,
 * and the day a build with drawtext is the one in front of us, this is the half that is hard to
 * get right. Deleting it would mean writing it again from scratch.
 */
export function yExpressionFor(style: TextStyle, lineIndex: number, lineCount: number): string {
  const lh = `${style.fontSizePx + 12}`;
  const block = `(${lineCount}*${lh})`;
  switch (style.position) {
    case "top":
      return `(h*0.08)+${lineIndex}*${lh}`;
    case "center":
      return `(h-${block})/2+${lineIndex}*${lh}`;
    case "lower_third":
      return `(h*0.72)+${lineIndex}*${lh}`;
    case "bottom":
    default:
      return `h-(h*0.10)-${block}+${lineIndex}*${lh}`;
  }
}

/* ═══════════════════════ probing ═══════════════════════ */

export async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function probeHasStream(file: string, kind: "v" | "a"): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-select_streams", kind,
      "-show_entries", "stream=codec_type",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/* ═══════════════════════ the render ═══════════════════════ */

/**
 * Render one clip to a normalised segment of exactly its timeline length.
 *
 * Normalised means: the timeline's resolution, fps, pixel format and SAR, so the concat that
 * follows is a stream copy of compatible parts rather than a re-negotiation per clip. A source
 * shorter than the slot is looped rather than left short — the timeline says how long this shot is,
 * and a gap would be the renderer overruling it.
 */
async function renderSegment(
  clip: TimelineVideoClip,
  localMedia: string,
  outPath: string,
  fmt: { widthPx: number; heightPx: number; fps: number },
  look?: TimelineLook
): Promise<void> {
  const dur = Math.max(0.04, clip.timelineEnd - clip.timelineStart);
  /**
   * RONDE 148/149 — fit, camera, grade, effects, scale and opacity, built in `timelineFilters`.
   *
   * For a clip with none of those fields, and a timeline with no look, this returns the
   * byte-identical string this function used to hold inline — which is what keeps the golden
   * render bit-for-bit unchanged. A test asserts that equality directly rather than trusting the
   * reading.
   *
   * `sourceKind` is DERIVED when the clip does not carry it, so a timeline written before RONDE 149
   * is graded correctly without being migrated: the provider is already in the identity, and the
   * provider is what the grade is calibrated against.
   */
  const graded: TimelineVideoClip =
    clip.sourceKind || !look || look.grade === "none"
      ? clip
      : {
          ...clip,
          sourceKind: docGradeSourceKindForProvider(clip.source.provider, {
            archiveAssetId: clip.source.archiveAssetId,
          }),
        };
  const vf = buildVideoFilter(graded, fmt, dur, look);

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  if (clip.kind === "image") {
    args.push("-loop", "1", "-t", dur.toFixed(3), "-i", localMedia);
  } else {
    // -stream_loop -1 makes a short source fill its slot; -t bounds it to the slot exactly.
    /**
     * RONDE 147 §15 — an ABSENT trim means "nobody wrote it down", and the renderer says what it
     * does about that rather than pretending it was zero.
     *
     * Starting at 0 is the right behaviour for a source whose trim was never recorded — it is the
     * only defensible default — but it is the RENDERER's decision, taken here, and not a value the
     * validator or the rehydrator invented upstream and passed along as if it were known.
     */
    const startAt = clip.sourceIn != null ? Math.max(0, clip.sourceIn) : 0;
    args.push("-stream_loop", "-1", "-ss", startAt.toFixed(3),
      "-t", dur.toFixed(3), "-i", localMedia);
  }
  args.push(
    "-an",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-t", dur.toFixed(3),
    outPath
  );
  await execFileAsync(ffmpeg(), args, { maxBuffer: 1024 * 1024 * 16 });
}

export type AssElement = {
  text: string;
  start: number;
  end: number;
  style: TextStyle;
  animation?: "none" | "fade" | "fade_rise" | "fade_scale";
};

/**
 * Build the whole subtitle document for a timeline.
 *
 * One file, one filter, every text and caption element in it. Styles are DEDUPLICATED by their own
 * content so that fifty captions sharing a look produce one `Style` line rather than fifty — which
 * is both smaller and the reason a theme change is one edit.
 *
 * `PlayResX/Y` are set to the timeline's own format so that a font size in the style means pixels
 * in the output. Without them libass assumes 384×288 and every size is silently wrong.
 */
export function buildAssDocument(params: {
  elements: readonly AssElement[];
  widthPx: number;
  heightPx: number;
  fontName?: string;
}): string {
  const styles = new Map<string, { name: string; style: TextStyle }>();
  const styleNameFor = (s: TextStyle): string => {
    const key = JSON.stringify(s);
    const found = styles.get(key);
    if (found) return found.name;
    const name = `s${styles.size}`;
    styles.set(key, { name, style: s });
    return name;
  };
  // Resolved first so the [V4+ Styles] block can be written before the events that use it.
  const events = params.elements
    .filter((e) => e.text.trim() && e.end > e.start)
    .map((e) => ({ e, styleName: styleNameFor(e.style) }));

  const font = params.fontName ?? "DejaVu Sans";
  const styleLines = [...styles.values()].map(({ name, style }) => {
    const primary = assColour(style.color, 0);
    const back = assColour(style.backgroundColor ?? "black", 1 - style.backgroundOpacity);
    // BorderStyle 3 is the opaque box; 1 is an outline. A style with no background gets an outline
    // instead, because white text on archival footage without either is unreadable.
    const borderStyle = style.backgroundOpacity > 0 ? 3 : 1;
    const outline = style.backgroundOpacity > 0 ? 0 : 3;
    const marginV = assMarginV(style.position, params.heightPx);
    return (
      `Style: ${name},${font},${style.fontSizePx},${primary},&H000000FF,&H00000000,${back},` +
      `-1,0,0,0,100,100,0,0,${borderStyle},${outline},0,${assAlignment(style.position)},40,40,${marginV},1`
    );
  });

  const eventLines = events.map(({ e, styleName }) => {
    const fade = e.animation && e.animation !== "none" ? "{\\fad(220,220)}" : "";
    const wrapped = e.style.maxCharsPerLine
      ? wrapText(e.text, e.style.maxCharsPerLine).join("\n")
      : e.text;
    return (
      `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${styleName},,0,0,0,,` +
      `${fade}${escapeAssText(wrapped)}`
    );
  });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${params.widthPx}`,
    `PlayResY: ${params.heightPx}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
      "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, " +
      "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...eventLines,
    "",
  ].join("\n");
}

/** The directory holding the fonts, for libass without fontconfig. */
export function resolveFontsDir(preferred?: string): string | undefined {
  const candidates = [
    preferred,
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/liberation",
    "/usr/share/fonts",
  ].filter(Boolean) as string[];
  return candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
}

/** Escape a path for use inside an ffmpeg filter argument. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Execute a timeline.
 *
 * `resolveMedia` is how a clip's source becomes a local file. It is injected rather than imported
 * so that this module has no opinion about downloading, caching or authorisation — the rehydrator
 * owns all three, and a renderer that could fetch would be a renderer that could make decisions.
 */
export async function renderTimeline(params: {
  timeline: ProjectTimeline;
  workDir: string;
  outputPath: string;
  /** Clip → a local file, or null when it cannot be recovered. */
  resolveMedia: (clip: TimelineVideoClip) => Promise<string | null>;
  /** Audio clip id → a local file. Voice/music/sfx. */
  /**
   * Audio clip → a local file.
   *
   * `url` is the clip's own URL when it has one and "" when it does not; `source` is its full
   * identity. RONDE 166: an AMBIENT clip is addressed by `freesound:401178` with no URL at all, so
   * a resolver that only reads `url` will be handed an empty string and should use `source`.
   */
  resolveAudio?: (
    id: string,
    url: string,
    source: AssetSourceIdentity
  ) => Promise<string | null>;
  /** libass font family name. Must exist in `fontsDir`; there is no fontconfig in the shipped build. */
  fontName?: string;
  fontsDir?: string;
  /**
   * RONDE 150 §5/§6 — render the GRAPHICS/TEXT/CAPTIONS layer somewhere else and hand it back.
   *
   * Injected rather than imported so this module keeps no dependency on a browser. Return null
   * (or throw, which is caught and reported) to fall back to the ASS route; when it returns a
   * file, that file is composited and the ASS pass does not run at all — see phase 3.
   */
  graphicsOverlay?: (timeline: ProjectTimeline) => Promise<GraphicsOverlayFile | null>;
}): Promise<RenderedTimeline> {
  const { timeline, workDir, outputPath } = params;
  const fmt = timeline.format;
  const skipped: string[] = [];
  let commands = 0;

  fs.mkdirSync(workDir, { recursive: true });

  const clips = videoTrack(timeline)
    .filter((c) => !c.disabled)
    .sort((a, b) => a.timelineStart - b.timelineStart);
  if (clips.length === 0) {
    throw new TimelineRenderError("timeline has no enabled video clips", "NO_VIDEO_CLIPS");
  }

  /**
   * RONDE 160 §12 — a look this build cannot execute is REPORTED, like every other lost decision.
   *
   * `gradeChain` already refuses to approximate an unknown grade: it returns null and the pixels
   * are left alone, which is the right behaviour — guessing at "teal_orange" would give the video a
   * colour treatment nobody chose. What was missing is the sentence saying so. The reporter
   * (`lookUnsupportedReason`) was written in RONDE 153 and never called from anywhere but its own
   * test, so a timeline asking for a look that does not exist rendered completely ungraded and
   * reported success — the one shape of failure §21 singles out.
   *
   * Reported once per render rather than once per clip: the look is a property of the video.
   */
  if (timeline.look) {
    const reason = lookUnsupportedReason(timeline.look.grade);
    if (reason) skipped.push(`unsupported_look ${timeline.look.grade} — ${reason}`);
  }

  // ── 1. every clip becomes a normalised segment of exactly its own length ────────────────────
  const segments: string[] = [];
  /** Kept alongside the paths so phase 2 knows each segment's clip and its real length. */
  const rendered: Array<{ clip: TimelineVideoClip; durationSec: number }> = [];
  let transitionsRendered = 0;
  for (const [i, clip] of clips.entries()) {
    const media = await params.resolveMedia(clip);
    if (!media) {
      skipped.push(`clip ${clip.id}: source could not be recovered (${clip.source.provider})`);
      continue;
    }
    const seg = path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
    try {
      await renderSegment(clip, media, seg, fmt, timeline.look);
      commands++;
    } catch (err) {
      skipped.push(`clip ${clip.id}: encode failed — ${(err as Error).message.slice(0, 160)}`);
      continue;
    }
    if (fs.existsSync(seg) && fs.statSync(seg).size > 1024) {
      segments.push(seg);
      rendered.push({ clip, durationSec: Math.max(0.04, clip.timelineEnd - clip.timelineStart) });
    } else skipped.push(`clip ${clip.id}: segment was empty`);

    /**
     * §9/§15 — an effect the renderer cannot execute is REPORTED, and the clip keeps carrying it.
     *
     * Deleting it would make the timeline agree with the render by losing what the planner
     * decided. Saying so costs a line in the log and keeps the plan recoverable.
     */
    for (const effect of unsupportedEffects(clip.effects)) {
      skipped.push(
        `unsupported_effect ${effect.effectType} on clip ${clip.id}` +
          (effect.reason ? ` (${effect.reason})` : "") +
          " — kept on the timeline, not executed"
      );
    }
    if (!transitionIsRenderable(clip.transitionIn)) {
      skipped.push(`unsupported_transition ${clip.transitionIn} on clip ${clip.id}`);
    }
  }
  if (segments.length === 0) {
    throw new TimelineRenderError(
      `none of the ${clips.length} clip(s) could be rendered: ${skipped.join("; ")}`,
      "MISSING_MEDIA"
    );
  }

  // ── 2. join the segments ───────────────────────────────────────────────────────────────────
  /**
   * RONDE 148 — two paths, and the choice between them is the whole point.
   *
   * A sequence of hard cuts goes through `concat`, which is a STREAM COPY: no re-encode, no
   * generation loss, and bit-for-bit identical output every time. That is the path RONDE 144's
   * golden test measures, so it must stay the path a cuts-only timeline takes.
   *
   * A timeline that asks for a crossfade cannot be stream-copied — the overlap is new pixels — so
   * it goes through an xfade graph instead. Building that graph for a video of pure cuts would
   * re-encode everything to produce exactly the same picture, which is why the builder returns
   * null when there is nothing to fade.
   */
  const silent = path.join(workDir, "video_only.mp4");
  const graph = buildTransitionGraph({
    durations: rendered.map((r) => r.durationSec),
    transitions: rendered.map((r) => ({
      kind: r.clip.transitionIn,
      durationSec: r.clip.transitionInSec,
    })),
  });

  if (graph) {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const seg of segments) args.push("-i", seg);
    args.push(
      "-filter_complex", graph.filter,
      "-map", "[vout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-an", silent
    );
    await execFileAsync(ffmpeg(), args, { maxBuffer: 1024 * 1024 * 16 });
    transitionsRendered = rendered.filter(
      (r, i) => i > 0 && r.clip.transitionIn !== "hard_cut"
    ).length;
  } else {
    const listFile = path.join(workDir, "segments.txt");
    fs.writeFileSync(
      listFile,
      segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8"
    );
    await execFileAsync(
      ffmpeg(),
      ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy", silent],
      { maxBuffer: 1024 * 1024 * 16 }
    );
  }
  commands++;

  // ── 3. text and captions, as ONE subtitle document ─────────────────────────────────────────
  const texts = textTrackOf(timeline, "TEXT").filter((t) => !t.disabled && t.text.trim());
  const captions = captionTrack(timeline).filter((c) => !c.disabled && c.text.trim());
  /**
   * RONDE 148 §12 — a graphic that puts WORDS on screen is drawn through the same ASS pass.
   *
   * A location card and a date card are text with a box around them, and libass draws exactly
   * that. A map or a chart is not, and `graphicsWithLabels` leaves those out — they are reported
   * below rather than rendered as their own label, which would put the word "map" on the screen
   * where a map was meant to be.
   */
  const labelled = graphicsWithLabels(timeline);
  const elements: AssElement[] = [
    ...texts.map((t) => ({
      text: t.text, start: t.start, end: t.end, style: t.style, animation: t.animation,
    })),
    ...labelled.map((g) => ({
      text: g.label!, start: g.start, end: g.end,
      style: g.style ?? DEFAULT_TEXT_STYLE, animation: "fade" as const,
    })),
    ...captions.map((c) => ({ text: c.text, start: c.start, end: c.end, style: c.style })),
  ];
  for (const g of graphicsTrack(timeline)) {
    if (!g.disabled && !g.label?.trim()) {
      skipped.push(
        `unsupported_graphic ${g.graphicType} (${g.id})` +
          (g.reason ? ` — ${g.reason}` : "") +
          " — kept on the GRAPHICS track, not drawn"
      );
    }
  }

  /**
   * ── 3a. RONDE 150 §5/§6 — composite the Remotion overlay, when there is one ─────────────────
   *
   * The overlay carries an alpha channel; `overlay=format=auto` lays it over the picture, honouring
   * that alpha, and everywhere the graphics layer drew nothing the film shows through untouched.
   *
   * The `else` below is not a fallback in the bad sense. Both routes draw the same elements from
   * the same timeline; one of them can lay out a lower third and one of them cannot. What matters
   * is that EXACTLY ONE runs: if both did, every caption would be burned in twice, half a pixel
   * apart, and the result reads as a blurry double-strike rather than as an obvious bug.
   */
  let withText = silent;
  let graphicsRenderer: GraphicsRenderer = elements.length > 0 ? "ffmpeg_ass" : "none";
  let overlay: GraphicsOverlayFile | null = null;
  if (params.graphicsOverlay) {
    try {
      overlay = await params.graphicsOverlay(timeline);
    } catch (err) {
      /**
       * A missing browser must not lose a finished edit.
       *
       * §2 forbids a SILENT fallback, not a fallback: the reason is pushed into `skipped`, which
       * goes to the render log and the job record, and the ASS route then draws the same captions
       * with plainer typography. Failing the whole render because a lower third could not be laid
       * out would be the worse answer.
       */
      skipped.push(
        `graphics overlay unavailable, fell back to the libass route — ${(err as Error).message.slice(0, 200)}`
      );
    }
  }

  if (overlay && fs.existsSync(overlay.overlayPath)) {
    skipped.push(...overlay.skipped);
    withText = path.join(workDir, "with_graphics.mp4");
    await execFileAsync(
      ffmpeg(),
      ["-y", "-hide_banner", "-loglevel", "error",
        "-i", silent,
        "-i", overlay.overlayPath,
        /**
         * `shortest=1` bounds the result by the PICTURE. The overlay is built to the timeline's own
         * duration, so the two should already match; if rounding ever leaves the overlay a frame
         * longer, a video that grew a frame of pure graphics over black would fail the duration
         * gate for a reason that has nothing to do with the edit.
         */
        "-filter_complex", "[0:v][1:v]overlay=format=auto:shortest=1[vout]",
        "-map", "[vout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-an", withText],
      { maxBuffer: 1024 * 1024 * 16 }
    );
    commands++;
    graphicsRenderer = "remotion";
  } else if (elements.length > 0) {
    if (overlay) {
      skipped.push(
        `graphics overlay ${overlay.overlayPath} was not written, fell back to the libass route`
      );
    }
    const assPath = path.join(workDir, "overlay.ass");
    fs.writeFileSync(
      assPath,
      buildAssDocument({
        elements,
        widthPx: fmt.widthPx,
        heightPx: fmt.heightPx,
        fontName: params.fontName,
      }),
      "utf8"
    );
    const fontsDir = resolveFontsDir(params.fontsDir);
    const filter =
      `subtitles='${escapeFilterPath(assPath)}'` +
      (fontsDir ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : "");
    withText = path.join(workDir, "with_text.mp4");
    await execFileAsync(
      ffmpeg(),
      ["-y", "-hide_banner", "-loglevel", "error", "-i", silent,
        "-vf", filter,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-an", withText],
      { maxBuffer: 1024 * 1024 * 16 }
    );
    commands++;
  }

  // ── 4. audio ───────────────────────────────────────────────────────────────────────────────
  /**
   * RONDE 148 §19/§23 — AMBIENT joins VOICE, MUSIC and SFX as its own track.
   *
   * It ducks more gently than music (see `DUCK_AMBIENT`), and a person switching the music off
   * should not thereby lose the room they are standing in.
   */
  const audioClips = [
    ...audioTrackOf(timeline, "VOICE").map((c) => ({ c, kind: "VOICE" as const })),
    ...audioTrackOf(timeline, "MUSIC").map((c) => ({ c, kind: "MUSIC" as const })),
    ...audioTrackOf(timeline, "AMBIENT").map((c) => ({ c, kind: "AMBIENT" as const })),
    ...audioTrackOf(timeline, "SFX").map((c) => ({ c, kind: "SFX" as const })),
  ].filter((x) => !x.c.disabled);

  const resolvedAudio: Array<{ file: string; input: MixInput }> = [];
  for (const { c, kind } of audioClips) {
    const url = c.source.canonicalUrl || c.source.mediaUrl;
    /**
     * RONDE 166 (§2) — an audio clip may be named by IDENTITY instead of by URL.
     *
     * This used to require a URL and skip anything without one, which meant an audio asset
     * addressed the way every VIDEO asset is addressed — `provider` + `providerAssetId`, resolved
     * by the rehydrator — could never be fetched at all. The AMBIENT track names Freesound
     * recordings that way, so wiring the catalogue up produced clips the renderer then reported as
     * "no source": correct plan, unfetchable audio.
     *
     * A clip is now resolvable when it has EITHER a URL or a provider identity, and the resolver
     * is handed both so it can use whichever it has. A clip with neither is still skipped and
     * still named — that part was right.
     */
    const hasIdentity = Boolean(c.source.provider && c.source.providerAssetId);
    if ((!url && !hasIdentity) || !params.resolveAudio) {
      skipped.push(`audio ${c.id}: no source`);
      continue;
    }
    const file = await params.resolveAudio(c.id, url ?? "", c.source);
    if (!file) {
      skipped.push(`audio ${c.id}: could not be recovered`);
      continue;
    }
    resolvedAudio.push({
      file,
      input: {
        // Input 0 is the video; audio inputs start at 1.
        index: resolvedAudio.length + 1,
        kind,
        startSec: c.start,
        gain: c.gain,
        fadeInSec: c.fadeInSec,
        fadeOutSec: c.fadeOutSec,
        durationSec: Math.max(0, c.end - c.start),
        duckUnderVoice: c.duckUnderVoice,
        /** RONDE 154 — the timeline's own ducking, automation and delay, carried unchanged. */
        ...(c.ducking ? { ducking: c.ducking } : {}),
        ...(c.automation?.length ? { automation: c.automation } : {}),
        ...(c.delaySec != null ? { delaySec: c.delaySec } : {}),
      },
    });
  }

  const audioGraph = buildAudioGraph(resolvedAudio.map((a) => a.input));
  if (!audioGraph) {
    fs.copyFileSync(withText, outputPath);
  } else {
    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-i", withText];
    for (const a of resolvedAudio) args.push("-i", a.file);
    args.push(
      "-filter_complex", audioGraph.filter,
      "-map", "0:v", "-map", `[${audioGraph.outLabel}]`,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      /**
       * §26 — `-shortest` bounded by the VIDEO, which is the timeline's own length.
       *
       * The video is input 0 and the mix cannot outlast it; without this a music bed longer than
       * the edit would extend the file past the picture, and the duration gate would then report a
       * drift that the timeline never asked for.
       */
      "-shortest",
      outputPath
    );
    await execFileAsync(ffmpeg(), args, { maxBuffer: 1024 * 1024 * 16 });
    commands++;
  }
  const ducked = resolvedAudio.filter(
    (a) => a.input.duckUnderVoice && a.input.kind !== "VOICE" && a.input.kind !== "SFX"
  ).length;

  const durationSec = (await probeDurationSec(outputPath)) ?? 0;
  return {
    outputPath,
    durationSec,
    clipsRendered: segments.length,
    textsDrawn: texts.length + labelled.length,
    captionsDrawn: captions.length,
    audioTracks: resolvedAudio.length,
    transitionsRendered,
    duckedTracks: ducked,
    camerasExecuted: rendered.filter((r) => cameraChain(
      r.clip.camera ?? { type: "camera_hold" }, fmt, r.durationSec
    ) !== null).length,
    graphicsRenderer,
    skipped,
    ffmpegCommands: commands,
  };
}

/* ═══════════════════════ §21 — the gate after every render ═══════════════════════ */

export type RenderQualityCheck = {
  ok: boolean;
  fileExists: boolean;
  sizeBytes: number;
  durationSec: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  widthPx: number | null;
  heightPx: number | null;
  fps: number | null;
  problems: string[];
};

/**
 * Check the produced file against the timeline that asked for it — §21.
 *
 * Every claim is measured with ffprobe rather than assumed from the fact that ffmpeg exited zero:
 * a truncated file, a video stream with no audio, or a duration that does not match the timeline
 * are all things a successful exit code is perfectly happy about.
 *
 * `expectAudio` is a parameter rather than an assumption, because a timeline with no audio track is
 * a legitimate thing to render and reporting a missing audio stream as a fault would make the gate
 * cry wolf — the failure mode RONDE 142 spent a round undoing.
 */
export async function checkRenderedFile(params: {
  filePath: string;
  timeline: ProjectTimeline;
  expectAudio: boolean;
  durationToleranceSec?: number;
}): Promise<RenderQualityCheck> {
  const problems: string[] = [];
  const exists = fs.existsSync(params.filePath);
  const size = exists ? fs.statSync(params.filePath).size : 0;
  if (!exists) problems.push("output file does not exist");
  else if (size < 1024) problems.push(`output file is ${size} bytes`);

  const duration = exists ? await probeDurationSec(params.filePath) : null;
  const hasVideo = exists ? await probeHasStream(params.filePath, "v") : false;
  const hasAudio = exists ? await probeHasStream(params.filePath, "a") : false;
  if (exists && !hasVideo) problems.push("no video stream");
  if (exists && params.expectAudio && !hasAudio) problems.push("no audio stream");

  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;
  if (exists && hasVideo) {
    try {
      const { stdout } = await execFileAsync(FFPROBE, [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-of", "default=nw=1:nk=1", params.filePath,
      ]);
      const [w, h, rate] = stdout.trim().split("\n");
      width = Number(w) || null;
      height = Number(h) || null;
      if (rate?.includes("/")) {
        const [n, d] = rate.split("/").map(Number);
        fps = d ? Math.round((n / d) * 100) / 100 : null;
      }
    } catch {
      problems.push("could not read stream properties");
    }
  }
  const fmt = params.timeline.format;
  if (width != null && width !== fmt.widthPx) problems.push(`width ${width} ≠ ${fmt.widthPx}`);
  if (height != null && height !== fmt.heightPx) problems.push(`height ${height} ≠ ${fmt.heightPx}`);
  if (fps != null && Math.abs(fps - fmt.fps) > 0.5) problems.push(`fps ${fps} ≠ ${fmt.fps}`);

  const tol = params.durationToleranceSec ?? 1.0;
  if (duration != null && params.timeline.durationSec > 0) {
    const drift = Math.abs(duration - params.timeline.durationSec);
    if (drift > tol) {
      problems.push(
        `duration ${duration.toFixed(2)}s differs from the timeline's ${params.timeline.durationSec.toFixed(2)}s by ${drift.toFixed(2)}s`
      );
    }
  }

  return {
    ok: problems.length === 0,
    fileExists: exists,
    sizeBytes: size,
    durationSec: duration,
    hasVideo,
    hasAudio,
    widthPx: width,
    heightPx: height,
    fps,
    problems,
  };
}
