/**
 * VIDEO 650 — REPLICATE prunaai/p-video-2 as the second generated-video provider.
 *
 * The API is mocked (this sandbox cannot reach replicate.com); ffmpeg is real: the download the mock
 * serves is a real 24 fps 1280×720 MP4, and the normalisation, the decode check and the motion check
 * run on it. Every test that reaches the API also asserts that the token never reaches the log.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as rep from "./replicateVideoGeneration";
import { AI_GENERATED_PROVIDERS, isAiGeneratedProvider, isGeneratedImageClip } from "./generatedImageFallback";
import { isAIGeneratedClip } from "./documentaryStyle";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { sentenceCoverage } from "./sentenceCoverage";
import { deliveryGate } from "./deliveryGate";
import { emptyTimeline, videoTrack, DEFAULT_FORMAT, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PREFLIGHT = fs.readFileSync(path.join(__dirname, "productionPreflight.ts"), "utf8");
const ENV_EXAMPLE = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

let dir = "";
let sample24: Buffer;
let sample24Path = "";
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-650-pvideo-"));
  sample24Path = path.join(dir, "sample24.mp4");
  /** what the model answers: 24 fps, 1280×720, a soundtrack, moving */
  await run(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=5.5:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample24Path,
  ]);
  sample24 = fs.readFileSync(sample24Path);
  expect(sample24.length).toBeGreaterThan(rep.GENERATED_MIN_BYTES);
}, 120_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const TOKEN = "r8_test_token_never_logged_4c9e";
let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m: string) => void logs.push(String(m)));
  rep.resetReplicateStandDownForTests();
  rep.resetReplicateSchemaCacheForTests();
  rep.setReplicatePollSleepForTests(async () => {});
  vi.stubEnv("REPLICATE_API_TOKEN", TOKEN);
  vi.stubEnv("REPLICATE_PVIDEO_PRICE_PER_SEC_USD", "0.05");
  for (const k of ["REPLICATE_PVIDEO_MODEL", "REPLICATE_PVIDEO_DURATION_SEC", "REPLICATE_PVIDEO_INPUT_JSON", "REPLICATE_PVIDEO_MAX_WAIT_MS", "REPLICATE_PVIDEO_POLL_MS"]) vi.stubEnv(k, "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rep.setReplicatePollSleepForTests(null);
  rep.resetReplicateStandDownForTests();
});

type Reply = { status: number; json?: unknown; bytes?: Buffer };
const reply = (r: Reply): Response => {
  const b = r.bytes ?? Buffer.alloc(0);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.json ?? {},
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  } as unknown as Response;
};
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const scripted = (replies: Array<Reply | ((call: Call) => Reply)>) => {
  /** every script starts from the model record: the per-model schema cache is emptied with it */
  rep.resetReplicateSchemaCacheForTests();
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {}, body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    const r = replies.shift();
    if (!r) throw new Error(`no scripted reply left for ${call.method} ${url}`);
    return reply(typeof r === "function" ? r(call) : r);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
};
const MODEL_RECORD = {
  status: 200,
  json: {
    latest_version: {
      id: "ver_abc123",
      openapi_schema: { components: { schemas: { Input: { properties: { prompt: { type: "string" }, duration: { type: "integer", enum: [5, 10], default: 5 }, resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "720p" }, aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"] }, seed: { type: "integer" } }, required: ["prompt"] } } } },
    },
  },
};
const OUTPUT_URL = "https://replicate.delivery/example/output-SECRET-URL.mp4";
const out = (name: string) => path.join(dir, name);
const opts = (over: Partial<Parameters<rep.ReplicateVideoGenerator>[2]> = {}) => ({ durationSec: 5, deadlineAtMs: Date.now() + 60_000, format: DEFAULT_FORMAT, neededSec: 4.2, ...over });
const noSecretInLogs = () => {
  for (const l of logs) {
    expect(l, l).not.toContain(TOKEN);
    expect(l, l).not.toContain("SECRET-URL");
  }
};

async function probe(file: string): Promise<{ width: number; height: number; fps: number; durationSec: number; audio: boolean }> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,duration", "-of", "json", file]);
  const streams = JSON.parse(stdout).streams as Array<Record<string, string>>;
  const v = streams.find((s) => s.codec_type === "video")!;
  const [n, d] = String(v.avg_frame_rate).split("/").map(Number);
  return { width: Number(v.width), height: Number(v.height), fps: n / d, durationSec: Number(v.duration), audio: streams.some((s) => s.codec_type === "audio") };
}

describe("configuration and the rules", () => {
  it("defaults: p-video-2, 5 s, 720p, 24 fps, 16:9, the four ceilings, retries 1; the token alone enables the rung", () => {
    const c = rep.replicateVideoConfig();
    expect(c).toMatchObject({ model: "prunaai/p-video-2", durationSec: 5, resolution: "720p", fps: 24, aspectRatio: "16:9", draft: false, maxSecondsPerVideo: 30, maxRequestsPerVideo: 6, maxCostPerVideoUsd: 1, maxRetries: 1, pricePerSecUsd: 0.05 });
    vi.stubEnv("REPLICATE_PVIDEO_DRAFT", "true");
    expect(rep.replicateVideoConfig().draft).toBe(true);
    vi.stubEnv("REPLICATE_PVIDEO_DRAFT", "");
    expect(rep.replicateVideoConfigured()).toBe(true);
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    expect(rep.replicateVideoConfigured()).toBe(false);
    expect(rep.replicateVideoConfig().token).toBeNull();
  });

  it("the ceilings: no price → no request; then requests, seconds, cost and retries, each named", () => {
    const cfg = { pricePerSecUsd: 0.05, resolution: "720p", draft: false, maxSecondsPerVideo: 10, maxRequestsPerVideo: 2, maxCostPerVideoUsd: 0.6, maxRetries: 1 };
    const spend = rep.newPVideoSpend();
    expect(rep.pVideoBudgetDecision(spend, { ...cfg, pricePerSecUsd: null }, 5, "s0b0")).toMatchObject({ allowed: false, reason: expect.stringContaining("REPLICATE_PVIDEO_PRICE_PER_SEC_USD") });
    expect(rep.pVideoBudgetDecision(spend, cfg, 5, "s0b0")).toMatchObject({ allowed: true, estimatedCostUsd: 0.25, billableSec: 5, rate: { perSecUsd: 0.05, source: "configured", published: 0.025 } });
    rep.notePVideoRequest(spend, 5, 0.25, "s0b0");
    expect(rep.pVideoBudgetDecision(spend, cfg, 5, "s0b0")).toMatchObject({ allowed: true, estimatedCostUsd: 0.25 }); // the one retry
    rep.notePVideoRequest(spend, 5, 0.25, "s0b0");
    expect(rep.pVideoBudgetDecision(spend, cfg, 5, "s0b0")).toMatchObject({ allowed: false, reason: expect.stringContaining("retries for s0b0") });
    expect(rep.pVideoBudgetDecision(spend, cfg, 5, "s0b1")).toMatchObject({ allowed: false, reason: expect.stringContaining("requests per video: 2 of 2") });
    const s2 = rep.newPVideoSpend();
    rep.notePVideoRequest(s2, 8, 0.1, "s0b0");
    expect(rep.pVideoBudgetDecision(s2, { ...cfg, maxRequestsPerVideo: 9 }, 5, "s0b1")).toMatchObject({ allowed: false, reason: expect.stringContaining("seconds per video") });
    const s3 = rep.newPVideoSpend();
    rep.notePVideoRequest(s3, 5, 0.4, "s0b0");
    expect(rep.pVideoBudgetDecision(s3, { ...cfg, maxRequestsPerVideo: 9, maxSecondsPerVideo: 99 }, 5, "s0b1")).toMatchObject({ allowed: false, reason: expect.stringContaining("cost per video") });
  });

  it("PRE-DEPLOY — the price: billed per WHOLE second; the configured price for THESE settings is the price; a price typed below the published rate is floored and named", () => {
    /** the published table, as of the date it carries: 720p full $0.025, 720p draft $0.015, 1080p full $0.05, 1080p draft $0.03 */
    expect(rep.PUBLISHED_PVIDEO2_RATES_USD_PER_SEC).toEqual({ "720p": { full: 0.025, draft: 0.015 }, "1080p": { full: 0.05, draft: 0.03 } });
    expect(rep.publishedRateFor({ resolution: "720p", draft: false })).toBe(0.025);
    expect(rep.publishedRateFor({ resolution: "720p", draft: true })).toBe(0.015);
    expect(rep.publishedRateFor({ resolution: "1080p", draft: false })).toBe(0.05);
    expect(rep.publishedRateFor({ resolution: "480p", draft: false })).toBeNull();
    /** whole seconds: 4.2 s asked for is 5 billed seconds */
    expect(rep.billableSeconds(4.2)).toBe(5);
    expect(rep.billableSeconds(5)).toBe(5);
    expect(rep.billableSeconds(0.2)).toBe(1);
    /** the configured price is used when it is at or above the published rate */
    expect(rep.effectiveRatePerSec({ pricePerSecUsd: 0.025, resolution: "720p", draft: false })).toEqual({ perSecUsd: 0.025, configured: 0.025, published: 0.025, source: "configured" });
    expect(rep.effectiveRatePerSec({ pricePerSecUsd: 0.04, resolution: "720p", draft: false })).toMatchObject({ perSecUsd: 0.04, source: "configured" });
    /** a price below the published rate for the configured settings: the published rate bounds the ceiling, the log names it */
    const floored = rep.effectiveRatePerSec({ pricePerSecUsd: 0.01, resolution: "1080p", draft: false });
    expect(floored).toEqual({ perSecUsd: 0.05, configured: 0.01, published: 0.05, source: "published_floor" });
    expect(rep.formatEffectiveRate({ resolution: "1080p", draft: false }, floored)).toContain("PUBLISHED FLOOR — configured $0.01/s is below the floor 1080p full $0.05/s (published/listed, unconfirmed");
    /**
     * GO/NO-GO — no table rate for the resolution: the listed "from" price ($0.025/s) is still the floor.
     * (Was: the configured price stood alone — a 480p price typed as $0.01 would have bounded the ceiling.)
     */
    expect(rep.REPLICATE_LISTED_MIN_USD_PER_SEC).toBe(0.025);
    expect(rep.effectiveRatePerSec({ pricePerSecUsd: 0.01, resolution: "480p", draft: true })).toEqual({ perSecUsd: 0.025, configured: 0.01, published: 0.025, source: "published_floor" });
    /** and the draft table rate ($0.015) never undercuts the listed minimum either */
    expect(rep.floorRateFor({ resolution: "720p", draft: true })).toBe(0.025);
    expect(rep.floorRateFor({ resolution: "720p", draft: false })).toBe(0.025);
    expect(rep.floorRateFor({ resolution: "1080p", draft: false })).toBe(0.05);
    /** a configured price above the floor is the price: a higher Replicate rate is honoured, never lowered */
    expect(rep.effectiveRatePerSec({ pricePerSecUsd: 0.04, resolution: "720p", draft: false })).toMatchObject({ perSecUsd: 0.04, source: "configured" });
    /** returned length in whole seconds: float noise is not a second, anything more is */
    expect(rep.billableSeconds(5.0004)).toBe(5);
    expect(rep.billableSeconds(5.5)).toBe(6);
    expect(rep.billableSeconds(5.01)).toBe(6);
    /** no price at all: no rate, no request */
    expect(rep.effectiveRatePerSec({ pricePerSecUsd: null, resolution: "720p", draft: false })).toMatchObject({ perSecUsd: null, source: "none" });
    expect(rep.formatEffectiveRate({ resolution: "720p", draft: false }, rep.effectiveRatePerSec({ pricePerSecUsd: null, resolution: "720p", draft: false }))).toContain("REPLICATE_PVIDEO_PRICE_PER_SEC_USD not set");
    /** the ceiling arithmetic uses the floored rate and the whole seconds: 4.2 s at a typed $0.001 on 720p full = 5 × $0.025 */
    const d = rep.pVideoBudgetDecision(rep.newPVideoSpend(), { pricePerSecUsd: 0.001, resolution: "720p", draft: false, maxSecondsPerVideo: 30, maxRequestsPerVideo: 6, maxCostPerVideoUsd: 1, maxRetries: 1 }, 4.2, "s0b0");
    expect(d).toMatchObject({ allowed: true, estimatedCostUsd: 0.125, billableSec: 5, rate: { source: "published_floor", perSecUsd: 0.025 } });
    /** the worked example of the defaults: 6 × 5 s at 720p full = $0.75, under the $1.00 ceiling; the seconds ceiling (30) stops a seventh */
    const spend = rep.newPVideoSpend();
    const dflt = { pricePerSecUsd: 0.025, resolution: "720p", draft: false, maxSecondsPerVideo: 30, maxRequestsPerVideo: 6, maxCostPerVideoUsd: 1, maxRetries: 1 };
    for (let i = 0; i < 6; i++) {
      const dec = rep.pVideoBudgetDecision(spend, dflt, 5, `s0b${i}`);
      expect(dec.allowed).toBe(true);
      rep.notePVideoRequest(spend, 5, (dec as { estimatedCostUsd: number }).estimatedCostUsd, `s0b${i}`);
    }
    expect(spend).toMatchObject({ requests: 6, secondsRequested: 30, costUsd: 0.75 });
    expect(rep.pVideoBudgetDecision(spend, dflt, 5, "s0b6")).toMatchObject({ allowed: false, reason: expect.stringContaining("requests per video: 6 of 6") });
  });

  it("PRE-DEPLOY — the ledger the film is bound by is the database's: claimed before every request, across replicas and attempts; no refund", () => {
    const at = PIPE.indexOf("async function fetchBeatReplicateVideo(");
    const body = PIPE.slice(at, PIPE.indexOf("async function fetchBeatElevenLabsVideo(", at));
    const order = [
      "pVideoBudgetDecision(spend, cfg, durationSec, where)",
      'const store = pVideoSpendStoreOverride() ?? (await import("./db")).dbPVideoSpendStore;',
      ".claim(videoId, { seconds: decision.billableSec, costUsd: decision.estimatedCostUsd, model: cfg.model }, { maxRequests: cfg.maxRequestsPerVideo, maxSeconds: cfg.maxSecondsPerVideo, maxCostUsd: cfg.maxCostPerVideoUsd })",
      "if (!claimed) {",
      "notePVideoRequest(spend, decision.billableSec, decision.estimatedCostUsd, where);",
      "replicateVideoGenerator()(prompt, outPath, {",
    ].map((n) => body.indexOf(n));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    /** nothing is refunded on a failure: the ledger only ever over-estimates */
    expect(body).not.toMatch(/spend\.(requests|secondsRequested|costUsd)\s*-=/);
    expect(body).not.toContain("refund");
    /** the store: a conditional UPDATE on the three ceilings, true for exactly the callers whose request fits; no video id or no database → false */
    const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
    const claim = DB.slice(DB.indexOf("export const dbPVideoSpendStore"), DB.indexOf("export const dbRenderLockStore"));
    expect(claim).toContain("if (!Number.isInteger(videoId) || videoId <= 0) return false;");
    expect(claim).toContain("if (!db) return false;");
    expect(claim).toContain("sql`${aiVideoGenerations.requests} < ${caps.maxRequests}`");
    expect(claim).toContain("sql`${aiVideoGenerations.secondsRequested} + ${secs} <= ${caps.maxSeconds}`");
    expect(claim).toContain("sql`${aiVideoGenerations.costMilliUsd} + ${costMilli} <= ${maxCostMilli}`");
    expect(claim).toContain("return affectedOne(result);");
    /** the table and its migration exist and are journaled */
    const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "drizzle", "schema.ts"), "utf8");
    expect(SCHEMA).toContain('export const aiVideoGenerations = mysqlTable("ai_video_generations", {');
    expect(fs.existsSync(path.join(__dirname, "..", "drizzle", "0065_video650_ai_video_generations.sql"))).toBe(true);
    expect(fs.readFileSync(path.join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")).toContain('"tag": "0065_video650_ai_video_generations"');
    /** the env example documents the draft setting and the published rates */
    expect(ENV_EXAMPLE).toContain("REPLICATE_PVIDEO_DRAFT=");
    expect(ENV_EXAMPLE).toContain("720p full $0.025/s");
  });

  it("the input follows the model's schema: declared names only, enums respected, overrides only when declared; without a schema the primary names", () => {
    const schema = MODEL_RECORD.json.latest_version.openapi_schema.components.schemas.Input;
    const c = { prompt: "p", durationSec: 5, resolution: "720p", fps: 24, aspectRatio: "16:9", draft: false, extra: { seed: 7, not_declared: 1 } };
    const a = rep.inputForSchema(c, schema);
    expect(a.input).toEqual({ prompt: "p", duration: 5, resolution: "720p", aspect_ratio: "16:9", seed: 7 });
    expect(a.dropped).toEqual(["fps", "draft=false (the model declares neither draft nor a matching mode)", "not_declared (override not declared by the model)"]);
    const b = rep.inputForSchema({ ...c, resolution: "4k", extra: {} }, schema);
    expect(b.input).not.toHaveProperty("resolution");
    expect(b.dropped[0]).toContain("resolution=4k");
    /** no schema: the primary names, and `draft` is NOT sent on a guess */
    const noSchema = rep.inputForSchema({ ...c, extra: {} }, null);
    expect(noSchema.input).toEqual({ prompt: "p", duration: 5, resolution: "720p", fps: 24, aspect_ratio: "16:9" });
    expect(noSchema.dropped).toEqual(["draft (no schema read — not sent on a guess)"]);
    /** PRE-DEPLOY — the draft setting is stated explicitly when the model declares it, as `draft` or as a mode enum */
    const withDraft = { properties: { ...schema.properties, draft: { type: "boolean", default: false }, fps: { type: "integer", enum: [24, 48], default: 24 } } };
    expect(rep.inputForSchema({ ...c, extra: {} }, withDraft).input).toEqual({ prompt: "p", duration: 5, resolution: "720p", fps: 24, aspect_ratio: "16:9", draft: false });
    expect(rep.inputForSchema({ ...c, draft: true, extra: {} }, withDraft).input).toMatchObject({ draft: true });
    const withMode = { properties: { ...schema.properties, mode: { type: "string", enum: ["speed", "quality"], default: "speed" } } };
    expect(rep.inputForSchema({ ...c, extra: {} }, withMode).input).toMatchObject({ mode: "quality" });
    expect(rep.inputForSchema({ ...c, draft: true, extra: {} }, withMode).input).toMatchObject({ mode: "speed" });
    expect(rep.inputForSchema({ ...c, extra: {} }, withMode).dropped).not.toContainEqual(expect.stringContaining("draft"));
    /** the duration: the sentence's seconds, snapped up to the model's enum */
    expect(rep.pVideoDurationFor(4.2, { durationSec: 5 }, schema)).toBe(5);
    expect(rep.pVideoDurationFor(6.5, { durationSec: 5 }, schema)).toBe(10);
    expect(rep.pVideoDurationFor(12, { durationSec: 5 }, schema)).toBe(10);
    expect(rep.pVideoDurationFor(6.5, { durationSec: 5 }, null)).toBe(7);
  });

  it("the output URL: a string, the first string of an array, an object's url; never http or nothing", () => {
    expect(rep.outputUrlOf("https://a/b.mp4")).toBe("https://a/b.mp4");
    expect(rep.outputUrlOf(["https://a/b.mp4", "https://a/c.mp4"])).toBe("https://a/b.mp4");
    expect(rep.outputUrlOf({ url: "https://a/b.mp4" })).toBe("https://a/b.mp4");
    expect(rep.outputUrlOf("http://a/b.mp4")).toBeNull();
    expect(rep.outputUrlOf(null)).toBeNull();
    expect(rep.outputUrlOf([])).toBeNull();
  });

  it("the prompt: subject and action, the narration as context, a documentary camera move, natural look, no text/logos/real person", () => {
    const p = rep.pVideoPrompt({ sentence: "The factory floor filled with workers at dawn.", visualDescription: "workers arriving at a steel factory at dawn", searchQuery: "steel factory dawn" });
    expect(p).toContain("Realistic documentary b-roll");
    expect(p).toContain("workers arriving at a steel factory at dawn; steel factory dawn");
    expect(p).toContain('"The factory floor filled with workers at dawn."');
    expect(p).toContain("Camera: slow handheld documentary camera");
    expect(p).toContain("no on-screen text");
    expect(p).toContain("no recognisable real person");
    expect(p.length).toBeLessThanOrEqual(1500);
  });

  it("a Replicate clip is AI-generated by its PROVIDER — for the coverage check and the fill rule — never by a filename guess", () => {
    expect(AI_GENERATED_PROVIDERS.has(rep.REPLICATE_VIDEO_PROVIDER)).toBe(true);
    expect(isAiGeneratedProvider("replicate_pvideo")).toBe(true);
    expect(isAiGeneratedProvider("youtube_cc")).toBe(false);
    expect(isGeneratedImageClip({ source: { provider: rep.REPLICATE_VIDEO_PROVIDER } })).toBe(true);
    /** VIDEO 649's rule stands: the filename regex is not the authority on a generated picture */
    expect(isAIGeneratedClip("/w/scene_0_genvid_b1_pvideo__pid_replicate_pvideo-abc.mp4")).toBe(false);
    expect(isAIGeneratedClip("/w/scene_0_b1__pid_youtube_cc-abc.mp4")).toBe(false);
  });
});

describe("the generator — model record, create, poll, download, normalise, measure", () => {
  it("T1 success: schema read → create → processing → succeeded → downloaded, normalised to 1920x1080@30, audio removed, moving; the token and the output URL never reach the log; the download carries no Authorization", async () => {
    const { calls } = scripted([
      MODEL_RECORD,
      { status: 201, json: { id: "pred_1", status: "starting", urls: { get: "https://api.replicate.com/v1/predictions/pred_1", cancel: "https://api.replicate.com/v1/predictions/pred_1/cancel" } } },
      { status: 200, json: { id: "pred_1", status: "processing" } },
      { status: 200, json: { id: "pred_1", status: "succeeded", output: [OUTPUT_URL], metrics: { predict_time: 41.2 } } },
      { status: 200, bytes: sample24 },
    ]);
    const o = out("t1.mp4");
    const r = await rep.replicateVideoGenerator()("a prompt", o, opts());
    expect(r).toEqual({ ok: true, predictionId: "pred_1", predictTimeSec: 41.2, outputDurationSec: expect.closeTo(5.5, 1) });
    /** GO/NO-GO — the RETURNED clip's length is measured and named in whole billable seconds (5.5 s → 6) */
    expect(logs.some((l) => l.includes("returned 5.50s = 6 billable s"))).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.replicate.com/v1/models/prunaai/p-video-2",
      "POST https://api.replicate.com/v1/models/prunaai/p-video-2/predictions",
      "GET https://api.replicate.com/v1/predictions/pred_1",
      "GET https://api.replicate.com/v1/predictions/pred_1",
      `GET ${OUTPUT_URL}`,
    ]);
    for (const c of calls.slice(0, 4)) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[4]!.headers.Authorization).toBeUndefined();
    expect(JSON.parse(calls[1]!.body!)).toEqual({ input: { prompt: "a prompt", duration: 5, resolution: "720p", aspect_ratio: "16:9" } });
    const p = await probe(o);
    expect(p).toMatchObject({ width: 1920, height: 1080, audio: false });
    expect(Math.abs(p.fps - 30)).toBeLessThan(0.01);
    expect(p.durationSec).toBeGreaterThanOrEqual(5.4);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".download-"))).toEqual([]);
    expect(logs.some((l) => l.includes("settings=720p/24fps/5s/full input=[prompt,duration,resolution,aspect_ratio]") && l.includes("dropped=[fps; draft=false"))).toBe(true);
    noSecretInLogs();
  }, 120_000);

  it("T2 no token: a named refusal before any request", async () => {
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    const { fn } = scripted([]);
    const r = await rep.replicateVideoGenerator()("p", out("t2.mp4"), opts());
    expect(r).toMatchObject({ ok: false, reason: "REPLICATE_API_TOKEN is not set", charged: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("T3 HTTP 402 at create: nothing downloaded, the service stands down, the next sentence sends no request", async () => {
    const { fn } = scripted([MODEL_RECORD, { status: 402, json: { detail: "Insufficient credit" } }]);
    const r = await rep.replicateVideoGenerator()("p", out("t3.mp4"), opts());
    expect(r).toMatchObject({ ok: false, reason: "create answered HTTP 402", charged: false });
    expect(rep.replicateStandingDown()).toBe(true);
    const again = await rep.replicateVideoGenerator()("p", out("t3b.mp4"), opts());
    expect(again).toMatchObject({ ok: false, reason: expect.stringContaining("standing down") });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(out("t3.mp4"))).toBe(false);
    noSecretInLogs();
  });

  it("T4 status failed: no file, the reason in the log, charged, no retry inside the generator", async () => {
    const { fn } = scripted([
      MODEL_RECORD,
      { status: 201, json: { id: "pred_4", status: "starting" } },
      { status: 200, json: { id: "pred_4", status: "failed", error: "NSFW content detected" } },
    ]);
    const r = await rep.replicateVideoGenerator()("p", out("t4.mp4"), opts());
    expect(r).toMatchObject({ ok: false, reason: "failed: NSFW content detected", predictionId: "pred_4", charged: true });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(out("t4.mp4"))).toBe(false);
  });

  it("T5 time-out: the window closes while processing — the prediction is cancelled, nothing downloaded", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    rep.setReplicatePollSleepForTests(async (ms) => { now += ms; });
    const { calls } = scripted([
      MODEL_RECORD,
      { status: 201, json: { id: "pred_5", status: "starting", urls: { get: "https://api.replicate.com/v1/predictions/pred_5", cancel: "https://api.replicate.com/v1/predictions/pred_5/cancel" } } },
      { status: 200, json: { id: "pred_5", status: "processing" } },
      { status: 200, json: { id: "pred_5", status: "processing" } },
      { status: 200, json: { id: "pred_5", status: "processing" } },
      { status: 200, json: { id: "pred_5", status: "processing" } },
      { status: 200, json: { id: "pred_5", status: "canceled" } },
    ]);
    const r = await rep.replicateVideoGenerator()("p", out("t5.mp4"), opts({ deadlineAtMs: now + 10_000 }));
    expect(r).toMatchObject({ ok: false, reason: "not finished within the window", predictionId: "pred_5" });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pred_5/cancel"))).toBe(true);
    expect(calls.some((c) => c.url === OUTPUT_URL)).toBe(false);
    expect(rep.replicateStandingDown()).toBe(false);
  });

  it("T6 unusable answers: succeeded without a usable URL (an http link), create without an id, a download that is not a video, a download too small — false, nothing left on disk", async () => {
    scripted([MODEL_RECORD, { status: 201, json: { id: "pred_6a", status: "starting" } }, { status: 200, json: { id: "pred_6a", status: "succeeded", output: "http://insecure/out.mp4" } }]);
    expect(await rep.replicateVideoGenerator()("p", out("t6a.mp4"), opts())).toMatchObject({ ok: false, reason: "succeeded without a usable output URL" });
    scripted([MODEL_RECORD, { status: 201, json: { status: "starting" } }]);
    expect(await rep.replicateVideoGenerator()("p", out("t6b.mp4"), opts())).toMatchObject({ ok: false, reason: "create answered without a prediction id" });
    const junk = Buffer.alloc(80_000, 7);
    scripted([MODEL_RECORD, { status: 201, json: { id: "pred_6c", status: "starting" } }, { status: 200, json: { id: "pred_6c", status: "succeeded", output: OUTPUT_URL } }, { status: 200, bytes: junk }]);
    const r = await rep.replicateVideoGenerator()("p", out("t6c.mp4"), opts());
    expect(r).toMatchObject({ ok: false, charged: true });
    if (!r.ok) expect(r.reason).toMatch(/could not be normalised|no decodable video stream/);
    expect(fs.existsSync(out("t6c.mp4"))).toBe(false);
    scripted([MODEL_RECORD, { status: 201, json: { id: "pred_6d", status: "starting" } }, { status: 200, json: { id: "pred_6d", status: "succeeded", output: OUTPUT_URL } }, { status: 200, bytes: Buffer.alloc(100) }]);
    expect(await rep.replicateVideoGenerator()("p", out("t6d.mp4"), opts())).toMatchObject({ ok: false, reason: "download too small (100 bytes)" });
    expect(fs.readdirSync(dir).filter((f) => f.includes(".download-"))).toEqual([]);
    noSecretInLogs();
  }, 120_000);

  it("FIRST-RENDER PREP — without a positive price Replicate is OFF: no model read, no request; 0, negative and text are not a price", () => {
    for (const bad of ["", "0", "-0.025", "abc", "  "]) {
      vi.stubEnv("REPLICATE_PVIDEO_PRICE_PER_SEC_USD", bad);
      expect(rep.replicateVideoConfig().pricePerSecUsd, JSON.stringify(bad)).toBeNull();
    }
    vi.stubEnv("REPLICATE_PVIDEO_PRICE_PER_SEC_USD", "0.025");
    expect(rep.replicateVideoConfig().pricePerSecUsd).toBe(0.025);
    /** in the route the price check comes before ANY network call (the model read) and before the ceilings */
    const at = PIPE.indexOf("async function fetchBeatReplicateVideo(");
    const body = PIPE.slice(at, PIPE.indexOf("async function fetchBeatElevenLabsVideo(", at));
    const order = [
      "if (!replicateVideoConfigured()) {",
      "if (cfg.pricePerSecUsd == null) {",
      "disabled — REPLICATE_PVIDEO_PRICE_PER_SEC_USD is not set to a positive number",
      "await getModelSchemaCached(cfg.token!, cfg.model)",
      "pVideoBudgetDecision(spend, cfg, durationSec, where)",
      ".claim(videoId,",
    ].map((n) => body.indexOf(n));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    /** the three ceilings keep their defaults */
    expect([rep.DEFAULT_MAX_REQUESTS_PER_VIDEO, rep.DEFAULT_MAX_SECONDS_PER_VIDEO, rep.DEFAULT_MAX_COST_PER_VIDEO_USD]).toEqual([6, 30, 1]);
  });

  it("GO/NO-GO — the seconds sent are the seconds budgeted: a schema that asks another duration sends NOTHING (no create, retryable=false)", async () => {
    /** budgeted 7 s, but the model only offers 5 or 10 → nothing is sent, the claim is not repeated */
    const { calls } = scripted([MODEL_RECORD]);
    const r = await rep.replicateVideoGenerator()("p", out("t8.mp4"), opts({ durationSec: 7, neededSec: 6.2 }));
    expect(r).toEqual({ ok: false, reason: "the model's schema asks 10s, 7s was budgeted", predictionId: null, charged: false, retryable: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    /** the pipeline chooses the duration FROM the cached schema before it claims, and does not retry this refusal */
    const at = PIPE.indexOf("async function fetchBeatReplicateVideo(");
    const body = PIPE.slice(at, PIPE.indexOf("async function fetchBeatElevenLabsVideo(", at));
    const order = [
      "const { schema: modelSchema } = await getModelSchemaCached(cfg.token!, cfg.model)",
      "const durationSec = pVideoDurationFor(neededSec, cfg, modelSchema);",
      "pVideoBudgetDecision(spend, cfg, durationSec, where)",
      ".claim(videoId,",
      "replicateVideoGenerator()(prompt, outPath, {",
      "if (made.charged || made.retryable === false) return null;",
    ].map((n) => body.indexOf(n));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    /** the schema cache: one GET serves the pipeline's choice and the generator's request; a failed read is never cached */
    rep.resetReplicateSchemaCacheForTests();
    const two = scripted([{ status: 500 }, MODEL_RECORD]);
    expect((await rep.getModelSchemaCached(TOKEN, "prunaai/p-video-2")).schema).toBeNull();
    expect((await rep.getModelSchemaCached(TOKEN, "prunaai/p-video-2")).schema).not.toBeNull();
    expect((await rep.getModelSchemaCached(TOKEN, "prunaai/p-video-2")).schema).not.toBeNull();
    expect(two.calls).toHaveLength(2);
    noSecretInLogs();
  });

  it("GO/NO-GO — billing follows the RETURNED clip: a longer clip is added to the video's ledger, unconditionally, after the fact", () => {
    const at = PIPE.indexOf("async function fetchBeatReplicateVideo(");
    const body = PIPE.slice(at, PIPE.indexOf("async function fetchBeatElevenLabsVideo(", at));
    const order = [
      "if (made.ok) {",
      "const returnedSec = made.outputDurationSec != null ? billableSeconds(made.outputDurationSec) : decision.billableSec;",
      "if (returnedSec > decision.billableSec) {",
      "await store.reconcile(videoId, { seconds: extraSec, costUsd: extraCost })",
      "spend.secondsRequested += extraSec;",
      "ledger corrected +",
    ].map((n) => body.indexOf(n));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
    const store = DB.slice(DB.indexOf("export const dbPVideoSpendStore"), DB.indexOf("export const dbRenderLockStore"));
    const reconcile = store.slice(store.indexOf("async reconcile(videoId, add) {"));
    expect(reconcile).toContain("secondsRequested: sql`${aiVideoGenerations.secondsRequested} + ${secs}`");
    expect(reconcile).toContain("costMilliUsd: sql`${aiVideoGenerations.costMilliUsd} + ${costMilli}`");
    /** no ceiling condition on the correction: the money is already spent */
    expect(reconcile).toContain(".where(eq(aiVideoGenerations.videoId, videoId));");
    expect(reconcile).not.toContain("caps.");
  });

  it("T7 the normalisation on its own: 24 fps 1280x720 with sound → the film's 1920x1080 at 30 fps, silent, measured as moving; a still is refused as not moving", async () => {
    const o = out("t7.mp4");
    const r = await rep.normaliseGeneratedVideo(FFMPEG, sample24Path, o, DEFAULT_FORMAT, 5);
    expect(r).toMatchObject({ ok: true });
    const p = await probe(o);
    expect(p).toMatchObject({ width: 1920, height: 1080, audio: false });
    expect(Math.abs(p.fps - 30)).toBeLessThan(0.01);
    const still = path.join(dir, "still24.mp4");
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#334455:s=1280x720:r=24:d=5.5", "-vf", "noise=alls=30:allf=u", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", still]);
    const s = await rep.normaliseGeneratedVideo(FFMPEG, still, out("t7still.mp4"), DEFAULT_FORMAT, 5);
    expect(s).toMatchObject({ ok: false, reason: expect.stringContaining("does not move") });
    /** too short for the sentence */
    const short = await rep.normaliseGeneratedVideo(FFMPEG, sample24Path, out("t7short.mp4"), DEFAULT_FORMAT, 9);
    expect(short).toMatchObject({ ok: false, reason: expect.stringContaining("the sentence needs 9.00s") });
  }, 120_000);
});

/* ═══════════════ the pipeline's wiring ═══════════════ */

function clipFor(id: string, provider: string, o: { start: number; end: number; approval?: "judge_fit" }): TimelineVideoClip {
  return {
    id, kind: "video",
    source: { provider, providerAssetId: id, archiveAssetId: 9, ...(o.approval ? { contentApproval: o.approval } : {}) },
    sourceIn: 0, sourceOut: o.end - o.start, timelineStart: o.start, timelineEnd: o.end,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", previewSource: "asset", sceneIndex: 0, beatIndex: 0,
  } as TimelineVideoClip;
}

describe("the pipeline: order, caps before requests, the archive as the duplicate guard, the timeline mark", () => {
  it("Replicate is asked only inside the generated-video rung, after ElevenLabs, for a sentence still without a picture", () => {
    const rung = PIPE.indexOf("async function fetchBeatGeneratedVideo(");
    const body = PIPE.slice(rung, rung + 1200);
    expect(body.indexOf("fetchBeatElevenLabsVideo(")).toBeGreaterThan(0);
    expect(body.indexOf("fetchBeatReplicateVideo(")).toBeGreaterThan(body.indexOf("fetchBeatElevenLabsVideo("));
    /** the rung itself runs only from generateMissingBeatImages → fetchBeatGeneratedImage, after every real source */
    expect(PIPE).toContain("const video = await fetchBeatGeneratedVideo(beat, scene, workDir, sceneIndex, dedup, videoTitle, prompt, sentence, plan?.visual_description, plan?.search_query);");
    const generic = PIPE.indexOf("await placeGenericMovingFallbacks(");
    const gen = PIPE.indexOf("await generateMissingBeatImages(");
    expect(gen).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(gen);
  });

  it("the Replicate route: the token check, the standing-down check, the ceilings BEFORE the request, the archive lookup BEFORE generating, adoptClip after", () => {
    const at = PIPE.indexOf("async function fetchBeatReplicateVideo(");
    const body = PIPE.slice(at, PIPE.indexOf("async function fetchBeatElevenLabsVideo(", at));
    const order = [
      "if (!replicateVideoConfigured()) {",
      "REPLICATE_API_TOKEN is not set",
      "if (replicateStandingDown()) {",
      "findMediaArchiveAssetByProviderAsset(REPLICATE_VIDEO_PROVIDER, assetId)",
      "pVideoBudgetDecision(spend, cfg, durationSec, where)",
      "notePVideoRequest(spend, decision.billableSec, decision.estimatedCostUsd, where)",
      "replicateVideoGenerator()(prompt, outPath, {",
      "if (made.charged || made.retryable === false) return null;",
      "adoptClip(offered, dedup, sceneIndex, beat.index, sentence, workDir, searchQuery ?? sentence, {",
      "coverageType=ai_generated_footage",
    ].map((n) => body.indexOf(n));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    /** the provider asset id is the generation's identity: model + prompt + duration */
    expect(body).toContain("createHash(\"sha256\").update(`${cfg.model}|${prompt}|${durationSec}`)");
    /** the archive's licence note and tag name it as generated */
    expect(PIPE).toContain('c.source === REPLICATE_VIDEO_PROVIDER ? "AI-generated (Replicate prunaai/p-video-2) — generated=true, not real footage"');
    expect(PIPE).toContain('tags: c.source === REPLICATE_VIDEO_PROVIDER ? ["ai-generated"] : []');
  });

  it("a Replicate clip approved for its sentence is cover, named ai_generated_footage; the delivery gate allows it and says so", () => {
    const t = emptyTimeline(650);
    t.durationSec = 8;
    videoTrack(t).push(clipFor("g", rep.REPLICATE_VIDEO_PROVIDER, { start: 0, end: 5, approval: "judge_fit" }));
    t.sentences = [{ sceneIndex: 0, beatIndex: 0, startSec: 0, endSec: 5, timingBasis: "measured", text: "A sentence." }];
    const cov = sentenceCoverage(t as ProjectTimeline);
    expect(cov.sentences[0]).toMatchObject({ status: "covered", approvedFootageSec: 5, aiGeneratedSec: 5, kinds: ["approved_footage", "ai_generated_footage"] });
    const v = deliveryGate({
      videoId: 650, route: "cinematic_timeline", timelineExists: true, assetsOnly: true, delivered: null,
      clips: [{ clipId: "g", archiveAssetId: 9, provider: rep.REPLICATE_VIDEO_PROVIDER, providerAssetId: "g", resolved: true, fromArchive: true, isPlaceholder: false }],
      sentenceCoverage: cov,
    });
    expect(v.allow, v.allow ? "" : JSON.stringify(v.failures)).toBe(true);
    expect(v.lines.some((l) => l.includes("QUALITY_NOTE AI_GENERATED_FOOTAGE sentences=1 sec=5.00 (s0b0)"))).toBe(true);
    /** a real clip is not named as generated */
    const real = sentenceCoverage({ ...t, tracks: t.tracks.map((tr) => (tr.kind === "VIDEO" ? { ...tr, clips: [clipFor("r", "youtube_cc", { start: 0, end: 5, approval: "judge_fit" })] } : tr)) } as ProjectTimeline);
    expect(real.sentences[0]!.kinds).toEqual(["approved_footage"]);
  });

  it("preflight names the capability on the token, and the env example carries every variable", () => {
    expect(PREFLIGHT).toContain('id: "video_generation_replicate"');
    expect(PREFLIGHT).toContain('requires: ["REPLICATE_API_TOKEN"]');
    for (const v of ["REPLICATE_API_TOKEN", "REPLICATE_PVIDEO_PRICE_PER_SEC_USD", "REPLICATE_PVIDEO_MAX_SECONDS_PER_VIDEO", "REPLICATE_PVIDEO_MAX_REQUESTS_PER_VIDEO", "REPLICATE_PVIDEO_MAX_COST_PER_VIDEO_USD", "REPLICATE_PVIDEO_MAX_RETRIES", "REPLICATE_PVIDEO_INPUT_JSON"]) {
      expect(ENV_EXAMPLE, v).toContain(v);
    }
  });

  it("without Replicate the other fallbacks stay: the still, generic footage and the card are untouched by the rung", () => {
    expect(PIPE).toContain("if (video) return video;");
    expect(PIPE).toContain("const base = `scene_${sceneIndex}_genimg_b${beat.index}`;");
    expect(PIPE).toContain("await placeGenericMovingFallbacks(scenes, sceneVisualResults, visualDedup, workDir, topicContext);");
  });
});
