/**
 * APIFY SUCCEEDS ONLY WHEN THE FILE DOES — RONDE 644.
 *
 * The HTTP layer is replaced with a scripted Apify that answers the documented endpoints; the file
 * the "record" download writes is a real MP4 made by ffmpeg, and the validation is the production
 * one. So every success below is a file ffprobe read and a frame that decoded.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  acquireYoutubeVideoViaApify,
  buildActorInput,
  pickVideoRecord,
  type ApifyDeps,
} from "./apifyYoutubeProvider";
import { validateAcquiredFile } from "./youtubeAcquisitionValidation";
import { probeVideoStreamMeta, probeVideoDurationSec } from "./videoPipeline";
import { extractFrameAtFraction } from "./localClipVision";
import type { SchemaField } from "./apifySchemaProbe";

const TOKEN = "apify_api_NEVER_PRINT_ME";
const SCHEMA: SchemaField[] = [
  { name: "urls", type: "array", required: true },
  { name: "quality", type: "string", required: false, enumValues: ["360", "480", "720", "1080"] },
  { name: "format", type: "string", required: false, enumValues: ["video", "audio"] },
  { name: "residentialProxyMode", type: "string", required: false, enumValues: ["fallback", "disabled"] },
  { name: "youtubeCookies", type: "string", required: false },
];

let dir: string;
let realMp4: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "apify-test-"));
  realMp4 = path.join(dir, "fixture.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=25:d=4",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", realMp4]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Script = {
  start?: { status: number; body?: unknown };
  polls?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  keys?: Array<{ key: string; size: number }>;
  fileBytes?: "real" | "junk" | "none";
};

function deps(script: Script, log: string[], urls: string[], clock = { t: 0 }): ApifyDeps {
  const polls = [...(script.polls ?? [{ status: "SUCCEEDED" }])];
  const runBase = { id: "run123", defaultDatasetId: "ds1", defaultKeyValueStoreId: "kv1", usageTotalUsd: 0.04 };
  return {
    http: async (method, url, init) => {
      urls.push(url);
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      clock.t += 1000;
      if (method === "POST") {
        const s = script.start ?? { status: 201, body: { data: { ...runBase, status: "RUNNING" } } };
        return { status: s.status, json: async () => s.body ?? {} };
      }
      if (url.includes("/actor-runs/")) {
        clock.t += 20_000;
        const next = polls.shift() ?? { status: "RUNNING" };
        return { status: 200, json: async () => ({ data: { ...runBase, ...next } }) };
      }
      if (url.includes("/datasets/")) return { status: 200, json: async () => script.items ?? [{ title: "x", downloadUrl: "u" }] };
      if (url.includes("/keys")) {
        return { status: 200, json: async () => ({ data: { items: script.keys ?? [{ key: "INPUT", size: 300 }, { key: "video.mp4", size: 900_000 }] } }) };
      }
      return { status: 404, json: async () => ({}) };
    },
    downloadTo: async (url, headers, outPath) => {
      urls.push(url);
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      if (script.fileBytes === "none") return null;
      if (script.fileBytes === "junk") fs.writeFileSync(outPath, Buffer.alloc(60_000, "x"));
      else fs.copyFileSync(realMp4, outPath);
      return fs.statSync(outPath).size;
    },
    inputSchema: async () => SCHEMA,
    validate: (p) =>
      validateAcquiredFile(p, 2, {
        probe: async (f) => {
          const m = await probeVideoStreamMeta(f);
          return !m || m.durationSec > 0 ? m : { ...m, durationSec: await probeVideoDurationSec(f) };
        },
        decodeFrame: (f) => extractFrameAtFraction(f, `${f}.jpg`, 0.5),
      }),
    streamDetails: async () => ({ codec: "h264", fps: 25 }),
    now: () => clock.t,
    log: (l) => log.push(l),
    sleep: async () => {},
  };
}

const req = (over: Partial<Parameters<typeof acquireYoutubeVideoViaApify>[0]> = {}) => ({
  videoId: "aqz-KE-bpKQ",
  quality: "1080",
  outPath: path.join(dir, "out.mp4"),
  deadlineMs: 600_000,
  token: TOKEN,
  enabled: true,
  ...over,
});

describe("the input is built only from the schema the actor declares", () => {
  it("sets urls, quality, format and proxy mode because the schema admits them", () => {
    const plan = buildActorInput(SCHEMA, "https://www.youtube.com/watch?v=x", { quality: "1080", format: "video", residentialProxyMode: "fallback" });
    expect(plan).toMatchObject({ ok: true, input: { urls: ["https://www.youtube.com/watch?v=x"], quality: "1080", format: "video", residentialProxyMode: "fallback" } });
  });

  it("1080 not offered → the highest offered below it, never a value the enum refuses", () => {
    const plan = buildActorInput([SCHEMA[0]!, { name: "quality", type: "string", required: false, enumValues: ["480", "720"] }], "u", { quality: "1080" });
    expect(plan.ok && plan.quality).toBe("720");
  });

  it("NEVER COOKIES — youtubeCookies exists in the schema and is never set", () => {
    const plan = buildActorInput(SCHEMA, "u", { quality: "1080", format: "video", residentialProxyMode: "fallback" });
    expect(plan.ok && "youtubeCookies" in plan.input).toBe(false);
  });

  it("a field the schema does not have is not sent", () => {
    const plan = buildActorInput([SCHEMA[0]!], "u", { quality: "1080", format: "video", residentialProxyMode: "fallback" });
    expect(plan.ok && Object.keys(plan.input)).toEqual(["urls"]);
  });

  it("no urls field, or a required field it cannot fill → a named failure, not a guess", () => {
    expect(buildActorInput([{ name: "startUrls", type: "array", required: true }], "u", { quality: "1080" })).toMatchObject({ ok: false });
    expect(buildActorInput([...SCHEMA, { name: "apiKey", type: "string", required: true }], "u", { quality: "1080" })).toMatchObject({ ok: false });
  });
});

describe("the file is the run's largest stored record, and only a video counts", () => {
  it("INPUT and small records are never the video", () => {
    expect(pickVideoRecord([{ key: "INPUT", size: 5_000_000 }, { key: "OUTPUT", size: 800 }, { key: "a.mp4", size: 2_000_000 }])?.key).toBe("a.mp4");
    expect(pickVideoRecord([{ key: "OUTPUT", size: 800 }])).toBeNull();
  });
});

describe("acquisition outcomes", () => {
  it("SUCCESS: a real MP4, validated, with every timestamp measured", async () => {
    const log: string[] = [];
    const urls: string[] = [];
    const r = await acquireYoutubeVideoViaApify(req(), deps({}, log, urls));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ provider: "apify", runId: "run123", width: 1280, height: 720, codec: "h264" });
    expect(r.durationSec).toBeGreaterThan(3);
    for (const k of ["runCreatedAt", "runFinishedAt", "fileDownloadStartedAt", "fileDownloadFinishedAt", "validationStartedAt", "validationFinishedAt"] as const) {
      expect(r.timing[k], k).not.toBeNull();
    }
    expect(r.summary.totalMs).toBeGreaterThan(0);
    expect(log.map((l) => l.split(" ")[1])).toEqual(["START", "RUN_STARTED", "OUTPUT_FIELDS", "FILE_READY", "VALIDATED"]);
  });

  it("THE TOKEN NEVER APPEARS IN A URL OR A LOG LINE", async () => {
    const log: string[] = [];
    const urls: string[] = [];
    await acquireYoutubeVideoViaApify(req(), deps({}, log, urls));
    await acquireYoutubeVideoViaApify(req(), deps({ start: { status: 401 } }, log, urls));
    for (const s of [...log, ...urls]) expect(s).not.toContain(TOKEN);
  });

  it("disabled, or no token → named, and nothing is called", async () => {
    const urls: string[] = [];
    expect(await acquireYoutubeVideoViaApify(req({ enabled: false }), deps({}, [], urls))).toMatchObject({ ok: false, failure: "APIFY_DISABLED" });
    expect(await acquireYoutubeVideoViaApify(req({ token: undefined }), deps({}, [], urls))).toMatchObject({ ok: false, failure: "APIFY_NO_TOKEN" });
    expect(urls).toEqual([]);
  });

  it("HTTP error on start → APIFY_HTTP_ERROR", async () => {
    expect(await acquireYoutubeVideoViaApify(req(), deps({ start: { status: 402 } }, [], []))).toMatchObject({ failure: "APIFY_HTTP_ERROR" });
  });

  it("run FAILED or ABORTED → APIFY_RUN_FAILED; TIMED-OUT on Apify → APIFY_TIMEOUT", async () => {
    expect(await acquireYoutubeVideoViaApify(req(), deps({ polls: [{ status: "FAILED", statusMessage: "bot check" }] }, [], []))).toMatchObject({ failure: "APIFY_RUN_FAILED" });
    expect(await acquireYoutubeVideoViaApify(req(), deps({ polls: [{ status: "TIMED-OUT" }] }, [], []))).toMatchObject({ failure: "APIFY_TIMEOUT" });
  });

  it("our own deadline passes while the run is still RUNNING → APIFY_TIMEOUT, not a hang", async () => {
    const r = await acquireYoutubeVideoViaApify(req({ deadlineMs: 45_000 }), deps({ polls: [{ status: "RUNNING" }, { status: "RUNNING" }, { status: "RUNNING" }] }, [], []));
    expect(r).toMatchObject({ ok: false, failure: "APIFY_TIMEOUT" });
  });

  it("the actor's own failureCode / error is a failure even when the run SUCCEEDED", async () => {
    const r = await acquireYoutubeVideoViaApify(req(), deps({ items: [{ status: "failed", failureCode: "VIDEO_UNAVAILABLE", error: "Video unavailable" }] }, [], []));
    expect(r).toMatchObject({ failure: "APIFY_RUN_FAILED" });
    if (!r.ok) expect(r.detail).toContain("VIDEO_UNAVAILABLE");
  });

  it("the record the row names in kvStoreKey is the one downloaded, not merely the largest", async () => {
    const urls: string[] = [];
    await acquireYoutubeVideoViaApify(
      req(),
      deps({ items: [{ kvStoreKey: "named.mp4", status: "success" }], keys: [{ key: "big.bin", size: 9_000_000 }, { key: "named.mp4", size: 500_000 }] }, [], urls)
    );
    expect(urls.some((u) => u.endsWith("/records/named.mp4"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/records/big.bin"))).toBe(false);
  });

  it("no stored file → APIFY_NO_FILE; download fails → APIFY_FILE_DOWNLOAD_FAILED", async () => {
    expect(await acquireYoutubeVideoViaApify(req(), deps({ keys: [{ key: "INPUT", size: 200 }] }, [], []))).toMatchObject({ failure: "APIFY_NO_FILE" });
    expect(await acquireYoutubeVideoViaApify(req(), deps({ fileBytes: "none" }, [], []))).toMatchObject({ failure: "APIFY_FILE_DOWNLOAD_FAILED" });
  });

  it("A FILE THAT IS NOT A VIDEO IS APIFY_INVALID_FILE, AND IS DELETED", async () => {
    const r = await acquireYoutubeVideoViaApify(req(), deps({ fileBytes: "junk" }, [], []));
    expect(r).toMatchObject({ ok: false, failure: "APIFY_INVALID_FILE" });
    expect(fs.existsSync(path.join(dir, "out.mp4"))).toBe(false);
  });
});

describe("MEASUREMENT MODE — the first test is not limited by FastVid's old timing", () => {
  const long = Array.from({ length: 30 }, () => ({ status: "RUNNING" })).concat([{ status: "SUCCEEDED" }]);

  it("no FastVid deadline, and NO timeout is sent to Apify", async () => {
    const urls: string[] = [];
    const r = await acquireYoutubeVideoViaApify(req({ deadlineMs: null, watchdogMs: 45 * 60_000 }), deps({}, [], urls));
    expect(r.ok).toBe(true);
    const start = urls.find((u) => u.includes("/runs?"))!;
    expect(start).not.toMatch(/timeout=/);
    expect(start).toContain("maxTotalChargeUsd=");
  });

  it("a run that takes ~10 minutes completes — the same run a 45 s deadline would kill", async () => {
    const measured = await acquireYoutubeVideoViaApify(req({ deadlineMs: null, watchdogMs: 45 * 60_000 }), deps({ polls: long }, [], []));
    expect(measured.ok).toBe(true);
    expect(measured.summary.totalMs).toBeGreaterThan(9 * 60_000);
    const bounded = await acquireYoutubeVideoViaApify(req({ deadlineMs: 45_000 }), deps({ polls: long }, [], []));
    expect(bounded).toMatchObject({ ok: false, failure: "APIFY_TIMEOUT" });
  });

  it("the watchdog is a hang guard, reported as NOT a measured acquisition time", async () => {
    const r = await acquireYoutubeVideoViaApify(req({ deadlineMs: null, watchdogMs: 60_000 }), deps({ polls: long }, [], []));
    expect(r).toMatchObject({ ok: false, failure: "WATCHDOG_TIMEOUT" });
    if (!r.ok) expect(r.detail).toContain("NOT a measured acquisition time");
  });

  it("totalMs stops when validation stops — TOTAL TIME TO USABLE MP4 — and actorWaitMs is the run itself", async () => {
    const r = await acquireYoutubeVideoViaApify(req({ deadlineMs: null }), deps({}, [], []));
    if (!r.ok) throw new Error("expected success");
    expect(r.summary.totalMs).toBe(r.timing.validationFinishedAt! - r.timing.startedAt);
    expect(r.summary.actorWaitMs).toBe(r.timing.runFinishedAt! - r.timing.runCreatedAt!);
  });
});

describe("the report the brief asks for", () => {
  it("every field, and a watchdog is never presented as a time", async () => {
    const { formatApifyTimingReport } = await import("./apifyLiveTest");
    const ok = formatApifyTimingReport({
      ok: true,
      summary: { actorWaitMs: 47_300, fileDownloadMs: 8_100, validationMs: 1_200, totalMs: 57_900 },
      bytes: 157 * 1024 * 1024, durationSec: 596.5, width: 1920, height: 1080, codec: "h264",
    });
    expect(ok).toBe(
      "[YouTubeApify] REPORT APIFY_TOTAL_TIME=57.9s ACTOR_WAIT=47.3s FILE_DOWNLOAD=8.1s VALIDATION=1.2s " +
        "FILE_SIZE=157.0MB VIDEO_DURATION=596.5s RESOLUTION=1920x1080 CODEC=h264 RESULT=PASS"
    );
    const wd = formatApifyTimingReport({ ok: false, failure: "WATCHDOG_TIMEOUT", summary: { actorWaitMs: null, fileDownloadMs: null, validationMs: null, totalMs: 2_700_000 } });
    expect(wd).toContain("APIFY_TOTAL_TIME=NOT MEASURED (watchdog)");
    expect(wd).toContain("RESULT=FAIL(WATCHDOG_TIMEOUT)");
  });

  it("the live test runs in measurement mode", () => {
    const src = fs.readFileSync(path.join(__dirname, "apifyLiveTest.ts"), "utf8");
    expect(src).toContain("deadlineMs: null,");
  });
});
