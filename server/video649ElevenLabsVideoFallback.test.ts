/**
 * VIDEO 649 — GENERATED_VIDEO_FALLBACK: ElevenLabs video inside the generated-picture rung.
 *
 * No network, no paid call: the generator is driven through a mocked `fetch`; the "downloaded"
 * bytes are a real MP4 ffmpeg draws here, so the remux and the audio check are real.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as el from "./elevenLabsVideoGeneration";
import { GENERATED_IMAGE_PROVIDER, generatedStillSec, isGeneratedImageClip } from "./generatedImageFallback";
import { isAIGeneratedClip } from "./documentaryStyle";
import { resolveFFmpegBin } from "./ffmpegBinary";

const run = promisify(execFile);
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PREFLIGHT = fs.readFileSync(path.join(__dirname, "productionPreflight.ts"), "utf8");
const ENV_EXAMPLE = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

let dir = "";
let sampleMp4: Buffer;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-649-elvid-"));
  const sample = path.join(dir, "sample.mp4");
  /** A real MP4 with a sound track: the remux must drop the audio and keep the picture. */
  await run(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=3:r=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample,
  ]);
  sampleMp4 = fs.readFileSync(sample);
  expect(sampleMp4.length).toBeGreaterThan(el.GENERATED_VIDEO_MIN_BYTES);
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const KEY = "test-key-never-logged-7b1d";
let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m: string) => void logs.push(String(m)));
  el.resetVideoServiceStandDownForTests();
  el.setVideoPollSleepForTests(async () => {});
  vi.stubEnv("ELEVENLABS_VIDEO_API_KEY", KEY);
  vi.stubEnv("ELEVENLABS_API_KEY", "");
  vi.stubEnv("ELEVENLABS_VIDEO_MODEL_ID", "");
  vi.stubEnv("ELEVENLABS_VIDEO_DURATION_SEC", "");
  vi.stubEnv("ELEVENLABS_VIDEO_EXTRA_JSON", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  el.setVideoPollSleepForTests(null);
  el.resetVideoServiceStandDownForTests();
});

type Reply = { status: number; json?: unknown; bytes?: Buffer };
const reply = (r: Reply): Response =>
  ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.json ?? {},
    arrayBuffer: async () => (r.bytes ?? Buffer.alloc(0)).buffer.slice((r.bytes ?? Buffer.alloc(0)).byteOffset, (r.bytes ?? Buffer.alloc(0)).byteOffset + (r.bytes ?? Buffer.alloc(0)).byteLength),
  }) as unknown as Response;

/** A fetch that answers in order and records every call (url + method + headers). */
const scripted = (replies: Reply[]) => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {}, body: typeof init?.body === "string" ? init.body : undefined });
    const r = replies.shift();
    if (!r) throw new Error("no scripted reply left");
    return reply(r);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
};
const SIGNED = "https://signed.example.invalid/output.mp4?token=SECRET-URL-9f2";
const out = (name: string) => path.join(dir, name);
const soon = () => Date.now() + 60_000;

describe("configuration", () => {
  it("defaults: the Fast model, 8 s, a 5-minute window, polling never under the documentation's 10 s floor", () => {
    vi.stubEnv("ELEVENLABS_VIDEO_POLL_MS", "2000");
    const cfg = el.elevenLabsVideoConfig();
    expect(cfg.key).toBe(KEY);
    expect(cfg.modelId).toBe(el.DEFAULT_VIDEO_MODEL_ID);
    expect(cfg.durationSec).toBe(8);
    expect(cfg.maxWaitMs).toBe(5 * 60_000);
    expect(cfg.pollMs).toBe(el.VIDEO_POLL_MIN_MS);
    expect(el.elevenLabsVideoConfigured()).toBe(true);
  });
  it("only the video key enables the rung — the voice key never does (no Pro plan: no 402 per film); EXTRA_JSON: unreadable ignored, readable merged", () => {
    expect(el.elevenLabsVideoConfig().keySource).toBe("video");
    vi.stubEnv("ELEVENLABS_VIDEO_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "voice-key-2c9");
    expect(el.elevenLabsVideoConfigured()).toBe(false);
    expect(el.elevenLabsVideoConfig().key).toBeNull();
    expect(el.elevenLabsVideoConfig().keySource).toBeNull();
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(el.elevenLabsVideoConfigured()).toBe(false);
    vi.stubEnv("ELEVENLABS_VIDEO_EXTRA_JSON", "{not json");
    expect(el.elevenLabsVideoConfig().extra).toEqual({});
    vi.stubEnv("ELEVENLABS_VIDEO_EXTRA_JSON", '{"resolution":"1080p"}');
    expect(el.elevenLabsVideoConfig().extra).toEqual({ resolution: "1080p" });
  });
  it("a video covers a sentence only when it runs at least the hold the scene will give it", () => {
    expect(el.generatedVideoCoversSentence(generatedStillSec({ holdSec: 5.46 }), 8)).toBe(true);
    expect(el.generatedVideoCoversSentence(generatedStillSec({ holdSec: 8.88 }), 8)).toBe(false);
    expect(el.generatedVideoCoversSentence(7, 8)).toBe(true);
    expect(el.generatedVideoCoversSentence(8.02, 8)).toBe(true);
    expect(el.generatedVideoCoversSentence(9, 8)).toBe(false);
  });
  it("a generated video is a generated picture for the timeline and the report, and no 'AI stock' filename", () => {
    expect(isGeneratedImageClip({ source: { provider: el.GENERATED_VIDEO_PROVIDER } })).toBe(true);
    expect(isGeneratedImageClip({ source: { provider: GENERATED_IMAGE_PROVIDER } })).toBe(true);
    expect(isGeneratedImageClip({ source: { provider: "youtube_cc" } })).toBe(false);
    expect(isAIGeneratedClip(`/w/scene_0_genvid_b1__pid_${el.GENERATED_VIDEO_PROVIDER}-0123abcd.mp4`)).toBe(false);
  });
});

describe("the generator — create, poll, download, strip audio", () => {
  it("T1 success: pending → generating → completed → downloaded, audio removed; the key and the signed URL never reach the log", async () => {
    const { calls } = scripted([
      { status: 200, json: { id: "gen_1", status: "pending" } },
      { status: 200, json: { id: "gen_1", status: "generating" } },
      { status: 200, json: { id: "gen_1", status: "completed", content_url: SIGNED, content_mime_type: "video/mp4" } },
      { status: 200, bytes: sampleMp4 },
    ]);
    const target = out("t1.mp4");
    expect(await el.videoClipGenerator()("A quiet office at night", target, { durationSec: 8, deadlineAtMs: soon() })).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    /** create: the documented endpoint, header and body fields */
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/flows/video");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["xi-api-key"]).toBe(KEY);
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({ model_id: el.DEFAULT_VIDEO_MODEL_ID, prompt: "A quiet office at night", duration_secs: 8, aspect_ratio: "16:9" });
    /** poll: GET on the generation id */
    expect(calls[1]!.url).toBe("https://api.elevenlabs.io/v1/flows/video/gen_1");
    expect(calls[1]!.method).toBe("GET");
    expect(calls[3]!.url).toBe(SIGNED);
    /** audio gone, picture kept */
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", target]).catch(() => ({ stdout: "" }));
    const types = String((probe as { stdout: string }).stdout).trim().split(/\s+/).filter(Boolean);
    expect(types).toContain("video");
    expect(types).not.toContain("audio");
    expect(logs.some((l) => l.includes("[GENERATED_VIDEO_FALLBACK] started id=gen_1"))).toBe(true);
    expect(logs.some((l) => l.includes("id=gen_1 completed in"))).toBe(true);
    expect(logs.some((l) => l.includes("id=gen_1 on disk"))).toBe(true);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain("SECRET-URL");
  });

  it("T3 HTTP 402 at create: nothing downloaded, the service stands down 30 min, the next sentence sends no request", async () => {
    const { fn } = scripted([{ status: 402, json: { detail: { status: "paid_plan_required" } } }]);
    expect(await el.videoClipGenerator()("x y", out("t3.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(el.videoServiceStandingDown()).toBe(true);
    expect(logs.some((l) => l.includes("the video service answered HTTP 402 at create"))).toBe(true);
    expect(logs.some((l) => l.includes(el.GENERATED_VIDEO_PROVIDER) && /cooldown|stand/i.test(l))).toBe(true);
    const before = fn.mock.calls.length;
    expect(await el.videoClipGenerator()("x y", out("t3b.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(fn.mock.calls.length).toBe(before);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("T4 status failed: no file, the reason in the log, not charged, no retry", async () => {
    const { fn } = scripted([
      { status: 200, json: { id: "gen_4", status: "pending" } },
      { status: 200, json: { id: "gen_4", status: "failed", failure_reason: "content policy" } },
    ]);
    expect(await el.videoClipGenerator()("x y", out("t4.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(fs.existsSync(out("t4.mp4"))).toBe(false);
    expect(logs.some((l) => l.includes("id=gen_4 failed") && l.includes("content policy") && l.includes("not charged"))).toBe(true);
    expect(fn.mock.calls.length).toBe(2);
    expect(el.videoServiceStandingDown()).toBe(false);
  });

  it("T2 time-out: the window passes while generating — nothing placed, no download, the service is not stood down", async () => {
    const replies: Reply[] = [{ status: 200, json: { id: "gen_2", status: "pending" } }];
    for (let i = 0; i < 50; i++) replies.push({ status: 200, json: { id: "gen_2", status: "generating" } });
    const { fn } = scripted(replies);
    let now = Date.now();
    el.setVideoPollSleepForTests(async (ms) => { now += ms; });
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(await el.videoClipGenerator()("x y", out("t2.mp4"), { durationSec: 8, deadlineAtMs: now + 35_000 })).toBe(false);
    expect(fs.existsSync(out("t2.mp4"))).toBe(false);
    expect(logs.some((l) => l.includes("id=gen_2 not finished within"))).toBe(true);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(5);
    expect(el.videoServiceStandingDown()).toBe(false);
  });

  it("T9 an expired signed link: one fresh read of the generation, then the download", async () => {
    scripted([
      { status: 200, json: { id: "gen_9", status: "pending" } },
      { status: 200, json: { id: "gen_9", status: "completed", content_url: `${SIGNED}&old=1` } },
      { status: 403 },
      { status: 200, json: { id: "gen_9", status: "completed", content_url: `${SIGNED}&fresh=1` } },
      { status: 200, bytes: sampleMp4 },
    ]);
    expect(await el.videoClipGenerator()("x y", out("t9.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(true);
    expect(logs.some((l) => l.includes("download answered HTTP 403") && l.includes("asking for a fresh link"))).toBe(true);
    expect(logs.join("\n")).not.toContain("SECRET-URL");
  });

  it("T5 unusable answers: completed without content_url, a download too small, no generation id — false, nothing on disk", async () => {
    scripted([
      { status: 200, json: { id: "gen_5", status: "pending" } },
      { status: 200, json: { id: "gen_5", status: "completed" } },
    ]);
    expect(await el.videoClipGenerator()("x y", out("t5a.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(logs.some((l) => l.includes("completed without content_url"))).toBe(true);
    scripted([
      { status: 200, json: { id: "gen_5b", status: "pending" } },
      { status: 200, json: { id: "gen_5b", status: "completed", content_url: SIGNED } },
      { status: 200, bytes: Buffer.alloc(100) },
    ]);
    expect(await el.videoClipGenerator()("x y", out("t5b.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(logs.some((l) => l.includes("download too small"))).toBe(true);
    scripted([{ status: 200, json: { status: "pending" } }]);
    expect(await el.videoClipGenerator()("x y", out("t5c.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(logs.some((l) => l.includes("without a generation id"))).toBe(true);
    for (const f of ["t5a.mp4", "t5b.mp4", "t5c.mp4"]) expect(fs.existsSync(out(f))).toBe(false);
  });

  it("T7 no video key: false before any request, even when the voice key is set", async () => {
    vi.stubEnv("ELEVENLABS_VIDEO_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "voice-key-2c9");
    const { fn } = scripted([]);
    expect(await el.videoClipGenerator()("x y", out("t7.mp4"), { durationSec: 8, deadlineAtMs: soon() })).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("voice-key-2c9");
  });
});

describe("wiring — the same rung, the same route, nothing bypassed", () => {
  const image = PIPE.slice(PIPE.indexOf("async function fetchBeatGeneratedImage("), PIPE.indexOf("\n}\n", PIPE.indexOf("async function fetchBeatGeneratedImage(")));
  /** VIDEO 650 — the rung is `fetchBeatGeneratedVideo` (ElevenLabs, then Replicate); the ElevenLabs body moved to `fetchBeatElevenLabsVideo`. */
  const video = PIPE.slice(PIPE.indexOf("async function fetchBeatElevenLabsVideo("), PIPE.indexOf("\n}\n", PIPE.indexOf("async function fetchBeatElevenLabsVideo(")));

  it("T11 the video is tried inside fetchBeatGeneratedImage, after the shared decision and prompt, before the still", () => {
    const decision = image.indexOf("generatedImageDecision({");
    const prompt = image.indexOf("const prompt = generatedImagePrompt({");
    const vid = image.indexOf("const video = await fetchBeatGeneratedVideo(beat, scene, workDir, sceneIndex, dedup, videoTitle, prompt, sentence, plan?.visual_description, plan?.search_query);");
    const still = image.indexOf("const made = await stillImageGenerator()(prompt, png)");
    expect(decision).toBeGreaterThan(0);
    expect(prompt).toBeGreaterThan(decision);
    expect(vid).toBeGreaterThan(prompt);
    expect(still).toBeGreaterThan(vid);
    expect(image).toContain("if (video) return video;");
    /** the pass itself, its cap and its place in the pipeline are unchanged */
    expect(PIPE).toContain("const clip = await fetchBeatGeneratedImage(beat, scene, workDir, si, dedup, videoTitle, GENERATED_IMAGES_PER_FILM - made);");
    expect(PIPE).toContain("await generateMissingBeatImages(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
  });

  it("T6/T5 the generated video goes through adoptClip (technical gate + picture editor against this sentence) and carries its provider", () => {
    expect(video).toContain("adoptClip(offered, dedup, sceneIndex, beat.index, sentence, workDir, searchQuery ?? sentence, {");
    expect(video).toContain("tagPathWithProviderAsset(path.join(workDir, `${base}.mp4`), GENERATED_VIDEO_PROVIDER, assetId, dedup.sourcingCache, {");
    expect(video).toContain('mediaType: "video",');
    expect(video).toContain("if (!clip || !isRealVideoClip(clip)) {");
    expect(video).toContain("generated, but not approved for the sentence — not used; the still is tried");
    expect(video).toContain("recordProviderDownloadOutcome(dedup.sourcingCache, outPath, false, \"the video service produced nothing\");");
    expect(video).not.toMatch(/stillImageToVideo|fetchYouTubeCCClips|downloadYouTubeCCClip/);
  });

  it("the video yields to the still when there is no key, the service stands down, the model cannot cover the hold, or the render has no window", () => {
    expect(video).toContain("if (!elevenLabsVideoConfigured()) return null;");
    expect(video).toContain("if (videoServiceStandingDown()) {");
    expect(video).toContain("const neededSec = generatedStillSec(beat);");
    expect(video).toContain("if (!generatedVideoCoversSentence(neededSec, cfg.durationSec)) {");
    expect(video).toContain("const windowMs = Math.min(cfg.maxWaitMs, remaining != null ? Math.max(0, remaining - GENERATED_VIDEO_RENDER_RESERVE_MS) : cfg.maxWaitMs);");
    expect(video).toContain("if (windowMs < VIDEO_POLL_MIN_MS * 2) {");
    expect(video).toContain("videoClipGenerator()(prompt, outPath, { durationSec: cfg.durationSec, deadlineAtMs: Date.now() + windowMs })");
  });

  it("T7 preflight names the capability on the key alone; the env example and docs carry the variables", () => {
    expect(PREFLIGHT).toContain('id: "video_generation",');
    expect(PREFLIGHT).toContain('requires: ["ELEVENLABS_VIDEO_API_KEY"],');
    expect(PREFLIGHT).not.toContain("falls back to ELEVENLABS_API_KEY");
    expect(ENV_EXAMPLE).toContain("# ELEVENLABS_VIDEO_API_KEY=");
    expect(ENV_EXAMPLE).toContain("# ELEVENLABS_VIDEO_MODEL_ID=veo-3.1-fast-generate-001");
    const docs = fs.readFileSync(path.join(__dirname, "..", "docs", "PRODUCTION_CONFIGURATION.md"), "utf8");
    expect(docs).toContain("ELEVENLABS_VIDEO_API_KEY");
  });

  it("T10 the module never logs the key or the content URL: every log line is built from id, status, counts and seconds", () => {
    const src = fs.readFileSync(path.join(__dirname, "elevenLabsVideoGeneration.ts"), "utf8");
    const logLines = src.split("\n").filter((l) => /console\.(log|warn)\(/.test(l) || /^\s*`\[\$\{GENERATED_VIDEO_FALLBACK\}\]/.test(l));
    for (const l of logLines) {
      expect(l, l).not.toMatch(/\bkey\b|contentUrl|content_url\}|cfg\.key\b|SIGNED/);
    }
    expect(src).not.toMatch(/console\.(log|warn)\([^)]*\b(key|contentUrl)\b[^)]*\)/);
  });
});
