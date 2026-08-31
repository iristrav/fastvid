/**
 * RONDE 135 — the two gaps RONDE 134 left, and the guards for what was already right.
 *
 * ── FINDING 1: the dedup Set nobody could read ───────────────────────────────────────────────
 *
 * `usedProviderKeys` had exactly one writer and exactly one reader, and they used different key
 * formats:
 *
 *     WRITE  visualDedupRegistry (RONDE 132)   `${provider.toLowerCase()}:${id}`        raw
 *     READ   providerAssetAlreadyUsed          `${provider}:${sha256(id).slice(0,16)}`  hashed
 *
 * The lookup could never succeed. Not once, for any asset, in any render.
 *
 * That is the exact mechanism this round is asked about: nine provider routes call
 * providerAssetAlreadyUsed BEFORE downloading, which is the cheap place to drop a picture the
 * video already has. It answered "no" every time, so an asset the funnel had already adopted was
 * searched again, downloaded again and judged by Vision again — and was stopped only at the very
 * end by `usedContentKeys` at the adopt point. Nothing shipped twice, which is why the output
 * never showed it; what it cost was a download, a vision call and one of the beat's six shortlist
 * slots, every single time.
 *
 * ── FINDING 2: eleven video routes had no resolution check ───────────────────────────────────
 *
 * RONDE 134 put videoResolutionVerdict on the funnel/pool download and the curated archive clip.
 * Every DIRECT provider route reaches the montage through one of two shared trim helpers, and
 * neither had it: trimRemoteVideoToClip (Wikimedia video, Flickr, SepiaSearch, Europeana, Vimeo
 * CC, media.ccc, NASA, NARA, Internet Archive, YouTube) and trimDownloadedStockClip (Pexels,
 * Pixabay).
 *
 * ── What was already right, and is guarded here rather than changed ──────────────────────────
 *
 * The frozen-frame rules (RONDE 85/111/130) and the 5-second still cap are correct as they stand.
 * This file locks them so the two changes above cannot quietly loosen them.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  assetUsedInVideo,
  markAssetUsedInVideo,
  providerAssetIdentityKey,
  type UsedAssetSets,
} from "./visualDedupRegistry";
import {
  providerAssetKey,
  providerAssetAlreadyUsed,
  trimRemoteVideoToClip,
  montageTailPadFilterChain,
} from "./videoPipeline";
import { stillImageMaxSec } from "./stillImagePolicy";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

function emptySets(): UsedAssetSets {
  return {
    usedContentKeys: new Set(),
    usedCuratedAssetIds: new Set(),
    usedCuratedStorageUrls: new Set(),
    usedProviderKeys: new Set(),
    usedFunnelCandidateIds: new Set(),
  };
}

/* ═══════════════════════ FINDING 1 — one key, both sides ═══════════════════════ */

describe("RONDE 135 §4 — the used-asset Set is written and read with the same key", () => {
  it("THE BUG: what markAssetUsedInVideo writes is what providerAssetAlreadyUsed looks up", () => {
    /**
     * The whole defect in one assertion. Before this round the left side produced
     * `wikimedia:File:Bundesarchiv_Bild_183.webm` and the right side asked for
     * `wikimedia:1f3a...`, so the Set was filled with keys nothing would ever request.
     */
    const sets = emptySets();
    markAssetUsedInVideo(sets, {
      provider: "wikimedia",
      providerAssetId: "File:Bundesarchiv_Bild_183-S33882.webm",
    });
    expect(
      sets.usedProviderKeys.has(providerAssetKey("wikimedia", "File:Bundesarchiv_Bild_183-S33882.webm")),
      "the funnel's write is invisible to every provider route's pre-download check"
    ).toBe(true);
  });

  it("...so the pre-download exclusion actually fires", () => {
    /**
     * The behavioural consequence, through the real reader. This is the call nine provider routes
     * make BEFORE spending a download, and it is the one that silently answered "no" forever.
     */
    const sets = emptySets();
    markAssetUsedInVideo(sets, { provider: "internet_archive", providerAssetId: "white-lives-matter-montana" });
    expect(
      providerAssetAlreadyUsed(sets.usedProviderKeys, undefined, "internet_archive", "white-lives-matter-montana")
    ).toBe(true);
  });

  it("an asset that was never used is still not excluded", () => {
    const sets = emptySets();
    markAssetUsedInVideo(sets, { provider: "wikimedia", providerAssetId: "File:A.webm" });
    expect(providerAssetAlreadyUsed(sets.usedProviderKeys, undefined, "wikimedia", "File:B.webm")).toBe(false);
    // ...and a different provider with the same id is a different asset.
    expect(providerAssetAlreadyUsed(sets.usedProviderKeys, undefined, "flickr", "File:A.webm")).toBe(false);
  });

  it("there is now ONE definition, and the pipeline's name still resolves to it", () => {
    expect(providerAssetKey("nara", "12345")).toBe(providerAssetIdentityKey("nara", "12345"));
    const pipeline = read("server/videoPipeline.ts");
    // The pipeline must not carry its own copy of the hashing any more.
    const fn = pipeline.slice(
      pipeline.indexOf("export function providerAssetKey("),
      pipeline.indexOf("export function tagPathWithProviderAsset(")
    );
    expect(fn).toContain("providerAssetIdentityKey(provider, id)");
    expect(fn, "a second copy of the key is how the two drifted apart").not.toContain("createHash(");
  });

  it("RONDE 132's case-insensitivity survived the unification", () => {
    /**
     * The old registry key lower-cased the provider and the pipeline key did not. Merging them had
     * to keep the STRICTER behaviour: two routes really do spell a provider differently, and a
     * dedup set that answers "no" to the same picture under a different capitalisation does not
     * work.
     */
    const sets = emptySets();
    markAssetUsedInVideo(sets, { provider: "wikimedia", providerAssetId: "File:X.webm" });
    expect(assetUsedInVideo(sets, { provider: "WIKIMEDIA", providerAssetId: "File:X.webm" }))
      .toEqual({ used: true, matchedOn: "provider_asset_id" });
    expect(providerAssetKey("Wikimedia", "File:X.webm")).toBe(providerAssetKey("wikimedia", "File:X.webm"));
  });

  it("the exclusion happens BEFORE the download, not after Vision", () => {
    /**
     * Point 4 of the round is about WHERE the check sits, not only that it works. Each of these
     * routes calls it while iterating search hits — before any fetch of the asset itself.
     */
    const src = read("server/videoPipeline.ts");
    for (const provider of ["wikimedia", "flickr", "sepiasearch", "europeana", "vimeo", "media_ccc", "gdelt_tv"]) {
      expect(src, `${provider} lost its pre-download duplicate check`)
        .toContain(`providerAssetAlreadyUsed(usedProviderKeys, sourcingCache, "${provider}"`);
    }
  });
});

/* ═══════════════════════ FINDING 2 — every video route ═══════════════════════ */

describe("RONDE 135 §1 — the technical gate reaches every video route", () => {
  it("both shared trim helpers run it before the encode", () => {
    const src = read("server/videoPipeline.ts");
    for (const helper of ["export async function trimRemoteVideoToClip(", "async function trimDownloadedStockClip("]) {
      const idx = src.indexOf(helper);
      expect(idx, `${helper} not found`).toBeGreaterThan(0);
      const head = src.slice(idx, idx + 900);
      expect(head, `${helper} does not gate its source`).toContain("videoSourcePassesTechnicalGate(");
    }
  });

  it("the gate is checked BEFORE ffmpeg is spawned, not after", () => {
    /**
     * Point 2: no unnecessary encode. If the check moved below the exec the resolution would still
     * be right and a full libx264 pass would be wasted on every refused file.
     */
    const src = read("server/videoPipeline.ts");
    const idx = src.indexOf("export async function trimRemoteVideoToClip(");
    const body = src.slice(idx, src.indexOf("// ─── 3c2v. Wikimedia Commons Video Search", idx));
    expect(body.indexOf("videoSourcePassesTechnicalGate(")).toBeLessThan(body.indexOf("FFMPEG_BIN"));
  });

  it("it uses RONDE 134's rule, with no new threshold", () => {
    const src = read("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("async function videoSourcePassesTechnicalGate("),
      src.indexOf("export async function trimRemoteVideoToClip(")
    );
    expect(fn).toContain("videoResolutionVerdict(meta?.width, meta?.height,");
    // RONDE 136: the floor now depends on whether the source is stock or archive, and that
    // decision also lives in technicalMediaGate — still no threshold written out here.
    expect(fn).toContain("minShortSideForSource(label)");
    expect(fn).not.toMatch(/\b(144|240|360|480|720|1080)\b/);
  });

  it("BEHAVIOUR: a 128x96 source is refused by the real helper and no clip is written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r135-trim-"));
    try {
      const src = path.join(dir, "tiny.mp4");
      const out = path.join(dir, "out.mp4");
      execSync(
        `ffmpeg -y -f lavfi -i "nullsrc=s=128x96,geq=random(1)*255:128:128" -t 3 -c:v libx264 -pix_fmt yuv420p "${src}" 2>/dev/null`
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let ok: boolean;
      try {
        ok = await trimRemoteVideoToClip(src, out, 2, 0, "Internet Archive scene 3");
      } finally {
        warn.mockRestore();
      }
      expect(ok).toBe(false);
      expect(fs.existsSync(out), "an encode ran on a file that was already refused").toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("BEHAVIOUR: a 1280x720 source passes and produces a clip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r135-trim-ok-"));
    try {
      const src = path.join(dir, "good.mp4");
      const out = path.join(dir, "out.mp4");
      execSync(
        `ffmpeg -y -f lavfi -i "nullsrc=s=1280x720,geq=random(1)*255:128:128" -t 4 -c:v libx264 -pix_fmt yuv420p "${src}" 2>/dev/null`
      );
      const ok = await trimRemoteVideoToClip(src, out, 2, 0, "Pexels scene 1");
      expect(ok).toBe(true);
      expect(fs.existsSync(out)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("BEHAVIOUR: a genuine 352x240 archive clip is kept, not refused", async () => {
    // The loss-aversion rule from RONDE 134, re-checked on the route this round added.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r135-news-"));
    try {
      const src = path.join(dir, "news.mp4");
      const out = path.join(dir, "out.mp4");
      execSync(
        `ffmpeg -y -f lavfi -i "nullsrc=s=352x240,geq=random(1)*255:128:128" -t 4 -c:v libx264 -pix_fmt yuv420p "${src}" 2>/dev/null`
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let ok: boolean;
      try {
        ok = await trimRemoteVideoToClip(src, out, 2, 0, "NARA scene 2");
      } finally {
        log.mockRestore();
      }
      expect(ok, "a sub-SD archive clip must not be thrown away").toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

/* ═══════════════════════ guards on what was already correct ═══════════════════════ */

describe("RONDE 135 §3 — no long frozen frame (guarding RONDE 85/111/130)", () => {
  it("a still may not be held longer than the 5-second limit", () => {
    expect(stillImageMaxSec()).toBeLessThanOrEqual(5);
  });

  it("the tail pad never holds a frame for longer than that limit", () => {
    /**
     * A 3-second montage against a 34-second slot is the production shape RONDE 130 measured. The
     * answer must not be a 31-second freeze.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let chain: string;
    try {
      chain = montageTailPadFilterChain(3, 34, "R135 guard");
    } finally {
      warn.mockRestore();
    }
    const hold = /stop_duration=([0-9.]+)/.exec(chain);
    if (hold) {
      expect(Number(hold[1]), "the hold outgrew the still limit").toBeLessThanOrEqual(stillImageMaxSec() + 0.001);
    } else {
      // No hold at all — it looped or slowed instead, which is the preferred answer.
      expect(chain).toMatch(/loop=|setpts=/);
    }
  });

  it("a long shortfall is filled by replaying footage, not by stopping on a frame", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let chain: string;
    try {
      chain = montageTailPadFilterChain(3, 34, "R135 guard loop");
    } finally {
      warn.mockRestore();
    }
    expect(chain).toContain("loop=loop=");
  });

  it("there are still exactly TWO clone-mode pad sites in the file", () => {
    /**
     * The guard five earlier rounds put in place: a freeze site must not appear unnoticed. This
     * round adds none, and the count is the proof.
     */
    const src = read("server/videoPipeline.ts");
    expect((src.match(/stop_mode=clone/g) ?? []).length).toBe(2);
  });
});
