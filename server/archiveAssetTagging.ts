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
      },
      required: [
        "title",
        "description",
        "tags",
        "persons",
        "countries",
        "cities",
        "events",
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
export const ARCHIVE_MAX_TAGS = 56;

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
  const title = parsed.title?.trim().slice(0, 160);
  if (!title) return null;

  const tagParts: string[] = [];
  // Identity tags first so they survive the cap when many visual details exist.
  pushTags(tagParts, parsed.persons);
  pushTags(tagParts, parsed.countries);
  pushTags(tagParts, parsed.cities);
  pushTags(tagParts, parsed.events);
  pushTags(tagParts, parsed.locations);
  pushTags(tagParts, parsed.tags);
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
  try {
    return JSON.parse(trimmed) as ArchiveAiVisionPayload;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim()) as ArchiveAiVisionPayload;
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as ArchiveAiVisionPayload;
    }
    throw new Error("LLM response did not contain JSON");
  }
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
  const mime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
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
    return [{ buffer, mimeType }];
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
  },
  opts: { imageDetail?: "auto" | "low" | "high" } = {}
): Promise<{ metadata: ArchiveAssetAiMetadata | null; error?: string }> {
  if (previews.length === 0) return { metadata: null, error: "No preview frames extracted" };
  const timeoutMs = archiveVisionTimeoutMs(previews.length);
  const imageDetail = opts.imageDetail ?? (previews.length > 2 ? "low" : "high");

  const imageParts = previews.map((preview) => ({
    type: "image_url" as const,
    image_url: { url: imageMimeToDataUrl(preview.buffer, preview.mimeType), detail: imageDetail },
  }));

  const runOnce = async (
    responseFormat: typeof TAG_JSON_SCHEMA | { type: "json_object" }
  ): Promise<ArchiveAssetAiMetadata | null> => {
    const payload: Parameters<typeof invokeLLM>[0] = {
      messages: [
        {
          role: "system",
          content:
            "You are a senior documentary archivist and historian. Analyze each frame carefully. Precision over speed: name exact people, countries, cities, and historical events when recognizable. Return JSON only.",
        },
        {
          role: "user",
          content: [{ type: "text", text: buildVisionPrompt(context, previews.length) }, ...imageParts],
        },
      ],
      maxTokens: 1600,
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
    if (!raw) return null;
    return flattenArchiveAiMetadata(parseJsonFromLlmContent(raw));
  };

  try {
    let result = await runOnce(TAG_JSON_SCHEMA);
    if (!result) {
      console.warn("[ArchiveAI] empty metadata, retrying vision once");
      result = await runOnce(TAG_JSON_SCHEMA);
    }
    if (!result) {
      console.warn("[ArchiveAI] strict schema empty, retrying with json_object");
      result = await runOnce({ type: "json_object" });
    }
    return { metadata: result, error: result ? undefined : "Vision model returned no usable metadata" };
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
  frameCount = 1
): string {
  const lines = [
    "Describe EVERYTHING you see for a documentary archive. Take your time — precise identification matters more than speed.",
    "",
    "title: max 15 words, concrete WHO/WHAT/WHERE (e.g. 'Adolf Hitler speech at Nuremberg rally' or 'Berlin Alexanderplatz tram traffic'). No filename.",
    "description: 2–3 sentences: action + exact location + era + event if recognizable.",
    "",
    "IDENTITY — fill as precisely as possible (recognizable names, not vague terms):",
    "- persons: full names or unique roles (adolf hitler, winston churchill, german soldier, berlin commuter). Not 'man' or 'leader' if you know who it is.",
    "- countries: country names (germany, united states, france, soviet union). Always explicit country, not just 'europe'.",
    "- cities: city names (berlin, nuremberg, paris, new york). Always explicit city when visible or inferable.",
    "- events: historical events (nuremberg rally, battle of berlin, berlin wall fall, d-day, cold war). Only when appropriate to the image.",
    "",
    "OTHER — fill ALL fields; empty arrays only when truly not applicable:",
    "- tags: 15–25 search slugs (lowercase, English), including person+place+event combinations",
    "- locations: landmarks, buildings, regions (reichstag, alexanderplatz, brandenburg gate, u-bahn)",
    "- objects: vehicles, uniforms, flags, signs, weapons, skyline, tram",
    "- actions: marching, speech, salute, city traffic, train arriving, evacuation",
    "- era: exact year/decade (1936, 1940s, 1989, modern day, 2020s)",
    "- setting: indoor/outdoor/street/stadium/bunker/skyline/platform",
    "- sceneType: parade/speech/cityscape/transit/battle/ruins/portrait/propaganda",
    "- visualDetails: swastika flag, wehrmacht uniform, cobblestone, glass towers",
    "- mood: triumphant, somber, busy, propaganda, peaceful",
    "- camera: wide aerial, close-up, tracking, black and white archival",
    "- colors: dominant colors or black and white",
    "",
    "Rules:",
    "- Urban geography: tag modern city, skyline, transit — no WWII unless truly visible.",
    "- WWII: hitler/nazi/wehrmacht ONLY when truly on screen; then also name country, city, and event.",
    "- Prefer too specific over too vague: 'adolf hitler nuremberg 1936' > 'historical figure'.",
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
  const maxFrames = opts.maxFrames ?? (opts.bulk ? 2 : 5);
  const previews = await previewImagesFromFilePath(filePath, mimeType, maxFrames);
  if (previews.length === 0) {
    return { metadata: null, frameCount: 0, error: "Could not extract preview frames (FFmpeg)" };
  }
  const vision = await invokeArchiveVisionTagging(previews, context, {
    imageDetail: opts.imageDetail ?? (opts.bulk ? "low" : "high"),
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
