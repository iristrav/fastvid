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

/**
 * RONDE 26: image formats the vision models actually accept.
 *
 * Renders 517-527 logged 38 failures of the shape
 *   [ArchiveFilter] overlay check failed: LLM invoke failed (openai, model=gpt-4o):
 *   400 Bad Request – "You uploaded an unsupported image"
 * and, because this detector fails OPEN, each one silently admitted a clip that was never
 * examined. The cause is upstream of the model: imageMimeToDataUrl used to forward ANY
 * `image/*` label verbatim, and archive sources routinely serve tiff, svg, bmp and heic —
 * none of which the vision endpoints accept.
 */
const VISION_SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/** Bare mime type, lowercased, with any `; charset=…` parameters stripped. */
function bareMime(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(";")[0]!.trim();
}

export function isVisionSupportedImageMime(mimeType: string): boolean {
  return VISION_SUPPORTED_IMAGE_MIMES.has(bareMime(mimeType));
}

export function imageMimeToDataUrl(buffer: Buffer, mimeType: string): string {
  // Only ever emit a label the vision endpoints know. Callers that may hold an exotic format
  // must run it through prepareImageForVision first — this is the last line of defence, and it
  // corrects a wrong LABEL on right BYTES, not the other way round.
  const bare = bareMime(mimeType);
  const mime = VISION_SUPPORTED_IMAGE_MIMES.has(bare) ? bare : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Make image bytes safe to hand to a vision model: pass supported formats through untouched,
 * transcode anything else to JPEG with ffmpeg, and give up cleanly when that is not possible.
 *
 * Returning null means "do not call the model" — the caller then fails open exactly as it did
 * before, but without spending a request that is certain to come back 400.
 */
export async function prepareImageForVision(
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  // Too short to even carry a format signature. No size floor beyond that: a 35-byte GIF is a
  // real image, and it is the SNIFF, not the length, that decides whether this is sendable.
  if (buffer.length < 12) return null;

  // The declared mime is only a hint — archive sources mislabel constantly, in both directions.
  // Trust the bytes: a JPEG announced as image/tiff needs no conversion, and a TIFF announced as
  // image/jpeg very much does. (archiveAssetTagging already learned this the same way.)
  const detected = detectImageMimeFromBuffer(buffer);
  if (detected && VISION_SUPPORTED_IMAGE_MIMES.has(detected)) {
    return { buffer, mimeType: detected };
  }

  const declared = bareMime(mimeType);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-img-"));
  try {
    const srcPath = path.join(workDir, `source${extensionForImageMime(declared)}`);
    const outPath = path.join(workDir, "converted.jpg");
    fs.writeFileSync(srcPath, buffer);
    // -frames:v 1 keeps multi-page TIFFs and animated formats to a single still.
    const ok = await runFfmpegToJpeg(srcPath, outPath);
    if (!ok) {
      console.warn(
        `[ArchiveFilter] cannot convert image (declared=${declared}, detected=${detected ?? "unknown"}) — skipping check`
      );
      return null;
    }
    return { buffer: fs.readFileSync(outPath), mimeType: "image/jpeg" };
  } catch (err) {
    console.warn(
      `[ArchiveFilter] image conversion failed for ${declared}:`,
      (err as Error).message?.slice(0, 120)
    );
    return null;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Format from the file's magic bytes, or null when it is none of the vision-safe four. */
export function detectImageMimeFromBuffer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function extensionForImageMime(bare: string): string {
  const sub = bare.startsWith("image/") ? bare.slice("image/".length) : "";
  // ffmpeg picks its demuxer from content, but a plausible extension helps the odd container.
  return /^[a-z0-9+.-]{1,12}$/.test(sub) ? `.${sub.replace(/[+.]/g, "")}` : ".img";
}

function runFfmpegToJpeg(srcPath: string, outPath: string): Promise<boolean> {
  return ffmpegSemaphore
    .run(() =>
      withForkRetry(
        () =>
          new Promise<void>((resolve, reject) => {
            const args = ["-y", "-i", srcPath, "-frames:v", "1", "-q:v", "3", outPath];
            const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
            const timer = setTimeout(() => {
              try { child.kill("SIGKILL"); } catch { /* ignore */ }
              reject(new Error("image convert timeout"));
            }, 15_000);
            child.on("close", (code) => {
              clearTimeout(timer);
              if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 800) resolve();
              else reject(new Error(stderr.slice(-120) || `ffmpeg exit ${code}`));
            });
            child.on("error", reject);
          })
      )
    )
    .then(() => true)
    .catch(() => false);
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
/**
 * RONDE 66: the axis is where the text came from, not how big it is.
 *
 * This prompt used to reject only DOMINANT text, and said in as many words that lower thirds,
 * burnt-in subtitles, captions, headlines and watermarks were no reason to refuse a clip. In
 * render 532 it therefore fired 3 times out of 35, while the beat-image gate — looking at the
 * same footage with a different question — kept reporting exactly what this was supposed to
 * catch: "Title card with text 'History Excursion' and flames", "Propaganda or newsreel title
 * card with text 'Soviet Fights Back!'", "An academic article titled 'Physician Suicide'".
 *
 * Size was the wrong test. A small modern subtitle burnt into archive footage is as wrong as a
 * big one; a large newspaper headline the camera is pointed AT is the documentary itself. What
 * separates them is whether the text was added in post or was physically in front of the lens —
 * which is a question a picture editor answers instantly, and a size threshold never can.
 */
const OVERLAY_PROMPT = `Beoordeel deze videostill(s) voor een documentaire-archief.

De vraag is NIET hoe groot de tekst is, maar waar hij vandaan komt: is hij ACHTERAF TOEGEVOEGD
(in de montage, door een omroep, door een uploader), of stond hij ECHT VOOR DE CAMERA?

hasBakedEditText = true — tekst die achteraf over het beeld is gelegd, hoe klein ook:
- titelkaarten, chapter cards, intro- of outrotekst, aftiteling
- ingebakken ondertitels of captions, ook kleine, ook in de taal van de narratie
- lower thirds, naambalken, nieuwstickers, omroeplogo's, kanaalbranding
- watermerken, uploader-handtekeningen, "subscribe"-oproepen, URL's of social-media-namen
- een schermafdruk van een webpagina, een document, een artikel of een presentatie
- bewerkingssoftware in beeld (DaVinci, Premiere, etc.)
- een aftelklok of leader met cijfers

hasBakedEditText = false — tekst die deel is van de opgenomen werkelijkheid:
- een krant, boek of brief die iemand vasthoudt of die gefilmd wordt
- een straatnaambord, winkelpui, spandoek, affiche of opschrift op een gebouw of voertuig
- een historische kaart, plattegrond of document dat het onderwerp van de opname is
- opschriften op uniformen, vliegtuigen, tanks of machines
En uiteraard false wanneer er helemaal geen tekst in beeld is.

Bij twijfel over de herkomst: kijk of de tekst meebeweegt met het beeld (dan stond hij er echt)
of vaststaat over een bewegend beeld heen (dan is hij toegevoegd).`;

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
/**
 * RONDE 24: process-wide memo of overlay verdicts, keyed by caller-supplied content identity.
 *
 * The same source asset is examined by several places in one render — the per-beat vision gate
 * (RONDE 23) and, if it wins, the archive ingestion below — and it reaches them under different
 * temporary filenames while the pixels are identical. Without a shared memo each of those is a
 * separate vision call for the same footage. Living here rather than in videoPipeline keeps it
 * usable from archiveIngestion too, which cannot import videoPipeline (that module imports IT).
 */
const overlayVerdictCache = new Map<string, boolean>();

/**
 * RONDE 25: how many cache MISSES (i.e. real vision calls) have been spent since the last reset.
 * Callers pass a ceiling; past it the check is skipped rather than run. Counting misses rather
 * than calls is what keeps re-offering the same asset to many beats free.
 */
let overlayChecksPerformed = 0;

/**
 * Start a fresh overlay budget. Called once per render so one expensive render cannot spend the
 * next one's allowance, and so the memo does not grow without bound across a long-lived worker.
 */
export function resetOverlayBudget(): void {
  overlayVerdictCache.clear();
  overlayChecksPerformed = 0;
}

/** Test seam: clear the shared overlay memo between cases. */
export function __resetOverlayVerdictCacheForTest(): void {
  resetOverlayBudget();
}

/** Vision calls actually spent since the last reset — for logging and tests. */
export function overlayChecksSpent(): number {
  return overlayChecksPerformed;
}

/**
 * archiveClipHasBakedEditText, memoised on `cacheKey`. Fails OPEN (treats the clip as clean) when
 * the detector errors, so a broken or unconfigured vision path degrades to today's behaviour
 * rather than rejecting every candidate and starving the render.
 */
export async function cachedClipHasBakedEditText(
  media: string,
  mimeType: string,
  cacheKey: string,
  maxChecks?: number
): Promise<boolean> {
  const cached = overlayVerdictCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // RONDE 25: a miss is about to cost an ffprobe, two ffmpeg extractions and a vision call, so
  // the ceiling is enforced here — the one place that knows a miss is happening. Past it we allow
  // the clip: an exhausted budget must not turn into "reject everything", which would starve the
  // cascade far more destructively than the text this guards against. Not cached, so a later
  // reset (next render) re-evaluates this clip properly instead of inheriting a budget artefact.
  if (maxChecks !== undefined && overlayChecksPerformed >= maxChecks) {
    console.warn(
      `[ArchiveFilter] overlay budget spent (${overlayChecksPerformed}/${maxChecks}) — ` +
        `skipping text check for ${cacheKey}, clip allowed unchecked`
    );
    return false;
  }
  overlayChecksPerformed++;
  let verdict = false;
  try {
    verdict = await archiveClipHasBakedEditText(media, mimeType);
  } catch (err) {
    console.warn(
      `[ArchiveFilter] overlay verdict failed for ${cacheKey} — treating as clean:`,
      (err as Error).message?.slice(0, 120)
    );
    verdict = false;
  }
  overlayVerdictCache.set(cacheKey, verdict);
  return verdict;
}

export async function archiveClipHasBakedEditText(
  media: Buffer | string,
  mimeType: string,
  opts?: { clipCount?: number }
): Promise<boolean> {
  if (opts?.clipCount != null && !shouldRunArchiveOverlayFilter(opts.clipCount)) return false;
  if (!archiveClipOverlayFilterEnabled()) return false;

  if (mimeType.startsWith("image/")) {
    const buf = typeof media === "string" ? fs.readFileSync(media) : media;
    const prepared = await prepareImageForVision(buf, mimeType);
    // Unconvertible format: fail open exactly as an errored check does, but without spending a
    // request the endpoint is certain to reject.
    if (!prepared) return false;
    return detectOnScreenTextInImages([imageMimeToDataUrl(prepared.buffer, prepared.mimeType)]);
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
    // RONDE 66: sample the ends too. 0.35/0.65 covers the middle third and misses precisely
    // where a title card, a leader and an end card live — and a clip that opens on a caption
    // and clears it is still a clip that opens on a caption.
    const sampleSec =
      dur <= 0.4
        ? [dur > 0 ? dur * 0.5 : 0]
        : fastMode
          ? [dur * 0.5]
          : [dur * 0.15, dur * 0.5, dur * 0.85];
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
