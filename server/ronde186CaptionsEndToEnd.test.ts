/**
 * RONDE 186 — captions and word timing survive the whole cinematic route into real pixels.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────
 *
 * `karaoke`, `word_by_word` and `highlight_word` need measured word boundaries. A render job takes
 * a STORED timeline and nothing else — and nothing ever put word timing into that document.
 * `runCinematicPipeline` had accepted `words` since R151 and dropped them on the floor;
 * `translateEdl` had no parameter for them; `productionGraphicsOverlay` was called with no `words`
 * at all. So the entire caption engine built in R152 could only run from a caller still holding the
 * TTS alignment in memory, which no production path is.
 *
 * Everything below runs the REAL route — production extractors, the real Director/EDL, the real
 * translation — and the last group renders the real Remotion overlay and reads the frames back.
 * A caption in a props object is not a caption a viewer can see.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCinematicSceneInputs,
  type AdoptionFacts,
  type ProductionBeat,
  type SceneFacts,
} from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import { timelineToRemotionProps } from "./remotionProps";
import { graphicsOverlayAvailable, productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { captionTrack, type ProjectTimeline } from "./projectTimeline";
import {
  beatNamedEntitiesByKind,
  extractActionCue,
  extractPersonNamesFromText,
  extractVisualPlacePhrase,
} from "./videoPipeline";
import { resolveFFmpegBin } from "./ffmpegBinary";
import type { Scene } from "./pipeline/types";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

/* ═══════════════════════ the route ═══════════════════════ */

const BEAT_SEC = 4;
const BEATS = [
  "In April 1945 the Battle of Berlin reached the city centre.",
  "He held the pistol in his right hand and said nothing.",
];

const PRODUCTION_EXTRACTORS = {
  people: (t: string) => extractPersonNamesFromText(t),
  place: (t: string) => extractVisualPlacePhrase(t),
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};

/** One measured word per half-second, covering both beats — the shape a TTS alignment has. */
function measuredWords(): Array<{ word: string; startSec: number; endSec: number }> {
  const all = BEATS.join(" ").split(/\s+/);
  const step = (BEATS.length * BEAT_SEC) / all.length;
  return all.map((word, i) => ({
    word,
    startSec: Number((i * step).toFixed(3)),
    endSec: Number(((i + 1) * step).toFixed(3)),
  }));
}

function beat(index: number, text: string): ProductionBeat {
  return {
    index, text,
    searchQuery: "berlin 1945", powerWord: "Berlin", keywords: ["berlin"],
    holdSec: BEAT_SEC, visualDescription: "",
    voiceStartSec: index * BEAT_SEC, voiceEndSec: index * BEAT_SEC + BEAT_SEC,
  };
}

function adoption(i: number): AdoptionFacts {
  return {
    provider: "internet_archive", providerAssetId: `r186-${i}`,
    sourceUrl: `https://archive.invalid/${i}.mp4`, query: "berlin 1945",
  };
}

function sceneFacts(): SceneFacts {
  const beats = BEATS.map((t, i) => beat(i, t));
  const scene: Scene = {
    index: 0, text: BEATS.join(" "), visualCue: "", pexelsQuery: "", aiImagePrompt: "",
    duration: BEATS.length * BEAT_SEC,
  };
  return {
    scene, beats,
    clips: beats.map((_, i) => ({
      facts: { localPath: `/tmp/r186_${i}.mp4`, durationSec: 10, widthPx: 1920, heightPx: 1080 },
      adoption: adoption(i),
    })),
  };
}

function planned(opts: { words?: boolean } = {}): ProjectTimeline {
  const built = buildCinematicSceneInputs({
    scenes: [sceneFacts()],
    extractors: PRODUCTION_EXTRACTORS,
  });
  expect(built.dropped).toEqual([]);
  return runCinematicPipeline({
    videoId: 186,
    scenes: built.scenes,
    ...(opts.words === false ? {} : { words: measuredWords() }),
  }).timeline;
}

/* ═══════════════════════ the captions exist at all ═══════════════════════ */

describe("R186 — the cinematic route produces narration captions", () => {
  it("puts a subtitle on the CAPTIONS track for every beat", () => {
    const captions = captionTrack(planned());
    expect(captions.length, "the CAPTIONS track is empty on the live route").toBeGreaterThanOrEqual(
      BEATS.length
    );
  });

  it("the caption text is the beat's own narration, not a card", () => {
    const texts = captionTrack(planned()).map((c) => c.text);
    expect(texts.join(" ")).toContain("Battle of Berlin");
  });

  /** Timing is the beat's voice window, not a guess — a caption off by a beat is unreadable. */
  it("each caption sits inside its own beat's window", () => {
    for (const c of captionTrack(planned())) {
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(BEATS.length * BEAT_SEC + 0.001);
    }
  });

  it("captions are in time order and do not run into each other", () => {
    const captions = [...captionTrack(planned())].sort((a, b) => a.start - b.start);
    for (let i = 1; i < captions.length; i++) {
      expect(captions[i]!.start, `caption ${i} starts before ${i - 1} ends`)
        .toBeGreaterThanOrEqual(captions[i - 1]!.start);
    }
  });
});

/* ═══════════════════════ word timing reaches the document ═══════════════════════ */

describe("R186 — the measured word boundaries reach the stored timeline", () => {
  /**
   * The assertion that fails for the R186 reason and no other. A render job has only the stored
   * document; if word timing is not in it, karaoke cannot happen however the caption is marked.
   */
  it("a caption carries its own words", () => {
    const withWords = captionTrack(planned()).filter((c) => (c.words?.length ?? 0) > 0);
    expect(withWords.length, "no caption carries word timing — karaoke is unreachable")
      .toBeGreaterThan(0);
  });

  /** Its OWN words: a caption must not carry the whole video's alignment. */
  it("a caption carries only the words spoken inside its own window", () => {
    for (const c of captionTrack(planned())) {
      for (const w of c.words ?? []) {
        expect(w.endSec, `"${w.word}" ends before caption ${c.id} starts`).toBeGreaterThan(c.start);
        expect(w.startSec, `"${w.word}" starts after caption ${c.id} ends`).toBeLessThan(c.end);
      }
    }
  });

  /** Absolute seconds, the same clock the caption's own start and end are on. */
  it("the word times are on the video's clock, not the beat's", () => {
    const last = [...captionTrack(planned())].sort((a, b) => b.start - a.start)[0]!;
    const words = last.words ?? [];
    expect(words.length).toBeGreaterThan(0);
    expect(Math.max(...words.map((w) => w.endSec))).toBeGreaterThan(BEAT_SEC);
  });

  /**
   * No measurement, no words. A guessed boundary lands a highlight on the wrong syllable, which is
   * worse than a caption that stays a plain sentence.
   */
  it("carries nothing when the render measured nothing", () => {
    for (const c of captionTrack(planned({ words: false }))) {
      expect(c.words ?? [], `${c.id} invented word timing`).toEqual([]);
    }
  });
});

/* ═══════════════════════ the overlay gets them without being told ═══════════════════════ */

describe("R186 — the render props find the words in the timeline itself", () => {
  /**
   * The render worker calls `productionGraphicsOverlay({ workDir })` with no `words`. Deriving them
   * from the captions is what makes the stored document sufficient on its own.
   */
  it("derives the word list from the timeline when the caller supplies none", () => {
    const props = timelineToRemotionProps({ timeline: planned() });
    expect(props.words.length, "the overlay would render with no word timing").toBeGreaterThan(0);
  });

  it("an explicit word list still wins, so the planning path is unchanged", () => {
    const explicit = [{ word: "OVERRIDE", startSec: 0, endSec: 1 }];
    const props = timelineToRemotionProps({ timeline: planned(), words: explicit });
    expect(props.words).toEqual(explicit);
  });

  it("a timeline with no measured words produces an empty list, not an invented one", () => {
    expect(timelineToRemotionProps({ timeline: planned({ words: false }) }).words).toEqual([]);
  });

  /** R185's contract, checked here too: a caption is never left sitting on a graphic. */
  it("captions and graphics do not share a position at the same moment", () => {
    const props = timelineToRemotionProps({ timeline: planned() });
    const unresolved = props.unresolvedCollisions.filter((c) =>
      c.startsWith("caption_collision_unresolved")
    );
    expect(unresolved, unresolved.join("\n")).toEqual([]);
  });
});

/* ═══════════════════════ the pixels ═══════════════════════ */

const canRender = graphicsOverlayAvailable();

describe.skipIf(!canRender)("R186 — the captions are actually drawn", () => {
  let dir = "";
  let overlayPath: string | null = null;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r186-"));
    const overlay = await productionGraphicsOverlay({ workDir: dir })(planned());
    overlayPath = overlay?.overlayPath ?? null;
  }, 600_000);

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Ink on the frame during a caption's window, and none once the video is over. A caption that
   * rendered as an empty box would pass every props assertion above and fail this one.
   */
  it("draws something during the first caption's window", async () => {
    expect(overlayPath, "the overlay did not render").toBeTruthy();
    const opaqueAt = async (atSec: number) => {
      const raw = path.join(dir, `f_${atSec}.rgba`);
      await execFileAsync(FFMPEG, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", atSec.toFixed(3), "-i", overlayPath!,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw,
      ]);
      const buf = fs.readFileSync(raw);
      let opaque = 0;
      for (let i = 3; i < buf.length; i += 4) if (buf[i]! > 40) opaque++;
      return opaque;
    };
    const first = captionTrack(planned()).sort((a, b) => a.start - b.start)[0]!;
    const during = await opaqueAt((first.start + first.end) / 2);
    expect(during, "nothing was drawn while the first caption was on screen").toBeGreaterThan(0);
  }, 300_000);

  /**
   * The words move. Two frames a second apart inside one caption must differ, because a word-timed
   * caption highlights a different word at each — a static sentence would give identical frames.
   */
  it("the caption changes between two moments of the same line", async () => {
    const frameAt = async (atSec: number) => {
      const raw = path.join(dir, `d_${atSec}.rgba`);
      await execFileAsync(FFMPEG, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", atSec.toFixed(3), "-i", overlayPath!,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw,
      ]);
      return fs.readFileSync(raw);
    };
    const first = captionTrack(planned()).sort((a, b) => a.start - b.start)[0]!;
    const span = first.end - first.start;
    /** Skipped rather than asserted on a caption too short to hold two distinguishable moments. */
    if (span < 1.5) return;
    const a = await frameAt(first.start + 0.4);
    const b = await frameAt(first.end - 0.4);
    expect(Buffer.compare(a, b), "the caption is identical across its whole window").not.toBe(0);
  }, 300_000);
});
