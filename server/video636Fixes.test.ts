/**
 * VIDEO 636 (Tesla, commit 9e9199b) — what the forensic audit proved, and the fixes it asked for.
 *
 *   1  a short file is never played again from its start (renderer: `tpad`, no `-stream_loop`)
 *   2  split shots run through their source once, in order — no overlap, no second piece at 0
 *   3  the planner knows the real length of every clip (`probed=0` in 636)
 *   4  a reorder moves clips; it never drops (58522) or doubles one
 *   5  a failed YouTube fetch is retried once, not three times at once (04AEWBdX_cs)
 *   6  the film's ready YouTube stock is asked first (mr9kK0_7x08 was never offered)
 *   7  the Judge is unchanged — strict, sentence-based, no planner words
 *   8  open-archive footage reaches the Judge instead of being refused for a missing name
 *   9  a sentence with no approved picture still gets its card
 *  10  a YouTube piece is played slower rather than repeat a window (vc_1d35c303ea)
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
  describeLlmFailure: (e: unknown) => String(e),
}));

import { invokeLLM } from "./_core/llm";
import { buildCinematicSceneInputs, type ProductionBeat, type SceneFacts } from "./cinematicPipelineInputs";
import { CHAPTER_CARD_FALLBACK } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { beatNamedEntitiesByKind, extractActionCue, extractPersonNamesFromText, extractVisualPlacePhrase } from "./videoPipeline";
import { editorialReorderScene } from "./editorialReorder";
import { limitLongShots, MIN_PIECE_SPEED } from "./longShotLimit";
import { emptyTimeline, timelineElementId, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { renderTimeline, speedThatFitsSource } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { judgeCandidateMetadata, type CandidateJudgeInput } from "./visualJudge";
import { buildBeatImagePrompt } from "./beatImageRelevanceGate";
import { isOpenArchiveVideoClip, isStockVideoClip } from "./documentaryStyle";
import { limitYoutubeShots, planYoutubePieces, type YoutubeSourceFacts } from "./youtubeShotLimit";
import { stockedRowsFirst } from "./youtubeShotStock";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const RENDERER = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");

const vclip = (id: string, start: number, end: number, sourceIn: number, sourceOut: number, extra: Partial<TimelineVideoClip> = {}): TimelineVideoClip =>
  ({
    id, kind: "video", source: { provider: "elon musk", archiveAssetId: 1 }, sourceIn, sourceOut,
    timelineStart: start, timelineEnd: end, transitionIn: "hard_cut", transitionOut: "hard_cut",
    previewSource: "asset", sceneIndex: 0, ...extra,
  }) as TimelineVideoClip;

/* ═══════════════ 1 — a short file holds its last frame (a real render) ═══════════════ */

describe("1 — a source too short for its slot is never replayed from its start", () => {
  const FMT = { widthPx: 160, heightPx: 90, fps: 25 };
  let dir = "";
  let source = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "v636-"));
    source = path.join(dir, "white_then_black.mp4");
    /** 1 s white, then 2 s black: a replay shows white again, a held last frame stays black. */
    await run(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=white:s=160x90:r=25:d=1",
      "-f", "lavfi", "-i", "color=black:s=160x90:r=25:d=2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ]);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function timeline(clip: Partial<TimelineVideoClip>, dur: number): ProjectTimeline {
    const t = emptyTimeline(636, FMT);
    t.durationSec = dur;
    t.tracks = [
      {
        kind: "VIDEO",
        clips: [{
          id: timelineElementId("clip", "v636", 0), kind: "video", source: { provider: "elon musk", archiveAssetId: 58281 },
          timelineStart: 0, timelineEnd: dur, transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
          ...clip,
        }],
      },
      { kind: "VOICE", clips: [] }, { kind: "MUSIC", clips: [] }, { kind: "SFX", clips: [] },
      { kind: "CAPTIONS", captions: [] }, { kind: "AMBIENT", clips: [] }, { kind: "TEXT", texts: [] },
      { kind: "GRAPHICS", graphics: [] },
    ] as never;
    return t;
  }
  async function lumaAt(file: string, sec: number): Promise<number> {
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-ss", String(sec), "-i", file, "-frames:v", "1",
      "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-",
    ]);
    return Number(/YAVG=([0-9.]+)/.exec(stderr)![1]);
  }
  async function render(name: string, clip: Partial<TimelineVideoClip>, dur: number): Promise<string> {
    const out = path.join(dir, `${name}.mp4`);
    await renderTimeline({ timeline: timeline(clip, dur), workDir: path.join(dir, `w_${name}`), outputPath: out, resolveMedia: async () => source });
    return out;
  }

  it("a 3 s file under a 7 s slot: the end is the held black frame, never the white opening again", async () => {
    const out = await render("short", { sourceIn: 0, sourceOut: 3 }, 7);
    expect(await lumaAt(out, 0.3)).toBeGreaterThan(200);
    expect(await lumaAt(out, 6.5)).toBeLessThan(40);
  }, 120_000);

  it("a second piece that starts past the file's end shows its last frame, not its first", async () => {
    const out = await render("p2", { sourceIn: 3.8, sourceOut: 7.6 }, 3.8);
    expect(await lumaAt(out, 0.5)).toBeLessThan(40);
    expect(await lumaAt(out, 3.2)).toBeLessThan(40);
  }, 120_000);

  it("the renderer no longer opens any input with -stream_loop", () => {
    expect(RENDERER).not.toContain('"-stream_loop"');
    expect(RENDERER).toContain("tpad=stop_mode=clone");
    expect(RENDERER).toContain("[ShotFreeze]");
  });
});

/* ═══════════════ 2 + 3 — split shots and the real source length ═══════════════ */

describe("2 — split shots run through their source once, in order", () => {
  it("58281: 8.16 s on screen over a 3.00 s file — pieces in order, none back at 0, none past the file", () => {
    const { clips } = limitLongShots({ clips: [vclip("vc_f1460aeff5", 44.38, 52.54, 0, 3.0)] });
    expect(clips.length).toBe(2);
    expect(clips.every((c) => c.speed === MIN_PIECE_SPEED)).toBe(true);
    expect(clips[0]!.sourceIn).toBe(0);
    expect(clips[1]!.sourceIn!).toBeGreaterThan(0);
    for (const c of clips) expect(c.sourceOut!).toBeLessThanOrEqual(3.0 + 1e-6);
  });

  it("58491: 7.80 s over 5.52 s — slowed (0.71×), second piece starts where the first ended", () => {
    const { clips } = limitLongShots({ clips: [vclip("vc_bb5e8ea1c3", 56.81, 64.61, 0, 5.52)] });
    expect(clips.length).toBe(2);
    const [a, b] = clips;
    expect(a!.speed).toBeCloseTo(5.52 / 7.8, 3);
    expect(b!.sourceIn!).toBeCloseTo(a!.sourceOut!, 2);
    expect(b!.sourceOut!).toBeLessThanOrEqual(5.52 + 1e-6);
  });

  it("58490: 5.27 s over 3.49 s — one shot slowed to 0.66×, no overlapping pieces", () => {
    const { clips } = limitLongShots({ clips: [vclip("vc_845d4c6071", 70.38, 75.65, 0, 3.49)] });
    expect(clips.length).toBe(1);
    expect(clips[0]!.speed).toBeCloseTo(3.49 / 5.27, 3);
    expect(clips[0]!.sourceOut).toBe(3.49);
  });

  it("a YouTube piece already slowed is not cut again as if it ran past its source", () => {
    const piece = vclip("vc_yt_p1", 8.02, 11.55, 0, 1.941, { speed: 0.55 });
    expect(limitLongShots({ clips: [piece] }).clips).toEqual([piece]);
  });
});

describe("3 — the planner reads each clip's measured length", () => {
  it("the probe before planning fills the memo `toPlannerClip` reads", () => {
    const at = PIPE.indexOf("const stillClips = new Set<string>();");
    const block = PIPE.slice(at, at + 2500);
    expect(block).toContain("await probeVideoStreamMeta(clipPath)");
    const planner = PIPE.slice(PIPE.indexOf("const toPlannerClip = (clipPath: string, beatIndex: number) => {"));
    expect(planner.slice(0, 6000)).toContain("const meta = memoisedVideoStreamMeta(clipPath);");
  });
});

/* ═══════════════ ShotFit unchanged ═══════════════ */

describe("ShotFit — the cases that already worked keep working", () => {
  it("a file a little short is still slowed once (635: 5.36 s over 4.00 s)", () => {
    expect(speedThatFitsSource({ kind: "video", sourceIn: 0 }, 4.0, 5.36)).toBeCloseTo(0.7462, 3);
  });
  it("a file long enough is untouched", () => {
    expect(speedThatFitsSource({ kind: "video", sourceIn: 0 }, 6.0, 5.0)).toBeNull();
  });
  it("a shot slightly longer than its source is still slowed rather than split (635: 8.30 over 7.98)", () => {
    const { clips } = limitLongShots({ clips: [vclip("s", 0, 5.1, 0, 4.9)] });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.speed).toBeCloseTo(4.9 / 5.1, 3);
  });
});

/* ═══════════════ 4 — reorder keeps every clip ═══════════════ */

describe("4 — a reorder moves clips; it never drops or doubles one", () => {
  const clips = ["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e_58522.mp4"];
  const ask = () => editorialReorderScene(1, "scene", "film", 30, clips, [3, 3, 3, 3, 1.5], [0, 2, 1, 6, 6], undefined);
  const answer = (order: unknown) =>
    vi.mocked(invokeLLM).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ order }) } }] } as never);

  it("video 636's answer [0,2,1,3] for five clips is refused — the approved fifth clip stays", async () => {
    answer([0, 2, 1, 3]);
    const r = await ask();
    expect(r.clips).toEqual(clips);
    expect(r.clipBeatIndices).toEqual([0, 2, 1, 6, 6]);
  });

  it("an answer that doubles a clip is refused", async () => {
    answer([0, 1, 1, 2, 3]);
    expect((await ask()).clips).toEqual(clips);
  });

  it("a true reordering is applied, each clip keeping its own sentence", async () => {
    answer([1, 0, 2, 3, 4]);
    const r = await ask();
    expect(r.clips).toEqual(["b.mp4", "a.mp4", "c.mp4", "d.mp4", "e_58522.mp4"]);
    expect(r.clipBeatIndices).toEqual([2, 0, 1, 6, 6]);
  });
});

/* ═══════════════ 5 + 6 — YouTube downloads and timing ═══════════════ */

describe("5 — one retry of a failed YouTube fetch, not one per waiting caller", () => {
  it("the first retry takes the fragment over; the others wait for it", () => {
    const at = PIPE.indexOf("const hadEarlierFetch = youtubeFragmentsFetched.has(fragment);");
    expect(at).toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 1800);
    expect(block).toContain("keepYoutubeFragmentWhenFetched(fragment, outPath, thisTransfer)");
    expect(block.indexOf("keepYoutubeFragmentWhenFetched")).toBeLessThan(block.indexOf("downloadYouTubeCCClip("));
  });
});

describe("6 — the film's ready YouTube stock is offered before anything that needs a download", () => {
  type Row = { id: string };
  const rows: Row[] = [{ id: "04AEWBdX_cs" }, { id: "tj7Sd7fs6JQ" }, { id: "xbhqH17QD4g" }, { id: "mr9kK0_7x08" }, { id: "kUmkbzQ-BS0" }];
  const ready = new Set(["mr9kK0_7x08", "kUmkbzQ-BS0"]);

  it("ready stock first, the ranker's order kept inside each group", () => {
    expect(stockedRowsFirst(rows, (r) => ready.has(r.id)).map((r) => r.id)).toEqual([
      "mr9kK0_7x08", "kUmkbzQ-BS0", "04AEWBdX_cs", "tj7Sd7fs6JQ", "xbhqH17QD4g",
    ]);
  });

  it("nothing is dropped and nothing is added", () => {
    expect(stockedRowsFirst(rows, () => false)).toEqual(rows);
    expect(new Set(stockedRowsFirst(rows, (r) => ready.has(r.id)))).toEqual(new Set(rows));
  });

  it("the beat's YouTube loop reads the rows in that order, within its five", () => {
    /** W2 (round after 7572ab2) — ready stock first, now with the sentence's serving videos exempt from the five. */
    expect(PIPE).toContain("const order = beatRowsInStockOrder(byChannel, {");
    expect(PIPE).toContain("return [...order.first, ...order.rest];");
  });
});

/* ═══════════════ 7 + 8 — Judge unchanged; open archives reach it ═══════════════ */

const base = (p: string, extra: Partial<CandidateJudgeInput> = {}): CandidateJudgeInput => ({
  path: p,
  sourceQuery: "tesla factory exterior",
  beatText: "In 2008, Tesla was just weeks from bankruptcy.",
  videoTitle: "How Elon Musk Built Tesla Into a Global Brand",
  personTopic: true,
  primaryPerson: "Elon Musk",
  requireBeatMatch: false,
  scriptAnchored: true,
  entityRules: [],
  signals: { beatMatch: 1, queryInBeat: true, providerTitleSharesNothing: false },
  where: "s0b0",
  ...extra,
});

describe("7 — the Judge is as strict as before", () => {
  it("the prompt asks about the sentence and carries no planner shot", () => {
    const prompt = buildBeatImagePrompt("Skeptics were betting against it.", 3, "Tesla film", "scene text", "PLANNED: stock exchange traders");
    const text = JSON.stringify(prompt);
    expect(text).toContain("Skeptics were betting against it.");
    expect(text).not.toContain("stock exchange traders");
  });

  it("commercial stock without the person is still refused before anyone looks", () => {
    expect(judgeCandidateMetadata(base("/w/scene_0_b0_pexels_123.mp4")).reason).toBe("stock_without_person");
  });
});

describe("8 — open-archive footage reaches the picture editor", () => {
  it("Internet Archive and Wikimedia films are open archives, not commercial stock", () => {
    expect(isOpenArchiveVideoClip("scene_0_b0_primary_hist_archive_0__pid_internet_archive-c5e7.mp4")).toBe(true);
    expect(isOpenArchiveVideoClip("scene_1_b3_primary_arch_wikivid_0__pid_wikimedia-87da.mp4")).toBe(true);
    expect(isOpenArchiveVideoClip("scene_0_b0_pexels_123.mp4")).toBe(false);
    expect(isOpenArchiveVideoClip("scene_1_b5_curated_a58281.mp4")).toBe(false);
    /** The grade still treats them as stock — unchanged. */
    expect(isStockVideoClip("scene_0_b0_primary_hist_archive_0__pid_internet_archive-c5e7.mp4")).toBe(true);
  });

  it("a Tesla film without 'Musk' in its name is no longer refused as stock_without_person", () => {
    const v = judgeCandidateMetadata(base("/w/scene_0_b0_primary_hist_archive_0__pid_internet_archive-c5e7.mp4"));
    expect(v.reason).not.toBe("stock_without_person");
    expect(v.decision).toBe("ACCEPT");
  });

  it("a sentence that names a person still asks for evidence of that person", () => {
    const musk = {
      id: "musk", kind: "person", fullName: "Elon Musk", mentionRe: /elon musk/i, clipMustMatchRe: /musk/i,
      stockQueries: [], youtubeQueries: [],
    } as never;
    const v = judgeCandidateMetadata(
      base("/w/scene_1_b1_primary_arch_archive_0__pid_internet_archive-0f73.mp4", {
        beatText: "Pundits doubted Elon Musk's audacious vision.",
        entityRules: [musk],
      })
    );
    expect(v.decision).toBe("REJECT");
    expect(v.reason).toBe("entity_evidence");
  });
});

/* ═══════════════ 9 — the card stays where nothing was approved ═══════════════ */

describe("9 — a sentence without an approved picture still gets its card", () => {
  it("the second sentence has no clip: it gets the chapter card (CHAPTER_CARD_FALLBACK)", () => {
    const texts = [
      "Tesla began as a small company with a bold plan for electric cars.",
      "What crucial external forces would soon tilt the scales?",
    ];
    const beats: ProductionBeat[] = texts.map((text, index) => ({
      index, text, searchQuery: "", powerWord: "", keywords: [], holdSec: 4, visualDescription: "",
      voiceStartSec: index * 4, voiceEndSec: index * 4 + 4,
    }));
    const built = buildCinematicSceneInputs({
      scenes: [{
        scene: { index: 0, text: texts.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 },
        beats,
        clips: [
          {
            facts: { localPath: "/tmp/v636-card-0.mp4", durationSec: 10, widthPx: 1920, heightPx: 1080 },
            adoption: { provider: "internet_archive", providerAssetId: "ia-0", sourceUrl: "https://archive.invalid/0.mp4", assetTitle: "shot", query: "shot" },
          },
          null,
        ] as SceneFacts["clips"],
      }],
      extractors: {
        people: (t: string) => extractPersonNamesFromText(t),
        place: (t: string) => extractVisualPlacePhrase(t),
        action: (t: string) => extractActionCue(t),
        namedEntities: (t: string) => beatNamedEntitiesByKind(t),
      },
      filmSubject: "Tesla",
    });
    const cards = (built.primaryGraphics ?? []).map((g) => g.graphic);
    expect(cards.length).toBe(1);
    expect(cards[0]!.graphicType).toBe("chapter_card");
    expect(cards[0]!.reason.startsWith(CHAPTER_CARD_FALLBACK)).toBe(true);
  });
});

/* ═══════════════ 10 — YouTube pieces slower rather than repeated ═══════════════ */

describe("10 — a YouTube piece is played slower rather than repeat a window", () => {
  const fourSeconds: YoutubeSourceFacts = { sourceDurationSec: 4.0, cutsSec: [], measured: true };

  it("vc_1d35c303ea: 7.06 s from one 4.00 s shot — two different windows at 0.55×", () => {
    const plan = planYoutubePieces({ inSec: 0, durationSec: 7.06, facts: fourSeconds, slowRatherThanRepeat: true });
    expect(plan.pieces).toHaveLength(2);
    expect(plan.distinct).toBe(2);
    const [a, b] = plan.pieces;
    expect(a!.speed).toBeCloseTo(0.55, 2);
    expect(a!.inSec + a!.durationSec * a!.speed!).toBeLessThanOrEqual(b!.inSec + 1e-6);
    expect(b!.inSec + b!.durationSec * b!.speed!).toBeLessThanOrEqual(4.0 + 1e-6);
    expect(plan.pieces.every((p) => p.durationSec <= 5)).toBe(true);
  });

  it("between two cards (their invisible grounds may not take its time) the timeline gets the slowed pieces", () => {
    const yt = vclip("vc_1d35c303ea", 8.02, 15.08, 0, 4.0, { source: { provider: "youtube_cc", providerAssetId: "xbhqH17QD4g" } as never });
    const before = vclip("vc_cc29ed21a0_graphic1", 4.56, 8.02, 0, 3.46);
    const after = vclip("vc_1d35c303ea_graphic2", 15.08, 21.01, 0, 4.0);
    const { clips } = limitYoutubeShots({ clips: [before, yt, after], youtube: new Map([["vc_1d35c303ea", fourSeconds]]) });
    const pieces = clips.filter((c) => c.id.startsWith("vc_1d35c303ea_p"));
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.sourceIn).not.toBe(pieces[1]!.sourceIn);
    expect(pieces[0]!.sourceOut!).toBeLessThanOrEqual(pieces[1]!.sourceIn! + 1e-6);
    expect(pieces.every((p) => p.speed != null && p.speed < 1)).toBe(true);
    /** The span is unchanged. */
    expect(pieces[0]!.timelineStart).toBe(8.02);
    expect(pieces[1]!.timelineEnd).toBe(15.08);
  });

  it("with a real shot beside it the old rule stands: the neighbour takes the time, nothing is slowed", () => {
    const yt = vclip("yt", 0, 7.06, 0, 4.0);
    const next = vclip("arch", 7.06, 12, 0, 6);
    const { clips } = limitYoutubeShots({ clips: [yt, next], youtube: new Map([["yt", fourSeconds]]) });
    expect(clips.filter((c) => c.id.startsWith("yt")).every((c) => c.speed == null)).toBe(true);
  });
});
