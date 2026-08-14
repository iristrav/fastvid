/**
 * Reject archive clips with baked-in edit text (titles, lower thirds, captions).
 * Documentary text belongs in the editor — not in source B-roll.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { exec as execCb, spawn } from "child_process";
import { promisify } from "util";
import { withForkRetry } from "./_core/execForkRetry";
import { ffmpegSemaphore } from "./_core/semaphore";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";

// Routed through ffmpegSemaphore (previously ungated) — archiveClipOverlayFilterEnabled() is
// effectively default-on in production (true whenever a Forge API key is configured).
const execRaw = promisify(execCb);
const exec = ((cmd: string, opts?: Record<string, unknown>) =>
  ffmpegSemaphore.run(() => withForkRetry(() => execRaw(cmd, opts as never)))) as typeof execRaw;

const OVERLAY_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "archive_clip_overlay_check",
    strict: true,
    schema: {
      type: "object",
      properties: {
        hasBakedEditText: { type: "boolean" },
      },
      required: ["hasBakedEditText"],
      additionalProperties: false,
    },
  },
} as const;

export function archiveClipOverlayFilterEnabled(): boolean {
  if (process.env.ENABLE_ARCHIVE_OVERLAY_FILTER === "false") return false;
  return Boolean(ENV.forgeApiKey);
}

/** Skip per-clip LLM overlay checks on very large splits (prevents upload timeout). */
export function shouldRunArchiveOverlayFilter(clipCount: number): boolean {
  if (!archiveClipOverlayFilterEnabled()) return false;
  const raw = process.env.ARCHIVE_OVERLAY_MAX_CLIPS?.trim();
  const max = raw ? parseInt(raw, 10) : 300;
  if (!isNaN(max) && max > 0 && clipCount > max) {
    console.warn(`[ArchiveFilter] skip overlay checks for ${clipCount} clips (max ${max})`);
    return false;
  }
  return true;
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

export function imageMimeToDataUrl(buffer: Buffer, mimeType: string): string {
  const mime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function extractVideoPreviewJpeg(
  videoPath: string,
  outPath: string,
  seek: number | `${number}%` = "35%"
): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  try {
    await ffmpegSemaphore.run(() => withForkRetry(() => new Promise<void>((resolve, reject) => {
      const seekArg = typeof seek === "number" ? seek.toFixed(3) : `${Math.round(parseFloat(seek))}%`;
      const args = ["-y", "-ss", seekArg, "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        reject(new Error("frame extract timeout"));
      }, 15_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) resolve();
        else reject(new Error(stderr.slice(-120) || `ffmpeg exit ${code}`));
      });
      child.on("error", reject);
    })));
    return true;
  } catch {
    return false;
  }
}

// F3-24: the two "false" bullets for baked-in subtitles/captions and historical text used to
// have no size/dominance qualifier at all — any on-screen subtitle or caption, of any size or
// language, was explicitly told never to be a rejection reason. That's why footage with large,
// dominant, irrelevant foreign-language subtitles burned into the frame (e.g. French text like
// "et Europe" / "devait parvenir à précipiter les peuples dans une guerre mondiale" covering a
// meaningful part of the picture) passed this gate uncontested. The fix is a DOMINANCE
// qualifier, not a blanket ban — a historical photo with small background text/labels still
// must not be auto-rejected, per the same prompt's existing intent.
const OVERLAY_PROMPT = `Beoordeel deze videostill(s) voor een documentaire-archief.

hasBakedEditText = true wanneer ÉÉN of meer stills DOMINANTE, onbruikbare tekst bevatten — tekst
die een aanzienlijk deel van het beeld inneemt en de aandacht wegtrekt van het beeldmateriaal zelf:
- titelkaarten of chapter cards die het beeld volledig overdekken
- intro/outro-tekst of aftiteling
- grote, dominante ingebakken ondertitels/captions (bijv. een brede onderbalk met een volledige
  lopende zin), zeker wanneer de taal niet aansluit bij de narratie
- grote montage-tekst die het beeldmateriaal onbruikbaar maakt
- bewerkingssoftware-interface zichtbaar in beeld (DaVinci, Premiere, etc.)
- een groot, prominent watermerk dat het beeld domineert

hasBakedEditText = false bij normaal documentaire- of archiefmateriaal, ook als er:
- kleine lower thirds zijn met naam, datum, locatie of jaar
- kleine, niet-dominante ondertitels of bijschriften die maar een klein deel van het beeld innemen
- historische tekst, krantenkoppen, kaarten of labels zichtbaar zijn, zolang ze het beeld niet domineren
- een klein logo of watermerk in de hoek staat
Kleine, marginale documentaire-labels zijn GEEN reden voor afwijzing — het gaat uitsluitend om
tekst die zo groot/dominant is dat ze het beeldmateriaal zelf onbruikbaar maakt.`;

async function detectOnScreenTextInImages(dataUrls: string[]): Promise<boolean> {
  if (dataUrls.length === 0) return false;
  const timeoutMs = dataUrls.length > 1 ? 18_000 : 14_000;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content: "Je filtert archief-clips. Return alleen JSON volgens het schema.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  dataUrls.length > 1
                    ? `${OVERLAY_PROMPT}\n\nEr zijn ${dataUrls.length} stills van hetzelfde fragment — markeer true als minstens één still tekst toont.`
                    : OVERLAY_PROMPT,
              },
              ...dataUrls.map((url) => ({
                type: "image_url" as const,
                image_url: { url, detail: "low" as const },
              })),
            ],
          },
        ],
        response_format: OVERLAY_JSON_SCHEMA,
        maxTokens: 64,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("overlay filter timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return false;
    const parsed = JSON.parse(content) as { hasBakedEditText?: boolean };
    return Boolean(parsed.hasBakedEditText);
  } catch (err) {
    console.warn("[ArchiveFilter] overlay check failed:", (err as Error).message?.slice(0, 120));
    return false;
  }
}

async function extractVideoPreviewJpegs(
  videoPath: string,
  workDir: string,
  sampleSec: number[]
): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (let i = 0; i < sampleSec.length; i++) {
    const outPath = path.join(workDir, `frame_${i}.jpg`);
    const ok = await extractVideoPreviewJpeg(videoPath, outPath, sampleSec[i]);
    if (ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) {
      frames.push(fs.readFileSync(outPath));
    }
  }
  return frames;
}

/** Preview frames from a source segment (for relevance / overlay checks). */
export async function extractArchiveSegmentPreviewJpegs(
  videoPath: string,
  startSec: number,
  endSec: number,
  fastMode = false
): Promise<Buffer[]> {
  if (!fs.existsSync(videoPath)) return [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-seg-preview-"));
  try {
    return await extractVideoPreviewJpegs(
      videoPath,
      workDir,
      sampleTimesInRange(startSec, endSec, fastMode)
    );
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function sampleTimesInRange(startSec: number, endSec: number, fastMode = false): number[] {
  const dur = endSec - startSec;
  if (dur <= 0.25) return [startSec + dur * 0.5];
  if (fastMode) return [startSec + dur * 0.5];
  return [startSec + dur * 0.35, startSec + dur * 0.65];
}

/** Check a source-video segment before extract (start/end in seconds). */
export async function archiveSegmentHasOnScreenText(
  videoPath: string,
  startSec: number,
  endSec: number,
  opts?: { clipCount?: number; fastMode?: boolean }
): Promise<boolean> {
  if (opts?.clipCount != null && !shouldRunArchiveOverlayFilter(opts.clipCount)) return false;
  if (!archiveClipOverlayFilterEnabled()) return false;
  if (!fs.existsSync(videoPath)) return false;

  const fastMode = opts?.fastMode ?? (opts?.clipCount != null && opts.clipCount > 40);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-overlay-seg-"));
  try {
    const frames = await extractVideoPreviewJpegs(
      videoPath,
      workDir,
      sampleTimesInRange(startSec, endSec, fastMode)
    );
    if (frames.length === 0) return false;
    const dataUrls = frames.map((buf) => imageMimeToDataUrl(buf, "image/jpeg"));
    return detectOnScreenTextInImages(dataUrls);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Returns true when clip should be skipped (on-screen text detected).
 * `media` accepts either an in-memory Buffer or a path to a file already on disk — for the video
 * case, callers that already have the source file on disk should pass the path so this doesn't
 * need a full read-into-memory + write-back-to-disk round trip of what can be a large clip.
 */
export async function archiveClipHasBakedEditText(
  media: Buffer | string,
  mimeType: string,
  opts?: { clipCount?: number }
): Promise<boolean> {
  if (opts?.clipCount != null && !shouldRunArchiveOverlayFilter(opts.clipCount)) return false;
  if (!archiveClipOverlayFilterEnabled()) return false;

  if (mimeType.startsWith("image/")) {
    const buf = typeof media === "string" ? fs.readFileSync(media) : media;
    const dataUrl = imageMimeToDataUrl(buf, mimeType);
    return detectOnScreenTextInImages([dataUrl]);
  }

  if (!mimeType.startsWith("video/")) return false;

  const fastMode = opts?.clipCount != null && opts.clipCount > 40;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-overlay-"));
  let videoPath: string;
  if (typeof media === "string") {
    videoPath = media;
  } else {
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mov") ? "mov" : "mp4";
    videoPath = path.join(workDir, `preview.${ext}`);
    fs.writeFileSync(videoPath, media);
  }
  try {
    const dur = await probeVideoDurationSec(videoPath);
    const sampleSec =
      dur <= 0.4
        ? [dur > 0 ? dur * 0.5 : 0]
        : fastMode
          ? [dur * 0.5]
          : [dur * 0.35, dur * 0.65];
    const frames = await extractVideoPreviewJpegs(videoPath, workDir, sampleSec);
    if (frames.length === 0) return false;
    const dataUrls = frames.map((buf) => imageMimeToDataUrl(buf, "image/jpeg"));
    return detectOnScreenTextInImages(dataUrls);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function probeVideoDurationSec(filePath: string): Promise<number> {
  try {
    const ffprobe = process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
    const { stdout } = await exec(
      `${ffprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 15_000 }
    );
    const dur = parseFloat(String(stdout).trim());
    return !isNaN(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}
