/**
 * RONDE 133 — the technical gate, traced end to end with real files.
 *
 * ── The two questions ─────────────────────────────────────────────────────────────────────────
 *
 *   TECHNICAL GATE   Can this file technically be used?
 *   VISION GATE      Does this picture belong under this beat?
 *
 * ── What the trace found ──────────────────────────────────────────────────────────────────────
 *
 * A still travelling through the pipeline is measured on exactly one of the two routes that can
 * carry it:
 *
 *   prepareCuratedArchiveClip   (archive)              width < 960px → refused
 *   downloadAndTrimPoolCandidate (every external one)  no pixel check whatsoever
 *
 * The external route's only floor was on BYTES, and this file proves with a real encode why that
 * is not the same question: the 320×240 fixture below is 56 KB — it sails past the route's
 * 50 000-byte floor while being unusable at 1920×1080. Bytes measure compression, pixels measure
 * resolution, and it was the pixels nobody was looking at.
 *
 * So a 320-pixel thumbnail reached Vision, was judged on its merits, and was upscaled into the
 * montage. Same asset, same pipeline, two standards — decided by nothing but which route happened
 * to fetch it.
 *
 * The second finding was silence: of the pool route's five technical refusal paths exactly one
 * (the HTTP status) wrote anything at all. The byte floor, the duration floor, the trim failure
 * and the still conversion all returned null without a word, so "why did this beat end up with no
 * picture" had no answer after the fact.
 *
 * ── How this file tests it ────────────────────────────────────────────────────────────────────
 *
 * Real JPEGs, encoded here by ffmpeg. A real local HTTP server. The real, exported
 * downloadAndTrimPoolCandidate — not a re-implementation of it. Nothing about the decision is
 * modelled; the function is called and its answer is the assertion.
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
  fileSizeVerdict,
  formatTechnicalReject,
  sourceDurationVerdict,
  stillResolutionVerdict,
  type TechnicalVerdict,
} from "./technicalMediaGate";
import { VIDRUSH_MIN_STILL_WIDTH } from "./vidrushQuality";
import type { PoolCandidate } from "./scenePool";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

/* ═══════════════════════ the rule itself ═══════════════════════ */

describe("the technical rule, on its own", () => {
  it("refuses a still below the width the archive route has always required", () => {
    const v = stillResolutionVerdict(320);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("still_too_low_res");
      expect(v.detail).toBe(`320px < ${VIDRUSH_MIN_STILL_WIDTH}px`);
    }
  });

  it("accepts a still at exactly the threshold", () => {
    // A boundary that rejects its own threshold would quietly move the standard.
    expect(stillResolutionVerdict(VIDRUSH_MIN_STILL_WIDTH).ok).toBe(true);
  });

  it("ABSENCE IS NEUTRAL: an unmeasurable width passes", () => {
    /**
     * ffprobe returns nothing when it times out, and this pipeline runs many probes at once under
     * memory pressure. Reading "we could not measure" as "too small" would throw away good
     * material exactly when the machine is busiest — and would be a change to the archive route's
     * long-standing behaviour, which is `width > 0 && width < MIN`.
     */
    expect(stillResolutionVerdict(0).ok).toBe(true);
    expect(stillResolutionVerdict(-1).ok).toBe(true);
    expect(stillResolutionVerdict(NaN).ok).toBe(true);
  });

  it("the byte floor and the duration floor answer their own questions", () => {
    expect(fileSizeVerdict(49_999, 50_000).ok).toBe(false);
    expect(fileSizeVerdict(50_000, 50_000).ok).toBe(true);
    expect(sourceDurationVerdict(1.49, 1.5).ok).toBe(false);
    expect(sourceDurationVerdict(1.5, 1.5).ok).toBe(true);
    // RONDE 134: an unmeasurable duration is unknown, and unknown never refuses.
    expect(sourceDurationVerdict(null, 1.5).ok).toBe(true);
  });

  it("G — the technical gate cannot express a content verdict", () => {
    /**
     * REQUIREMENT G. A technical gate may say a file is unusable; it may never say the picture
     * does not belong. Those are different judgments with different evidence, and the moment a
     * technical failure can be spelled "does_not_fit" the render can no longer tell a corrupt
     * download from a picture the editor refused.
     *
     * The type is the enforcement — there is no verdict shape here that can carry a content
     * verdict — and the source is checked because a type is erased at runtime.
     *
     * Comments are stripped first: this module's own prose NAMES the verdicts it is forbidden to
     * produce, which is exactly the false anchor that would let the guarantee rot. The claim is
     * about the code.
     */
    const code = read("server/technicalMediaGate.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("does_not_fit");
    expect(code).not.toContain('"fits"');
    // Nothing about the beat can even reach it: no narration, no subject, no period.
    expect(code).not.toContain("beatText");
    expect(code).not.toContain("narration");
    // And it imports nothing that could tell it what the picture is about.
    expect(code).not.toContain("beatImageRelevanceGate");
    expect(code).not.toContain("localClipVision");

    const verdicts: TechnicalVerdict[] = [
      stillResolutionVerdict(10),
      fileSizeVerdict(1, 2),
      // RONDE 134 changed this argument from 0 to 0.5 on purpose. `0` used to mean "zero seconds
      // long, refuse"; it now means "ffprobe could not determine a duration", which is unknown and
      // therefore neutral — see sourceDurationVerdict. A real measured 0.5s still refuses, which
      // is what this line is here to check.
      sourceDurationVerdict(0.5, 1),
    ];
    for (const v of verdicts) {
      expect(v.ok).toBe(false);
      if (!v.ok) {
        // Every reason names a property of the FILE, never of the picture's content.
        expect(v.reason).toMatch(/^(http_error|file_too_small|still_too_low_res|video_too_low_res|duration_too_short|encode_failed|still_conversion_failed)$/);
      }
    }
  });

  it("F — a refusal formats into one greppable line naming the reason", () => {
    const line = formatTechnicalReject({
      beatLabel: "s2b0",
      source: "wikimedia",
      assetId: "File:Bundesarchiv_Bild_183-S33882.jpg",
      verdict: { ok: false, reason: "still_too_low_res", detail: "320px < 960px" },
    });
    expect(line).toContain("[TechnicalGate] REJECT s2b0");
    expect(line).toContain("source=wikimedia");
    expect(line).toContain("reason=still_too_low_res");
    expect(line).toContain("detail=320px < 960px");
  });
});

/* ═══════════════════════ the real route, with real files ═══════════════════════ */

describe("RONDE 133 — one candidate traced through the real technical gate", () => {
  let dir: string;
  let server: http.Server | undefined;
  let baseUrl = "";
  let smallJpg: Buffer;
  let bigJpg: Buffer;

  beforeAll(() => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-seed-"));
    // Noise, so JPEG cannot compress it away — the small fixture has to land ABOVE the route's
    // 50 000-byte floor, which is the entire point being proven.
    const small = path.join(seedDir, "small.jpg");
    const big = path.join(seedDir, "big.jpg");
    execSync(
      `ffmpeg -y -f lavfi -i "nullsrc=s=320x240,geq=random(1)*255:128:128" -frames:v 1 -q:v 1 "${small}" 2>/dev/null`
    );
    execSync(
      `ffmpeg -y -f lavfi -i "nullsrc=s=1600x1200,geq=random(1)*255:128:128" -frames:v 1 -q:v 3 "${big}" 2>/dev/null`
    );
    smallJpg = fs.readFileSync(small);
    bigJpg = fs.readFileSync(big);
    fs.rmSync(seedDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function serve(payload: Buffer): Promise<void> {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(payload);
    });
    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }

  function stillCandidate(source: string): PoolCandidate {
    return {
      id: `${source}:r133`,
      assetId: "r133-still",
      source,
      remoteUrl: `${baseUrl}/still.jpg`,
      thumbnailUrl: null,
      title: "R133 still",
      description: null,
      tags: [],
      mediaType: "image",
      durationSec: null,
      license: null,
      // Deliberately a LIE, and the one the provider's search response would have told us: the
      // metadata claims a full-resolution photograph while the bytes are a thumbnail.
      width: 4000,
      height: 3000,
      clipSimilarity: null,
      embeddingSimilarity: null,
      rankingScore: null,
      visionScore: null,
      selectionScore: null,
    } as PoolCandidate;
  }

  it("the fixture really does defeat a byte floor — 320px, over 50 KB", () => {
    /**
     * The premise of the whole round, measured rather than asserted. If this ever stops being
     * true the test below stops proving that the PIXEL check is what caught the file.
     */
    expect(smallJpg.length).toBeGreaterThan(50_000);
    expect(bigJpg.length).toBeGreaterThan(50_000);
  });

  it("A — a technically unusable still never becomes a clip, so Vision never sees it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-small-"));
    await serve(smallJpg);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await downloadAndTrimPoolCandidate(stillCandidate("wikimedia"), dir, 2, 0, 4);
      /**
       * null is the whole guarantee. The funnel turns null into
       * `usedFunnelCandidateIds.add(id); continue;` — the candidate never reaches
       * evaluateClipVisionGate and never reaches checkBeatRelevance, because there is no file to
       * hand them.
       */
      expect(out, "a 320px still must not produce a clip").toBeNull();
      // ...and nothing was left on disk for anything else to pick up.
      const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
      expect(leftovers).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it("F — and it says why, on the real route", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-log-"));
    await serve(smallJpg);
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await downloadAndTrimPoolCandidate(stillCandidate("wikimedia"), dir, 2, 0, 4);
    } finally {
      warn.mockRestore();
    }
    const reject = lines.find((l) => l.includes("[TechnicalGate] REJECT"));
    expect(reject, `no technical reject line in:\n${lines.join("\n")}`).toBeTruthy();
    expect(reject!).toContain("reason=still_too_low_res");
    expect(reject!).toContain("source=wikimedia");
    expect(reject!).toContain("s2b0");
  }, 60_000);

  it("B — a technically valid still DOES become a clip and may reach Vision", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-big-"));
    await serve(bigJpg);
    const out = await downloadAndTrimPoolCandidate(stillCandidate("wikimedia"), dir, 2, 0, 4);
    expect(out, "a 1600px still must survive the technical gate").toBeTruthy();
    expect(fs.existsSync(out!)).toBe(true);
    expect(fs.statSync(out!).size).toBeGreaterThan(1_000);
  }, 120_000);

  it("C — the file the gate is handed IS the file the montage gets", async () => {
    /**
     * REQUIREMENT C. downloadAndTrimPoolCandidate returns one path. The funnel hands exactly that
     * path to the vision gate, to the beat image gate, and then to `funnelClip = clipPath` — there
     * is no re-download, no second trim and no swap in between, so what was judged is what is cut
     * into the video.
     *
     * The behavioural half is above: the returned path exists and is playable. This half proves
     * the pipeline does not substitute anything after judging it.
     */
    const src = read("server/videoPipeline.ts");
    const loop = src.slice(
      src.indexOf("for (const { candidate, clipPath } of downloadedClips)"),
      src.indexOf("let winner = pickBestFunnelCandidate(")
    );
    expect(loop.length).toBeGreaterThan(100);
    // The gate is given the downloaded path itself, not a re-derived one.
    expect(loop).toContain("const visionResult = await evaluateClipVisionGate(\n            clipPath,");
    expect(loop).toContain("scored.push({ candidate, clipPath, visionResult });");

    // And the adopted clip is the winner's own path — the same object the gate judged.
    const adopt = src.slice(src.indexOf("let funnelClip: string | null = null;"), src.length);
    expect(adopt.slice(0, 4000)).toContain("const { candidate, clipPath } = winner;");
    expect(adopt.slice(0, 4000)).toContain("funnelClip = clipPath;");
    expect(src).toContain("        if (funnelClip) {\n          clip = funnelClip;");
  });

  it("D — a preview that cannot be read is refused, not guessed at", async () => {
    /**
     * REQUIREMENT D. A body that is not an image at all: the server answers 200 with the right
     * content type and returns rubbish. ffprobe cannot measure it, so the resolution rule passes
     * it (absence is neutral) and the CONVERSION is what must catch it — which it does, and now
     * says so.
     */
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-corrupt-"));
    await serve(Buffer.alloc(80_000, 0x7f));
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    let out: string | null;
    try {
      out = await downloadAndTrimPoolCandidate(stillCandidate("internet_archive"), dir, 1, 1, 4);
    } finally {
      warn.mockRestore();
    }
    expect(out, "a corrupt body must not become a clip").toBeNull();
  }, 60_000);

  it("E — every provider is held to the same standard", async () => {
    /**
     * REQUIREMENT E. The same 320px bytes, offered under four different provider names. Before
     * this round the archive route refused this file and every one of these accepted it.
     */
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r133-providers-"));
    await serve(smallJpg);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const source of ["wikimedia", "loc", "nara", "europeana"]) {
        const out = await downloadAndTrimPoolCandidate(stillCandidate(source), dir, 3, 0, 4);
        expect(out, `${source} accepted a 320px still`).toBeNull();
      }
    } finally {
      warn.mockRestore();
    }
  }, 120_000);
});

/* ═══════════════════════ one rule, not two ═══════════════════════ */

describe("the archive route and the external routes ask the same question", () => {
  it("both call stillResolutionVerdict rather than writing the rule out twice", () => {
    /**
     * The defect was not a missing threshold — it was a threshold that existed in exactly one
     * function. Two copies is how they drift apart again.
     */
    expect(read("server/curatedMediaSourcing.ts")).toContain("stillResolutionVerdict(width)");
    expect(read("server/videoPipeline.ts")).toContain("stillResolutionVerdict(stillMeta?.width ?? 0)");
  });

  it("the external route measures the FILE, never the provider's claimed width", () => {
    /**
     * PoolCandidate carries width/height from the search response, and providers report the
     * ORIGINAL's dimensions while serving a resized file. Trusting that field would approve a
     * thumbnail on the strength of the photograph it was cut from — which is why the fixture
     * above claims 4000×3000 while being 320×240.
     */
    const src = read("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("export async function downloadAndTrimPoolCandidate("),
      src.indexOf("/** Stable stock trim")
    );
    expect(fn).toContain("const stillMeta = await probeVideoStreamMeta(rawPath);");
    expect(fn, "the provider's own width must not decide this").not.toContain("candidate.width");
  });

  it("the byte floor is no longer skipped on a media-cache hit", () => {
    /**
     * THE BUG: the floor used to sit inside `if (!fromCache)`. The media cache is keyed by source
     * URL and shared by every route, and fetchWikimediaImages writes into it at a 10 000-byte
     * floor — so the same Commons file, restored from cache on the pool route, skipped that
     * route's 50 000-byte floor entirely.
     */
    const src = read("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("export async function downloadAndTrimPoolCandidate("),
      src.indexOf("/** Stable stock trim")
    );
    const cacheBlockEnd = fn.indexOf("void reportToMediaCache(");
    const sizeCheck = fn.indexOf("fileSizeVerdict(rawSize, POOL_MIN_RAW_BYTES)");
    expect(sizeCheck).toBeGreaterThan(0);
    expect(
      sizeCheck,
      "the size check must sit AFTER the cache/download branch, not inside it"
    ).toBeGreaterThan(cacheBlockEnd);
  });

  it("the thresholds are unchanged — this round moved checks, it did not retune them", () => {
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("const POOL_MIN_RAW_BYTES = 50_000;");
    expect(src).toContain("const POOL_MIN_SOURCE_SEC = 1.5;");
    expect(read("server/vidrushQuality.ts")).toContain("VIDRUSH_MIN_STILL_WIDTH = 960");
  });
});

/* ═══════════════════════ what stays ranking, not rejection ═══════════════════════ */

describe("checks that only rank never remove a candidate", () => {
  it("thumbnail CLIP ranking reorders and keeps the unscored", () => {
    /**
     * rankCandidatesByThumbnailClip scores a provider THUMBNAIL, which is by definition not the
     * file that will be used. That makes it usable for ordering and unusable as a gate — and it
     * is written that way: an unscored candidate keeps its place rather than being dropped.
     */
    const src = read("server/scenePool.ts");
    const fn = src.slice(src.indexOf("export async function rankCandidatesByThumbnailClip("));
    expect(fn).toContain("if (!candidate.thumbnailUrl) return;");
    expect(fn).toContain("then unscored (preserve keyword order)");
    expect(fn, "a ranking pass must not filter the pool").not.toContain("candidates.splice(");
  });

  it("CLIP's own score ranks funnel candidates, it does not reject them", () => {
    // RONDE 103's rule, re-checked here because it is the boundary this round is about.
    const src = read("server/videoPipeline.ts");
    expect(src).toContain("CLIP ranks ");
    expect(src).toContain("— not a reject");
  });
});
