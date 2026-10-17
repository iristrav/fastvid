/**
 * VIDEO 662 — the fix round from render 71/72 (video 662, LA set against Brussels and Bruges).
 *
 *   1  a generated (AI) picture is archived (inactive AI-beelden archive), so a retry render finds it
 *   2  an in-point at or past the end of a clip's file never makes an empty segment
 *   3  a second place: narrowing never drops a named place; a need naming a place no query asked for
 *      goes first among the uncovered
 *   4  two moments of the same source video that look alike are a repeat
 *   5  the fallback scene's anchor is never "Meanwhile Brussels"; the label is cut from the phrase
 *   6  the animation floor's key words never run across a comma
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

import { keyWordsIn, nameIn } from "./animationFloor";
import { fingerprintOf, type FrameFingerprint } from "./contactSheet";
import { fallbackSceneWords } from "./fallbackScene";
import { emptyTimeline, type TimelineVideoClip } from "./projectTimeline";
import { placesDroppedByNarrowing, placesNamedIn } from "./searchQueryContract";
import { AI_ARCHIVE_SLUG, AUTO_ARCHIVES, autoArchiveKind } from "./stockArchive";
import { renderTimeline, TAIL_READ_SEC } from "./timelineRenderer";
import { footageFamily } from "./videoPipeline";
import { placeStandsAlone } from "./placeMismatch";
import { findVisualRepeats, SAME_SOURCE_PICTURE_BITS } from "./visualRepeatCheck";
import { namedSubjectCoverage } from "./youtubeVideoPool";

const SRC = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

/* ═══════════ 1 ═══════════ */

describe("1 — a generated picture is archived, so a retry render can read it back", () => {
  it("AI providers go to their own archive, which is never offered as archive footage", () => {
    for (const platform of ["stability", "elevenlabs_video", "replicate_pvideo"]) {
      expect(autoArchiveKind({ sourcePlatform: platform, sourceNote: `${platform}:abc` })).toBe("ai");
      expect(autoArchiveKind({ sourcePlatform: null, sourceNote: `${platform}:abc` })).toBe("ai");
    }
    expect(AUTO_ARCHIVES.ai.slug).toBe(AI_ARCHIVE_SLUG);
    expect(AUTO_ARCHIVES.ai.isActive).toBe(0);
    /** the other kinds are unchanged */
    expect(autoArchiveKind({ sourcePlatform: "youtube_cc", sourceNote: "youtube_cc:x" })).toBe("youtube");
    expect(autoArchiveKind({ sourcePlatform: "pexels", sourceNote: "pexels:1" })).toBe("stock");
    expect(autoArchiveKind({ sourcePlatform: "wikimedia", sourceNote: "wikimedia:1" })).toBe("other");
  });

  it("the ingestion files them there, uncut and without a text check (the owner's rule for AI pictures)", () => {
    const ING = SRC("archiveIngestion.ts");
    expect(ING).toContain('if (autoArchiveKind(metadata) === "ai") {');
    expect(ING).toContain('aiArchiveId = await ensureAutoMediaArchive("ai")');
    expect(ING).toContain("aiArchiveId == null &&\n      !metadata.alreadyOneShot");
    expect(ING).toContain("const overlay = articleScreenshot || aiArchiveId != null");
  });

  it("the generated-picture rung archives what it places, and places it whatever the archive answers", () => {
    const PIPE = SRC("videoPipeline.ts");
    const at = PIPE.indexOf("export async function generateMissingBeatImages(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain("await ensureArchiveBackedBeforePush(dedup, clip, clipContentKey(clip), scene.index, beat.index)");
    expect(body.indexOf("ensureArchiveBackedBeforePush")).toBeLessThan(body.indexOf("target.clips.push(clip)"));
    expect(body).toContain("placed anyway");
  });
});

/* ═══════════ 2 ═══════════ */

describe("2 — an in-point past the file's end never makes an empty segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v662-2-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("render 71's vc_d2fe49d8fe: a 4.07 s file with its in-point at 8.5 s — the film keeps its length", async () => {
    const mk = (name: string, src: string, sec: number) => {
      const out = path.join(dir, name);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-t", String(sec), "-pix_fmt", "yuv420p", "-c:v", "libx264", out]);
      return out;
    };
    const a = mk("a.mp4", "testsrc2=size=320x180:rate=30", 3);
    const short = mk("short.mp4", "mandelbrot=size=320x180:rate=30", 4.07);
    const timeline = emptyTimeline(662, { widthPx: 320, heightPx: 180, fps: 30 });
    const clip = (id: string, start: number, end: number, sourceIn: number, provider: string): TimelineVideoClip =>
      ({
        id, kind: "video", source: { provider, providerAssetId: id }, sourceIn,
        timelineStart: start, timelineEnd: end, motion: "none",
        transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: { kind: "none" },
      }) as unknown as TimelineVideoClip;
    const video = timeline.tracks.find((t) => t.kind === "VIDEO");
    if (video?.kind !== "VIDEO") throw new Error("no video track");
    video.clips.push(clip("first", 0, 2, 0, "a"), clip("late", 2, 4, 8.5, "short"));
    timeline.durationSec = 4;
    const out = path.join(dir, "film.mp4");
    const res = await renderTimeline({
      timeline,
      workDir: path.join(dir, "work"),
      outputPath: out,
      resolveMedia: async (c) => (c.source.provider === "short" ? short : a),
    });
    expect(res.skipped.filter((s) => s.includes("segment was empty"))).toEqual([]);
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim());
    expect(dur).toBeGreaterThan(3.9);
    expect(TAIL_READ_SEC).toBe(0.5);
  }, 300_000);
});

/* ═══════════ 3 ═══════════ */

describe("3 — a second place is searched for, and never narrowed away", () => {
  it("render 72: 'Venice Beach skateboarders Bruges canals' → 'Venice Beach' drops Bruges, so the query goes as it was", () => {
    expect(placesDroppedByNarrowing("Venice Beach skateboarders Bruges canals", "Venice Beach", undefined)).toEqual(["bruges"]);
    expect(placesDroppedByNarrowing("Bruges canals at dawn", "Bruges canals", undefined)).toEqual([]);
    expect(placesDroppedByNarrowing("skateboarders at sunset", "skateboarders", undefined)).toEqual([]);
    /** a verified place of the beat counts too */
    const ctx = { places: [{ term: "Venice Beach", verified: true }] } as never;
    expect(placesDroppedByNarrowing("Venice Beach skateboarders", "skateboarders", ctx)).toEqual(["Venice Beach"]);
    /** only a query that sets two places side by side keeps both; one place may be narrowed away as before (render 594) */
    expect(placesNamedIn("Venice Beach skateboarders Bruges canals", undefined)).toHaveLength(2);
    expect(placesNamedIn("Kris Jenner New York City bombard", undefined)).toHaveLength(1);
    expect(SRC("searchQueryContract.ts")).toContain("const dropped = named.length >= 2 ? placesDroppedByNarrowing(text, out.query, ctx) : [];");
  });

  it("a need that names a place no query has asked for goes first among the uncovered, whatever its weight", () => {
    const pool = {
      candidates: [],
      sentences: ["LA sprawls under the sun.", "Skaters fill Venice Beach.", "Hollywood signs glow.", "Bruges wakes to misty canals."],
      query1: "Los Angeles",
      visualNeeds: [
        { subject: "Venice Beach skateboarders", beats: [1, 2] },
        { subject: "Hollywood sign", beats: [0, 2] },
        { subject: "Bruges misty mornings", beats: [3] },
      ],
    };
    const order = namedSubjectCoverage(pool as never).map((n) => n.name);
    expect(order[0]).toBe("Bruges misty mornings");
    /** the output keeps its shape */
    expect(Object.keys(namedSubjectCoverage(pool as never)[0]!).sort()).toEqual(["beats", "covered", "kind", "name", "reason", "score"]);
    /** a person or landmark whose name starts with a place is not a place: "Paris Hilton", "Berlin Wall" */
    expect(placeStandsAlone("Paris Hilton", "paris")).toBe(false);
    expect(placeStandsAlone("Berlin Wall 1989", "berlin")).toBe(false);
    expect(placeStandsAlone("Bruges misty mornings", "bruges")).toBe(true);
    /** once a query asked for Bruges, it no longer jumps the queue */
    const asked = namedSubjectCoverage(pool as never, undefined, { asked: ["Bruges canals"] }).map((n) => n.name);
    expect(asked[0]).not.toBe("Bruges misty mornings");
  });
});

/* ═══════════ 4 ═══════════ */

function frame(seed: number): FrameFingerprint {
  const g = new Uint8Array(72);
  let x = seed * 2654435761;
  for (let i = 0; i < 72; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    g[i] = 30 + (x % 190);
  }
  return fingerprintOf(g, 0);
}
/** A frame a few bits away from `f` — the same street, a moment later. */
function near(f: FrameFingerprint, bits: number): FrameFingerprint {
  let hash = f.hash;
  for (let i = 0; i < bits; i++) hash ^= 1n << BigInt(i * 5);
  return { ...f, hash };
}

describe("4 — two moments of one source video that look alike are a repeat", () => {
  it("render 72's boulevard (uOqcqEiSTPE at 30 s and 149 s): close but not near-identical frames", () => {
    const at30 = [frame(1), frame(2), frame(3)];
    const at149 = [near(frame(1), 9), frame(8), frame(9)];
    /** from two different sources: not a repeat (the strict rule) */
    expect(findVisualRepeats([{ id: "a", prints: at30 }, { id: "b", prints: at149 }])).toEqual([]);
    /** from the same source video: one alike pair is enough */
    expect(
      findVisualRepeats([
        { id: "a", prints: at30, family: "youtube:uOqcqEiSTPE" },
        { id: "b", prints: at149, family: "youtube:uOqcqEiSTPE" },
      ])
    ).toEqual([{ id: "b", sameAs: "a" }]);
    expect(SAME_SOURCE_PICTURE_BITS).toBe(12);
    /** really different footage of the same video stays */
    expect(
      findVisualRepeats([
        { id: "a", prints: at30, family: "youtube:x" },
        { id: "c", prints: [frame(20), frame(21)], family: "youtube:x" },
      ])
    ).toEqual([]);
  });

  it("the source family is read from a moment's key, and from the lineage root in the pipeline", () => {
    expect(footageFamily("youtube_cc:cfc79df4f69f0a00@t927d40")).toBe("youtube_cc:cfc79df4f69f0a00");
    expect(footageFamily("curated:asset:61548")).toBeNull();
    expect(SRC("videoPipeline.ts")).toContain("family: clipSourceFamily(dedup, clipPath)");
  });
});

/* ═══════════ 5 + 6 ═══════════ */

describe("5 — the fallback scene's words; 6 — key words never cross a comma", () => {
  it("'Meanwhile, Brussels often sits…' → the label is Brussels, and the phrase does not repeat it", () => {
    expect(nameIn("Meanwhile, Brussels often sits beneath a grey sky.")).toBe("Brussels");
    const w = fallbackSceneWords("Meanwhile, Brussels often sits beneath a grey and drizzling sky.")!;
    expect(w.label).toBe("Brussels");
    expect(w.phrase ?? "").not.toMatch(/Brussels|Meanwhile|often/i);
  });

  it("a real two-word name is still a name; the scene shows the name alone (VIDEO 663: one or two words)", () => {
    expect(nameIn("The bank was led by Christine Lagarde in 2026.")).toBe("Christine Lagarde");
    expect(fallbackSceneWords("By loosening monetary controls while inflation rose, the ECB acted.")).toEqual({
      graphicType: "label",
      label: "ECB",
    });
  });

  it("render 72's 'breathtakingly distinct, revealing…' never becomes 'distinct revealing'", () => {
    const k = keyWordsIn("Its beauty is breathtakingly distinct, revealing another world.")!;
    expect(k.split(" ")).not.toEqual(expect.arrayContaining(["distinct", "revealing"]));
  });
});
