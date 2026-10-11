import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFileSync } from "child_process";
import type { AddressInfo } from "net";

/**
 * TUNELIO FIRST, THE OWN yt-dlp SERVICE AS FALLBACK — the order inside `downloadYouTubeCCClip`.
 *
 * The Tunelio module is replaced by a scripted double (no network, no credits); the cloud service
 * is a local HTTP server that records every hit. What is asserted is the ORDER and the HAND-OFF:
 * a Tunelio source becomes the beat's clip through the same cut + validation, and anything
 * Tunelio cannot deliver — a refusal, an exception, a switched-off route — reaches the cloud
 * service exactly as before.
 */
const tunelio = vi.hoisted(() => ({
  acquire: vi.fn(),
  enabled: vi.fn(() => true),
}));
vi.mock("./tunelioDownloader", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tunelioDownloader")>();
  return {
    ...real,
    acquireTunelioSource: (...args: unknown[]) => tunelio.acquire(...args),
    tunelioEnabled: () => tunelio.enabled(),
  };
});

import { downloadYouTubeCCClip } from "./videoPipeline";

let dir: string;
let server: http.Server;
let cloudHits: string[];
/** A fresh id per test: the download layer remembers a refused video for the rest of the process. */
let testSeq = 0;
let videoId = "tuneTest0000";

function realMp4(seconds: number, out: string, withAudio = true): string {
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=s=640x360:r=25:d=${seconds}`];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "400k");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  execFileSync("ffmpeg", args);
  return out;
}

function startCloud(handler: http.RequestListener): Promise<void> {
  server = http.createServer((req, res) => {
    /** Only the transfer itself counts; the cloud route's egress preflight (/health/egress) is not a download. */
    if ((req.url ?? "").startsWith("/download")) cloudHits.push(req.url ?? "");
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      process.env.YOUTUBE_CC_DL_SERVICE = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunelio-route-"));
  cloudHits = [];
  testSeq += 1;
  videoId = `tuneTest${String(testSeq).padStart(4, "0")}`;
  tunelio.acquire.mockReset();
  tunelio.enabled.mockReset();
  tunelio.enabled.mockReturnValue(true);
  process.env.TUNELIO_API_KEY = "tk_route_test";
  process.env.TUNELIO_ENABLED = "true";
});
afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.YOUTUBE_CC_DL_SERVICE;
  delete process.env.TUNELIO_API_KEY;
  delete process.env.TUNELIO_ENABLED;
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const servesCloudClip = (): http.RequestListener => (_req, res) => {
  const clip = fs.readFileSync(realMp4(5, path.join(dir, "cloud.mp4")));
  res.writeHead(200, { "content-type": "video/mp4", "content-length": String(clip.length) });
  res.end(clip);
};

describe("Tunelio first", () => {
  it("a Tunelio source is cut to the beat's window, validated and renamed onto outPath; the cloud service is never asked", async () => {
    const source = realMp4(20, path.join(dir, "source.mp4"));
    tunelio.acquire.mockResolvedValue({ ok: true, path: source, bytes: fs.statSync(source).size, durationSec: 20, width: 640, height: 360, cached: false });
    await startCloud(servesCloudClip());
    const outPath = path.join(dir, "beat.mp4");
    const outcome: { status?: string; reason?: string; transferStarted?: boolean } = {};
    const ok = await downloadYouTubeCCClip(videoId, 4, 6, outPath, 0, "Test video", undefined, true, outcome as never, undefined, undefined, false);
    expect(ok).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(10_000);
    expect(outcome.status).toBe("DOWNLOAD_SUCCESS");
    expect(outcome.reason).toBe("tunelio");
    expect(outcome.transferStarted).toBe(true);
    expect(cloudHits).toEqual([]);
    expect(fs.existsSync(outPath.replace(/\.mp4$/, "_tunelio_tmp.mp4"))).toBe(false);
    /** The cut is about the window asked for, not the whole source. */
    const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outPath], { encoding: "utf8" });
    expect(Number(dur)).toBeGreaterThan(3.5);
    expect(Number(dur)).toBeLessThan(5);
    const [args] = tunelio.acquire.mock.calls[0] as [string, unknown, { timeoutMs: number }];
    expect(args).toBe(videoId);
  });

  it("when Tunelio refuses, the cloud service is asked and delivers exactly as before", async () => {
    tunelio.acquire.mockResolvedValue({ ok: false, code: "INSUFFICIENT_CREDITS", detail: "balance 4 < 10", paid: false });
    await startCloud(servesCloudClip());
    const outPath = path.join(dir, "beat.mp4");
    const outcome: { status?: string; reason?: string } = {};
    const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video", undefined, true, outcome as never, undefined, undefined, false);
    expect(ok).toBe(true);
    expect(cloudHits.length).toBe(1);
    expect(cloudHits[0]).toContain(`/download?id=${videoId}`);
    expect(outcome.status).toBe("DOWNLOAD_SUCCESS");
    expect(outcome.reason).toBe("cloud_service");
  });

  it("when Tunelio throws, the pipeline does not crash and the cloud service is asked", async () => {
    tunelio.acquire.mockRejectedValue(new Error("boom https://secret.example/x Bearer abc"));
    await startCloud(servesCloudClip());
    const outPath = path.join(dir, "beat.mp4");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video", undefined, true, undefined, undefined, undefined, false);
      expect(ok).toBe(true);
      expect(cloudHits.length).toBe(1);
      const text = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(text).toContain("Tunelio route threw");
    } finally {
      warn.mockRestore();
    }
  });

  it("when both fail, the exit line names both attempts and the function returns false", async () => {
    tunelio.acquire.mockResolvedValue({ ok: false, code: "RATE_LIMITED", detail: "create http 429", paid: false });
    await startCloud((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Video unavailable" }));
    });
    const outPath = path.join(dir, "beat.mp4");
    const outcome: { status?: string; reason?: string } = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = await downloadYouTubeCCClip(videoId, 5, 0, outPath, 0, "Test video", undefined, true, outcome as never, undefined, undefined, false);
      expect(ok).toBe(false);
      expect(fs.existsSync(outPath)).toBe(false);
      expect(outcome.status).not.toBe("DOWNLOAD_SUCCESS");
      expect(outcome.reason).toContain("tunelio=rate_limited");
      expect(outcome.reason).toContain("cloud=");
    } finally {
      warn.mockRestore();
    }
  });

  it("an unusable Tunelio source (no video) is refused by the cut's own validation and the cloud service takes over", async () => {
    const audioOnly = path.join(dir, "audio-only.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:a", "aac", audioOnly]);
    tunelio.acquire.mockResolvedValue({ ok: true, path: audioOnly, bytes: fs.statSync(audioOnly).size, durationSec: 10, width: 1280, height: 720, cached: false });
    await startCloud(servesCloudClip());
    const outPath = path.join(dir, "beat.mp4");
    const outcome: { status?: string; reason?: string } = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = await downloadYouTubeCCClip(videoId, 4, 0, outPath, 0, "Test video", undefined, true, outcome as never, undefined, undefined, false);
      expect(ok).toBe(true);
      expect(cloudHits.length).toBe(1);
      expect(outcome.reason).toBe("cloud_service");
    } finally {
      warn.mockRestore();
    }
    expect(fs.existsSync(outPath.replace(/\.mp4$/, "_tunelio_tmp.mp4"))).toBe(false);
  });

  it("with the route switched off, Tunelio is never asked", async () => {
    tunelio.enabled.mockReturnValue(false);
    await startCloud(servesCloudClip());
    const ok = await downloadYouTubeCCClip(videoId, 5, 0, path.join(dir, "beat.mp4"), 0, "Test video", undefined, true, undefined, undefined, undefined, false);
    expect(ok).toBe(true);
    expect(tunelio.acquire).not.toHaveBeenCalled();
    expect(cloudHits.length).toBe(1);
  });

  it("with the real switch: a key WITHOUT TUNELIO_ENABLED=true goes straight to the cloud route", async () => {
    const real = await vi.importActual<typeof import("./tunelioDownloader")>("./tunelioDownloader");
    tunelio.enabled.mockImplementation(() => real.tunelioEnabled());
    await startCloud(servesCloudClip());
    const values = [undefined, "", "false", "1", "yes"];
    for (const [i, value] of values.entries()) {
      if (value === undefined) delete process.env.TUNELIO_ENABLED;
      else process.env.TUNELIO_ENABLED = value;
      /** a fresh video per value: the pipeline remembers a video it already fetched this render */
      const out = path.join(dir, `beat_${i}.mp4`);
      const ok = await downloadYouTubeCCClip(`${videoId}${i}`, 5, 0, out, 0, "Test video", undefined, true, undefined, undefined, undefined, false);
      expect(ok, `TUNELIO_ENABLED=${String(value)}`).toBe(true);
      expect(tunelio.acquire, `TUNELIO_ENABLED=${String(value)}`).not.toHaveBeenCalled();
    }
    expect(cloudHits.length).toBe(5);
    /** and exactly "true" opens the route */
    process.env.TUNELIO_ENABLED = "true";
    tunelio.acquire.mockResolvedValue({ ok: false, code: "COOLDOWN", detail: "test", paid: false });
    await downloadYouTubeCCClip(`${videoId}T`, 5, 0, path.join(dir, "beat_true.mp4"), 0, "Test video", undefined, true, undefined, undefined, undefined, false);
    expect(tunelio.acquire).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("a caller that named the cloud route (onlyRoute) skips Tunelio", async () => {
    await startCloud(servesCloudClip());
    const ok = await downloadYouTubeCCClip(videoId, 5, 0, path.join(dir, "beat.mp4"), 0, "Test video", undefined, true, undefined, undefined, "cloud", false);
    expect(ok).toBe(true);
    expect(tunelio.acquire).not.toHaveBeenCalled();
    expect(cloudHits.length).toBe(1);
  });
});

describe("wiring, pinned in the source", () => {
  const vp = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("the attempt type knows both routes and Tunelio is asked before the cloud route", () => {
    expect(vp).toContain('route: "cloud" | "tunelio";');
    const fn = vp.indexOf("export async function downloadYouTubeCCClip(");
    const tunelioBlock = vp.indexOf("if (!onlyRoute && tunelioEnabled()) {", fn);
    const cloudBlock = vp.indexOf("// F3-41: cloud/yt-dlp service tried FIRST", fn);
    expect(tunelioBlock).toBeGreaterThan(fn);
    expect(cloudBlock).toBeGreaterThan(tunelioBlock);
  });

  it("the transfer of the signed URL carries no Authorization header and refuses redirects", () => {
    const deps = vp.slice(vp.indexOf("function productionTunelioDeps("), vp.indexOf("export function tunelioStatusFor("));
    expect(deps).toContain('{ redirect: "manual" }');
    expect(deps).not.toContain("Authorization");
    expect(deps).not.toContain("TUNELIO_API_KEY");
  });

  it("the paid call is claimed across replicas in the existing worker_once_claims table", () => {
    const deps = vp.slice(vp.indexOf("function productionTunelioDeps("), vp.indexOf("export function tunelioStatusFor("));
    expect(deps).toContain("claimCreate: async (claimKey) => {");
    expect(deps).toContain("db.insert(workerOnceClaims).ignore().values({ claimKey, holder })");
    expect(deps).toContain("return affectedRowCount(result) === 1;");
    const mod = fs.readFileSync(path.join(__dirname, "tunelioDownloader.ts"), "utf8");
    /** the claim sits between the balance check and the one paid call */
    const balance = mod.indexOf("if (state.credits.value < TUNELIO_CREATE_COST) {");
    const claim = mod.indexOf("won = await deps.claimCreate(tunelioCreateClaimKey(videoId, now()));");
    const create = mod.indexOf("state.stats.createCalls++;");
    expect(balance).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(balance);
    expect(create).toBeGreaterThan(claim);
  });

  it("a Tunelio refusal is never counted as more than a route that did not deliver", () => {
    expect(vp).toContain('return code === "TIMEOUT" ? "DOWNLOAD_TIMEOUT" : "DOWNLOAD_FAILED";');
    const unusable = fs.readFileSync(path.join(__dirname, "youtubeUnusableVideos.ts"), "utf8");
    expect(unusable).toContain('if (a.route !== "cloud") continue;');
  });

  it("the Tunelio cut passes the same validation as the cloud route", () => {
    const fn = vp.slice(vp.indexOf("if (!onlyRoute && tunelioEnabled()) {"), vp.indexOf("// F3-41: cloud/yt-dlp service tried FIRST"));
    expect(fn).toContain("await validateAcquiredFile(tunelioTmpPath, duration, {");
    expect(fn).toContain("fs.renameSync(tunelioTmpPath, outPath);");
    expect(fn).toContain('reportDownload("DOWNLOAD_SUCCESS", "tunelio");');
    expect(fn).toContain("if (fs.existsSync(tunelioTmpPath)) fs.unlinkSync(tunelioTmpPath);");
  });
});
