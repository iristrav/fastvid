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
import {
  appendMapLabelsToSourceNote,
  extractGeoSlugsFromVisionPayload,
  mergeGeoSlugsIntoArchiveTags,
} from "./archiveGeoTagging";

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
  countries?: string[];
  cities?: string[];
  events?: string[];
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
  /** Readable place names on maps/diagrams (OCR-style). */
  mapLabels?: string[];
  /** Any visible on-screen text (signs, captions, map titles). */
  visibleTextOnScreen?: string[];
};

const TAG_JSON_SCHEMA_PROPERTIES = {
  title: { type: "string" },
  description: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
  persons: { type: "array", items: { type: "string" } },
  countries: { type: "array", items: { type: "string" } },
  cities: { type: "array", items: { type: "string" } },
  events: { type: "array", items: { type: "string" } },
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
  mapLabels: { type: "array", items: { type: "string" } },
  visibleTextOnScreen: { type: "array", items: { type: "string" } },
} as const;

/** Full schema — used for single-clip uploads (strict, all fields). */
const TAG_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "archive_asset_tags",
    strict: true,
    schema: {
      type: "object",
      properties: TAG_JSON_SCHEMA_PROPERTIES,
      required: Object.keys(TAG_JSON_SCHEMA_PROPERTIES),
      additionalProperties: false,
    },
  },
} as const;

/** Lighter schema for bulk retitle — strict json_schema often fails with vision on OpenAI. */
const TAG_JSON_SCHEMA_LIGHT = {
  type: "json_schema" as const,
  json_schema: {
    name: "archive_asset_tags_light",
    strict: true,
    schema: {
      type: "object",
      properties: TAG_JSON_SCHEMA_PROPERTIES,
      required: ["title", "description", "tags"],
      additionalProperties: false,
    },
  },
} as const;

/** Minimal schema for bulk — only title + description + exactly 4 tags (most reliable). */
const TAG_JSON_SCHEMA_MINIMAL = {
  type: "json_schema" as const,
  json_schema: {
    name: "archive_clip_four_tags",
    strict: true,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4,
        },
      },
      required: ["title", "description", "tags"],
      additionalProperties: false,
    },
  },
} as const;

/** Max searchable tags stored per asset (pipeline + semantic matching). Geo slugs prioritized. */
export const ARCHIVE_MAX_TAGS = 6;

/** Vision LLM timeout — quality over speed; override via env. */
function archiveVisionTimeoutMs(frameCount: number): number {
  const fromEnv = parseInt(process.env.ARCHIVE_AI_TAG_TIMEOUT_MS ?? "", 10);
  if (!isNaN(fromEnv) && fromEnv >= 15_000) return fromEnv;
  return frameCount > 2 ? 90_000 : frameCount > 1 ? 75_000 : 55_000;
}

export function archiveAiTaggingEnabled(): boolean {
  return process.env.ENABLE_ARCHIVE_AI_TAGS !== "false" && Boolean(ENV.forgeApiKey);
}

export function mergeArchiveTags(userTags: string[], aiTags: string[]): string[] {
  return normalizeMediaTags([...aiTags, ...userTags]).slice(0, ARCHIVE_MAX_TAGS);
}

const VAGUE_ARCHIVE_TAG_RE =
  /\b(man|woman|person|people|leader|city|street|urban|historical|modern|busy|outdoor|indoor|scene|footage|video|clip|documentary|generic|abstract|success|growth|strategy|business|company|building|day|night)\b/i;

function isSpecificArchiveTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  if (normalized.length < 3) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1 && VAGUE_ARCHIVE_TAG_RE.test(normalized)) return false;
  return true;
}

/** Pick up to 4 concrete English search tags for archive/Pexels matching. */
export function selectHighQualityArchiveTags(parsed: ArchiveAiVisionPayload): string[] {
  const picked: string[] = [];
  const push = (raw: string | undefined | null) => {
    const v = raw?.trim().toLowerCase().replace(/\s+/g, " ");
    if (!v || !isSpecificArchiveTag(v)) return;
    if (picked.includes(v)) return;
    picked.push(v);
  };

  for (const tag of parsed.tags ?? []) {
    push(tag);
    if (picked.length >= ARCHIVE_MAX_TAGS) break;
  }

  const person = parsed.persons?.[0];
  const city = parsed.cities?.[0];
  const country = parsed.countries?.[0];
  const event = parsed.events?.[0];
  const action = parsed.actions?.[0];
  const object = parsed.objects?.[0];
  const location = parsed.locations?.[0];
  const sceneType = parsed.sceneType;

  if (person && action) push(`${person} ${action}`);
  else if (person) push(person);

  if (city && country && city !== country) push(`${city} ${country}`);
  else if (city) push(city);
  else if (country) push(country);

  if (event) push(event);
  if (location) push(location);
  if (action && !person) push(action);
  if (object) push(object);
  if (sceneType) push(sceneType);

  for (const tag of parsed.tags ?? []) {
    push(tag);
    if (picked.length >= ARCHIVE_MAX_TAGS) break;
  }

  return normalizeMediaTags(picked).slice(0, ARCHIVE_MAX_TAGS);
}

/** Ensure we store up to 4 tags even when the model returns fewer valid ones. */
function padArchiveTags(
  tags: string[],
  parsed: ArchiveAiVisionPayload,
  title: string
): string[] {
  const out = [...tags];
  const push = (raw: string | undefined | null) => {
    const v = raw?.trim().toLowerCase().replace(/\s+/g, " ");
    if (!v || v.length < 3 || out.includes(v)) return;
    out.push(v);
  };

  for (const tag of parsed.tags ?? []) {
    push(tag);
    if (out.length >= ARCHIVE_MAX_TAGS) break;
  }
  if (out.length < ARCHIVE_MAX_TAGS) {
    for (const w of title.split(/\s+/)) {
      if (w.length >= 4) push(w);
      if (out.length >= ARCHIVE_MAX_TAGS) break;
    }
  }
  return normalizeMediaTags(out).slice(0, ARCHIVE_MAX_TAGS);
}

export function truncateArchiveSourceNote(note: string | null | undefined): string | null {
  if (!note?.trim()) return null;
  return note.trim().slice(0, 512);
}


function deriveArchiveTitle(parsed: ArchiveAiVisionPayload): string {
  const direct = parsed.title?.trim();
  if (direct) return direct.slice(0, 160);

  const fromDescription = parsed.description?.trim().split(/[.!?]/)[0]?.trim();
  if (fromDescription && fromDescription.length >= 8) return fromDescription.slice(0, 160);

  const bits = [
    parsed.persons?.[0],
    parsed.cities?.[0],
    parsed.countries?.[0],
    parsed.events?.[0],
    parsed.sceneType,
    parsed.tags?.[0],
  ].filter(Boolean);
  if (bits.length > 0) return bits.join(" — ").slice(0, 160);

  const firstTag = parsed.tags?.[0]?.trim();
  if (firstTag) return firstTag.slice(0, 160);

  return "";
}

/** Flatten structured vision JSON into searchable tags + rich description. */
export function flattenArchiveAiMetadata(parsed: ArchiveAiVisionPayload): ArchiveAssetAiMetadata | null {
  const title = deriveArchiveTitle(parsed);
  if (!title) return null;

  let tags = selectHighQualityArchiveTags(parsed);
  const geoSlugs = extractGeoSlugsFromVisionPayload(parsed);
  tags = mergeGeoSlugsIntoArchiveTags(tags, geoSlugs, ARCHIVE_MAX_TAGS);
  tags = padArchiveTags(tags, parsed, title);
  if (tags.length === 0) {
    tags = normalizeMediaTags(title.split(/\s+/).filter((w) => w.length > 3)).slice(0, ARCHIVE_MAX_TAGS);
  }
  if (tags.length === 0) return null;

  const detailBits = [
    parsed.description?.trim(),
    parsed.persons?.length ? `People: ${parsed.persons.slice(0, 6).join(", ")}` : "",
    parsed.countries?.length ? `Countries: ${parsed.countries.slice(0, 4).join(", ")}` : "",
    parsed.cities?.length ? `Cities: ${parsed.cities.slice(0, 6).join(", ")}` : "",
    parsed.events?.length ? `Events: ${parsed.events.slice(0, 4).join(", ")}` : "",
    parsed.locations?.length ? `Places: ${parsed.locations.slice(0, 6).join(", ")}` : "",
    parsed.setting?.trim() ? `Setting: ${parsed.setting.trim()}` : "",
    parsed.era?.trim() ? `Era: ${parsed.era.trim()}` : "",
    parsed.sceneType?.trim() ? `Scene: ${parsed.sceneType.trim()}` : "",
    parsed.actions?.length ? `Actions: ${parsed.actions.slice(0, 6).join(", ")}` : "",
    parsed.visualDetails?.length ? `Details: ${parsed.visualDetails.slice(0, 8).join(", ")}` : "",
    parsed.mapLabels?.length ? `Map labels: ${parsed.mapLabels.slice(0, 8).join(", ")}` : "",
    parsed.visibleTextOnScreen?.length
      ? `On-screen text: ${parsed.visibleTextOnScreen.slice(0, 6).join(", ")}`
      : "",
  ].filter(Boolean);

  let description = detailBits.join(" | ").slice(0, 500) || title;
  description =
    appendMapLabelsToSourceNote(description, parsed.mapLabels, geoSlugs)?.slice(0, 512) ?? description;
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
  /** Bulk retitle: replace stored tags with AI tags only (do not merge old tag noise). */
  replaceTags?: boolean;
}): { title: string; tags: string[]; sourceNote: string | null } {
  let title = opts.baseTitle;
  let tags = opts.replaceTags
    ? normalizeMediaTags(opts.ai.tags).slice(0, ARCHIVE_MAX_TAGS)
    : mergeArchiveTags(opts.userTags, opts.ai.tags);
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

function extractLlmTextContent(
  content: string | Array<{ type: string; text?: string }> | null | undefined
): string | null {
  if (!content) return null;
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  return null;
}

function parseJsonFromLlmContent(raw: string): ArchiveAiVisionPayload {
  const trimmed = raw.trim();
  let parsed: ArchiveAiVisionPayload;
  try {
    parsed = JSON.parse(trimmed) as ArchiveAiVisionPayload;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      parsed = JSON.parse(fenced[1].trim()) as ArchiveAiVisionPayload;
    } else {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("LLM response did not contain JSON");
      parsed = JSON.parse(trimmed.slice(start, end + 1)) as ArchiveAiVisionPayload;
    }
  }
  parsed.tags = coerceVisionTags(parsed.tags);
  return parsed;
}

function coerceVisionTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (typeof item !== "string") return [];
      return item
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    });
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function ffmpegBin(): string {
  const fromEnv = process.env.FFMPEG_BIN?.trim() || process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== "win32") {
    for (const candidate of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "ffmpeg";
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
      const args = [
        "-y",
        "-ss",
        seek.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-f",
        "image2",
        outPath,
      ];
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
      }, 25_000);
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

/** Sample frames across the clip — bulk mode uses fewer frames for speed and token limits. */
async function extractVideoPreviewFrames(
  videoPath: string,
  workDir: string,
  maxFrames = 5
): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  const dur = await probeVideoDurationSec(videoPath);
  const ratioSets =
    dur > 12
      ? [0.08, 0.25, 0.42, 0.58, 0.75]
      : dur > 6
        ? [0.1, 0.32, 0.55, 0.78]
        : dur > 2
          ? [0.12, 0.42, 0.72]
          : dur > 1
            ? [0.2, 0.6]
            : [0.35];
  const ratios = ratioSets.slice(0, Math.max(1, Math.min(maxFrames, ratioSets.length)));
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
  const mime = normalizeOpenAiVisionMime(mimeType);
  const safeMime = OPENAI_VISION_MIMES.has(mime) ? mime : "image/jpeg";
  return `data:${safeMime};base64,${buffer.toString("base64")}`;
}

const OPENAI_VISION_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function normalizeOpenAiVisionMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase().split(";")[0]!.trim();
  if (lower === "image/jpg" || lower === "image/pjpeg") return "image/jpeg";
  if (lower.startsWith("image/")) return lower;
  return "image/jpeg";
}

function detectImageMimeFromBuffer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function extForVisionMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

function looksLikeVideoContainer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}

async function convertBufferToJpegWithFfmpeg(buffer: Buffer, inputExt: string): Promise<Buffer | null> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ai-img-"));
  const inPath = path.join(workDir, `input.${inputExt}`);
  const outPath = path.join(workDir, "output.jpg");
  try {
    fs.writeFileSync(inPath, buffer);
    await new Promise<void>((resolve, reject) => {
      const args = ["-y", "-i", inPath, "-frames:v", "1", "-q:v", "3", outPath];
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
        reject(new Error("image convert timeout"));
      }, 25_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 100) resolve();
        else reject(new Error(stderr.slice(-120) || `ffmpeg exit ${code}`));
      });
      child.on("error", reject);
    });
    return fs.readFileSync(outPath);
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** OpenAI vision only accepts png/jpeg/gif/webp — detect real format and re-encode if needed. */
async function ensureOpenAiVisionPreview(
  preview: { buffer: Buffer; mimeType: string },
  sourceExt?: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (preview.buffer.length < 64) return null;

  const detected = detectImageMimeFromBuffer(preview.buffer);
  if (detected && OPENAI_VISION_MIMES.has(detected)) {
    return { buffer: preview.buffer, mimeType: detected };
  }

  const ext =
    (detected ? extForVisionMime(detected) : null) ??
    sourceExt ??
    extForVisionMime(normalizeOpenAiVisionMime(preview.mimeType));

  const converted = await convertBufferToJpegWithFfmpeg(preview.buffer, ext);
  if (converted && detectImageMimeFromBuffer(converted) === "image/jpeg") {
    return { buffer: converted, mimeType: "image/jpeg" };
  }
  return null;
}

async function previewImagesFromFilePath(
  filePath: string,
  mimeType: string,
  maxFrames = 5
): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  if (mimeType.startsWith("image/")) {
    if (!fs.existsSync(filePath)) return [];
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 64) return [];
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase() || extForVisionMime(mimeType);
    const ready = await ensureOpenAiVisionPreview({ buffer, mimeType }, ext);
    if (ready) return [ready];
    if (looksLikeVideoContainer(buffer)) {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ai-frames-"));
      try {
        return await extractVideoPreviewFrames(filePath, workDir, maxFrames);
      } finally {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
    return [];
  }
  if (!mimeType.startsWith("video/")) return [];

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-ai-frames-"));
  try {
    return await extractVideoPreviewFrames(filePath, workDir, maxFrames);
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
    const ready = await ensureOpenAiVisionPreview({ buffer: mediaBuffer, mimeType });
    return ready ? [ready] : [];
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
  },
  opts: { imageDetail?: "auto" | "low" | "high"; preferJsonObject?: boolean; bulk?: boolean } = {}
): Promise<{ metadata: ArchiveAssetAiMetadata | null; error?: string }> {
  if (previews.length === 0) return { metadata: null, error: "No preview frames extracted" };
  const readyPreviews: Array<{ buffer: Buffer; mimeType: string }> = [];
  for (const preview of previews) {
    const ready = await ensureOpenAiVisionPreview(preview);
    if (ready) readyPreviews.push(ready);
  }
  if (readyPreviews.length === 0) {
    return {
      metadata: null,
      error: "Preview images could not be encoded for vision AI (unsupported format)",
    };
  }
  const timeoutMs = archiveVisionTimeoutMs(readyPreviews.length);
  const imageDetail = opts.imageDetail ?? (readyPreviews.length > 2 ? "low" : "high");
  type VisionFormat =
    | typeof TAG_JSON_SCHEMA
    | typeof TAG_JSON_SCHEMA_LIGHT
    | typeof TAG_JSON_SCHEMA_MINIMAL
    | { type: "json_object" };
  const formats: VisionFormat[] = opts.bulk
    ? [{ type: "json_object" }, TAG_JSON_SCHEMA_MINIMAL]
    : opts.preferJsonObject
      ? [{ type: "json_object" }, TAG_JSON_SCHEMA_LIGHT, { type: "json_object" }]
      : [TAG_JSON_SCHEMA_LIGHT, { type: "json_object" }, TAG_JSON_SCHEMA];

  const imageParts = readyPreviews.map((preview) => ({
    type: "image_url" as const,
    image_url: { url: imageMimeToDataUrl(preview.buffer, preview.mimeType), detail: imageDetail },
  }));

  const runOnce = async (responseFormat: VisionFormat): Promise<ArchiveAssetAiMetadata | null> => {
    const payload: Parameters<typeof invokeLLM>[0] = {
      messages: [
        {
          role: "system",
          content:
            "You are a senior documentary archivist. Analyze each frame and return JSON only. " +
            "Provide exactly 4 high-quality English search tags per clip — concrete visible subjects for stock/archive search, not vague words.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionPrompt(context, readyPreviews.length, opts.bulk) },
            ...imageParts,
          ],
        },
      ],
      maxTokens: opts.bulk ? 900 : 1600,
    };
    if (responseFormat.type === "json_object") {
      payload.response_format = { type: "json_object" };
    } else {
      payload.response_format = responseFormat;
    }

    const response = await Promise.race([
      invokeLLM(payload),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("archive AI tag timeout")), timeoutMs)
      ),
    ]);

    const raw = extractLlmTextContent(response.choices[0]?.message?.content);
    if (!raw) {
      console.warn("[ArchiveAI] vision returned empty content");
      return null;
    }
    const parsed = parseJsonFromLlmContent(raw);
    const flat = flattenArchiveAiMetadata(parsed);
    if (!flat) {
      console.warn(
        "[ArchiveAI] vision JSON parsed but no usable title/tags",
        parsed.title?.slice(0, 40),
        (parsed.tags ?? []).slice(0, 4).join(", ")
      );
    } else {
      console.log(
        `[ArchiveAI] tags (${flat.tags.length}): ${flat.tags.join(" | ")} ← ${flat.title.slice(0, 50)}`
      );
    }
    return flat;
  };

  try {
    let result: ArchiveAssetAiMetadata | null = null;
    let lastError: string | undefined;
    for (const format of formats) {
      try {
        result = await runOnce(format);
        if (result) break;
      } catch (err) {
        lastError = (err as Error).message?.slice(0, 220);
        console.warn("[ArchiveAI] vision attempt failed:", lastError);
      }
    }
    return {
      metadata: result,
      error: result ? undefined : lastError ?? "Vision model returned no usable metadata",
    };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 220) ?? "Vision tagging failed";
    console.warn("[ArchiveAI] tagging failed:", message);
    return { metadata: null, error: message };
  }
}

function buildVisionPrompt(
  context: {
    archiveNicheTags?: string[];
    parentFilename?: string;
    userTags?: string[];
    clipLabel?: string;
  },
  frameCount = 1,
  bulk = false
): string {
  if (bulk) {
    const lines = [
      "Analyze this archive clip for documentary B-roll search.",
      "",
      "Return JSON with:",
      "- title: max 15 words, concrete WHO/WHAT/WHERE in English",
      "- description: 1–2 sentences describing what is visible",
      "- tags: EXACTLY 4 English search phrases (lowercase, 2–4 words each)",
      "",
      "Tag examples: amsterdam canal bikes | subway platform berlin | business meeting team | cyclists rain street",
      "Avoid vague single words: person, city, success, business, modern, historical.",
      "Prefer concrete visuals: place + activity, or subject + action.",
    ];
    if (frameCount > 1) {
      lines.push(`You receive ${frameCount} frames from the same video — one combined result.`);
    }
    if (context.clipLabel) lines.push(`Clip: ${context.clipLabel}.`);
    if (context.archiveNicheTags?.length) {
      lines.push(`Archive topic: ${context.archiveNicheTags.slice(0, 8).join(", ")}.`);
    }
    return lines.join("\n");
  }

  const lines = [
    "Analyze this clip for a documentary media archive.",
    "",
    "title: max 15 words, concrete WHO/WHAT/WHERE (e.g. 'Amsterdam cyclists on canal bridge' or 'Hitler speech at Nuremberg rally'). No filename.",
    "description: 2–3 sentences: visible action + location + era if recognizable.",
    "",
    "tags: EXACTLY 4 high-quality English search slugs (lowercase). These are the most important output.",
    "Each tag must be concrete and visually searchable — optimized for Pexels and archive matching.",
    "Examples: amsterdam cyclists rain | business meeting team | subway platform berlin | entrepreneur working laptop",
    "Do NOT use vague tags alone: person, people, city, street, success, growth, strategy, business, company, modern, historical.",
    "",
    "Also fill structured fields to support title/description (arrays can be short):",
    "- persons, countries, cities, events, locations, objects, actions, era, setting, sceneType",
    "- mapLabels: every readable place name on maps/diagrams (e.g. Philadelphia, Kansas City, Singapore)",
    "- visibleTextOnScreen: signs, captions, map titles, street names visible in frame",
    "",
    "Rules:",
    "- If the frame shows a MAP or historical diagram, list ALL readable city/country names in mapLabels.",
    "- Wrong geography on a map must still be tagged (e.g. Philadelphia map → mapLabels: [Philadelphia, Pennsylvania]).",
    "- Prefer specific combinations: 'amsterdam canal bikes' over separate tags 'amsterdam' + 'city'.",
    "- Name exact people/places/events only when clearly visible.",
    "- Tag visible place + activity when recognizable (city, landmark, sport, vehicle, building).",
    "- Never tag only generic words (city, street, people) — always pair with place or activity.",
  ];
  if (frameCount > 1) {
    lines.push(`You receive ${frameCount} frames from the same video — combine into one complete tag set.`);
  }
  if (context.clipLabel) lines.push(`This is ${context.clipLabel} from a longer video.`);
  if (context.parentFilename) lines.push(`Source file: ${context.parentFilename}`);
  if (context.archiveNicheTags?.length) {
    lines.push(`Archive subject: ${context.archiveNicheTags.slice(0, 10).join(", ")}`);
  }
  if (context.userTags?.length) {
    lines.push(`Existing tags (add to these, do not repeat unless relevant): ${context.userTags.join(", ")}`);
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
  } = {},
  opts: { maxFrames?: number; imageDetail?: "auto" | "low" | "high"; bulk?: boolean } = {}
): Promise<{ metadata: ArchiveAssetAiMetadata | null; frameCount: number; error?: string }> {
  if (!archiveAiTaggingEnabled()) {
    return { metadata: null, frameCount: 0, error: "AI tagging disabled" };
  }
  const maxFrames = opts.maxFrames ?? (opts.bulk ? 1 : 5);
  const previews = await previewImagesFromFilePath(filePath, mimeType, maxFrames);
  if (previews.length === 0) {
    return { metadata: null, frameCount: 0, error: "Could not extract preview frames (FFmpeg)" };
  }
  const vision = await invokeArchiveVisionTagging(previews, context, {
    imageDetail: opts.imageDetail ?? (opts.bulk ? "low" : "high"),
    preferJsonObject: opts.bulk,
    bulk: opts.bulk,
  });
  return { metadata: vision.metadata, frameCount: previews.length, error: vision.error };
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
  const { metadata } = await invokeArchiveVisionTagging(previews, context);
  return metadata;
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
