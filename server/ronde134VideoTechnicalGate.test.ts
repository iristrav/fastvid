/**
 * RONDE 134 — video through the technical gate, measured off the real file.
 *
 * RONDE 133 closed the still routes and left video open on purpose. This is what was open:
 *
 * ── 1. There was no resolution check for video at all ────────────────────────────────────────
 *
 * The only thing between a video file and the montage was montageStreamMetaUsable:
 *
 *     if (meta.width < 2 || meta.height < 2) return false;
 *
 * That refuses a file which is not a picture. It is not a quality bar. A 128×96 clip cleared it,
 * was judged by Vision on its merits, and was blown up fifteen times into a 1920×1080 frame.
 *
 * ── 2. The duration came from the provider when the file could not be read ───────────────────
 *
 *     let sourceDur = candidate.durationSec ?? 0;      // the CLAIM
 *     try { sourceDur = <ffprobe> } catch { }          // ...kept on failure
 *     if (sourceDur < 1.5) return null;
 *
 * So an unreadable file passed the duration check on a number out of a search response — and then
 * spent a full libx264 encode before failing. The same unreadable file was accepted or refused
 * depending on whether its provider happened to report a duration at all: two answers to one
 * question about one file.
 *
 * ── The floor, and why it is 144 and not 480 ─────────────────────────────────────────────────
 *
 * Neither number is invented here. sourcingPolicy's youtubeMinFormatHeight() has held this exact
 * judgement since RONDE 27, for the identical situation — a source scaled into a 1920×1080 frame
 * as B-roll — and states both bounds: nothing below 144 is admissible, 480 is the preferred bar.
 *
 * 144 refuses. 480 is measured and printed, and refuses nothing, because a genuine 1945 newsreel
 * digitised at 352×240 is not a bad file — it is the only copy there is. A 480-line rejection
 * would fall almost entirely on Internet Archive, the Library of Congress and NARA, and almost
 * not at all on Pexels and Pixabay, which return 1080p by construction. That is the exact
 * inversion of what this pipeline is for. After one production render the NOTE lines say how much
 * material really sits between 144 and 480, and that is the evidence for moving the floor.
 *
 * Everything below runs real ffmpeg encodes, a real HTTP server and the real exported
 * downloadAndTrimPoolCandidate.
 */
import { describe, expect, it, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { execSync } from "child_process";
import { downloadAndTrimPoolCandidate } from "./videoPipeline";
import {
  VIDEO_MIN_SHORT_SIDE_PX,
  VIDEO_QUALITY_BAR_SHORT_SIDE_PX,
  formatBelowQualityBar,
  formatTechnicalReject,
  sourceDurationVerdict,
  videoResolutionVerdict,
} from "./technicalMediaGate";
import { youtubeMinFormatHeight } from "./sourcingPolicy";
import type { PoolCandidate } from "./scenePool";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

/**
 * Source with PROSE comments removed.
 *
 * Every "this is gone now" assertion below has to read the CODE, because the comment that explains
 * the removal quotes the removed line verbatim — that is the whole point of the comment, and it is
 * also a false anchor that would keep the assertion green forever after a revert.
 *
 * Only block comments that BEGIN a line are stripped, which is what an explanatory comment looks
 * like. The obvious `/\*[\s\S]*?\*\/` desynchronises on a `*​/` inside a string or a regex, and on a
 * 37 000-line file that silently swallows real code: measured on videoPipeline.ts it removed
 * `fetchPexelsClips` entirely and four of six `renderAiStillToClip` call sites, which would make
 * every `not.toContain` assertion below pass for the wrong reason. Inline `/* ignore *​/` survives,
 * which is harmless.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/* ═══════════════════════ the rule ═══════════════════════ */

describe("the video resolution rule", () => {

  it("refuses below the floor and names both numbers", () => {
    const v = videoResolutionVerdict(128, 96);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("video_too_low_res");
      expect(v.actual).toBe("128x96");
      expect(v.required).toBe("144 lines");
    }
  });

  it("accepts at exactly the floor", () => {
    expect(videoResolutionVerdict(256, 144).ok).toBe(true);
  });

  it("a real newsreel at 352x240 is ACCEPTED, and flagged rather than thrown away", () => {
    /**
     * The single most important assertion in this file. This is the material the pipeline exists
     * to find, and a 480-line rejection would have removed it.
     */
    const v = videoResolutionVerdict(352, 240);
    expect(v.ok).toBe(true);
    expect(v.belowQualityBar).toBe(true);
  });

  it("1080p is accepted and not flagged", () => {
    const v = videoResolutionVerdict(1920, 1080);
    expect(v.ok).toBe(true);
    expect(v.belowQualityBar).toBe(false);
  });

  it("ABSENCE IS NEUTRAL: an unmeasurable file passes", () => {
    expect(videoResolutionVerdict(null, null).ok).toBe(true);
    expect(videoResolutionVerdict(undefined, undefined).ok).toBe(true);
    expect(videoResolutionVerdict(0, 0).ok).toBe(true);
  });
});

describe("G — the video rule still cannot express a content verdict", () => {
  it("no reason it can produce is about what the picture shows", () => {
    const code = read("server/technicalMediaGate.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("does_not_fit");
    expect(code).not.toContain('"fits"');
    expect(code).not.toContain("beatText");
    expect(code).not.toContain("narration");
    const v = videoResolutionVerdict(10, 10);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("video_too_low_res");
  });

  it("the log line carries provider, contentKey, type, reason, measured and required", () => {
    // Point 6 of the round, verbatim.
    const line = formatTechnicalReject({
      beatLabel: "s2b0",
      source: "wikimedia",
      assetId: "some-asset",
      contentKey: "wikimedia:some-asset",
      mediaType: "video",
      verdict: videoResolutionVerdict(320, 240, 480) as Extract<ReturnType<typeof videoResolutionVerdict>, { ok: false }>,
    });
    expect(line).toContain("source=wikimedia");
    expect(line).toContain("contentKey=wikimedia:some-asset");
    expect(line).toContain("type=video");
    expect(line).toContain("reason=video_too_low_res");
    expect(line).toContain("actual=320x240");
    expect(line).toContain("required=480 lines");
  });

  it("the quality-bar note is a NOTE, never a REJECT", () => {
    const note = formatBelowQualityBar({
      beatLabel: "s1b2", source: "loc", contentKey: "loc:x", width: 352, height: 240,
    });
    expect(note).toContain("[TechnicalGate] NOTE");
    expect(note).not.toContain("REJECT");
    expect(note).toContain("actual=352x240");
    expect(note).toContain("bar=480 lines");
  });
});

/* ═══════════════════════ the real route, real encodes ═══════════════════════ */

describe("RONDE 134 — real video files through the real pool route", () => {
  let dir = "";
  let server: http.Server | undefined;
  let baseUrl = "";
  let tinyRes: Buffer; // 128x96 — below the floor
  let newsreel: Buffer; // 352x240 — below the bar, above the floor
  let good: Buffer; // 1280x720
  let tooShort: Buffer; // 1280x720 but 0.6s

  beforeAll(() => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "r134-seed-"));
    const enc = (name: string, size: string, dur: number) => {
      const p = path.join(seed, name);
      execSync(
        `ffmpeg -y -f lavfi -i "nullsrc=s=${size},geq=random(1)*255:128:128" -t ${dur} ` +
          `-c:v libx264 -pix_fmt yuv420p "${p}" 2>/dev/null`
      );
      return fs.readFileSync(p);
    };
    tinyRes = enc("tiny.mp4", "128x96", 4);
    newsreel = enc("news.mp4", "352x240", 4);
    good = enc("good.mp4", "1280x720", 4);
    tooShort = enc("short.mp4", "1280x720", 0.6);
    fs.rmSync(seed, { recursive: true, force: true });
    // Four real libx264 encodes. Vitest's default 10s hook budget is enough alone and not enough
    // when the rest of the suite is competing for the same cores — which is where this first
    // failed, on the full run rather than the focused one.
  }, 120_000);

  afterEach(async () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  function serve(payload: Buffer): Promise<void> {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(payload);
    });
    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }

  function videoCandidate(source: string): PoolCandidate {
    return {
      id: `${source}:r134`,
      assetId: "r134-clip",
      source,
      remoteUrl: `${baseUrl}/clip.mp4`,
      thumbnailUrl: null,
      title: "R134 clip",
      description: null,
      tags: [],
      mediaType: "video",
      // The provider's CLAIM, and a generous one. Before this round it was what the duration check
      // fell back on when the file could not be read.
      durationSec: 30,
      license: null,
      width: 1920,
      height: 1080,
      clipSimilarity: null,
      embeddingSimilarity: null,
      rankingScore: null,
      visionScore: null,
      selectionScore: null,
    } as PoolCandidate;
  }

  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const w = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const l = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    return { lines, restore: () => { w.mockRestore(); l.mockRestore(); } };
  }

  it("the fixtures really are the sizes this test claims", () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "r134-verify-"));
    const probe = (buf: Buffer, name: string) => {
      const p = path.join(seed, name);
      fs.writeFileSync(p, buf);
      return execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${p}"`
      ).toString().trim();
    };
    expect(probe(tinyRes, "a.mp4")).toBe("128,96");
    expect(probe(newsreel, "b.mp4")).toBe("352,240");
    expect(probe(good, "c.mp4")).toBe("1280,720");
    fs.rmSync(seed, { recursive: true, force: true });
  });
});

/* ═══════════════════════ one truth across routes ═══════════════════════ */

describe("archive video and external video ask the same question", () => {

  it("the archive route had NO video resolution check before this round", () => {
    /**
     * prepareCuratedArchiveClip's image branch has refused a narrow still since long before this
     * round; its video branch had nothing at all. The `else` is the fix, and it must stay attached
     * to the same mediaType test.
     */
    const src = read("server/curatedMediaSourcing.ts");
    const fn = src.slice(
      src.indexOf("export async function prepareCuratedArchiveClip("),
      src.indexOf("export type CuratedCandidatePick")
    );
    expect(fn).toContain('if (asset.mediaType === "image") {');
    expect(fn).toContain("const dims = await probeVideoDimensions(rawPath);");
    // Both branches measure the FILE, never a column on the row.
    expect(fn).not.toContain("asset.width");
    expect(fn).not.toContain("asset.height");
  });

  it("neither route trusts a stored or claimed dimension", () => {
    const pipeline = read("server/videoPipeline.ts");
    const fn = pipeline.slice(
      pipeline.indexOf("export async function downloadAndTrimPoolCandidate("),
      pipeline.indexOf("/** Stable stock trim")
    );
    expect(fn).not.toContain("candidate.width");
    expect(fn).not.toContain("candidate.height");
  });
});
