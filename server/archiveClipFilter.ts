/**
 * Reject archive clips with baked-in edit text (titles, lower thirds, captions).
 * Documentary text belongs in the editor — not in source B-roll.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";

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
  if (process.env.ENABLE_ARCHIVE_AI_TAGS === "false") return false;
  return Boolean(ENV.forgeApiKey);
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function imageMimeToDataUrl(buffer: Buffer, mimeType: string): string {
  const mime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function extractVideoPreviewJpeg(videoPath: string, outPath: string, seekRatio = 0.35): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["-y", "-ss", `${Math.round(seekRatio * 100)}%`, "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
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
    });
    return true;
  } catch {
    return false;
  }
}

async function previewImageFromMedia(
  mediaBuffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (mimeType.startsWith("image/")) {
    return { buffer: mediaBuffer, mimeType };
  }
  if (!mimeType.startsWith("video/")) return null;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-overlay-"));
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mov") ? "mov" : "mp4";
  const videoPath = path.join(workDir, `preview.${ext}`);
  const framePath = path.join(workDir, "frame.jpg");
  try {
    fs.writeFileSync(videoPath, mediaBuffer);
    const ok = await extractVideoPreviewJpeg(videoPath, framePath);
    if (!ok) return null;
    return { buffer: fs.readFileSync(framePath), mimeType: "image/jpeg" };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const OVERLAY_PROMPT = `Beoordeel dit videostillbeeld voor een documentaire-archief.

hasBakedEditText = true ALLEEN wanneer er duidelijk tekst in het beeld zit die door een video-editor is toegevoegd, zoals:
- titelkaarten / chapter cards
- ondertitels of captions die over het beeld liggen
- lower thirds, namen, datums, locatie-tekst
- grote tekst-overlays of animatie-tekst uit een montage

hasBakedEditText = false wanneer:
- puur beeldmateriaal zonder editor-tekst
- natuurlijke tekst in de scène (borden, krantenkoppen, etiketten) die bij het onderwerp hoort
- alleen logo's of watermerken (geen titel/caption overlay)`;

/** Returns true when clip should be skipped (baked edit text detected). */
export async function archiveClipHasBakedEditText(
  mediaBuffer: Buffer,
  mimeType: string
): Promise<boolean> {
  if (!archiveClipOverlayFilterEnabled()) return false;

  const preview = await previewImageFromMedia(mediaBuffer, mimeType);
  if (!preview) return false;

  const dataUrl = imageMimeToDataUrl(preview.buffer, preview.mimeType);
  const timeoutMs = 14_000;

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
              { type: "text", text: OVERLAY_PROMPT },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
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
