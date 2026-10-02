/**
 * THE EDITOR, END TO END — a person's edits reach the MP4.
 *
 * A feature counts when it survives the whole chain: the edit the editor applies (the shared pure
 * functions in `@shared/timelineEdits` and `@shared/editorCommands`, the same ones the browser
 * calls), the validator the save goes through, and the one renderer that makes the delivered file.
 * This builds a small film, edits it the way the editor does, renders it with real ffmpeg, and
 * measures the file — length, picture, sound — rather than reading a filter string.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  duplicateVideoClip,
  setAudioClip,
  setAudioClipTiming,
  setTextElementTiming,
  setVideoClipSpeed,
  tightenPacing,
  videoClipsOf,
  type EditableTimeline,
} from "@shared/timelineEdits";
import { applyEditorOps, cameraPreset } from "@shared/editorCommands";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { buildVideoFilter, clipPlaybackSpeed } from "./timelineFilters";
import { validateTimeline, NON_BLOCKING_ISSUES } from "./timelineValidator";
import { renderTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { parseEditorOps } from "./editorAssistant";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const FMT = { widthPx: 320, heightPx: 180, fps: 24 } as const;

let dir = "";
let videoSrc = "";
let stillSrc = "";
let voiceSrc = "";
let musicSrc = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-e2e-"));
  videoSrc = path.join(dir, "src.mp4");
  stillSrc = path.join(dir, "still.png");
  voiceSrc = path.join(dir, "voice.wav");
  musicSrc = path.join(dir, "music.wav");
  const run = (args: string[]) => execFileAsync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  await run(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12", videoSrc]);
  await run(["-f", "lavfi", "-i", "smptebars=size=640x360", "-frames:v", "1", stillSrc]);
  await run(["-f", "lavfi", "-i", "sine=frequency=440:duration=9", voiceSrc]);
  await run(["-f", "lavfi", "-i", "sine=frequency=220:duration=9", musicSrc]);
}, 300_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function clip(over: Partial<TimelineVideoClip> & { id: string }): TimelineVideoClip {
  return {
    kind: "video",
    source: { provider: "archive", archiveAssetId: 1, title: over.id },
    sourceIn: 0,
    sourceOut: 3,
    timelineStart: 0,
    timelineEnd: 3,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    ...over,
  } as TimelineVideoClip;
}

/** A nine-second film: a shot, a still, a shot; narration, music, a sound; subtitles and a year. */
function film(): ProjectTimeline {
  const t = emptyTimeline(7, FMT);
  t.durationSec = 9;
  for (const track of t.tracks) {
    if (track.kind === "VIDEO") {
      track.clips.push(
        clip({ id: "a", timelineStart: 0, timelineEnd: 3 }),
        clip({ id: "b", kind: "image", timelineStart: 3, timelineEnd: 6, sourceIn: undefined, sourceOut: undefined, camera: cameraPreset("slow_push") as never }),
        clip({ id: "c", timelineStart: 6, timelineEnd: 9, sourceIn: 4, sourceOut: 7 }),
      );
    }
    if (track.kind === "VOICE") track.clips.push({ id: "v", source: { provider: "elevenlabs", mediaUrl: "voice" }, start: 0, end: 9, gain: 1 });
    if (track.kind === "MUSIC") track.clips.push({ id: "m", source: { provider: "freesound", mediaUrl: "music" }, start: 0, end: 9, gain: 0.3, duckUnderVoice: true });
    if (track.kind === "SFX") track.clips.push({ id: "s", source: { provider: "freesound", mediaUrl: "music" }, start: 2, end: 3, gain: 0.5 });
    if (track.kind === "CAPTIONS") {
      track.captions.push(
        { id: "c1", text: "In nineteen forty five", start: 0.2, end: 3, style: { fontSizePx: 18, color: "white", backgroundOpacity: 0, position: "bottom" } },
        { id: "c2", text: "the war ended", start: 3.2, end: 6, style: { fontSizePx: 18, color: "white", backgroundOpacity: 0, position: "bottom" } },
      );
    }
    if (track.kind === "TEXT") {
      track.texts.push({ id: "t1", text: "1945", start: 1, end: 3, style: { fontSizePx: 22, color: "white", backgroundOpacity: 0.4, position: "top" }, animation: "typewriter" });
    }
  }
  return t;
}

const asEditable = (t: ProjectTimeline) => t as unknown as EditableTimeline;
const asTimeline = (t: EditableTimeline) => t as unknown as ProjectTimeline;

function blocking(t: ProjectTimeline): string[] {
  return validateTimeline(t).issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code)).map((i) => `${i.code}:${i.elementId}`);
}

async function probe(file: string): Promise<{ duration: number; streams: string[]; size: string }> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]);
  const j = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number }> };
  const v = j.streams.find((s) => s.codec_type === "video");
  return { duration: Number(j.format.duration), streams: j.streams.map((s) => s.codec_type), size: `${v?.width}x${v?.height}` };
}

/* ═══════════ the edits themselves ═══════════ */

describe("editor edits keep the film whole", () => {
  it("speed: the slot stays, the source read doubles, the renderer plays it at that speed", () => {
    const t = asTimeline(setVideoClipSpeed(asEditable(film()), "a", 2));
    const a = videoTrack(t).find((c) => c.id === "a")!;
    expect(a.speed).toBe(2);
    expect(a.timelineEnd - a.timelineStart).toBeCloseTo(3, 5);
    expect(a.sourceOut! - a.sourceIn!).toBeCloseTo(6, 5);
    expect(clipPlaybackSpeed(a)).toBe(2);
    expect(buildVideoFilter(a, FMT, 3)).toContain("setpts=(PTS-STARTPTS)/2.0000");
    /** A still has no speed; back to 1× removes the field. */
    expect(clipPlaybackSpeed({ kind: "image", speed: 2 })).toBe(1);
    expect(videoTrack(asTimeline(setVideoClipSpeed(asEditable(t), "a", 1))).find((c) => c.id === "a")!.speed).toBeUndefined();
  });

  it("duplicate puts a copy right after and moves the rest up; the film stays as long as the voice", () => {
    const t = asTimeline(duplicateVideoClip(asEditable(film()), "a", "a2"));
    expect(videoTrack(t).map((c) => c.id)).toEqual(["a", "a2", "b", "c"]);
    expect(t.durationSec).toBeCloseTo(12, 5);
    expect(blocking(t)).toEqual([]);
  });

  it("faster pacing cuts long shots without changing the film's length or its picture", () => {
    const t = tightenPacing(asEditable(film()), 1.5);
    expect(videoClipsOf(t).length).toBe(6);
    expect(t.durationSec).toBeCloseTo(9, 5);
    const c = videoClipsOf(t).filter((x) => String(x.id).startsWith("c") || x.sourceIn === 5.5);
    expect(c.some((x) => x.sourceIn === 5.5)).toBe(true);
    expect(blocking(asTimeline(t))).toEqual([]);
  });

  it("text timing is kept inside the film and at least half a second long", () => {
    const t = setTextElementTiming(asEditable(film()), "TEXT", "t1", 8.9, 8.95);
    const t1 = (t.tracks.find((x) => x.kind === "TEXT") as unknown as { texts: Array<{ start: number; end: number }> }).texts[0]!;
    expect(t1.start).toBeCloseTo(8.5, 5);
    expect(t1.end).toBeCloseTo(9, 5);
  });

  it("audio: volume, fades and mute land on the clip; a moved sound keeps its length", () => {
    let t = setAudioClip(asEditable(film()), "MUSIC", "m", { gain: 0.5, fadeInSec: 1, fadeOutSec: 20, muted: false });
    const m = (t.tracks.find((x) => x.kind === "MUSIC") as unknown as { clips: Array<Record<string, number>> }).clips[0]!;
    expect(m.gain).toBe(0.5);
    expect(m.fadeInSec).toBe(1);
    expect(m.fadeOutSec, "a fade can be at most half the clip").toBe(4.5);
    t = setAudioClip(t, "SFX", "s", { muted: true });
    expect((t.tracks.find((x) => x.kind === "SFX") as unknown as { clips: Array<{ disabled?: boolean }> }).clips[0]!.disabled).toBe(true);
    t = setAudioClipTiming(t, "SFX", "s", 8.8);
    const s = (t.tracks.find((x) => x.kind === "SFX") as unknown as { clips: Array<{ start: number; end: number }> }).clips[0]!;
    expect(s.start).toBeCloseTo(8, 5);
    expect(s.end).toBeCloseTo(9, 5);
  });

  it("an out-of-range speed is refused by the validator", () => {
    const t = film();
    videoTrack(t)[0]!.speed = 9;
    expect(blocking(t)).toContain("invalid_speed:a");
  });
});

/* ═══════════ AI commands ═══════════ */

describe("AI commands are editor operations, validated before they are applied", () => {
  it("the model's answer is checked: unknown verbs and bad values are dropped and reported", () => {
    const plan = parseEditorOps(JSON.stringify({
      summary: "Sneller en kleinere ondertitels",
      ops: [
        { op: "tighten_pacing", maxShotSec: 2 },
        { op: "captions_style", fontSizePx: 30 },
        { op: "render_video" },
        { op: "set_speed", clipId: "a", speed: 99 },
      ],
    }));
    expect(plan.ops.map((o) => o.op)).toEqual(["tighten_pacing", "captions_style"]);
    expect(plan.dropped.length).toBe(2);
    expect(parseEditorOps("not json").ops).toEqual([]);
  });

  it("applying them changes only the timeline, through the same edits a click makes", () => {
    const applied = applyEditorOps(asEditable(film()), [
      { op: "set_transition", clipId: "b", transition: "slide_left", seconds: 0.5 },
      { op: "set_effect", clipId: "c", effect: "vignette", intensity: 0.6 },
      { op: "set_camera", clipId: "all", movement: "slow_push" },
      { op: "show_element", id: "t1", shown: false },
      { op: "set_volume", track: "MUSIC", gain: 0.2 },
      { op: "replace_clip", clipId: "c" },
      { op: "remove_clip", clipId: "nope" },
    ]);
    const t = asTimeline(applied.timeline);
    const [a, b, c] = videoTrack(t);
    expect(b!.transitionIn).toBe("slide_left");
    expect(c!.effects).toEqual([{ effectType: "vignette", intensity: 0.6 }]);
    expect(a!.camera?.type).toBe("slow_push");
    expect((t.tracks.find((x) => x.kind === "TEXT") as { texts: Array<{ disabled?: boolean }> }).texts[0]!.disabled).toBe(true);
    expect(applied.replaceClipIds).toEqual(["c"]);
    expect(applied.log.at(-1)).toBe("no shot nope");
    expect(blocking(t)).toEqual([]);
  });
});

/* ═══════════ the MP4 ═══════════ */

describe("an edited film renders through the one renderer", () => {
  it("speed, still motion, a slide and a zoom transition, effects, subtitles, a typed year, music with fades and a muted sound — one file", async () => {
    let t = asEditable(film());
    t = setVideoClipSpeed(t, "a", 2);
    t = applyEditorOps(t, [
      { op: "set_transition", clipId: "b", transition: "slide_left", seconds: 0.5 },
      { op: "set_transition", clipId: "c", transition: "zoom", seconds: 0.5 },
      { op: "set_effect", clipId: "c", effect: "vignette", intensity: 0.6 },
      { op: "set_effect", clipId: "a", effect: "contrast", intensity: 0.4 },
    ]).timeline;
    t = setAudioClip(t, "MUSIC", "m", { fadeInSec: 1, fadeOutSec: 1 });
    t = setAudioClip(t, "SFX", "s", { muted: true });
    const timeline = asTimeline(t);
    expect(blocking(timeline)).toEqual([]);

    const outputPath = path.join(dir, "edited.mp4");
    const result = await renderTimeline({
      timeline,
      workDir: path.join(dir, "work"),
      outputPath,
      resolveMedia: async (c) => (c.kind === "image" ? stillSrc : videoSrc),
      resolveAudio: async (_id, url) => (url === "voice" ? voiceSrc : musicSrc),
    });
    expect(result.outputPath).toBe(outputPath);
    const p = await probe(outputPath);
    expect(p.size).toBe(`${FMT.widthPx}x${FMT.heightPx}`);
    expect(p.streams).toContain("audio");
    expect(p.duration).toBeGreaterThan(8.5);
    expect(p.duration).toBeLessThan(9.6);
    /** Nothing the editor offers is reported as "not rendered". */
    expect(result.skipped.filter((s) => /unsupported_transition|unsupported_effect/.test(s))).toEqual([]);
  }, 600_000);
});
