import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  estimateWordTimings,
  loadNarrationMeta,
  narrationProviderLabel,
  narrationWordTiming,
  saveNarrationMeta,
  summarizeProviders,
  whisperWordTimings,
} from "./narrationWordTiming";

/**
 * RONDE 653 — renders 606 and 607 were narrated by Fish Audio after ElevenLabs answered 401
 * payment_required, and planned with words=0: only ElevenLabs ever produced word boundaries.
 */
const TEXT = "In 1945, Berlin fell. The bunker, sealed for weeks, went quiet — and history turned.";

describe("the estimate spreads the script over the measured narration", () => {
  const words = estimateWordTimings(TEXT, 8);

  it("times every word, in order, without overlap, inside the narration", () => {
    expect(words.map((w) => w.word)).toEqual([
      "In", "1945", "Berlin", "fell", "The", "bunker", "sealed", "for", "weeks", "went", "quiet", "and", "history", "turned",
    ]);
    for (let i = 0; i < words.length; i++) {
      expect(words[i]!.endSec).toBeGreaterThan(words[i]!.startSec);
      if (i > 0) expect(words[i]!.startSec).toBeGreaterThanOrEqual(words[i - 1]!.endSec);
    }
    expect(words[0]!.startSec).toBeGreaterThan(0);
    expect(words.at(-1)!.endSec).toBeLessThanOrEqual(8);
  });

  it("leaves a pause after a full stop longer than the gap between two words of one clause", () => {
    const at = (w: string) => words.findIndex((x) => x.word === w);
    const afterFell = words[at("fell") + 1]!.startSec - words[at("fell")]!.endSec;
    const afterThe = words[at("The") + 1]!.startSec - words[at("The")]!.endSec;
    expect(afterFell).toBeGreaterThan(afterThe);
  });

  it("gives nothing for no text or no length", () => {
    expect(estimateWordTimings("", 5)).toEqual([]);
    expect(estimateWordTimings(TEXT, 0)).toEqual([]);
  });
});

describe("the ladder names the rung it stood on", () => {
  it("uses the TTS's own timestamps when it has them", async () => {
    const r = await narrationWordTiming({
      measured: [{ word: "In", startSec: 0.1, endSec: 0.2 }],
      audioPath: null,
      text: TEXT,
      durationSec: 8,
    });
    expect(r.source).toBe("elevenlabs");
  });

  it("transcribes the narration when the TTS gave none", async () => {
    const r = await narrationWordTiming({
      measured: [],
      audioPath: "/tmp/voice.mp3",
      text: TEXT,
      durationSec: 8,
      transcribe: async () => ({ words: [{ word: "In", startSec: 0.2, endSec: 0.3 }] }),
    });
    expect(r.source).toBe("whisper");
    expect(r.words).toHaveLength(1);
  });

  it("estimates when transcription is unavailable, and says why", async () => {
    const r = await narrationWordTiming({
      measured: null,
      audioPath: "/tmp/voice.mp3",
      text: TEXT,
      durationSec: 8,
      transcribe: async () => ({ error: "HTTP 401" }),
    });
    expect(r.source).toBe("estimated");
    expect(r.words.length).toBe(14);
    expect(r.note).toContain("HTTP 401");
  });

  it("is `none` only without a narration length", async () => {
    const r = await narrationWordTiming({ measured: [], audioPath: null, text: TEXT, durationSec: null });
    expect(r.source).toBe("none");
  });
});

describe("Whisper's word timestamps are only trusted when they cover the script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fv_whisper_"));
  const audio = path.join(dir, "v.mp3");
  fs.writeFileSync(audio, Buffer.alloc(2048));
  const reply = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("asks for word granularity and returns the words", async () => {
    let sent: FormData | null = null;
    const r = await whisperWordTimings({
      audioPath: audio,
      expectedWords: 2,
      durationSec: 3,
      apiKey: "k",
      apiUrl: "https://api.openai.com/v1/audio/transcriptions",
      fetch: (async (_u: string, init: RequestInit) => {
        sent = init.body as FormData;
        return new Response(JSON.stringify({ words: [{ word: "Berlin", start: 0.1, end: 0.5 }, { word: "fell", start: 0.6, end: 0.9 }] }));
      }) as unknown as typeof fetch,
    });
    expect((sent as FormData | null)?.get("timestamp_granularities[]")).toBe("word");
    expect(r).toEqual({ words: [{ word: "Berlin", startSec: 0.1, endSec: 0.5 }, { word: "fell", startSec: 0.6, endSec: 0.9 }] });
  });

  it("refuses a thin transcript, an HTTP error and a missing key", async () => {
    const base = { audioPath: audio, expectedWords: 10, durationSec: 3, apiUrl: "u" };
    expect(await whisperWordTimings({ ...base, apiKey: "k", fetch: reply({ words: [{ word: "x", start: 0, end: 1 }] }) })).toHaveProperty("error");
    expect(await whisperWordTimings({ ...base, apiKey: "k", fetch: reply({}, 401) })).toEqual({ error: "HTTP 401" });
    expect(await whisperWordTimings({ ...base, apiKey: "" })).toEqual({ error: "no transcription key" });
  });
});

describe("which voice spoke is recorded instead of dropped", () => {
  it("round-trips the narration text and providers through the work dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fv_meta_"));
    saveNarrationMeta(dir, { text: TEXT, providers: ["fish-audio", "fish-audio"] });
    expect(loadNarrationMeta(dir)).toEqual({ text: TEXT, providers: ["fish-audio", "fish-audio"] });
  });

  it("summarises and labels the providers", () => {
    expect(summarizeProviders(["fish-audio", "fish-audio", "elevenlabs-timestamped"])).toBe(
      "fish-audio×2, elevenlabs-timestamped×1"
    );
    expect(narrationProviderLabel(["elevenlabs-timestamped", "elevenlabs"])).toBe("elevenlabs");
    expect(narrationProviderLabel(["fish-audio"])).toBe("fish-audio");
    expect(narrationProviderLabel(["elevenlabs-timestamped", "fish-audio"])).toBe("mixed:elevenlabs+fish-audio");
    expect(narrationProviderLabel([])).toBeNull();
  });
});

describe("the render plans with the ladder's words and never writes an estimate back", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  it("feeds wordTiming.words to the metadata and to the cinematic plan", () => {
    expect(SRC).toContain("wordTiming = await narrationWordTiming({");
    expect(SRC.match(/words: wordTiming\.words,/g)?.length).toBe(2);
    expect(SRC).not.toContain("words: storedAlignment?.words ?? [],");
    expect(SRC).toContain("provider: narrationProviderLabel(narrationMeta?.providers ?? []),");
  });

  it("only the TTS's own timestamps are saved to the alignment file the scene split reads", () => {
    const at = SRC.indexOf("wordTiming = await narrationWordTiming({");
    const block = SRC.slice(at, at + 3000);
    expect(block).not.toContain("saveStoredTtsAlignment(");
  });

  it("says out loud when a part was not spoken by ElevenLabs", () => {
    expect(SRC).toContain("part(s) NOT spoken by ElevenLabs");
    expect(SRC).toContain("partProviders.push(voResult.provider ?? \"unknown\");");
  });
});
