/**
 * PRE-DEPLOY CHECK — SENTENCE TIMING FROM PAUSES, MEASURED ON NARRATION WITH KNOWN BOUNDARIES.
 *
 * The fixtures in testFixtures/voice are synthesised narration (espeak-ng, English and Dutch; see
 * scripts/make-voice-timing-fixtures.py): every sentence was synthesised ALONE, trimmed, and the
 * sentences were joined with pauses of chosen lengths — so the true start and end of every spoken
 * sentence is known to the millisecond and written next to the audio (`*.json`). The real
 * `silencedetect` runs on the real file; what is asserted is the rule that matters for the film:
 * every spoken word of a sentence lies INSIDE the window the measurement gives that sentence (a cut
 * inside the pause, never inside speech), the windows are contiguous and cover the whole narration,
 * and a narration whose pauses cannot tell the sentences apart is REFUSED, not guessed.
 *
 * What this does NOT prove: the behaviour of a particular TTS voice (Fish Audio, Google) — their
 * pause lengths are measured on the first production render (`[VoiceTiming] … margin=`), and the
 * timing is reported as APPROXIMATE (`measured_silence`), never as exact.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { AMBIGUOUS_PAUSE_MARGIN, measureSentenceWindows, sentenceWindowsFromSilences } from "./voiceTimingFromSilence";

const FFMPEG = resolveFFmpegBin();
const DIR = path.join(__dirname, "testFixtures", "voice");
type Truth = { sentences: Array<{ text: string; start: number; end: number }>; totalSec: number; pauses: number[]; commaPause: number | null; voice: string };
const truthOf = (name: string): Truth => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Truth;
const measure = (name: string) => {
  const t = truthOf(name);
  return measureSentenceWindows(FFMPEG, path.join(DIR, `${name}.m4a`), t.totalSec, t.sentences).then((r) => ({ r, t }));
};
/** A tolerance for the AAC encode and the silence detector's edges — well under a syllable. */
const EDGE_SEC = 0.06;

function assertWindowsHoldTheSpeech(name: string, r: Awaited<ReturnType<typeof measure>>["r"], t: Truth) {
  expect(r.ok, `${name}: ${r.ok ? "" : r.reason}`).toBe(true);
  if (!r.ok) return;
  expect(r.windows).toHaveLength(t.sentences.length);
  r.windows.forEach((w, i) => {
    const s = t.sentences[i]!;
    /** every word of the sentence is inside its window — a cut never falls inside speech */
    expect(w.startSec, `${name} sentence ${i} starts before its window`).toBeLessThanOrEqual(s.start + EDGE_SEC);
    expect(w.endSec, `${name} sentence ${i} ends after its window`).toBeGreaterThanOrEqual(s.end - EDGE_SEC);
    /** and the window holds no neighbour: it ends before the next sentence starts and starts after the previous ended */
    if (i < t.sentences.length - 1) expect(w.endSec).toBeLessThanOrEqual(t.sentences[i + 1]!.start + EDGE_SEC);
    if (i > 0) expect(w.startSec).toBeGreaterThanOrEqual(t.sentences[i - 1]!.end - EDGE_SEC);
    /** contiguous: no gap and no overlap between neighbours */
    if (i > 0) expect(w.startSec).toBe(r.windows[i - 1]!.endSec);
  });
  /** every boundary is a cut inside an inserted pause, and its uncertainty (half the pause) is stated */
  r.boundaries.forEach((b, i) => {
    expect(b.cutSec).toBeGreaterThan(t.sentences[i]!.end - EDGE_SEC);
    expect(b.cutSec).toBeLessThan(t.sentences[i + 1]!.start + EDGE_SEC);
    expect(b.pauseSec).toBeGreaterThan(0);
    expect(b.pauseSec).toBeLessThanOrEqual(t.pauses[i]! + 0.4);
  });
  expect(r.marginRatio).toBeGreaterThanOrEqual(AMBIGUOUS_PAUSE_MARGIN);
}

describe("PRE-DEPLOY — sentence windows measured from real pauses in synthesised narration", () => {
  it("en4: four English sentences with comma pauses shorter than the sentence pauses — every word inside its window, cuts inside the pauses", async () => {
    const { r, t } = await measure("en4");
    assertWindowsHoldTheSpeech("en4", r, t);
    expect(r.ok && r.pausesUsed).toBe(3);
  }, 60_000);

  it("nl5: five Dutch sentences of very different lengths — no sentence shifted, shortened or merged", async () => {
    const { r, t } = await measure("nl5");
    assertWindowsHoldTheSpeech("nl5", r, t);
    expect(r.ok && r.windows.map((w) => Number((w.endSec - w.startSec).toFixed(1)))).toEqual(
      t.sentences.map((s, i) => expect.closeTo(s.end - s.start + (i === 0 ? 0 : t.pauses[i - 1]! / 2) + (i === t.sentences.length - 1 ? 0 : t.pauses[i]! / 2), 0))
    );
  }, 60_000);

  it("one: a single sentence is the whole narration between its leading and trailing silence", async () => {
    const { r, t } = await measure("one");
    assertWindowsHoldTheSpeech("one", r, t);
    expect(r.ok && r.pausesUsed).toBe(0);
  }, 60_000);

  it("tight3: sentence pauses barely above the detector's floor (0.28–0.30 s) still cut correctly", async () => {
    const { r, t } = await measure("tight3");
    assertWindowsHoldTheSpeech("tight3", r, t);
  }, 60_000);

  it("trap4: a comma pause LONGER than the sentence pauses — the measurement is REFUSED (margin 1.0), the scene stays estimated; it is never passed off as sentence timing", async () => {
    const { r } = await measure("trap4");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("the pauses do not tell the sentences apart");
    expect(r.reason).toContain(`${AMBIGUOUS_PAUSE_MARGIN}x is needed`);
    /** the windows it WOULD have produced put two cuts inside sentence 2 — exactly the error the margin exists to refuse */
    const t = truthOf("trap4");
    const silences = [
      { startSec: 2.35, endSec: 2.83 }, { startSec: 4.2, endSec: 5.02 }, { startSec: 5.65, endSec: 6.47 }, { startSec: 7.46, endSec: 7.91 }, { startSec: 8.99, endSec: 9.44 },
    ];
    const blind = sentenceWindowsFromSilences(t.sentences, silences, t.totalSec);
    expect(blind.ok).toBe(false);
  }, 60_000);

  it("the text sanity check alone would NOT have caught the trap (the rates stay within a factor 3): the margin is the guard", () => {
    const t = truthOf("trap4");
    /** the three longest pauses, as trap4 has them: two comma pauses of 0.82 s and one sentence pause — margin 1.0 */
    const chosenWrong = [{ startSec: 2.35, endSec: 2.83 }, { startSec: 4.2, endSec: 5.02 }, { startSec: 5.65, endSec: 6.47 }];
    const r = sentenceWindowsFromSilences(t.sentences, chosenWrong, t.totalSec);
    /** with ONLY those three pauses on offer (no unchosen pause → margin ∞) the rate check is what is left, and it passes the wrong cut */
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows[1]!.endSec).toBeLessThan(t.sentences[1]!.end);
  });
});
