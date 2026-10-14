/**
 * A PLANNED GRAPHIC IS NOT SWITCHED OFF FOR CROWDING IT NEVER CAUSES, AND REACHES THE MP4 ON ITS WORD.
 *
 * The renderer draws a graphic from the moment the voice says its anchor word (`graphicOnScreenWindow`).
 * The on-screen-text director judged "too much text at once" on the PLANNED spans instead, which all
 * start at the sentence's first word: a year, a name and a figure in one sentence were three things
 * at once, and the figure — said seconds later, alone on screen — was switched off as
 * `too_much_text_at_once`. The graphics lifecycle then reported it as "switched off in the editor".
 *
 * Here: the director's rule 6 on the real on-screen windows; the lifecycle naming the director's
 * reason; the props carrying the figure on its word; and one real local render (Remotion overlay +
 * the production ffmpeg composite) read back pixel by pixel. Subtitles are off, as the setting
 * says, and are not drawn; their word timing still places the graphics. A film without graphics
 * renders exactly as before. No network, no paid call.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { graphicsLifecycle } from "./graphicsLifecycle";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { directOnScreenText } from "./onScreenTextDirector";
import { DEFAULT_CAPTION_STYLE, emptyTimeline, graphicsTrack, type ProjectTimeline } from "./projectTimeline";
import { timelineToRemotionProps } from "./remotionProps";
import { resolveRemotionBrowser } from "./remotionRenderer";
import { renderTimeline, type RenderedTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 12;
const DURATION = 10;

/** "In 2008 the firm of John Smith finally sold 2450 cars" — the year early, the name next, the figure late. */
const WORDS = (
  [["In", 0.0], ["2008", 0.3], ["the", 0.9], ["firm", 1.1], ["of", 1.4], ["John", 1.6], ["Smith", 1.9], ["finally", 4.6], ["sold", 5.0], ["2450", 5.4], ["cars", 6.0]] as const
).map(([word, startSec]) => ({ word, startSec, endSec: startSec + 0.3 }));

function sentenceTimeline(opts: { words?: boolean; graphics?: boolean } = {}): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
  t.durationSec = DURATION;
  for (const track of t.tracks) {
    if (track.kind === "VIDEO") {
      track.clips.push({
        id: "vc", kind: "video", source: { provider: "pexels", providerAssetId: "fixture" },
        sceneIndex: 0, beatIndex: 0, sourceIn: 0, sourceOut: DURATION, timelineStart: 0, timelineEnd: DURATION,
        motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
      } as never);
    }
    /** The subtitle the planner made, switched off by the video's setting (`subtitles_off`): its words still time the graphics. */
    if (track.kind === "CAPTIONS") {
      track.captions.push({
        id: "cap", text: "In 2008 the firm of John Smith finally sold 2450 cars", start: 0, end: 7,
        style: { ...DEFAULT_CAPTION_STYLE }, disabled: true, disabledReason: "subtitles_off",
        ...(opts.words === false ? {} : { words: WORDS }),
      } as never);
    }
    if (track.kind === "GRAPHICS" && opts.graphics !== false) {
      track.graphics.push(
        { id: "g_date", graphicType: "date_card", data: { text: "2008", anchorWord: "2008" }, start: 0, end: 3, label: "2008" } as never,
        { id: "g_name", graphicType: "lower_third", data: { name: "John Smith", label: "John Smith", anchorWord: "John" }, start: 0, end: 3, label: "John Smith" } as never,
        { id: "g_count", graphicType: "counter", data: { fromValue: 0, toValue: 2450, label: "2450 cars", caption: "Cars sold", anchorWord: "2450" }, start: 0, end: 3.5, label: "2450 cars" } as never
      );
    }
  }
  return t;
}

/* ═══════════════════════ the director, on the real windows ═══════════════════════ */

describe("the on-screen-text director judges crowding where the graphics really are", () => {
  it("year, name and figure in one sentence, each on its own word: the figure is kept", () => {
    const t = sentenceTimeline();
    const d = directOnScreenText(t);
    expect(d.disabled.map((x) => x.id)).not.toContain("g_count");
    expect(graphicsTrack(t).find((g) => g.id === "g_count")?.disabled).not.toBe(true);
  });

  it("without word timing the planned spans are all there is: the existing rule stands unchanged", () => {
    const t = sentenceTimeline({ words: false });
    const d = directOnScreenText(t);
    expect(d.disabled).toEqual([{ id: "g_count", reason: "too_much_text_at_once", label: "2450 cars" }]);
  });
});

/* ═══════════════════════ the lifecycle names the real reason ═══════════════════════ */

describe("a graphic switched off by the pipeline is reported with the pipeline's reason", () => {
  const planned = [{ beatId: "s0b0", graphicType: "date_card", data: { text: "2008" }, startSec: 0, reason: "a year" }];
  it("the director's reason, not 'switched off in the editor'", async () => {
    const { timelineElementId } = await import("./projectTimeline");
    const gid = timelineElementId("gfx", "s0b0", "date_card", 0);
    const life = graphicsLifecycle({
      planned,
      onTrack: [{ id: gid, graphicType: "date_card", data: { text: "2008" }, label: "2008", disabled: true, disabledReason: "graphic_budget_exceeded" }],
    });
    expect(life.lives[0]).toMatchObject({ outcome: "DROPPED_DISABLED", detail: "switched off by the on-screen-text director: graphic_budget_exceeded" });
  });
  it("a switch with no recorded reason is still the editor's", async () => {
    const { timelineElementId } = await import("./projectTimeline");
    const gid = timelineElementId("gfx", "s0b0", "date_card", 0);
    const life = graphicsLifecycle({ planned, onTrack: [{ id: gid, graphicType: "date_card", data: { text: "2008" }, label: "2008", disabled: true }] });
    expect(life.lives[0]).toMatchObject({ outcome: "DROPPED_DISABLED", detail: "switched off in the editor" });
  });
});

/* ═══════════════════════ the render input ═══════════════════════ */

describe("the graphic reaches the Remotion render input on its word, for its planned length", () => {
  it("the figure is in the props, from the frame its word is said, as long as planned; the switched-off subtitle is not", () => {
    const t = sentenceTimeline();
    directOnScreenText(t);
    const props = timelineToRemotionProps({ timeline: t });
    const count = props.graphics.find((g) => g.id === "g_count");
    expect(count).toBeDefined();
    expect(count!.fromFrame).toBe(Math.round(5.4 * FPS));
    expect(count!.durationInFrames).toBe(Math.round(3.5 * FPS));
    expect(props.graphics.find((g) => g.id === "g_date")!.fromFrame).toBe(Math.round(0.3 * FPS));
    expect(props.graphics.find((g) => g.id === "g_name")!.fromFrame).toBe(Math.round(1.6 * FPS));
    expect(props.captions).toEqual([]);
  });
});

/* ═══════════════════════ real pixels ═══════════════════════ */

async function frameAt(file: string, atSec: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    resolveFFmpegBin(),
    ["-hide_banner", "-loglevel", "error", "-ss", atSec.toFixed(3), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 }
  );
  return stdout as unknown as Buffer;
}

/** Pixels that are no longer the dark-red source — what the overlay put there. */
function ink(rgb: Buffer): number {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) if (!(rgb[i]! > 100 && rgb[i]! < 140 && rgb[i + 1]! < 30 && rgb[i + 2]! < 30)) n++;
  return n;
}

const describeRender = resolveRemotionBrowser() ? describe : describe.skip;

describeRender("one real local render: the overlay is laid over the film, each graphic on its word", () => {
  let dir = "";
  let source = "";
  let out = "";
  let result: RenderedTimeline;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "on-word-"));
    source = path.join(dir, "red.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", `color=c=0x780000:s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=${FPS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ]);
    const t = sentenceTimeline();
    directOnScreenText(t);
    out = path.join(dir, "film.mp4");
    const workDir = path.join(dir, "work");
    result = await renderTimeline({
      timeline: t,
      workDir,
      outputPath: out,
      resolveMedia: async () => source,
      graphicsOverlay: productionGraphicsOverlay({ workDir, cacheDir: path.join(dir, "bundle") }),
    });
  }, 1_800_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the transparent overlay went through the normal composite, nothing refused", () => {
    expect(fs.existsSync(out)).toBe(true);
    expect(result.skipped.filter((s) => /unsupported_graphic|fell back|not drawn|no visible ink/.test(s))).toEqual([]);
  });

  it("before the first word nothing is drawn: the switched-off subtitle stays off, the film shows through", async () => {
    expect(ink(await frameAt(out, 0.1))).toBeLessThan(WIDTH * HEIGHT * 0.002);
  });

  it("the figure is on screen after its word, alone, where it used to be switched off", async () => {
    expect(ink(await frameAt(out, 7.2))).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
  });

  it("outside its window the film is clean again", async () => {
    expect(ink(await frameAt(out, 9.5))).toBeLessThan(WIDTH * HEIGHT * 0.002);
  });

  it("the film's own picture is kept everywhere the overlay drew nothing (alpha honoured, not an opaque layer)", async () => {
    const f = await frameAt(out, 7.2);
    /** the top-left corner: no graphic there, the dark-red source must show through */
    const i = (10 * WIDTH + 10) * 3;
    expect(f[i]!).toBeGreaterThan(100);
    expect(f[i + 1]!).toBeLessThan(30);
  });
});

describeRender("a valid film without graphics renders exactly as before", () => {
  let dir = "";
  it("no overlay is made, the film is the source", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-gfx-"));
    const src = path.join(dir, "red.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", `color=c=0x780000:s=${WIDTH}x${HEIGHT}:d=2:r=${FPS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", src,
    ]);
    const t = sentenceTimeline({ graphics: false });
    t.durationSec = 2;
    const video = t.tracks.find((k) => k.kind === "VIDEO");
    if (video?.kind === "VIDEO") video.clips[0] = { ...video.clips[0]!, sourceOut: 2, timelineEnd: 2 };
    const out = path.join(dir, "film.mp4");
    const r = await renderTimeline({
      timeline: t,
      workDir: path.join(dir, "work"),
      outputPath: out,
      resolveMedia: async () => src,
      graphicsOverlay: productionGraphicsOverlay({ workDir: path.join(dir, "work"), cacheDir: path.join(dir, "bundle") }),
    });
    expect(fs.existsSync(out)).toBe(true);
    expect(r.graphicsRenderer).not.toBe("remotion");
    expect(ink(await frameAt(out, 1))).toBeLessThan(WIDTH * HEIGHT * 0.002);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 600_000);
});
