/**
 * THE MEASURED TIMING ROUTE — what the hard quality gate's "every sentence covered in time" rests on.
 *
 * Three faults found on the way the spoken windows reach `ProjectTimeline.sentences`, each with the
 * render that showed it:
 *
 *   1. cinematicPipelineInputs.ts recorded a sentence's end UNCLAMPED while its beat (and so its clip)
 *      was clamped to the scene's audio. The TTS split trims a scene's leading silence, so a scene's
 *      clock is a few hundredths shorter than its word span: the last sentence of every scene asked
 *      for cover past its own clip and read as `partial`.
 *   2. voiceTtsAlignment.ts returned null without a word when ElevenLabs refused the with-timestamps
 *      call. Video 645: HTTP 401 quota_exceeded, Fish Audio spoke the text (no timestamps), eleven
 *      sentences laid out — and nothing in the log said why.
 *   3. videoPipeline.ts reported `providers=elevenlabs×1` for that narration, because the selected-voice
 *      branch of `generateVoiceover` named ElevenLabs whatever `synthesizeElevenLabsVoice` fell back to.
 *
 * Nothing here invents a start or an end: a window is measured (ElevenLabs timestamps) or it is the
 * planner's estimate and stays `estimated`, which the gate does not pass.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * videoPipeline.ts speaks to ElevenLabs and Fish Audio through node-fetch, not the global fetch:
 * the module is replaced here so that §3 can answer 401 for ElevenLabs and real audio for Fish Audio
 * without a network. §2's `fetchElevenLabsWithTimestamps` (voiceTtsAlignment.ts) uses the global fetch.
 */
const netState = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: { body?: string }) => Promise<Response>) }));
vi.mock("node-fetch", () => ({
  default: async (url: string | URL, init?: { body?: string }) => {
    if (!netState.handler) throw new Error(`node-fetch is replaced in this test: ${String(url)}`);
    return netState.handler(String(url), init);
  },
}));
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildCinematicSceneInputs,
  type AdoptedClipFacts,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import type { Scene } from "./pipeline/types";
import { buildTtsSceneBeatMap, fetchElevenLabsWithTimestamps, loadStoredTtsAlignment } from "./voiceTtsAlignment";
import { loadNarrationMeta } from "./narrationWordTiming";
import { hardVisualRuleFailures } from "./deliveryGate";
import { buildMarkedSsml, type MarkTimepoint } from "./ttsMarkAlignment";
import { sentenceCoverage } from "./sentenceCoverage";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

/* ───────────── fixtures ───────────── */

function scene(index: number, duration: number): Scene {
  return { index, text: "Tesla unveiled the Roadster. It changed the industry.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration, ...({} as Record<string, never>) };
}
/** A MEASURED beat: the TTS's own word boundaries, scene-local. */
function measuredBeat(index: number, voiceStartSec: number, voiceEndSec: number): ProductionBeat {
  return {
    index,
    text: `Sentence ${index} of the narration.`,
    searchQuery: "tesla roadster",
    powerWord: "roadster",
    keywords: ["tesla", "roadster"],
    holdSec: Math.max(3, voiceEndSec - voiceStartSec),
    voiceStartSec,
    voiceEndSec,
    visualDescription: "",
  };
}
function adoption(id: string): AdoptionFacts {
  return { provider: "youtube_cc", providerAssetId: id, sourceUrl: `https://youtu.be/${id}`, assetTitle: "Roadster", query: "tesla roadster", contentApproval: "judge_fit" };
}
function facts(durationSec: number): AdoptedClipFacts {
  return { localPath: `/tmp/clip_${durationSec}.mp4`, durationSec };
}
function measuredScene(index: number, audioSec: number, windows: Array<[number, number]>): SceneFacts {
  const beats = windows.map(([a, b], i) => measuredBeat(i, a, b));
  return {
    scene: scene(index, audioSec),
    beats,
    clips: beats.map((_, i) => ({ facts: facts(30), adoption: adoption(`${index}${i}`) })),
  };
}

/* ═══════════════ 1. the sentence ends where its beat ends ═══════════════ */

describe("1. a measured sentence's window is the beat's window — clamped to the scene's audio like the clip under it", () => {
  /**
   * Scene 0's audio is 10.00 s (the split trimmed 0.08 s of leading silence); its last word ends at
   * 10.08 s on the untrimmed word clock. Scene 1 begins at 10.00 s on this timeline.
   */
  const built = () => buildCinematicSceneInputs({ scenes: [measuredScene(0, 10, [[0, 4.2], [4.2, 10.08]]), measuredScene(1, 8, [[0, 3.5], [3.5, 8]])] });

  it("the last sentence of scene 0 ends at 10.00, not 10.08 — exactly where its beat window ends", () => {
    const b = built();
    expect(b.stats.clampedToScene).toBe(1);
    const s01 = b.sentences.find((s) => s.sceneIndex === 0 && s.beatIndex === 1)!;
    expect(s01).toMatchObject({ startSec: 4.2, endSec: 10, timingBasis: "measured" });
    const w01 = b.beatWindows.find((w) => w.sceneIndex === 0 && w.beatIndex === 1)!;
    expect(s01.endSec).toBe(Number(w01.endSec.toFixed(3)));
    /** scene 1's first sentence starts where scene 0's audio ends: no sentence overlaps another */
    const s10 = b.sentences.find((s) => s.sceneIndex === 1 && s.beatIndex === 0)!;
    expect(s10.startSec).toBe(10);
    expect(s01.endSec).toBeLessThanOrEqual(s10.startSec);
  });

  it("every sentence is recorded, measured, with a start and an end — the first, the middle, the last", () => {
    const b = built();
    expect(b.sentences.map((s) => `s${s.sceneIndex}b${s.beatIndex}`)).toEqual(["s0b0", "s0b1", "s1b0", "s1b1"]);
    for (const s of b.sentences) {
      expect(s.timingBasis).toBe("measured");
      expect(s.startSec).not.toBeNull();
      expect(s.endSec).not.toBeNull();
      expect(s.endSec!).toBeGreaterThan(s.startSec!);
    }
    expect(b.sentences[3]).toMatchObject({ startSec: 13.5, endSec: 18 });
  });

  it("the consequence, measured by the coverage check: a clip filling the clamped beat window covers its sentence fully — before the fix it read 'partial' by 0.08 s", () => {
    const b = built();
    const s01 = b.sentences.find((s) => s.sceneIndex === 0 && s.beatIndex === 1)!;
    const t: ProjectTimeline = emptyTimeline(1);
    t.sentences = [s01];
    videoTrack(t).push({
      id: "vc_1",
      kind: "video",
      source: { provider: "youtube_cc", providerAssetId: "01", archiveAssetId: 1, contentApproval: "judge_fit" },
      sourceIn: 0,
      sourceOut: 5.8,
      sceneIndex: 0,
      beatIndex: 1,
      timelineStart: 4.2,
      timelineEnd: 10,
      motion: "none",
      transitionIn: "hard_cut",
      transitionOut: "hard_cut",
      previewSource: "asset",
    } as TimelineVideoClip);
    const r = sentenceCoverage(t);
    expect(r.sentences[0]).toMatchObject({ status: "covered", coveredSec: 5.8, spokenSec: 5.8 });
    expect(r.proven).toBe(true);
    /** the unclamped window (what was recorded before) is partial — the 0.08 s past the clip has no picture */
    t.sentences = [{ ...s01, endSec: 10.08 }];
    expect(sentenceCoverage(t).sentences[0]!.status).toBe("partial");
  });

  it("an UNMEASURED beat stays `estimated`: nothing here turns a laid-out hold into a spoken time", () => {
    const laidOut: SceneFacts = {
      scene: scene(0, 9),
      beats: [{ index: 0, text: "No word timing.", searchQuery: "x", powerWord: "x", keywords: ["x"], holdSec: 4, visualDescription: "" }],
      clips: [{ facts: facts(30), adoption: adoption("00") }],
    };
    const b = buildCinematicSceneInputs({ scenes: [laidOut] });
    expect(b.sentences[0]!.timingBasis).toBe("estimated");
    expect(b.stats.laidOut).toBe(1);
  });
});

/* ═══════════════ 2. the with-timestamps call says why it gave nothing ═══════════════ */

describe("2. when ElevenLabs refuses the with-timestamps call, the log says so — the reason video 645 had no word timing", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  afterEach(() => {
    warn.mockClear();
    vi.unstubAllGlobals();
  });
  afterAll(() => warn.mockRestore());

  it("HTTP 401 quota_exceeded: null, and one [TtsAlign] line with the status and the body — never the key", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10 characters" } }), { status: 401 }));
    const r = await fetchElevenLabsWithTimestamps("Tesla unveiled the Roadster.", "voiceABC", "sk-secret-key-123", 5_000);
    expect(r).toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[TtsAlign] with-timestamps HTTP 401:") && l.includes("quota_exceeded") && l.includes("laid out, not measured"))).toBe(true);
    expect(lines.join("\n")).not.toContain("sk-secret-key-123");
  });

  it("a network error: null, and the error named", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    expect(await fetchElevenLabsWithTimestamps("text", "voice", "key", 5_000)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[TtsAlign] with-timestamps error: ECONNRESET"))).toBe(true);
  });

  it("a 200 without alignment: null, said", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ audio_base64: "" }), { status: 200 }));
    expect(await fetchElevenLabsWithTimestamps("text", "voice", "key", 5_000)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no alignment or no audio"))).toBe(true);
  });

  it("the pipeline says when the alignment is not stored, and when the route is off", () => {
    const vp = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(vp).toContain("[TtsAlign] word alignment not stored: ${alignParts.length}/${chunks.length} part(s) carried measured timing (ElevenLabs timestamps or Google timepoints)");
    expect(vp).toContain("[TtsAlign] off (${why}): the narration carries no word timing, so the beats are laid out, not measured");
    /** the only measured route: ElevenLabs timestamps → stored alignment → per-scene beats; no second timing method */
    expect(vp).toContain("if (wantAlign && alignParts.length === chunks.length) {");
    expect(vp).toContain("/** Without the TTS's own timestamps the beats keep their planned holds: no second timing method. */");
  });
});

/* ═══════════════ 3. the provider that spoke is the provider reported ═══════════════ */

describe("3. `generateVoiceover` reports the provider that actually spoke", () => {
  let dir: string;
  let mp3: Buffer;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-voice-"));
    const p = path.join(dir, "tone.mp3");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-b:a", "64k", p]);
    mp3 = fs.readFileSync(p);
  }, 60_000);
  afterAll(() => {
    netState.handler = null;
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ElevenLabs answers 401, Fish Audio speaks: provider=fish-audio, not elevenlabs (video 645's log said elevenlabs)", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-eleven-key");
    vi.stubEnv("FISH_AUDIO_API_KEY", "test-fish-key");
    vi.stubEnv("ELEVENLABS_ONLY", "false");
    const calls: string[] = [];
    netState.handler = async (u: string) => {
      calls.push(u);
      if (u.includes("api.elevenlabs.io")) {
        return new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota" } }), { status: 401 });
      }
      if (u.includes("api.fish.audio")) return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } });
      throw new Error(`unexpected fetch ${u}`);
    };
    const { generateVoiceover } = await import("./videoPipeline");
    const out = path.join(dir, "part.mp3");
    const r = await generateVoiceover("Tesla unveiled the Roadster.", out, "pNInz6obpgDQGcFmaJgB", { maxChars: 800, preferElevenLabs: true });
    expect(calls.some((u) => u.includes("api.elevenlabs.io"))).toBe(true);
    expect(calls.some((u) => u.includes("api.fish.audio"))).toBe(true);
    expect(r.usedSilentFallback).toBe(false);
    expect(r.provider).toBe("fish-audio");
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBe(mp3.length);
  }, 240_000);
});

/* ═══════════════ 4. the narration synthesis end to end: which route measures, and what happens when none can ═══════════════ */

describe("4. synthesizeFullNarrationMp3 — ElevenLabs timestamps first, Google's own timepoints second, nothing measured otherwise", () => {
  const SCENE_TEXT = "In 2008 Tesla delivered the Roadster. It changed the industry.";
  const scenes = [{ index: 0, text: SCENE_TEXT, visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 3 }] as unknown as Scene[];
  let dir: string;
  let mp3: Buffer;
  let mp3Sec = 0;
  /** spied in beforeAll, after §2 has restored its own spy on the same console */
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  const calls: string[] = [];

  beforeAll(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-narration-"));
    const p = path.join(dir, "tone.mp3");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", p]);
    mp3 = fs.readFileSync(p);
    mp3Sec = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", p]).toString().trim());
  }, 60_000);
  afterEach(() => {
    warn.mockClear();
    log.mockClear();
    calls.length = 0;
    netState.handler = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    warn.mockRestore();
    log.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** the engine stand-ins, by URL */
  const elevenTimestamps = (ok: boolean) => async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    calls.push(`global:${u}`);
    if (!ok) return new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10 credits" } }), { status: 401 });
    const text = (JSON.parse(String(init?.body ?? "{}")) as { text: string }).text;
    const chars = [...text];
    const step = (mp3Sec - 0.2) / chars.length;
    return new Response(
      JSON.stringify({
        audio_base64: mp3.toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => Number((0.1 + i * step).toFixed(4))),
          character_end_times_seconds: chars.map((_, i) => Number((0.1 + (i + 1) * step).toFixed(4))),
        },
      }),
      { status: 200 }
    );
  };
  const wellBehaved = (marked: ReturnType<typeof buildMarkedSsml>, durationSec: number): MarkTimepoint[] => {
    const order: string[] = [];
    marked.words.forEach((_, i) => {
      order.push(`w${i}`);
      const e = marked.sentenceEnds.find((x) => x.lastWordIndex === i);
      if (e) order.push(e.mark);
    });
    return order.map((markName, k) => ({ markName, timeSeconds: Number((0.12 + ((durationSec - 0.37) * k) / (order.length - 1)).toFixed(3)) }));
  };
  const nodeFetch = (opts: { googleTimepoints?: "full" | "half" | "none" } = {}) => async (u: string, init?: { body?: string }) => {
    calls.push(`node:${u}`);
    if (u.includes("api.elevenlabs.io")) return new Response(JSON.stringify({ detail: { status: "quota_exceeded" } }), { status: 401 });
    if (u.includes("api.fish.audio")) return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    if (u.includes("texttospeech.googleapis.com/v1beta1")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: { ssml: string } };
      const text = body.input.ssml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
      const marked = buildMarkedSsml(text);
      const tps = wellBehaved(marked, mp3Sec);
      const timepoints = opts.googleTimepoints === "none" ? undefined : opts.googleTimepoints === "half" ? tps.slice(0, Math.floor(tps.length / 2)) : tps;
      return new Response(JSON.stringify({ audioContent: mp3.toString("base64"), ...(timepoints ? { timepoints } : {}) }), { status: 200 });
    }
    if (u.includes("texttospeech.googleapis.com/v1/")) return new Response(JSON.stringify({ audioContent: mp3.toString("base64") }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  /** a fresh videoPipeline, because its provider keys are read once at import */
  const fresh = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) vi.stubEnv(k, "");
      else vi.stubEnv(k, v);
    }
    return import("./videoPipeline");
  };
  const workDir = (name: string) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const text = (lines: ReturnType<typeof vi.spyOn>) => lines.mock.calls.map((c) => String(c[0]));

  it("1. ElevenLabs delivers timestamps: the existing route stores them, nothing else is asked", async () => {
    vi.stubGlobal("fetch", elevenTimestamps(true));
    netState.handler = nodeFetch();
    const vp = await fresh({ ELEVENLABS_API_KEY: "eleven", GOOGLE_TTS_API_KEY: "google", FISH_AUDIO_API_KEY: undefined, ELEVENLABS_ONLY: undefined, ENABLE_TTS_WORD_ALIGNMENT: undefined });
    const wd = workDir("eleven");
    const out = await vp.synthesizeFullNarrationMp3(scenes, wd, "pNInz6obpgDQGcFmaJgB");
    expect(fs.existsSync(out)).toBe(true);
    const stored = loadStoredTtsAlignment(wd);
    expect(stored).not.toBeNull();
    expect(stored!.words.map((w) => w.word)).toEqual(SCENE_TEXT.split(/\s+/));
    expect(loadNarrationMeta(wd)?.providers).toEqual(["elevenlabs-timestamped"]);
    expect(calls.filter((c) => c.startsWith("node:"))).toEqual([]);
  }, 240_000);

  it("2. ElevenLabs answers 401 quota_exceeded, Google is configured: Google speaks and its own timepoints are stored as MEASURED timing that reaches the sentences", async () => {
    vi.stubGlobal("fetch", elevenTimestamps(false));
    netState.handler = nodeFetch({ googleTimepoints: "full" });
    const vp = await fresh({ ELEVENLABS_API_KEY: "eleven", GOOGLE_TTS_API_KEY: "google", FISH_AUDIO_API_KEY: "fish", ELEVENLABS_ONLY: undefined, ENABLE_TTS_WORD_ALIGNMENT: undefined });
    const wd = workDir("google");
    const out = await vp.synthesizeFullNarrationMp3(scenes, wd, "pNInz6obpgDQGcFmaJgB");
    expect(fs.existsSync(out)).toBe(true);
    /** the plain ElevenLabs voice and Fish Audio were never asked: a part without timing cannot pass the gate */
    expect(calls.some((c) => c.startsWith("node:") && c.includes("api.elevenlabs.io"))).toBe(false);
    expect(calls.some((c) => c.includes("api.fish.audio"))).toBe(false);
    expect(calls.some((c) => c.includes("texttospeech.googleapis.com/v1beta1"))).toBe(true);
    expect(loadNarrationMeta(wd)?.providers).toEqual(["google-tts-timepointed"]);
    const stored = loadStoredTtsAlignment(wd);
    expect(stored).not.toBeNull();
    const words = SCENE_TEXT.split(/\s+/);
    expect(stored!.words.map((w) => w.word)).toEqual(words);
    for (let i = 1; i < stored!.words.length; i++) expect(stored!.words[i]!.startSec).toBeGreaterThanOrEqual(stored!.words[i - 1]!.endSec - 1e-6);
    expect(stored!.words[words.length - 1]!.endSec).toBeLessThanOrEqual(stored!.totalDurationSec + 0.01);
    expect(text(log).some((l) => l.startsWith("[TtsAlign] Google timepoints: 10 word(s), 2 sentence end(s) measured"))).toBe(true);
    /** the stored words go the way ElevenLabs' always went: scene beats → cinematic inputs → measured sentences */
    const beatMap = buildTtsSceneBeatMap(scenes.map((sc) => ({ index: sc.index, text: sc.text, duration: sc.duration })), stored!, () => 24);
    const planned = beatMap.get(0)!;
    /** the planner's own rule merges beats under the minimum clip length: on a 3 s narration that is one beat; its window is still measured */
    expect(planned.length).toBeGreaterThanOrEqual(1);
    expect(planned[0]!.voiceStartSec).toBe(0);
    expect(planned[planned.length - 1]!.voiceEndSec).toBeGreaterThan(2);
    const sceneFacts: SceneFacts = {
      scene: scene(0, stored!.totalDurationSec),
      beats: planned.map((b) => ({ index: b.index, text: b.text, searchQuery: "tesla", powerWord: "tesla", keywords: ["tesla"], holdSec: b.holdSec, voiceStartSec: b.voiceStartSec, voiceEndSec: b.voiceEndSec, visualDescription: "" })),
      clips: planned.map((_, i) => ({ facts: facts(30), adoption: adoption(`0${i}`) })),
    };
    const built = buildCinematicSceneInputs({ scenes: [sceneFacts] });
    expect(built.sentences.length).toBe(planned.length);
    expect(built.sentences.every((x) => x.timingBasis === "measured")).toBe(true);
    expect(built.sentences[0]!.startSec).toBe(0);
    const last = built.sentences[built.sentences.length - 1]!;
    expect(last.endSec!).toBeLessThanOrEqual(stored!.totalDurationSec);
    for (let i = 1; i < built.sentences.length; i++) expect(built.sentences[i]!.startSec!).toBeGreaterThanOrEqual(built.sentences[i - 1]!.endSec!);
    /** approved clips on exactly those windows: both sentences covered, proven */
    const t: ProjectTimeline = emptyTimeline(1);
    t.sentences = built.sentences;
    built.sentences.forEach((sn, i) => {
      videoTrack(t).push({
        id: `vc_${i}`, kind: "video",
        source: { provider: "youtube_cc", providerAssetId: `0${i}`, archiveAssetId: 1, contentApproval: "judge_fit" },
        sourceIn: 0, sourceOut: sn.endSec! - sn.startSec!, sceneIndex: 0, beatIndex: i,
        timelineStart: sn.startSec!, timelineEnd: sn.endSec!,
        motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
      } as TimelineVideoClip);
    });
    const cov = sentenceCoverage(t);
    expect(cov.proven).toBe(true);
    expect(hardVisualRuleFailures({ sentenceCoverage: cov })).toEqual([]);
  }, 240_000);

  it("3. ElevenLabs answers 401 and Google is NOT configured: Fish Audio speaks, nothing is measured, the log says so, and the gate blocks the estimated sentence", async () => {
    vi.stubGlobal("fetch", elevenTimestamps(false));
    netState.handler = nodeFetch();
    const vp = await fresh({ ELEVENLABS_API_KEY: "eleven", GOOGLE_TTS_API_KEY: undefined, GOOGLE_CLOUD_TTS_API_KEY: undefined, FISH_AUDIO_API_KEY: "fish", ELEVENLABS_ONLY: undefined, ENABLE_TTS_WORD_ALIGNMENT: undefined });
    const wd = workDir("fish");
    const out = await vp.synthesizeFullNarrationMp3(scenes, wd, "pNInz6obpgDQGcFmaJgB");
    expect(fs.existsSync(out)).toBe(true);
    expect(loadNarrationMeta(wd)?.providers).toEqual(["fish-audio"]);
    expect(loadStoredTtsAlignment(wd)).toBeNull();
    const lines = text(warn);
    expect(lines.some((l) => l.startsWith("[TtsAlign] with-timestamps HTTP 401"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[TtsAlign] word alignment not stored: 0/1 part(s)"))).toBe(true);
    /** downstream: no alignment → laid-out beats → estimated sentence → the gate does not pass it */
    const laidOut: SceneFacts = {
      scene: scene(0, 3),
      beats: [{ index: 0, text: SCENE_TEXT, searchQuery: "x", powerWord: "x", keywords: ["x"], holdSec: 3, visualDescription: "" }],
      clips: [{ facts: facts(30), adoption: adoption("00") }],
    };
    const built = buildCinematicSceneInputs({ scenes: [laidOut] });
    const t: ProjectTimeline = emptyTimeline(1);
    t.sentences = built.sentences;
    videoTrack(t).push({
      id: "vc_0", kind: "video",
      source: { provider: "youtube_cc", providerAssetId: "00", archiveAssetId: 1, contentApproval: "judge_fit" },
      sourceIn: 0, sourceOut: 3, sceneIndex: 0, beatIndex: 0, timelineStart: 0, timelineEnd: 3,
      motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset",
    } as TimelineVideoClip);
    const cov = sentenceCoverage(t);
    expect(cov.sentences[0]!.timingBasis).toBe("estimated");
    expect(hardVisualRuleFailures({ sentenceCoverage: cov }).map((f) => f.code)).toEqual(["SENTENCE_COVERAGE_UNPROVEN"]);
  }, 240_000);

  it("4. Google speaks but its timepoints do not fit the text it was sent (half the marks): the voice is kept, the timing is refused, nothing measured is stored", async () => {
    vi.stubGlobal("fetch", elevenTimestamps(false));
    netState.handler = nodeFetch({ googleTimepoints: "half" });
    const vp = await fresh({ ELEVENLABS_API_KEY: "eleven", GOOGLE_TTS_API_KEY: "google", FISH_AUDIO_API_KEY: undefined, ELEVENLABS_ONLY: undefined, ENABLE_TTS_WORD_ALIGNMENT: undefined });
    const wd = workDir("google-refused");
    const out = await vp.synthesizeFullNarrationMp3(scenes, wd, "pNInz6obpgDQGcFmaJgB");
    expect(fs.existsSync(out)).toBe(true);
    expect(loadNarrationMeta(wd)?.providers).toEqual(["google-tts"]);
    expect(loadStoredTtsAlignment(wd)).toBeNull();
    expect(text(log).some((l) => l.startsWith("[TtsAlign] Google timepoints refused:") && l.includes("missing from the response"))).toBe(true);
    expect(text(warn).some((l) => l.startsWith("[TtsAlign] word alignment not stored: 0/1 part(s)"))).toBe(true);
  }, 240_000);

  it("5. ELEVENLABS_ONLY keeps the chain exactly as it was: no Google, no Fish", async () => {
    vi.stubGlobal("fetch", elevenTimestamps(false));
    netState.handler = nodeFetch();
    const vp = await fresh({ ELEVENLABS_API_KEY: "eleven", GOOGLE_TTS_API_KEY: "google", FISH_AUDIO_API_KEY: "fish", ELEVENLABS_ONLY: "true", ENABLE_TTS_WORD_ALIGNMENT: undefined });
    const wd = workDir("only");
    await expect(vp.synthesizeFullNarrationMp3(scenes, wd, "pNInz6obpgDQGcFmaJgB")).rejects.toThrow();
    expect(calls.some((c) => c.includes("texttospeech.googleapis.com"))).toBe(false);
    expect(calls.some((c) => c.includes("api.fish.audio"))).toBe(false);
  }, 240_000);
});
