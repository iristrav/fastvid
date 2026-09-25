import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MUSIC_SEARCHES,
  catalogueFromPool,
  isCc0Licence,
  productionMusicCatalogue,
  resetMusicPoolCache,
  searchFreesoundMusic,
  trackFromFreesound,
} from "./freesoundMusicCatalogue";
import { EMPTY_MUSIC_CATALOGUE, formatCueSheet, planMusicCues, scoreCues, type MusicTrack } from "./musicDirector";
import { buildAudioGraph, type MixInput } from "./timelineFilters";

/**
 * RONDE 653 — the delivered (cinematic) film had no music: the cue sheet was planned on every
 * render and every cue came back UNSCORED, because the only catalogue ever registered was empty.
 */
const search = MUSIC_SEARCHES[0]!;

function fsResult(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Track ${id}`,
    license: "http://creativecommons.org/publicdomain/zero/1.0/",
    duration: 120,
    username: "someone",
    tags: ["music", "ambient"],
    url: `https://freesound.org/people/someone/sounds/${id}/`,
    ...over,
  };
}

describe("only what Freesound itself says is CC0 enters the catalogue", () => {
  it("reads the licence from the result, not from the filter that asked for it", () => {
    expect(isCc0Licence("http://creativecommons.org/publicdomain/zero/1.0/")).toBe(true);
    expect(isCc0Licence("Creative Commons 0")).toBe(true);
    expect(isCc0Licence("http://creativecommons.org/licenses/by/4.0/")).toBe(false);
    expect(isCc0Licence("http://creativecommons.org/licenses/by-nc/4.0/")).toBe(false);
    expect(isCc0Licence(undefined)).toBe(false);
  });

  it("keeps a CC0 track with Freesound's own id, title, length and page", () => {
    const t = trackFromFreesound(fsResult(501), search)!;
    expect(t.identity).toMatchObject({ provider: "freesound", providerAssetId: "501" });
    expect(t.licence).toBe("CC0");
    expect(t.durationSec).toBe(120);
    expect(t.sourcePageUrl).toContain("/sounds/501/");
  });

  it("drops non-CC0, vocals, and tracks too short or too long to score with", () => {
    expect(trackFromFreesound(fsResult(1, { license: "http://creativecommons.org/licenses/by/3.0/" }), search)).toBeNull();
    expect(trackFromFreesound(fsResult(2, { tags: ["music", "vocals"] }), search)).toBeNull();
    expect(trackFromFreesound(fsResult(3, { duration: 8 }), search)).toBeNull();
    expect(trackFromFreesound(fsResult(4, { duration: 3600 }), search)).toBeNull();
  });
});

describe("the search asks Freesound once per mood and survives a moved endpoint", () => {
  it("falls back to the unified search path on 404, and never sends the key anywhere else", async () => {
    const urls: string[] = [];
    const lines: string[] = [];
    const pool = await searchFreesoundMusic({
      apiKey: "k",
      log: (l) => lines.push(l),
      fetch: async (url) => {
        urls.push(url);
        if (url.includes("/search/text/")) return { status: 404, json: async () => ({}) };
        return { status: 200, json: async () => ({ results: [fsResult(urls.length), fsResult(900)] }) };
      },
    });
    expect(urls.every((u) => u.startsWith("https://freesound.org/apiv2/"))).toBe(true);
    expect(urls.filter((u) => u.includes("/apiv2/search/?")).length).toBe(MUSIC_SEARCHES.length);
    expect(decodeURIComponent(urls[0]!)).toContain('license:"Creative Commons 0"');
    /** The same track found by two moods is kept once. */
    expect(pool.filter((t) => t.identity.providerAssetId === "900").length).toBe(1);
    expect(lines.some((l) => l.includes("keptCC0="))).toBe(true);
  });

  it("a failing search adds nothing and says why", async () => {
    const lines: string[] = [];
    const pool = await searchFreesoundMusic({
      apiKey: "k",
      log: (l) => lines.push(l),
      fetch: async () => {
        throw new Error("network down");
      },
    });
    expect(pool).toEqual([]);
    expect(lines.some((l) => l.includes("network down"))).toBe(true);
  });

  afterEach(() => {
    resetMusicPoolCache();
    vi.unstubAllEnvs();
  });

  it("without FREESOUND_API_KEY production gets the empty catalogue, never an invented track", async () => {
    vi.stubEnv("FREESOUND_API_KEY", "");
    expect(await productionMusicCatalogue()).toBe(EMPTY_MUSIC_CATALOGUE);
  });
});

describe("one film is scored from the pool without repeating a track", () => {
  const pool: MusicTrack[] = [
    trackFromFreesound(fsResult(11, { duration: 200 }), MUSIC_SEARCHES[0]!)!,
    trackFromFreesound(fsResult(12, { duration: 200 }), MUSIC_SEARCHES[2]!)!,
    trackFromFreesound(fsResult(13, { duration: 40 }), MUSIC_SEARCHES[3]!)!,
  ];

  it("fills every cue it can, each with a different track long enough to cover it", () => {
    const cues = planMusicCues({ curve: [], sceneWindows: [{ startSec: 0, endSec: 60 }], totalDurationSec: 60 });
    const scored = scoreCues(cues, catalogueFromPool("freesound-cc0", pool));
    const filled = scored.filter((s) => s.track);
    expect(filled.length).toBeGreaterThan(0);
    const ids = filled.map((s) => s.track!.identity.providerAssetId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of filled) expect(s.track!.durationSec).toBeGreaterThanOrEqual(s.cue.endSec - s.cue.startSec);
    const total = formatCueSheet(scored, "freesound-cc0").at(-1)!;
    expect(total).toContain("catalogue=freesound-cc0");
    expect(total).not.toContain("THIS FILM HAS NO MUSIC");
  });

  it("an empty pool is the empty catalogue, and the cue sheet says so", () => {
    expect(catalogueFromPool("x", [])).toBe(EMPTY_MUSIC_CATALOGUE);
  });
});

describe("the production planner asks for the catalogue and hands it to the score", () => {
  const PROD = fs.readFileSync(path.join(__dirname, "cinematicProduction.ts"), "utf8");
  const PIPE = fs.readFileSync(path.join(__dirname, "cinematicPipeline.ts"), "utf8");
  it("fetches it before the plan, never fails the plan over it, and logs its name", () => {
    expect(PROD).toContain(": productionMusicCatalogue()");
    expect(PROD).toContain("return EMPTY_MUSIC_CATALOGUE;");
    expect(PROD).toContain("musicCatalogue,\n    });");
    expect(PROD).toContain("formatCueSheet(result.cueSheet, musicCatalogue.name)");
    expect(PIPE).toContain("params.musicCatalogue\n  );");
  });
});

/**
 * The mix itself, through real ffmpeg: a 10 s picture, a 10 s voice and a 60 s music file placed
 * for 0–8 s. The renderer's own graph and its apad/-shortest mux. The file must be 10 s long, carry
 * audio, and the music must be audible while it plays and gone after its cue.
 */
describe("a scored cue is audible in the muxed file, and the edit keeps its length", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fv_music_"));
  const run = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const probe = (file: string, args: string[]) =>
    execFileSync("ffprobe", ["-v", "error", ...args, file], { encoding: "utf8" }).trim();

  it("muxes voice + music to the picture's length, music under its cue only", () => {
    const pic = path.join(dir, "pic.mp4");
    const voice = path.join(dir, "voice.wav");
    const music = path.join(dir, "music.wav");
    const out = path.join(dir, "out.mp4");
    run(["-f", "lavfi", "-i", "color=c=black:s=320x180:d=10:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", pic]);
    /** The voice speaks 0–4 s and is silent 4–10 s, so ducking releases and the bed is measurable. */
    run(["-f", "lavfi", "-i", "sine=frequency=880:duration=4", "-af", "apad=whole_dur=10", voice]);
    run(["-f", "lavfi", "-i", "sine=frequency=220:duration=60", music]);
    const inputs: MixInput[] = [
      { index: 1, kind: "VOICE", startSec: 0, gain: 1, durationSec: 10 },
      { index: 2, kind: "MUSIC", startSec: 0, gain: 0.22, fadeInSec: 1.5, fadeOutSec: 2, durationSec: 8, duckUnderVoice: true },
    ];
    const graph = buildAudioGraph(inputs)!;
    run([
      "-i", pic, "-i", voice, "-i", music,
      "-filter_complex", `${graph.filter};[${graph.outLabel}]apad=whole_dur=10[m]`,
      "-map", "0:v", "-map", "[m]", "-c:v", "copy", "-c:a", "aac", "-shortest", out,
    ]);
    expect(Number(probe(out, ["-show_entries", "format=duration", "-of", "csv=p=0"]))).toBeCloseTo(10, 0);
    expect(probe(out, ["-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])).toBe("audio");

    const musicOnly = levelVia(out, 4.5, 5.5);
    const afterCue = levelVia(out, 8.5, 9.5);
    expect(musicOnly).toBeGreaterThan(-45);
    expect(afterCue).toBeLessThan(musicOnly - 20);
  });
});

/** mean_volume of a window, via ffmpeg's own volumedetect (it reports on stderr). */
function levelVia(file: string, from: number, to: number): number {
  const out = execFileSync(
    "sh",
    ["-c", `ffmpeg -hide_banner -ss ${from} -to ${to} -i "${file}" -af volumedetect -f null - 2>&1`],
    { encoding: "utf8" }
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(out);
  return m ? Number(m[1]) : Number.NEGATIVE_INFINITY;
}
