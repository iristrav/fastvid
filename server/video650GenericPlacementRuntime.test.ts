/**
 * PRE-DEPLOY CHECK — THE GENERIC FLOOR, RUN FOR REAL (the synthetic cases render two 1920x1080 clips with real ffmpeg: ~60 s each on this host, hence the 300 s clocks): a real clip from the archive first; the
 * synthetic placeholder only when the archive has nothing, and then named as an emergency.
 *
 * `placeGenericMovingFallbacks` runs with real ffmpeg (the validity, black and motion checks, the
 * synthetic render) against a stand-in archive: `listActiveVideoArchiveAssetsByTag` answers from a
 * list this test controls and `loadArchiveAssetFile` hands over a real testsrc2 file. Everything
 * else is the pipeline's own code.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveFFmpegBin } from "./ffmpegBinary";
import { GENERIC_FOOTAGE_PROVIDER, SYNTHETIC_PLACEHOLDER_PROVIDER } from "./genericFootageFallback";

const archive = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; title: string | null; mediaType: "video" | "image"; mediaStatus: string | null; isActive: number; durationSec: number | null; storageUrl: string; storageKey: string | null; mimeType: string; tags?: string[] }>,
  file: "",
}));
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  listActiveVideoArchiveAssetsByTag: async (tag: string) => (tag === "generic" ? archive.rows : []),
}));
vi.mock("./archiveAssetLoad", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./archiveAssetLoad")>()),
  loadArchiveAssetFile: async () => ({ ok: true, result: { localPath: archive.file, cleanup: () => undefined } }),
}));

const run = promisify(execFile);
const FFMPEG = resolveFFmpegBin();
type VP = typeof import("./videoPipeline");
let vp: VP;
let root = "";
let logs: string[] = [];

beforeAll(async () => {
  vp = await import("./videoPipeline");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "v650-generic-rt-"));
  archive.file = path.join(root, "archive_sky.mp4");
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", archive.file]);
}, 120_000);
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* not worth a failure */ } });
afterEach(() => vi.restoreAllMocks());

const capture = () => {
  logs = [];
  for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
};
const scene = { index: 0, text: "A sentence nothing could picture. And another.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 };

/**
 * FIX 1+2 — a real generic clip is placed only after both mandatory checks for its sentence. These
 * cases are about the PLACEMENT, so the checks are given here: passing unless a case says otherwise
 * (the checks themselves are tested in mandatoryPictureChecks.test.ts).
 */
async function place(workDir: string, passes = true) {
  fs.mkdirSync(workDir, { recursive: true });
  const dedup = vp.createVisualDedupState(vp.getPipelinePerfProfile("1"));
  dedup.sceneBeatsBySceneIndex.set(0, [
    { index: 0, text: "A sentence nothing could picture.", holdSec: 3, keywords: [] as string[] },
    { index: 1, text: "And another.", holdSec: 3, keywords: [] as string[] },
  ] as never);
  const results: Array<{ clips: string[]; beatDurations: number[]; clipBeatIndices: number[] } | undefined> = [{ clips: [], beatDurations: [], clipBeatIndices: [] }];
  const asked: string[] = [];
  const tally = await vp.placeGenericMovingFallbacks([scene as never], results as never, dedup, workDir, "Film", async (_s, _b, clipPath) => {
    asked.push(path.basename(clipPath));
    return passes;
  });
  return { tally, results, dedup, asked };
}

describe("PRE-DEPLOY — the generic floor prefers a REAL archive clip and names the synthetic field as an emergency", () => {
  it("with a real generic clip in the archive: both sentences get it (source=archive, provider generic_footage), no placeholder, no EMERGENCY line", async () => {
    capture();
    archive.rows = [{ id: 418, title: "slow clouds", mediaType: "video", mediaStatus: "READY", isActive: 1, durationSec: 8, storageUrl: "", storageKey: null, mimeType: "video/mp4", tags: ["generic"] }];
    const { tally, results } = await place(path.join(root, "with-archive"));
    expect(tally).toEqual({ placed: 2, failed: 0 });
    const clips = results[0]!.clips;
    expect(clips).toHaveLength(2);
    expect(results[0]!.clipBeatIndices).toEqual([0, 1]);
    for (const c of clips) {
      /** the tag is `__pid_<provider>-<sha16 of the asset id>` (providerAssetIdentityKey) */
      expect(path.basename(c)).toMatch(new RegExp(`__pid_${GENERIC_FOOTAGE_PROVIDER}-[0-9a-f]{16}\\.mp4$`));
      expect(fs.statSync(c).size).toBeGreaterThan(10_000);
    }
    expect(logs.some((l) => l.includes('library: 1 active generic clip(s) tagged "generic"'))).toBe(true);
    expect(logs.filter((l) => l.includes("placed source=archive asset=418"))).toHaveLength(2);
    expect(logs.some((l) => l.includes("EMERGENCY") || l.includes("source=synthetic"))).toBe(false);
    /** the one archive clip is allowed to serve both sentences when it is the only one (rotation prefers fresh clips first) */
    expect(logs.some((l) => l.includes("TOTAL placed=2 failed=0"))).toBe(true);
  }, 300_000);

  it("FIX 1+2 — a real generic clip that fails the checks for its sentence is not placed; the colour field (which the delivery gate refuses) stands in", async () => {
    capture();
    archive.rows = [{ id: 418, title: "slow clouds", mediaType: "video", mediaStatus: "READY", isActive: 1, durationSec: 8, storageUrl: "", storageKey: null, mimeType: "video/mp4", tags: ["generic"] }];
    const { results, asked } = await place(path.join(root, "with-archive-refused"), false);
    expect(asked.length).toBeGreaterThan(0);
    for (const c of results[0]!.clips) {
      expect(path.basename(c)).not.toContain(`__pid_${GENERIC_FOOTAGE_PROVIDER}`);
    }
    expect(logs.filter((l) => l.includes("placed source=archive"))).toHaveLength(0);
    expect(logs.some((l) => l.includes("did not pass both mandatory checks for this sentence"))).toBe(true);
  }, 300_000);

  it("with NO generic clip in the archive: the synthetic placeholder is placed under its own provider name and every line calls it an EMERGENCY, not footage", async () => {
    capture();
    archive.rows = [];
    const { tally, results } = await place(path.join(root, "no-archive"));
    expect(tally).toEqual({ placed: 2, failed: 0 });
    for (const c of results[0]!.clips) {
      expect(path.basename(c)).toMatch(new RegExp(`__pid_${SYNTHETIC_PLACEHOLDER_PROVIDER}-[0-9a-f]{16}\\.mp4$`));
      expect(path.basename(c)).not.toContain(`__pid_${GENERIC_FOOTAGE_PROVIDER}`);
    }
    expect(logs.some((l) => l.includes('library: 0 active generic clip(s) tagged "generic"'))).toBe(true);
    const placedLines = logs.filter((l) => l.includes("placed source=synthetic"));
    expect(placedLines).toHaveLength(2);
    for (const l of placedLines) {
      expect(l).toContain("EMERGENCY PLACEHOLDER (provider=synthetic_placeholder)");
      expect(l).toContain("NOT footage, NOT a content choice");
      expect(l).toContain("QUALITY PROBLEM");
    }
    /** the archive's refusal is said before the placeholder is placed */
    expect(logs.some((l) => l.includes("before that: archive: no generic clip of"))).toBe(true);
  }, 300_000);

  it("an archive clip too short for the sentence is passed over for the placeholder — and said so", async () => {
    capture();
    archive.rows = [{ id: 7, title: "too short", mediaType: "video", mediaStatus: "READY", isActive: 1, durationSec: 2, storageUrl: "", storageKey: null, mimeType: "video/mp4", tags: ["generic"] }];
    const { results } = await place(path.join(root, "short-archive"));
    expect(results[0]!.clips.every((c) => c.includes(`__pid_${SYNTHETIC_PLACEHOLDER_PROVIDER}-`))).toBe(true);
    expect(results[0]!.clips.some((c) => c.includes(`__pid_${GENERIC_FOOTAGE_PROVIDER}-`))).toBe(false);
    expect(logs.some((l) => l.includes("before that: archive: no generic clip of 4.00s or longer"))).toBe(true);
  }, 300_000);
});
