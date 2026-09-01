/**
 * RONDE 118 — an archive asset must have a preview that can actually be read.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * All three routes into the archive did the same thing:
 *
 *     storagePut(...)                 // the bytes go to S3
 *     createMediaArchiveAsset({ ..., isActive: 1 })   // the row goes in, active, immediately
 *
 * Nothing between those two lines asked whether the bytes were a video, whether ffmpeg could get
 * a frame out of them, or whether an image would decode. A truncated download, a container with
 * no video stream, a zero-byte write — all of them became `isActive = 1` archive items that the
 * candidate query happily returns.
 *
 * The UI's "Preview mislukt — bestand ontbreekt of is corrupt" is the browser discovering this
 * afterwards. The server never knew: `archiveAssetHasLocalCopy` answers a different question —
 * "does a file exist at this URL shape" — and returns true for any http URL without fetching a
 * single byte.
 *
 * ── What this module is ──────────────────────────────────────────────────────────────────────
 *
 * The check that was missing, built from the primitives the pipeline already uses: ffprobe for
 * "is this really a decodable video/image", and extractFrameAtFraction — the same frame grabber
 * the vision gate uses — for "can a preview frame actually be produced".
 *
 * It is not a preview ARCHITECTURE. It stores nothing, caches nothing and renders nothing for
 * display; it answers one question about bytes that are already in hand, so the caller can decide
 * whether a row may be written at all.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const exec = promisify(execCb);

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

/**
 * Why an asset has no usable preview.
 *
 * Kept short and machine-readable: it is written to a column and read back by the admin, so it
 * has to survive as a value rather than as a sentence.
 */
export type PreviewFailureReason =
  | "source_missing"
  | "source_unreadable"
  | "no_video_stream"
  | "zero_duration"
  | "no_preview_frame"
  | "preview_unreadable"
  | "image_unreadable";

export type PreviewVerdict =
  | { ok: true; widthPx: number; heightPx: number; durationSec: number }
  | { ok: false; reason: PreviewFailureReason; detail?: string };

/** Below this a file cannot hold an image or a container, let alone a frame. */
const MIN_PLAUSIBLE_MEDIA_BYTES = 512;
/** A preview frame smaller than this is not a picture — ffmpeg wrote a header and nothing else. */
const MIN_PLAUSIBLE_FRAME_BYTES = 256;

type ProbeResult = { width: number; height: number; durationSec: number; hasVideoStream: boolean };

/**
 * Ask ffprobe what this file actually is.
 *
 * Deliberately one call for all three facts — a second spawn per asset is real wall clock on a
 * bulk upload, and every one of these comes from the same probe anyway.
 */
async function probeMedia(filePath: string, timeoutMs: number): Promise<ProbeResult | null> {
  try {
    const { stdout } = await exec(
      `${ffprobeBin()} -v error -select_streams v:0 ` +
        `-show_entries stream=codec_type,width,height -show_entries format=duration ` +
        `-of json "${filePath}"`,
      { timeout: timeoutMs }
    );
    const parsed = JSON.parse(String(stdout)) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration ?? 0);
    return {
      width: Number(stream?.width ?? 0),
      height: Number(stream?.height ?? 0),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
      hasVideoStream: stream?.codec_type === "video",
    };
  } catch {
    return null;
  }
}

/**
 * Can this asset be shown?
 *
 * For an IMAGE that means the bytes decode to real pixel dimensions — which is exactly what being
 * "displayable as a preview" is for a still.
 *
 * For a VIDEO it means two separate things, and both are checked because either can fail on its
 * own: the container has a video stream with a real duration, AND ffmpeg can genuinely pull one
 * frame out of it. A file can probe clean and still yield nothing at extraction time (a truncated
 * download whose header survived), which is the case the UI kept discovering in the browser.
 */
export async function verifyArchivePreview(params: {
  localPath: string;
  mediaType: "video" | "image";
  /** Frame extractor, injected so this module does not drag the vision stack into an upload. */
  extractFrame?: (videoPath: string, outPath: string, fraction: number) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<PreviewVerdict> {
  const { localPath, mediaType } = params;
  const timeoutMs = params.timeoutMs ?? 20_000;

  if (!localPath || !fs.existsSync(localPath)) {
    return { ok: false, reason: "source_missing" };
  }
  let size = 0;
  try {
    size = fs.statSync(localPath).size;
  } catch {
    return { ok: false, reason: "source_missing" };
  }
  if (size < MIN_PLAUSIBLE_MEDIA_BYTES) {
    return { ok: false, reason: "source_unreadable", detail: `${size}B` };
  }

  const probe = await probeMedia(localPath, Math.min(timeoutMs, 15_000));
  if (!probe) {
    // ffprobe could not read it at all — the definition of corrupt, for both media types.
    return { ok: false, reason: mediaType === "image" ? "image_unreadable" : "source_unreadable" };
  }

  if (mediaType === "image") {
    if (!(probe.width > 0 && probe.height > 0)) {
      return { ok: false, reason: "image_unreadable" };
    }
    return { ok: true, widthPx: probe.width, heightPx: probe.height, durationSec: 0 };
  }

  if (!probe.hasVideoStream) return { ok: false, reason: "no_video_stream" };
  if (probe.durationSec <= 0) return { ok: false, reason: "zero_duration" };
  if (!(probe.width > 0 && probe.height > 0)) return { ok: false, reason: "no_video_stream" };

  /**
   * The part a probe cannot answer.
   *
   * A container can describe a perfectly good video and contain no decodable picture. Asking for
   * a frame is the only way to find out, and it is also literally the preview the UI will try to
   * show — so this checks the thing that actually failed rather than a proxy for it.
   */
  const extract = params.extractFrame;
  if (!extract) {
    // No extractor supplied: the probe passed, and claiming more than was checked would be a lie.
    return { ok: true, widthPx: probe.width, heightPx: probe.height, durationSec: probe.durationSec };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previewcheck-"));
  const framePath = path.join(dir, "frame.jpg");
  try {
    const got = await extract(localPath, framePath, 0.25);
    if (!got || !fs.existsSync(framePath)) {
      return { ok: false, reason: "no_preview_frame" };
    }
    const frameBytes = fs.statSync(framePath).size;
    if (frameBytes < MIN_PLAUSIBLE_FRAME_BYTES) {
      return { ok: false, reason: "preview_unreadable", detail: `${frameBytes}B` };
    }
    // ...and the frame itself must be a readable image, not just a non-empty file.
    const frameProbe = await probeMedia(framePath, 8_000);
    if (!frameProbe || !(frameProbe.width > 0 && frameProbe.height > 0)) {
      return { ok: false, reason: "preview_unreadable" };
    }
    return { ok: true, widthPx: probe.width, heightPx: probe.height, durationSec: probe.durationSec };
  } catch (err) {
    return { ok: false, reason: "no_preview_frame", detail: (err as Error).message?.slice(0, 60) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Verify bytes that are in memory rather than on disk.
 *
 * The upload routes hold a Buffer at the moment the decision has to be made — before any row is
 * written — so this writes it to a scratch file and asks the same question. Same check, one
 * caller-facing shape.
 */
export async function verifyArchivePreviewBuffer(params: {
  buffer: Buffer;
  mediaType: "video" | "image";
  extension?: string;
  extractFrame?: (videoPath: string, outPath: string, fraction: number) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<PreviewVerdict> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previewsrc-"));
  const ext = params.extension?.replace(/^\.?/, ".") ?? (params.mediaType === "video" ? ".mp4" : ".jpg");
  const file = path.join(dir, `asset${ext}`);
  try {
    fs.writeFileSync(file, params.buffer);
    return await verifyArchivePreview({
      localPath: file,
      mediaType: params.mediaType,
      extractFrame: params.extractFrame,
      timeoutMs: params.timeoutMs,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One line per refused asset, in the shape the upload and ingestion logs already use. */
export function formatPreviewRefusal(label: string, verdict: Extract<PreviewVerdict, { ok: false }>): string {
  return (
    `[PreviewCheck] refused ${label}: ${verdict.reason}` +
    (verdict.detail ? ` (${verdict.detail})` : "") +
    " — not registered as an archive asset"
  );
}
