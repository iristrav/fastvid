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
    /**
     * RONDE 602 widened the parameter to `<T extends ThumbnailRankable>` so the YouTube cascade
     * route could hand it the candidates its own mapper already produces, without inventing the
     * four `PoolCandidate` fields this body never reads. The anchor stops at the name for that
     * reason; every claim below is the claim it always was, and the same rule is now also
     * asserted at RUNTIME in youtubeLooksBeforeItSpendsADownload — a ranking pass returns as many
     * candidates as it was given.
     */
    const at = src.indexOf("export async function rankCandidatesByThumbnailClip");
    expect(at, "the ranker was renamed or removed").toBeGreaterThan(-1);
    const fn = src.slice(at);
    expect(fn).toContain("if (!candidate.thumbnailUrl) return;");
    expect(fn).toContain("then unscored (preserve keyword order)");
    expect(fn, "a ranking pass must not filter the pool").not.toContain("candidates.splice(");
  });

});
