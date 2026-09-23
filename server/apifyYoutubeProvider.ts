/**
 * APIFY AS A YOUTUBE ACQUISITION PROVIDER — ONE VIDEO IN, ONE VALIDATED LOCAL FILE OUT. RONDE 644.
 *
 * ── What is verified, and from where ────────────────────────────────────────────────────────
 *
 * The run API is Apify's own, read from its official OpenAPI source (apify/apify-docs):
 *
 *   POST /v2/acts/{actor}/runs?timeout=&maxTotalChargeUsd=      body = the actor's input → { data: Run }
 *   GET  /v2/actor-runs/{runId}?waitForFinish=≤60               → { data: Run }
 *        Run.status ∈ READY RUNNING SUCCEEDED FAILED TIMING-OUT TIMED-OUT ABORTING ABORTED
 *        Run.defaultDatasetId, Run.defaultKeyValueStoreId, Run.startedAt, Run.finishedAt, Run.usageTotalUsd
 *   GET  /v2/datasets/{id}/items?clean=1&format=json            → the run's output rows
 *   GET  /v2/key-value-stores/{id}/keys                         → { data: { items: [{ key, size, recordPublicUrl }] } }
 *   GET  /v2/key-value-stores/{id}/records/{key}                → the raw record, its own Content-Type
 *
 * The ACTOR'S input fields are not assumed at all: `buildActorInput` is handed the schema the
 * actor's current build declares (read live, see apifySchemaProbe.ts) and sets only fields that
 * schema contains, with values its enums allow. A required field it cannot fill is a named failure,
 * never a guess.
 *
 * The OUTPUT fields were read from the same build (worker log, 2026-09-23 19:13, build 1.0.30):
 *
 *     title, videoId, quality, format, durationSeconds, fileSizeBytes, proxyCountry, status,
 *     downloadUrl, uploader, viewCount, paidMegabytes, originalUrl, kvStoreKey, failureCode,
 *     failureStages, error
 *
 * So the FILE is the record the row names in `kvStoreKey`, in the run's own key-value store; only
 * when a row names none is the store's largest record taken instead. Either way it counts only once
 * ffprobe and a decoded frame say it is a video. A row carrying `failureCode` or `error` is the
 * actor's own refusal and is reported as such.
 *
 * ── What it never does ──────────────────────────────────────────────────────────────────────
 *
 * Print the token. It travels in an Authorization header; URLs and log lines never carry it.
 * Call a result a success because Apify said SUCCEEDED: success is a file on disk that passed
 * `validateAcquiredFile`, the same boundary every other route crosses.
 */
import fs from "fs";
import { APIFY_YOUTUBE_ACTOR, describeInputSchema, type SchemaField } from "./apifySchemaProbe";
import type { AcquiredFileVerdict } from "./youtubeAcquisitionValidation";

const API = "https://api.apify.com/v2";

export type ApifyFailureClass =
  | "APIFY_DISABLED"
  | "APIFY_NO_TOKEN"
  | "APIFY_SCHEMA_UNSUPPORTED"
  | "APIFY_HTTP_ERROR"
  | "APIFY_RUN_FAILED"
  | "APIFY_TIMEOUT"
  | "APIFY_NO_FILE"
  | "APIFY_FILE_DOWNLOAD_FAILED"
  | "APIFY_INVALID_FILE"
  /**
   * Measurement mode only: the safety watchdog fired. This is NOT an acquisition time — it says a
   * request or the run hung far past anything normal, and the number must not be used as data.
   */
  | "WATCHDOG_TIMEOUT";

/** Every instant is MEASURED on this worker's clock; Apify's own timestamps are kept beside them. */
export type ApifyTiming = {
  startedAt: number;
  runCreatedAt: number | null;
  runFinishedAt: number | null;
  fileDownloadStartedAt: number | null;
  fileDownloadFinishedAt: number | null;
  validationStartedAt: number | null;
  validationFinishedAt: number | null;
  /** Apify's own view of the run, when it reported one. */
  apifyRunStartedAt: string | null;
  apifyRunFinishedAt: string | null;
};

export type ApifyTimingSummary = {
  providerWaitMs: number | null;
  /** From the run being created to Apify reporting it finished: the actor's own working time, as we waited for it. */
  actorWaitMs: number | null;
  fileDownloadMs: number | null;
  validationMs: number | null;
  totalMs: number;
};

export function summariseTiming(t: ApifyTiming, endedAt: number): ApifyTimingSummary {
  const span = (a: number | null, b: number | null) => (a != null && b != null ? b - a : null);
  return {
    providerWaitMs: span(t.startedAt, t.runFinishedAt),
    actorWaitMs: span(t.runCreatedAt, t.runFinishedAt),
    fileDownloadMs: span(t.fileDownloadStartedAt, t.fileDownloadFinishedAt),
    validationMs: span(t.validationStartedAt, t.validationFinishedAt),
    /** TOTAL TIME TO USABLE MP4: the timer stops when validation does, when it got that far. */
    totalMs: (t.validationFinishedAt ?? endedAt) - t.startedAt,
  };
}

export type ApifyAcquisition =
  | {
      ok: true;
      provider: "apify";
      videoId: string;
      sourceUrl: string;
      runId: string;
      filePath: string;
      bytes: number;
      durationSec: number;
      width: number;
      height: number;
      codec: string | null;
      fps: number | null;
      requestedQuality: string | null;
      usageTotalUsd: number | null;
      datasetFields: string[];
      timing: ApifyTiming;
      summary: ApifyTimingSummary;
    }
  | {
      ok: false;
      provider: "apify";
      videoId: string;
      failure: ApifyFailureClass;
      detail: string;
      runId: string | null;
      usageTotalUsd: number | null;
      timing: ApifyTiming;
      summary: ApifyTimingSummary;
    };

/* ═══════════════════════ configuration — presence only, never values ═══════════════════════ */

/** On unless YOUTUBE_APIFY_ENABLED=false. It also needs APIFY_API_TOKEN. */
export function apifyYoutubeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUTUBE_APIFY_ENABLED?.trim() !== "false";
}

export function apifyToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.APIFY_API_TOKEN?.trim() || undefined;
}

/** Hard cap on what one run may cost. Bounded; default well above a single ~10-minute video. */
export function apifyMaxChargeUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.YOUTUBE_APIFY_MAX_CHARGE_USD ?? "");
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : 1;
}

/** Largest source file accepted, in MB. A whole video, so far above the 80 MB per-clip ceiling. */
export function apifyMaxSourceBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.YOUTUBE_APIFY_MAX_SOURCE_MB ?? "", 10);
  return (Number.isFinite(n) && n >= 10 && n <= 4096 ? n : 1024) * 1024 * 1024;
}

/* ═══════════════════════ input: only what the actor's schema declares ═══════════════════════ */

export type ActorInputPlan =
  | { ok: true; input: Record<string, unknown>; quality: string | null; unset: string[] }
  | { ok: false; detail: string };

/**
 * The actor input for one video, from the schema its current build declares.
 *
 * Every field set here is one the schema names, with a value its enum admits. The URL list is the
 * one field that must exist; everything else is a preference applied only when available.
 */
export function buildActorInput(
  schema: readonly SchemaField[],
  videoUrl: string,
  wanted: { quality: string; format?: string; residentialProxyMode?: string }
): ActorInputPlan {
  const byName = new Map(schema.map((f) => [f.name, f]));
  const urls = byName.get("urls");
  if (!urls) {
    return { ok: false, detail: `the actor's schema has no "urls" field (fields: ${schema.map((f) => f.name).join(",") || "none"})` };
  }
  const input: Record<string, unknown> = { urls: urls.type === "array" ? [videoUrl] : videoUrl };
  const admits = (f: SchemaField | undefined, v: string) =>
    !!f && (!f.enumValues || f.enumValues.map(String).includes(v));

  /** Quality: the wanted one if the enum admits it, else the highest admitted numeric value below it. */
  let quality: string | null = null;
  const q = byName.get("quality");
  if (q) {
    if (admits(q, wanted.quality)) quality = wanted.quality;
    else if (q.enumValues) {
      const cap = Number.parseInt(wanted.quality, 10);
      const numeric = q.enumValues
        .map(String)
        .filter((v) => /^\d+$/.test(v) && Number.parseInt(v, 10) <= cap)
        .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
      quality = numeric[0] ?? null;
    }
    if (quality != null) input.quality = quality;
  }
  if (wanted.format && admits(byName.get("format"), wanted.format)) input.format = wanted.format;
  if (wanted.residentialProxyMode && admits(byName.get("residentialProxyMode"), wanted.residentialProxyMode)) {
    input.residentialProxyMode = wanted.residentialProxyMode;
  }
  const unset = schema.filter((f) => f.required && !(f.name in input) && f.defaultValue === undefined).map((f) => f.name);
  if (unset.length > 0) {
    return { ok: false, detail: `required actor field(s) this adapter cannot fill: ${unset.join(",")}` };
  }
  return { ok: true, input, quality, unset: [] };
}

/* ═══════════════════════ the file: the run's own storage, proven by ffprobe ═══════════════════════ */

export type KvKey = { key: string; size?: number; recordPublicUrl?: string };

/** The run's largest record — the only candidate for "the video". Proven or refused downstream. */
export function pickVideoRecord(keys: readonly KvKey[], minBytes = 10_000): KvKey | null {
  const candidates = keys
    .filter((k) => k.key !== "INPUT" && (k.size ?? 0) >= minBytes)
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  return candidates[0] ?? null;
}

/** Terminal statuses, from ActorJobStatus. Anything else is still going. */
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

/* ═══════════════════════ the provider ═══════════════════════ */

export type ApifyHttp = (
  method: "GET" | "POST",
  url: string,
  init: { headers: Record<string, string>; body?: string }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export type ApifyDeps = {
  http: ApifyHttp;
  /** Streams a URL to a file; returns bytes written or null. The pipeline's own streaming helper. */
  downloadTo: (url: string, headers: Record<string, string>, outPath: string, maxBytes: number, timeoutMs: number) => Promise<number | null>;
  /** The live input schema of the actor's current build. */
  inputSchema: () => Promise<SchemaField[]>;
  validate: (filePath: string) => Promise<AcquiredFileVerdict>;
  /** codec and fps, which the shared validation does not report. */
  streamDetails: (filePath: string) => Promise<{ codec: string | null; fps: number | null }>;
  now: () => number;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

type Run = {
  id?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string | null;
  defaultDatasetId?: string;
  defaultKeyValueStoreId?: string;
  usageTotalUsd?: number | null;
  statusMessage?: string;
};

export async function acquireYoutubeVideoViaApify(
  req: {
    videoId: string;
    quality: string;
    outPath: string;
    /**
     * FastVid's acquisition deadline, or NULL for measurement mode: no deadline of ours, and no
     * `timeout` sent to Apify — the run ends when the actor finishes or Apify reports a failure.
     */
    deadlineMs: number | null;
    /** Measurement mode's only limit: a hang guard far above any normal run. Not a timeout. */
    watchdogMs?: number;
    token: string | undefined;
    enabled: boolean;
  },
  deps: ApifyDeps
): Promise<ApifyAcquisition> {
  const timing: ApifyTiming = {
    startedAt: deps.now(),
    runCreatedAt: null,
    runFinishedAt: null,
    fileDownloadStartedAt: null,
    fileDownloadFinishedAt: null,
    validationStartedAt: null,
    validationFinishedAt: null,
    apifyRunStartedAt: null,
    apifyRunFinishedAt: null,
  };
  const sourceUrl = `https://www.youtube.com/watch?v=${req.videoId}`;
  let runId: string | null = null;
  let usageTotalUsd: number | null = null;
  const fail = (failure: ApifyFailureClass, detail: string): ApifyAcquisition => {
    const out: ApifyAcquisition = {
      ok: false, provider: "apify", videoId: req.videoId, failure, detail: detail.slice(0, 300),
      runId, usageTotalUsd, timing, summary: summariseTiming(timing, deps.now()),
    };
    deps.log(
      `[YouTubeApify] FAILED videoId=${req.videoId} runId=${runId ?? "none"} class=${failure} ` +
        `totalMs=${out.summary.totalMs} detail=${out.detail}`
    );
    return out;
  };

  if (!req.enabled) return fail("APIFY_DISABLED", "YOUTUBE_APIFY_ENABLED=false");
  if (!req.token) return fail("APIFY_NO_TOKEN", "APIFY_API_TOKEN=MISSING");
  const auth = { Authorization: `Bearer ${req.token}` };
  const measuring = req.deadlineMs == null;
  const limitMs = measuring ? req.watchdogMs ?? 45 * 60_000 : req.deadlineMs!;
  const remaining = () => limitMs - (deps.now() - timing.startedAt);
  /** Which limit was hit: a deadline is a verdict, the watchdog is only a hang guard. */
  const outOfTime = (detail: string) =>
    measuring
      ? fail("WATCHDOG_TIMEOUT", `${detail} — safety watchdog (${limitMs}ms), NOT a measured acquisition time`)
      : fail("APIFY_TIMEOUT", detail);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  deps.log(`[YouTubeApify] START videoId=${req.videoId} quality=${req.quality} actor=${APIFY_YOUTUBE_ACTOR} ${measuring ? `mode=measure watchdogMs=${limitMs}` : `deadlineMs=${limitMs}`}`);

  const schema = await deps.inputSchema().catch(() => [] as SchemaField[]);
  const plan = buildActorInput(schema, sourceUrl, { quality: req.quality, format: "video", residentialProxyMode: "fallback" });
  if (!plan.ok) return fail("APIFY_SCHEMA_UNSUPPORTED", plan.detail);

  /* 1 — start the run. Its own timeout is our deadline, so an abandoned run does not keep billing. */
  /** Measurement mode sends no timeout: Apify's own run limit is not ours to shorten. */
  const runTimeoutParam = measuring ? "" : `timeout=${Math.max(30, Math.ceil(limitMs / 1000))}&`;
  let run: Run;
  try {
    const resp = await deps.http(
      "POST",
      `${API}/acts/${APIFY_YOUTUBE_ACTOR}/runs?${runTimeoutParam}maxTotalChargeUsd=${apifyMaxChargeUsd()}`,
      { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(plan.input) }
    );
    if (resp.status !== 201 && resp.status !== 200) return fail("APIFY_HTTP_ERROR", `start run http_${resp.status}`);
    run = ((await resp.json()) as { data?: Run }).data ?? {};
  } catch (err) {
    return fail("APIFY_HTTP_ERROR", `start run threw: ${(err as Error).message}`);
  }
  runId = run.id ?? null;
  timing.runCreatedAt = deps.now();
  deps.log(
    `[YouTubeApify] RUN_STARTED videoId=${req.videoId} runId=${runId ?? "none"} ` +
      `input=${Object.keys(plan.input).join(",")} quality=${plan.quality ?? "actor_default"} ` +
      `createMs=${timing.runCreatedAt - timing.startedAt}`
  );
  if (!runId) return fail("APIFY_HTTP_ERROR", "start run returned no run id");

  /* 2 — wait, in Apify's own long-poll steps of at most 60 s, never past our deadline. */
  while (!TERMINAL.has(run.status ?? "")) {
    const left = remaining();
    if (left <= 0) return outOfTime(`run still ${run.status ?? "unknown"} after ${limitMs}ms`);
    const waitSec = Math.max(1, Math.min(60, Math.floor(left / 1000)));
    try {
      const resp = await deps.http("GET", `${API}/actor-runs/${runId}?waitForFinish=${waitSec}`, { headers: auth });
      if (resp.status !== 200) {
        await sleep(2_000);
        continue;
      }
      run = ((await resp.json()) as { data?: Run }).data ?? run;
    } catch {
      await sleep(2_000);
    }
  }
  timing.runFinishedAt = deps.now();
  timing.apifyRunStartedAt = run.startedAt ?? null;
  timing.apifyRunFinishedAt = run.finishedAt ?? null;
  usageTotalUsd = typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null;
  if (run.status === "TIMED-OUT") return fail("APIFY_TIMEOUT", `the run timed out on Apify (${run.statusMessage ?? "no message"})`);
  if (run.status !== "SUCCEEDED") return fail("APIFY_RUN_FAILED", `run ${run.status}: ${run.statusMessage ?? "no message"}`);

  /* 3 — the dataset row: the actor's own verdict, the exact record key, and its field names. */
  let datasetFields: string[] = [];
  let namedKey: string | null = null;
  if (run.defaultDatasetId) {
    try {
      const resp = await deps.http("GET", `${API}/datasets/${run.defaultDatasetId}/items?clean=1&format=json`, { headers: auth });
      const items = resp.status === 200 ? ((await resp.json()) as Array<Record<string, unknown>>) : [];
      const first = Array.isArray(items) ? items[0] : undefined;
      if (first) {
        datasetFields = Object.keys(first).sort();
        deps.log(`[YouTubeApify] OUTPUT_FIELDS videoId=${req.videoId} runId=${runId} fields=${datasetFields.join(",")}`);
        const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
        const failureCode = text(first.failureCode);
        const error = text(first.error);
        if (failureCode || error) {
          return fail("APIFY_RUN_FAILED", `actor status=${text(first.status) ?? "?"} failureCode=${failureCode ?? "none"} error=${error ?? "none"}`);
        }
        namedKey = text(first.kvStoreKey);
      }
    } catch {
      /* the row is context; the file below is the evidence */
    }
  }

  /* 4 — the file: the run's largest stored record. */
  if (!run.defaultKeyValueStoreId) return fail("APIFY_NO_FILE", "run has no key-value store");
  let record: KvKey | null = null;
  try {
    const resp = await deps.http("GET", `${API}/key-value-stores/${run.defaultKeyValueStoreId}/keys?limit=1000`, { headers: auth });
    const data = resp.status === 200 ? ((await resp.json()) as { data?: { items?: KvKey[] } }).data : undefined;
    const items = data?.items ?? [];
    /** The key the actor named, when it is actually in the store; otherwise the largest record. */
    record = (namedKey ? items.find((k) => k.key === namedKey) : undefined) ?? pickVideoRecord(items);
  } catch (err) {
    return fail("APIFY_HTTP_ERROR", `list store keys threw: ${(err as Error).message}`);
  }
  if (!record) return fail("APIFY_NO_FILE", "no stored record large enough to be a video");

  timing.fileDownloadStartedAt = deps.now();
  const recordUrl = `${API}/key-value-stores/${run.defaultKeyValueStoreId}/records/${encodeURIComponent(record.key)}`;
  let bytes: number | null = null;
  try {
    bytes = await deps.downloadTo(recordUrl, auth, req.outPath, apifyMaxSourceBytes(), Math.max(30_000, remaining()));
    if (!bytes && remaining() <= 0) return outOfTime("record download still running");
  } catch (err) {
    return fail("APIFY_FILE_DOWNLOAD_FAILED", `record download threw: ${(err as Error).message}`);
  }
  timing.fileDownloadFinishedAt = deps.now();
  if (!bytes || !fs.existsSync(req.outPath)) return fail("APIFY_FILE_DOWNLOAD_FAILED", `record ${record.key} arrived empty`);
  deps.log(
    `[YouTubeApify] FILE_READY videoId=${req.videoId} runId=${runId} record=${record.key} bytes=${bytes} ` +
      `providerMs=${(timing.runFinishedAt ?? 0) - timing.startedAt} downloadMs=${timing.fileDownloadFinishedAt - timing.fileDownloadStartedAt}`
  );

  /* 5 — the same boundary every route crosses. SUCCEEDED is Apify's word; this is ours. */
  timing.validationStartedAt = deps.now();
  const verdict = await deps.validate(req.outPath);
  const details = verdict.ok ? await deps.streamDetails(req.outPath).catch(() => ({ codec: null, fps: null })) : { codec: null, fps: null };
  timing.validationFinishedAt = deps.now();
  if (!verdict.ok) {
    try { fs.unlinkSync(req.outPath); } catch { /* already gone */ }
    return fail("APIFY_INVALID_FILE", `${verdict.code}: ${verdict.detail}`);
  }
  const summary = summariseTiming(timing, deps.now());
  deps.log(
    `[YouTubeApify] VALIDATED videoId=${req.videoId} runId=${runId} bytes=${bytes} durationSec=${verdict.durationSec.toFixed(1)} ` +
      `resolution=${verdict.width}x${verdict.height} codec=${details.codec ?? "?"} fps=${details.fps ?? "?"} ` +
      `actorWaitMs=${summary.actorWaitMs} providerWaitMs=${summary.providerWaitMs} fileDownloadMs=${summary.fileDownloadMs} ` +
      `validationMs=${summary.validationMs} totalMs=${summary.totalMs} usageUsd=${usageTotalUsd ?? "?"}`
  );
  return {
    ok: true, provider: "apify", videoId: req.videoId, sourceUrl, runId, filePath: req.outPath, bytes,
    durationSec: verdict.durationSec, width: verdict.width, height: verdict.height,
    codec: details.codec, fps: details.fps, requestedQuality: plan.quality, usageTotalUsd, datasetFields, timing, summary,
  };
}

/* ═══════════════════════ production wiring ═══════════════════════ */

let cachedSchema: SchemaField[] | null = null;

export async function productionApifyDeps(token: string): Promise<ApifyDeps> {
  const pipeline = await import("./videoPipeline");
  const { validateAcquiredFile } = await import("./youtubeAcquisitionValidation");
  const { extractFrameAtFraction } = await import("./localClipVision");
  const { execFile } = await import("child_process");
  const auth = { Authorization: `Bearer ${token}` };
  return {
    http: async (method, url, init) => {
      const r = await fetch(url, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(90_000) });
      return { status: r.status, json: () => r.json() };
    },
    downloadTo: async (url, headers, outPath, maxBytes, timeoutMs) => {
      const { response, bytesWritten } = await pipeline.downloadToFileStreaming(
        url, outPath, timeoutMs, "Apify YouTube record", { headers }, maxBytes
      );
      return response.ok ? bytesWritten : null;
    },
    inputSchema: async () => {
      if (cachedSchema) return cachedSchema;
      const r = await fetch(`${API}/acts/${APIFY_YOUTUBE_ACTOR}/builds/default`, { headers: auth, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return [];
      const build = ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
      const def = build.actorDefinition as Record<string, unknown> | undefined;
      cachedSchema = describeInputSchema(build.inputSchema ?? def?.input);
      return cachedSchema;
    },
    validate: (p) =>
      validateAcquiredFile(p, 2, {
        probe: async (f) => {
          const meta = await pipeline.probeVideoStreamMeta(f);
          if (!meta || meta.durationSec > 0) return meta;
          return { ...meta, durationSec: await pipeline.probeVideoDurationSec(f) };
        },
        decodeFrame: async (f) => {
          const framePath = `${f}.validate.jpg`;
          try {
            return await extractFrameAtFraction(f, framePath, 0.5);
          } finally {
            try { fs.unlinkSync(framePath); } catch { /* none written */ }
          }
        },
      }),
    streamDetails: (f) =>
      new Promise((resolve) => {
        execFile(
          process.env.FFPROBE_BIN || "ffprobe",
          ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,avg_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", f],
          { timeout: 15_000 },
          (err, stdout) => {
            if (err) return resolve({ codec: null, fps: null });
            const [codec, rate] = String(stdout).trim().split("\n");
            const [n, d] = (rate ?? "").split("/").map(Number);
            resolve({ codec: codec || null, fps: n && d ? Number((n / d).toFixed(2)) : null });
          }
        );
      }),
    now: () => Date.now(),
    log: (l) => console.log(l),
  };
}
