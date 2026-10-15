/**
 * VIDEO 659 — FIX F: A REMOVED FREESOUND SOUND GETS ITS CATALOGUE ALTERNATIVE, OR ONLY IT IS SKIPPED.
 *
 * Production: `[Audio] job=66 clip=bg_209dbbbbf8 status=UNRESOLVED provider=freesound asset=459931
 * reason=REHYDRATION_DOWNLOAD_FAILED` — the same line in job 27 and job 63. Freesound removed the
 * recording. Now: the planned sound first; then the other recordings of its catalogue category, in
 * catalogue order; else only that sound is left out. A sound Freesound answered 404 for is
 * remembered and not asked for again. Nothing else in the render is touched.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import { fetchFreesoundClip, freesoundAlternatives, type FreesoundFetchDeps } from "./freesoundFallback";

const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");

const clip = (id: number, title?: string) => ({
  id: "bg_209dbbbbf8",
  source: { provider: "freesound", providerAssetId: String(id), sourcePageUrl: `https://freesound.org/s/${id}/`, ...(title ? { title } : {}) },
});

/** A stand-in Freesound: which ids resolve, which downloads work, which are known gone. */
function world(opts: { resolves: number[]; downloads?: number[]; gone?: number[] }) {
  const asked: number[] = [];
  const fetched: string[] = [];
  const lines: string[] = [];
  const deps: FreesoundFetchDeps = {
    resolve: async (source) => {
      const id = Number(source.providerAssetId);
      asked.push(id);
      return opts.resolves.includes(id) ? { ok: true, url: `https://cdn.freesound.org/previews/${id}.mp3` } : { ok: false, code: "REHYDRATION_DOWNLOAD_FAILED" };
    },
    download: async (url) => {
      fetched.push(url);
      const id = Number(/previews\/(\d+)\.mp3/.exec(url)?.[1]);
      return (opts.downloads ?? opts.resolves).includes(id);
    },
    isGone: (id) => (opts.gone ?? []).includes(id),
    log: (l) => lines.push(l),
  };
  return { deps, asked, fetched, lines };
}

describe("VIDEO 659 fix F — the alternatives come from the catalogue, in its order", () => {
  it("459931 is 'Gentle wind' in wind and 'Wind drone footage' in drone_wind; its alternative is wind's other recording", () => {
    expect(SOUND_CATALOG.wind.map((v) => v.freesoundId)).toEqual([366073, 459931]);
    expect(SOUND_CATALOG.drone_wind.map((v) => v.freesoundId)).toEqual([459931]);
    expect(freesoundAlternatives(459931, "Gentle wind")).toEqual([{ freesoundId: 366073, label: "Wind in trees", category: "wind" }]);
    expect(freesoundAlternatives(459931, "Wind drone footage")).toEqual([{ freesoundId: 366073, label: "Wind in trees", category: "wind" }]);
  });

  it("the category the clip's title names comes first, then the others; never the sound itself, never twice", () => {
    /** 270402 is "Forest birds morning" (birds) and "Forest morning" (forest). */
    const forest = freesoundAlternatives(270402, "Forest morning").map((a) => a.category);
    expect(forest[0]).toBe("forest");
    const ids = freesoundAlternatives(270402, "Forest morning").map((a) => a.freesoundId);
    expect(ids).not.toContain(270402);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a sound in no category has no alternative", () => {
    expect(freesoundAlternatives(1, "nothing")).toEqual([]);
  });
});

describe("VIDEO 659 fix F — fetching one Freesound clip", () => {
  it("an available sound: fetched as planned, no alternative asked", async () => {
    const w = world({ resolves: [366073] });
    const got = await fetchFreesoundClip(clip(366073, "Wind in trees"), "/tmp/a.mp3", w.deps, 66);
    expect(got).toEqual({ file: "/tmp/a.mp3", freesoundId: 366073, substituted: false });
    expect(w.asked).toEqual([366073]);
    expect(w.lines).toEqual([]);
  });

  it("a missing sound (the 659 case): the catalogue alternative is used, and the log says so", async () => {
    const w = world({ resolves: [366073] });
    const got = await fetchFreesoundClip(clip(459931, "Gentle wind"), "/tmp/a.mp3", w.deps, 66);
    expect(got).toEqual({ file: "/tmp/a.mp3", freesoundId: 366073, substituted: true });
    expect(w.asked).toEqual([459931, 366073]);
    expect(w.lines[0]).toBe("[Audio] job=66 clip=bg_209dbbbbf8 status=UNRESOLVED provider=freesound asset=459931 reason=unresolved (REHYDRATION_DOWNLOAD_FAILED)");
    expect(w.lines[1]).toBe('[Audio] job=66 clip=bg_209dbbbbf8 freesound=459931 → alternative 366073 ("Wind in trees", category wind, catalogue order)');
  });

  it("a failed download of the planned sound: the alternative is tried", async () => {
    const w = world({ resolves: [459931, 366073], downloads: [366073] });
    const got = await fetchFreesoundClip(clip(459931, "Gentle wind"), "/tmp/a.mp3", w.deps, 66);
    expect(got?.freesoundId).toBe(366073);
    expect(w.lines[0]).toMatch(/asset=459931 reason=download failed/);
  });

  it("nothing works: only this sound is skipped, and the render goes on (null, no throw)", async () => {
    const w = world({ resolves: [] });
    const got = await fetchFreesoundClip(clip(459931, "Gentle wind"), "/tmp/a.mp3", w.deps, 66);
    expect(got).toBeNull();
    expect(w.lines.at(-1)).toBe("[Audio] job=66 clip=bg_209dbbbbf8 status=SKIPPED asset=459931 — no working recording; only this sound is left out");
  });

  it("a sound known gone is not asked again: no lookup, no wait", async () => {
    const w = world({ resolves: [366073], gone: [459931] });
    const got = await fetchFreesoundClip(clip(459931, "Gentle wind"), "/tmp/a.mp3", w.deps, 66);
    expect(got?.freesoundId).toBe(366073);
    expect(w.asked).toEqual([366073]);
    expect(w.lines[0]).toMatch(/reason=gone \(Freesound removed it; not asked again\)/);
  });

  it("a resolver that throws is a failure like any other, never an exception out of the render", async () => {
    const w = world({ resolves: [] });
    w.deps.resolve = async () => {
      throw new Error("boom");
    };
    await expect(fetchFreesoundClip(clip(459931), "/tmp/a.mp3", w.deps, 66)).resolves.toBeNull();
  });
});

describe("VIDEO 659 fix F — Freesound's 404 is remembered; a passing error is not", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    process.env.FREESOUND_API_KEY = "stub-freesound";
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.FREESOUND_API_KEY;
    vi.restoreAllMocks();
  });
  const reply = (status: number, body: unknown = {}) => {
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };

  it("404: null, remembered as gone, and the next ask does not reach Freesound", async () => {
    const f = await import("./cinematicAudio/fetcher");
    reply(404);
    expect(await f.freesoundPreviewUrl(459931)).toBeNull();
    expect(f.freesoundSoundIsGone(459931)).toBe(true);
    expect(await f.freesoundPreviewUrl(459931)).toBeNull();
    expect(calls).toBe(1);
  });

  it("429: null this time, NOT remembered — asked again next time", async () => {
    const f = await import("./cinematicAudio/fetcher");
    reply(429);
    expect(await f.freesoundPreviewUrl(366073)).toBeNull();
    expect(f.freesoundSoundIsGone(366073)).toBe(false);
    await f.freesoundPreviewUrl(366073);
    expect(calls).toBe(2);
  });

  it("200: the preview URL, nothing remembered", async () => {
    const f = await import("./cinematicAudio/fetcher");
    reply(200, { previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/366/366073-hq.mp3" } });
    expect(await f.freesoundPreviewUrl(366073)).toBe("https://cdn.freesound.org/previews/366/366073-hq.mp3");
    expect(f.freesoundSoundIsGone(366073)).toBe(false);
  });
});

describe("VIDEO 659 fix F — the render's audio loop uses it, and only for Freesound sounds", () => {
  it("a Freesound clip without a URL goes through fetchFreesoundClip; everything else keeps its own path", () => {
    const loop = WORKER.slice(WORKER.indexOf("for (const clip of audioClips) {"), WORKER.indexOf("for (const kind of [\"VOICE\", \"MUSIC\", \"AMBIENT\", \"SFX\"] as const)"));
    const freesound = loop.indexOf('if (clip.source.provider === "freesound" && !clip.source.canonicalUrl && !clip.source.mediaUrl && clip.source.providerAssetId) {');
    const generic = loop.indexOf('let url = clip.source.canonicalUrl || clip.source.mediaUrl || "";');
    expect(freesound).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(freesound);
    const branch = loop.slice(freesound, generic);
    expect(branch).toContain("fetchFreesoundClip(");
    expect(branch).toContain("isGone: freesoundSoundIsGone,");
    /** A skipped sound only leaves its own clip out: the loop continues with the next clip. */
    expect(branch).toContain("if (got) audioByClip.set(clip.id, got.file);\n        continue;");
    expect(branch).not.toMatch(/throw|return\s/);
  });
});
