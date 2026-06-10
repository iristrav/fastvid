/**
 * Keep only archive clips that match the library's subject (name, description, niche tags).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import {
  extractArchiveSegmentPreviewJpegs,
  imageMimeToDataUrl,
} from "./archiveClipFilter";

const exec = promisify(execCb);

export type ArchiveSubjectContext = {
  archiveName: string;
  archiveDescription?: string | null;
  nicheTags: string[];
};

const SUBJECT_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "archive_clip_subject_check",
    strict: true,
    schema: {
      type: "object",
      properties: {
        matchesArchiveSubject: { type: "boolean" },
      },
      required: ["matchesArchiveSubject"],
      additionalProperties: false,
    },
  },
} as const;

export function archiveSubjectFilterEnabled(): boolean {
  if (process.env.ENABLE_ARCHIVE_SUBJECT_FILTER === "false") return false;
  return Boolean(ENV.forgeApiKey);
}

export function hasArchiveSubjectContext(context: ArchiveSubjectContext): boolean {
  return Boolean(context.archiveName?.trim() || context.nicheTags.length > 0);
}

export function shouldRunArchiveSubjectFilter(clipCount: number): boolean {
  if (!archiveSubjectFilterEnabled()) return false;
  const raw = process.env.ARCHIVE_SUBJECT_MAX_CLIPS?.trim();
  const max = raw ? parseInt(raw, 10) : 240;
  if (!isNaN(max) && max > 0 && clipCount > max) {
    console.warn(`[ArchiveSubject] skip subject filter for ${clipCount} clips (max ${max})`);
    return false;
  }
  return true;
}

export function buildArchiveSubjectPrompt(context: ArchiveSubjectContext): string {
  const lines = [
    "Beoordeel of dit videofragment hoort in het onderstaande documentaire-archief.",
    "",
    `Archiefnaam: ${context.archiveName.trim()}`,
  ];
  if (context.archiveDescription?.trim()) {
    lines.push(`Beschrijving: ${context.archiveDescription.trim().slice(0, 400)}`);
  }
  if (context.nicheTags.length > 0) {
    lines.push(`Niche-tags: ${context.nicheTags.slice(0, 12).join(", ")}`);
  }
  lines.push(
    "",
    "matchesArchiveSubject = true ALLEEN wanneer het beeldmateriaal duidelijk over dit archief-onderwerp gaat.",
    "",
    "matchesArchiveSubject = false wanneer het fragment:",
    "- een ander onderwerp, tijdperk of thema toont",
    "- intro/outro, credits, logo-only of filler is",
    "- generiek beeldmateriaal is zonder duidelijke link met het archief",
    "- niet past bij de archiefnaam/tags (ook bij twijfel: false)",
  );
  return lines.join("\n");
}

async function mapRangesWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldContinue?: () => boolean
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      if (shouldContinue && !shouldContinue()) return;
      const i = nextIdx;
      nextIdx += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

async function detectMatchesArchiveSubject(dataUrls: string[], context: ArchiveSubjectContext): Promise<boolean> {
  if (dataUrls.length === 0) return true;
  const timeoutMs = dataUrls.length > 1 ? 20_000 : 16_000;

  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content: "Je filtert archief-clips op onderwerp. Return alleen JSON volgens het schema.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  dataUrls.length > 1
                    ? `${buildArchiveSubjectPrompt(context)}\n\nEr zijn ${dataUrls.length} stills van hetzelfde fragment — markeer true alleen als het fragment duidelijk past.`
                    : buildArchiveSubjectPrompt(context),
              },
              ...dataUrls.map((url) => ({
                type: "image_url" as const,
                image_url: { url, detail: "low" as const },
              })),
            ],
          },
        ],
        response_format: SUBJECT_JSON_SCHEMA,
        maxTokens: 64,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("subject filter timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") return true;
    const parsed = JSON.parse(content) as { matchesArchiveSubject?: boolean };
    return Boolean(parsed.matchesArchiveSubject);
  } catch (err) {
    console.warn("[ArchiveSubject] check failed:", (err as Error).message?.slice(0, 120));
    return true;
  }
}

export async function archiveSegmentMatchesArchiveSubject(
  videoPath: string,
  startSec: number,
  endSec: number,
  context: ArchiveSubjectContext,
  opts?: { clipCount?: number; fastMode?: boolean }
): Promise<boolean> {
  if (!hasArchiveSubjectContext(context)) return true;
  if (opts?.clipCount != null && !shouldRunArchiveSubjectFilter(opts.clipCount)) return true;
  if (!archiveSubjectFilterEnabled()) return true;
  if (!fs.existsSync(videoPath)) return true;

  const fastMode = opts?.fastMode ?? (opts?.clipCount != null && opts.clipCount > 60);
  const frames = await extractArchiveSegmentPreviewJpegs(videoPath, startSec, endSec, fastMode);
  if (frames.length === 0) return true;
  const dataUrls = frames.map((buf) => imageMimeToDataUrl(buf, "image/jpeg"));
  return detectMatchesArchiveSubject(dataUrls, context);
}

export async function archiveClipMatchesArchiveSubject(
  mediaBuffer: Buffer,
  mimeType: string,
  context: ArchiveSubjectContext,
  opts?: { clipCount?: number }
): Promise<boolean> {
  if (!hasArchiveSubjectContext(context)) return true;
  if (opts?.clipCount != null && !shouldRunArchiveSubjectFilter(opts.clipCount)) return true;
  if (!archiveSubjectFilterEnabled()) return true;

  if (mimeType.startsWith("image/")) {
    return detectMatchesArchiveSubject([imageMimeToDataUrl(mediaBuffer, mimeType)], context);
  }

  if (!mimeType.startsWith("video/")) return true;

  const fastMode = opts?.clipCount != null && opts.clipCount > 60;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-subject-"));
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mov") ? "mov" : "mp4";
  const videoPath = path.join(workDir, `preview.${ext}`);
  try {
    fs.writeFileSync(videoPath, mediaBuffer);
    const dur = await probeVideoDurationSec(videoPath);
    const startSec = 0;
    const endSec = dur > 0 ? dur : 1;
    return archiveSegmentMatchesArchiveSubject(videoPath, startSec, endSec, context, {
      clipCount: opts?.clipCount,
      fastMode,
    });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function filterClipRangesByArchiveSubject(
  videoPath: string,
  ranges: Array<{ start: number; end: number }>,
  context: ArchiveSubjectContext,
  opts?: {
    onProgress?: (kept: number, total: number, skipped: number) => void;
    shouldContinue?: () => boolean;
  }
): Promise<Array<{ start: number; end: number }>> {
  if (!hasArchiveSubjectContext(context) || !shouldRunArchiveSubjectFilter(ranges.length)) {
    return ranges;
  }

  const fastMode = ranges.length > 60;
  const flags = await mapRangesWithConcurrency(
    ranges,
    3,
    async (range) => {
      if (opts?.shouldContinue && !opts.shouldContinue()) return null;
      const ok = await archiveSegmentMatchesArchiveSubject(
        videoPath,
        range.start,
        range.end,
        context,
        { clipCount: ranges.length, fastMode }
      );
      return ok ? range : null;
    },
    opts?.shouldContinue
  );

  const kept = flags.filter((r): r is { start: number; end: number } => r != null);
  const skipped = ranges.length - kept.length;
  opts?.onProgress?.(kept.length, ranges.length, skipped);
  if (skipped > 0) {
    console.log(
      `[ArchiveSubject] kept ${kept.length}/${ranges.length} ranges for "${context.archiveName}" (${skipped} off-topic)`
    );
  }
  return kept;
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
