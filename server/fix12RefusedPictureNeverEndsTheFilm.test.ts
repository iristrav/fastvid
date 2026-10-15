/**
 * FIX 1+2 — A REFUSED PICTURE NEVER ON ITS OWN ENDS THE FILM.
 *
 * Refusing a picture is allowed; using a refused or unchecked one is not; refusing the whole film
 * only because one picture was refused is not allowed while a safe replacement exists. These cases
 * run the pipeline's own rungs (`placeGenericMovingFallbacks`, `checkPictureForSentence`), the
 * timeline's own graphic placement (`placePrimaryGraphics`), the coverage measurement and the
 * delivery gate. No model, no network: the two checks are answered by the test, the archive is a
 * stand-in list, and the files are small real clips made with ffmpeg.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { createBeatRelevanceLedger, beatRelevanceBeatKey } from "./beatVisualRelevance";
import { primaryGraphicForBeat, intentFrom } from "./cinematicPipelineInputs";
import { filmSubjectChapterCard } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { deliveryGate, type DeliveryClipFact } from "./deliveryGate";
import { placePrimaryGraphics } from "./edlToTimeline";
import { runMandatoryChecks } from "./mandatoryPictureChecks";
import { emptyTimeline, graphicsTrack, videoTrack, type ProjectTimeline, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";
import { sentenceCoverage } from "./sentenceCoverage";

const archive = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; title: string | null; mediaType: "video" | "image"; mediaStatus: string | null; isActive: number; durationSec: number | null; storageUrl: string; storageKey: string | null; mimeType: string; tags?: string[] }>,
  file: "",
}));
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  listActiveVideoArchiveAssetsByTag: async (tag: string) => (tag === "generic" ? archive.rows : []),
}));
vi.mock("./archiveAssetLoad", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./archiveAssetLoad")>()),
  loadArchiveAssetFile: async () => ({ ok: true, result: { localPath: archive.file, cleanup: () => undefined } }),
}));

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
type VP = typeof import("./videoPipeline");
let vp: VP;
let root = "";
let logs: string[] = [];

const makeClip = (file: string, source: string) =>
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${source}=size=320x180:rate=30:duration=8`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);

beforeAll(async () => {
  vp = await import("./videoPipeline");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fix12-never-ends-"));
  archive.file = path.join(root, "archive_generic.mp4");
  await makeClip(archive.file, "testsrc2");
}, 120_000);
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* not worth a failure */ } });
afterEach(() => {
  vi.restoreAllMocks();
  archive.rows = [];
});

const capture = () => {
  logs = [];
  for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
};

const scene = { index: 0, text: "A line nothing could picture.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 };
const beat = { index: 0, text: "A line nothing could picture.", holdSec: 3, keywords: [] as string[] };
const GENERIC_ROW = { id: 418, title: "slow clouds", mediaType: "video" as const, mediaStatus: "READY", isActive: 1, durationSec: 8, storageUrl: "", storageKey: null, mimeType: "video/mp4", tags: ["generic"] };

/** The sentence's own candidates the picture editor never judged in its turn (`noteUnjudgedFallback`), as real files. */
async function candidates(dir: string, n: number): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `scene_0_cand${i}__pid_pexels-${String(i).padStart(16, "c")}.mp4`);
    await makeClip(p, i % 2 ? "testsrc" : "smptebars");
    out.push(p);
  }
  return out;
}

async function placeFloor(workDir: string, opts: {
  candidates: string[];
  check: (clipPath: string) => Promise<boolean>;
  /** "production": the pipeline's own answer (`drawnPictureCanStandInForBeat`) */
  graphicStandsIn?: boolean | "production";
  mainSubject?: string;
}) {
  const dedup = vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
  if (opts.mainSubject) dedup.mainSubject = opts.mainSubject;
  dedup.sceneBeatsBySceneIndex.set(0, [beat] as never);
  for (const c of opts.candidates) vp.noteUnjudgedFallback(dedup, 0, 0, c);
  const results: Array<{ clips: string[]; beatDurations: number[]; clipBeatIndices: number[] } | undefined> = [{ clips: [], beatDurations: [], clipBeatIndices: [] }];
  const asked: string[] = [];
  capture();
  const tally = await vp.placeGenericMovingFallbacks(
    [scene as never], results as never, dedup, workDir, "Film",
    async (_s, _b, clipPath) => (asked.push(clipPath), opts.check(clipPath)),
    opts.graphicStandsIn === "production" ? undefined : () => (opts.graphicStandsIn as boolean | undefined) ?? false
  );
  return { tally, results: results[0]!, asked, dedup };
}

/** A clip of the timeline, as the pipeline writes it: placed for a sentence, with both marks. */
function tlClip(id: string, start: number, end: number, beatIndex: number, marks: Partial<TimelineVideoClip["source"]> = {}): TimelineVideoClip {
  return {
    id, kind: "video",
    source: { provider: "youtube_cc", providerAssetId: `yt_${id}`, mediaUrl: `/w/${id}.mp4`, archiveAssetId: 59000 + beatIndex, contentApproval: "judge_fit", textCheck: "clean", ...marks },
    sourceIn: 0, sourceOut: end - start, sceneIndex: 0, beatIndex,
    timelineStart: start, timelineEnd: end,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
  } as TimelineVideoClip;
}

function timelineOf(clips: TimelineVideoClip[], graphics: TimelineGraphic[], sentences: Array<[number, number, number, string]>): ProjectTimeline {
  const t = emptyTimeline(1);
  t.tracks = [
    { kind: "VIDEO", clips },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", graphics },
  ] as ProjectTimeline["tracks"];
  t.durationSec = Math.max(...sentences.map((s) => s[2]));
  t.sentences = sentences.map(([beatIndex, startSec, endSec, text]) => ({ sceneIndex: 0, beatIndex, startSec, endSec, timingBasis: "measured" as const, text }));
  return t;
}

/** The delivery gate on a timeline, as the render worker asks it for a film the pipeline queued. */
function gateOn(t: ProjectTimeline, placeholderIds: string[] = []) {
  const clips: DeliveryClipFact[] = videoTrack(t).filter((c) => !c.disabled).map((c) => ({
    clipId: c.id, archiveAssetId: c.source.archiveAssetId ?? null, provider: c.source.provider, providerAssetId: c.source.providerAssetId ?? null,
    resolved: true, fromArchive: true, isPlaceholder: placeholderIds.includes(c.id),
    contentApproval: c.source.contentApproval ?? null, textCheck: c.source.textCheck ?? null,
    /** as the render worker reads it */
    hidden: typeof c.transform?.opacity === "number" && c.transform.opacity <= 0,
  }));
  return deliveryGate({ videoId: 1, route: "cinematic_timeline", timelineExists: true, clips, delivered: null, assetsOnly: true, enforcePictureChecks: true, sentenceCoverage: sentenceCoverage(t) });
}

/* ═══════════════════════ 1. refused → the alternative ═══════════════════════ */

describe("1. a picture is refused, an alternative passes, the film is delivered", () => {
  it("the refused candidate is not placed; the checked generic clip is, and the gate delivers on it", async () => {
    const workDir = path.join(root, "one");
    const [refused] = await candidates(path.join(workDir, "cands"), 1);
    archive.rows = [GENERIC_ROW];
    const { tally, results, asked } = await placeFloor(workDir, { candidates: [refused!], check: async (p) => p !== refused });
    expect(asked[0]).toBe(refused);
    expect(tally).toEqual({ placed: 1, failed: 0 });
    expect(results.clips).toHaveLength(1);
    expect(results.clips[0]).not.toBe(refused);
    expect(path.basename(results.clips[0]!)).toMatch(/__pid_generic_footage-/);
    expect(results.clipBeatIndices).toEqual([0]);
    /** what the timeline holds for that sentence: the checked clip, both marks — delivered */
    const t = timelineOf([tlClip("vc_generic", 0, 4, 0, { provider: "generic_footage" })], [], [[0, 0, 4, beat.text]]);
    const v = gateOn(t);
    expect(v.allow, v.allow ? "" : v.failures.map((f) => f.code).join(",")).toBe(true);
  }, 300_000);
});

/* ═══════════════════════ 2. text check missing → not used, alternative tried ═══════════════════════ */

describe("2. the content check passes but the text check is missing: the picture is not used, an alternative is tried", () => {
  it("runMandatoryChecks: a fit with no text answer fails, and the picture editor is not even asked", async () => {
    let judged = 0;
    const o = await runMandatoryChecks({
      recordedContent: () => "fit",
      recordedText: () => null,
      checkText: async () => "unchecked",
      judgeContent: async () => (judged++, "fit"),
    });
    expect(o.pass).toBe(false);
    expect(o.reason).toBe("the text check gave no answer");
    expect(judged).toBe(0);
  });

  it("on the emergency rung: the candidate fails on its missing text check and the generic clip is placed instead", async () => {
    const workDir = path.join(root, "two");
    const [fitNoText] = await candidates(path.join(workDir, "cands"), 1);
    archive.rows = [GENERIC_ROW];
    const { results, asked } = await placeFloor(workDir, {
      candidates: [fitNoText!],
      check: async (p) =>
        p === fitNoText
          ? (await runMandatoryChecks({ recordedContent: () => "fit", recordedText: () => null, checkText: async () => "unchecked", judgeContent: async () => "fit" })).pass
          : true,
    });
    expect(asked).toContain(fitNoText);
    expect(results.clips).not.toContain(fitNoText);
    expect(results.clips).toHaveLength(1);
    expect(path.basename(results.clips[0]!)).toMatch(/__pid_generic_footage-/);
  }, 300_000);
});

/* ═══════════════════════ 3. every picture refused → the existing fallback ═══════════════════════ */

describe("3. the first and the next picture are refused: the existing fallback is used", () => {
  it("no colour field where a data graphic can stand in: the sentence is left to the graphic, nothing is drawn as a placeholder", async () => {
    const workDir = path.join(root, "three");
    const cands = await candidates(path.join(workDir, "cands"), 2);
    archive.rows = [];
    const { tally, results, asked } = await placeFloor(workDir, { candidates: cands, check: async () => false, graphicStandsIn: true });
    expect(asked).toEqual(cands);
    expect(results.clips).toEqual([]);
    expect(tally).toEqual({ placed: 0, failed: 0 });
    expect(logs.some((l) => l.includes("s0b0 no colour field — a data graphic, map or card drawn from the sentence's own words is its picture on the timeline"))).toBe(true);
    expect(logs.some((l) => l.includes("graphicIsPicture=1"))).toBe(true);
    /** no synthetic file was made */
    expect(fs.readdirSync(workDir).filter((f) => f.includes("synthetic_placeholder"))).toEqual([]);
  }, 300_000);

  it("the pipeline's question and the timeline's answer agree: a sentence with a figure can stand in, a plain one cannot", () => {
    const dedup = vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
    const plain = { index: 0, text: "The town was quiet that morning.", holdSec: 4, keywords: [] as string[] };
    const counted = { index: 1, text: "Inflation reached 10% in 2022.", holdSec: 4, keywords: [] as string[] };
    const sc = { ...scene, text: `${plain.text} ${counted.text}` };
    expect(vp.graphicCanStandInForBeat(dedup, sc as never, counted as never)).toBe(true);
    expect(vp.graphicCanStandInForBeat(dedup, sc as never, plain as never)).toBe(false);
    expect(primaryGraphicForBeat(intentFrom(counted as never, 0, 1, null, {}), sc as never, 0, 4)).not.toBeNull();
  });
});

/* ═══════════════════════ 4. the fallback covers the whole sentence ═══════════════════════ */

describe("4. the fallback covers the whole sentence, on its own time", () => {
  it("the graphic fills exactly the sentence's spoken window; coverage says covered; the gate delivers", () => {
    const sc = { ...scene, text: "Sales began. Inflation reached 10% in 2022. Then came the recall." };
    const counted = { index: 1, text: "Inflation reached 10% in 2022.", holdSec: 4, keywords: [] as string[] };
    const graphic = primaryGraphicForBeat(intentFrom(counted as never, 0, 1, null, {}), sc as never, 3, 7.5);
    expect(graphic).not.toBeNull();
    const clips = [tlClip("vc_a", 0, 3, 0), tlClip("vc_c", 7.5, 10, 2)];
    const graphics: TimelineGraphic[] = [];
    const placed = placePrimaryGraphics(clips, graphics, [{ beatId: "s0b1", startSec: 3, endSec: 7.5, graphic: graphic! }]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.graphic.start).toBe(3);
    expect(placed[0]!.graphic.end).toBe(7.5);
    expect(placed[0]!.graphic.data).toMatchObject({ primaryVisual: true, sceneIndex: 0, beatIndex: 1 });

    const t = timelineOf(clips, graphics, [[0, 0, 3, "Sales began."], [1, 3, 7.5, counted.text], [2, 7.5, 10, "Then came the recall."]]);
    expect(graphicsTrack(t)).toHaveLength(1);
    const row = sentenceCoverage(t).sentences.find((r) => r.key === "s0b1")!;
    expect(row.status).toBe("covered");
    expect(row.contentGraphicSec).toBe(4.5);
    expect(row.spokenSec).toBe(4.5);
    const v = gateOn(t);
    expect(v.allow, v.allow ? "" : v.failures.map((f) => `${f.code}: ${f.detail}`).join("; ")).toBe(true);
  });
});

/* ═══════════════════════ 5. no valid fallback → delivered, named ═══════════════════════ */

/** VIDEO 659 (owner's rule, 15 October: a video must always succeed) — named for the editor, never a refused film. */
describe("5. no valid fallback at all: the film is delivered, and what is unchecked is named — never passed off as cover", () => {
  it("a sentence held only by the colour field: uncovered, named as SENTENCE_WITHOUT_CHECKED_PICTURE, delivered", () => {
    const t = timelineOf(
      [tlClip("vc_a", 0, 3, 0), tlClip("vc_field", 3, 7, 1, { provider: "synthetic_placeholder", contentApproval: "generic_footage", textCheck: "unchecked" })],
      [],
      [[0, 0, 3, "Sales began."], [1, 3, 7, "A line nothing could picture."]]
    );
    const row = sentenceCoverage(t).sentences.find((r) => r.key === "s0b1")!;
    expect(row.status).toBe("uncovered");
    const v = gateOn(t, ["vc_field"]);
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.find((p) => p.code === "SENTENCE_WITHOUT_CHECKED_PICTURE")?.detail).toContain("s0b1");
  });

  it("a picture whose check is missing on the timeline is named at delivery (the net stays), the film delivered", () => {
    const t = timelineOf([tlClip("vc_a", 0, 3, 0, { textCheck: undefined })], [], [[0, 0, 3, "Sales began."]]);
    const v = gateOn(t);
    expect(v.allow).toBe(true);
    if (v.allow) expect(v.qualityProblems.map((p) => p.code)).toContain("PICTURE_NOT_CHECKED");
  });
});

/* ═══════════════════════ 6. VIDEO 659 — a drawn card instead of a colour field ═══════════════════════ */

describe("6. VIDEO 659: a sentence no picture passes for gets a drawn card, never a colour field, and the film is delivered", () => {
  /** four of 659's sentences: no figure, no map — 659 gave each a colour field */
  const S659 = [
    "Skyrocketing energy bills forced millions to choose between heating and eating.",
    "Daily life was consumed by worry as heating costs soared.",
    "When the European Central Bank, under Christine Lagarde, announced its response, markets held their breath.",
  ];

  it("the pipeline's question: every 659 sentence can be drawn — its own card, or the film's subject", () => {
    const dedup = vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
    dedup.mainSubject = "Inflation in Europe";
    for (const [i, text] of S659.entries()) {
      const b = { index: i, text, holdSec: 5, keywords: [] as string[] };
      expect(vp.drawnPictureCanStandInForBeat(dedup, { ...scene, text: S659.join(" ") } as never, b as never), text).toBe(true);
    }
  });

  it("the data-graphic question is unchanged: a plain sentence still has no data graphic (the generated-image rung asks this one)", () => {
    const dedup = vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
    dedup.mainSubject = "Inflation in Europe";
    const plain = { index: 0, text: S659[1], holdSec: 5, keywords: [] as string[] };
    expect(vp.graphicCanStandInForBeat(dedup, { ...scene, text: S659[1] } as never, plain as never)).toBe(false);
  });

  it("on the floor rung with the production answer: every candidate refused, no generic clip — no colour field is made", async () => {
    const workDir = path.join(root, "six");
    const cands = await candidates(path.join(workDir, "cands"), 1);
    archive.rows = [];
    const { tally, results } = await placeFloor(workDir, { candidates: cands, check: async () => false, graphicStandsIn: "production", mainSubject: "Inflation in Europe" });
    expect(results.clips).toEqual([]);
    expect(tally).toEqual({ placed: 0, failed: 0 });
    expect(logs.some((l) => l.includes("graphicIsPicture=1"))).toBe(true);
    expect(fs.readdirSync(workDir).filter((f) => f.includes("synthetic_placeholder"))).toEqual([]);
  }, 300_000);

  it("a checked generic clip still comes before the card: real moving footage first", async () => {
    const workDir = path.join(root, "six-generic");
    const cands = await candidates(path.join(workDir, "cands"), 1);
    archive.rows = [GENERIC_ROW];
    const { tally, results } = await placeFloor(workDir, { candidates: cands, check: async (p) => !cands.includes(p), graphicStandsIn: "production", mainSubject: "Inflation in Europe" });
    expect(tally).toEqual({ placed: 1, failed: 0 });
    expect(path.basename(results.clips[0]!)).toMatch(/__pid_generic_footage-/);
  }, 300_000);

  it("on the timeline: the card stands under the sentence, its invisible ground is not an unchecked picture, and the film is delivered without SENTENCE_WITHOUT_CHECKED_PICTURE", () => {
    /** the neighbour's ground the card is cut from carries no checks, as 659's colour field did */
    const clips = [
      tlClip("vc_a", 0, 3, 0),
      tlClip("vc_c", 8, 11, 2, { provider: "synthetic_placeholder", contentApproval: "generic_footage", textCheck: "unchecked" }),
    ];
    const graphics: TimelineGraphic[] = [];
    const card = filmSubjectChapterCard("Inflation in Europe", 3, 5)!;
    expect(card).not.toBeNull();
    const placed = placePrimaryGraphics(clips, graphics, [{ beatId: "s0b1", startSec: 3, endSec: 8, graphic: card }]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.backdrop.transform?.opacity).toBe(0);
    const t = timelineOf(clips, graphics, [[0, 0, 3, "Sales began."], [1, 3, 8, S659[1]!], [2, 8, 11, "Then came the recall."]]);
    const row = sentenceCoverage(t).sentences.find((r) => r.key === "s0b1")!;
    expect(row.cardSec).toBe(5);
    const v = gateOn(t);
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    const named = v.qualityProblems.map((p) => `${p.code} ${p.detail}`);
    expect(named.filter((p) => p.startsWith("SENTENCE_WITHOUT_CHECKED_PICTURE") && p.includes("s0b1"))).toEqual([]);
    expect(named.filter((p) => p.startsWith("PICTURE_NOT_CHECKED") && p.includes("_graphic"))).toEqual([]);
    /** the neighbour's own unchecked clip is still named — the net stays for what is on screen */
    expect(named.some((p) => p.startsWith("PICTURE_NOT_CHECKED") && p.includes("clip=vc_c "))).toBe(true);
  });
});

/* ═══════════════════════ the wiring: what the checks established reaches the timeline ═══════════════════════ */

describe("a picture that passed both checks reaches the timeline with both marks", () => {
  it("an archive picture whose text verdict came from its archive row is recorded as clean (it used to reach the gate as unchecked)", async () => {
    const clipPath = "/w/scene_0_b0_arch__pid_curated-00000000000000a7.mp4";
    const key = vp.clipContentKey(clipPath);
    const dedup = {
      beatRelevance: createBeatRelevanceLedger(),
      archiveAssetsCache: new Map([[0, [{ id: 77, hasBakedEditText: 0 }]]]),
      sourcingCache: { lineage: { resolve: () => ({ archiveAssetId: 77 }) } },
    } as never as Parameters<VP["checkPictureForSentence"]>[0];
    vp.noteApprovedKeyForBeat(dedup, 0, 0, key);
    expect(vp.textCheckForClip(dedup, key)).toBeNull();
    capture();
    const out = await vp.checkPictureForSentence(dedup, { index: 0, text: "x" }, { index: 0, text: "x" }, clipPath, "/w", "Film", "test");
    expect(out).toMatchObject({ pass: true, content: "fit", text: "clean", askedText: false, askedContent: false });
    expect(vp.textCheckForClip(dedup, key)).toBe("clean");
  });

  it("an acceptable verdict read from the relevance ledger is recorded where the timeline reads judge_acceptable", async () => {
    const clipPath = "/w/scene_0_b0_led__pid_pexels-00000000000000b8.mp4";
    const key = vp.clipContentKey(clipPath);
    const ledger = createBeatRelevanceLedger();
    ledger.byBeat.set(beatRelevanceBeatKey(0, 0, "path", clipPath), {
      ctx: { sceneIndex: 0, beatIndex: 0, beatText: "x" },
      decision: { verdict: "acceptable", allowed: true, reprieved: false, cached: false, depicts: "", reason: "test", evaluated: true },
    } as never);
    const dedup = { beatRelevance: ledger, archiveAssetsCache: new Map() } as never as Parameters<VP["checkPictureForSentence"]>[0];
    vp.noteTextCheck(dedup, key, "overlay");
    expect(vp.pictureAcceptableForBeat(dedup, 0, 0, key)).toBe(false);
    capture();
    const out = await vp.checkPictureForSentence(dedup, { index: 0, text: "x" }, { index: 0, text: "x" }, clipPath, "/w", "Film", "test");
    expect(out.pass).toBe(true);
    expect(vp.pictureAcceptableForBeat(dedup, 0, 0, key)).toBe(true);
    expect(vp.pictureApprovedForBeat(dedup, 0, 0, key)).toBe(false);
  });

  it("a picture that fails is recorded nowhere as approved", async () => {
    const clipPath = "/w/scene_0_b0_bad__pid_pexels-00000000000000c9.mp4";
    const key = vp.clipContentKey(clipPath);
    const dedup = { beatRelevance: createBeatRelevanceLedger(), archiveAssetsCache: new Map() } as never as Parameters<VP["checkPictureForSentence"]>[0];
    vp.noteTextCheck(dedup, key, "fills_picture");
    capture();
    const out = await vp.checkPictureForSentence(dedup, { index: 0, text: "x" }, { index: 0, text: "x" }, clipPath, "/w", "Film", "test");
    expect(out.pass).toBe(false);
    expect(vp.pictureApprovedForBeat(dedup, 0, 0, key)).toBe(false);
    expect(vp.pictureAcceptableForBeat(dedup, 0, 0, key)).toBe(false);
  });
});
