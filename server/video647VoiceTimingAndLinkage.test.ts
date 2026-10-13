/**
 * VIDEO 647 — THE VOICE TIMING ROUTE AND THE SENTENCE↔CLIP LINK, END TO END, WITHOUT A NETWORK.
 *
 * Renders 644–646 were refused with SENTENCE_COVERAGE_UNPROVEN: ElevenLabs answered 401
 * quota_exceeded, Fish Audio spoke the text (audio only), every sentence stayed `estimated`. A new
 * ElevenLabs key is now in production. These tests pin, with the real functions and synthetic data:
 *
 *   1. the timestamped route returns the engine's own character alignment, and a refusal (401, any
 *      body) returns nothing and says why — it never invents timing;
 *   2. that alignment becomes words, the words find their scene's text, and each sentence's spoken
 *      window is read from its own first and last word — measured at both ends;
 *   3. the gate tells a timing problem from a picture problem: estimated timing is UNPROVEN, a
 *      missing picture under measured timing is NOT_COVERED, and measured + covered passes;
 *   4. a clip only counts for the sentence it was approved for: another sentence's approved clip,
 *      an unjudged clip and a clip held past its source are each refused, with their kind named;
 *   5. the worker reads the key from ELEVENLABS_API_KEY, the quota latch is per render and the
 *      cooldown is three minutes — so the next render tries the new key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  buildTtsSceneBeatMap,
  fetchElevenLabsWithTimestamps,
  ttsWordAlignmentEnabled,
  wordsFromCharacterAlignment,
  type TtsCharacterAlignment,
} from "./voiceTtsAlignment";
import { deliveryGate, type PlaceholderCheckFacts } from "./deliveryGate";
import { sentenceCoverage } from "./sentenceCoverage";
import { emptyTimeline, videoTrack, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { stripComments } from "./sourceScan.test.support";

const read = (f: string) => stripComments(fs.readFileSync(path.join(__dirname, f), "utf8"));

/* ───────────── a synthetic ElevenLabs-shaped alignment: 0.08 s per character, spoken in order ───────────── */

const NARRATION = "The war ended in May. Cities lay in ruins.";
function characterAlignment(text: string, secPerChar = 0.08, offset = 0.2): TtsCharacterAlignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => Number((offset + i * secPerChar).toFixed(3))),
    character_end_times_seconds: characters.map((_, i) => Number((offset + (i + 1) * secPerChar).toFixed(3))),
  };
}

describe("1. the timestamped ElevenLabs route: the engine's alignment, or nothing and the reason", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a timestamped answer gives audio and the character alignment", async () => {
    const alignment = characterAlignment(NARRATION);
    const audio = Buffer.alloc(4_000, 1).toString("base64");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ audio_base64: audio, alignment }), { status: 200 }));
    const out = await fetchElevenLabsWithTimestamps(NARRATION, "voice-647", "not-a-real-key", 5_000);
    expect(out).not.toBeNull();
    expect(out!.alignment.characters).toHaveLength(NARRATION.length);
    expect(out!.audioBuffer.length).toBe(4_000);
  });

  it.each([
    ["quota", 401, { detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10000." } }],
    ["invalid key", 401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }],
    ["server error", 500, { detail: "upstream" }],
  ])("a %s refusal (HTTP %i) returns no timing and names the status and body — nothing is invented", async (_what, status, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
    const out = await fetchElevenLabsWithTimestamps(NARRATION, "voice-647", "not-a-real-key", 5_000);
    expect(out).toBeNull();
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("with-timestamps HTTP"));
    expect(line).toContain(`HTTP ${status}`);
    expect(line).toContain(JSON.stringify(body).slice(0, 40));
    warn.mockRestore();
  });

  it("an answer without alignment or without audio is not timing either", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ audio_base64: Buffer.alloc(500).toString("base64") }), { status: 200 }));
    expect(await fetchElevenLabsWithTimestamps(NARRATION, "v", "k", 5_000)).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ alignment: characterAlignment(NARRATION) }), { status: 200 }));
    expect(await fetchElevenLabsWithTimestamps(NARRATION, "v", "k", 5_000)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("2. alignment → words → the scene's text → each sentence's own spoken window", () => {
  it("words carry the engine's times, and a scene's beats are read from its own first and last word", () => {
    const alignment = characterAlignment(NARRATION);
    const words = wordsFromCharacterAlignment(alignment);
    expect(words.map((w) => w.word)).toEqual(["The", "war", "ended", "in", "May.", "Cities", "lay", "in", "ruins."]);
    expect(words[0]!.startSec).toBeCloseTo(0.2, 3);
    expect(words[4]!.endSec).toBeCloseTo(0.2 + "The war ended in May.".length * 0.08, 3);
    for (let i = 1; i < words.length; i++) expect(words[i]!.startSec).toBeGreaterThanOrEqual(words[i - 1]!.endSec);

    const totalDurationSec = words[words.length - 1]!.endSec + 0.3;
    const scenes = [
      { index: 0, text: "The war ended in May.", duration: 2 },
      { index: 1, text: "Cities lay in ruins.", duration: 2 },
    ];
    const byScene = buildTtsSceneBeatMap(scenes, { words, totalDurationSec, updatedAt: "" }, () => 4);
    const s0 = byScene.get(0)!;
    const s1 = byScene.get(1)!;
    expect(s0.length).toBeGreaterThan(0);
    expect(s1.length).toBeGreaterThan(0);
    /** scene-local: the first sentence of each scene starts at its own first word */
    expect(s0[0]!.voiceStartSec).toBeCloseTo(0, 3);
    expect(s0[s0.length - 1]!.voiceEndSec).toBeCloseTo(words[4]!.endSec - words[0]!.startSec, 3);
    expect(s1[0]!.voiceStartSec).toBeCloseTo(0, 3);
    expect(s1[s1.length - 1]!.voiceEndSec).toBeCloseTo(words[8]!.endSec - words[5]!.startSec, 3);
    expect(s1.map((b) => b.text).join(" ")).toContain("Cities");
    expect(s0.map((b) => b.text).join(" ")).not.toContain("Cities");
  });

  it("without a stored alignment there is no measured window: `measured` is read from voiceStartSec only", () => {
    const inputs = read("cinematicPipelineInputs.ts");
    expect(inputs).toContain("const measured = beat.voiceStartSec != null;");
    /** VIDEO 650 — the measured basis has two sources, alignment and the scene audio's pauses; an estimate stays an estimate. */
    expect(inputs).toContain('timingBasis: measured && beat.voiceEndSec != null ? (beat.voiceTimingSource === "silence" ? "measured_silence" : "measured") : "estimated",');
  });
});

/* ───────────── gate fixtures ───────────── */

function clip(id: string, start: number, end: number, o: { beat?: [number, number]; approved?: boolean; sourceSec?: number } = {}): TimelineVideoClip {
  const { beat = [0, 0], approved = true, sourceSec = end - start } = o;
  return {
    id,
    kind: "video",
    source: { provider: "youtube_cc", providerAssetId: id, archiveAssetId: 1, ...(approved ? { contentApproval: "judge_fit" as const } : {}) },
    sourceIn: 10,
    sourceOut: 10 + sourceSec,
    timelineStart: start,
    timelineEnd: end,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    sceneIndex: beat[0],
    beatIndex: beat[1],
  } as TimelineVideoClip;
}
function timeline(sentences: ProjectTimeline["sentences"], clips: TimelineVideoClip[] = []): ProjectTimeline {
  const t = emptyTimeline(647);
  t.durationSec = 10;
  videoTrack(t).push(...clips);
  t.sentences = sentences;
  return t;
}
const sentence = (s: number, b: number, start: number, end: number, basis: "measured" | "estimated" = "measured") =>
  ({ sceneIndex: s, beatIndex: b, startSec: start, endSec: end, timingBasis: basis, text: `Sentence ${s}-${b}.` });
const base = { videoId: 647, route: "cinematic_timeline" as const, timelineExists: true, clips: [], delivered: null, assetsOnly: true };
const cleanScan: PlaceholderCheckFacts = { method: "all_frames", complete: true, framesSampled: 250, placeholderFrames: 0, placeholderSec: 0, plannedCardSec: 0, confirmedPlaceholderSec: 0, indicatedPlaceholderSec: 0, unplannedPlaceholderFrames: 0, contentGraphicGroundSec: 0, decodedSec: 10 };
const codesOf = (v: ReturnType<typeof deliveryGate>) => (v.allow ? [] : v.failures.map((f) => f.code));

describe("3. the gate tells a timing problem from a picture problem", () => {
  it("measured timing under an approved picture passes; the same picture under estimated timing is UNPROVEN, not NOT_COVERED", () => {
    const covered = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline([sentence(0, 0, 0, 4)], [clip("a", 0, 4)])), placeholderCheck: cleanScan });
    expect(covered.allow).toBe(true);

    const estimated = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline([sentence(0, 0, 0, 4, "estimated")], [clip("a", 0, 4)])), placeholderCheck: cleanScan });
    expect(codesOf(estimated)).toContain("SENTENCE_COVERAGE_UNPROVEN");
    expect(codesOf(estimated)).not.toContain("SENTENCE_NOT_COVERED");
  });

  it("a missing picture under measured timing is NOT_COVERED, not UNPROVEN — the picture budget is not blamed on the voice", () => {
    const none = deliveryGate({ ...base, sentenceCoverage: sentenceCoverage(timeline([sentence(0, 0, 0, 4)])), placeholderCheck: cleanScan });
    expect(codesOf(none)).toContain("SENTENCE_NOT_COVERED");
    expect(codesOf(none)).not.toContain("SENTENCE_COVERAGE_UNPROVEN");
  });

  it("a measured timing is never marked proven by a missing one: one estimated sentence among measured ones still refuses", () => {
    const t = timeline([sentence(0, 0, 0, 4), sentence(0, 1, 4, 8, "estimated")], [clip("a", 0, 4, { beat: [0, 0] }), clip("b", 4, 8, { beat: [0, 1] })]);
    const r = sentenceCoverage(t);
    expect(r.sentences[0]!.status).toBe("covered");
    expect(r.sentences[1]!.status).toBe("unknown");
    expect(r.proven).toBe(false);
    expect(deliveryGate({ ...base, sentenceCoverage: r, placeholderCheck: cleanScan }).allow).toBe(false);
  });
});

describe("4. a clip counts only for the sentence it was approved for", () => {
  it("another sentence's approved clip, an unjudged clip and a clip held past its source are each refused, by kind", () => {
    const other = sentenceCoverage(timeline([sentence(0, 1, 0, 4)], [clip("a", 0, 4, { beat: [0, 0] })]));
    expect(other.sentences[0]).toMatchObject({ status: "uncovered", coveredSec: 0, kinds: ["other_sentence_picture"] });

    /** a clip nobody judged is not known to be wrong — and not known to be right: unproven, never passed */
    const unjudged = sentenceCoverage(timeline([sentence(0, 0, 0, 4)], [clip("a", 0, 4, { approved: false })]));
    expect(unjudged.sentences[0]).toMatchObject({ status: "unknown", coveredSec: 0, kinds: ["unverified_footage"] });
    expect(unjudged.sentences[0]!.reasons).toContain("footage without the picture editor's approval 4.00s");

    const held = sentenceCoverage(timeline([sentence(0, 0, 0, 6)], [clip("a", 0, 6, { sourceSec: 2.5 })]));
    expect(held.sentences[0]!.status).toBe("partial");
    expect(held.sentences[0]!.kinds).toContain("stretched_footage");
    expect(held.stretchedClips).toBe(1);

    for (const r of [other, held]) {
      expect(codesOf(deliveryGate({ ...base, sentenceCoverage: r, placeholderCheck: cleanScan }))).toContain("SENTENCE_NOT_COVERED");
    }
    expect(codesOf(deliveryGate({ ...base, sentenceCoverage: unjudged, placeholderCheck: cleanScan }))).toContain("SENTENCE_COVERAGE_UNPROVEN");
    for (const r of [other, unjudged, held]) expect(r.proven).toBe(false);
  });

  it("the link survives on the timeline: two sentences, two approved clips, each under its own", () => {
    const r = sentenceCoverage(timeline([sentence(0, 0, 0, 4), sentence(1, 0, 4, 8)], [clip("a", 0, 4, { beat: [0, 0] }), clip("b", 4, 8, { beat: [1, 0] })]));
    expect(r.sentences.map((s) => s.status)).toEqual(["covered", "covered"]);
    expect(r.proven).toBe(true);
    /** swap the links and nothing is covered */
    const swapped = sentenceCoverage(timeline([sentence(0, 0, 0, 4), sentence(1, 0, 4, 8)], [clip("a", 0, 4, { beat: [1, 0] }), clip("b", 4, 8, { beat: [0, 0] })]));
    expect(swapped.sentences.map((s) => s.status)).toEqual(["uncovered", "uncovered"]);
  });
});

describe("5. the worker reads ELEVENLABS_API_KEY and tries it again on every render", () => {
  it("one variable name, read where the voice is made, where timing is switched on and where preflight reports it", () => {
    const pipe = read("videoPipeline.ts");
    const align = read("voiceTtsAlignment.ts");
    const preflight = read("productionPreflight.ts");
    expect(pipe).toContain('process.env.ELEVENLABS_API_KEY');
    expect(align).toContain('process.env.ELEVENLABS_API_KEY?.trim()');
    expect(preflight).toContain('requires: ["ELEVENLABS_API_KEY"],');
    expect(pipe).not.toMatch(/ELEVEN_LABS_API_KEY|ELEVENLABS_KEY\b/);
    const saved = process.env.ELEVENLABS_API_KEY;
    try {
      process.env.ELEVENLABS_API_KEY = "present";
      delete process.env.ENABLE_TTS_WORD_ALIGNMENT;
      expect(ttsWordAlignmentEnabled()).toBe(true);
      process.env.ELEVENLABS_API_KEY = "";
      expect(ttsWordAlignmentEnabled()).toBe(false);
    } finally {
      if (saved == null) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved;
    }
  });

  it("the quota latch is per render and the cooldown is three minutes: a new key is tried on the next render", () => {
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("elevenLabsQuotaExhausted: false,");
    expect(pipe).toContain("const ELEVENLABS_COOLDOWN_MS = 3 * 60_000;");
    expect(pipe).toContain("elevenLabsFailureStreak = 0; elevenLabsCooldownUntilMs = 0;");
    /** the voice stage asks for timestamps first, with one retry, before any plain voice */
    expect(pipe).toContain("if (useTtsAlign) {");
    expect(pipe).toMatch(/\(await fetchElevenLabsWithTimestamps\([^)]*\)\) \?\?\s*\(await fetchElevenLabsWithTimestamps\(/);
  });
});
