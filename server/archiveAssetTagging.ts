/**
 * AI vision tagging for media archive uploads (title, description, searchable tags).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { normalizeMediaTags } from "./db";

const execAsync = promisify(exec);

export type ArchiveAssetAiMetadata = {
  title: string;
  description: string;
  tags: string[];
};

type ArchiveAiVisionPayload = {
  title?: string;
  description?: string;
  tags?: string[];
  persons?: string[];
  locations?: string[];
  objects?: string[];
  actions?: string[];
  era?: string;
  setting?: string;
  sceneType?: string;
  visualDetails?: string[];
  mood?: string;
  camera?: string;
  colors?: string[];
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
        tags: { type: "array", items: { type: "string" } },
        persons: { type: "array", items: { type: "string" } },
        locations: { type: "array", items: { type: "string" } },
        objects: { type: "array", items: { type: "string" } },
        actions: { type: "array", items: { type: "string" } },
        era: { type: "string" },
        setting: { type: "string" },
        sceneType: { type: "string" },
        visualDetails: { type: "array", items: { type: "string" } },
        mood: { type: "string" },
        camera: { type: "string" },
        colors: { type: "array", items: { type: "string" } },
      },
      required: [
        "title",
        "description",
        "tags",
        "persons",
        "locations",
        "objects",
        "actions",
        "era",
        "setting",
        "sceneType",
        "visualDetails",
        "mood",
        "camera",
        "colors",
      ],
      additionalProperties: false,
    },
  },
} as const;

/** Max searchable tags stored per asset (pipeline + semantic matching). */
export const ARCHIVE_MAX_TAGS = 48;

export function archiveAiTaggingEnabled(): boolean {
  return process.env.ENABLE_ARCHIVE_AI_TAGS !== "false" && Boolean(ENV.forgeApiKey);
}

export function mergeArchiveTags(userTags: string[], aiTags: string[]): string[] {
  return normalizeMediaTags([...userTags, ...aiTags]).slice(0, ARCHIVE_MAX_TAGS);
}

export function truncateArchiveSourceNote(note: string | null | undefined): string | null {
  if (!note?.trim()) return null;
  return note.trim().slice(0, 512);
}

function pushTag(bucket: string[], raw: string | undefined | null): void {
  const v = raw?.trim().toLowerCase();
  if (!v || v.length < 2) return;
  bucket.push(v);
}

function pushTags(bucket: string[], items: string[] | undefined): void {
  for (const item of items ?? []) pushTag(bucket, item);
}

/** Flatten structured vision JSON into searchable tags + rich description. */
export function flattenArchiveAiMetadata(parsed: ArchiveAiVisionPayload): ArchiveAssetAiMetadata | null {
  const title = parsed.title?.trim().slice(0, 120);
  if (!title) return null;

  const tagParts: string[] = [];
  pushTags(tagParts, parsed.tags);
  pushTags(tagParts, parsed.persons);
  pushTags(tagParts, parsed.locations);
  pushTags(tagParts, parsed.objects);
  pushTags(tagParts, parsed.actions);
  pushTags(tagParts, parsed.visualDetails);
  pushTags(tagParts, parsed.colors);
  pushTag(tagParts, parsed.era);
  pushTag(tagParts, parsed.setting);
  pushTag(tagParts, parsed.sceneType);
  pushTag(tagParts, parsed.mood);
  pushTag(tagParts, parsed.camera);

  // Derive extra slugs from title words (4+ chars)
  for (const w of title.split(/\s+/)) {
    if (w.length >= 4) pushTag(tagParts, w);
  }

  let tags = normalizeMediaTags(tagParts);
  if (tags.length === 0) {
    tags = normalizeMediaTags(title.split(/\s+/).filter((w) => w.length > 2));
  }
  if (tags.length === 0) return null;
  tags = tags.slice(0, ARCHIVE_MAX_TAGS);

  const detailBits = [
    parsed.description?.trim(),
    parsed.setting?.trim() ? `Setting: ${parsed.setting.trim()}` : "",
    parsed.era?.trim() ? `Era: ${parsed.era.trim()}` : "",
    parsed.sceneType?.trim() ? `Scene: ${parsed.sceneType.trim()}` : "",
    parsed.actions?.length ? `Actions: ${parsed.actions.slice(0, 6).join(", ")}` : "",
    parsed.visualDetails?.length ? `Details: ${parsed.visualDetails.slice(0, 8).join(", ")}` : "",
    parsed.persons?.length ? `People: ${parsed.persons.slice(0, 4).join(", ")}` : "",
    parsed.locations?.length ? `Places: ${parsed.locations.slice(0, 4).join(", ")}` : "",
  ].filter(Boolean);

  const description = detailBits.join(" | ").slice(0, 500) || title;
  return { title, description, tags };
}

export function buildArchiveSourceNote(ai: ArchiveAssetAiMetadata): string {
  return ai.description.trim().slice(0, 512);
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

  const aiNote = buildArchiveSourceNote(opts.ai);
  sourceNote = sourceNote?.trim() ? `${sourceNote.trim()} — ${aiNote}` : aiNote;

  return { title, tags, sourceNote: truncateArchiveSourceNote(sourceNote) };
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
}

async function probeVideoDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobeBin()}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 15_000 }
    );
    const dur = parseFloat(String(stdout).trim());
    return !isNaN(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

async function extractVideoPreviewJpeg(
  videoPath: string,
  outPath: string,
  seekSec?: number
): Promise<boolean> {
  if (!fs.existsSync(videoPath)) return false;
  let seek = seekSec;
  if (seek == null || seek < 0) {
    const dur = await probeVideoDurationSec(videoPath);
    seek = dur > 0.5 ? dur * 0.35 : 0.25;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["-y", "-ss", seek.toFixed(3), "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath];
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
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

/** Sample 1–3 frames across the clip for richer video tagging. */
async function extractVideoPreviewFrames(
  videoPath: string,
  workDir: string
): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  const dur = await probeVideoDurationSec(videoPath);
  const ratios = dur > 4 ? [0.12, 0.42, 0.72] : dur > 1.5 ? [0.2, 0.55] : [0.35];
  const out: Array<{ buffer: Buffer; mimeType: string }> = [];
  for (let i = 0; i < ratios.length; i++) {
    const seek = dur > 0.5 ? Math.max(0.08, dur * ratios[i]!) : 0.15;
    const framePath = path.join(workDir, `frame_${i}.jpg`);
    const ok = await extractVideoPreviewJpeg(videoPath, framePath, seek);
    if (ok) out.push({ buffer: fs.readFileSync(framePath), mimeType: "image/jpeg" });
  }
  return out;
}

function imageMimeToDataUrl(buffer: Buffer, mimeType: string): string {
  const mime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function previewImagesFromFilePath(
  filePath: string,
  mimeType: string
): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  if (mimeType.startsWith("image/")) {
    if (!fs.existsSync(filePath)) return [];
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 64) return [];
    return [{ buffer, mimeType }];
  }
  if (!mimeType.startsWith("video/")) return [];

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ai-frames-"));
  try {
    const frames = await extractVideoPreviewFrames(filePath, workDir);
    return frames;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function previewImagesFromMedia(
  mediaBuffer: Buffer,
  mimeType: string
): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  if (mimeType.startsWith("image/")) {
    return [{ buffer: mediaBuffer, mimeType }];
  }
  if (!mimeType.startsWith("video/")) return [];

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ai-tag-"));
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mov") ? "mov" : "mp4";
  const videoPath = path.join(workDir, `preview.${ext}`);
  try {
    fs.writeFileSync(videoPath, mediaBuffer);
    return await extractVideoPreviewFrames(videoPath, workDir);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function invokeArchiveVisionTagging(
  previews: Array<{ buffer: Buffer; mimeType: string }>,
  context: {
    archiveNicheTags?: string[];
    parentFilename?: string;
    userTags?: string[];
    clipLabel?: string;
  }
): Promise<ArchiveAssetAiMetadata | null> {
  if (previews.length === 0) return null;
  const timeoutMs = previews.length > 1 ? 28_000 : 20_000;

  const imageParts = previews.map((preview) => ({
    type: "image_url" as const,
    image_url: { url: imageMimeToDataUrl(preview.buffer, preview.mimeType), detail: "high" as const },
  }));

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "Je bent een documentaire archivist. Analyseer het beeld (of beelden uit dezelfde clip) en return alleen JSON volgens het schema. Wees exhaustief — elk zichtbaar detail telt voor zoeken.",
          },
          {
            role: "user",
            content: [{ type: "text", text: buildVisionPrompt(context, previews.length) }, ...imageParts],
          },
        ],
        response_format: TAG_JSON_SCHEMA,
        maxTokens: 900,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("archive AI tag timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return null;
    return flattenArchiveAiMetadata(JSON.parse(content) as ArchiveAiVisionPayload);
  } catch (err) {
    console.warn("[ArchiveAI] tagging failed:", (err as Error).message?.slice(0, 160));
    return null;
  }
}

function buildVisionPrompt(
  context: {
    archiveNicheTags?: string[];
    parentFilename?: string;
    userTags?: string[];
    clipLabel?: string;
  },
  frameCount = 1
): string {
  const lines = [
    "Beschrijf ALLES wat je ziet voor een documentaire-archief — zoekmachine moet later de perfecte clip vinden.",
    "",
    "title: max 10 woorden, concreet wat in beeld is (geen bestandsnaam, geen 'clip 1').",
    "description: 1–2 zinnen met handeling + setting + tijdperk indien zichtbaar.",
    "",
    "Vul ALLE velden — lege arrays alleen als echt niets van toepassing is:",
    "- tags: 10–20 korte zoek-slugs (lowercase, NL+EN mix)",
    "- persons: namen of rollen (bijv. hitler, soldier, cyclist, crowd)",
    "- locations: steden, landen, gebouwen, landmarks (berlin, reichstag, subway station)",
    "- objects: voertuigen, wapens, kleding, borden, meubels, skyline, tram",
    "- actions: wat gebeurt er (marching, speech, walking, train arriving, city traffic)",
    "- era: tijdperk (1939, 1940s, cold war, modern day, contemporary, 2020s) — schat uit beeld",
    "- setting: indoor/outdoor/street/bunker/skyline/studio/platform/rooftop",
    "- sceneType: parade/speech/cityscape/transit/interview/battle/ruins/portrait/documentary b-roll",
    "- visualDetails: kleine details (swastika flag, uniform, cobblestone, glass towers, bike lane)",
    "- mood: sfeer (triumphant, somber, busy, peaceful, propaganda)",
    "- camera: shot type (wide aerial, close-up, tracking, static, black and white archival)",
    "- colors: dominante kleuren of zwart-wit",
    "",
    "Belangrijk voor matching:",
    "- Stadsgeografie: tag modern city, skyline, transit, architecture — NIET automatisch WWII tenzij echt zichtbaar.",
    "- WWII: tag hitler/nazi/wehrmacht/parade/propaganda ALLEEN als echt in beeld.",
    "- Wees specifiek: 'berlin street traffic' is beter dan alleen 'berlin'.",
  ];
  if (frameCount > 1) {
    lines.push(`Je krijgt ${frameCount} frames uit dezelfde video — combineer tot één complete tag-set.`);
  }
  if (context.clipLabel) lines.push(`Dit is ${context.clipLabel} uit een langere video.`);
  if (context.parentFilename) lines.push(`Bronbestand: ${context.parentFilename}`);
  if (context.archiveNicheTags?.length) {
    lines.push(`Archief-onderwerp: ${context.archiveNicheTags.slice(0, 10).join(", ")}`);
  }
  if (context.userTags?.length) {
    lines.push(`Bestaande tags (aanvullen, niet herhalen tenzij relevant): ${context.userTags.join(", ")}`);
  }
  return lines.join("\n");
}

/** Vision metadata from a file on disk (no full-video buffer read). */
export async function generateArchiveAssetAiMetadataFromPath(
  filePath: string,
  mimeType: string,
  context: {
    archiveNicheTags?: string[];
    parentFilename?: string;
    userTags?: string[];
    clipLabel?: string;
  } = {}
): Promise<ArchiveAssetAiMetadata | null> {
  if (!archiveAiTaggingEnabled()) return null;
  const previews = await previewImagesFromFilePath(filePath, mimeType);
  if (previews.length === 0) return null;
  return invokeArchiveVisionTagging(previews, context);
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

  const previews = await previewImagesFromMedia(mediaBuffer, mimeType);
  if (previews.length === 0) return null;
  return invokeArchiveVisionTagging(previews, context);
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

  return applySharedAiToClipFields({
    baseTitle: opts.baseTitle,
    userTags: opts.userTags,
    sourceNote: opts.sourceNote,
    ai,
    clipIndex: opts.clipIndex,
    userProvidedTitle: opts.userProvidedTitle,
  });
}
