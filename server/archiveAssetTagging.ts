/**
 * AI vision tagging for media archive uploads (title, description, searchable tags).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { normalizeMediaTags } from "./db";

export type ArchiveAssetAiMetadata = {
  title: string;
  description: string;
  tags: string[];
};

const TAG_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "archive_asset_tags",
    strict: true,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["title", "description", "tags"],
      additionalProperties: false,
    },
  },
} as const;

export function archiveAiTaggingEnabled(): boolean {
  return process.env.ENABLE_ARCHIVE_AI_TAGS !== "false" && Boolean(ENV.forgeApiKey);
}

export function mergeArchiveTags(userTags: string[], aiTags: string[]): string[] {
  return normalizeMediaTags([...userTags, ...aiTags]).slice(0, 32);
}

export function truncateArchiveSourceNote(note: string | null | undefined): string | null {
  if (!note?.trim()) return null;
  return note.trim().slice(0, 512);
}

const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** Infer mime when browser sends empty type (common on Windows). */
export function inferArchiveMediaMime(mimeType: string, filename?: string): string {
  if (mimeType.startsWith("video/") || mimeType.startsWith("image/")) return mimeType;
  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  return mimeType;
}

export function applySharedAiToClipFields(opts: {
  baseTitle: string;
  userTags: string[];
  sourceNote: string | null;
  ai: ArchiveAssetAiMetadata;
  clipIndex?: number;
  userProvidedTitle?: boolean;
}): { title: string; tags: string[]; sourceNote: string | null } {
  let title = opts.baseTitle;
  let tags = mergeArchiveTags(opts.userTags, opts.ai.tags);
  let sourceNote = opts.sourceNote;

  if (opts.clipIndex != null) {
    const root = opts.baseTitle.replace(/\s*—\s*clip\s*\d+$/i, "").trim();
    title = `${root} — ${opts.ai.title}`.slice(0, 512);
  } else if (!opts.userProvidedTitle) {
    title = opts.ai.title.slice(0, 512);
  }

  const desc = opts.ai.description.trim();
  if (desc) {
    sourceNote = sourceNote ? `${sourceNote} — ${desc}` : desc;
  }

  return { title, tags, sourceNote: truncateArchiveSourceNote(sourceNote) };
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function imageMimeToDataUrl(buffer: Buffer, mimeType: string): string {
  const mime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function extractVideoPreviewJpeg(videoPath: string, outPath: string): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["-y", "-ss", "35%", "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
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

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ai-tag-"));
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

function buildVisionPrompt(context: {
  archiveNicheTags?: string[];
  parentFilename?: string;
  userTags?: string[];
  clipLabel?: string;
}): string {
  const lines = [
    "Beschrijf wat je ziet in dit beeld voor een documentaire-archief.",
    "Geef een korte titel (max 8 woorden), één zin beschrijving, en 6–12 zoek-tags.",
    "Tags: lowercase, geen hashtags, mix Nederlands/Engels waar logisch (personen, plaatsen, objecten, tijdperk).",
  ];
  if (context.clipLabel) lines.push(`Dit is ${context.clipLabel} uit een langere video.`);
  if (context.parentFilename) lines.push(`Bronbestand: ${context.parentFilename}`);
  if (context.archiveNicheTags?.length) {
    lines.push(`Archief-onderwerp: ${context.archiveNicheTags.slice(0, 8).join(", ")}`);
  }
  if (context.userTags?.length) {
    lines.push(`Bestaande tags (aanvullen, niet herhalen tenzij relevant): ${context.userTags.join(", ")}`);
  }
  return lines.join("\n");
}

export async function generateArchiveAssetAiMetadata(
  mediaBuffer: Buffer,
  mimeType: string,
  context: {
    archiveNicheTags?: string[];
    parentFilename?: string;
    userTags?: string[];
    clipLabel?: string;
  } = {}
): Promise<ArchiveAssetAiMetadata | null> {
  if (!archiveAiTaggingEnabled()) return null;

  const preview = await previewImageFromMedia(mediaBuffer, mimeType);
  if (!preview) return null;

  const dataUrl = imageMimeToDataUrl(preview.buffer, preview.mimeType);
  const timeoutMs = 18_000;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "Je bent een documentaire archivist. Analyseer het beeld en return alleen JSON volgens het schema.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: buildVisionPrompt(context) },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
        response_format: TAG_JSON_SCHEMA,
        maxTokens: 400,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("archive AI tag timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as {
      title?: string;
      description?: string;
      tags?: string[];
    };
    const title = parsed.title?.trim().slice(0, 120);
    const description = parsed.description?.trim().slice(0, 500);
    const tags = normalizeMediaTags((parsed.tags ?? []).filter((t) => typeof t === "string"));
    if (!title || tags.length === 0) return null;
    return { title, description: description || title, tags };
  } catch (err) {
    console.warn("[ArchiveAI] tagging failed:", (err as Error).message?.slice(0, 160));
    return null;
  }
}

export async function enrichArchiveAssetFields(opts: {
  buffer: Buffer;
  mimeType: string;
  autoGenerateTags: boolean;
  baseTitle: string;
  userTags: string[];
  sourceNote: string | null;
  archiveNicheTags?: string[];
  parentFilename?: string;
  clipIndex?: number;
  userProvidedTitle?: boolean;
}): Promise<{ title: string; tags: string[]; sourceNote: string | null }> {
  let title = opts.baseTitle;
  let tags = opts.userTags;
  let sourceNote = opts.sourceNote;

  if (!opts.autoGenerateTags) return { title, tags, sourceNote };

  const ai = await generateArchiveAssetAiMetadata(opts.buffer, opts.mimeType, {
    archiveNicheTags: opts.archiveNicheTags,
    parentFilename: opts.parentFilename,
    userTags: opts.userTags,
    clipLabel: opts.clipIndex != null ? `fragment ${opts.clipIndex + 1}` : undefined,
  });

  if (!ai) return { title, tags, sourceNote };

  if (opts.clipIndex != null) {
    const root = opts.baseTitle.replace(/\s*—\s*clip\s*\d+$/i, "").trim();
    title = `${root} — ${ai.title}`.slice(0, 512);
  } else if (!opts.userProvidedTitle) {
    title = ai.title.slice(0, 512);
  }

  tags = mergeArchiveTags(opts.userTags, ai.tags);

  const desc = ai.description.trim();
  if (desc) {
    sourceNote = sourceNote ? `${sourceNote} — ${desc}` : desc;
  }

  return { title, tags, sourceNote: truncateArchiveSourceNote(sourceNote) };
}
