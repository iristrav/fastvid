/**
 * ttsMarkAlignment.ts — measured word timing from Google Cloud TTS's own timepoints. No network:
 * the fetch is a stand-in that answers with a real ffmpeg-made mp3 and timepoints derived from the
 * marks the module itself sent, so every number the module reads back is one it can be checked on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  GOOGLE_TTS_TIMEPOINT_URL,
  SSML_REQUEST_MAX_BYTES,
  alignmentFromTimepoints,
  buildMarkedSsml,
  escapeSsml,
  splitForSsmlBudget,
  synthesizeGoogleTimepointed,
  type MarkTimepoint,
  type TimepointedSynthesisDeps,
} from "./ttsMarkAlignment";
import { wordsFromCharacterAlignment } from "./voiceTtsAlignment";

const TEXT = "In 2008 Tesla delivered the Roadster. It changed the industry forever! Did anyone notice?";

describe("the marked SSML", () => {
  it("puts a mark before every word and one after every sentence's last word, escaped", () => {
    const m = buildMarkedSsml('Tom & Jerry said "go" <now>. Done.');
    expect(m.words).toEqual(["Tom", "&", "Jerry", "said", '"go"', "<now>.", "Done."]);
    expect(m.sentenceEnds).toEqual([{ mark: "e0", lastWordIndex: 5 }, { mark: "e1", lastWordIndex: 6 }]);
    expect(m.ssml).toContain('<mark name="w1"/>&amp;');
    expect(m.ssml).toContain('<mark name="w4"/>&quot;go&quot;');
    expect(m.ssml).toContain('<mark name="w5"/>&lt;now&gt;. <mark name="e0"/>');
    expect(m.ssml.startsWith("<speak>")).toBe(true);
    expect(m.ssml.endsWith("</speak>")).toBe(true);
    expect(escapeSsml("a<b>&'\"")).toBe("a&lt;b&gt;&amp;&apos;&quot;");
  });

  it("a text without a final full stop still ends its last sentence", () => {
    const m = buildMarkedSsml("one two three");
    expect(m.sentenceEnds).toEqual([{ mark: "e0", lastWordIndex: 2 }]);
  });

  it("splits a long text into requests under the byte budget, on sentences first and words only when one sentence is too long", () => {
    const sentence = "Tesla built the first Roadster on a Lotus chassis in two thousand and eight. ";
    const long = sentence.repeat(60);
    const pieces = splitForSsmlBudget(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(buildMarkedSsml(p).bytes).toBeLessThanOrEqual(SSML_REQUEST_MAX_BYTES);
    /** every word survives, in order, none cut */
    expect(pieces.join(" ").split(/\s+/)).toEqual(long.trim().split(/\s+/));
    /** sentences are not broken when they fit */
    for (const p of pieces.slice(0, -1)) expect(/[.!?]$/.test(p)).toBe(true);
    const oneHuge = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ") + ".";
    const byWords = splitForSsmlBudget(oneHuge, 1_200);
    expect(byWords.length).toBeGreaterThan(5);
    expect(byWords.join(" ").split(/\s+/)).toEqual(oneHuge.split(/\s+/));
    expect(splitForSsmlBudget("   ")).toEqual([]);
  });
});

/** Timepoints a well-behaved engine would return: the marks, in text order, spread over the audio. */
function wellBehaved(marked: ReturnType<typeof buildMarkedSsml>, durationSec: number): MarkTimepoint[] {
  const order: string[] = [];
  marked.words.forEach((_, i) => {
    order.push(`w${i}`);
    const e = marked.sentenceEnds.find((x) => x.lastWordIndex === i);
    if (e) order.push(e.mark);
  });
  const lo = 0.12;
  const hi = durationSec - 0.25;
  return order.map((markName, k) => ({ markName, timeSeconds: Number((lo + ((hi - lo) * k) / (order.length - 1)).toFixed(3)) }));
}

describe("reading the timepoints", () => {
  const marked = buildMarkedSsml(TEXT);

  it("a clean response: word starts are the marks, a word ends where the next begins, a sentence ends at its end mark — measured at both ends", () => {
    const tps = wellBehaved(marked, 6);
    const r = alignmentFromTimepoints({ marked, timepoints: tps, audioDurationSec: 6 });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.words.map((w) => w.word)).toEqual(marked.words);
    const byName = new Map(tps.map((t) => [t.markName, t.timeSeconds]));
    expect(r.words[0]!.startSec).toBe(byName.get("w0"));
    expect(r.words[0]!.endSec).toBe(byName.get("w1"));
    /** "Roadster." is the last word of sentence 0: it ends at e0, not at the next word */
    expect(r.words[5]!.word).toBe("Roadster.");
    expect(r.words[5]!.endSec).toBe(byName.get("e0"));
    expect(r.sentenceWindows).toHaveLength(3);
    expect(r.sentenceWindows[0]).toEqual({ startSec: byName.get("w0"), endSec: byName.get("e0") });
    expect(r.sentenceWindows[2]!.endSec).toBe(byName.get("e2"));
    for (let i = 1; i < r.words.length; i++) expect(r.words[i]!.startSec).toBeGreaterThanOrEqual(r.words[i - 1]!.endSec - 1e-9);
    /** the character alignment reads back to the same words — the shape the stored alignment, the scene split and the beat planner already take */
    const back = wordsFromCharacterAlignment(r.alignment);
    expect(back.map((w) => w.word)).toEqual(marked.words);
    expect(back.map((w) => [w.startSec, w.endSec])).toEqual(r.words.map((w) => [w.startSec, w.endSec]));
  });

  it("refuses: a missing mark, a doubled mark, marks running backwards, a mark past the audio, speech that ends long before the audio, malformed entries", () => {
    const good = wellBehaved(marked, 6);
    const err = (tps: MarkTimepoint[], dur = 6) => {
      const r = alignmentFromTimepoints({ marked, timepoints: tps, audioDurationSec: dur });
      return "error" in r ? r.error : null;
    };
    expect(err(good.slice(0, -1))).toContain("mark e2 missing");
    expect(err([...good, { markName: "w3", timeSeconds: 1 }])).toContain("reported twice");
    const back = good.map((t) => (t.markName === "w4" ? { ...t, timeSeconds: 0.01 } : t));
    expect(err(back)).toContain("run backwards at w4");
    const late = good.map((t) => (t.markName === "e2" ? { ...t, timeSeconds: 7.5 } : t));
    expect(err(late)).toContain("past the audio's end");
    /** the text is spoken in 5.75 s but the file runs 20 s: this audio is not this text */
    expect(err(good, 20)).toContain("the audio and the text do not agree");
    expect(err([{ markName: "w0", timeSeconds: Number.NaN }])).toContain("malformed");
    expect(err(good, 0)).toContain("no duration");
    /** the first word more than half-way into the audio: not this text either */
    const shifted = good.map((t) => ({ ...t, timeSeconds: t.timeSeconds + 6.2 }));
    expect(alignmentFromTimepoints({ marked, timepoints: shifted, audioDurationSec: 12.1 })).toHaveProperty("error");
    /** a plausible lead-in (the engine's own breath) is not refused */
    const lead = good.map((t) => ({ ...t, timeSeconds: t.timeSeconds + 0.4 }));
    expect("error" in alignmentFromTimepoints({ marked, timepoints: lead, audioDurationSec: 6.4 })).toBe(false);
  });
});

describe("speaking a part with Google and reading its own timepoints", () => {
  let dir: string;
  let mp3: Buffer;
  let mp3Sec = 0;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-tp-"));
    const p = path.join(dir, "tone.mp3");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", p]);
    mp3 = fs.readFileSync(p);
    mp3Sec = probe(p);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const probe = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", f]).toString().trim());
  const concat = async (parts: string[], out: string) => {
    if (parts.length === 1) {
      fs.copyFileSync(parts[0]!, out);
      return;
    }
    const list = path.join(dir, `list_${path.basename(out)}.txt`);
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "libmp3lame", "-b:a", "64k", out]);
  };
  /** the stand-in engine: answers every request with the tone and timepoints for exactly the marks it was sent */
  const engine = (opts: { timepoints?: (marked: ReturnType<typeof buildMarkedSsml>) => MarkTimepoint[]; status?: number; drop?: boolean } = {}) => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: TimepointedSynthesisDeps["fetchImpl"] = async (url, init) => {
      const body = JSON.parse(init.body) as { input: { ssml: string }; enableTimePointing?: string[] };
      requests.push({ url, body });
      if (opts.status) return { ok: false, status: opts.status, text: async () => `{"error":"quota"}`, json: async () => ({}) };
      const text = body.input.ssml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      const marked = buildMarkedSsml(text);
      const timepoints = opts.drop ? undefined : (opts.timepoints ?? ((m) => wellBehaved(m, mp3Sec)))(marked);
      return { ok: true, status: 200, text: async () => "", json: async () => ({ audioContent: mp3.toString("base64"), ...(timepoints ? { timepoints } : {}) }) };
    };
    return { requests, fetchImpl };
  };
  const deps = (e: ReturnType<typeof engine>): TimepointedSynthesisDeps => ({ apiKey: "k", fetchImpl: e.fetchImpl, probeDurationSec: async (f) => probe(f), concatParts: concat, log: () => undefined });

  it("one request: the audio is written, the words are measured, the request asked for SSML_MARK timepoints and carried the key in a header", async () => {
    const e = engine();
    const out = path.join(dir, "part0.mp3");
    const r = await synthesizeGoogleTimepointed(TEXT, out, dir, deps(e));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fs.existsSync(out)).toBe(true);
    expect(r.requests).toBe(1);
    expect(r.words).toBe(TEXT.split(/\s+/).length);
    expect(r.sentences).toBe(3);
    expect(r.durationSec).toBeCloseTo(mp3Sec, 1);
    const words = wordsFromCharacterAlignment(r.alignment);
    expect(words.map((w) => w.word)).toEqual(TEXT.split(/\s+/));
    expect(words[0]!.startSec).toBeCloseTo(0.12, 3);
    expect(words[words.length - 1]!.endSec).toBeLessThanOrEqual(mp3Sec);
    expect(e.requests[0]!.url).toBe(GOOGLE_TTS_TIMEPOINT_URL);
    expect(e.requests[0]!.body.enableTimePointing).toEqual(["SSML_MARK"]);
    expect((e.requests[0]!.body.input as { ssml: string }).ssml).toContain('<mark name="w0"/>In');
  });

  it("many requests: each request's timepoints are offset by the audio before it, the parts are joined, no word fuses with its neighbour", async () => {
    const e = engine();
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about the Roadster and the Lotus chassis in Hethel.`).join(" ");
    const out = path.join(dir, "part1.mp3");
    const r = await synthesizeGoogleTimepointed(long, out, dir, { ...deps(e), fetchImpl: e.fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /** the budget forces several requests for this text at 4.5 KB? it fits in one — force it with a small budget through the split, by checking the pieces directly */
    const pieces = splitForSsmlBudget(long, 900);
    expect(pieces.length).toBeGreaterThan(3);
    /** and run the synthesis as if the budget were small: the module splits at SSML_REQUEST_MAX_BYTES, so emulate with a longer text */
    const longer = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} about the Roadster and the Lotus chassis in Hethel.`).join(" ");
    const e2 = engine();
    const out2 = path.join(dir, "part2.mp3");
    const r2 = await synthesizeGoogleTimepointed(longer, out2, dir, deps(e2));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.requests).toBeGreaterThan(1);
    expect(e2.requests).toHaveLength(r2.requests);
    const words = wordsFromCharacterAlignment(r2.alignment);
    expect(words.map((w) => w.word)).toEqual(longer.split(/\s+/));
    for (let i = 1; i < words.length; i++) expect(words[i]!.startSec, `word ${i}`).toBeGreaterThanOrEqual(words[i - 1]!.endSec - 1e-9);
    expect(words[words.length - 1]!.endSec).toBeGreaterThan(mp3Sec * (r2.requests - 1));
    expect(r2.durationSec).toBeCloseTo(mp3Sec * r2.requests, 0);
    expect(probe(out2)).toBeCloseTo(mp3Sec * r2.requests, 0);
    /** the pieces are cleaned up */
    expect(fs.readdirSync(dir).filter((f) => f.includes("_tp"))).toEqual([]);
  }, 60_000);

  it("the engine answers without timepoints, or with timepoints that do not fit its audio: the audio is kept, the timing is refused", async () => {
    const drop = engine({ drop: true });
    const r = await synthesizeGoogleTimepointed(TEXT, path.join(dir, "part3.mp3"), dir, deps(drop));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.audioWritten).toBe(true);
    expect(r.reason).toContain("missing from the response");
    expect(fs.existsSync(path.join(dir, "part3.mp3"))).toBe(true);
    const half = engine({ timepoints: (m) => wellBehaved(m, mp3Sec).slice(0, 4) });
    const h = await synthesizeGoogleTimepointed(TEXT, path.join(dir, "part4.mp3"), dir, deps(half));
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.audioWritten).toBe(true);
    /** the text is three times what this 3 s audio can hold: the marks run past the audio */
    const stretched = engine({ timepoints: (m) => wellBehaved(m, mp3Sec * 3) });
    const s = await synthesizeGoogleTimepointed(TEXT, path.join(dir, "part5.mp3"), dir, deps(stretched));
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toContain("past the audio's end");
  });

  it("HTTP failure: nothing written, the reason named, the key never in it", async () => {
    const e = engine({ status: 403 });
    const out = path.join(dir, "part6.mp3");
    const r = await synthesizeGoogleTimepointed(TEXT, out, dir, { ...deps(e), apiKey: "secret-google-key" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.audioWritten).toBe(false);
    expect(r.reason).toContain("HTTP 403");
    expect(r.reason).not.toContain("secret-google-key");
    expect(fs.existsSync(out)).toBe(false);
  });
});
