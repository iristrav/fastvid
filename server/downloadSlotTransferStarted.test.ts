import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

/**
 * SLOT FIX — A SLOT IS RETURNED ONLY WHEN NO TRANSFER STARTED.
 *
 * `transferStarted` was set only on the RapidAPI branch and went with it (799fa6b). Since then every
 * failed cloud transfer reported `transferStarted=false`, so the caller holding the render's download
 * slot (`fetchYouTubeCCClips`: `if (!ok && dl.transferStarted === false) releaseYoutubeDownloadSlot`)
 * handed every failed transfer's slot back, and a run of refusals could ask the service far past the
 * ceiling. The streamer now reports the moment the request leaves (`onRequestStart`).
 *
 * The caller's rule is pinned as source by `youtubeDownloadSlotsBuyTransfers.test.ts`; here it is
 * applied exactly as written, around the real `downloadYouTubeCCClip`, with the service faked.
 */

type VP = typeof import("./videoPipeline");
type PF = typeof import("./providerFailureClass");
let vp: VP;
let pf: PF;
let dir: string;
const SERVICE = "https://slot-test-cloud.example.com";
beforeAll(async () => {
  vp = await import("./videoPipeline");
  pf = await import("./providerFailureClass");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-slot-"));
}, 60_000);

const ORIGINAL_ENV = { ...process.env };
let downloadsAsked: string[];
let serviceAnswer: (url: string) => unknown;
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.YOUTUBE_CC_DL_SERVICE = SERVICE;
  delete process.env.YOUTUBE_API_KEY;
  pf.resetPermanentDownloadRefusals();
  pf.resetCloudEgressBlocked();
  vp.resetYoutubeFragmentsFetched();
  downloadsAsked = [];
  nodeFetchMock.mockReset();
  nodeFetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("/download?")) {
      downloadsAsked.push(String(url));
      return serviceAnswer(String(url));
    }
    /** egress preflight and anything else: not answered */
    return { ok: false, status: 404, text: async () => "", json: async () => ({}), headers: { get: () => null } };
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const refused = (detail = "stream_refused") => ({
  ok: false,
  status: 502,
  text: async () => JSON.stringify({ detail }),
  headers: { get: () => null },
});

let n = 0;
/** One download exactly as `fetchYouTubeCCClips` does it: claim, fetch, return the slot only if nothing started. */
async function asTheCallerDoes(cache: ReturnType<VP["createSourcingCache"]>, max: number, videoId: string) {
  if (!vp.claimYoutubeDownloadSlot(cache, max)) return { claimed: false as const };
  const dl: { status?: string; reason?: string; transferStarted?: boolean } = {};
  const out = path.join(dir, `clip_${n++}.mp4`);
  const ok = await vp.downloadYouTubeCCClip(videoId, 4, 30, out, 0, "Some title", cache, true, dl as never, 20_000);
  let refunded = false;
  if (!ok && dl.transferStarted === false) refunded = vp.releaseYoutubeDownloadSlot(cache);
  return { claimed: true as const, ok, dl, refunded };
}
const spent = (cache: ReturnType<VP["createSourcingCache"]>) => vp.providerMetrics(cache, "youtube_cc");

describe("SLOT FIX — the download that never started gives its slot back", () => {
  it("the scene budget is below the download floor: the service is never asked, transferStarted=false, the slot comes back", async () => {
    const cache = vp.createSourcingCache(1);
    serviceAnswer = () => refused();
    const r = await vp.withSceneFetchTimeout(() => asTheCallerDoes(cache, 5, "budgetVid01"), 1_000, "slot test");
    expect(downloadsAsked).toEqual([]);
    expect(r.claimed && r.dl.transferStarted).toBe(false);
    expect(r.claimed && r.refunded).toBe(true);
    expect(spent(cache).downloadSlotsClaimed).toBe(0);
    expect(spent(cache).downloadSlotsRefunded).toBe(1);
  });

  it("the streamer refuses before the request leaves (URL already refused this render): not started, slot back", async () => {
    const cache = vp.createSourcingCache(2);
    serviceAnswer = () => refused();
    /** the exact URL the cloud branch will ask for */
    pf.notePermanentDownloadRefusal(`${SERVICE}/download?id=memoVideo01&duration=4&start=30`, "http_404");
    const r = await asTheCallerDoes(cache, 5, "memoVideo01");
    expect(downloadsAsked).toEqual([]);
    expect(r.claimed && r.dl.transferStarted).toBe(false);
    expect(spent(cache).downloadSlotsClaimed).toBe(0);
  });
});

describe("SLOT FIX — a transfer that started keeps its slot, whatever it answered", () => {
  it("started and refused (http 502): transferStarted=true, the slot is NOT returned", async () => {
    const cache = vp.createSourcingCache(3);
    serviceAnswer = () => refused("stream_refused");
    const r = await asTheCallerDoes(cache, 5, "refusedVid1");
    expect(downloadsAsked.length).toBe(1);
    expect(r.claimed && r.ok).toBe(false);
    expect(r.claimed && r.dl.transferStarted).toBe(true);
    expect(r.claimed && r.refunded).toBe(false);
    expect(spent(cache).downloadSlotsClaimed).toBe(1);
    expect(spent(cache).downloadSlotsRefunded).toBe(0);
  });

  it("started and timed out / threw: transferStarted=true, no refund — and no second refund ever", async () => {
    const cache = vp.createSourcingCache(4);
    serviceAnswer = () => {
      throw new Error("Timeout: YouTube CC cloud download scene 0 exceeded 20s");
    };
    const r = await asTheCallerDoes(cache, 5, "timeoutVid1");
    expect(downloadsAsked.length).toBe(1);
    expect(r.claimed && r.dl.status).toBe("DOWNLOAD_TIMEOUT");
    expect(r.claimed && r.dl.transferStarted).toBe(true);
    expect(spent(cache).downloadSlotsClaimed).toBe(1);
    /** a refund the caller does not make stays unmade; one it does make can never be made twice below zero */
    const empty = vp.createSourcingCache(5);
    expect(vp.releaseYoutubeDownloadSlot(empty)).toBe(false);
    expect(spent(empty).downloadSlotsClaimed).toBe(0);
  });

  it("a successful transfer: delivered, transferStarted=true, the slot stays spent", async () => {
    const cache = vp.createSourcingCache(6);
    const src = path.join(dir, "service_answer.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
    serviceAnswer = () => ({
      ok: true,
      status: 200,
      body: fs.createReadStream(src),
      headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? String(fs.statSync(src).size) : null) },
      text: async () => "",
    });
    const r = await asTheCallerDoes(cache, 5, "successVid1");
    expect(downloadsAsked.length).toBe(1);
    expect(r.claimed && r.dl.status).toBe("DOWNLOAD_SUCCESS");
    expect(r.claimed && r.ok).toBe(true);
    expect(r.claimed && r.dl.transferStarted).toBe(true);
    expect(r.claimed && r.refunded).toBe(false);
    expect(spent(cache).downloadSlotsClaimed).toBe(1);
  }, 60_000);
});

describe("SLOT FIX — a run of failed transfers cannot push past the ceiling", () => {
  it("ten videos all refused by the service, ceiling 4: the service is asked exactly 4 times", async () => {
    const cache = vp.createSourcingCache(7);
    serviceAnswer = () => refused("stream_refused");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await asTheCallerDoes(cache, 4, `runVideo00${i}`));
    expect(downloadsAsked.length).toBe(4);
    expect(results.filter((r) => r.claimed).length).toBe(4);
    expect(spent(cache).downloadSlotsClaimed).toBe(4);
    expect(spent(cache).downloadSlotsRefunded).toBe(0);
  });

  it("a mix: two never started (refund) and failures that started (no refund) — still never past the ceiling", async () => {
    const cache = vp.createSourcingCache(8);
    serviceAnswer = () => refused("bot_check_unused");
    pf.notePermanentDownloadRefusal(`${SERVICE}/download?id=mixMemo0001&duration=4&start=30`, "http_404");
    pf.notePermanentDownloadRefusal(`${SERVICE}/download?id=mixMemo0002&duration=4&start=30`, "http_404");
    const ids = ["mixMemo0001", "mixFail0001", "mixMemo0002", "mixFail0002", "mixFail0003", "mixFail0004"];
    for (const id of ids) await asTheCallerDoes(cache, 3, id);
    /** the two that never started gave their slots back; three real transfers fill the ceiling of 3 */
    expect(spent(cache).downloadSlotsRefunded).toBe(2);
    expect(spent(cache).downloadSlotsClaimed).toBe(3);
    expect(downloadsAsked.length).toBe(3);
  });

  it("wired: the cloud branch tells the streamer to mark the start; the streamer marks it just before the request", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const inner = PIPE.slice(PIPE.indexOf("async function downloadToFileStreamingInner("));
    expect(inner.indexOf("onRequestStart?.();")).toBeGreaterThan(-1);
    expect(inner.indexOf("onRequestStart?.();")).toBeLessThan(inner.indexOf("await fetchWithTimeout(url, timeoutMs, label, options)"));
    const cloud = PIPE.slice(PIPE.indexOf("const dlUrl = `${cloudDlService}/download"));
    expect(cloud.slice(0, 3_000)).toMatch(/80 \* 1024 \* 1024,[\s\S]*?\(\) => \{\s*transferStarted = true;\s*\}/);
  });
});
