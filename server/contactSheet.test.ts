/**
 * VIDEO 656 — the contact sheet and the repeat check run on real files, made here with ffmpeg.
 *
 * A picture that comes back after the film showed something else is a repeat; a picture that stays
 * (a held frame) is not; a moving film is not; flat frames (black) are never compared.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  contactSheetStorageKey,
  fingerprintOf,
  findRepeats,
  formatContactSheetLine,
  sampleIntervalSec,
  scanDeliveredFilm,
  sheetEvery,
  type FrameFingerprint,
} from "./contactSheet";
import { resolveFFmpegBin } from "./ffmpegBinary";

let dir = "";
let ff = "";

function make(name: string, graph: string, inputs: string[]): string {
  const out = path.join(dir, name);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const i of inputs) args.push("-f", "lavfi", "-i", i);
  args.push("-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", out);
  execFileSync(ff, args);
  return out;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "contact-sheet-"));
  ff = resolveFFmpegBin();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const BARS = "smptehdbars=s=320x180:d=3:r=25";
const FRACTAL = "mandelbrot=s=320x180:r=25";
const MOVING = "testsrc2=s=320x180:r=25";
const trim = (n: number, d: number, label: string) => `[${n}:v]trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p[${label}]`;

describe("on real files", () => {
  it("A, B, A again, C: the return of A is found, once, with where and how long", async () => {
    const film = make(
      "aba.mp4",
      `${trim(1, 3, "b")};${trim(2, 3, "c")};[0:v]format=yuv420p,split[a1][a2];[a1][b][a2][c]concat=n=4:v=1[v]`,
      [BARS, FRACTAL, MOVING]
    );
    const sheet = path.join(dir, "aba.jpg");
    const r = await scanDeliveredFilm({ videoPath: film, sheetPath: sheet, durationSec: 12, ffmpegBin: ff });
    expect(r).not.toBeNull();
    expect(r!.samples).toBe(12);
    expect(r!.repeats).toEqual([{ firstAtSec: 0, againAtSec: 6, samples: 3, seconds: 3 }]);
    /** the sheet is a real JPEG, eight tiles wide */
    expect(r!.sheetPath).toBe(sheet);
    expect(readFileSync(sheet).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 120_000);

  it("a picture that stays on screen (a held frame) is not a repeat", async () => {
    const film = make("hold.mp4", `${trim(0, 3, "m")};[1:v]trim=duration=6,setpts=PTS-STARTPTS,format=yuv420p[a];[m][a]concat=n=2:v=1[v]`, [
      MOVING,
      "smptehdbars=s=320x180:d=6:r=25",
    ]);
    const r = await scanDeliveredFilm({ videoPath: film, sheetPath: path.join(dir, "hold.jpg"), durationSec: 9, ffmpegBin: ff });
    expect(r!.repeats).toEqual([]);
  }, 120_000);

  it("black between two different pictures is not compared, and black twice is not a repeat", async () => {
    const film = make(
      "black.mp4",
      `${trim(0, 2, "k1")};${trim(1, 3, "a")};${trim(2, 2, "k2")};${trim(3, 3, "b")};[k1][a][k2][b]concat=n=4:v=1[v]`,
      ["color=black:s=320x180:d=2:r=25", BARS, "color=black:s=320x180:d=2:r=25", FRACTAL]
    );
    const r = await scanDeliveredFilm({ videoPath: film, sheetPath: path.join(dir, "black.jpg"), durationSec: 10, ffmpegBin: ff });
    expect(r!.repeats).toEqual([]);
  }, 120_000);

  it("a file that cannot be read gives no result, and the line says so", async () => {
    const bad = path.join(dir, "bad.mp4");
    fs.writeFileSync(bad, "not a video");
    const r = await scanDeliveredFilm({ videoPath: bad, sheetPath: path.join(dir, "bad.jpg"), durationSec: 5, ffmpegBin: ff });
    expect(r).toBeNull();
    expect(formatContactSheetLine(7, 9, r, null)).toContain("NOT MADE");
  }, 120_000);
});

describe("the rule, on fingerprints", () => {
  const fp = (hash: bigint, atSec: number, flat = false): FrameFingerprint => ({ atSec, hash, flat });
  const A = 0xf0f0f0f0f0f0f0f0n;
  const B = 0x0f0f0f0f0f0f0f0fn;

  it("A A B A: one return of A, not one per earlier sample", () => {
    expect(findRepeats([fp(A, 0), fp(A, 1), fp(B, 2), fp(A, 3)], 1)).toEqual([
      { firstAtSec: 0, againAtSec: 3, samples: 1, seconds: 1 },
    ]);
  });

  it("a few bits of difference (a caption, compression) is still the same picture; many are not", () => {
    expect(findRepeats([fp(A, 0), fp(B, 1), fp(A ^ 0b111n, 2)], 1)).toHaveLength(1);
    expect(findRepeats([fp(A, 0), fp(B, 1), fp(A ^ 0xffffn, 2)], 1)).toHaveLength(0);
  });

  it("a flat frame between does not count as 'something else'", () => {
    expect(findRepeats([fp(A, 0), fp(0n, 1, true), fp(A, 2)], 1)).toEqual([]);
  });

  it("a uniform grey frame is flat", () => {
    expect(fingerprintOf(new Uint8Array(72).fill(16), 0).flat).toBe(true);
    const ramp = Uint8Array.from({ length: 72 }, (_, i) => (i % 9) * 28);
    expect(fingerprintOf(ramp, 0).flat).toBe(false);
  });

  it("long films are sampled wider apart and the sheet stays at most 240 tiles", () => {
    expect(sampleIntervalSec(60)).toBe(1);
    expect(sampleIntervalSec(600)).toBe(1);
    expect(sampleIntervalSec(3600)).toBe(6);
    expect(sheetEvery(600)).toBe(3);
    expect(sheetEvery(60)).toBe(1);
  });
});

describe("after delivery, in the render job", () => {
  it("the sheet is stored under the job's own key and the line names the key, never a URL", async () => {
    const { reportContactSheet } = await import("./renderJobWorker");
    const upload = vi.fn(async (key: string) => ({ key, url: "https://signed.example/secret?sig=abc" }));
    const sheet = path.join(dir, "fake.jpg");
    fs.writeFileSync(sheet, "jpg");
    const line = await reportContactSheet({
      videoId: 656,
      jobId: 81,
      outputPath: "/nowhere.mp4",
      workDir: dir,
      durationSec: 12,
      upload,
      scan: async () => ({ sheetPath: sheet, intervalSec: 1, samples: 12, repeats: [{ firstAtSec: 9, againAtSec: 12, samples: 3, seconds: 3 }] }),
    });
    expect(upload).toHaveBeenCalledWith(contactSheetStorageKey(656, 81), sheet, "image/jpeg");
    expect(line).toContain("sheet=videos/656/edits/render_81_contact_sheet.jpg");
    expect(line).toContain("REPEATS=1");
    expect(line).toContain("0:09→0:12 (3s)");
    expect(line).not.toContain("https://");
    expect(line).not.toContain("sig=");
  }, 120_000);

  it("a failing scan or upload never throws", async () => {
    const { reportContactSheet } = await import("./renderJobWorker");
    const line = await reportContactSheet({
      videoId: 1,
      jobId: 2,
      outputPath: "/nowhere.mp4",
      workDir: dir,
      durationSec: null,
      upload: async () => {
        throw new Error("down");
      },
      scan: async () => {
        throw new Error("ffmpeg gone");
      },
    });
    expect(line).toContain("NOT MADE — ffmpeg gone");
  }, 120_000);

  it("runs after the delivery is recorded, before the job returns", () => {
    const W = readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    const body = W.slice(W.indexOf("export async function runRenderJob("));
    const lineage = body.indexOf("await recordDeliveredLineage({");
    const sheet = body.indexOf("await reportContactSheet({");
    const ret = body.indexOf("return {\n      ok: true,");
    expect(lineage).toBeGreaterThan(-1);
    expect(sheet).toBeGreaterThan(lineage);
    expect(ret).toBeGreaterThan(sheet);
  });
});
