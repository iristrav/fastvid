/**
 * Fastvid — AI Video Generation Pipeline (v5 — Stability AI + Dynamic Scenes)
 *
 * Visual strategy (per scene):
 *   1. PRIMARY:   Stability AI SDXL image → FFmpeg zoom-loop video (~5-10s) — HIGH QUALITY
 *   2. SECONDARY: Pexels stock video clips (multiple per scene)
 *   3. FALLBACK:  Solid colour video (instant)
 *
 * Scene count scales with video length:
 *   5-8 min  → 12 scenes (~25-30s each)
 *   8-12 min → 20 scenes (~25-30s each)
 *   12-15 min → 25 scenes (~25-30s each)
 *   15-20 min → 30 scenes (~30-35s each)
 *   20+ min   → 35 scenes (~35-40s each)
 *
 * Per scene: 1 AI image (zoompan) + 3 Pexels clips joined with xfade transitions. All encoded at HIGH QUALITY (preset=slow, crf=18).
 * All scenes processed in parallel batches to stay within 60-min cap.
 *
 * Cost per video (Stability AI SDXL @ $0.003/image):
 *   12 scenes → ~$0.036
 *   20 scenes → ~$0.060
 *   30 scenes → ~$0.090
 */
import { createHash } from "crypto";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { storagePut } from "./storage";
import { invokeLLM } from "./_core/llm";
import { getVideoById, updateVideoScenes, updateVideoStatus, type EditorScene, type EditorClip } from "./db";
import pLimit from "p-limit";
import { generateGrokVideo } from "./_core/grokVideo";
import { generateVeoVideo } from "./_core/veoVideo";
import { generateMetaMovieGen } from "./_core/metaMovieGen";
import { generateHiggsfieldTextToVideo, generateHiggsfieldImageToVideo } from "./_core/higgsfieldVideo";
import { sanitizeForDrawtext, sanitizeForDrawtextStrict } from "./ffmpegSanitize";
import {
  buildPostGradeVF,
  buildSimpleKenBurnsVF,
  buildStillEncodeArgs,
  documentaryStyleEnabled,
  renderHighlightCaptionOverlay,
  renderNameBadgeOverlay,
  resolveStillCompositionVF,
  stillOutputFrameCount,
  type TimedOverlay,
} from "./documentaryStyle";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import fetch from "node-fetch";
import {
  extractFullNarrationText,
  parseMarkdownNarrationBlocks,
  type MarkdownNarrationBlock,
} from "./scriptWriter";
import {
  applyAiRelevanceRanking,
  buildHistoricalArchivalQueries,
  buildMediaSearchIntent,
  inferTopicKind,
  isHistoricalDocumentary,
  partitionCandidatesForIntent,
  prefersArchivalVideo,
  prefersRealFootageOnly,
  realFootageFirstEnabled,
  rankMediaCandidates,
  type MediaCandidate,
  type MediaSourceKind,
} from "./mediaResearchEngine";
import {
  planScriptGuidedClip,
  scriptGuidedBudgetMs,
  scriptGuidedClipsEnabled,
} from "./scriptGuidedClipFinder";
import { clipPassesVisionGate, clipVisionGateEnabled } from "./visualQualityGate";
import { curatedArchiveOnlyVisuals, elevenLabsOnlyVoice, skipEffectsStage } from "./sourcingPolicy";
import {
  fetchCuratedArchiveBeatClip,
  curatedClipPathAssetId,
  curatedAssetContentKey,
  archiveVisualSourcesReady,
  markCuratedAssetUsed,
} from "./curatedMediaSourcing";

// API Keys
const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY || "";
const STABILITY_AI_API_KEY = process.env.STABILITY_AI_API_KEY || "";
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || "";
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || "";
const META_MOVIE_GEN_API_KEY = process.env.META_MOVIE_GEN_API_KEY || "";
const HIGGSFIELD_API_KEY = process.env.HIGGSFIELD_API_KEY || "";
const HIGGSFIELD_API_SECRET = process.env.HIGGSFIELD_API_SECRET || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
/** Optional: CC-licensed event/interview videos (https://www.flickr.com/services/api/) */
const FLICKR_API_KEY = process.env.FLICKR_API_KEY || "";
/** Optional: EU broadcast heritage video (https://www.europeana.eu/en/apis) */
const EUROPEANA_API_KEY = process.env.EUROPEANA_API_KEY || "";
/** Optional: Vimeo Creative Commons video search (https://developer.vimeo.com/) */
const VIMEO_ACCESS_TOKEN = process.env.VIMEO_ACCESS_TOKEN || "";
/** GDELT TV News → Internet Archive television captions (free, no key) */
const GDELT_TV_API = "https://api.gdeltproject.org/api/v2/tv/tv";
const GDELT_TV_STATIONS = ["CNN", "FOXNEWS", "MSNBC", "BBCNEWS"] as const;
const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || "";
const KLING_API_KEY = process.env.KLING_API_KEY || "";
const KLING_API_SECRET = process.env.KLING_API_SECRET || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const LUMA_API_KEY = process.env.LUMA_API_KEY || "";
const LEONARDO_API_KEY = process.env.LEONARDO_API_KEY || "";
const PIKA_API_KEY = process.env.PIKA_API_KEY || "";
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "";
/** Optional: high-quality CC photos (https://unsplash.com/developers) */
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || "";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_YT_HOST =
  process.env.RAPIDAPI_YT_HOST || "ytstream-download-youtube-videos.p.rapidapi.com";

// @ts-ignore
import ffmpegStatic from "ffmpeg-static";
import { execSync } from "child_process";

// Prefer system FFmpeg (installed via nixpacks.toml on Railway) over ffmpeg-static.
// ffmpeg-static can fail on some Linux environments due to missing glibc/libatomic.

// Helper: test if a binary actually runs (not just exists on disk)
const testBinary = (binPath: string): boolean => {
  try {
    execSync(`"${binPath}" -version`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const resolveFFmpegBin = (): string => {
  // Check NODE_ENV for Railway
  const envPath = process.env.FFMPEG_BIN || '';
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[Fastvid] Using FFMPEG_BIN env: ${envPath}`);
    return envPath;
  }
  // PRIORITY 1: Try system ffmpeg FIRST - it has drawtext/libfreetype support needed for text overlays
  // ffmpeg-static does NOT have drawtext support (compiled without libfreetype)
  const candidatePaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/nix/var/nix/profiles/default/bin/ffmpeg",
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p) && testBinary(p)) {
      console.log(`[Fastvid] Using system FFmpeg (drawtext-capable): ${p}`);
      return p;
    }
  }
  // PRIORITY 2: Try ffmpeg-static as fallback (no drawtext, but works for basic encoding)
  const staticPath = (ffmpegStatic as unknown as string) || "ffmpeg";
  if (staticPath && fs.existsSync(staticPath)) {
    try {
      execSync(`chmod +x "${staticPath}"`, { shell: "/bin/sh" });
    } catch { /* ignore */ }
    if (testBinary(staticPath)) {
      console.warn(`[Fastvid] Using ffmpeg-static (NO drawtext support): ${staticPath}`);
      return staticPath;
    } else {
      console.warn(`[Fastvid] ffmpeg-static exists but CANNOT RUN (missing glibc?): ${staticPath}`);
    }
  }
  // PRIORITY 3: Try which command
  try {
    const systemPath = execSync("which ffmpeg", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (systemPath && testBinary(systemPath)) {
      console.log(`[Fastvid] Using system FFmpeg (which): ${systemPath}`);
      return systemPath;
    }
  } catch {
    // system ffmpeg not found via which
  }
  // PRIORITY 4: Try nix store — Railway Nixpacks installs ffmpeg here (use shell:true for glob)
  try {
    const nixPath = execSync("ls /nix/store/*/bin/ffmpeg 2>/dev/null | head -1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    if (nixPath && fs.existsSync(nixPath) && testBinary(nixPath)) {
      console.log(`[Fastvid] Using nix store FFmpeg: ${nixPath}`);
      return nixPath;
    }
  } catch {
    // nix store not available
  }
  // PRIORITY 5: Try find as last resort
  try {
    const found = execSync("find /nix /usr /opt -name ffmpeg -type f 2>/dev/null | head -1", { encoding: "utf8", shell: "/bin/sh" }).trim();
    if (found && fs.existsSync(found) && testBinary(found)) {
      console.log(`[Fastvid] Using found FFmpeg: ${found}`);
      return found;
    }
  } catch {
    // find failed
  }
  // PRIORITY 6: Last resort: try 'ffmpeg' from PATH
  if (testBinary('ffmpeg')) {
    console.log(`[Fastvid] Using 'ffmpeg' from PATH`);
    return 'ffmpeg';
  }
  console.error(`[Fastvid] CRITICAL: No working FFmpeg binary found! staticPath=${staticPath}`);
  return staticPath; // return anyway so error messages show the path
};
let FFMPEG_BIN: string = resolveFFmpegBin();

function resolveFFprobeBin(): string {
  const envPath = process.env.FFPROBE_BIN || "";
  if (envPath && fs.existsSync(envPath) && testBinary(envPath)) {
    return envPath;
  }
  const derivedFromFfmpeg = FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const candidates = [
    derivedFromFfmpeg,
    "/usr/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "ffprobe",
  ];
  for (const p of candidates) {
    if (p && testBinary(p)) {
      console.log(`[Fastvid] Using ffprobe: ${p}`);
      return p;
    }
  }
  if (process.platform !== "win32") {
    try {
      const nixPath = execSync("ls /nix/store/*/bin/ffprobe 2>/dev/null | head -1", {
        encoding: "utf8",
        shell: "/bin/sh",
      }).trim();
      if (nixPath && testBinary(nixPath)) return nixPath;
    } catch {
      /* nix store not available */
    }
  }
  console.warn("[Fastvid] No dedicated ffprobe found — using 'ffprobe' from PATH");
  return "ffprobe";
}

let FFPROBE_BIN: string = resolveFFprobeBin();

const FFPROBE_PATHS = (): string[] => [
  FFPROBE_BIN,
  "/usr/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "ffprobe",
];

async function isValidVideoFile(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  if (size < 1000) return false;
  for (const probePath of FFPROBE_PATHS()) {
    try {
      const { stdout } = await exec(
        `"${probePath}" -v error -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );
      if (stdout.trim().includes("video")) return true;
    } catch {
      /* try next probe binary */
    }
  }
  // ffprobe missing or failed — accept files that look like MP4 and are non-trivial size
  try {
    const head = fs.readFileSync(filePath).subarray(0, 12);
    return head.length >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp" && size > 5000;
  } catch {
    return false;
  }
}
// Use 256MB maxBuffer — FFmpeg concat of 15+ scenes can produce large stderr output
const execRaw = (cmd: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  execCb(cmd, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = stdout; (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = stderr; reject(err); }
    else resolve({ stdout, stderr });
  });
});

// Wrapper that retries with a different ffmpeg binary if the current one fails
const exec = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
  try {
    return await execRaw(cmd);
  } catch (err: unknown) {
    // If current FFMPEG_BIN failed with a binary-not-found error, try alternatives
    const errMsg = (err as Error)?.message || '';
    // Only treat as binary-not-found if the error mentions the FFmpeg binary path itself,
    // NOT if it's an input file ENOENT (which would incorrectly trigger binary switching)
    const isBinaryNotFound = (
      errMsg.includes('not found') || errMsg.includes('Permission denied')
    ) && !errMsg.includes('ENOENT') && !errMsg.includes('No such file or directory');
    if (isBinaryNotFound) {
      console.warn(`[Fastvid] FFmpeg binary failed (${FFMPEG_BIN}), trying alternatives...`);
      const alternatives = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
      for (const alt of alternatives) {
        if (alt === FFMPEG_BIN) continue;
        if (testBinary(alt)) {
          console.log(`[Fastvid] Switching to alternative FFmpeg: ${alt}`);
          const oldBin = FFMPEG_BIN;
          FFMPEG_BIN = alt;
          // Replace the old binary path at the start of the command with the new one
          // Commands are built as: `${FFMPEG_BIN} -y ...` so the first token is the binary
          const retryCmd = cmd.startsWith(oldBin)
            ? alt + cmd.slice(oldBin.length)
            : cmd.replace(/^\S+/, alt);
          return await execRaw(retryCmd);
        }
      }
    }
    throw err;
  }
};

// Font paths
// Resolve font paths dynamically — Ubuntu vs Debian have different Noto font locations
const resolveFontPath = (name: string): string => {
  const candidates = [
    `/usr/share/fonts/truetype/noto/${name}`,           // Ubuntu
    `/usr/share/fonts/noto/${name}`,                    // Debian (fonts-noto)
    `/usr/share/fonts/truetype/noto-fonts/${name}`,     // some distros
    `/usr/share/fonts/${name}`,                         // generic fallback
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Last resort: try fc-match to find any available font
  try {
    const result = execSync(`fc-match --format='%{file}' 'NotoSans:bold'`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* ignore */ }
  console.warn(`[Fastvid] Font not found: ${name}, canvas will use default font`);
  return '';
};
const FONT_BOLD = resolveFontPath('NotoSans-Bold.ttf');
const FONT_REGULAR = resolveFontPath('NotoSans-Regular.ttf');

// Canvas is not used — all rendering is done via FFmpeg (no native dependencies required)
const CANVAS_AVAILABLE = false; // kept for reference, all functions use FFmpeg-only paths

// Linux/Railway: prefer /var/tmp (survives long runs). Windows/dev: use OS temp dir.
const TMP_DIR =
  process.env.FASTVID_TMP_DIR ??
  (process.platform === "win32" ? path.join(os.tmpdir(), "fastvid") : "/var/tmp");
// Use lower resolution on Railway (no Forge key = Railway environment) to avoid OOM
// Railway free tier has ~512MB RAM; 1280x720 FFmpeg compositing OOM-kills the process
const IS_RAILWAY = !process.env.BUILT_IN_FORGE_API_KEY;
// 1080p resolution for professional YouTube quality
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
/** Letterbox pad (legacy encode paths). */
const SCALE_PAD_VF = `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2`;
/** Fill 16:9 — center crop, no black bars (documentary montage). */
const CROP_FILL_VF =
  `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,` +
  `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2`;
const FPS_FORMAT_VF = `fps=25,format=yuv420p,setpts=PTS-STARTPTS`;
const STANDARD_VF = `${SCALE_PAD_VF},${FPS_FORMAT_VF}`;
/** New clip every ~3–4s; hold up to 7s when narration/visual clearly stay on one subject. */
const VIDRUSH_CLIP_MIN_SEC = 2.5;
const VIDRUSH_CLIP_MAX_SEC = 4.0;
const VIDRUSH_CLIP_HOLD_SEC = 7.0;
const VIDRUSH_BEAT_SEC = 3.5;
/** Hard cuts on legacy stock mode; crossfade for archive/documentary montage. */
function montageXfadeSec(): number {
  if (curatedArchiveOnlyVisuals() || documentaryStyleEnabled()) return 0.45;
  return IS_RAILWAY ? 0.12 : 0;
}
const CHAPTER_CARD_DURATION = 2.5;

/** Wall-clock budgets: short ≤60 min, long ≤90 min (see getPipelinePerfProfile). */
interface PipelinePerfProfile {
  targetWallClockMin: number;
  maxBeatsPerScene: number;
  maxTopicQueries: number;
  skipFairUseTransform: boolean;
  transformTimeoutMs: number;
  enableArchival: boolean;
  enableNasa: boolean;
  /** One hero fetch (YouTube CC + NASA) for Musk 2-min opening — real SpaceX/Tesla footage. */
  enableMuskHeroFetch: boolean;
  /** Max per-video YouTube CC searches on entity beats (each search is slow). */
  maxEntityYoutubePerVideo: number;
  /** Generate AI b-roll only when no matching stock clip was found for that beat. */
  enableAiFallback: boolean;
  maxAiClipsPerVideo: number;
  sceneParallelism: number;
  pexelsDownloadRetries: number;
  /** Max Pexels query variants tried per beat (prevents 8+ min stalls). */
  maxStockQueriesPerBeat: number;
  /** Wall-clock cap for one beat's stock waterfall. */
  beatClipTimeoutMs: number;
  /** Wall-clock cap for one scene's visual fetch. */
  sceneVisualTimeoutMs: number;
  /** Skip slow stock waterfalls (hero/archival/multi-fallback) on short Railway jobs. */
  fastStockMode: boolean;
  /** Script beats: real YouTube CC first; Pexels/Pixabay only as capped fallback. */
  scriptOnlyVisuals: boolean;
  /** YouTube + SerpAPI + AI first; licensed stock only when real footage fails. */
  minimizeStockFootage: boolean;
  /** Max Pexels/Pixabay clips for the whole video when minimizeStockFootage is on. */
  maxStockBeatsPerVideo: number;
}

/** YouTube search + download (CC and fair-use standard videos). */
function youtubeCcReady(): boolean {
  const canSearch = Boolean(process.env.YOUTUBE_API_KEY?.trim());
  const canDownload = Boolean(RAPIDAPI_KEY || process.env.YOUTUBE_CC_DL_SERVICE?.trim());
  return canSearch && canDownload;
}

/** Standard YouTube (non-CC) allowed when transformed for fair use (default on). */
function youtubeFairUseEnabled(): boolean {
  return process.env.ENABLE_YOUTUBE_FAIR_USE !== "false";
}

/** Max seconds per standard-YouTube (fair-use) clip — short transformative excerpt only. */
function youtubeFairUseMaxClipSec(): number {
  const raw = process.env.FAIR_USE_YT_MAX_SEC?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 2 && n <= 8) return n;
  }
  return 5;
}

function capYoutubeClipDuration(duration: number, fileTag: string): number {
  if (fileTag === "ytfu") return Math.min(duration, youtubeFairUseMaxClipSec());
  return duration;
}

/** Clips that must receive fair-use transform before adoption (never raw). */
function clipRequiresFairUseTransform(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return /_ytfu_|_ytcc_|_archive_|_wikivid_|_septube_|_gdelt_/i.test(base);
}

function ffmpegSupportsDrawtext(): boolean {
  const bin = FFMPEG_BIN.toLowerCase();
  return !bin.includes("ffmpeg-static") && !bin.includes("node_modules");
}

/** YouTube beat sourcing — disabled; pipeline uses archive, Wikimedia, stills, and Pexels only. */
function youtubeSourcingEnabled(): boolean {
  return false;
}

/** YouTube only (≤1 min/beat) then Pexels — requires ENABLE_YOUTUBE_SOURCING=true. */
function youtubeOnlySourcingEnabled(): boolean {
  return youtubeSourcingEnabled() && process.env.YOUTUBE_ONLY_SOURCING !== "false";
}

/** Wall-clock budget per beat for YouTube search+download before Pexels fallback. */
function youtubeBeatSearchBudgetMs(): number {
  const raw = process.env.YOUTUBE_BEAT_BUDGET_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 15_000 && n <= 120_000) return n;
  }
  return 60_000;
}

function buildBeatYoutubeQueries(
  beat: SceneBeat,
  scene: Scene,
  videoTitle: string | undefined,
  personName: string
): string[] {
  return [
    ...new Set(
      [
        ...realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle),
        ...(personName.trim()
          ? buildPersonCelebrityVideoQueries(personName, beat.text, beat.index)
          : []),
        ...buildTopicDocumentaryYoutubeQueries(beat, scene, videoTitle),
        beat.searchQuery,
        scene.visualCue,
        scene.pexelsQuery,
        ...(videoTitle?.trim() ? [`${videoTitle} documentary footage`] : []),
      ].filter((q): q is string => typeof q === "string" && q.trim().length > 3)
    ),
  ].slice(0, 6);
}

async function fetchBeatYoutubeOnly(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  adoptOpts: VisualAdoptOptions,
  personName: string,
  videoTitle: string | undefined,
  label: string
): Promise<string | null> {
  if (!youtubeSourcingEnabled() || !youtubeCcReady()) return null;
  const queries = buildBeatYoutubeQueries(beat, scene, videoTitle, personName);
  if (!queries.length) return null;
  if (dedup.entityYoutubeFetchesUsed >= dedup.perf.maxEntityYoutubePerVideo) return null;
  dedup.entityYoutubeFetchesUsed++;

  const loose: VisualAdoptOptions = {
    ...adoptOpts,
    requireBeatMatch: false,
    scriptAnchored: false,
  };
  const ytKeywords = [
    ...new Set([...(adoptOpts.keywords ?? []), ...beat.keywords]),
  ].slice(0, 22);

  let paths: string[] = [];
  try {
    paths = await withTimeout(
      fetchYouTubeCCClips(
        queries.slice(0, 5),
        clipFetchDur,
        workDir,
        sceneIndex,
        1,
        ytKeywords,
        1,
        adoptOpts.personTopic ? adoptOpts.primaryPerson ?? "" : "",
        {
          beatText: beat.text,
          videoTitle,
          fastMode: dedup.perf.fastStockMode,
        }
      ),
      youtubeBeatSearchBudgetMs(),
      `${label} fetch s${sceneIndex} b${beat.index}`
    );
  } catch (err) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: ${label} fetch timeout:`,
      (err as Error).message
    );
    return null;
  }
  if (!paths.length) return null;

  const clip = await adoptClip(
    paths,
    dedup,
    sceneIndex,
    beat.index,
    beat.text,
    workDir,
    queries[0],
    loose
  );
  return isAuthenticVideoClip(clip ?? "") ? clip : null;
}

async function fetchBeatYoutubeThenPexels(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  ytLabel: string,
  stockReason: string
): Promise<string | null> {
  const yt = await fetchBeatYoutubeOnly(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    adoptOpts,
    personName,
    videoTitle,
    ytLabel
  );
  if (yt) return yt;
  if (!canUseLicensedStockBeat(dedup)) return null;
  const stock = await fetchBeatStockFallback(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    adoptOpts,
    stockReason
  );
  if (stock && isRealVideoClip(stock)) {
    markLicensedStockBeatUsed(dedup);
    return stock;
  }
  if (dedup.perf.enableAiFallback && dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo) {
    const ai = await fetchBeatAIClip(
      beat, scene, workDir, sceneIndex, beat.index, clipFetchDur, dedup, videoTitle
    );
    if (ai && !isPipelineFallbackClip(ai)) return ai;
  }
  return null;
}

/** Archive + Wikimedia video first, then Pexels/Pixabay, then AI. */
async function fetchBeatArchivalThenPexels(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  scenePersons: string[],
  tag: string,
  stockReason: string
): Promise<string | null> {
  if (curatedArchiveOnlyVisuals()) {
    return fetchCuratedArchiveBeatClip(
      beat,
      scene,
      workDir,
      sceneIndex,
      beat.holdSec,
      dedup.usedCuratedAssetIds,
      dedup.usedCuratedStorageUrls,
      videoTitle
    );
  }
  const topicHay = [videoTitle, scene.text, beat.text].filter(Boolean).join(" ");
  const historicalDoc = isHistoricalDocumentary(topicHay) && !dedup.personTopicLock;
  const intent = buildMediaSearchIntent({
    beatText: beat.text,
    searchQueries: [beat.searchQuery, videoTitle ?? ""].filter((q) => q.trim().length >= 3),
    keywords: adoptOpts.keywords ?? beat.keywords,
    primaryPerson: historicalDoc ? "" : personName,
    persons: scenePersons,
    videoTitle,
    powerWord: beat.powerWord,
    personTopicLock: dedup.personTopicLock && !historicalDoc,
    spaceTopic: isSpaceRelatedTopic(scene.visualCue, scene.pexelsQuery, beat.text, scene.text, videoTitle ?? ""),
    muskTopic: adoptOpts.muskTopic ?? false,
  });
  const loose: VisualAdoptOptions = { ...adoptOpts, requireBeatMatch: false, scriptAnchored: false };

  if (historicalDoc) {
    const internet = await fetchBeatInternetStillsFirst(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      scenePersons,
      videoTitle,
      adoptOpts,
      `${tag}_inet`
    );
    if (internet && isRealVideoClip(internet)) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: internet still (historical)`);
      return internet;
    }
  }

  const hist = await fetchHistoricalBeatVideo(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, intent, loose, tag, { skipYoutube: true }
  );
  if (isAuthenticVideoClip(hist ?? "")) return hist;

  if (personName.trim() && !historicalDoc) {
    const celebVids = await fetchPersonCelebrityVideoClips(
      personName,
      clipFetchDur,
      workDir,
      sceneIndex,
      celebrityFetchFastMode(dedup.perf, scene.duration) ? 2 : 3,
      `${tag}_arch`,
      beat.index,
      beat.text,
      celebrityFetchFastMode(dedup.perf, scene.duration)
    );
    const celeb = await adoptBestCelebrityClip(
      celebVids,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      personName,
      { ...loose, personTopic: true, primaryPerson: personName }
    );
    if (isAuthenticVideoClip(celeb ?? "")) return celeb;
  }

  const still = await fetchBeatAuthenticStills(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    adoptOpts,
    scenePersons,
    tag,
    historicalDoc
  );
  if (still && isRealVideoClip(still)) return still;

  if (dedup.perf.enableAiFallback && dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo) {
    const ai = await fetchBeatAIClip(
      beat, scene, workDir, sceneIndex, beat.index, clipFetchDur, dedup, videoTitle
    );
    if (ai && !isPipelineFallbackClip(ai)) return ai;
  }

  if (!canUseLicensedStockBeat(dedup)) return null;

  const stock = await fetchBeatStockFallback(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    adoptOpts,
    stockReason
  );
  if (stock && isRealVideoClip(stock)) {
    markLicensedStockBeatUsed(dedup);
    return stock;
  }
  return null;
}

/** Primary beat path: archival (default) or YouTube-only when explicitly enabled. */
async function beatPrimaryFetch(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  scenePersons: string[],
  tag: string,
  stockReason: string
): Promise<string | null> {
  if (curatedArchiveOnlyVisuals()) {
    return fetchCuratedArchiveBeatClip(
      beat,
      scene,
      workDir,
      sceneIndex,
      beat.holdSec,
      dedup.usedCuratedAssetIds,
      dedup.usedCuratedStorageUrls,
      videoTitle
    );
  }
  if (youtubeOnlySourcingEnabled()) {
    return fetchBeatYoutubeThenPexels(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      personName,
      videoTitle,
      adoptOpts,
      "primary YouTube",
      stockReason
    );
  }
  return fetchBeatArchivalThenPexels(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    adoptOpts,
    scenePersons,
    tag,
    stockReason
  );
}

/** Serp → Openverse → Wikimedia with relaxed adopt (bypasses still caps). */
async function fetchBeatInternetStillsFirst(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  scenePersons: string[],
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  tag: string
): Promise<string | null> {
  return fetchBeatScriptImageClip(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    scenePersons,
    videoTitle,
    {
      ...adoptOpts,
      requireBeatMatch: false,
      scriptAnchored: false,
      scriptImageFallback: true,
    },
    tag
  );
}

/** Real still photos (Wiki/SerpAPI/Openverse) before licensed stock. */
async function fetchBeatAuthenticStills(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  scenePersons: string[],
  tag: string,
  historicalDoc: boolean
): Promise<string | null> {
  if (!historicalDoc && !canUseGlobalStillPhoto(dedup) && dedup.stillPhotosMaxThisScene === 0) return null;

  const loose: VisualAdoptOptions = {
    ...adoptOpts,
    requireBeatMatch: false,
    scriptAnchored: false,
    scriptImageFallback: true,
  };
  const intent = buildMediaSearchIntent({
    beatText: beat.text,
    searchQueries: [beat.searchQuery, videoTitle ?? ""].filter((q) => q.trim().length >= 3),
    keywords: adoptOpts.keywords ?? beat.keywords,
    primaryPerson: historicalDoc ? "" : personName,
    persons: scenePersons,
    videoTitle,
    powerWord: beat.powerWord,
    personTopicLock: adoptOpts.personTopic ?? false,
    spaceTopic: false,
    muskTopic: adoptOpts.muskTopic ?? false,
  });
  const queries = [
    ...buildHistoricalArchivalQueries(intent, beat.text).slice(0, 3),
    enrichStockQuery(beat.powerWord, scene, videoTitle, personName, beat.text),
    beat.searchQuery,
    scene.visualCue,
    scene.pexelsQuery,
    ...(videoTitle?.trim() ? [videoTitle.split(/\s+/).slice(0, 4).join(" ")] : []),
  ].filter((q): q is string => typeof q === "string" && q.trim().length > 3);
  const queryCap = historicalDoc ? 3 : dedup.perf.fastStockMode ? 2 : 4;
  const unique = [...new Set(queries)].slice(0, queryCap);
  const personPortrait = Boolean(personName.trim()) && !historicalDoc;
  const trySerp = SERPAPI_KEY && (historicalDoc || !dedup.perf.fastStockMode);

  if (trySerp) {
    for (let qi = 0; qi < Math.min(unique.length, historicalDoc ? 3 : 1); qi++) {
      const serpQ = personPortrait && personName.trim()
        ? buildPersonSerpQuery(personName, sceneIndex, beat.index, beat.text)
        : (unique[qi] ?? beat.searchQuery);
      const serpPaths = await fetchSerpAPIImages(
        serpQ,
        clipFetchDur,
        workDir,
        sceneIndex,
        1,
        `${tag}_still`,
        { dedup, personPortrait, resultOffset: sceneIndex + beat.index + qi }
      );
      const serpClip = await adoptClip(
        serpPaths,
        dedup,
        sceneIndex,
        beat.index,
        beat.text,
        workDir,
        serpQ,
        loose
      );
      if (serpClip && !isPipelineFallbackClip(serpClip)) {
        if (canUseGlobalStillPhoto(dedup)) markGlobalStillPhotoUsed(dedup);
        dedup.stillPhotosThisScene++;
        console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: SerpAPI still "${serpQ}"`);
        return serpClip;
      }
    }
  }

  for (const q of unique) {
    const wikiPaths = await fetchWikimediaImages(
      q,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_still`
    );
    const wikiClip = await adoptClip(
      wikiPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      q,
      loose
    );
    if (wikiClip && !isPipelineFallbackClip(wikiClip)) {
      if (canUseGlobalStillPhoto(dedup)) markGlobalStillPhotoUsed(dedup);
      dedup.stillPhotosThisScene++;
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: Wikimedia still "${q}"`);
      return wikiClip;
    }
  }

  const ovQ = personPortrait && personName.trim()
    ? `${personName} ${unique[0] ?? ""}`.trim()
    : (unique[0] ?? beat.searchQuery);
  if ((historicalDoc || !dedup.perf.fastStockMode) && ovQ.length > 3) {
    const ovPaths = await fetchOpenverseImages(
      ovQ,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_still`,
      { dedup, personPortrait }
    );
    const ovClip = await adoptClip(
      ovPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      ovQ,
      loose
    );
    if (ovClip && !isPipelineFallbackClip(ovClip)) {
      if (canUseGlobalStillPhoto(dedup)) markGlobalStillPhotoUsed(dedup);
      dedup.stillPhotosThisScene++;
      return ovClip;
    }
  }

  return null;
}

function minimizeStockFootageEnabled(): boolean {
  return process.env.MINIMIZE_STOCK_FOOTAGE !== "false";
}

/** Max licensed Pexels/Pixabay/B-roll clips per video (0 = real footage + AI only). */
function resolveMaxStockBeatsPerVideo(videoLength: string): number {
  const raw = process.env.MAX_STOCK_BEATS_PER_VIDEO?.trim();
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  if (realFootageFirstEnabled()) return 2;
  const short = videoLength === "1" || videoLength === "2";
  return short ? 3 : 2;
}

function maxEntityYoutubeFetchesPerVideo(minimizeStock = minimizeStockFootageEnabled()): number {
  if (!youtubeSourcingEnabled() || !youtubeCcReady()) return 0;
  if (minimizeStock) return IS_RAILWAY ? 32 : 24;
  return IS_RAILWAY ? 12 : 8;
}

function applyMinimizeStockProfile(
  profile: PipelinePerfProfile,
  videoLength: string
): PipelinePerfProfile {
  if (!minimizeStockFootageEnabled() && !realFootageFirstEnabled()) {
    return { ...profile, minimizeStockFootage: false, maxStockBeatsPerVideo: 999 };
  }
  return {
    ...profile,
    minimizeStockFootage: true,
    maxStockQueriesPerBeat: 1,
    maxStockBeatsPerVideo: resolveMaxStockBeatsPerVideo(videoLength),
    maxEntityYoutubePerVideo: maxEntityYoutubeFetchesPerVideo(true),
    enableNasa: profile.enableNasa || videoLength === "1" || videoLength === "2",
    enableArchival: true,
  };
}

/** RapidAPI download + trim often exceeds 24s; outer beat timeout must allow that. */
function youtubeBeatFetchTimeoutMs(fastStockMode: boolean): number {
  if (youtubeOnlySourcingEnabled()) return youtubeBeatSearchBudgetMs();
  if (realFootageFirstEnabled()) return IS_RAILWAY ? 55_000 : 70_000;
  if (fastStockMode) return IS_RAILWAY ? 22_000 : 35_000;
  return 80_000;
}

/** Max time per beat for online/script image search before stock footage. */
function beatVisualSearchMaxMs(perf: PipelinePerfProfile): number {
  return perf.fastStockMode ? 18_000 : 60_000;
}

function beatStockFallbackWallMs(perf: PipelinePerfProfile): number {
  if (youtubeOnlySourcingEnabled()) return 45_000;
  return perf.fastStockMode ? 12_000 : 30_000;
}

/** Wall-clock cap for one beat: search + stock fallback. */
function beatVisualWallMs(perf: PipelinePerfProfile): number {
  if (youtubeOnlySourcingEnabled()) {
    return (
      youtubeBeatSearchBudgetMs() +
      Math.max(perf.transformTimeoutMs, 25_000) +
      beatStockFallbackWallMs(perf) +
      8_000
    );
  }
  return beatVisualSearchMaxMs(perf) + beatStockFallbackWallMs(perf) + 5_000;
}

function backfillClipWallMs(perf: PipelinePerfProfile, sceneDurationSec = 60): number {
  if (youtubeOnlySourcingEnabled()) {
    return youtubeBeatSearchBudgetMs() + beatStockFallbackWallMs(perf) + 30_000;
  }
  if (perf.fastStockMode) return 12_000;
  if (sceneDurationSec <= 30) return 45_000;
  return 90_000;
}

/** Cap online/script search per beat — then stock footage. */
function beatVideoSearchWallMs(perf: PipelinePerfProfile): number {
  return beatVisualSearchMaxMs(perf);
}

function personCelebrityVideoWallMs(perf: PipelinePerfProfile, sceneDurationSec: number): number {
  if (celebrityFetchFastMode(perf, sceneDurationSec)) return 35_000;
  return perf.fastStockMode ? 50_000 : 90_000;
}

function beatScriptImageWallMs(perf: PipelinePerfProfile): number {
  return perf.fastStockMode ? 12_000 : 25_000;
}

function maxBackfillAttempts(perf: PipelinePerfProfile, sceneDurationSec: number): number {
  if (perf.fastStockMode) return sceneDurationSec <= 10 ? 1 : 2;
  if (sceneDurationSec <= 22) return 1;
  if (sceneDurationSec <= 60) return 2;
  return 2;
}

/** Ultra-fast celebrity caps only on very short CTA scenes; longer scenes may search minutes. */
function celebrityFetchFastMode(perf: PipelinePerfProfile, sceneDurationSec: number): boolean {
  return perf.fastStockMode && sceneDurationSec <= 15;
}

/** Min clips for scene duration without forcing extra fetches on short CTA/outro scenes. */
function minClipsForScene(duration: number, beatCount: number, fast = false): number {
  const byDuration = Math.max(1, Math.ceil(duration / VIDRUSH_BEAT_SEC));
  if (fast && duration <= 10) return 1;
  if (fast) return Math.max(1, Math.min(beatCount, byDuration));
  if (duration <= 30) return Math.max(1, Math.min(beatCount, byDuration));
  const floor = Math.max(2, byDuration);
  return Math.max(1, Math.min(beatCount, floor));
}

/** YouTube CC clip for one beat (interviews, news, entity-named footage). */
async function tryBeatRealYouTubeFootage(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  adoptOpts: VisualAdoptOptions,
  youtubeQueries: string[],
  label: string,
  timeoutMs: number
): Promise<string | null> {
  if (!youtubeSourcingEnabled()) return null;
  if (!youtubeCcReady() || youtubeQueries.length === 0) return null;
  if (dedup.entityYoutubeFetchesUsed >= dedup.perf.maxEntityYoutubePerVideo) return null;
  dedup.entityYoutubeFetchesUsed++;
  const ytKeywords = [
    ...new Set([...(adoptOpts.keywords ?? []), ...beat.keywords]),
  ].slice(0, 22);
  try {
    return await withTimeout(
      tryStockSources(
        [{
          query: youtubeQueries[0],
          fetch: () =>
            fetchYouTubeCCClips(
              youtubeQueries.slice(0, 5),
              clipFetchDur,
              workDir,
              sceneIndex,
              1,
              ytKeywords,
              1,
              adoptOpts.personTopic ? adoptOpts.primaryPerson ?? "" : "",
              {
                beatText: beat.text,
                videoTitle: adoptOpts.videoTitle,
                fastMode: dedup.perf.fastStockMode,
              }
            ),
        }],
        dedup,
        sceneIndex,
        beat.index,
        beat.text,
        workDir,
        label,
        adoptOpts
      ),
      timeoutMs,
      `${label} s${sceneIndex} b${beat.index}`
    );
  } catch (err) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: ${label} skipped:`,
      (err as Error).message
    );
    return null;
  }
}

function buildTopicDocumentaryYoutubeQueries(
  beat: SceneBeat,
  scene: Scene,
  videoTitle?: string
): string[] {
  const topic = beat.powerWord?.trim() || beat.searchQuery?.trim() || "";
  if (!topic || topic.length < 3) return [];
  const titleHint = videoTitle ? videoTitle.split(/\s+/).slice(0, 5).join(" ") : "";
  return [
    ...new Set(
      [
        `${topic} documentary footage`,
        `${topic} news report`,
        `${topic} interview`,
        topic,
        beat.searchQuery,
        scene.pexelsQuery,
        ...(titleHint.length > 5 ? [`${titleHint} ${topic}`] : []),
      ].filter((q): q is string => typeof q === "string" && q.trim().length > 4)
    ),
  ];
}

function buildTopicRealMediaQuery(
  beat: SceneBeat,
  scene: Scene,
  videoTitle: string | undefined,
  primaryPerson: string
): string {
  const topic =
    beat.powerWord?.trim() ||
    beat.searchQuery?.trim() ||
    scene.pexelsQuery?.trim() ||
    scene.visualCue?.trim() ||
    "";
  const titleBits = videoTitle?.split(/\s+/).slice(0, 3).join(" ") ?? "";
  return [primaryPerson, topic, titleBits].filter(Boolean).join(" ").trim() || topic;
}

/**
 * Real topic footage: YouTube first, then Wikimedia/celebrity video, stills, SerpAPI.
 * Runs before licensed stock when minimize-stock is on.
 */
async function tryBeatTopicRealFootage(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  adoptOpts: VisualAdoptOptions,
  videoTitle: string | undefined,
  personName: string,
  opts: { includeTopicYoutube?: boolean; fileTag?: string } = {}
): Promise<string | null> {
  const perf = dedup.perf;
  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const primary = scenePersons[0] ?? personName ?? dedup.primaryPerson ?? "";
  const topicLabel = beat.powerWord?.trim() || beat.searchQuery?.trim() || "";
  const wikiQuery = buildTopicRealMediaQuery(beat, scene, videoTitle, primary);
  if (!wikiQuery || wikiQuery.length < 2) return null;

  const loose: VisualAdoptOptions = { ...adoptOpts, requireBeatMatch: false };
  const tag = opts.fileTag || `b${beat.index}`;
  const ytMs = youtubeBeatFetchTimeoutMs(perf.fastStockMode);
  const spaceTopic = isSpaceRelatedTopic(
    scene.visualCue,
    scene.pexelsQuery,
    beat.text,
    scene.text,
    videoTitle ?? "",
    topicLabel
  );

  const topicYt = buildTopicDocumentaryYoutubeQueries(beat, scene, videoTitle);
  if (youtubeSourcingEnabled() && youtubeCcReady() && topicYt.length) {
    const ytClip = await tryBeatRealYouTubeFootage(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      loose,
      topicYt,
      "topic YouTube",
      ytMs
    );
    if (ytClip) return ytClip;
  }

  let clip: string | null = null;
  if (primary) {
    const celebVids = await fetchPersonCelebrityVideoClips(
      primary,
      clipFetchDur,
      workDir,
      sceneIndex,
      celebrityFetchFastMode(perf, scene.duration) ? 2 : 3,
      `${tag}_celeb`,
      beat.index,
      beat.text,
      celebrityFetchFastMode(perf, scene.duration)
    );
    clip = await adoptBestCelebrityClip(
      celebVids,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      primary,
      loose
    );
    if (clip && !isStillPhotoClip(clip)) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: person video (Wiki/Sepia/Archive/CCC)`);
      return clip;
    }
  } else {
    const wikiVid = await fetchWikimediaVideos(wikiQuery, clipFetchDur, workDir, sceneIndex, 1, `${tag}_wiki`);
    clip = await adoptClip(
      wikiVid.map((c) => c.path),
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      wikiQuery,
      loose
    );
    if (clip && !isStillPhotoClip(clip)) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: Wikimedia video`);
      return clip;
    }
  }

  if (!dedup.personTopicLock) {
    const wikiImg = await fetchWikimediaImages(wikiQuery, clipFetchDur, workDir, sceneIndex, 1, `${tag}_wiki`);
    clip = await adoptClip(
      wikiImg,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      wikiQuery,
      loose
    );
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: Wikimedia image`);
      return clip;
    }
  }

  const allowStill =
    dedup.stillPhotosMaxThisScene === 0
      ? canUseGlobalStillPhoto(dedup)
      : dedup.stillPhotosThisScene < dedup.stillPhotosMaxThisScene;
  const ovQuery = primary ? `${primary} portrait ${topicLabel || wikiQuery}` : wikiQuery;
  if (allowStill) {
    const ovPaths = await fetchOpenverseImages(
      ovQuery,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_ov`,
      { dedup, personPortrait: Boolean(primary) || dedup.personTopicLock }
    );
    clip = await adoptClip(
      ovPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      ovQuery,
      loose
    );
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: Openverse topic`);
      return clip;
    }
  }

  if (SERPAPI_KEY && allowStill && canUseGlobalStillPhoto(dedup)) {
    const serpQ = primary
      ? buildPersonSerpQuery(primary, sceneIndex, beat.index, beat.text)
      : (topicLabel || wikiQuery);
    const portrait = Boolean(primary) || dedup.personTopicLock;
    const serpPaths = await fetchSerpAPIImages(
      serpQ,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_serp`,
      {
        dedup,
        personPortrait: portrait,
        resultOffset: sceneIndex * 2 + beat.index,
      }
    );
    clip = await adoptClip(
      serpPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      serpQ,
      loose
    );
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: SerpAPI topic`);
      return clip;
    }
  }

  if (youtubeSourcingEnabled() && process.env.YOUTUBE_API_KEY && allowStill && canUseGlobalStillPhoto(dedup)) {
    const thumbQ = buildTopicDocumentaryYoutubeQueries(beat, scene, videoTitle)[0] || wikiQuery;
    const ytThumb = await fetchYouTubeThumbnails(
      thumbQ,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_ytt`
    );
    clip = await adoptClip(
      ytThumb,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      thumbQ,
      loose
    );
    if (clip) {
      dedup.stillPhotosThisScene++;
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: YouTube thumbnail`);
      return clip;
    }
  }

  if (perf.enableNasa && spaceTopic) {
    const nasaPaths = await fetchNasaVideoClips(
      topicLabel || wikiQuery,
      clipFetchDur,
      workDir,
      sceneIndex,
      1
    );
    clip = await adoptClip(
      nasaPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      wikiQuery,
      loose
    );
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: NASA`);
      return clip;
    }
  }

  if (perf.enableArchival) {
    const archivePaths = await fetchInternetArchiveClips(
      wikiQuery,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_ia`
    );
    clip = await adoptClip(
      archivePaths.map((c) => c.path),
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      wikiQuery,
      loose
    );
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: Internet Archive`);
      return clip;
    }
  }

  return null;
}

/** Cheap tier: still image → Ken Burns (~$0.03/beat). Best $/quality for documentaries. */
function cheapAiImageProvidersReady(): boolean {
  return Boolean(STABILITY_AI_API_KEY || LEONARDO_API_KEY);
}

/** Expensive tier: Grok/Veo/Runway video — off unless ENABLE_AI_VIDEO_FALLBACK=true. */
function premiumAiVideoFallbackEnabled(): boolean {
  return process.env.ENABLE_AI_VIDEO_FALLBACK === "true";
}

function aiProvidersReady(): boolean {
  if (cheapAiImageProvidersReady()) return true;
  return (
    premiumAiVideoFallbackEnabled() &&
    Boolean(REPLICATE_API_KEY || RUNWAY_API_KEY || GOOGLE_GEMINI_API_KEY)
  );
}

/** AI clip when stock/YouTube miss — never grey. ENABLE_AI_FALLBACK=false to disable. */
function resolveAiFallbackConfig(videoLength: string): { enable: boolean; maxClips: number } {
  if (process.env.ENABLE_AI_FALLBACK === "false" || !aiProvidersReady()) {
    return { enable: false, maxClips: 0 };
  }
  const short = videoLength === "1" || videoLength === "2";
  if (IS_RAILWAY && short) {
    return { enable: aiProvidersReady(), maxClips: aiProvidersReady() ? 14 : 0 };
  }
  const minimize = minimizeStockFootageEnabled();
  return {
    enable: true,
    maxClips: minimize
      ? short
        ? IS_RAILWAY
          ? 10
          : 12
        : IS_RAILWAY
          ? 12
          : 16
      : short
        ? IS_RAILWAY
          ? 3
          : 5
        : IS_RAILWAY
          ? 6
          : 10,
  };
}

function applyAiFallbackToProfile(
  profile: PipelinePerfProfile,
  videoLength: string
): PipelinePerfProfile {
  const ai = resolveAiFallbackConfig(videoLength);
  return applyMinimizeStockProfile(
    { ...profile, enableAiFallback: ai.enable, maxAiClipsPerVideo: ai.maxClips },
    videoLength
  );
}

function getPipelinePerfProfile(videoLength: string): PipelinePerfProfile {
  const railwayParallel = IS_RAILWAY ? 2 : 2;
  const maxEntityYoutube = maxEntityYoutubeFetchesPerVideo(minimizeStockFootageEnabled());
  let profile: PipelinePerfProfile;
  if (videoLength === "1" || videoLength === "2") {
    profile = applyAiFallbackToProfile({
      targetWallClockMin: 8,
      maxBeatsPerScene: IS_RAILWAY ? 4 : 6,
      maxTopicQueries: IS_RAILWAY ? 1 : 3,
      skipFairUseTransform: true,
      transformTimeoutMs: 15_000,
      enableArchival: true,
      enableNasa: false,
      enableMuskHeroFetch: false,
      maxEntityYoutubePerVideo: maxEntityYoutube,
      sceneParallelism: railwayParallel,
      pexelsDownloadRetries: 1,
      maxStockQueriesPerBeat: 2,
      beatClipTimeoutMs: IS_RAILWAY ? 22_000 : 60_000,
      sceneVisualTimeoutMs: IS_RAILWAY ? 5 * 60_000 : 4 * 60_000,
      fastStockMode: IS_RAILWAY,
      scriptOnlyVisuals: false,
    }, videoLength);
  } else if (videoLength === "5-8") {
    profile = applyAiFallbackToProfile({
      targetWallClockMin: 90,
      maxBeatsPerScene: 6,
      maxTopicQueries: 4,
      skipFairUseTransform: true,
      transformTimeoutMs: 35_000,
      enableArchival: false,
      enableNasa: true,
      enableMuskHeroFetch: false,
      maxEntityYoutubePerVideo: maxEntityYoutube,
      sceneParallelism: railwayParallel,
      pexelsDownloadRetries: 2,
      maxStockQueriesPerBeat: 5,
      beatClipTimeoutMs: 120_000,
      sceneVisualTimeoutMs: 8 * 60_000,
      fastStockMode: false,
      scriptOnlyVisuals: true,
    }, videoLength);
  } else if (videoLength === "12-15" || videoLength === "15-20") {
    profile = applyAiFallbackToProfile({
      targetWallClockMin: 90,
      maxBeatsPerScene: 5,
      maxTopicQueries: 3,
      skipFairUseTransform: true,
      transformTimeoutMs: 40_000,
      enableArchival: false,
      enableNasa: true,
      enableMuskHeroFetch: false,
      maxEntityYoutubePerVideo: maxEntityYoutube,
      sceneParallelism: railwayParallel,
      pexelsDownloadRetries: 2,
      maxStockQueriesPerBeat: 5,
      beatClipTimeoutMs: 120_000,
      sceneVisualTimeoutMs: 10 * 60_000,
      fastStockMode: false,
      scriptOnlyVisuals: true,
    }, videoLength);
  } else {
    profile = applyAiFallbackToProfile({
      targetWallClockMin: 90,
      maxBeatsPerScene: 7,
      maxTopicQueries: 4,
      skipFairUseTransform: false,
      transformTimeoutMs: 45_000,
      enableArchival: true,
      enableNasa: true,
      enableMuskHeroFetch: false,
      maxEntityYoutubePerVideo: maxEntityYoutube,
      sceneParallelism: railwayParallel,
      pexelsDownloadRetries: 2,
      maxStockQueriesPerBeat: 6,
      beatClipTimeoutMs: 150_000,
      sceneVisualTimeoutMs: 12 * 60_000,
      fastStockMode: false,
      scriptOnlyVisuals: true,
    }, videoLength);
  }

  if (curatedArchiveOnlyVisuals()) {
    return {
      ...profile,
      enableArchival: false,
      enableNasa: false,
      enableMuskHeroFetch: false,
      enableAiFallback: false,
      maxAiClipsPerVideo: 0,
      minimizeStockFootage: true,
      maxStockBeatsPerVideo: 0,
      maxStockQueriesPerBeat: 0,
      maxEntityYoutubePerVideo: 0,
    };
  }
  return profile;
}

function visualStageTimeoutMs(videoLength: string, perf: PipelinePerfProfile): number {
  if (videoLength === "1" || videoLength === "2") {
    return perf.fastStockMode ? 20 * 60_000 : 20 * 60_000;
  }
  return Math.round(perf.targetWallClockMin * 60_000 * 1.15);
}

async function runBeatClipFetch(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  spaceTopic: boolean,
  personName: string,
  videoTitle: string | undefined
): Promise<string | null> {
  const { beatClipTimeoutMs } = dedup.perf;
  try {
    return await withTimeout(
      fetchBeatClip(
        beat, scene, workDir, sceneIndex, clipFetchDur, dedup, spaceTopic, personName, videoTitle
      ),
      beatClipTimeoutMs,
      `Scene ${sceneIndex} beat ${beat.index} stock`
    );
  } catch (err) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: stock timed out after ${Math.round(beatClipTimeoutMs / 1000)}s —`,
      (err as Error).message
    );
    // Background fetchBeatClip may still be running; release lock so next beat cannot stall 8+ min.
    dedup.lock = Promise.resolve();
    return null;
  }
}

/** Quick script-ordered rescue: YouTube CC first, then capped Pexels. */
async function resolveBeatClipFast(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  scenePersons: string[],
  videoTitle?: string,
  adoptOpts: VisualAdoptOptions = {}
): Promise<string | null> {
  if (realFootageFirstEnabled() && !youtubeOnlySourcingEnabled()) {
    const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
    const primary = await beatPrimaryFetch(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      scenePersons[0] ?? dedup.primaryPerson ?? "",
      videoTitle,
      adoptOpts,
      scenePersons,
      `b${beat.index}_fast`,
      "fast primary"
    );
    if (primary) {
      dedup.lastMuskStockClip = primary;
      return primary;
    }
  }

  const ytMs = youtubeBeatFetchTimeoutMs(dedup.perf.fastStockMode);
  if (youtubeSourcingEnabled() && youtubeCcReady()) {
    const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle);
    let clip = await tryBeatRealYouTubeFootage(
      beat, scene, workDir, sceneIndex, clipFetchDur, dedup, adoptOpts, entityYt, "fast event YouTube", ytMs
    );
    if (clip) {
      dedup.lastMuskStockClip = clip;
      return clip;
    }
    const person = scenePersons[0] ?? dedup.primaryPerson;
    if (person) {
      const personYt = buildPersonCelebrityVideoQueries(person, beat.text, beat.index);
      clip = await tryBeatRealYouTubeFootage(
        beat,
        scene,
        workDir,
        sceneIndex,
        clipFetchDur,
        dedup,
        { ...adoptOpts, personTopic: true, primaryPerson: person, requireBeatMatch: false },
        personYt,
        `fast person YouTube (${person})`,
        ytMs
      );
      if (clip) {
        dedup.lastMuskStockClip = clip;
        console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: fast person YouTube (${person})`);
        return clip;
      }
    }
  }

  if (youtubeOnlySourcingEnabled()) {
    if (!canUseLicensedStockBeat(dedup)) return null;
    const stock = await fetchBeatStockFallback(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      scenePersons[0] ?? dedup.primaryPerson ?? "",
      videoTitle,
      adoptOpts,
      "YouTube 1min cap"
    );
    if (stock && isRealVideoClip(stock)) {
      markLicensedStockBeatUsed(dedup);
      dedup.lastMuskStockClip = stock;
      return stock;
    }
    return null;
  }

  if (dedup.perf.minimizeStockFootage) {
    const topicClip = await tryBeatTopicRealFootage(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      adoptOpts,
      videoTitle,
      scenePersons[0] ?? dedup.primaryPerson ?? "",
      { includeTopicYoutube: true, fileTag: `b${beat.index}_fast` }
    );
    if (topicClip) {
      dedup.lastMuskStockClip = topicClip;
      return topicClip;
    }
    return null;
  }

  const queries = buildBeatVisualQueryList(
    beat.text, scene, videoTitle, scenePersons, 4
  );

  const pexCap = dedup.perf.fastStockMode ? 2 : 3;
  for (const q of queries.slice(0, pexCap)) {
    try {
      const paths = await withTimeout(
        fetchPexelsClips(
          q,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          undefined,
          true,
          `b${beat.index}_fast`,
          dedup.usedPexelsIds,
          beat.index + sceneIndex + queries.indexOf(q),
          1
        ),
        10_000,
        `fast Pexels scene ${sceneIndex} beat ${beat.index}`
      );
      for (const p of paths) {
        if (!p || dedup.usedPaths.has(p) || !fs.existsSync(p)) continue;
        let size = 0;
        try { size = fs.statSync(p).size; } catch { continue; }
        if (size < 180_000) continue;
        if (isRejectedStockClip(p, q) || isPipelineFallbackClip(p)) continue;
        const contentKey = clipContentKey(p);
        if (dedup.usedContentKeys.has(contentKey)) continue;
        if (dedup.personTopicLock && dedup.primaryPerson &&
          isOffTopicVisualForPersonTopic(q, p, dedup.primaryPerson)) continue;
        try {
          const ok = await withTimeout(isValidVideoFile(p), 5_000, `fast validate s${sceneIndex} b${beat.index}`);
          if (!ok) continue;
        } catch {
          continue;
        }
        dedup.usedPaths.add(p);
        dedup.usedContentKeys.add(contentKey);
        dedup.lastMuskStockClip = p;
        console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: fast Pexels "${q}"`);
        return p;
      }
    } catch {
      /* try next script query */
    }
  }

  return null;
}

function composeParallelism(): number {
  return IS_RAILWAY ? 1 : 2;
}

/** Stable stock trim — no animated Ken Burns pan (avoids jitter on real footage). */
async function trimDownloadedStockClip(
  rawPath: string,
  outPath: string,
  clipDuration: number,
  sourceDuration: number,
  label: string,
  startOffsetSec = 0
): Promise<boolean> {
  const trimDur = Math.min(clipDuration, Math.max(2.5, sourceDuration - 0.05));
  const ss = Math.max(0, Math.min(startOffsetSec, Math.max(0, sourceDuration - trimDur - 0.1))).toFixed(2);
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -ss ${ss} -i "${rawPath}" ` +
        `-t ${trimDur.toFixed(3)} ` +
        `-vf "${STANDARD_VF}" ` +
        `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
      ),
      45_000,
      label
    );
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000;
  } catch {
    return false;
  }
}

// ─── Dynamic scene count based on video length ────────────────────────────────
// Each scene is ~25-35s of narration. To hit target duration:
//   5-8 min  = 300-480s → 12-18 scenes @ ~30s each → use 15
//   8-12 min = 480-720s → 18-24 scenes @ ~30s each → use 22
//   12-15 min= 720-900s → 24-30 scenes @ ~30s each → use 28
//   15-20 min= 900-1200s→ 30-40 scenes @ ~30s each → use 35
//   20+ min  = 1200s+   → 40+ scenes @ ~30s each   → use 42
function getScenesForLength(videoLength: string): number {
  switch (videoLength) {
    case "1":     return 3;   // ~1 min preview / test
    case "2":     return 5;   // ~2 min preview / test
    case "5-8":   return 15;
    case "8-12":  return 22;
    case "12-15": return 28;
    case "15-20": return 35;
    case "20+":   return 42;
    default:      return 22;
  }
}
// ─── Types ─────────────────────────────────────────────────────────────────────────────────
interface Scene {
  index: number;
  text: string;
  visualCue: string;
  pexelsQuery: string;
  pexelsQueries?: string[]; // Multiple search queries for better visual matching
  personNames?: string[];    // Names of all people mentioned in this scene's narration
  aiImagePrompt: string;
  duration: number;
  // Chapter card fields (optional)
  isChapterCard?: boolean;   // true = this scene is a chapter title card (no voiceover, 1.5s)
  chapterTitle?: string;     // ALL CAPS title text for the chapter card
  // Vidrush-quality fields
  highlightWords?: string[]; // 2-3 power words for kinetic typography overlay (LLM-generated)
  brollQueries?: string[];   // 2 specific B-roll search queries for cutaway footage
  statCallout?: string;      // 1 key statistic/number for yellow corner callout box (e.g. "45°C", "2%", "$4B")
  literalVisualCue?: string; // Hyper-specific 3-5 word B-roll search (Vidrush literal matching)
  sectionTitle?: string;     // ALL CAPS chapter title → yellow card before this scene
}

export interface PipelineProgress {
  stage: string;
  percent: number;
}

// ─── Timeout helper ───────────────────────────────────────────────────────────
// fetchWithTimeout: truly cancels the download using AbortController (unlike withTimeout which only races)
async function fetchWithTimeout(url: string, timeoutMs: number, label: string, options: Record<string, unknown> = {}): Promise<ReturnType<typeof fetch>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
      throw pipelineError(PIPELINE_ERROR.TIMEOUT, `Timeout: ${label} exceeded ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const delayMs = Math.max(1, Math.round(ms));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(pipelineError(PIPELINE_ERROR.TIMEOUT, `Timeout: ${label} exceeded ${Math.round(delayMs / 1000)}s`)),
        delayMs
      )
    ),
  ]);
}

// ─── Documentary workflow (prompt → script → ElevenLabs → editor → per-zin beeld → montage) ─
export const PIPELINE_WORKFLOW = [
  { key: "prompt", label: "Prompt bekijken", detail: "Onderwerp, lengte en tone uit je idee halen." },
  { key: "script", label: "Professioneel script", detail: "Documentaire narratie — beelden worden automatisch gematcht." },
  { key: "elevenlabs", label: "Volledig script in ElevenLabs", detail: "Eén voiceover-opname voor het hele script, consistente stem." },
  { key: "editor", label: "Voiceover in editor", detail: "Scenes + timing in het editsysteem vóór beelden." },
  { key: "visuals", label: "Per zin: belangrijkste woord → beeld", detail: "Elke zin krijgt een clip op het kernwoord of de persoon/event." },
  { key: "whole", label: "Hele video doorlopen", detail: "Alle scenes en beats, zonder grijze placeholders." },
  { key: "assemble", label: "Alles samenvoegen", detail: "Scenes concat + documentaire muziek." },
  { key: "polish", label: "Effecten & overgangen", detail: "Montage, color grade, sync, vloeiende cuts." },
] as const;

export const STAGE_LABELS = {
  parsing:    "Scenes uit professioneel script halen...",
  voiceovers: "Volledige voiceover in ElevenLabs (één script)...",
  editorDraft: "Voiceover in het editsysteem laden...",
  visuals:    "Per zin: belangrijkste woord → beeld zoeken...",
  composing:  "Clips monteren — effecten & overgangen...",
  assembling: "Alle scenes samenvoegen + muziek...",
  uploading:  "Video uploaden...",
  complete:   "Perfecte video klaar!",
};

// ─── 1. Parse Script into Scenes ─────────────────────────────────────────────

const SCENE_PARSE_BATCH_SIZE = 16;

function narrationWordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Split or merge markdown blocks to exactly maxScenes without repeating narration. */
function partitionNarrationBlocks(blocks: MarkdownNarrationBlock[], maxScenes: number): string[] {
  if (blocks.length === 0) return [];
  if (blocks.length === maxScenes) return blocks.map((b) => b.text);
  if (blocks.length > maxScenes) {
    const texts = blocks.map((b) => b.text);
    const merged: string[] = [];
    let cursor = 0;
    for (let i = 0; i < maxScenes; i++) {
      const take = i === maxScenes - 1
        ? texts.length - cursor
        : Math.max(1, Math.round((texts.length - cursor) / (maxScenes - i)));
      merged.push(texts.slice(cursor, cursor + take).join(" "));
      cursor += take;
    }
    return merged;
  }
  const texts = [...blocks.map((b) => b.text)];
  while (texts.length < maxScenes) {
    let splitIdx = 0;
    let maxWords = 0;
    for (let i = 0; i < texts.length; i++) {
      const w = narrationWordCount(texts[i]);
      if (w > maxWords) {
        maxWords = w;
        splitIdx = i;
      }
    }
    const words = texts[splitIdx].split(/\s+/).filter(Boolean);
    if (words.length < 24) break;
    const mid = Math.ceil(words.length / 2);
    const a = words.slice(0, mid).join(" ");
    const b = words.slice(mid).join(" ");
    texts.splice(splitIdx, 1, a, b);
  }
  return texts.slice(0, maxScenes);
}

function scenesFromMarkdownScript(script: string, maxScenes: number, topicContext?: string): Scene[] | null {
  const blocks = parseMarkdownNarrationBlocks(script);
  if (blocks.length < 2) return null;

  const texts = partitionNarrationBlocks(blocks, maxScenes);
  if (texts.length < 2) return null;

  const scriptPersons = extractPersonNamesFromText(topicContext ?? script);

  return texts.map((text, index) => {
    const block =
      blocks.find((b) => text.includes(b.text.slice(0, Math.min(60, b.text.length)))) ??
      blocks[Math.min(index, blocks.length - 1)];
    const beatPersons = [
      ...new Set([...extractPersonNamesFromText(text), ...scriptPersons]),
    ].filter(Boolean);
    const primaryQuery = stockQueryFromBeatScript(text, beatPersons, text, topicContext);
    const allQueries = [
      ...new Set([
        primaryQuery,
        ...scriptStockSearchQueries(text, beatPersons, text, topicContext),
      ]),
    ].slice(0, 4);
    const primary = beatPersons[0] ?? "";
    return {
      index,
      text,
      visualCue: primaryQuery,
      pexelsQuery: primaryQuery,
      pexelsQueries: allQueries.length ? allQueries : [primaryQuery],
      personNames: beatPersons,
      literalVisualCue: undefined,
      highlightWords: [],
      brollQueries: primary
        ? [`${primary} interview`, `${primary} news`].filter((q) => q.length >= 3 && !isBlockedStockQuery(q)).slice(0, 2)
        : [],
      statCallout: "",
      aiImagePrompt: `Cinematic ${primaryQuery}, documentary lighting, photorealistic`,
      duration: 0,
      isChapterCard: false,
      chapterTitle: isPublishableChapterTitle(block.sectionTitle) ? block.sectionTitle : undefined,
      sectionTitle: isPublishableChapterTitle(block.sectionTitle) ? block.sectionTitle : undefined,
    };
  });
}

/** Remove LLM-parse overlap so scene 2+ does not replay the opening hook. */
function dedupeSceneNarration(scenes: Scene[]): Scene[] {
  if (scenes.length < 2) return scenes;
  const hookPrefix = scenes[0].text.trim().slice(0, 100);
  for (let i = 1; i < scenes.length; i++) {
    let text = scenes[i].text.trim();
    if (hookPrefix.length > 30) {
      for (const len of [100, 80, 60, 40]) {
        const prefix = hookPrefix.slice(0, len).trim();
        if (prefix.length > 20 && text.startsWith(prefix)) {
          text = text.slice(prefix.length).trim();
          break;
        }
      }
    }
    const prev = scenes[i - 1].text.trim();
    if (prev.length > 40) {
      const tail = prev.slice(-80);
      if (text.startsWith(tail.slice(0, 50))) {
        text = text.slice(tail.slice(0, 50).length).trim();
      }
    }
    scenes[i].text = text.length > 0 ? text : scenes[i].text;
  }
  return scenes;
}

function parseLLMJson<T>(content: unknown, label: string): T {
  try {
    if (content && typeof content === "object") return content as T;
    const raw = typeof content === "string" ? content : JSON.stringify(content);
    return JSON.parse(raw) as T;
  } catch (err) {
    throw pipelineError(
      PIPELINE_ERROR.SCRIPT_PARSE,
      `${label}: ${(err as Error).message}`
    );
  }
}

function splitScriptForSceneParsing(script: string, parts: number): string[] {
  if (parts <= 1) return [script];
  const sections = script.split(/(?=^## )/m).filter((s) => s.trim().length > 0);
  if (sections.length >= parts) {
    const chunks: string[] = Array.from({ length: parts }, () => "");
    sections.forEach((sec, i) => {
      chunks[i % parts] += (chunks[i % parts] ? "\n" : "") + sec;
    });
    return chunks.filter((c) => c.trim().length > 0);
  }
  const size = Math.ceil(script.length / parts);
  return Array.from({ length: parts }, (_, i) => script.slice(i * size, (i + 1) * size)).filter(Boolean);
}

const SCENE_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "scenes",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              visualCue: { type: "string" },
              pexelsQuery: { type: "string" },
              pexelsQueries: { type: "array", items: { type: "string" } },
              personNames: { type: "array", items: { type: "string" } },
              brollQueries: { type: "array", items: { type: "string" } },
              literalVisualCue: { type: "string" },
              sectionTitle: { type: "string" },
              statCallout: { type: "string" },
            },
            required: ["text", "visualCue", "pexelsQuery", "pexelsQueries", "personNames", "brollQueries", "literalVisualCue", "sectionTitle", "statCallout"],
            additionalProperties: false,
          },
        },
      },
      required: ["scenes"],
      additionalProperties: false,
    },
  },
};

async function parseScriptIntoScenesBatch(
  script: string,
  sceneCount: number,
  startIndex: number
): Promise<Scene[]> {
  const response = await withTimeout(
    invokeLLM({
      messages: [
        {
          role: "system",
          content: `Parse the script into exactly ${sceneCount} scenes for Vidrush-quality documentary video.

Scripts are NARRATION ONLY (no [VISUAL:] tags). Footage search is derived server-side from spoken words.

For each scene return:
- text: narration only (max 500 chars, full sentences) — strip any [VISUAL: ...] if present
- visualCue: "" (leave empty)
- literalVisualCue: "" (leave empty)
- pexelsQuery: "" (leave empty)
- pexelsQueries: [] (leave empty)
- brollQueries: [] (leave empty)
- personNames: full names of real people mentioned in text, or []. If the video is about one celebrity, include their full name on EVERY scene even when narration says "she" or "her".
- sectionTitle: ALL CAPS chapter heading shown on yellow card BEFORE this scene when starting a new topic; "" if not a chapter start. NEVER use HOOK, OPENING, CTA, INTRO, or OUTRO as sectionTitle — always "" for those meta sections.
- statCallout: ONE key number or stat from this scene for a yellow corner box (e.g. "$1B", "45%", "2024") or "" if none.

Split narration into contiguous slices — NEVER repeat the opening hook or earlier sentences in later scenes. Each scene text is ONLY its own slice. Name real people, brands, and events in the spoken lines when relevant.`,
        },
        {
          role: "user",
          content: `Parse into exactly ${sceneCount} scenes:\n\n${script.slice(0, 14000)}`,
        },
      ],
      response_format: SCENE_JSON_SCHEMA,
      maxTokens: 16384,
    }),
    120_000,
    `Parse scenes batch from ${startIndex}`
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw pipelineError(PIPELINE_ERROR.SCRIPT_PARSE, "Failed to parse script into scenes");
  const parsed = parseLLMJson<{ scenes: Array<Omit<Scene, "index" | "duration"> & { sectionTitle?: string }> }>(
    content,
    "Scene parse JSON"
  );
  const rawScenes = (parsed.scenes ?? []).slice(0, sceneCount);
  return rawScenes.map((s, i) => mapRawScene(s, startIndex + i));
}

function mapRawScene(
  s: Omit<Scene, "index" | "duration"> & { sectionTitle?: string },
  index: number
): Scene {
  const rawS = s as Record<string, unknown>;
  const hint = `${s.text ?? ""}`.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  const personNames = [
    ...new Set(
      [
        ...((rawS.personNames as string[] | undefined) || [])
          .filter((n) => typeof n === "string" && n.trim().length > 0)
          .map((n) => n.trim()),
        ...extractPersonNamesFromText(hint),
      ]
    ),
  ];
  const primaryQuery = stockQueryFromBeatScript(hint, personNames, hint);
  const scriptQueries = scriptStockSearchQueries(hint, personNames, hint);
  const allQueries = [...new Set([primaryQuery, ...scriptQueries])].slice(0, 4);
  const brollQueries = personNames.length > 0
    ? [`${personNames[0].split(/\s+/)[0]} interview`, `${personNames[0]} red carpet`]
        .filter((q) => q.length >= 3 && !isBlockedStockQuery(q))
        .slice(0, 2)
    : [];
  const sectionTitle =
    typeof rawS.sectionTitle === "string" ? rawS.sectionTitle.trim().slice(0, 60) : "";
  const statCallout =
    typeof rawS.statCallout === "string" ? rawS.statCallout.trim().slice(0, 24) : "";
  return {
    ...s,
    index,
    duration: 0,
    text: hint,
    visualCue: primaryQuery,
    pexelsQuery: primaryQuery,
    pexelsQueries: allQueries,
    personNames,
    literalVisualCue: undefined,
    highlightWords: [],
    brollQueries,
    statCallout,
    aiImagePrompt: `Cinematic ${primaryQuery}, dramatic lighting, photorealistic`,
    isChapterCard: false,
    chapterTitle: isPublishableChapterTitle(sectionTitle) ? sectionTitle : undefined,
    sectionTitle: isPublishableChapterTitle(sectionTitle) ? sectionTitle : undefined,
  };
}

async function parseScriptIntoScenes(script: string, maxScenes: number, topicContext?: string): Promise<Scene[]> {
  const fromMarkdown = scenesFromMarkdownScript(script, maxScenes, topicContext);
  if (fromMarkdown && fromMarkdown.length >= Math.min(2, maxScenes)) {
    console.log(`[Pipeline] Parsed ${fromMarkdown.length} scenes from markdown (no LLM re-parse)`);
    return dedupeSceneNarration(fromMarkdown);
  }

  let scenes: Scene[];
  if (maxScenes <= SCENE_PARSE_BATCH_SIZE) {
    scenes = await parseScriptIntoScenesBatch(script, maxScenes, 0);
  } else {
    const batchCount = Math.ceil(maxScenes / SCENE_PARSE_BATCH_SIZE);
    const chunks = splitScriptForSceneParsing(script, batchCount);
    const scenesPerBatch = Math.ceil(maxScenes / chunks.length);
    const allScenes: Scene[] = [];

    for (let b = 0; b < chunks.length; b++) {
      const remaining = maxScenes - allScenes.length;
      if (remaining <= 0) break;
      const count = Math.min(scenesPerBatch, remaining, SCENE_PARSE_BATCH_SIZE);
      const batchScenes = await parseScriptIntoScenesBatch(chunks[b], count, allScenes.length);
      allScenes.push(...batchScenes);
    }
    scenes = allScenes;
  }

  if (scenes.length === 0) {
    throw pipelineError(PIPELINE_ERROR.SCRIPT_PARSE, "No scenes parsed from script");
  }
  return dedupeSceneNarration(scenes.slice(0, maxScenes));
}

// ─── 2. TTS Voiceover ───────────────────────────────────────────────────────────────────────────
export type VoiceoverGenerateOptions = {
  /** Per-scene cap 800; full-script bulk uses ~10k (1–2 min documentaries). */
  maxChars?: number;
  /** One ElevenLabs call for entire narration (faster, consistent tone). */
  preferElevenLabs?: boolean;
};

function sanitizeVoiceoverText(text: string, maxChars = 800): string {
  const rawText = text
    .replace(/\[visual:[^\]]*\]/gi, "")
    .replace(/[#*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .trim();
  if (rawText.length <= maxChars) return rawText;
  return rawText.slice(0, maxChars).replace(/\s\S*$/, "");
}

/** ElevenLabs safe max per request; long scripts are chunked at scene boundaries then concatenated. */
const BULK_VO_CHUNK_CHARS = 9_500;

async function concatVoiceoverParts(partPaths: string[], outputPath: string, workDir: string): Promise<void> {
  if (partPaths.length === 1) {
    fs.copyFileSync(partPaths[0], outputPath);
    return;
  }
  const listFile = path.join(workDir, "voiceover_concat_list.txt");
  fs.writeFileSync(listFile, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -b:a 192k "${outputPath}"`
    ),
    120_000,
    "Concat bulk voiceover parts"
  );
}

/** Build one MP3 for the full narration (1+ ElevenLabs calls if script is very long). */
async function synthesizeFullNarrationMp3(
  scenes: Scene[],
  workDir: string,
  voiceId?: string,
  onTtsPart?: (part: number, totalParts: number) => void,
  sourceScript?: string
): Promise<string> {
  const fullNarration = sanitizeVoiceoverText(
    sourceScript ? extractFullNarrationText(sourceScript) : scenes.map((s) => s.text.trim()).join(" "),
    200_000
  );
  if (fullNarration.length === 0) {
    throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "No narration text for bulk voiceover");
  }

  const chunks: string[] = [];
  let rest = fullNarration;
  while (rest.length > BULK_VO_CHUNK_CHARS) {
    const slice = rest.slice(0, BULK_VO_CHUNK_CHARS);
    const breakAt = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
    const cut = breakAt > 200 ? breakAt + 1 : BULK_VO_CHUNK_CHARS;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);

  const partPaths: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onTtsPart?.(i + 1, chunks.length);
    const partPath = path.join(workDir, `full_voiceover_part_${i}.mp3`);
    await generateVoiceover(chunks[i], partPath, voiceId, {
      maxChars: BULK_VO_CHUNK_CHARS,
      preferElevenLabs: true,
    });
    partPaths.push(partPath);
  }

  const fullPath = path.join(workDir, "full_voiceover.mp3");
  await concatVoiceoverParts(partPaths, fullPath, workDir);
  return fullPath;
}

/** Full-script TTS (ElevenLabs) then split MP3 per scene by word counts — all video lengths. */
async function generateBulkSceneVoiceovers(
  scenes: Scene[],
  audioPaths: string[],
  workDir: string,
  voiceId?: string,
  onProgress?: (done: number, total: number) => void,
  sourceScript?: string
): Promise<number[]> {
  onProgress?.(0, scenes.length);
  const fullPath = await synthesizeFullNarrationMp3(scenes, workDir, voiceId, (part, total) => {
    console.log(`[Pipeline] Bulk voiceover TTS part ${part}/${total}`);
  }, sourceScript);
  await trimVoiceoverSilence(fullPath);

  const durations = await splitFullVoiceoverByScenes(fullPath, scenes, audioPaths);
  onProgress?.(scenes.length, scenes.length);
  console.log(
    `[Pipeline] Bulk voiceover: ${scenes.length} scenes, split durations ${durations.map((d) => d.toFixed(1)).join("s, ")}s`
  );
  return durations;
}

function bulkVoiceoverTimeoutMs(sceneCount: number): number {
  return Math.min(900_000, 120_000 + sceneCount * 20_000);
}

async function splitFullVoiceoverByScenes(
  fullAudioPath: string,
  scenes: Scene[],
  outputPaths: string[]
): Promise<number[]> {
  const totalDur = await probeVideoDurationSec(fullAudioPath);
  if (totalDur <= 0) {
    throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "Bulk voiceover file has no duration");
  }

  const weights = scenes.map((s) => {
    const words = sanitizeVoiceoverText(s.text, 50_000).split(/\s+/).filter(Boolean).length;
    return Math.max(1, words);
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const durations: number[] = [];
  let cursor = 0;

  for (let i = 0; i < scenes.length; i++) {
    const isLast = i === scenes.length - 1;
    const segDur = isLast
      ? Math.max(0.25, totalDur - cursor)
      : Math.max(0.25, (totalDur * weights[i]) / totalWeight);
    const out = outputPaths[i];
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -ss ${cursor.toFixed(3)} -i "${fullAudioPath}" -t ${segDur.toFixed(3)} ` +
        `-c:a libmp3lame -b:a 192k "${out}"`
      ),
      45_000,
      `Split bulk VO scene ${i}`
    );
    if (i > 0) await trimVoiceoverLeadingSilence(out);
    let dur = await probeVideoDurationSec(out);
    if (dur <= 0) dur = segDur;
    durations.push(dur);
    cursor += segDur;
  }
  return durations;
}

/** Trim only leading silence on per-scene splits (keeps scene boundaries tight). */
async function trimVoiceoverLeadingSilence(audioPath: string): Promise<void> {
  const tmpPath = audioPath.replace(/\.mp3$/i, "_leadtrim.mp3");
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${audioPath}" -af ` +
        `"silenceremove=start_periods=1:start_duration=0.04:start_threshold=-40dB:detection=peak" ` +
        `-c:a libmp3lame -b:a 192k "${tmpPath}"`
      ),
      30_000,
      "Trim leading silence on scene VO"
    );
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 200) {
      fs.unlinkSync(audioPath);
      fs.renameSync(tmpPath, audioPath);
    } else if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/** UI voices are ElevenLabs IDs (stored in voices.fishAudioReferenceId). Never remap to Fish. */
async function synthesizeElevenLabsVoice(
  text: string,
  outputPath: string,
  elevenVoiceId: string,
  timeoutMs: number,
  label: string
): Promise<number> {
  if (!ELEVENLABS_API_KEY) {
    throw pipelineError(
      PIPELINE_ERROR.VOICEOVER,
      "ElevenLabs API key is not configured. Add ELEVENLABS_API_KEY in Railway to use your selected voice."
    );
  }
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await withTimeout(
        fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}`, {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: { stability: 0.58, similarity_boost: 0.88, style: 0.05, use_speaker_boost: true },
          }),
        }),
        timeoutMs,
        `${label} attempt ${attempt}`
      );
      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 600 + attempt * 600));
        continue;
      }
      if (!response.ok) {
        const errText = await response.text();
        throw pipelineError(
          PIPELINE_ERROR.VOICEOVER,
          `ElevenLabs voice ${elevenVoiceId.slice(0, 8)}… HTTP ${response.status}: ${errText.slice(0, 200)}`
        );
      }
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      if (audioBuffer.length < 100) {
        throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "ElevenLabs returned empty audio");
      }
      fs.writeFileSync(outputPath, audioBuffer);
      const dur = await probeVideoDurationSec(outputPath);
      console.log(`[Pipeline] ElevenLabs ${label}: voice=${elevenVoiceId.slice(0, 10)}… ${dur.toFixed(1)}s`);
      return dur > 0 ? dur : Math.max(3, Math.round(audioBuffer.length / 40000));
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw pipelineError(PIPELINE_ERROR.VOICEOVER, "ElevenLabs TTS failed after retries");
}

// Per-scene fallback only when bulk path is not used. Default pipeline: full-script ElevenLabs + split.
export async function generateVoiceover(
  text: string,
  outputPath: string,
  voiceId?: string,
  options?: VoiceoverGenerateOptions
): Promise<number> {
  const maxChars = options?.maxChars ?? 800;
  const cleanText = sanitizeVoiceoverText(text, maxChars);

  const MAX_ATTEMPTS = 3;
  const TTS_TIMEOUT_MS = maxChars > 2000 ? 180_000 : 90_000;

  const selectedElevenVoice = voiceId?.trim();
  // User picked a voice in the dashboard → always that exact ElevenLabs voice (never Fish remap).
  if (selectedElevenVoice) {
    return synthesizeElevenLabsVoice(
      cleanText,
      outputPath,
      selectedElevenVoice,
      TTS_TIMEOUT_MS,
      "selected voice"
    );
  }

  if (elevenLabsOnlyVoice()) {
    return synthesizeElevenLabsVoice(
      cleanText,
      outputPath,
      "pNInz6obpgDQGcFmaJgB",
      TTS_TIMEOUT_MS,
      "default documentary"
    );
  }

  if (ELEVENLABS_API_KEY && options?.preferElevenLabs) {
    return synthesizeElevenLabsVoice(
      cleanText,
      outputPath,
      "pNInz6obpgDQGcFmaJgB",
      TTS_TIMEOUT_MS,
      "default documentary"
    );
  }

  const fishReferenceId = "0327fdb5da9e4fd782899a8058c8ae2b";
  if (FISH_AUDIO_API_KEY && !options?.preferElevenLabs) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await withTimeout(
          fetch("https://api.fish.audio/v1/tts", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${FISH_AUDIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: cleanText,
              reference_id: fishReferenceId,
              format: "mp3",
              mp3_bitrate: 192,
              normalize: true,
              latency: "normal",
            }),
          }),
          TTS_TIMEOUT_MS,
          `Fish Audio TTS attempt ${attempt}`
        );

        if (response.status === 429) {
          const waitMs = 1000 + attempt * 1000;
          console.warn(`[Pipeline] Fish Audio 429 (attempt ${attempt}), retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          throw pipelineError(PIPELINE_ERROR.VOICEOVER, `Fish Audio HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "Fish Audio returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[Pipeline] Fish Audio TTS written: ${audioBuffer.length} bytes to ${outputPath}`);

        let durationSec = Math.max(3, Math.round(audioBuffer.length / 40000));
        try {
          const { execSync: es } = await import('child_process');
          for (const probePath of FFPROBE_PATHS()) {
            try {
              const probeOut = es(`"${probePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
              const parsed = parseFloat(probeOut.trim());
              if (!isNaN(parsed) && parsed > 0) { durationSec = Math.ceil(parsed); break; }
            } catch { /* try next */ }
          }
        } catch { /* use estimate */ }
        console.log(`[Pipeline] Fish Audio TTS scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? '?'}: ${durationSec}s`);
        return durationSec;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[Pipeline] Fish Audio failed after ${MAX_ATTEMPTS} attempts:`, err);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // ── ElevenLabs TTS (FALLBACK — try if Fish Audio fails and key available) ───────────
  if (ELEVENLABS_API_KEY) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Map voiceId to ElevenLabs voice ID, or use a high-quality default
        // Default: "Adam" = pNInz6obpgDQGcFmaJgB (deep documentary voice)
        const elevenVoiceId = voiceId || "pNInz6obpgDQGcFmaJgB";
        const response = await withTimeout(
          fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}`, {
            method: "POST",
            headers: {
              "xi-api-key": ELEVENLABS_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: cleanText,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
            }),
          }),
          TTS_TIMEOUT_MS,
          `ElevenLabs TTS attempt ${attempt}`
        );

        if (response.status === 429) {
          const waitMs = 500 + attempt * 500;
          console.warn(`[Pipeline] ElevenLabs 429 (attempt ${attempt}), retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          throw pipelineError(PIPELINE_ERROR.VOICEOVER, `ElevenLabs HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length < 100) throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "ElevenLabs returned empty audio");

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[Pipeline] ElevenLabs TTS written: ${audioBuffer.length} bytes to ${outputPath}`);

        let durationSec = 5;
        try {
          const { execSync: es } = await import('child_process');
          for (const probePath of FFPROBE_PATHS()) {
            try {
              const probeOut = es(`"${probePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
              const parsed = parseFloat(probeOut.trim());
              if (!isNaN(parsed) && parsed > 0) { durationSec = Math.ceil(parsed); break; }
            } catch { /* try next */ }
          }
        } catch { /* use default */ }
        if (durationSec === 5 && audioBuffer.length > 1000) {
          durationSec = Math.max(3, Math.round(audioBuffer.length / 40000));
        }
        console.log(`[Pipeline] ElevenLabs TTS scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? "?"}: ${durationSec}s`);
        return durationSec;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[Pipeline] ElevenLabs failed after ${MAX_ATTEMPTS} attempts:`, err);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // Fallback 2: Google TTS (free, no API key, works in any environment)
  // Uses the unofficial Google Translate TTS endpoint — reliable for short texts
  try {
    const chunks: string[] = [];
    const words = cleanText.split(' ');
    let chunk = '';
    for (const word of words) {
      if ((chunk + ' ' + word).trim().length > 180) {
        chunks.push(chunk.trim());
        chunk = word;
      } else {
        chunk = (chunk + ' ' + word).trim();
      }
    }
    if (chunk) chunks.push(chunk);

    const chunkFiles: string[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkPath = outputPath.replace('.mp3', `_gtts_chunk${ci}.mp3`);
      const encoded = encodeURIComponent(chunks[ci]);
      const gttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
      const gResp = await withTimeout(
        fetch(gttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }),
        15_000, `gTTS chunk ${ci}`
      );
      if (!gResp.ok) throw pipelineError(PIPELINE_ERROR.VOICEOVER, `gTTS HTTP ${gResp.status}`);
      const buf = Buffer.from(await gResp.arrayBuffer());
      if (buf.length < 100) throw pipelineError(PIPELINE_ERROR.VOICEOVER_EMPTY, "gTTS empty response");
      fs.writeFileSync(chunkPath, buf);
      chunkFiles.push(chunkPath);
    }

    if (chunkFiles.length === 1) {
      fs.renameSync(chunkFiles[0], outputPath);
    } else {
      // Concatenate chunks with FFmpeg
      const listFile = outputPath.replace('.mp3', '_gtts_list.txt');
      fs.writeFileSync(listFile, chunkFiles.map(f => `file '${f}'`).join('\n'));
      await withTimeout(
        exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`),
        20_000, 'gTTS concat'
      );
      chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      try { fs.unlinkSync(listFile); } catch {}
    }

    const { execSync: es } = await import('child_process');
    let durationSec = Math.max(3, Math.ceil(cleanText.split(' ').length / 2.5));
    try {
      const probeOut = es(`"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, { encoding: 'utf8', timeout: 8000 });
      const parsed = parseFloat(probeOut.trim());
      if (!isNaN(parsed) && parsed > 0) durationSec = Math.ceil(parsed);
    } catch { /* use estimate */ }

    console.log(`[Pipeline] gTTS fallback scene ${outputPath.match(/scene_(\d+)/)?.[1] ?? '?'}: ${durationSec}s`);
    return durationSec;
  } catch (gErr) {
    console.warn('[Pipeline] gTTS fallback failed:', gErr);
  }

  // Silent fallback
  const estimatedDuration = Math.max(3, Math.ceil(cleanText.split(" ").length / 2.5));
  try {
    await withTimeout(
      exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${estimatedDuration} -c:a libmp3lame -b:a 64k "${outputPath}"`),
      10_000, "Silent audio fallback"
    );
  } catch {
    fs.writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]));
  }
  return estimatedDuration;
}

// ─── 3a. Stability AI Image → Video Loop (PRIMARY visual) ────────────────────
async function generateStabilityAIClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!STABILITY_AI_API_KEY) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: No Stability AI key, skipping AI image`);
    return null;
  }

  try {
    const useUltra = process.env.STABILITY_AI_TIER === "ultra";
    const endpoint = useUltra
      ? "https://api.stability.ai/v2beta/stable-image/generate/ultra"
      : "https://api.stability.ai/v2beta/stable-image/generate/core";
    console.log(
      `[Pipeline] Scene ${sceneIndex}: Stability ${useUltra ? "Ultra" : "Core"} (~$0.03–0.08/img)...`
    );
    const t = Date.now();

    const negative =
      "blurry, low quality, watermark, text, logo, ugly, deformed, cartoon, anime, illustration";
    const form = new FormData();
    form.append("prompt", prompt.slice(0, 1000));
    form.append("aspect_ratio", "16:9");
    form.append("output_format", "png");
    form.append("negative_prompt", negative);
    form.append("style_preset", "photographic");

    let imgBuffer: Buffer | null = null;
    const coreResp = await withTimeout(
      fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STABILITY_AI_API_KEY}`,
          Accept: "image/*",
        },
        body: form,
      }),
      45_000,
      `Stability Core scene ${sceneIndex}`
    );

    if (coreResp.ok) {
      const raw = Buffer.from(await coreResp.arrayBuffer());
      if (raw.length > 50_000) imgBuffer = raw;
    } else {
      const errText = await coreResp.text();
      console.warn(
        `[Pipeline] Scene ${sceneIndex}: Stability v2beta ${coreResp.status}: ${errText.slice(0, 180)} — legacy SDXL`
      );
      const stabilityPayload = {
        text_prompts: [
          { text: prompt, weight: 1 },
          { text: negative, weight: -1 },
        ],
        cfg_scale: 7,
        height: 768,
        width: 1344,
        samples: 1,
        steps: 35,
      };
      const legacyResp = await withTimeout(
        fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${STABILITY_AI_API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(stabilityPayload),
        }),
        45_000,
        `Stability SDXL scene ${sceneIndex}`
      );
      if (legacyResp.ok) {
        const result = await legacyResp.json() as {
          artifacts?: Array<{ base64: string; finishReason: string }>;
        };
        const artifact = result.artifacts?.[0];
        if (artifact?.base64) imgBuffer = Buffer.from(artifact.base64, "base64");
      }
    }

    if (!imgBuffer) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Stability AI returned no image`);
      return null;
    }
    const pngPath = outputPath.replace(".mp4", "_ai.png");
    fs.writeFileSync(pngPath, imgBuffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Stability AI image in ${((Date.now()-t)/1000).toFixed(1)}s (${(imgBuffer.length/1024).toFixed(0)}KB)`);

    // Convert to video — Ken Burns with blur-fill/polaroid when documentary style enabled
    const fps = 25;
    if (documentaryStyleEnabled()) {
      const filterComplex = resolveStillCompositionVF(duration, sceneIndex, 0, false);
      try {
        await withTimeout(
          exec(`${FFMPEG_BIN} ${buildStillEncodeArgs(pngPath, outputPath, duration, filterComplex)}`),
          90_000,
          `AI image to video scene ${sceneIndex}`
        );
      } catch (docErr) {
        console.warn(`[Pipeline] Scene ${sceneIndex}: AI documentary still failed, using simple Ken Burns:`, (docErr as Error).message);
        const fallbackFc = buildSimpleKenBurnsVF(duration, false);
        await withTimeout(
          exec(`${FFMPEG_BIN} ${buildStillEncodeArgs(pngPath, outputPath, duration, fallbackFc)}`),
          90_000,
          `AI image to video scene ${sceneIndex} (fallback)`
        );
      }
    } else {
      const totalFrames = Math.ceil(duration * fps);
      const zoomStep = 0.0003; // slow 7% zoom over full duration
      const direction = sceneIndex % 2 === 0 ? 1 : -1;
      const panX = direction > 0 ? `iw/2-(iw/zoom/2)` : `iw/2-(iw/zoom/2)+2`;
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
          `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},` +
          `zoompan=z='min(zoom+${zoomStep},1.07)':x='${panX}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
          `-t ${duration} -r ${fps} -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p "${outputPath}"`
        ),
        90_000,
        `AI image to video scene ${sceneIndex}`
      );
    }

    try { fs.unlinkSync(pngPath); } catch { /* ignore */ }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      return outputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Stability AI clip failed:`, err);
    return null;
  }
}

// ─── 3b. Pexels Stock Clips (SECONDARY — multiple per scene) ─────────────────
async function fetchPexelsClips(
  query: string,
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 3,
  extraQueries?: string[],
  strictQueries = false,
  fileTag = "pexels",
  excludeVideoIds?: Set<number>,
  candidateOffset = 0,
  downloadRetries = 3
): Promise<string[]> {
  if (!PEXELS_API_KEY) return [];

  const results: string[] = [];

  // Never fall back to generic nature/city b-roll — that produces irrelevant footage (wind turbines, cyclists, etc.)
  const queryList = Array.from(
    new Set(
      [query, ...(extraQueries ?? [])]
        .filter((q) => q && q.trim().length > 2 && !isBlockedStockQuery(q))
        .map((q) => simplifyStockSearchWord(q, q, true))
    )
  );
  if (queryList.length === 0) return [];
  // Deduplicate
  const seen = new Set<string>();
  const uniqueQueries = queryList.filter(q => { if (seen.has(q)) return false; seen.add(q); return true; });

  for (const currentQuery of uniqueQueries) {
    if (results.length >= count) break; // Stop if we have enough clips

    try {
      // HD quality: large size (min 1280px), landscape orientation, fetch 15 candidates
      const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(currentQuery)}&per_page=15&size=large&orientation=landscape&min_duration=4`;
      const searchResp = await withTimeout(
        fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
        10_000,
        `Pexels search scene ${sceneIndex} query "${currentQuery}"`
      );

      if (!searchResp.ok) continue;

    const searchData = await searchResp.json() as {
      videos?: Array<{
        id: number;
        duration: number;
        url?: string;
        video_files: Array<{ width: number; height: number; link: string }>;
      }>;
    };

    if (!searchData.videos?.length) continue;

    // Filter: min 3s duration, skip already-used Pexels IDs, sort by resolution descending
    const filtered = searchData.videos
      .filter(v => v.duration >= 3 && !excludeVideoIds?.has(v.id) && !isRejectedPexelsVideo(v))
      .sort((a, b) => {
        const aMax = Math.max(...a.video_files.map(f => f.width));
        const bMax = Math.max(...b.video_files.map(f => f.width));
        return bMax - aMax;
      });
    const offset = filtered.length > 0 ? candidateOffset % filtered.length : 0;
    const candidates = [...filtered.slice(offset), ...filtered.slice(0, offset)].slice(0, count * 3);

    const needed = count - results.length;
    // Download up to `needed` clips in parallel
    const downloadLimit = pLimit(needed);
    const downloadResults = await Promise.allSettled(
      candidates.slice(0, needed).map((video, idx) => downloadLimit(async () => {
        // Prefer 720p (1280px wide) — cap at 1280 to avoid large file download timeouts
        // 4K files (3840px+) and 1080p (1920px) are too large and cause FetchError: aborted
        const videoFile = video.video_files
          .filter(f => f.width >= 1280 && f.width <= 1280)  // exact 720p/1280p
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files
          .filter(f => f.width >= 960 && f.width <= 1280)   // 960-1280px range
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files
          .filter(f => f.width >= 640 && f.width <= 1920)   // any HD
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files
          .filter(f => f.width <= 1920)
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files.sort((a, b) => a.width - b.width)[0]; // fallback: smallest available

        if (!videoFile?.link) return null;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_${fileTag}_vid${video.id}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${fileTag}_vid${video.id}.mp4`);

        // Download with retry logic
        let downloadResp;
        let buffer: Buffer | null = null;
        let retries = downloadRetries;
        
        while (retries > 0 && !buffer) {
          try {
            downloadResp = await withTimeout(
              fetch(videoFile.link),
              45_000,
              `Download Pexels clip ${idx} scene ${sceneIndex} (attempt ${4 - retries}/3)`
            );
            if (!downloadResp.ok) {
              retries--;
              if (retries > 0) await new Promise(r => setTimeout(r, 1000)); // Wait before retry
              continue;
            }

            buffer = Buffer.from(await downloadResp.arrayBuffer());
            
            // Validate buffer size (minimum 50KB for valid video)
            if (buffer.length < 50_000) {
              console.warn(`[Pipeline] Pexels clip ${idx} too small (${buffer.length} bytes), retrying...`);
              buffer = null;
              retries--;
              if (retries > 0) await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            
            break; // Success
          } catch (err) {
            console.warn(`[Pipeline] Download attempt failed for Pexels clip ${idx}:`, err);
            retries--;
            if (retries > 0) await new Promise(r => setTimeout(r, 1000));
          }
        }
        
        if (!buffer) {
          console.warn(`[Pipeline] Failed to download Pexels clip ${idx} after 3 attempts`);
          return null;
        }

        fs.writeFileSync(rawPath, buffer);

        // Validate downloaded file with ffprobe before processing
        // Use system ffprobe which supports -show_entries (ffmpeg-static does not have drawtext/libfreetype)
        try {
          const probeCmd = `"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`;
          const probeResult = await withTimeout(
            exec(probeCmd),
            10_000,
            `Probe Pexels clip ${idx}`
          );
          const probeDuration = typeof probeResult === 'string' ? probeResult : (probeResult as any).stdout || '';
          const duration = parseFloat(probeDuration);
          if (isNaN(duration) || duration < 1) {
            console.warn(`[Pipeline] Pexels clip ${idx} has invalid duration: ${duration}`);
            try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
            return null;
          }
          // Second check: verify video stream is readable (catches 'moov atom not found' and other corrupt MP4 errors)
          const streamCheckCmd = `"${FFPROBE_BIN}" -v error -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`;
          const streamResult = await withTimeout(
            exec(streamCheckCmd),
            10_000,
            `Stream check Pexels clip ${idx}`
          );
          const streamOutput = typeof streamResult === 'string' ? streamResult : (streamResult as any).stdout || '';
          if (!streamOutput.includes('video')) {
            console.warn(`[Pipeline] Pexels clip ${idx} has no readable video stream (corrupt/incomplete MP4), skipping`);
            try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
            return null;
          }
        } catch (err) {
          console.warn(`[Pipeline] Failed to validate Pexels clip ${idx}:`, err);
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
          return null;
        }

        const startSec = ((sceneIndex + idx) * 0.37) % 1.2;
        const trimmed = await trimDownloadedStockClip(
          rawPath,
          outPath,
          clipDuration,
          video.duration,
          `Trim Pexels clip ${idx} scene ${sceneIndex}`,
          startSec
        );

        try { fs.unlinkSync(rawPath); } catch { /* ignore */ }

        if (trimmed) {
          excludeVideoIds?.add(video.id);
          return outPath;
        }
        return null;
      }))
    );

    for (const r of downloadResults) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    } catch (err) {
      console.warn(`[Pipeline] Pexels search failed for query "${currentQuery}" scene ${sceneIndex}:`, err);
    }
  }

  return results;
}

// ─── 3b2. Fetch B-roll Clips from Pexels (cutaway footage for visual variety) ─────────────
// Fetches 1-2 B-roll clips using scene.brollQueries (LLM-generated cutaway queries).
// These are inserted between main clips to add visual variety (Vidrush style).
async function fetchBrollClips(
  brollQueries: string[],
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  excludeVideoIds?: Set<number>
): Promise<string[]> {
  if ((!PEXELS_API_KEY && !PIXABAY_API_KEY) || !brollQueries || brollQueries.length === 0) return [];
  const results: string[] = [];
  for (let qi = 0; qi < brollQueries.length && results.length < 3; qi++) {
    const query = simplifyStockSearchWord(brollQueries[qi] ?? "", brollQueries[qi] ?? "", true);
    if (!query || query.length < 3 || isBlockedStockQuery(query)) continue;
    try {
      const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&size=large&orientation=landscape&min_duration=4`;
      const searchResp = await withTimeout(
        fetch(searchUrl, { headers: { Authorization: PEXELS_API_KEY } }),
        10_000,
        `B-roll Pexels search scene ${sceneIndex} query "${query}"`
      );
      if (!searchResp.ok) {
        if (PIXABAY_API_KEY) {
          const pixPaths = await fetchPixabayClips(
            query, clipDuration, workDir, sceneIndex, 1, `scene_${sceneIndex}_broll_pix`, true, undefined, qi
          );
          if (pixPaths[0]) {
            results.push(pixPaths[0]);
            console.log(`[Pipeline] Scene ${sceneIndex}: B-roll Pixabay: "${query}"`);
            continue;
          }
        }
        continue;
      }
      const searchData = await searchResp.json() as {
        videos?: Array<{ id: number; duration: number; video_files: Array<{ width: number; height: number; link: string }> }>;
      };
      if (!searchData.videos?.length) {
        if (PIXABAY_API_KEY) {
          const pixPaths = await fetchPixabayClips(
            query, clipDuration, workDir, sceneIndex, 1, `scene_${sceneIndex}_broll_pix`, true, undefined, qi
          );
          if (pixPaths[0]) {
            results.push(pixPaths[0]);
            console.log(`[Pipeline] Scene ${sceneIndex}: B-roll Pixabay: "${query}"`);
            continue;
          }
        }
        continue;
      }
      const candidates = searchData.videos
        .filter(v => v.duration >= 3 && !excludeVideoIds?.has(v.id))
        .slice(0, 3);
      for (const video of candidates) {
        if (results.length >= 3) break;
        const videoFile = video.video_files
          .filter(f => f.width >= 1280 && f.width <= 1920)
          .sort((a, b) => b.width - a.width)[0]
          || video.video_files.filter(f => f.width <= 1920).sort((a, b) => b.width - a.width)[0];
        if (!videoFile?.link) continue;
        const rawPath = path.join(workDir, `scene_${sceneIndex}_broll_vid${video.id}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_broll_vid${video.id}.mp4`);
        try {
          const dlResp = await fetchWithTimeout(videoFile.link, 8_000, `B-roll download scene ${sceneIndex}`);
          if (!dlResp.ok) continue;
          const buffer = Buffer.from(await dlResp.arrayBuffer());
          if (buffer.length < 50_000) continue;
          fs.writeFileSync(rawPath, buffer);
          const startSec = (sceneIndex + qi) * 0.29 % 1.0;
          const trimmed = await trimDownloadedStockClip(
            rawPath,
            outPath,
            clipDuration,
            video.duration,
            `B-roll trim scene ${sceneIndex}`,
            startSec
          );
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
          if (trimmed) {
            excludeVideoIds?.add(video.id);
            results.push(outPath);
            console.log(`[Pipeline] Scene ${sceneIndex}: B-roll clip added: "${query}"`);
          }
        } catch (err) {
          console.warn(`[Pipeline] B-roll clip failed for scene ${sceneIndex} query "${query}":`, (err as Error).message);
          try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
        }
        break; // one clip per query
      }
    } catch (err) {
      console.warn(`[Pipeline] B-roll search failed for scene ${sceneIndex} query "${query}":`, (err as Error).message);
    }
  }
  return results;
}


// ─── 3b3. Fetch Clips from Pixabay (B-roll + main visual source) ─────────────────────────────
// Pixabay Video API: free, no attribution required for commercial use.
// Returns up to `count` trimmed HD clips matching the query.
async function fetchPixabayClips(
  query: string,
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  suffix: string = "pixabay",
  strictQueries = false,
  excludeVideoIds?: Set<number>,
  candidateOffset = 0
): Promise<string[]> {
  if (!PIXABAY_API_KEY) return [];
  const results: string[] = [];

  const queryList = Array.from(
    new Set(
      [query]
        .filter((q) => q && q.trim().length > 2 && !isBlockedStockQuery(q))
        .map((q) => simplifyStockSearchWord(q, q, true))
    )
  );
  if (queryList.length === 0) return [];
  const seen = new Set<string>();
  const uniqueQueries = queryList.filter(q => { if (seen.has(q)) return false; seen.add(q); return true; });

  for (const currentQuery of uniqueQueries) {
    if (results.length >= count) break;
    try {
      // Pixabay Video API: https://pixabay.com/api/docs/#api_videos
      // video_type=film gives real footage (not animation); min_width=1280 for HD
      const searchUrl =
        `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}` +
        `&q=${encodeURIComponent(currentQuery)}` +
        `&per_page=10&video_type=film&min_width=1280&safesearch=true`;

      const searchResp = await withTimeout(
        fetch(searchUrl),
        10_000,
        `Pixabay search scene ${sceneIndex} query "${currentQuery}"`
      );
      if (!searchResp.ok) {
        console.warn(`[Pipeline] Pixabay search HTTP ${searchResp.status} for "${currentQuery}"`);
        continue;
      }

      const searchData = await searchResp.json() as {
        totalHits?: number;
        hits?: Array<{
          id: number;
          duration: number;
          tags?: string;
          videos: {
            large?: { url: string; width: number; height: number; size: number };
            medium?: { url: string; width: number; height: number; size: number };
            small?: { url: string; width: number; height: number; size: number };
          };
        }>;
      };

      if (!searchData.hits?.length) continue;

      // Filter: min 3s duration, skip used IDs, sort by resolution descending
      const filtered = searchData.hits
        .filter(v => v.duration >= 3 && !excludeVideoIds?.has(v.id) && !hasBlockedStockTags(v.tags))
        .sort((a, b) => {
          const aW = a.videos.large?.width ?? a.videos.medium?.width ?? 0;
          const bW = b.videos.large?.width ?? b.videos.medium?.width ?? 0;
          return bW - aW;
        });
      const offset = filtered.length > 0 ? candidateOffset % filtered.length : 0;
      const candidates = [...filtered.slice(offset), ...filtered.slice(0, offset)].slice(0, count * 2);

      for (let idx = 0; idx < candidates.length && results.length < count; idx++) {
        const video = candidates[idx];
        // Prefer large (1080p) → medium (720p) → small
        const videoFile =
          video.videos.large?.url ? video.videos.large :
          video.videos.medium?.url ? video.videos.medium :
          video.videos.small?.url ? video.videos.small : null;

        if (!videoFile?.url) continue;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_vid${video.id}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_vid${video.id}.mp4`);

        try {
          // Download with retry
          let buffer: Buffer | null = null;
          for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
            try {
              const dlResp = await withTimeout(
                fetch(videoFile.url),
                20_000,
                `Pixabay download scene ${sceneIndex} clip ${idx} attempt ${attempt + 1}`
              );
              if (!dlResp.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
              const buf = Buffer.from(await dlResp.arrayBuffer());
              if (buf.length < 200_000) { await new Promise(r => setTimeout(r, 1000)); continue; }
              buffer = buf;
            } catch (dlErr) {
              console.warn(`[Pipeline] Pixabay download attempt ${attempt + 1} failed:`, dlErr);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          if (!buffer) continue;

          fs.writeFileSync(rawPath, buffer);

          // Validate with ffprobe
          try {
            const probeResult = await withTimeout(
              exec(`"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`),
              10_000, `Probe Pixabay clip ${idx}`
            );
            const dur = parseFloat(typeof probeResult === 'string' ? probeResult : (probeResult as any).stdout || '');
            if (isNaN(dur) || dur < 1) { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }
          } catch { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }

          // Stable trim — color grade applied later in composeSceneVideo
          const startSec = (sceneIndex + idx) * 0.33 % 1.1;
          const trimmed = await trimDownloadedStockClip(
            rawPath,
            outPath,
            clipDuration,
            video.duration,
            `Trim Pixabay clip ${idx} scene ${sceneIndex}`,
            startSec
          );

          try { fs.unlinkSync(rawPath); } catch { /**/ }

          if (trimmed) {
            excludeVideoIds?.add(video.id);
            results.push(outPath);
            console.log(`[Pipeline] Scene ${sceneIndex}: Pixabay clip added: "${currentQuery}"`);
          }
        } catch (err) {
          console.warn(`[Pipeline] Pixabay clip ${idx} failed for scene ${sceneIndex}:`, (err as Error).message);
          try { fs.unlinkSync(rawPath); } catch { /**/ }
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Pixabay search failed for query "${currentQuery}" scene ${sceneIndex}:`, err);
    }
  }

  return results;
}

/** Encode a still image to MP4 with Ken Burns; documentary blur-fill with simple fallback. */
async function encodeStillImageMp4(
  imgPath: string,
  outPath: string,
  duration: number,
  label: string,
  sceneIndex: number,
  beatIndex: number,
  personPortrait: boolean
): Promise<void> {
  const fps = 25;
  const frames = stillOutputFrameCount(duration, fps);

  if (documentaryStyleEnabled()) {
    const filterComplex = resolveStillCompositionVF(duration, sceneIndex, beatIndex, personPortrait);
    try {
      await withTimeout(
        exec(`${FFMPEG_BIN} ${buildStillEncodeArgs(imgPath, outPath, duration, filterComplex)}`),
        45_000,
        label
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        const probed = await probeVideoDurationSec(outPath);
        if (probed >= duration * 0.5) return;
        console.warn(`[Pipeline] ${label}: documentary still too short (${probed.toFixed(2)}s), retrying simple Ken Burns`);
      }
    } catch (err) {
      console.warn(`[Pipeline] ${label}: documentary still encode failed, retrying simple Ken Burns:`, (err as Error).message);
    }
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    const fallbackFc = buildSimpleKenBurnsVF(duration, personPortrait);
    await withTimeout(
      exec(`${FFMPEG_BIN} ${buildStillEncodeArgs(imgPath, outPath, duration, fallbackFc)}`),
      45_000,
      `${label} (fallback)`
    );
    return;
  }

  const totalFrames = frames;
  const zoomEnd = personPortrait ? 1.02 : 1.03;
  const zoomStep = (zoomEnd - 1.0) / totalFrames;
  const padW = Math.round(VIDEO_WIDTH * 1.05);
  const padH = Math.round(VIDEO_HEIGHT * 1.05);
  const cropY = personPortrait ? "0" : `(ih-${VIDEO_HEIGHT})/2`;
  const yExpr = personPortrait ? "ih/4-(ih/zoom/4)" : "ih/2-(ih/zoom/2)";
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -i "${imgPath}" ` +
        `-vf "scale=${personPortrait ? VIDEO_WIDTH : padW}:${personPortrait ? VIDEO_HEIGHT : padH}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:${cropY},` +
        `select='eq(n\\,0)',` +
        `zoompan=z='min(zoom+${zoomStep.toFixed(7)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='${yExpr}':` +
        `d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
        `-frames:v ${totalFrames} -c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p -r ${fps} "${outPath}"`
    ),
    45_000,
    label
  );
}

/** Gentle Ken Burns for stills: ~3% center zoom. */
async function convertImageToVideoGentle(
  imgPath: string,
  outPath: string,
  duration: number,
  label: string,
  sceneIndex = 0,
  beatIndex = 0
): Promise<void> {
  await encodeStillImageMp4(imgPath, outPath, duration, label, sceneIndex, beatIndex, false);
}

/** Person stills: top-aligned 16:9 crop so faces stay visible on red-carpet / full-body photos. */
async function convertImageToVideoPersonPortrait(
  imgPath: string,
  outPath: string,
  duration: number,
  label: string,
  sceneIndex = 0,
  beatIndex = 0
): Promise<void> {
  await encodeStillImageMp4(imgPath, outPath, duration, label, sceneIndex, beatIndex, true);
}

async function stillImageToVideo(
  imgPath: string,
  outPath: string,
  duration: number,
  label: string,
  personPortrait: boolean,
  sceneIndex = 0,
  beatIndex = 0
): Promise<void> {
  if (personPortrait) {
    await convertImageToVideoPersonPortrait(imgPath, outPath, duration, label, sceneIndex, beatIndex);
  } else {
    await convertImageToVideoGentle(imgPath, outPath, duration, label, sceneIndex, beatIndex);
  }
}

function normalizeImageSourceUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

// ─── 3c2. Wikimedia Commons Image Search ────────────────────────────────────
// Searches Wikimedia Commons for freely licensed images (good for celebrities, news, etc.)
async function fetchWikimediaImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = ""
): Promise<string[]> {
  const results: string[] = [];
  try {
    // Search Wikimedia Commons for images
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=10&format=json&origin=*`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
      8_000,
      `Wikimedia search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as { query?: { search?: Array<{ title: string }> } };
    const titles = searchData.query?.search?.map(r => r.title).slice(0, count * 2) || [];
    if (!titles.length) return [];

    // Get image info for each result
    for (let i = 0; i < Math.min(titles.length, count); i++) {
      try {
        const title = titles[i];
        const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|mime|size&format=json&origin=*`;
        const infoResp = await withTimeout(
          fetch(infoUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          8_000,
          `Wikimedia info scene ${sceneIndex}`
        );
        if (!infoResp.ok) continue;
        const infoData = await infoResp.json() as { query?: { pages?: Record<string, { imageinfo?: Array<{ url: string; mime: string; size: number }> }> } };
        const pages = infoData.query?.pages || {};
        const page = Object.values(pages)[0];
        const imageInfo = page?.imageinfo?.[0];
        if (!imageInfo?.url) continue;
        // Only use JPEG/PNG images, skip SVG/PDF/audio/video
        if (!imageInfo.mime.startsWith('image/jpeg') && !imageInfo.mime.startsWith('image/png')) continue;
        // Skip very small images
        if (imageInfo.size < 10_000) continue;

        // Download the image
        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}wiki_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}wiki_${i}.mp4`);
        const imgResp = await withTimeout(
          fetch(imageInfo.url, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          15_000,
          `Wikimedia download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuffer.length < 10_000) continue;
        fs.writeFileSync(imgPath, imgBuffer);

        await stillImageToVideo(
          imgPath,
          outPath,
          duration,
          `Wikimedia image to video scene ${sceneIndex}`,
          /portrait|face|headshot|person|celebrity/i.test(query),
          sceneIndex
        );
        try { fs.unlinkSync(imgPath); } catch { /* ignore */ }
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
          results.push(outPath);
          console.log(`[Pipeline] Scene ${sceneIndex}: Wikimedia image added: ${title}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] Wikimedia image ${i} failed for scene ${sceneIndex}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Wikimedia search failed for scene ${sceneIndex}:`, err);
  }
  return results;
}

// ─── 3c2b. Openverse API Image Search ─────────────────────────────────────
// Searches Openverse (WordPress/Automattic) for CC-licensed photos of public figures.
// No API key required. Returns CC-BY licensed images — safe for commercial use.
// Great source for celebrities, politicians, athletes, and public events.
async function fetchOpenverseImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  maxResults: number = 2,
  fileTag = "",
  opts: { personPortrait?: boolean; dedup?: VisualDedupState } = {}
): Promise<string[]> {
  const results: string[] = [];
  try {
    // Search Openverse for CC-licensed images (commercial use + modification allowed)
    const searchUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&page_size=${maxResults * 3}&format=json`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation; contact@fastvid.ai)' } }),
      8000,
      `Openverse search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Openverse error ${searchResp.status}`);
      return [];
    }
    const payload = await searchResp.json() as { results?: Array<{ id: string; url: string; title?: string; license?: string; attribution?: string }> };
    const images = payload.results || [];
    if (images.length === 0) return [];

    for (let i = 0; i < Math.min(images.length, maxResults * 2) && results.length < maxResults; i++) {
      try {
        const imgUrl = images[i].url;
        if (!imgUrl || !/\.(jpg|jpeg|png|webp)/i.test(imgUrl)) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}openverse_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}openverse_${i}.mp4`);

        // Download image
        const imgResp = await withTimeout(
          fetch(imgUrl),
          10000,
          `Openverse image download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuf = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuf.length < 5000) continue; // skip tiny/broken images
        fs.writeFileSync(imgPath, imgBuf);

        await stillImageToVideo(
          imgPath,
          outPath,
          duration,
          `Openverse image to video scene ${sceneIndex}`,
          Boolean(opts.personPortrait) || /portrait|face|headshot/i.test(query),
          sceneIndex
        );
        try { fs.unlinkSync(imgPath); } catch { /**/ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
          const urlKey = normalizeImageSourceUrl(imgUrl);
          if (opts.dedup?.usedImageUrls.has(urlKey)) continue;
          opts.dedup?.usedImageUrls.add(urlKey);
          results.push(outPath);
          console.log(`[Pipeline] Scene ${sceneIndex}: Openverse image added: ${images[i].title?.slice(0, 60) || imgUrl.slice(0, 60)}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] Openverse image ${i} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Openverse search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

// ─── 3c2c. Unsplash API Image Search ─────────────────────────────────────────
// High-quality freely usable photos (Unsplash License). Requires free access key.
async function fetchUnsplashImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  maxResults: number = 2,
  fileTag = "",
  opts: { personPortrait?: boolean; dedup?: VisualDedupState } = {}
): Promise<string[]> {
  if (!UNSPLASH_ACCESS_KEY?.trim()) return [];
  const results: string[] = [];
  try {
    const searchUrl =
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
      `&per_page=${Math.min(maxResults * 3, 15)}&orientation=landscape`;
    const searchResp = await withTimeout(
      fetch(searchUrl, {
        headers: {
          Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY.trim()}`,
          "Accept-Version": "v1",
        },
      }),
      8000,
      `Unsplash search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Unsplash error ${searchResp.status}`);
      return [];
    }
    const payload = await searchResp.json() as {
      results?: Array<{
        id?: string;
        urls?: { regular?: string; small?: string };
        alt_description?: string;
        description?: string;
      }>;
    };
    const images = payload.results ?? [];
    if (!images.length) return [];

    for (let i = 0; i < images.length && results.length < maxResults; i++) {
      try {
        const imgUrl = images[i].urls?.regular || images[i].urls?.small;
        if (!imgUrl) continue;
        const urlKey = normalizeImageSourceUrl(imgUrl);
        if (opts.dedup?.usedImageUrls.has(urlKey)) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}unsplash_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}unsplash_${i}.mp4`);

        const imgResp = await withTimeout(
          fetch(imgUrl),
          10000,
          `Unsplash image download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuf = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuf.length < 5000) continue;
        fs.writeFileSync(imgPath, imgBuf);

        const portrait =
          Boolean(opts.personPortrait) ||
          /portrait|face|headshot/i.test(query) ||
          /portrait|face|headshot/i.test(images[i].alt_description ?? "");
        await stillImageToVideo(
          imgPath,
          outPath,
          duration,
          `Unsplash image to video scene ${sceneIndex}`,
          portrait,
          sceneIndex
        );
        try { fs.unlinkSync(imgPath); } catch { /**/ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
          opts.dedup?.usedImageUrls.add(urlKey);
          results.push(outPath);
          const label = images[i].alt_description || images[i].description || query;
          console.log(`[Pipeline] Scene ${sceneIndex}: Unsplash image added: ${label.slice(0, 60)}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] Unsplash image ${i} failed scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Unsplash search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

// ─── 3c2b-yt. YouTube Data API Thumbnails ────────────────────────────────────
// Uses YouTube Data API v3 to search for relevant videos and downloads their
// high-quality thumbnails as image clips. This gives highly relevant visuals
// that match the scene topic without requiring video downloads.
async function fetchYouTubeThumbnails(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 3,
  fileTag = ""
): Promise<string[]> {
  if (!youtubeSourcingEnabled()) return [];
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
  if (!YOUTUBE_API_KEY) return [];
  fs.mkdirSync(workDir, { recursive: true });
  const results: string[] = [];
  try {
    // Search YouTube for relevant videos (Creative Commons preferred, but also standard)
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${count * 3}&key=${YOUTUBE_API_KEY}`;
    const searchResp = await withTimeout(
      fetch(searchUrl),
      10000,
      `YouTube search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube API error ${searchResp.status}`);
      return [];
    }
    const payload = await searchResp.json() as { items?: Array<{ id: { videoId: string }; snippet: { title: string; thumbnails: { maxres?: { url: string }; high?: { url: string }; medium?: { url: string } } } }> };
    const items = payload.items || [];
    if (items.length === 0) return [];

    for (let i = 0; i < Math.min(items.length, count * 2) && results.length < count; i++) {
      try {
        const item = items[i];
        // Use highest quality thumbnail available
        const thumbUrl = item.snippet.thumbnails?.maxres?.url ||
                         item.snippet.thumbnails?.high?.url ||
                         item.snippet.thumbnails?.medium?.url;
        if (!thumbUrl) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}yt_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}yt_${i}.mp4`);

        // Download thumbnail
        const imgResp = await withTimeout(
          fetch(thumbUrl),
          10000,
          `YouTube thumbnail download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        const imgBuf = Buffer.from(await imgResp.arrayBuffer());
        if (imgBuf.length < 5000) continue; // skip tiny/broken thumbnails
        fs.writeFileSync(imgPath, imgBuf);

        // Convert thumbnail to video clip with slow Ken Burns zoom effect
        await withTimeout(
          new Promise<void>(async (resolve, reject) => {
            const { spawn } = await import('child_process');
            const args = [
              '-y', '-loop', '1', '-i', imgPath,
              '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.0006,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(duration * 25)}:s=1920x1080:fps=25,setsar=1`,
              '-t', String(duration),
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-pix_fmt', 'yuv420p', '-an', outPath
            ];
            const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /**/ } reject(new Error('timeout')); }, 25000);
            child.on('close', (code: number | null) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
            child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
          }),
          30000,
          `YouTube thumbnail to video scene ${sceneIndex}`
        );
        try { fs.unlinkSync(imgPath); } catch { /**/ }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
          results.push(outPath);
          console.log(`[Pipeline] Scene ${sceneIndex}: YouTube thumbnail added: "${item.snippet.title?.slice(0, 60)}"`);
        }
      } catch (err) {
        console.warn(`[Pipeline] YouTube thumbnail ${i} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] YouTube search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

// ─── 3c2b. SerpAPI Google Images Search ────────────────────────────────────
// Searches Google Images via SerpAPI for celebrity/person-specific photos.
// Ideal for finding real photos of people mentioned in the narration.
async function fetchSerpAPIImages(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = "",
  opts: {
    dedup?: VisualDedupState;
    personPortrait?: boolean;
    resultOffset?: number;
  } = {}
): Promise<string[]> {
  if (!SERPAPI_KEY) return [];
  // Ensure workDir exists — it may have been cleaned up between pipeline stages
  fs.mkdirSync(workDir, { recursive: true });
  const results: string[] = [];
  try {
    const searchUrl = new URL('https://serpapi.com/search.json');
    searchUrl.searchParams.set('engine', 'google_images');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('safe', 'active');
    searchUrl.searchParams.set('num', '10');
    searchUrl.searchParams.set('ijn', '0');
    searchUrl.searchParams.set('api_key', SERPAPI_KEY);

    const searchResp = await withTimeout(
      fetch(searchUrl.toString()),
      15_000,
      `SerpAPI search scene ${sceneIndex}`
    );
    if (!searchResp.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: SerpAPI error ${searchResp.status}`);
      return [];
    }
    const searchData = await searchResp.json() as {
      images_results?: Array<{
        original?: string;
        thumbnail?: string;
        title?: string;
      }>;
    };

    const offset = opts.resultOffset ?? 0;
    const images = (searchData.images_results || []).slice(offset, offset + count * 4);
    if (!images.length) return [];

    let downloaded = 0;
    for (let i = 0; i < images.length && downloaded < count; i++) {
      const imgUrl = images[i].original || images[i].thumbnail;
      if (!imgUrl) continue;
      const urlKey = normalizeImageSourceUrl(imgUrl);
      if (opts.dedup?.usedImageUrls.has(urlKey)) continue;
      // Skip SVG, GIF, and non-image URLs
      const lowerUrl = imgUrl.toLowerCase();
      if (lowerUrl.endsWith('.svg') || lowerUrl.endsWith('.gif') || lowerUrl.endsWith('.webp')) continue;
      if (!lowerUrl.includes('jpg') && !lowerUrl.includes('jpeg') && !lowerUrl.includes('png') &&
          !lowerUrl.match(/\.(jpg|jpeg|png)(\?|$)/i) && !lowerUrl.match(/image\/(jpeg|png)/i)) {
        // Allow if URL doesn't have a bad extension (many CDN URLs have no extension)
        if (lowerUrl.endsWith('.svg') || lowerUrl.endsWith('.gif')) continue;
      }

      try {
        const tag = fileTag ? `${fileTag}_` : "";
        const imgPath = path.join(workDir, `scene_${sceneIndex}_${tag}serp_${i}.jpg`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}serp_${i}.mp4`);

        const imgResp = await withTimeout(
          fetch(imgUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Fastvid/1.0)',
              'Accept': 'image/jpeg,image/png,image/*',
            },
          }),
          12_000,
          `SerpAPI image download scene ${sceneIndex}`
        );
        if (!imgResp.ok) continue;
        // Validate content-type: must be an image, not HTML/text
        const contentType = imgResp.headers.get('content-type') || '';
        if (contentType.includes('text/') || contentType.includes('application/') || contentType.includes('html')) continue;
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
        // Skip tiny images (likely placeholders)
        if (imgBuffer.length < 15_000) continue;
        // Validate magic bytes: JPEG (FFD8FF) or PNG (89504E47)
        const magic = imgBuffer.slice(0, 4);
        const isJpeg = magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF;
        const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47;
        if (!isJpeg && !isPng) continue;
        fs.writeFileSync(imgPath, imgBuffer);

        await stillImageToVideo(
          imgPath,
          outPath,
          duration,
          `SerpAPI image to video scene ${sceneIndex}`,
          Boolean(opts.personPortrait),
          sceneIndex
        );
        try { fs.unlinkSync(imgPath); } catch { /* ignore */ }
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
          opts.dedup?.usedImageUrls.add(urlKey);
          results.push(outPath);
          downloaded++;
          console.log(`[Pipeline] Scene ${sceneIndex}: SerpAPI image added: ${images[i].title || imgUrl.slice(0, 60)}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] SerpAPI image ${i} failed for scene ${sceneIndex}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] SerpAPI search failed for scene ${sceneIndex}:`, err);
  }
  return results;
}

// ─── 3c. Color Fallback (deprecated — use fetchBeatAIClip instead of grey slabs) ─
async function generateColorFallback(sceneIndex: number, duration: number, workDir: string): Promise<string> {
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(workDir, `scene_${sceneIndex}_fallback.mp4`);
  const colors = ["3a4a5e", "4a5a6e", "3a5a6e", "4a4a5e", "3a5a5e", "4a5a5e", "3a4a6e", "4a4a6e"];
  const color = colors[sceneIndex % colors.length];
  const safeDuration = Math.min(Math.max(duration, 3), 90);

  if (fs.existsSync(outputPath)) {
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
  }

  const commands = [
    `${FFMPEG_BIN} -y -f lavfi -i "color=c=#${color}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=25" -t ${safeDuration} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an "${outputPath}"`,
    `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=25" -t ${safeDuration} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an "${outputPath}"`,
    `${FFMPEG_BIN} -y -f lavfi -i "color=c=black:s=1280x720:r=25" -t ${safeDuration} -c:v mpeg4 -q:v 5 -an "${outputPath}"`,
  ];

  for (let i = 0; i < commands.length; i++) {
    try {
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      }
      await withTimeout(exec(commands[i]), 30_000, `Fallback video scene ${sceneIndex} attempt ${i + 1}`);
      if (await isValidVideoFile(outputPath)) {
        console.log(`[Pipeline] Scene ${sceneIndex}: fallback video OK (${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB, attempt ${i + 1})`);
        return outputPath;
      }
      console.warn(`[Pipeline] Scene ${sceneIndex}: fallback attempt ${i + 1} produced unreadable file`);
    } catch (err) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: fallback attempt ${i + 1} failed:`, (err as Error).message);
    }
  }

  throw pipelineError(
    PIPELINE_ERROR.FFMPEG,
    `Could not create valid fallback video for scene ${sceneIndex}`
  );
}

/** Rotate golden Musk queries; never grey or duplicate clips. */
async function fetchMuskGoldenStockBeat(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  dedup: VisualDedupState,
  adoptOpts: VisualAdoptOptions
): Promise<string | null> {
  const clipFetchDur = 4;
  const start = (sceneIndex * 5 + beat.index) % GOLDEN_MUSK_QUERIES.length;
  const maxTries = dedup.perf.fastStockMode ? 3 : GOLDEN_MUSK_QUERIES.length;
  for (let i = 0; i < maxTries; i++) {
    const gq = GOLDEN_MUSK_QUERIES[(start + i) % GOLDEN_MUSK_QUERIES.length];
    if (isBlockedStockQuery(gq)) continue;
    const golden = await fetchPexelsClips(
      gq, clipFetchDur, workDir, sceneIndex, 2, [gq], true,
      `b${beat.index}_golden`, dedup.usedPexelsIds, beat.index + sceneIndex + i,
      dedup.perf.pexelsDownloadRetries
    );
    const gClip = await adoptClip(
      golden, dedup, sceneIndex, beat.index, beat.text, workDir, gq, adoptOpts
    );
    if (gClip) return gClip;
  }
  return null;
}

/** Return clipPath if ffprobe confirms a video stream; never substitute grey placeholders. */
async function requireValidClip(
  clipPath: string,
  sceneIndex: number,
  _duration: number,
  _workDir: string
): Promise<string | null> {
  if (
    await isValidVideoFile(clipPath) &&
    !isPipelineFallbackClip(clipPath) &&
    !(await isMostlyBlackClip(clipPath))
  ) {
    return clipPath;
  }
  console.warn(`[Pipeline] Scene ${sceneIndex}: dropping invalid clip ${path.basename(clipPath)}`);
  return null;
}

// ─── 3c1. Generate Grok Video Clip ──────────────────────────────────────────
async function generateGrokVideoClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!REPLICATE_API_KEY) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateGrokVideo(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const grokOutputPath = outputPath.replace(/\.mp4$/, "_grok.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Grok download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(grokOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Grok video saved (${buffer.length} bytes)`);
    return grokOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Grok generation error:`, err);
    return null;
  }
}

// ─── 3c2. Generate Veo Video Clip ───────────────────────────────────────────
async function generateVeoVideoClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!GOOGLE_GEMINI_API_KEY) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateVeoVideo(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const veoOutputPath = outputPath.replace(/\.mp4$/, "_veo.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Veo download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(veoOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Veo video saved (${buffer.length} bytes)`);
    return veoOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Veo generation error:`, err);
    return null;
  }
}

// ─── 3c3. Generate Meta Movie Gen Clip ──────────────────────────────────────
async function generateMetaMovieGenClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!META_MOVIE_GEN_API_KEY) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateMetaMovieGen(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const metaOutputPath = outputPath.replace(/\.mp4$/, "_meta.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Meta Movie Gen download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(metaOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Meta Movie Gen video saved (${buffer.length} bytes)`);
    return metaOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Meta Movie Gen generation error:`, err);
    return null;
  }
}

// ─── 3c4. Generate Higgsfield Text-to-Video Clip ───────────────────────────────
async function generateHiggsfieldTextToVideoClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!HIGGSFIELD_API_KEY || !HIGGSFIELD_API_SECRET) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateHiggsfieldTextToVideo(prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const higgsfieldOutputPath = outputPath.replace(/\.mp4$/, "_higgsfield.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield text-to-video download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(higgsfieldOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Higgsfield text-to-video saved (${buffer.length} bytes)`);
    return higgsfieldOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield text-to-video error:`, err);
    return null;
  }
}

// ─── 3c5. Generate Higgsfield Image-to-Video Clip ───────────────────────────────
async function generateHiggsfieldImageToVideoClip(
  imageUrl: string,
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!HIGGSFIELD_API_KEY || !HIGGSFIELD_API_SECRET) {
    return null; // Fallback to other sources
  }

  try {
    const result = await generateHiggsfieldImageToVideo(imageUrl, prompt, Math.min(duration, 8));
    if (!result) return null;

    // Download the video from the URL and save to local file
    const higgsfieldOutputPath = outputPath.replace(/\.mp4$/, "_higgsfield_img.mp4");
    const response = await fetch(result.url);
    if (!response.ok) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield image-to-video download failed (${response.status})`);
      return null;
    }

    const buffer = await response.buffer();
    fs.writeFileSync(higgsfieldOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Higgsfield image-to-video saved (${buffer.length} bytes)`);
    return higgsfieldOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Higgsfield image-to-video error:`, err);
    return null;
  }
}

// ─── 3c6. Leonardo AI Image → Video (HIGH QUALITY image gen, replaces Stability AI) ─────
async function generateLeonardoAIClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!LEONARDO_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Leonardo AI image...`);
    const t = Date.now();
    // Step 1: Create generation job
    const genResp = await withTimeout(
      fetch("https://cloud.leonardo.ai/api/rest/v1/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${LEONARDO_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt + ", cinematic, 4K, high quality, professional photography",
          negative_prompt: "blurry, low quality, watermark, text, logo, ugly, deformed",
          modelId: "b24e16ff-06e3-43eb-8d33-4416c2d75876", // Leonardo Kino XL (cinematic)
          width: 1344, height: 768, num_images: 1,
          guidance_scale: 7, num_inference_steps: 30,
          public: false, photoReal: false, alchemy: false,
        }),
      }),
      30_000, `Leonardo AI generate scene ${sceneIndex}`
    );
    if (!genResp.ok) {
      const errText = await genResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Leonardo AI error ${genResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const genData = await genResp.json() as { sdGenerationJob?: { generationId: string } };
    const generationId = genData.sdGenerationJob?.generationId;
    if (!generationId) return null;

    // Step 2: Poll for completion (max 60s)
    let imageUrl: string | null = null;
    for (let poll = 0; poll < 12; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, {
          headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` },
        }),
        10_000, `Leonardo AI poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { generations_by_pk?: { status: string; generated_images?: Array<{ url: string }> } };
      const gen = pollData.generations_by_pk;
      if (gen?.status === "COMPLETE" && gen.generated_images?.[0]?.url) {
        imageUrl = gen.generated_images[0].url;
        break;
      }
      if (gen?.status === "FAILED") break;
    }
    if (!imageUrl) return null;

    // Step 3: Download image and convert to video
    const imgResp = await withTimeout(fetch(imageUrl), 20_000, `Leonardo AI download scene ${sceneIndex}`);
    if (!imgResp.ok) return null;
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    const pngPath = outputPath.replace(".mp4", "_leonardo.jpg");
    fs.writeFileSync(pngPath, imgBuffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Leonardo AI image in ${((Date.now()-t)/1000).toFixed(1)}s (${(imgBuffer.length/1024).toFixed(0)}KB)`);

    // Convert to video with fast Ken Burns
    const fps = 25; const totalFrames = Math.ceil(duration * fps);
    const zoomEnd = 1.05; const zoomStart = 1.0;
    const zoomStep = (zoomEnd - zoomStart) / totalFrames;
    const leonardoOutputPath = outputPath.replace(".mp4", "_leonardo.mp4");
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -loop 1 -i "${pngPath}" ` +
        `-vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},` +
        `zoompan=z='min(zoom+${zoomStep.toFixed(6)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${fps}" ` +
        `-t ${duration} -r ${fps} -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p "${leonardoOutputPath}"`
      ),
      90_000, `Leonardo AI image to video scene ${sceneIndex}`
    );
    try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
    if (fs.existsSync(leonardoOutputPath) && fs.statSync(leonardoOutputPath).size > 1000) {
      return leonardoOutputPath;
    }
    return null;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Leonardo AI clip failed:`, err);
    return null;
  }
}

// ─── 3c7. Runway Gen-4 Image-to-Video ─────────────────────────────────────────
async function generateRunwayClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!RUNWAY_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Runway Gen-4 video...`);
    const t = Date.now();
    const durationSec = Math.min(duration, 10) as 5 | 10;
    const body: Record<string, unknown> = {
      model: "gen4_turbo",
      promptText: prompt,
      duration: durationSec <= 5 ? 5 : 10,
      ratio: "1280:768",
    };
    if (imageUrl) body.promptImage = imageUrl;

    const createResp = await withTimeout(
      fetch("https://api.dev.runwayml.com/v1/image_to_video", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RUNWAY_API_KEY}`,
          "Content-Type": "application/json",
          "X-Runway-Version": "2024-11-06",
        },
        body: JSON.stringify(body),
      }),
      30_000, `Runway create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Runway error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { id: string };
    const taskId = createData.id;
    if (!taskId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
        }),
        10_000, `Runway poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { status: string; output?: string[] };
      if (pollData.status === "SUCCEEDED" && pollData.output?.[0]) {
        videoUrl = pollData.output[0];
        break;
      }
      if (pollData.status === "FAILED") break;
    }
    if (!videoUrl) return null;

    // Download video
    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Runway download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const runwayOutputPath = outputPath.replace(".mp4", "_runway.mp4");
    fs.writeFileSync(runwayOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Runway video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return runwayOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Runway clip failed:`, err);
    return null;
  }
}

// ─── 3c8. Kling AI Image-to-Video ─────────────────────────────────────────────
async function generateKlingClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!KLING_API_KEY || !KLING_API_SECRET) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Kling AI video...`);
    const t = Date.now();

    // Generate JWT token for Kling
    const { createHmac } = await import('crypto');
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: KLING_API_KEY, exp: Math.floor(Date.now()/1000) + 1800, nbf: Math.floor(Date.now()/1000) - 5 })).toString('base64url');
    const sig = createHmac('sha256', KLING_API_SECRET).update(`${header}.${payload}`).digest('base64url');
    const klingJWT = `${header}.${payload}.${sig}`;

    const body: Record<string, unknown> = {
      model_name: "kling-v1-5",
      prompt: prompt,
      duration: Math.min(duration, 10) <= 5 ? "5" : "10",
      mode: "std",
      cfg_scale: 0.5,
    };
    if (imageUrl) body.image_url = imageUrl;

    const endpoint = imageUrl
      ? "https://api.klingai.com/v1/videos/image2video"
      : "https://api.klingai.com/v1/videos/text2video";

    const createResp = await withTimeout(
      fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${klingJWT}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      30_000, `Kling create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Kling error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { data?: { task_id: string } };
    const taskId = createData.data?.task_id;
    if (!taskId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    const pollEndpoint = imageUrl
      ? `https://api.klingai.com/v1/videos/image2video/${taskId}`
      : `https://api.klingai.com/v1/videos/text2video/${taskId}`;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(pollEndpoint, { headers: { Authorization: `Bearer ${klingJWT}` } }),
        10_000, `Kling poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { data?: { task_status: string; task_result?: { videos?: Array<{ url: string }> } } };
      if (pollData.data?.task_status === "succeed" && pollData.data.task_result?.videos?.[0]?.url) {
        videoUrl = pollData.data.task_result.videos[0].url;
        break;
      }
      if (pollData.data?.task_status === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Kling download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const klingOutputPath = outputPath.replace(".mp4", "_kling.mp4");
    fs.writeFileSync(klingOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Kling video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return klingOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Kling clip failed:`, err);
    return null;
  }
}

// ─── 3c9. Luma Dream Machine Image-to-Video ────────────────────────────────────
async function generateLumaClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!LUMA_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Luma Dream Machine video...`);
    const t = Date.now();
    const body: Record<string, unknown> = {
      prompt: prompt,
      model: "ray-2",
      resolution: "720p",
      duration: "5s",
      loop: false,
    };
    if (imageUrl) body.keyframes = { frame0: { type: "image", url: imageUrl } };

    const createResp = await withTimeout(
      fetch("https://api.lumalabs.ai/dream-machine/v1/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${LUMA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      30_000, `Luma create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Luma error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { id: string };
    const genId = createData.id;
    if (!genId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${genId}`, {
          headers: { Authorization: `Bearer ${LUMA_API_KEY}` },
        }),
        10_000, `Luma poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { state: string; assets?: { video?: string } };
      if (pollData.state === "completed" && pollData.assets?.video) {
        videoUrl = pollData.assets.video;
        break;
      }
      if (pollData.state === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Luma download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const lumaOutputPath = outputPath.replace(".mp4", "_luma.mp4");
    fs.writeFileSync(lumaOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Luma video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return lumaOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Luma clip failed:`, err);
    return null;
  }
}

// ─── 3c10. Pika Labs Image-to-Video ────────────────────────────────────────────
async function generatePikaClip(
  prompt: string,
  imageUrl: string | null,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  if (!PIKA_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Pika Labs video...`);
    const t = Date.now();
    const body: Record<string, unknown> = {
      promptText: prompt,
      model: "pike-2.2",
      options: { frameRate: 24, resolution: "1080p", duration: Math.min(duration, 5) },
    };
    if (imageUrl) body.image = imageUrl;

    const createResp = await withTimeout(
      fetch("https://api.pika.art/v2/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${PIKA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      30_000, `Pika create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Pika error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { id?: string; requestId?: string };
    const taskId = createData.id || createData.requestId;
    if (!taskId) return null;

    // Poll for completion (max 3 minutes)
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`https://api.pika.art/v2/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${PIKA_API_KEY}` },
        }),
        10_000, `Pika poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { status?: string; videos?: Array<{ url: string }>; resultUrl?: string };
      if ((pollData.status === "finished" || pollData.status === "succeeded") && (pollData.videos?.[0]?.url || pollData.resultUrl)) {
        videoUrl = pollData.videos?.[0]?.url || pollData.resultUrl || null;
        break;
      }
      if (pollData.status === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Pika download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const pikaOutputPath = outputPath.replace(".mp4", "_pika.mp4");
    fs.writeFileSync(pikaOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Pika video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return pikaOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Pika clip failed:`, err);
    return null;
  }
}

// ─── 3c11. Manus Forge Built-in Video Generation ──────────────────────────────
async function generateManusForgeClip(
  prompt: string,
  duration: number,
  outputPath: string,
  sceneIndex: number
): Promise<string | null> {
  const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "";
  const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";
  if (!FORGE_API_URL || !FORGE_API_KEY) return null;
  try {
    console.log(`[Pipeline] Scene ${sceneIndex}: Generating Manus Forge video...`);
    const t = Date.now();
    const forgeBase = FORGE_API_URL.replace(/\/+$/, "");

    // Try Manus Forge video generation endpoint
    const createResp = await withTimeout(
      fetch(`${forgeBase}/v1/video/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${FORGE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt,
          duration: Math.min(duration, 8),
          resolution: "1280x720",
          fps: 24,
        }),
      }),
      30_000, `Manus Forge create scene ${sceneIndex}`
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.warn(`[Pipeline] Scene ${sceneIndex}: Manus Forge error ${createResp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const createData = await createResp.json() as { task_id?: string; id?: string; url?: string };

    // If direct URL returned, download immediately
    if (createData.url) {
      const dlResp = await withTimeout(fetch(createData.url), 60_000, `Manus Forge download scene ${sceneIndex}`);
      if (!dlResp.ok) return null;
      const buffer = Buffer.from(await dlResp.arrayBuffer());
      const forgeOutputPath = outputPath.replace(".mp4", "_forge.mp4");
      fs.writeFileSync(forgeOutputPath, buffer);
      console.log(`[Pipeline] Scene ${sceneIndex}: Manus Forge video in ${((Date.now()-t)/1000).toFixed(1)}s`);
      return forgeOutputPath;
    }

    // Otherwise poll for task completion
    const taskId = createData.task_id || createData.id;
    if (!taskId) return null;
    let videoUrl: string | null = null;
    for (let poll = 0; poll < 36; poll++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await withTimeout(
        fetch(`${forgeBase}/v1/video/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${FORGE_API_KEY}` },
        }),
        10_000, `Manus Forge poll scene ${sceneIndex}`
      );
      if (!pollResp.ok) continue;
      const pollData = await pollResp.json() as { status?: string; url?: string; output_url?: string };
      if ((pollData.status === "completed" || pollData.status === "succeeded") && (pollData.url || pollData.output_url)) {
        videoUrl = pollData.url || pollData.output_url || null;
        break;
      }
      if (pollData.status === "failed") break;
    }
    if (!videoUrl) return null;

    const dlResp = await withTimeout(fetch(videoUrl), 60_000, `Manus Forge download scene ${sceneIndex}`);
    if (!dlResp.ok) return null;
    const buffer = Buffer.from(await dlResp.arrayBuffer());
    const forgeOutputPath = outputPath.replace(".mp4", "_forge.mp4");
    fs.writeFileSync(forgeOutputPath, buffer);
    console.log(`[Pipeline] Scene ${sceneIndex}: Manus Forge video in ${((Date.now()-t)/1000).toFixed(1)}s (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return forgeOutputPath;
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: Manus Forge clip failed:`, err);
    return null;
  }
}

/** Trim a downloaded file to a short scene clip (shared by Archive, NASA, Wikimedia video). */
async function trimRemoteVideoToClip(
  sourcePath: string,
  outputPath: string,
  duration: number,
  clipStart = 5,
  label = "clip"
): Promise<boolean> {
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -ss ${clipStart} -i "${sourcePath}" -t ${duration} ` +
        `-vf "${STANDARD_VF}" ` +
        `-c:v libx264 -preset veryfast -crf 22 -an -pix_fmt yuv420p "${outputPath}"`
      ),
      90_000,
      `Trim ${label}`
    );
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000;
  } catch (err) {
    console.warn(`[Pipeline] trimRemoteVideoToClip failed (${label}):`, (err as Error).message);
    return false;
  }
}

// ─── 3c2v. Wikimedia Commons Video Search ───────────────────────────────────
async function fetchWikimediaVideos(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = []
): Promise<CelebrityClipCandidate[]> {
  if (!query?.trim()) return [];
  const results: CelebrityClipCandidate[] = [];
  const UA = { "User-Agent": "Fastvid/1.0 (video generation; CC-licensed clips only)" };
  try {
    const searchUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(`${query} filetype:video`)}&srnamespace=6&srlimit=15&format=json&origin=*`;
    const searchResp = await withTimeout(fetch(searchUrl, { headers: UA }), 10_000, `Wikimedia video search scene ${sceneIndex}`);
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as { query?: { search?: Array<{ title: string }> } };
    const hits = (searchData.query?.search ?? [])
      .filter((r) => {
        const hay = `${r.title} ${query}`.toLowerCase();
        if (personName && !textMentionsPersonName(hay, personName)) return false;
        if (beatKeywords.length > 0 && scoreVisualRelevance(hay, beatKeywords) < 1 && personName) {
          return textMentionsPersonName(hay, personName);
        }
        return true;
      })
      .sort(
        (a, b) =>
          scoreVisualRelevance(`${b.title} ${query}`, beatKeywords) -
          scoreVisualRelevance(`${a.title} ${query}`, beatKeywords)
      )
      .slice(0, count * 3);
    if (!hits.length) return [];

    let downloaded = 0;
    for (let i = 0; i < hits.length && downloaded < count; i++) {
      try {
        const title = hits[i].title;
        const infoUrl =
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}` +
          `&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
        const infoResp = await withTimeout(fetch(infoUrl, { headers: UA }), 10_000, `Wikimedia video info scene ${sceneIndex}`);
        if (!infoResp.ok) continue;
        const infoData = await infoResp.json() as {
          query?: { pages?: Record<string, { imageinfo?: Array<{ url: string; size?: number; mime?: string }> }> };
        };
        const page = Object.values(infoData.query?.pages || {})[0];
        const imageInfo = page?.imageinfo?.[0];
        if (!imageInfo?.url || !imageInfo.mime?.startsWith("video/")) continue;
        if ((imageInfo.size ?? 0) > 80 * 1024 * 1024) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}wikivid_${i}_tmp`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}wikivid_${i}.mp4`);
        const dlResp = await fetchWithTimeout(imageInfo.url, 45_000, `Wikimedia video download scene ${sceneIndex}`, { headers: UA });
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));

        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 3, `Wikimedia video scene ${sceneIndex}`)) {
          results.push({ path: outPath, query });
          downloaded++;
          console.log(`[Pipeline] Scene ${sceneIndex}: Wikimedia video added: ${title}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] Wikimedia video ${i} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Wikimedia video search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

/** Archive.org queries for real person footage (news, TV, documentaries) — no API key. */
function buildPersonArchiveVideoQueries(person: string, beatIndex: number, beatText = ""): string[] {
  const first = person.split(/\s+/)[0] ?? person;
  const scriptQs = beatText
    ? scriptEventSearchQueries(beatText, [person]).map((q) =>
        textMentionsPersonName(q, person) ? q : `${person} ${q}`.trim()
      )
    : [];
  const variants = [
    ...scriptQs,
    `title:(${person}) AND mediatype:movies`,
    `collection:tvnews AND ${person}`,
    `${person} interview`,
    `${person} television`,
    `${first} celebrity news`,
    `subject:"${person}"`,
  ].filter((q, i, arr) => q.trim().length > 3 && arr.indexOf(q) === i);
  const offset = beatIndex % Math.max(1, variants.length);
  return [...variants.slice(offset), ...variants.slice(0, offset)].slice(0, 5);
}

/** Flickr CC video (4,5,6,9,10) — events, interviews uploaded with CC license. */
async function fetchFlickrCCVideos(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 1,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = []
): Promise<string[]> {
  if (!FLICKR_API_KEY?.trim() || !query?.trim()) return [];
  const results: string[] = [];
  try {
    const searchParams = new URLSearchParams({
      method: "flickr.photos.search",
      api_key: FLICKR_API_KEY,
      text: query,
      media: "videos",
      license: "4,5,6,9,10",
      content_type: "7",
      per_page: String(Math.min(12, count * 4)),
      format: "json",
      nojsoncallback: "1",
    });
    const searchResp = await withTimeout(
      fetch(`https://api.flickr.com/services/rest/?${searchParams}`),
      12_000,
      `Flickr video search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as {
      stat?: string;
      photos?: { photo?: Array<{ id: string; secret: string; server: string; title?: string }> };
    };
    if (searchData.stat !== "ok") return [];
    const photos = (searchData.photos?.photo ?? [])
      .filter((photo) => {
        const hay = `${photo.title ?? ""} ${query}`.toLowerCase();
        if (personName && !textMentionsPersonName(hay, personName)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          scoreVisualRelevance(`${b.title ?? ""} ${query}`, beatKeywords) -
          scoreVisualRelevance(`${a.title ?? ""} ${query}`, beatKeywords)
      );
    if (!photos.length) return [];

    let downloaded = 0;
    for (let i = 0; i < photos.length && downloaded < count; i++) {
      const photo = photos[i];
      try {
        const sizeParams = new URLSearchParams({
          method: "flickr.photos.getSizes",
          api_key: FLICKR_API_KEY,
          photo_id: photo.id,
          format: "json",
          nojsoncallback: "1",
        });
        const sizeResp = await withTimeout(
          fetch(`https://api.flickr.com/services/rest/?${sizeParams}`),
          10_000,
          `Flickr sizes scene ${sceneIndex}`
        );
        if (!sizeResp.ok) continue;
        const sizeData = await sizeResp.json() as {
          stat?: string;
          sizes?: { size?: Array<{ label?: string; source?: string; media?: string }> };
        };
        if (sizeData.stat !== "ok") continue;
        const sizes = sizeData.sizes?.size ?? [];
        const videoSize =
          sizes.find((s) => s.media === "video" && s.source) ??
          sizes.find((s) => s.source && /\.mp4/i.test(s.source)) ??
          sizes.find((s) => /video|mp4|hd/i.test(s.label ?? "") && s.source);
        const videoUrl = videoSize?.source;
        if (!videoUrl) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}flickr_${i}_tmp`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}flickr_${i}.mp4`);
        const dlResp = await fetchWithTimeout(
          videoUrl,
          45_000,
          `Flickr video download scene ${sceneIndex}`,
          { headers: { "User-Agent": "Fastvid/1.0 (CC-licensed clips only)" } }
        );
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));
        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 2, `Flickr video scene ${sceneIndex}`)) {
          results.push(outPath);
          downloaded++;
          console.log(
            `[Pipeline] Scene ${sceneIndex}: Flickr CC video: ${photo.title?.slice(0, 60) ?? query}`
          );
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] Flickr video ${i} failed scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Flickr search failed scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

/** Federated PeerTube search (SepiaSearch) — CC news/interviews, no API key. */
const SEPIA_SEARCH_API = "https://sepiasearch.org/api/v1";

function scoreSepiaSearchHit(
  title: string,
  query: string,
  personName: string,
  beatKeywords: string[]
): number {
  const hay = `${title} ${query}`.toLowerCase();
  if (personName && !textMentionsPersonName(hay, personName)) return -1;
  let score = 3;
  score += scoreVisualRelevance(hay, beatKeywords);
  if (/\b(interview|news|documentary|conference|speech|red carpet|celebrity|talk show)\b/.test(hay)) {
    score += 2;
  }
  return score;
}

async function fetchSepiaSearchVideos(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 1,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = []
): Promise<CelebrityClipCandidate[]> {
  const queryList = [...new Set((Array.isArray(queries) ? queries : [queries]).filter((q) => q?.trim()))];
  if (!queryList.length) return [];

  type RankedHit = {
    uuid: string;
    host: string;
    title: string;
    query: string;
    score: number;
  };

  const results: CelebrityClipCandidate[] = [];
  const seenUuids = new Set<string>();
  const ranked: RankedHit[] = [];

  try {
    for (const query of queryList.slice(0, 4)) {
      if (ranked.length >= count * 4) break;
      const searchUrl = new URL(`${SEPIA_SEARCH_API}/search/videos`);
      searchUrl.searchParams.set("search", query);
      searchUrl.searchParams.set("count", "15");
      searchUrl.searchParams.append("licenceOneOf", "1");
      searchUrl.searchParams.append("licenceOneOf", "2");
      searchUrl.searchParams.append("licenceOneOf", "7");

      const searchResp = await withTimeout(
        fetch(searchUrl.toString(), { headers: { "User-Agent": "Fastvid/1.0 (CC PeerTube clips)" } }),
        14_000,
        `SepiaSearch scene ${sceneIndex}`
      );
      if (!searchResp.ok) continue;
      const data = await searchResp.json() as {
        data?: Array<{
          uuid: string;
          name?: string;
          duration?: number;
          isLive?: boolean;
          channel?: { host?: string };
        }>;
      };

      for (const item of data.data ?? []) {
        const host = item.channel?.host;
        const uuid = item.uuid;
        if (!host || !uuid || item.isLive || seenUuids.has(uuid)) continue;
        if ((item.duration ?? 0) < 8 || (item.duration ?? 0) > 900) continue;
        const title = item.name ?? "";
        const score = scoreSepiaSearchHit(title, query, personName, beatKeywords);
        if (score < 0) continue;
        seenUuids.add(uuid);
        ranked.push({ uuid, host, title, query, score });
      }
    }

    ranked.sort((a, b) => b.score - a.score);

    let downloaded = 0;
    for (const hit of ranked) {
      if (downloaded >= count) break;
      try {
        const metaUrl = `https://${hit.host}/api/v1/videos/${hit.uuid}`;
        const metaResp = await withTimeout(
          fetch(metaUrl, { headers: { "User-Agent": "Fastvid/1.0" } }),
          12_000,
          `PeerTube meta scene ${sceneIndex}`
        );
        if (!metaResp.ok) continue;
        const meta = await metaResp.json() as {
          name?: string;
          description?: string;
          tags?: Array<{ name?: string } | string>;
          streamingPlaylists?: Array<{
            files?: Array<{
              fileDownloadUrl?: string;
              fileUrl?: string;
              size?: number;
              resolution?: { id?: number };
            }>;
          }>;
        };
        const metaTitle = meta.name ?? hit.title;
        const tagNames = (meta.tags ?? [])
          .map((t) => (typeof t === "string" ? t : t.name ?? ""))
          .filter(Boolean)
          .join(" ");
        const metaHay = `${metaTitle} ${meta.description ?? ""} ${tagNames} ${hit.query}`;
        if (personName && !textMentionsPersonName(metaHay, personName)) continue;
        const metaScore =
          scoreVisualRelevance(metaHay.toLowerCase(), beatKeywords) +
          (textMentionsPersonName(metaHay, personName) ? 3 : 0);
        if (beatKeywords.length > 0 && metaScore < 2 && personName) continue;

        const files = meta.streamingPlaylists?.[0]?.files ?? [];
        const mp4 = files
          .filter((f) => (f.fileDownloadUrl || f.fileUrl) && (f.size ?? 0) > 50_000)
          .sort((a, b) => {
            const resA = a.resolution?.id ?? 720;
            const resB = b.resolution?.id ?? 720;
            const distA = Math.abs(resA - 720);
            const distB = Math.abs(resB - 720);
            if (distA !== distB) return distA - distB;
            return (a.size ?? 0) - (b.size ?? 0);
          })[0];
        const downloadUrl = mp4?.fileDownloadUrl || mp4?.fileUrl;
        if (!downloadUrl || (mp4?.size ?? 0) > 80 * 1024 * 1024) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}septube_${downloaded}_tmp`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}septube_${downloaded}.mp4`);
        const dlResp = await fetchWithTimeout(
          downloadUrl,
          55_000,
          `SepiaSearch download scene ${sceneIndex}`,
          { headers: { "User-Agent": "Fastvid/1.0" } }
        );
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));
        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 5, `SepiaSearch scene ${sceneIndex}`)) {
          results.push({ path: outPath, query: hit.query });
          downloaded++;
          console.log(
            `[Pipeline] Scene ${sceneIndex}: SepiaSearch CC video (score ${hit.score}): ${metaTitle.slice(0, 60)}`
          );
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] SepiaSearch item failed scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] SepiaSearch failed scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

/** GDELT TV News queries — real US/UK broadcast mentions (Internet Archive TV). */
function buildGdeltTvQueries(personName: string, beatText: string, beatIndex: number): string[] {
  const quoted = `"${personName}"`;
  const clean = beatText.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  const eventQs = scriptEventSearchQueries(clean, [personName]);
  const out: string[] = [];
  for (let i = 0; i < GDELT_TV_STATIONS.length; i++) {
    const station = GDELT_TV_STATIONS[(beatIndex + i) % GDELT_TV_STATIONS.length];
    out.push(`${quoted} station:${station}`);
  }
  for (let i = 0; i < Math.min(2, eventQs.length); i++) {
    const station = GDELT_TV_STATIONS[(beatIndex + i + 1) % GDELT_TV_STATIONS.length];
    out.push(`"${eventQs[i]}" station:${station}`);
  }
  return [...new Set(out)].slice(0, 5);
}

function parseGdeltArchivePreviewUrl(
  previewUrl: string
): { identifier: string; startSec: number; endSec: number } | null {
  const m = previewUrl.match(/archive\.org\/details\/([^#?]+)#start\/(\d+)\/end\/(\d+)/i);
  if (!m) return null;
  const startSec = parseInt(m[2], 10);
  const endSec = parseInt(m[3], 10);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  return { identifier: decodeURIComponent(m[1]), startSec, endSec };
}

async function resolveArchiveVideoFileUrl(
  identifier: string,
  sceneIndex: number
): Promise<string | null> {
  const metaUrl = `https://archive.org/metadata/${identifier}/files`;
  const metaResp = await withTimeout(
    fetch(metaUrl, { headers: { "User-Agent": "Fastvid/1.0 (TV news clips)" } }),
    12_000,
    `Archive TV metadata scene ${sceneIndex}`
  );
  if (!metaResp.ok) return null;
  const metaData = await metaResp.json() as {
    result?: Array<{ name: string; format: string; size?: string }>;
  };
  const videoFiles = (metaData.result ?? []).filter((f) =>
    ["h.264", "MPEG4", "MP4", "Ogg Video", "WebM"].includes(f.format)
  );
  if (!videoFiles.length) return null;
  const videoFile = videoFiles.sort(
    (a, b) => parseInt(a.size || "999999999", 10) - parseInt(b.size || "999999999", 10)
  )[0];
  return `https://archive.org/download/${identifier}/${encodeURIComponent(videoFile.name)}`;
}

async function trimArchiveStreamToClip(
  videoUrl: string,
  outputPath: string,
  startSec: number,
  clipDur: number,
  label: string,
  fastMode = false
): Promise<boolean> {
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -ss ${startSec} -i "${videoUrl}" -t ${clipDur} ` +
          `-vf "${STANDARD_VF}" ` +
          `-c:v libx264 -preset veryfast -crf 22 -an -pix_fmt yuv420p "${outputPath}"`
      ),
      fastMode ? 50_000 : 120_000,
      `Archive stream trim ${label}`
    );
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10_000;
  } catch (err) {
    console.warn(`[Pipeline] trimArchiveStreamToClip failed (${label}):`, (err as Error).message);
    return false;
  }
}

/**
 * GDELT TV News API — real celebrity mentions on CNN/FOX/MSNBC/BBC (Internet Archive TV).
 * Free, no API key; searches closed captions and returns precise broadcast clips.
 */
async function fetchGdeltTvNewsClips(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 1,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = [],
  fastMode = false
): Promise<CelebrityClipCandidate[]> {
  const queryList = [...new Set((Array.isArray(queries) ? queries : [queries]).filter((q) => q?.trim()))];
  if (!queryList.length) return [];

  const results: CelebrityClipCandidate[] = [];
  const seenPreviews = new Set<string>();
  let downloaded = 0;

  type GdeltClip = {
    preview_url: string;
    snippet?: string;
    show?: string;
    station?: string;
    query: string;
    score: number;
  };
  const ranked: GdeltClip[] = [];

  try {
    const queryCap = fastMode ? 2 : queryList.length;
    for (const query of queryList.slice(0, queryCap)) {
      if (ranked.length >= (fastMode ? count * 2 : count * 4)) break;
      const apiUrl =
        `${GDELT_TV_API}?query=${encodeURIComponent(query)}&mode=ClipGallery&format=json` +
        `&maxrecords=${fastMode ? 4 : 8}&timespan=5y`;
      const resp = await withTimeout(
        fetch(apiUrl, { headers: { "User-Agent": "Fastvid/1.0 (GDELT TV news)" } }),
        fastMode ? 14_000 : 22_000,
        `GDELT TV search scene ${sceneIndex}`
      );
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.includes("must contain at least one station")) continue;
      let data: {
        clips?: Array<{
          preview_url?: string;
          snippet?: string;
          show?: string;
          station?: string;
        }>;
      };
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        continue;
      }
      for (const clip of data.clips ?? []) {
        if (!clip.preview_url || seenPreviews.has(clip.preview_url)) continue;
        const hay = `${clip.snippet ?? ""} ${clip.show ?? ""} ${query}`.toLowerCase();
        if (personName && !textMentionsPersonName(hay, personName)) continue;
        const score =
          scoreVisualRelevance(hay, beatKeywords) + (textMentionsPersonName(hay, personName) ? 4 : 0);
        seenPreviews.add(clip.preview_url);
        ranked.push({
          preview_url: clip.preview_url,
          snippet: clip.snippet,
          show: clip.show,
          station: clip.station,
          query,
          score,
        });
      }
    }

    ranked.sort((a, b) => b.score - a.score);

    for (const hit of ranked) {
      if (downloaded >= count) break;
      const parsed = parseGdeltArchivePreviewUrl(hit.preview_url);
      if (!parsed) continue;
      try {
        const videoUrl = await resolveArchiveVideoFileUrl(parsed.identifier, sceneIndex);
        if (!videoUrl) continue;
        const segmentDur = Math.min(duration, parsed.endSec - parsed.startSec, 60);
        if (segmentDur < 5) continue;

        const tag = fileTag ? `${fileTag}_` : "";
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}gdelt_${downloaded}.mp4`);
        const ok = await trimArchiveStreamToClip(
          videoUrl,
          outPath,
          parsed.startSec,
          segmentDur,
          `GDELT TV scene ${sceneIndex}`,
          fastMode
        );
        if (ok) {
          results.push({ path: outPath, query: hit.query });
          downloaded++;
          console.log(
            `[Pipeline] Scene ${sceneIndex}: GDELT TV news (${hit.station ?? "TV"}): ` +
              `${hit.show?.slice(0, 50) ?? hit.snippet?.slice(0, 50)}`
          );
        }
      } catch (err) {
        console.warn(`[Pipeline] GDELT clip failed scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] GDELT TV search failed scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

/** Europeana — EU broadcast/documentary video (CC/PD), requires free API key. */
async function fetchEuropeanaVideos(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 1,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = []
): Promise<CelebrityClipCandidate[]> {
  if (!EUROPEANA_API_KEY?.trim()) return [];
  const queryList = [...new Set((Array.isArray(queries) ? queries : [queries]).filter((q) => q?.trim()))];
  if (!queryList.length) return [];

  const results: CelebrityClipCandidate[] = [];
  const seenIds = new Set<string>();
  let downloaded = 0;
  const authHeader = { Authorization: `ApiKey ${EUROPEANA_API_KEY.trim()}` };

  for (const query of queryList.slice(0, 3)) {
    if (downloaded >= count) break;
    try {
      const searchUrl = new URL("https://api.europeana.eu/record/v2/search.json");
      searchUrl.searchParams.set("query", query);
      searchUrl.searchParams.set("qf", "TYPE:VIDEO");
      searchUrl.searchParams.set("reusability", "open");
      searchUrl.searchParams.set("rows", "12");

      const searchResp = await withTimeout(
        fetch(searchUrl.toString(), { headers: { ...authHeader, "User-Agent": "Fastvid/1.0" } }),
        14_000,
        `Europeana search scene ${sceneIndex}`
      );
      if (!searchResp.ok) continue;
      const searchData = await searchResp.json() as {
        items?: Array<{ id?: string; title?: string[]; edmPreview?: string }>;
      };
      const items = (searchData.items ?? [])
        .filter((item) => {
          const title = (item.title ?? []).join(" ");
          const hay = `${title} ${query}`.toLowerCase();
          if (personName && !textMentionsPersonName(hay, personName)) return false;
          return true;
        })
        .sort(
          (a, b) =>
            scoreVisualRelevance(`${(b.title ?? []).join(" ")} ${query}`, beatKeywords) -
            scoreVisualRelevance(`${(a.title ?? []).join(" ")} ${query}`, beatKeywords)
        );

      for (const item of items) {
        if (downloaded >= count) break;
        const recordId = item.id;
        if (!recordId || seenIds.has(recordId)) continue;
        seenIds.add(recordId);
        try {
          const recordUrl = `https://api.europeana.eu/record/v2${recordId}.json?profile=rich`;
          const recordResp = await withTimeout(
            fetch(recordUrl, { headers: { ...authHeader, "User-Agent": "Fastvid/1.0" } }),
            12_000,
            `Europeana record scene ${sceneIndex}`
          );
          if (!recordResp.ok) continue;
          const recordData = await recordResp.json() as {
            object?: {
              aggregations?: Array<{ edmIsShownBy?: string; edmIsShownAt?: string }>;
            };
          };
          const mediaUrl =
            recordData.object?.aggregations?.find((a) => a.edmIsShownBy)?.edmIsShownBy ??
            recordData.object?.aggregations?.find((a) => a.edmIsShownAt)?.edmIsShownAt;
          if (!mediaUrl || !/\.(mp4|webm|mov|m4v)/i.test(mediaUrl)) continue;

          const tag = fileTag ? `${fileTag}_` : "";
          const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}euro_${downloaded}_tmp`);
          const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}euro_${downloaded}.mp4`);
          const dlResp = await fetchWithTimeout(
            mediaUrl,
            55_000,
            `Europeana download scene ${sceneIndex}`,
            { headers: { "User-Agent": "Fastvid/1.0" } }
          );
          if (!dlResp.ok) continue;
          const buf = await dlResp.arrayBuffer();
          if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
          fs.writeFileSync(tmpPath, Buffer.from(buf));
          if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 3, `Europeana scene ${sceneIndex}`)) {
            results.push({ path: outPath, query });
            downloaded++;
            console.log(
              `[Pipeline] Scene ${sceneIndex}: Europeana video: ${(item.title ?? []).join(" ").slice(0, 60)}`
            );
          }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (err) {
          console.warn(`[Pipeline] Europeana item failed scene ${sceneIndex}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Europeana search failed scene ${sceneIndex}:`, (err as Error).message);
    }
  }
  return results;
}

/** Vimeo Creative Commons — interviews/documentaries (requires free access token). */
async function fetchVimeoCCVideos(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 1,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = []
): Promise<CelebrityClipCandidate[]> {
  if (!VIMEO_ACCESS_TOKEN?.trim()) return [];
  const queryList = [...new Set((Array.isArray(queries) ? queries : [queries]).filter((q) => q?.trim()))];
  if (!queryList.length) return [];

  const results: CelebrityClipCandidate[] = [];
  const vimeoHeaders = {
    Authorization: `Bearer ${VIMEO_ACCESS_TOKEN.trim()}`,
    Accept: "application/vnd.vimeo.*+json;version=3.4",
    "User-Agent": "Fastvid/1.0",
  };
  const seenUris = new Set<string>();
  let downloaded = 0;

  for (const query of queryList.slice(0, 3)) {
    if (downloaded >= count) break;
    try {
      const searchUrl =
        `https://api.vimeo.com/videos?query=${encodeURIComponent(query)}&filter=CC` +
        `&per_page=10&sort=relevant&fields=uri,name,description,link`;
      const searchResp = await withTimeout(
        fetch(searchUrl, { headers: vimeoHeaders }),
        14_000,
        `Vimeo CC search scene ${sceneIndex}`
      );
      if (!searchResp.ok) continue;
      const searchData = await searchResp.json() as {
        data?: Array<{ uri?: string; name?: string; description?: string }>;
      };

      for (const video of searchData.data ?? []) {
        if (downloaded >= count) break;
        const uri = video.uri;
        if (!uri || seenUris.has(uri)) continue;
        const hay = `${video.name ?? ""} ${video.description ?? ""} ${query}`.toLowerCase();
        if (personName && !textMentionsPersonName(hay, personName)) continue;
        if (beatKeywords.length > 0 && scoreVisualRelevance(hay, beatKeywords) < 1) continue;
        seenUris.add(uri);

        try {
          const detailUrl = `https://api.vimeo.com${uri}?fields=download,name`;
          const detailResp = await withTimeout(
            fetch(detailUrl, { headers: vimeoHeaders }),
            12_000,
            `Vimeo detail scene ${sceneIndex}`
          );
          if (!detailResp.ok) continue;
          const detail = await detailResp.json() as {
            download?: Array<{ link?: string; quality?: string; size?: number }>;
          };
          const dl =
            detail.download
              ?.filter((d) => d.link && (d.size ?? 0) < 80 * 1024 * 1024)
              .sort((a, b) => {
                const qa = parseInt((a.quality ?? "720").replace(/\D/g, ""), 10) || 720;
                const qb = parseInt((b.quality ?? "720").replace(/\D/g, ""), 10) || 720;
                return Math.abs(qa - 720) - Math.abs(qb - 720);
              })[0] ?? detail.download?.find((d) => d.link);
          const downloadUrl = dl?.link;
          if (!downloadUrl) continue;

          const tag = fileTag ? `${fileTag}_` : "";
          const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}vimeo_${downloaded}_tmp`);
          const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}vimeo_${downloaded}.mp4`);
          const dlResp = await fetchWithTimeout(
            downloadUrl,
            55_000,
            `Vimeo download scene ${sceneIndex}`,
            { headers: { "User-Agent": "Fastvid/1.0" } }
          );
          if (!dlResp.ok) continue;
          const buf = await dlResp.arrayBuffer();
          if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
          fs.writeFileSync(tmpPath, Buffer.from(buf));
          if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 5, `Vimeo CC scene ${sceneIndex}`)) {
            results.push({ path: outPath, query });
            downloaded++;
            console.log(`[Pipeline] Scene ${sceneIndex}: Vimeo CC video: ${video.name?.slice(0, 60)}`);
          }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (err) {
          console.warn(`[Pipeline] Vimeo item failed scene ${sceneIndex}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Vimeo CC search failed scene ${sceneIndex}:`, (err as Error).message);
    }
  }
  return results;
}

/** media.ccc.de — CC-BY conference talks (strong for Musk/Tesla/tech figures). */
async function fetchMediaCccVideos(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 1,
  fileTag = ""
): Promise<string[]> {
  if (!query?.trim()) return [];
  const results: string[] = [];
  try {
    const searchUrl = `https://api.media.ccc.de/public/events/search?q=${encodeURIComponent(query)}`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { "User-Agent": "Fastvid/1.0 (media.ccc.de CC)" } }),
      12_000,
      `media.ccc search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const data = await searchResp.json() as {
      events?: Array<{
        title?: string;
        recordings?: Array<{
          mime_type?: string;
          folder?: string;
          filename?: string;
          recording_url?: string;
          length?: number;
          high_quality?: boolean;
        }>;
      }>;
    };
    const events = data.events ?? [];

    let downloaded = 0;
    for (const event of events) {
      if (downloaded >= count) break;
      const recs = event.recordings ?? [];
      const videoRec =
        recs.find((r) => r.mime_type === "video/mp4" && r.recording_url) ??
        recs.find(
          (r) =>
            r.recording_url &&
            /video\/mp4|\.mp4/i.test(`${r.mime_type ?? ""} ${r.filename ?? ""}`) &&
            /h264|mp4/i.test(`${r.folder ?? ""} ${r.filename ?? ""}`)
        );
      if (!videoRec?.recording_url) continue;
      if ((videoRec.length ?? 0) > 0 && (videoRec.length ?? 0) < 8) continue;

      try {
        const tag = fileTag ? `${fileTag}_` : "";
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}ccc_${downloaded}_tmp`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}ccc_${downloaded}.mp4`);
        const dlResp = await fetchWithTimeout(
          videoRec.recording_url,
          90_000,
          `media.ccc download scene ${sceneIndex}`,
          { headers: { "User-Agent": "Fastvid/1.0" } }
        );
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 80_000 || buf.byteLength > 120 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));
        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 10, `media.ccc scene ${sceneIndex}`)) {
          results.push(outPath);
          downloaded++;
          console.log(`[Pipeline] Scene ${sceneIndex}: media.ccc video: ${event.title?.slice(0, 60)}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] media.ccc download failed scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] media.ccc search failed scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

function personMatchesTechCccTopic(personName: string, beatText = ""): boolean {
  const hay = `${personName} ${beatText}`.toLowerCase();
  return /\b(musk|tesla|spacex|bezos|zuckerberg|jobs|gates|cybertruck|starlink|jenner|kardashian|celebrity|billionaire)\b/.test(
    hay
  );
}

/**
 * Real celebrity/person video without YouTube quota (all persons, script-aware queries):
 * Wikimedia → GDELT TV News → SepiaSearch → Archive → Europeana → Vimeo CC → CCC → Flickr.
 */
async function fetchPersonCelebrityVideoClips(
  personName: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number,
  fileTag: string,
  beatIndex: number,
  beatText = "",
  fastMode = false
): Promise<CelebrityClipCandidate[]> {
  const results: CelebrityClipCandidate[] = [];
  const beatKeywords = buildPersonBeatRelevanceKeywords(personName, beatText);
  const scriptQueries = buildPersonCelebrityVideoQueries(personName, beatText, beatIndex);
  const gdeltQueries = buildGdeltTvQueries(personName, beatText, beatIndex);
  const candidateTarget = fastMode ? Math.max(count, 2) : Math.max(count * 2, 4);
  const scriptQueryCap = fastMode ? 3 : scriptQueries.length;

  for (const q of scriptQueries.slice(0, scriptQueryCap)) {
    if (results.length >= candidateTarget) break;
    const wikiHits = await fetchWikimediaVideos(
      q,
      duration,
      workDir,
      sceneIndex,
      candidateTarget - results.length,
      fileTag,
      personName,
      beatKeywords
    );
    results.push(...wikiHits);
  }

  if (results.length < candidateTarget) {
    const gdeltHits = await fetchGdeltTvNewsClips(
      gdeltQueries,
      duration,
      workDir,
      sceneIndex,
      fastMode ? 1 : candidateTarget - results.length,
      fileTag,
      personName,
      beatKeywords,
      fastMode
    );
    results.push(...gdeltHits);
  }

  if (results.length < candidateTarget) {
    const septubeHits = await fetchSepiaSearchVideos(
      scriptQueries.slice(0, fastMode ? 3 : scriptQueries.length),
      duration,
      workDir,
      sceneIndex,
      candidateTarget - results.length,
      fileTag,
      personName,
      beatKeywords
    );
    results.push(...septubeHits);
  }

  if (results.length < candidateTarget) {
    const archiveHits = await fetchInternetArchiveClips(
      buildPersonArchiveVideoQueries(personName, beatIndex, beatText),
      duration,
      workDir,
      sceneIndex,
      candidateTarget - results.length,
      fileTag,
      personName,
      beatKeywords
    );
    results.push(...archiveHits);
  }

  if (results.length < candidateTarget && EUROPEANA_API_KEY && !fastMode) {
    const euroHits = await fetchEuropeanaVideos(
      scriptQueries,
      duration,
      workDir,
      sceneIndex,
      candidateTarget - results.length,
      fileTag,
      personName,
      beatKeywords
    );
    results.push(...euroHits);
  }

  if (!fastMode && results.length < candidateTarget && VIMEO_ACCESS_TOKEN) {
    const vimeoHits = await fetchVimeoCCVideos(
      scriptQueries,
      duration,
      workDir,
      sceneIndex,
      candidateTarget - results.length,
      fileTag,
      personName,
      beatKeywords
    );
    results.push(...vimeoHits);
  }

  if (results.length < candidateTarget && personMatchesTechCccTopic(personName, beatText)) {
    const cccPaths = await fetchMediaCccVideos(
      personName,
      duration,
      workDir,
      sceneIndex,
      candidateTarget - results.length,
      fileTag
    );
    for (const p of cccPaths) {
      results.push({ path: p, query: `${personName} conference` });
    }
  }

  if (results.length < candidateTarget && FLICKR_API_KEY) {
    for (const q of scriptQueries.slice(0, 3)) {
      if (results.length >= candidateTarget) break;
      const flickrPaths = await fetchFlickrCCVideos(
        q,
        duration,
        workDir,
        sceneIndex,
        candidateTarget - results.length,
        fileTag,
        personName,
        beatKeywords
      );
      for (const p of flickrPaths) {
        results.push({ path: p, query: q });
      }
    }
  }

  const seen = new Set<string>();
  return results
    .filter((c) => {
      if (seen.has(c.path)) return false;
      seen.add(c.path);
      return true;
    })
    .sort(
      (a, b) =>
        scoreCelebrityCandidate(b, beatText, personName, beatKeywords) -
        scoreCelebrityCandidate(a, beatText, personName, beatKeywords)
    )
    .slice(0, candidateTarget);
}

// ─── 3c2n. NASA Images & Video Library (public domain US gov footage) ─────────
async function fetchNasaVideoClips(
  query: string,
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2
): Promise<string[]> {
  if (!query?.trim()) return [];
  const results: string[] = [];
  try {
    const searchUrl = `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=video`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { "User-Agent": "Fastvid/1.0 (NASA public domain footage)" } }),
      12_000,
      `NASA video search scene ${sceneIndex}`
    );
    if (!searchResp.ok) return [];
    const data = await searchResp.json() as {
      collection?: { items?: Array<{ data?: Array<{ nasa_id?: string; title?: string }> }> };
    };
    const items = data.collection?.items ?? [];
    let fetched = 0;
    for (const item of items) {
      if (fetched >= count) break;
      const nasaId = item.data?.[0]?.nasa_id;
      const title = item.data?.[0]?.title ?? nasaId;
      if (!nasaId) continue;
      try {
        const assetResp = await withTimeout(
          fetch(`https://images-api.nasa.gov/asset/${nasaId}`, { headers: { "User-Agent": "Fastvid/1.0" } }),
          12_000,
          `NASA asset ${nasaId}`
        );
        if (!assetResp.ok) continue;
        const assets = await assetResp.json() as string[];
        const mp4Path = assets.find((u) => /\.mp4$/i.test(u) && !/~mobile|~thumb|~preview|~small/i.test(u))
          ?? assets.find((u) => /\.mp4$/i.test(u));
        if (!mp4Path) continue;
        const mp4Url = mp4Path.startsWith("http")
          ? mp4Path
          : `https://images-assets.nasa.gov${mp4Path.startsWith("/") ? mp4Path : `/${mp4Path}`}`;

        const tmpPath = path.join(workDir, `scene_${sceneIndex}_nasa_${fetched}_tmp.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_nasa_${fetched}.mp4`);
        const dlResp = await fetchWithTimeout(mp4Url, 60_000, `NASA download scene ${sceneIndex}`, {
          headers: { "User-Agent": "Fastvid/1.0" },
        });
        if (!dlResp.ok) continue;
        const buf = await dlResp.arrayBuffer();
        if (buf.byteLength < 50_000 || buf.byteLength > 80 * 1024 * 1024) continue;
        fs.writeFileSync(tmpPath, Buffer.from(buf));

        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 8, `NASA scene ${sceneIndex}`)) {
          results.push(outPath);
          fetched++;
          console.log(`[Pipeline] Scene ${sceneIndex}: NASA video added: ${title}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] NASA video ${nasaId} failed for scene ${sceneIndex}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] NASA video search failed for scene ${sceneIndex}:`, (err as Error).message);
  }
  return results;
}

function buildEventVideoQueries(scene: Scene, primarySubject: string, hasPerson: boolean): string[] {
  const hint = `${scene.text} ${primarySubject}`;
  const q = [
    scene.visualCue,
    scene.pexelsQuery,
    ...(scene.pexelsQueries ?? []),
    ...(scene.brollQueries ?? []),
    hasPerson && primarySubject ? primarySubject : "",
  ]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => simplifyStockSearchWord(s, hint));
  return Array.from(new Set(q.filter((w) => w.length >= 3)));
}

function isSpaceRelatedTopic(...parts: string[]): boolean {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  return /space|rocket|nasa|esa|spacex|mars|moon|satellite|launch|orbit|astronaut|shuttle|station|tesla|electric vehicle|factory/i.test(text);
}

// ─── 3c2. Fetch Internet Archive Video Clips ────────────────────────────────
async function fetchInternetArchiveClips(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  fileTag = "",
  personName = "",
  beatKeywords: string[] = []
): Promise<CelebrityClipCandidate[]> {
  const results: CelebrityClipCandidate[] = [];
  const queryList = Array.isArray(queries) ? queries : [queries];
  const uniqueQueries = Array.from(new Set(queryList.filter((q) => q && q.trim().length > 0)));
  let fetched = 0;

  for (const query of uniqueQueries) {
    if (fetched >= count) break;
    try {
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:movies&fl[]=identifier,title&rows=12&output=json`;
    const searchResp = await withTimeout(
      fetch(searchUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
      IS_RAILWAY ? 6_000 : 10_000,
      `Internet Archive search scene ${sceneIndex}`
    );
    if (!searchResp.ok) continue;
    const searchData = await searchResp.json() as { response?: { docs?: Array<{ identifier: string; title: string }> } };
    const docs = (searchData.response?.docs ?? [])
      .filter((doc) => {
        const hay = `${doc.title} ${query}`.toLowerCase();
        if (personName && !textMentionsPersonName(hay, personName)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          scoreVisualRelevance(`${b.title} ${query}`, beatKeywords) -
          scoreVisualRelevance(`${a.title} ${query}`, beatKeywords)
      )
      .slice(0, (count - fetched) * 3);
    if (!docs.length) continue;

    for (const doc of docs) {
      if (fetched >= count) break;
      try {
        const metaUrl = `https://archive.org/metadata/${doc.identifier}/files`;
        const metaResp = await withTimeout(
          fetch(metaUrl, { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }),
          8_000,
          `Internet Archive metadata scene ${sceneIndex}`
        );
        if (!metaResp.ok) continue;
        const metaData = await metaResp.json() as { result?: Array<{ name: string; format: string; size?: string }> };
        const videoFiles = (metaData.result || []).filter(f =>
          ['h.264', 'MPEG4', 'MP4', 'Ogg Video', 'WebM'].includes(f.format)
        );
        if (!videoFiles.length) continue;

        const videoFile = videoFiles.sort((a, b) =>
          parseInt(a.size || '999999999') - parseInt(b.size || '999999999')
        )[0];

        const videoUrl = `https://archive.org/download/${doc.identifier}/${encodeURIComponent(videoFile.name)}`;
        const tag = fileTag ? `${fileTag}_` : "";
        const outPath = path.join(workDir, `scene_${sceneIndex}_${tag}archive_${fetched}.mp4`);
        const tmpPath = path.join(workDir, `scene_${sceneIndex}_${tag}archive_${fetched}_tmp`);

        const dlResp = await fetchWithTimeout(
          videoUrl,
          IS_RAILWAY ? 18_000 : 45_000,
          `Internet Archive download scene ${sceneIndex}`,
          { headers: { 'User-Agent': 'Fastvid/1.0 (video generation)' } }
        );
        if (!dlResp.ok) continue;

        const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
        const arrayBuf = await dlResp.arrayBuffer();
        if (arrayBuf.byteLength > MAX_ARCHIVE_SIZE) {
          console.warn(`[Pipeline] Scene ${sceneIndex}: Archive clip too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB), skipping`);
          continue;
        }
        fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

        if (await trimRemoteVideoToClip(tmpPath, outPath, duration, 10, `Internet Archive scene ${sceneIndex}`)) {
          results.push({ path: outPath, query });
          fetched++;
          console.log(`[Pipeline] Scene ${sceneIndex}: Internet Archive clip added: ${doc.title}`);
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Pipeline] Scene ${sceneIndex}: Archive item ${doc.identifier} failed:`, (err as Error).message);
      }
    }
    } catch (err) {
      console.warn(`[Pipeline] Scene ${sceneIndex}: Internet Archive search failed for "${query}":`, (err as Error).message);
    }
  }
  return results;
}

// ─── 3c3a. Download a YouTube CC clip (RapidAPI first, cloud service fallback) ─
async function downloadYouTubeCCClip(
  videoId: string,
  duration: number,
  clipStart: number,
  outPath: string,
  sceneIndex: number,
  title?: string
): Promise<boolean> {
  const cloudDlService = process.env.YOUTUBE_CC_DL_SERVICE?.replace(/\/$/, "") || "";

  if (RAPIDAPI_KEY) {
    const tmpPath = outPath.replace(/\.mp4$/, "_rapid_tmp.mp4");
    try {
      const metaUrl = `https://${RAPIDAPI_YT_HOST}/dl?id=${videoId}`;
      const metaResp = await withTimeout(
        fetch(metaUrl, {
          headers: {
            "x-rapidapi-host": RAPIDAPI_YT_HOST,
            "x-rapidapi-key": RAPIDAPI_KEY,
          },
        }),
        20_000,
        `RapidAPI YouTube meta scene ${sceneIndex}`
      );
      if (metaResp.ok) {
        const data = await metaResp.json() as {
          formats?: Array<{ url?: string; mimeType?: string; contentLength?: string; height?: number }>;
          adaptiveFormats?: Array<{ url?: string; mimeType?: string; contentLength?: string; height?: number }>;
        };
        const pickFormat = (
          formats: Array<{ url?: string; mimeType?: string; contentLength?: string; height?: number }> | undefined
        ) => {
          const mp4 = (formats ?? []).filter((f) => f.url && f.mimeType?.includes("mp4"));
          if (!mp4.length) return undefined;
          return mp4.sort((a, b) => {
            const heightA = a.height ?? 720;
            const heightB = b.height ?? 720;
            const distA = Math.abs(heightA - 720);
            const distB = Math.abs(heightB - 720);
            if (distA !== distB) return distA - distB;
            return parseInt(a.contentLength || "999999999", 10) - parseInt(b.contentLength || "999999999", 10);
          })[0];
        };

        const format = pickFormat(data.formats) ?? pickFormat(data.adaptiveFormats);
        if (format?.url) {
          const dlResp = await fetchWithTimeout(
            format.url,
            90_000,
            `RapidAPI YouTube download scene ${sceneIndex}`,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: "https://www.youtube.com/",
              },
            }
          );
          if (dlResp.ok) {
            const buf = await dlResp.arrayBuffer();
            if (buf.byteLength >= 50_000 && buf.byteLength <= 80 * 1024 * 1024) {
              fs.writeFileSync(tmpPath, Buffer.from(buf));
              if (
                await trimRemoteVideoToClip(
                  tmpPath,
                  outPath,
                  duration,
                  clipStart,
                  `YouTube CC RapidAPI scene ${sceneIndex}`
                )
              ) {
                console.log(
                  `[Pipeline] Scene ${sceneIndex}: ✅ YouTube CC via RapidAPI: "${title?.slice(0, 60) ?? videoId}" (${videoId})`
                );
                return true;
              }
            }
          }
        }
      } else {
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: RapidAPI error ${metaResp.status} for ${videoId}`
        );
      }
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${sceneIndex}: RapidAPI download failed for ${videoId}:`,
        (err as Error).message
      );
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (cloudDlService) {
    try {
      const dlUrl = `${cloudDlService}/download?id=${videoId}&duration=${duration}&start=${clipStart}`;
      const dlResp = await fetchWithTimeout(
        dlUrl,
        90_000,
        `YouTube CC cloud download scene ${sceneIndex}`
      );
      if (!dlResp.ok) {
        const errText = await dlResp.text().catch(() => "");
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: Cloud DL service error ${dlResp.status} for ${videoId}: ${errText.slice(0, 100)}`
        );
        return false;
      }
      const arrayBuf = await dlResp.arrayBuffer();
      if (arrayBuf.byteLength > 80 * 1024 * 1024) {
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: YouTube CC clip too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB), skipping`
        );
        return false;
      }
      fs.writeFileSync(outPath, Buffer.from(arrayBuf));
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
        console.log(
          `[Pipeline] Scene ${sceneIndex}: ✅ YouTube CC via cloud service: "${title?.slice(0, 60) ?? videoId}" (${videoId})`
        );
        return true;
      }
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${sceneIndex}: Cloud DL failed for ${videoId}:`,
        (err as Error).message
      );
    }
  }

  return false;
}

/** Live probe: YouTube CC search + RapidAPI metadata (for /api/health/youtube-probe). */
export async function probeYouTubeCcPipeline(): Promise<{
  ready: boolean;
  searchStatus: number | null;
  ccResultCount: number;
  rapidApiStatus: number | null;
  rapidApiHasFormat: boolean;
  sampleVideoId: string | null;
  message: string;
}> {
  const ready = youtubeCcReady();
  if (!ready) {
    return {
      ready: false,
      searchStatus: null,
      ccResultCount: 0,
      rapidApiStatus: null,
      rapidApiHasFormat: false,
      sampleVideoId: null,
      message: "Set YOUTUBE_API_KEY and RAPIDAPI_KEY (or YOUTUBE_CC_DL_SERVICE)",
    };
  }
  const probeQuery = "SpaceX Falcon 9 rocket launch";
  let searchStatus: number | null = null;
  let ccResultCount = 0;
  let sampleVideoId: string | null = null;
  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("key", process.env.YOUTUBE_API_KEY!.trim());
    searchUrl.searchParams.set("q", probeQuery);
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("videoLicense", "creativeCommon");
    searchUrl.searchParams.set("maxResults", "5");
    searchUrl.searchParams.set("part", "snippet");
    const searchResp = await fetch(searchUrl.toString());
    searchStatus = searchResp.status;
    if (searchResp.ok) {
      const data = (await searchResp.json()) as {
        items?: Array<{ id?: { videoId?: string } }>;
      };
      ccResultCount = data.items?.length ?? 0;
      sampleVideoId = data.items?.[0]?.id?.videoId ?? null;
    }
  } catch (err) {
    return {
      ready: true,
      searchStatus,
      ccResultCount: 0,
      rapidApiStatus: null,
      rapidApiHasFormat: false,
      sampleVideoId: null,
      message: `YouTube search failed: ${(err as Error).message}`,
    };
  }

  let rapidApiStatus: number | null = null;
  let rapidApiHasFormat = false;
  if (sampleVideoId && RAPIDAPI_KEY) {
    const host = process.env.RAPIDAPI_YT_HOST || "ytstream-download-youtube-videos.p.rapidapi.com";
    try {
      const metaResp = await fetch(`https://${host}/dl?id=${sampleVideoId}`, {
        headers: {
          "x-rapidapi-host": host,
          "x-rapidapi-key": RAPIDAPI_KEY,
        },
      });
      rapidApiStatus = metaResp.status;
      if (metaResp.ok) {
        const data = (await metaResp.json()) as {
          formats?: Array<{ url?: string; mimeType?: string }>;
          adaptiveFormats?: Array<{ url?: string; mimeType?: string }>;
        };
        const mp4 = [...(data.formats ?? []), ...(data.adaptiveFormats ?? [])].some(
          (f) => f.url && f.mimeType?.includes("mp4")
        );
        rapidApiHasFormat = mp4;
      }
    } catch {
      rapidApiStatus = null;
    }
  }

  const searchOk = searchStatus === 200 && ccResultCount > 0;
  const rapidOk = rapidApiStatus === 200 && rapidApiHasFormat;
  let message = "YouTube CC pipeline OK";
  if (!searchOk) {
    message =
      searchStatus === 403
        ? "YouTube API key invalid or quota exceeded"
        : `YouTube CC search returned ${ccResultCount} results (HTTP ${searchStatus})`;
  } else if (!rapidOk) {
    message =
      rapidApiStatus === 403 || rapidApiStatus === 401
        ? "RapidAPI key invalid or not subscribed to ytstream-download-youtube-videos"
        : `RapidAPI metadata HTTP ${rapidApiStatus ?? "error"} — no MP4 format`;
  }

  return {
    ready: true,
    searchStatus,
    ccResultCount,
    rapidApiStatus,
    rapidApiHasFormat,
    sampleVideoId,
    message,
  };
}

/** Live probe: one Stability Core/Ultra image (for /api/health/stability-probe). */
export async function probeStabilityAI(): Promise<{
  ready: boolean;
  tier: "core" | "ultra";
  httpStatus: number | null;
  imageBytes: number;
  elapsedMs: number;
  message: string;
}> {
  if (!STABILITY_AI_API_KEY?.trim()) {
    return {
      ready: false,
      tier: "core",
      httpStatus: null,
      imageBytes: 0,
      elapsedMs: 0,
      message: "STABILITY_AI_API_KEY not set",
    };
  }
  const useUltra = process.env.STABILITY_AI_TIER === "ultra";
  const tier = useUltra ? "ultra" : "core";
  const endpoint = useUltra
    ? "https://api.stability.ai/v2beta/stable-image/generate/ultra"
    : "https://api.stability.ai/v2beta/stable-image/generate/core";
  const t = Date.now();
  try {
    const form = new FormData();
    form.append("prompt", "Fastvid API probe, photorealistic documentary still, neutral subject, 16:9");
    form.append("aspect_ratio", "16:9");
    form.append("output_format", "png");
    form.append("negative_prompt", "text, watermark, logo");
    form.append("style_preset", "photographic");
    const resp = await withTimeout(
      fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STABILITY_AI_API_KEY}`,
          Accept: "image/*",
        },
        body: form,
      }),
      45_000,
      "Stability AI probe"
    );
    const elapsedMs = Date.now() - t;
    if (!resp.ok) {
      const errText = (await resp.text()).slice(0, 240);
      let message = `Stability HTTP ${resp.status}: ${errText}`;
      if (resp.status === 402) message = "Stability credits exhausted — add balance in Billing";
      if (resp.status === 401) message = "Stability API key invalid";
      return { ready: true, tier, httpStatus: resp.status, imageBytes: 0, elapsedMs, message };
    }
    const raw = Buffer.from(await resp.arrayBuffer());
    const ok = raw.length > 50_000;
    return {
      ready: true,
      tier,
      httpStatus: resp.status,
      imageBytes: raw.length,
      elapsedMs,
      message: ok
        ? `Stability ${tier} OK (${(raw.length / 1024).toFixed(0)} KB in ${(elapsedMs / 1000).toFixed(1)}s)`
        : `Stability returned undersized image (${raw.length} bytes)`,
    };
  } catch (err) {
    return {
      ready: true,
      tier,
      httpStatus: null,
      imageBytes: 0,
      elapsedMs: Date.now() - t,
      message: `Stability probe failed: ${(err as Error).message}`,
    };
  }
}

// ─── 3c3. Fetch YouTube Video Clips (CC + fair-use) ───────────────────────────
// CC first; then standard YouTube when fair-use is enabled (transform required on adopt).
type ScriptGuidedBeatContext = {
  beatText: string;
  videoTitle?: string;
  fastMode?: boolean;
};

type YoutubeSearchRow = {
  item: {
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
    };
  };
  title: string;
  desc: string;
  thumb?: string;
  rel: number;
};

async function searchYoutubeVideoCandidates(
  query: string,
  sceneIndex: number,
  license: "creative_common" | "any",
  relevanceKeywords: string[],
  minRelevanceScore: number,
  requiredPersonName: string,
  maxResults: number
): Promise<YoutubeSearchRow[]> {
  const youtubeApiKey = process.env.YOUTUBE_API_KEY;
  if (!youtubeApiKey) return [];

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("key", youtubeApiKey);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("type", "video");
  if (license === "creative_common") {
    searchUrl.searchParams.set("videoLicense", "creativeCommon");
  }
  searchUrl.searchParams.set("maxResults", String(maxResults));
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("videoDuration", "medium");
  searchUrl.searchParams.set("order", "relevance");
  searchUrl.searchParams.set("videoEmbeddable", "true");

  const label = license === "creative_common" ? "YouTube CC" : "YouTube fair-use";
  const searchResp = await withTimeout(
    fetch(searchUrl.toString()),
    15_000,
    `${label} search scene ${sceneIndex}`
  );
  if (!searchResp.ok) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: ${label} API error ${searchResp.status} for "${query}"`);
    return [];
  }

  const searchData = (await searchResp.json()) as {
    items?: YoutubeSearchRow["item"][];
  };

  return (searchData.items ?? [])
    .map((item) => {
      const title = item.snippet?.title ?? "";
      const desc = item.snippet?.description ?? "";
      const thumb = item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url;
      const hay = `${title} ${desc} ${query}`;
      if (requiredPersonName && !textMentionsPersonName(hay, requiredPersonName)) {
        return { item, title, desc, thumb, rel: -1 };
      }
      const rel = relevanceKeywords.length > 0 ? scoreVisualRelevance(hay, relevanceKeywords) : 1;
      return { item, title, desc, thumb, rel };
    })
    .filter((row) => row.rel >= minRelevanceScore)
    .sort((a, b) => b.rel - a.rel);
}

async function fetchYouTubeCCClips(
  queries: string | string[],
  duration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  relevanceKeywords: string[] = [],
  minRelevanceScore = 1,
  requiredPersonName = "",
  scriptGuided?: ScriptGuidedBeatContext
): Promise<string[]> {
  if (!youtubeSourcingEnabled()) return [];
  const results: string[] = [];

  const youtubeApiKey = process.env.YOUTUBE_API_KEY;
  const hasDownloader = !!RAPIDAPI_KEY || !!process.env.YOUTUBE_CC_DL_SERVICE;

  if (!youtubeApiKey) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: YouTube CC skipped — missing YOUTUBE_API_KEY`);
    return [];
  }
  if (!hasDownloader) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex}: YouTube CC skipped — set RAPIDAPI_KEY or YOUTUBE_CC_DL_SERVICE in Railway`
    );
    return [];
  }

  // Normalise: accept single string or array of query variants (specific→broad)
  const queryList = Array.isArray(queries) ? queries : [queries];
  // Deduplicate and filter empty strings
  const uniqueQueries = Array.from(new Set(queryList.filter(q => q && q.trim().length > 0)));

  // Track video IDs already downloaded to avoid duplicates across query variants
  const downloadedIds = new Set<string>();
  let fetched = 0;

  const ytDeadline = Date.now() + (IS_RAILWAY ? 88_000 : 55_000);
  const guidedDeadline =
    scriptGuidedClipsEnabled() && scriptGuided?.beatText?.trim()
      ? Date.now() + scriptGuidedBudgetMs(scriptGuided.fastMode ?? IS_RAILWAY)
      : ytDeadline;

  const licensePasses: Array<{ license: "creative_common" | "any"; tag: string; fileTag: string }> = [
    { license: "creative_common", tag: "YouTube CC", fileTag: "ytcc" },
  ];
  if (youtubeFairUseEnabled()) {
    licensePasses.push({ license: "any", tag: "YouTube fair-use", fileTag: "ytfu" });
  }

  for (const query of uniqueQueries.slice(0, 2)) {
    if (fetched >= count) break;
    if (Date.now() > ytDeadline) break;

    for (const pass of licensePasses) {
      if (fetched >= count) break;
      if (Date.now() > ytDeadline) break;
      if (pass.license === "any" && fetched >= count) break;

      try {
        const items = await searchYoutubeVideoCandidates(
          query,
          sceneIndex,
          pass.license,
          relevanceKeywords,
          minRelevanceScore,
          requiredPersonName,
          Math.max(5, (count - fetched) * 4)
        );
        if (!items.length) {
          console.warn(
            `[Pipeline] Scene ${sceneIndex}: ${pass.tag} 0 relevant results for "${query}"`
          );
          continue;
        }
        console.log(
          `[Pipeline] Scene ${sceneIndex}: ${pass.tag} found ${items.length} relevant videos for "${query}"`
        );

        let guidedAttempts = 0;
        const maxGuidedAttempts = scriptGuided?.fastMode ? 2 : 3;

        for (const row of items.slice(0, 5)) {
          if (fetched >= count) break;
          if (Date.now() > ytDeadline) break;
          const item = row.item;
          const videoId = item.id?.videoId;
          if (!videoId || downloadedIds.has(videoId)) continue;

          const title = row.title;
          if (relevanceKeywords.length > 0 && row.rel < minRelevanceScore) {
            console.warn(
              `[Pipeline] Scene ${sceneIndex}: ${pass.tag} skip irrelevant "${title.slice(0, 60)}" (score ${row.rel}/${minRelevanceScore})`
            );
            continue;
          }

          try {
            let clipStart = 15;
            if (
              scriptGuidedClipsEnabled() &&
              scriptGuided?.beatText?.trim() &&
              guidedAttempts < maxGuidedAttempts
            ) {
              guidedAttempts++;
              const plan = await planScriptGuidedClip(
                {
                  videoId,
                  title,
                  description: row.desc,
                  thumbnailUrl: row.thumb,
                  metadataScore: row.rel,
                },
                {
                  beatText: scriptGuided.beatText,
                  keywords: relevanceKeywords,
                  videoTitle: scriptGuided.videoTitle,
                  deadlineMs: Math.min(ytDeadline, guidedDeadline),
                  fastMode: scriptGuided.fastMode,
                }
              );
              if (plan.skip) {
                console.log(
                  `[ScriptGuided] Scene ${sceneIndex}: skip YT "${title.slice(0, 55)}" (vision/metadata)`
                );
                continue;
              }
              clipStart = Math.max(0, Math.round(plan.startSec * 10) / 10);
              console.log(
                `[ScriptGuided] Scene ${sceneIndex}: ${plan.method} @${clipStart}s "${title.slice(0, 55)}"`
              );
            }

            const outPath = path.join(workDir, `scene_${sceneIndex}_${pass.fileTag}_${fetched}.mp4`);
            const clipDur = capYoutubeClipDuration(duration, pass.fileTag);

            const ok = await downloadYouTubeCCClip(
              videoId,
              clipDur,
              clipStart,
              outPath,
              sceneIndex,
              item.snippet?.title
            );
            if (ok) {
              results.push(outPath);
              downloadedIds.add(videoId);
              fetched++;
              if (pass.license === "any") {
                console.log(
                  `[Pipeline] Scene ${sceneIndex}: ✅ YouTube fair-use clip (transform on adopt): "${title.slice(0, 60)}"`
                );
              }
            }
          } catch (err) {
            console.warn(
              `[Pipeline] Scene ${sceneIndex}: ${pass.tag} video ${videoId} failed:`,
              (err as Error).message
            );
          }
        }
      } catch (err) {
        console.warn(
          `[Pipeline] Scene ${sceneIndex}: ${pass.tag} search failed for "${query}":`,
          (err as Error).message
        );
      }
    }
  }
  return results;
}

// ─── 3d. Transform Clip for Fair Use ───────────────────────────────────────
// Applies mandatory visual transformations to any stock/archive/YouTube clip:
//   1. Cinematic color grading (contrast + saturation + color curves)
//   2. Scene narration text as subtitle overlay (bottom of frame)
//   3. Vignette effect (darkened edges for cinematic look)
//   4. Slight zoom-in crop (changes framing/composition)
// This makes every clip a transformative derivative work.
async function transformClipForFairUse(
  inputPath: string,
  sceneText: string,
  sceneIndex: number,
  clipIndex: number,
  workDir: string,
  timeoutMs = 120_000
): Promise<string> {
  const outputPath = inputPath.replace(/\.mp4$/, '_transformed.mp4');
  const strict = clipRequiresFairUseTransform(inputPath);

  const grades = [
    { contrast: 1.08, saturation: 1.12, brightness: -0.02 },
    { contrast: 1.10, saturation: 0.95, brightness: -0.03 },
    { contrast: 1.05, saturation: 1.20, brightness: 0.00 },
    { contrast: 1.12, saturation: 0.90, brightness: -0.04 },
    { contrast: 1.06, saturation: 1.08, brightness: 0.01 },
  ];
  const grade = grades[(sceneIndex + clipIndex) % grades.length];
  const vignetteAngle = (0.5 + ((sceneIndex * 3 + clipIndex) % 5) * 0.1).toFixed(2);
  const zoom = 1.06 + ((sceneIndex + clipIndex) % 3) * 0.01;
  const zw = Math.round(VIDEO_WIDTH * zoom);
  const zh = Math.round(VIDEO_HEIGHT * zoom);
  const zoomCrop =
    `scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(iw-${VIDEO_WIDTH})/2:(ih-${VIDEO_HEIGHT})/2`;
  let filterChain =
    `${zoomCrop},` +
    `eq=contrast=${grade.contrast}:saturation=${grade.saturation}:brightness=${grade.brightness},` +
    `vignette=angle=${vignetteAngle}:mode=forward`;

  const subtitle = sanitizeForDrawtextStrict(sceneText, 72);
  if (subtitle && ffmpegSupportsDrawtext()) {
    filterChain +=
      `,drawtext=text='${subtitle}':fontcolor=white:fontsize=30:x=(w-text_w)/2:y=h-72:` +
      `box=1:boxcolor=black@0.55:boxborderw=10`;
  }

  const TRANSFORM_TIMEOUT_MS = timeoutMs;
  console.log(
    `[Pipeline] Scene ${sceneIndex}: fair-use transform clip ${clipIndex} (${path.basename(inputPath)})` +
      (subtitle ? " + narration subtitle" : "")
  );
  try {
    const { spawn: spawnChild } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y', '-i', inputPath,
        '-vf', filterChain,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p',
        outputPath
      ];
      const child = spawnChild(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString().slice(-500); });
      const timer = setTimeout(() => {
        console.warn(`[Pipeline] Scene ${sceneIndex}: transform clip ${clipIndex} TIMEOUT after ${TRANSFORM_TIMEOUT_MS/1000}s — killing FFmpeg`);
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(
          pipelineError(
            PIPELINE_ERROR.TIMEOUT,
            `Transform timeout scene ${sceneIndex} clip ${clipIndex}`
          )
        );
      }, TRANSFORM_TIMEOUT_MS);
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(pipelineError(PIPELINE_ERROR.FFMPEG, `FFmpeg exit ${code}: ${stderr.slice(-200)}`));
      });
      child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5_000) {
      if (await isValidVideoFile(outputPath)) {
        try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
        console.log(`[Pipeline] Scene ${sceneIndex}: clip ${clipIndex} transformed for fair use`);
        return outputPath;
      }
      console.warn(`[Pipeline] Scene ${sceneIndex}: transformed clip ${clipIndex} unreadable`);
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: fair-use transform failed for clip ${clipIndex}:`, (err as Error).message);
  }
  if (strict) return "";
  return inputPath;
}

/** Extract a person name from prompts/titles like "Rumors about Kylie Jenner". */
function extractPrimaryPersonFromText(text?: string): string {
  if (!text?.trim()) return "";
  const cleaned = text.replace(/[^\w\s:'-]/g, " ").replace(/\s+/g, " ").trim();
  const aboutMatch = cleaned.match(/\babout\s+([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+){0,2})/i);
  if (aboutMatch?.[1]) return aboutMatch[1].trim();
  const kylieMatch = cleaned.match(/\b(kylie\s+jenner)\b/i);
  if (kylieMatch?.[1]) return "Kylie Jenner";
  const nameMatches = cleaned.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g) ?? [];
  const skip = new Set(["deep dive", "the story", "a deep", "full story", "rumors about"]);
  for (const candidate of nameMatches) {
    if (!skip.has(candidate.toLowerCase())) return candidate.trim();
  }
  return "";
}

function extractPrimaryPersonFromTitle(title?: string): string {
  return extractPrimaryPersonFromText(title);
}

function isPersonCelebrityTopic(topicContext?: string): boolean {
  const t = (topicContext ?? "").toLowerCase();
  if (/\bkylie\b|\bjenner\b|\bkardashian\b/.test(t)) return true;
  return Boolean(extractPrimaryPersonFromText(topicContext));
}

function buildPersonMediaQueries(person: string, visualCue?: string): string[] {
  const cue = visualCue?.split(/\s+/).slice(0, 3).join(" ") ?? "";
  return [
    person,
    `${person} interview`,
    `${person} speech`,
    `${person} news conference`,
    `${person} red carpet`,
    cue ? `${person} ${cue}` : `${person} documentary`,
  ].filter((q, i, arr) => q.trim().length > 0 && arr.indexOf(q) === i);
}

interface CelebrityClipCandidate {
  path: string;
  query: string;
}

/** True when haystack contains the celebrity name (last name or full name). */
function textMentionsPersonName(haystack: string, personName: string): boolean {
  const hay = haystack.toLowerCase();
  const parts = personName.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
  if (!parts.length) return false;
  if (parts.length === 1) return hay.includes(parts[0]);
  const last = parts[parts.length - 1];
  if (hay.includes(last)) return true;
  return parts.every((p) => hay.includes(p));
}

/** Beat + person tokens for filtering celebrity search hits. */
function buildPersonBeatRelevanceKeywords(personName: string, beatText: string): string[] {
  const clean = beatText.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  return [
    ...personName.split(/\s+/).filter((p) => p.length >= 3),
    ...tokenizeForRelevance(clean),
    ...extractInlineVisualCues(clean).flatMap((c) => tokenizeForRelevance(c)),
  ].filter((k, i, arr) => arr.indexOf(k) === i).slice(0, 18);
}

/**
 * Script-aware celebrity video queries: events + visual cues + person variants.
 * Rotated per beat so each narration line gets a different search angle.
 */
function buildPersonCelebrityVideoQueries(
  personName: string,
  beatText: string,
  beatIndex: number
): string[] {
  const clean = beatText.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  const persons = [personName];
  const eventQs = scriptEventSearchQueries(clean, persons);
  const visualCues = extractInlineVisualCues(clean);
  const beatTokens = tokenizeForRelevance(clean).filter((t) => t.length >= 4).slice(0, 3);
  const mediaQs = buildPersonMediaQueries(personName, visualCues[0] || beatTokens.join(" "));

  const combined = [
    ...eventQs,
    ...visualCues.map((c) => `${personName} ${c}`.trim()),
    ...beatTokens.map((t) => `${personName} ${t}`),
    ...mediaQs,
  ].filter((q) => q.trim().length > 3 && !isBlockedStockQuery(q));

  const unique = [...new Set(combined)];
  const offset = beatIndex % Math.max(1, unique.length);
  return [...unique.slice(offset), ...unique.slice(0, offset)].slice(0, 7);
}

function scoreCelebrityCandidate(
  candidate: CelebrityClipCandidate,
  beatText: string,
  personName: string,
  keywords: string[]
): number {
  const hay = `${candidate.query} ${path.basename(candidate.path)} ${beatText}`.toLowerCase();
  return (
    scoreBeatNarrationMatch(beatText, candidate.query, candidate.path) * 4 +
    scoreVisualRelevance(hay, keywords) +
    (textMentionsPersonName(hay, personName) ? 4 : 0)
  );
}

async function adoptBestCelebrityClip(
  candidates: CelebrityClipCandidate[],
  dedup: VisualDedupState,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  workDir: string,
  personName: string,
  opts: VisualAdoptOptions
): Promise<string | null> {
  if (!candidates.length) return null;
  const keywords = opts.keywords ?? buildPersonBeatRelevanceKeywords(personName, beatText);
  const sorted = [...candidates].sort(
    (a, b) =>
      scoreCelebrityCandidate(b, beatText, personName, keywords) -
      scoreCelebrityCandidate(a, beatText, personName, keywords)
  );
  for (const c of sorted) {
    const clip = await adoptClip(
      [c.path],
      dedup,
      sceneIndex,
      beatIndex,
      beatText,
      workDir,
      c.query,
      opts
    );
    if (clip) return clip;
  }
  return null;
}

/** Script-aware Serp queries — event from narration first, then rotated portrait variants. */
function buildPersonSerpQuery(
  person: string,
  sceneIndex: number,
  beatIndex: number,
  beatText = ""
): string {
  const scriptQs = beatText
    ? scriptEventSearchQueries(beatText, [person]).map((q) =>
        /\b(face|portrait|interview|talking)\b/i.test(q) ? q : `${q} face interview`
      )
    : [];
  if (scriptQs.length) {
    return scriptQs[(sceneIndex + beatIndex) % scriptQs.length];
  }
  const variants = [
    `${person} face portrait close up`,
    `${person} interview talking head`,
    `${person} red carpet full body`,
    `${person} met gala dress`,
    `${person} makeup brand launch`,
    `${person} paparazzi event`,
  ];
  return variants[(sceneIndex * 5 + beatIndex) % variants.length];
}

/** Script-anchored image queries: person → event → power word → topic. */
function buildBeatImageSearchQueries(
  beat: SceneBeat,
  scene: Scene,
  videoTitle: string | undefined,
  scenePersons: string[]
): string[] {
  const primary = scenePersons[0]?.trim() ?? "";
  const out: string[] = [];
  if (primary) {
    out.push(buildPersonSerpQuery(primary, scene.index, beat.index, beat.text));
    out.push(`${primary} face portrait photo`);
    for (const eq of scriptEventSearchQueries(beat.text, scenePersons).slice(0, 3)) {
      out.push(eq);
    }
  }
  const power = beat.powerWord?.trim();
  if (power && power.length >= 3 && !isBlockedStockQuery(power)) {
    out.push(primary ? `${primary} ${power}` : power);
  }
  for (const cue of extractInlineVisualCues(beat.text).slice(0, 2)) {
    out.push(primary ? `${primary} ${cue}` : cue);
  }
  const scriptQ = stockQueryFromBeatScript(beat.text, scenePersons, scene.text, videoTitle);
  if (scriptQ) out.push(scriptQ);
  for (const q of [beat.searchQuery, scene.visualCue, scene.pexelsQuery]) {
    if (q?.trim()) out.push(q.trim());
  }
  return [...new Set(out.filter((q) => q.length >= 3 && !isBlockedStockQuery(q)))].slice(0, 6);
}

/**
 * Fast still fallback: Serp → Openverse → Wikimedia → YouTube thumb.
 * Used when video search is slow or empty — person, event, or topic image is fine.
 */
async function fetchBeatScriptImageClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  scenePersons: string[],
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  tag: string
): Promise<string | null> {
  const forced = Boolean(adoptOpts.scriptImageFallback);
  if (!forced && !canUseGlobalStillPhoto(dedup)) return null;
  if (!forced) {
    const sceneStillOk =
      dedup.stillPhotosMaxThisScene === 0 ||
      dedup.stillPhotosThisScene < dedup.stillPhotosMaxThisScene;
    if (!sceneStillOk) return null;
  }

  const primary = scenePersons[0] ?? adoptOpts.primaryPerson ?? "";
  const portrait = Boolean(primary) || dedup.personTopicLock;
  const looseOpts: VisualAdoptOptions = {
    ...adoptOpts,
    requireBeatMatch: false,
    scriptAnchored: false,
    scriptImageFallback: true,
    personTopic: portrait,
    primaryPerson: primary || adoptOpts.primaryPerson,
  };
  const queries = buildBeatImageSearchQueries(beat, scene, videoTitle, scenePersons);

  return withTimeout(
    (async () => {
      if (SERPAPI_KEY) {
        for (let qi = 0; qi < Math.min(queries.length, 3); qi++) {
          const q = queries[qi];
          const paths = await fetchSerpAPIImages(
            q,
            clipFetchDur,
            workDir,
            sceneIndex,
            1,
            `${tag}_img_serp`,
            {
              dedup,
              personPortrait: portrait,
              resultOffset: sceneIndex * 3 + beat.index + qi,
            }
          );
          const clip = await adoptClip(
            paths, dedup, sceneIndex, beat.index, beat.text, workDir, q, looseOpts
          );
          if (clip) {
            console.log(
              `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: script image Serp (${q})`
            );
            return clip;
          }
        }
      }
      for (const q of queries.slice(0, 2)) {
        const ovPaths = await fetchOpenverseImages(
          q,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          `${tag}_img_ov`,
          { dedup, personPortrait: portrait }
        );
        const clip = await adoptClip(
          ovPaths, dedup, sceneIndex, beat.index, beat.text, workDir, q, looseOpts
        );
        if (clip) {
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: script image Openverse (${q})`
          );
          return clip;
        }
      }
      if (primary) {
        const wikiPaths = await fetchWikimediaImages(
          primary, clipFetchDur, workDir, sceneIndex, 1, `${tag}_img_wiki`
        );
        const clip = await adoptClip(
          wikiPaths, dedup, sceneIndex, beat.index, beat.text, workDir, primary, looseOpts
        );
        if (clip) {
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: script image Wikimedia (${primary})`
          );
          return clip;
        }
      }
      if (process.env.YOUTUBE_API_KEY) {
        const thumbQ = queries[0] ?? beat.searchQuery;
        const ytPaths = await fetchYouTubeThumbnails(
          thumbQ, clipFetchDur, workDir, sceneIndex, 1, `${tag}_img_yt`
        );
        const clip = await adoptClip(
          ytPaths, dedup, sceneIndex, beat.index, beat.text, workDir, thumbQ, looseOpts
        );
        if (clip) {
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: script image YouTube thumb (${thumbQ})`
          );
          return clip;
        }
      }
      return null;
    })(),
    beatScriptImageWallMs(dedup.perf),
    `script image s${sceneIndex} b${beat.index}`
  ).catch((err) => {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: script image skipped:`,
      (err as Error).message
    );
    return null;
  });
}

/** Last-resort: accept first valid Serp/Wikimedia/YouTube-thumb still (no strict adopt gates). */
async function fetchBeatScriptImageForced(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  scenePersons: string[],
  videoTitle: string | undefined,
  tag: string
): Promise<string | null> {
  const primary = scenePersons[0] ?? dedup.primaryPerson ?? "";
  const portrait = Boolean(primary) || dedup.personTopicLock;
  const queries = buildBeatImageSearchQueries(beat, scene, videoTitle, scenePersons);

  const takeFirstValid = async (paths: string[]): Promise<string | null> =>
    withVisualDedupLock(dedup, async () => {
      for (const p of paths) {
        if (!p || dedup.usedPaths.has(p) || !fs.existsSync(p)) continue;
        if (!(await isValidVideoFile(p))) continue;
        if (isPipelineFallbackClip(p)) continue;
        if (await isMostlyBlackClip(p)) continue;
        dedup.usedPaths.add(p);
        if (isStillPhotoClip(p)) {
          dedup.stillPhotosThisScene++;
          if (canUseGlobalStillPhoto(dedup)) markGlobalStillPhotoUsed(dedup);
        }
        return p;
      }
      return null;
    });

  return withTimeout(
    (async () => {
      if (SERPAPI_KEY) {
        for (let qi = 0; qi < Math.min(queries.length, 5); qi++) {
          const q = queries[qi];
          const paths = await fetchSerpAPIImages(
            q,
            clipFetchDur,
            workDir,
            sceneIndex,
            1,
            `${tag}_force_serp`,
            {
              dedup,
              personPortrait: portrait,
              resultOffset: sceneIndex * 5 + beat.index + qi,
            }
          );
          const clip = await takeFirstValid(paths);
          if (clip) {
            console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: forced image Serp (${q})`);
            return clip;
          }
        }
      }
      if (primary) {
        const wikiPaths = await fetchWikimediaImages(
          primary, clipFetchDur, workDir, sceneIndex, 1, `${tag}_force_wiki`
        );
        const clip = await takeFirstValid(wikiPaths);
        if (clip) {
          console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: forced image Wikimedia (${primary})`);
          return clip;
        }
      }
      for (const q of queries.slice(0, 4)) {
        const wikiPaths = await fetchWikimediaImages(
          q, clipFetchDur, workDir, sceneIndex, 1, `${tag}_force_wiki`
        );
        const wikiClip = await takeFirstValid(wikiPaths);
        if (wikiClip) {
          console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: forced image Wikimedia (${q})`);
          return wikiClip;
        }
        if (UNSPLASH_ACCESS_KEY?.trim()) {
          const unsplashPaths = await fetchUnsplashImages(
            q, clipFetchDur, workDir, sceneIndex, 1, `${tag}_force_unsplash`, { dedup }
          );
          const unsplashClip = await takeFirstValid(unsplashPaths);
          if (unsplashClip) {
            console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: forced image Unsplash (${q})`);
            return unsplashClip;
          }
        }
      }
      if (process.env.YOUTUBE_API_KEY) {
        const thumbQ = queries[0] ?? beat.searchQuery;
        const ytPaths = await fetchYouTubeThumbnails(
          thumbQ, clipFetchDur, workDir, sceneIndex, 1, `${tag}_force_yt`
        );
        const clip = await takeFirstValid(ytPaths);
        if (clip) {
          console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: forced image YouTube thumb (${thumbQ})`);
          return clip;
        }
      }
      return null;
    })(),
    beatScriptImageWallMs(dedup.perf) + 5_000,
    `forced image s${sceneIndex} b${beat.index}`
  ).catch(() => null);
}

/** Still-photo clips (Ken Burns from images) — cap these per scene; prefer real stock video. */
function isStillPhotoClip(filePath: string): boolean {
  if (isStockVideoClip(filePath)) return false;
  const base = path.basename(filePath);
  // AI / generated motion clips count as video, not stills
  if (/_ai\.mp4$|_runway_|_kling_|_luma_|_pika_|_veo_|_grok_|_forge_/i.test(base)) return false;
  return /_serp_|_wiki_|_openverse_|_unsplash_|_p0_|_p2_|_yt_\d/i.test(base);
}

/** AI-generated clip path (used only as last-resort after stock search). */
function isAIGeneratedClip(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return /_ai_fallback\.mp4$|_stability_|_leonardo_|_grok_|_ai\.mp4|_runway_|_kling_|_luma_|_pika_|_veo_|_forge_|scene_\d+_b\d+_ai/i.test(base);
}

/** Map temp clip filename → editor manifest source (pexels, youtube, serpapi, …). */
function inferClipSourceFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/_transformed(?=\.mp4)$/i, "").toLowerCase();
  if (/_ytfu_|_ytcc_|_b\d+_yt_|_yt_\d/i.test(base)) return "youtube";
  if (
    /pexels|_pex_|lr_pex|_b\d+_fast|_fast_vid|_b\d+_script|_script_vid|_golden|_b\d+_lr_pex|scene_\d+_b\d+_vid\d+|person_stock/i.test(
      base
    )
  ) {
    return "pexels";
  }
  if (/serp/i.test(base)) return "serpapi";
  if (/wikivid|_wiki_/i.test(base)) return "wikimedia";
  if (/septube/i.test(base)) return "peertube";
  if (/gdelt/i.test(base)) return "gdelt";
  if (/euro_/i.test(base)) return "europeana";
  if (/vimeo/i.test(base)) return "vimeo";
  if (/openverse/i.test(base)) return "openverse";
  if (/nasa/i.test(base)) return "nasa";
  if (/archive|curated/i.test(base)) return "archive";
  if (/pixabay|_pix_|beat_vid|fb_vid/i.test(base)) return "pixabay";
  if (
    /_ai_fallback|_stability_|_leonardo_|_grok_|_runway_|_kling_|_luma_|_pika_|_veo_|_forge_|scene_\d+_b\d+_ai/i.test(
      base
    )
  ) {
    return "ai";
  }
  if (/_fallback/i.test(base)) return "fallback";
  if (/broll_vid/i.test(base)) return "broll";
  return "unknown";
}

function buildBeatAIPrompt(beat: SceneBeat, scene: Scene, videoTitle?: string): string {
  const muskTopic = isMuskTeslaTopic(videoTitle, beat.text);
  const entities = extractBeatRealEntities(beat.text, scene.text, videoTitle);
  const entityLabel = entities.map((r) => r.id).join(", ");
  const visual =
    beat.powerWord ||
    extractInlineVisualCues(beat.text)[0] ||
    beat.searchQuery ||
    realEntityStockQueriesForBeat(beat.text, scene.text, videoTitle)[0] ||
    deriveBeatStockQuery(beat.text, scene, videoTitle, undefined, muskTopic) ||
    scene.literalVisualCue ||
    scene.visualCue ||
    scene.pexelsQuery;
  const narration = beat.text.replace(/\[visual:[^\]]+\]/gi, "").trim().slice(0, 220);
  return (
    `Cinematic documentary still, photorealistic 16:9, subject: ${visual}. ` +
    `Matches this spoken line: ${narration}. ` +
    `Real-world ${entityLabel || "news"} context, sharp focus, natural lighting, no text or watermark.`
  ).slice(0, 500);
}

/** AI clip only when stock could not match this beat (prompt = narration + visual cue). */
async function fetchBeatAIClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  videoTitle?: string
): Promise<string | null> {
  const { perf } = dedup;
  if (!perf.enableAiFallback || dedup.aiClipsUsed >= perf.maxAiClipsPerVideo) return null;
  if (!aiProvidersReady()) return null;

  const prompt = buildBeatAIPrompt(beat, scene, videoTitle);
  const outPath = path.join(workDir, `scene_${sceneIndex}_b${beatIndex}_ai_fallback.mp4`);
  const dur = Math.min(Math.max(clipFetchDur, 3), perf.fastStockMode ? 5 : 8);

  let generated: string | null = null;
  // Cheap tier: photoreal still → Ken Burns (~$0.03/beat, broadcast look)
  if (STABILITY_AI_API_KEY) {
    generated = await generateStabilityAIClip(prompt, dur, outPath, sceneIndex);
  }
  if (!generated && LEONARDO_API_KEY) {
    generated = await generateLeonardoAIClip(prompt, dur, outPath, sceneIndex);
  }
  // Premium tier only (Runway/Grok ~$0.25+ per clip) — ENABLE_AI_VIDEO_FALLBACK=true
  if (!generated && premiumAiVideoFallbackEnabled()) {
    if (REPLICATE_API_KEY) {
      generated = await generateGrokVideoClip(prompt, dur, outPath, sceneIndex);
    }
    if (!generated && GOOGLE_GEMINI_API_KEY) {
      generated = await generateVeoVideoClip(prompt, dur, outPath, sceneIndex);
    }
    if (!generated && RUNWAY_API_KEY) {
      generated = await generateRunwayClip(prompt, null, dur, outPath, sceneIndex);
    }
  }
  if (!generated || !(await isValidVideoFile(generated)) || (await isMostlyBlackClip(generated))) {
    return null;
  }

  return withVisualDedupLock(dedup, async () => {
    const contentKey = clipContentKey(generated!);
    if (dedup.usedContentKeys.has(contentKey)) return null;
    dedup.usedPaths.add(generated!);
    dedup.usedContentKeys.add(contentKey);
    dedup.aiClipsUsed++;
    console.log(
      `[Pipeline] Scene ${sceneIndex} beat ${beatIndex}: AI fallback ${dedup.aiClipsUsed}/${perf.maxAiClipsPerVideo} — "${prompt.slice(0, 90)}..."`
    );
    return generated;
  });
}

function extractInlineVisualCues(text: string): string[] {
  return [...text.matchAll(/\[visual:\s*([^\]]+)\]/gi)]
    .map((m) => m[1].trim())
    .filter((v) => v.length > 3 && !isBlockedStockQuery(v));
}

function scoreBeatNarrationMatch(beatText: string, sourceQuery: string, filePath: string): number {
  const tokens = tokenizeForRelevance(beatText).filter((t) => t.length >= 3);
  const hay = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  return scoreVisualRelevance(hay, tokens);
}

/** Map one script token → English Pexels keyword (no scene/title context). */
function translateTokenForPexels(token: string): string | null {
  const t = token.toLowerCase();
  if (RELEVANCE_STOP_WORDS.has(t) || t.length < 3) return null;
  if (DUTCH_STOCK_WORD_MAP[t]) return DUTCH_STOCK_WORD_MAP[t];
  for (const [re, word] of STOCK_TOPIC_WORD_RULES) {
    if (re.test(`\\b${t}\\b`) || re.test(t)) return word;
  }
  return t;
}

/**
 * Stock search terms from beat narration: persons → events → entities.
 * Skips generic wildlife/animal tokens when a named person is in scope.
 */
function scriptStockSearchQueries(
  beatText: string,
  persons: string[] = [],
  sceneText = "",
  videoTitle?: string
): string[] {
  const narration = beatText.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  const out: string[] = [];
  const hasPerson = persons.length > 0;
  const anchorPerson = hasPerson;

  for (const person of persons) {
    out.push(person);
    const first = person.split(/\s+/)[0]?.trim().toLowerCase();
    if (first && first.length >= 3) out.push(first);
    out.push(`${person} interview`, `${person} celebrity`);
    if (beatMentionsPerson(beatText, person) || beatMentionsPerson(sceneText, person)) {
      out.push(`${person} red carpet`, `${person} news`);
    }
  }

  for (const ev of scriptEventSearchQueries(beatText, persons)) out.push(ev);

  for (const cue of extractInlineVisualCues(beatText)) {
    if (anchorPerson && PERSON_OFFTOPIC_VISUAL_RE.test(cue)) continue;
    const sq = simplifyStockSearchWord(cue, cue, true);
    if (anchorPerson && (PERSON_OFFTOPIC_VISUAL_RE.test(sq) || isGenericNatureStockWord(sq))) continue;
    out.push(sq);
  }

  for (const q of realEntityStockQueriesForBeat(beatText, sceneText, videoTitle)) {
    if (q) out.push(q);
  }

  if (!anchorPerson) {
    const beatTokens = tokenizeForRelevance(narration);
    const ranked = [...beatTokens].sort((a, b) => b.length - a.length);
    for (const tok of ranked) {
      const w = translateTokenForPexels(tok);
      if (!w || isBlockedStockQuery(w) || isGenericNatureStockWord(w)) continue;
      out.push(w);
    }
    if (out.length === 0 && narration.length > 0) {
      const fallback = simplifyStockSearchWord(narration, narration, true);
      if (!isGenericNatureStockWord(fallback)) out.push(fallback);
    }
  }

  return [...new Set(out.filter((q) => q && q.length >= 3 && !isBlockedStockQuery(q)))].slice(0, 8);
}

function isGenericNatureStockWord(word: string): boolean {
  return PERSON_OFFTOPIC_VISUAL_RE.test(word) ||
    /^(wildlife|ocean|bird|forest|zoo|animal|fish|beach|sunset|nature|flower|garden)$/i.test(word.trim());
}

function stockQueryFromBeatScript(
  beatText: string,
  persons: string[] = [],
  sceneText = "",
  videoTitle?: string
): string {
  return scriptStockSearchQueries(beatText, persons, sceneText, videoTitle)[0] ?? "documentary";
}

function isStockVideoClip(filePath: string): boolean {
  return /_pexels_|_pex_|_pixabay_|_pix_|_broll_|_ytcc_|_archive_|_wikivid_|_nasa_|_esa_|_b\d+_(pex|pix)/i.test(
    path.basename(filePath)
  );
}

/** Licensed Pexels/Pixabay/b-roll — not authentic archival footage. */
function isLicensedStockClip(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return /pexels|_pex_|pixabay|_pix_|broll_vid|_golden|_fast_vid|_lr_pex|scene_\d+_b\d+_vid\d+/i.test(
    base
  );
}

/** Real downloaded video that is not a Ken Burns still or licensed stock clip. */
function isAuthenticVideoClip(filePath: string): boolean {
  return isRealVideoClip(filePath) && !isLicensedStockClip(filePath);
}

function maxStillPhotosGlobal(dedup: VisualDedupState): number {
  if (dedup.perf.fastStockMode) return 16;
  if (dedup.personTopicLock) return Math.max(10, dedup.perf.maxBeatsPerScene * 3);
  if (minimizeStockFootageEnabled()) return 6;
  return 4;
}

function canUseGlobalStillPhoto(dedup: VisualDedupState): boolean {
  return dedup.stillPhotosUsedGlobal < maxStillPhotosGlobal(dedup);
}

function markGlobalStillPhotoUsed(dedup: VisualDedupState): void {
  dedup.stillPhotosUsedGlobal++;
}

function maxStillPhotosForScene(_sceneIndex: number, hasPerson: boolean, personTopicLock = false): number {
  if (personTopicLock) return 4;
  if (minimizeStockFootageEnabled()) return hasPerson ? 3 : 2;
  return hasPerson ? 3 : 2;
}

function beatMentionsPerson(beatText: string, personName: string): boolean {
  if (!personName.trim()) return false;
  const lower = beatText.toLowerCase();
  const parts = personName.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
  if (parts.length >= 2) {
    if (parts.every((p) => lower.includes(p))) return true;
    return lower.includes(parts[0]);
  }
  return parts.length === 1 && lower.includes(parts[0]);
}

const PERSON_NAME_SKIP_PHRASES = new Set([
  "deep dive", "breaking news", "the truth", "red carpet", "social media", "united states",
  "new york", "los angeles", "full story", "no comment", "under the", "life under",
  "decoding the", "rumors about", "facts fiction", "exclusive interview",
]);

/** Capitalized names from narration (Kylie Jenner, Elon Musk, …). */
function extractPersonNamesFromText(text: string): string[] {
  if (!text?.trim()) return [];
  const found = new Set<string>();
  const fullNames = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g) ?? [];
  for (const name of fullNames) {
    const n = name.trim();
    if (n.length < 5 || PERSON_NAME_SKIP_PHRASES.has(n.toLowerCase())) continue;
    found.add(n);
  }
  const kylie = text.match(/\b(kylie\s+jenner)\b/i);
  if (kylie?.[1]) found.add("Kylie Jenner");
  const musk = text.match(/\b(elon\s+musk)\b/i);
  if (musk?.[1]) found.add("Elon Musk");
  return Array.from(found);
}

/** Real-world events spoken on this beat → stock/YouTube search phrases. */
function scriptEventSearchQueries(beatText: string, persons: string[]): string[] {
  const t = beatText.toLowerCase();
  const primary = persons[0] ?? "";
  const p = (suffix: string) => (primary ? `${primary} ${suffix}`.trim() : suffix);
  const out: string[] = [];

  if (/\b(interview|interviews|spoke with|talked to)\b/.test(t)) out.push(p("interview"));
  if (/\b(keynote|speech|presentation|address)\b/.test(t)) out.push(p("keynote speech"));
  if (/\b(red carpet|premiere|gala|awards?)\b/.test(t)) out.push(p("red carpet"));
  if (/\b(launch|unveil|unveiled|announcement|revealed|debut)\b/.test(t)) out.push(p("product launch"));
  if (/\b(trial|court|lawsuit|verdict|sentencing)\b/.test(t)) out.push(p("court trial"));
  if (/\b(wedding|married|engagement|divorce)\b/.test(t)) out.push(p("wedding"));
  if (/\b(protest|demonstration|rally)\b/.test(t)) out.push(p("protest"));
  if (/\b(concert|performance|tour)\b/.test(t)) out.push(p("concert"));
  if (/\b(scandal|controversy|backlash)\b/.test(t)) out.push(p("news conference"));
  if (/\b(billion|million|\$\d|deal|acquisition|ipo)\b/.test(t)) out.push(p("business news"));
  if (/\b(rocket launch|falcon|starship|spacex)\b/.test(t)) {
    out.push("SpaceX rocket launch");
  }
  if (/\b(tesla|cybertruck|gigafactory)\b/.test(t)) {
    out.push(/\btesla\b/.test(t) ? "Tesla event" : "Tesla factory");
  }

  return [...new Set(out.filter((q) => q.length >= 3 && !isBlockedStockQuery(q)))];
}

function resolveScenePersons(scene: Scene, videoTitle?: string, globalPrimaryPerson?: string): string[] {
  const persons = new Set((scene.personNames ?? []).map((n) => n.trim()).filter(Boolean));
  for (const n of extractPersonNamesFromText(scene.text)) persons.add(n);
  const titlePerson = globalPrimaryPerson?.trim() || extractPrimaryPersonFromTitle(videoTitle);
  if (titlePerson) persons.add(titlePerson);
  return Array.from(persons);
}

/**
 * Eén kernwoord per zin: persoon > event > sterkste inhoudswoord (uit narratie).
 * Primair zoekanker per beat — geen [VISUAL:] tags in script.
 */
function extractPowerWordFromSentence(sentence: string, persons: string[] = []): string {
  const clean = sentence.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  if (!clean) return "documentary";

  for (const person of persons) {
    if (beatMentionsPerson(clean, person)) {
      const first = person.split(/\s+/)[0]?.trim();
      return first && first.length >= 3 ? first : person;
    }
  }

  const eventQs = scriptEventSearchQueries(clean, persons);
  if (eventQs[0]) {
    const ev = eventQs[0].split(/\s+/).slice(-2).join(" ").trim() || eventQs[0];
    if (ev.length >= 3) return ev;
  }

  const tokens = tokenizeForRelevance(clean);
  const scoreToken = (w: string): number => {
    if (DUTCH_STOCK_WORD_MAP[w]) return 120;
    for (const [re] of STOCK_TOPIC_WORD_RULES) {
      if (re.test(`\\b${w}\\b`) || re.test(w)) return 90;
    }
    return w.length;
  };
  const ranked = [...tokens].sort((a, b) => scoreToken(b) - scoreToken(a));
  for (const tok of ranked) {
    const w = translateTokenForPexels(tok);
    if (w && !isBlockedStockQuery(w) && !isGenericNatureStockWord(w)) return w;
  }

  const longest = tokens.sort((a, b) => b.length - a.length)[0];
  if (longest && longest.length >= 4) {
    const w = translateTokenForPexels(longest);
    if (w) return w;
  }

  return stockQueryFromBeatScript(clean, persons, "", undefined);
}

/** Ordered queries for one beat — power word, persons, events, entities (from narration). */
function buildBeatVisualQueryList(
  beatText: string,
  scene: Scene,
  videoTitle: string | undefined,
  scenePersons: string[],
  maxQueries: number
): string[] {
  const beatPersons = [
    ...new Set([
      ...scenePersons,
      ...extractPersonNamesFromText(beatText),
      ...extractPersonNamesFromText(scene.text),
    ]),
  ];
  const power = extractPowerWordFromSentence(beatText, beatPersons);
  const powerQ = simplifyStockSearchWord(power, beatText, true);
  const scriptQueries = scriptStockSearchQueries(
    beatText, beatPersons, scene.text, videoTitle
  );
  const eventQueries = scriptEventSearchQueries(beatText, beatPersons);
  const entityStock = realEntityStockQueriesForBeat(beatText, scene.text, videoTitle);

  const ordered = [
    powerQ,
    ...scriptQueries,
    ...eventQueries,
    ...entityStock,
  ].filter((q) => typeof q === "string" && q.trim().length > 2 && !isBlockedStockQuery(q));

  return [...new Set(ordered)].slice(0, maxQueries);
}

// ─── Beat-level visual matching (narration ↔ footage alignment) ───────────────
const RELEVANCE_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its", "we", "they", "he", "she",
  "you", "i", "my", "our", "their", "his", "her", "your", "as", "so", "if", "not", "no", "up", "out",
  "about", "into", "than", "then", "when", "where", "who", "which", "what", "how", "all", "each", "more",
  "most", "also", "just", "very", "over", "after", "before", "through", "during", "between", "while",
  "because", "since", "even", "only", "still", "now", "here", "there", "some", "any", "every", "one",
  "two", "three", "first", "second", "third", "new", "like", "said", "says", "fact", "facts", "minute",
  "rumor", "rumors", "gossip", "exclusive", "breaking", "truth", "story", "decode", "decoding",
]);

interface SceneBeat {
  index: number;
  text: string;
  searchQuery: string;
  /** Kernwoord uit deze zin — primair zoekanker voor stock/YouTube. */
  powerWord: string;
  keywords: string[];
  /** Seconds this beat stays on screen (3–4 default, up to 7 when merged). */
  holdSec: number;
}

interface VisualDedupState {
  usedPaths: Set<string>;
  usedPexelsIds: Set<number>;
  usedPixabayIds: Set<number>;
  usedContentKeys: Set<string>;
  usedCategories: Map<string, number>;
  globalBeatIndex: number;
  muskHeroFetchUsed: boolean;
  /** Last adopted real stock clip (any topic) — reused instead of color/black placeholders. */
  lastMuskStockClip: string | null;
  aiClipsUsed: number;
  entityYoutubeFetchesUsed: number;
  /** Licensed Pexels/Pixabay clips used (capped when minimizeStockFootage). */
  stockBeatsUsed: number;
  /** Ken Burns / Serp stills allowed this scene (0 = video only). */
  stillPhotosThisScene: number;
  stillPhotosMaxThisScene: number;
  /** Whole-video cap on still-image clips (Serp/Openverse/Wikimedia stills). */
  stillPhotosUsedGlobal: number;
  /** Source image URLs already used (prevents same Google Image twice). */
  usedImageUrls: Set<string>;
  /** Curated admin archive asset IDs already used this video. */
  usedCuratedAssetIds: Set<number>;
  /** Storage URLs from curated archive — blocks same file twice even with different IDs. */
  usedCuratedStorageUrls: Set<string>;
  lock: Promise<void>;
  perf: PipelinePerfProfile;
  /** Named celebrity from user prompt (e.g. Kylie Jenner) — anchor every beat's stock search. */
  primaryPerson: string;
  personTopicLock: boolean;
}

/** One licensed stock clip allowed when minimizeStockFootage (whole-video cap). */
function canUseLicensedStockBeat(dedup: VisualDedupState): boolean {
  if (!dedup.perf.minimizeStockFootage) return true;
  return dedup.stockBeatsUsed < dedup.perf.maxStockBeatsPerVideo;
}

function markLicensedStockBeatUsed(dedup: VisualDedupState): void {
  if (dedup.perf.minimizeStockFootage) dedup.stockBeatsUsed++;
}

function createVisualDedupState(
  perf: PipelinePerfProfile,
  topic?: { primaryPerson?: string; personTopicLock?: boolean }
): VisualDedupState {
  return {
    usedPaths: new Set(),
    usedPexelsIds: new Set(),
    usedPixabayIds: new Set(),
    usedContentKeys: new Set(),
    usedCategories: new Map(),
    globalBeatIndex: 0,
    muskHeroFetchUsed: false,
    lastMuskStockClip: null,
    aiClipsUsed: 0,
    entityYoutubeFetchesUsed: 0,
    stockBeatsUsed: 0,
    stillPhotosThisScene: 0,
    stillPhotosMaxThisScene: 0,
    stillPhotosUsedGlobal: 0,
    usedImageUrls: new Set(),
    usedCuratedAssetIds: new Set(),
    usedCuratedStorageUrls: new Set(),
    lock: Promise.resolve(),
    perf,
    primaryPerson: topic?.primaryPerson?.trim() ?? "",
    personTopicLock: Boolean(topic?.personTopicLock && topic?.primaryPerson?.trim()),
  };
}

const STOCK_CATEGORY_LIMITS: Record<string, number> = {
  gigafactory: 1,
  solar: 1,
  rocket: 2,
  tesla: 3,
  factory: 2,
  robot: 2,
  space: 1,
  generic: 4,
};

/** High-quality rotating queries for Musk/Tesla/SpaceX — modern real-world B-roll only. */
/** Brand-forward hero searches — recognizable Tesla/SpaceX (not generic factory). */
const HERO_MUSK_QUERIES = ["tesla", "spacex", "rocket", "factory", "car", "cybertruck"];

const HERO_YOUTUBE_QUERIES = [
  "SpaceX Falcon 9 rocket launch",
  "SpaceX Starship launch test flight",
  "Tesla Gigafactory tour",
  "Falcon 9 landing booster drone ship",
];

const GOLDEN_MUSK_QUERIES = [...HERO_MUSK_QUERIES, "solar", "battery", "satellite", "moon"];

type VisualAdoptOptions = {
  muskTopic?: boolean;
  personTopic?: boolean;
  primaryPerson?: string;
  keywords?: string[];
  sceneText?: string;
  videoTitle?: string;
  /** Hero/opening: require Tesla/SpaceX tokens in slug or query. */
  requireMuskBrand?: boolean;
  /** Clip must match words in the beat narration (real footage on-topic). */
  requireBeatMatch?: boolean;
  /** Vidrush literal matching: reject clips with zero narration overlap. */
  scriptAnchored?: boolean;
  /** Script-matched still fallback — trust search query, skip strict entity/person gates. */
  scriptImageFallback?: boolean;
};

async function withVisualDedupLock<T>(dedup: VisualDedupState, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = dedup.lock;
  dedup.lock = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

const BLOCKED_STOCK_TAGS_RE =
  /emoji|cartoon|animation|icon|illustration|graphic|pattern|sticker|clipart|motion graphics|3d render|abstract background|wallpaper|seamless loop|looping|campfire|bonfire|fireplace|bbq|barbecue|driving|dashcam|highway|bridge|miniature|scale model|toy|diorama|tabletop|model rocket|shuttle|saturn|apollo|lunar|moon landing|moon surface|science fiction|sci-fi|vhs|glitch|vintage space|archival|textile|weaving|loom|garment factory|fabric mill|crime scene|forensic|police tape|news reporter|journalist|reporter microphone|hazmat suit|investigation|murder|courtroom/i;

const MUSK_TOPIC_TOKENS = ["tesla", "spacex", "musk", "electric", "ev", "battery", "gigafactory", "falcon", "starship", "cybertruck", "automotive", "rocket", "launch"];

/** When narration names a real company/product, clip slug/query must show that same entity (real-world footage). */
type RealEntityRule = {
  id: string;
  mentionRe: RegExp;
  clipMustMatchRe: RegExp;
  stockQueries: string[];
  youtubeQueries: string[];
};

const REAL_ENTITY_RULES: RealEntityRule[] = [
  {
    id: "kylie",
    mentionRe: /\b(kylie\s+jenner|kylie\b|jenner\b)/i,
    clipMustMatchRe: /\b(kylie|jenner|kardashian|celebrity|influencer|makeup|fashion)\b/i,
    stockQueries: ["kylie", "celebrity", "fashion"],
    youtubeQueries: [
      "Kylie Jenner interview",
      "Kylie Jenner red carpet",
      "Kylie Jenner makeup launch",
    ],
  },
  {
    id: "musk",
    mentionRe: /\b(elon\s+musk|musk)\b/i,
    clipMustMatchRe: /\b(musk|elon|tesla|spacex)\b/i,
    stockQueries: ["tesla", "spacex"],
    youtubeQueries: [
      "Elon Musk interview",
      "Elon Musk Tesla keynote",
      "Elon Musk SpaceX presentation",
    ],
  },
  {
    id: "tesla",
    mentionRe: /\btesla\b/i,
    clipMustMatchRe: /\btesla\b/i,
    stockQueries: ["tesla"],
    youtubeQueries: ["Tesla Gigafactory tour", "Tesla Model 3 production line", "Tesla Cybertruck unveiling"],
  },
  {
    id: "spacex",
    mentionRe: /\bspacex\b/i,
    clipMustMatchRe: /\b(spacex|falcon|starship)\b/i,
    stockQueries: ["spacex", "rocket"],
    youtubeQueries: ["SpaceX Falcon 9 rocket launch", "SpaceX Starship launch test flight", "Falcon 9 landing booster"],
  },
  {
    id: "falcon9",
    mentionRe: /\bfalcon\s*9\b/i,
    clipMustMatchRe: /\b(falcon|spacex)\b/i,
    stockQueries: ["rocket", "spacex"],
    youtubeQueries: ["SpaceX Falcon 9 rocket launch", "Falcon 9 landing booster drone ship"],
  },
  {
    id: "starship",
    mentionRe: /\bstarship\b/i,
    clipMustMatchRe: /\b(starship|spacex)\b/i,
    stockQueries: ["spacex", "rocket"],
    youtubeQueries: ["SpaceX Starship launch test flight", "Starship hop test Boca Chica"],
  },
  {
    id: "cybertruck",
    mentionRe: /\bcybertruck\b/i,
    clipMustMatchRe: /\b(tesla|cybertruck)\b/i,
    stockQueries: ["tesla", "car"],
    youtubeQueries: ["Tesla Cybertruck unveiling", "Tesla Cybertruck driving"],
  },
  {
    id: "gigafactory",
    mentionRe: /\bgigafactory\b/i,
    clipMustMatchRe: /\b(tesla|gigafactory)\b/i,
    stockQueries: ["factory", "tesla"],
    youtubeQueries: ["Tesla Gigafactory tour", "Tesla factory Berlin Gigafactory"],
  },
  {
    id: "model3",
    mentionRe: /\bmodel\s*[3y]\b/i,
    clipMustMatchRe: /\b(tesla|model)\b/i,
    stockQueries: ["tesla", "car"],
    youtubeQueries: ["Tesla Model 3 production", "Tesla Model Y factory"],
  },
  {
    id: "starlink",
    mentionRe: /\bstarlink\b/i,
    clipMustMatchRe: /\b(starlink|spacex|satellite)\b/i,
    stockQueries: ["satellite", "rocket"],
    youtubeQueries: ["SpaceX Starlink launch", "Falcon 9 Starlink mission"],
  },
  {
    id: "neuralink",
    mentionRe: /\bneuralink\b/i,
    clipMustMatchRe: /\b(neuralink|brain|neuroscience)\b/i,
    stockQueries: ["brain", "technology"],
    youtubeQueries: ["Neuralink presentation", "brain implant research laboratory"],
  },
  {
    id: "titanic",
    mentionRe: /\b(rms\s+titanic|titanic)\b/i,
    clipMustMatchRe: /\b(titanic|rms|liner|iceberg|southampton|1912|shipwreck|white\s+star)\b/i,
    stockQueries: ["RMS Titanic", "Titanic ship 1912"],
    youtubeQueries: [
      "RMS Titanic archival footage",
      "Titanic sinking 1912 documentary",
      "Titanic maiden voyage Southampton 1912",
      "Titanic iceberg collision original",
    ],
  },
];

function extractBeatRealEntities(beatText: string, _sceneText = "", _videoTitle = ""): RealEntityRule[] {
  const fromBeat = REAL_ENTITY_RULES.filter((r) => r.mentionRe.test(beatText));
  if (fromBeat.length > 0) return fromBeat;
  for (const cue of extractInlineVisualCues(beatText)) {
    const fromCue = REAL_ENTITY_RULES.filter((r) => r.mentionRe.test(cue));
    if (fromCue.length > 0) return fromCue;
  }
  return [];
}

function clipSatisfiesRealEntities(
  rules: RealEntityRule[],
  sourceQuery: string,
  filePath: string
): boolean {
  if (rules.length === 0) return true;
  const hay = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  // Match the search query (e.g. "Elon Musk interview"), not every entity word in the beat.
  return rules.some((r) => r.clipMustMatchRe.test(hay));
}

function realEntityStockQueriesForBeat(beatText: string, sceneText: string, videoTitle?: string): string[] {
  const rules = extractBeatRealEntities(beatText, sceneText, videoTitle ?? "");
  return [...new Set(
    rules.flatMap((r) => r.stockQueries.map((q) => simplifyStockSearchWord(q, beatText, true)))
  )];
}

function realEntityYoutubeQueriesForBeat(beatText: string, sceneText: string, videoTitle?: string): string[] {
  const rules = extractBeatRealEntities(beatText, sceneText, videoTitle ?? "");
  return [...new Set(rules.flatMap((r) => r.youtubeQueries))];
}

function realEntityScore(rules: RealEntityRule[], sourceQuery: string, filePath: string): number {
  if (rules.length === 0) return 0;
  const hay = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  return rules.filter((r) => r.clipMustMatchRe.test(hay)).length * 4;
}

const BLOCKED_STOCK_QUERY_RE =
  /\b(subscribe|like button|thumbs up|thumbs down|social media ui|notification bell|emoji|icon animation|button animation|wallpaper|seamless loop|motion graphics|scale model|miniature|toy rocket|model rocket|space shuttle|shuttle model|saturn v|apollo|lunar|moon landing|moon surface|diorama|replica rocket|mission control|astronaut suit|vintage nasa|archival footage|science fiction|sci-fi|cgi rocket|crime scene|forensic|police tape|murder|courtroom)\b/i;

/** Reject model/CGI/archival-looking clips (Pexels slugs + local filenames). */
const BLOCKED_STOCK_VISUAL_RE =
  /shuttle|saturn|apollo|lunar|moon[- ]?landing|moon[- ]?surface|miniature|diorama|tabletop|model[- ]?rocket|scale[- ]?model|toy[- ]?rocket|replica|maquette|science[- ]?fiction|sci[- ]?fi|cgi|3d[- ]?animation|vhs|glitch|vintage[- ]?space|archival|old[- ]?nasa|space[- ]?shuttle|saturn[- ]?v|rocket[- ]?model|model[- ]?launch|volkswagen|vw\b|ford\b|bmw|mercedes|audi\b|toyota factory|honda factory|container ship|cargo ship|freight ship|bulk carrier|ferry|passenger boat|catamaran|harbor cruise|shipping port|port crane|logistics hub|cargo terminal|container terminal|river boat|canal boat|textile mill|weaving factory|yarn factory|fabric mill|sewing factory|highway|motorway|freeway|country road|rural road|pickup truck|desert road|coastal road|dashcam|night driving/i;

const BLOCKED_MUSK_COMPETITOR_RE =
  /\b(volkswagen|vw|ford|gm|general motors|bmw|mercedes|audi|toyota|honda|hyundai|kia|rivian|lucid)\b/i;

/** Wildlife/nature stock that must never appear on Musk/Tesla/SpaceX videos. */
const MUSK_OFFTOPIC_VISUAL_RE =
  /\b(dolphin|dolphins|whale|whales|shark|sharks|sea turtle|ocean wildlife|underwater mammal|reef|jellyfish|penguin|polar bear|safari|zoo animal|aquarium|swimming with|marine life|tropical fish)\b/i;

/** Animals / random nature B-roll that must not appear on named-celebrity videos (e.g. Kylie → flamingos). */
const PERSON_OFFTOPIC_VISUAL_RE =
  /\b(flamingo|flamingos|peacock|parrot|zoo|safari|wildlife|aquarium|dolphin|whale|penguin|giraffe|elephant|lion|tiger|bear|crocodile|snake|monkey|gorilla|zebra|hippo|bird flock|flock of birds|exotic bird|pink birds)\b/i;

/** Opening = hero Tesla car / SpaceX pad first. */
const OPENING_MUSK_QUERIES = HERO_MUSK_QUERIES;

/** Only these rocket/space queries may yield rocket-category clips on Musk/Tesla topics. */
const MUSK_APPROVED_ROCKET_QUERY_RE =
  /\b(rocket|spacex|falcon|starship)\b|falcon\s*9.*(land|boost|recover|drone\s*ship)|starship.*(pad|boca|texas|static)|spacex.*crew\s*dragon/i;

function stockVisualCategory(query: string, filePath?: string): string {
  const combined = `${query} ${path.basename(filePath ?? "")}`.toLowerCase();
  if (/miniature|diorama|tabletop|toy|model rocket|scale model|saturn|apollo|lunar|moon[- ]?landing|moon[- ]?surface|space shuttle|shuttle|vhs|glitch|sci[- ]?fi|cgi/.test(combined)) {
    return "blocked_model";
  }
  if (/textile|weaving|loom|yarn factory|fabric mill|sewing factory|ferry|catamaran|river boat|canal|harbor cruise|container ship|cargo ship|shipping port|port crane|logistics hub|cargo terminal|container terminal|warehouse district|distribution center|highway|motorway|freeway|country road|rural road|pickup truck|pickup|semi truck|freight truck|delivery truck|desert road|coastal road|dashcam/.test(combined)) {
    return "blocked_offtopic";
  }
  if (/\b(pickup|pick-up|off[- ]?road truck)\b/.test(combined) && !/\btesla\b/.test(combined)) {
    return "blocked_offtopic";
  }
  if (/gigafactory|solar.*(factory|plant|roof)|factory.*solar|solar panel.*roof/.test(combined)) return "gigafactory";
  if (/solar|photovoltaic|panel array|sun panel/.test(combined)) return "solar";
  if (/tesla|supercharger|model [3syx]|cybertruck/.test(combined)) return "tesla";
  if (/falcon|spacex|starship|rocket|launch pad|booster|spacecraft|ignition/.test(combined)) return "rocket";
  if (/robot arm|humanoid|cybernetic|prosthetic arm/.test(combined)) return "robot";
  if (/assembly line|manufacturing|factory|gigafactory|welding plant/.test(combined)) return "factory";
  if (/astronaut|mission control|orbit|satellite deploy|space station/.test(combined)) return "space";
  return "generic";
}

function categoryLimitFor(dedup: VisualDedupState, category: string, muskTopic = false): number {
  if (muskTopic) {
    if (category === "rocket") return 1;
    if (category === "space") return 0;
    if (category === "generic") return 2;
  }
  return STOCK_CATEGORY_LIMITS[category] ?? 2;
}

function muskBrandScore(sourceQuery: string, filePath: string): number {
  const t = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  let s = 0;
  if (/\btesla\b/.test(t)) s += 3;
  if (/\bspacex\b/.test(t)) s += 3;
  if (/\bfalcon\b|\bstarship\b|\bcybertruck\b/.test(t)) s += 2;
  return s;
}

function hasMuskBrandSignal(sourceQuery: string, filePath: string): boolean {
  if (muskBrandScore(sourceQuery, filePath) >= 1) return true;
  return /\b(tesla|spacex|falcon|starship|cybertruck|gigafactory|supercharger|model 3)\b/i.test(sourceQuery);
}

function categoryAtLimit(dedup: VisualDedupState, category: string, muskTopic = false): boolean {
  if (category === "blocked_model" || category === "blocked_offtopic") return true;
  const limit = categoryLimitFor(dedup, category, muskTopic);
  return (dedup.usedCategories.get(category) ?? 0) >= limit;
}

function pickMuskGoldenQuery(globalBeat: number, beatIndex = 0): string {
  const idx = (globalBeat * 3 + beatIndex) % GOLDEN_MUSK_QUERIES.length;
  return GOLDEN_MUSK_QUERIES[idx];
}

/** Normalize scene stock fields from scene narration (not video title). */
function sanitizeSceneStockQueries(scene: Scene, videoTitle?: string): void {
  const sceneScript = scene.text.trim();
  const persons = resolveScenePersons(scene, videoTitle);
  const fromScene = stockQueryFromBeatScript(sceneScript, persons, sceneScript, videoTitle);
  const queries = buildBeatVisualQueryList(sceneScript, scene, videoTitle, persons, 4);
  if (scene.literalVisualCue && PERSON_OFFTOPIC_VISUAL_RE.test(scene.literalVisualCue)) {
    scene.literalVisualCue = fromScene;
  }
  scene.pexelsQuery = fromScene;
  scene.visualCue = fromScene;
  scene.pexelsQueries = queries.length > 0 ? queries : [fromScene];
  scene.brollQueries = persons.length > 0
    ? [`${persons[0]} interview`].filter((q) => q.length >= 3)
    : [];
  if (persons.length > 0) scene.personNames = persons;
}

/** Rewrite LLM scene queries that cause CGI/model rocket hits on Pexels. */
function sanitizeSceneForMuskTopic(scene: Scene, sceneIndex: number, videoTitle?: string): void {
  if (!isMuskTeslaTopic(videoTitle, scene.text)) return;
  const fallback = pickMuskGoldenQuery(sceneIndex, 0);
  const safe = (q: string): string => {
    const trimmed = q.trim();
    if (!trimmed) return fallback;
    const cat = stockVisualCategory(trimmed);
    if (cat === "blocked_model" || isBlockedStockQuery(trimmed)) return fallback;
    if (cat === "solar" && !/solar|photovoltaic|zon\b|sun\b/.test(scene.text.toLowerCase())) return fallback;
    if (cat === "space") return fallback;
    if (cat === "rocket" && !isMuskApprovedRocketQuery(trimmed)) {
      return "rocket";
    }
    if (isAmbiguousRocketQuery(trimmed)) return fallback;
    return simplifyStockSearchWord(trimmed, scene.text);
  };
  if (scene.literalVisualCue) scene.literalVisualCue = safe(scene.literalVisualCue);
  scene.pexelsQuery = safe(scene.pexelsQuery);
  scene.visualCue = safe(scene.visualCue);
  scene.pexelsQueries = (scene.pexelsQueries ?? []).map(safe).filter((q, i, arr) => q && arr.indexOf(q) === i);
  scene.brollQueries = (scene.brollQueries ?? []).map((q) => {
    const cat = stockVisualCategory(q);
    if (cat === "tesla" || cat === "factory" || cat === "robot") return safe(q);
    return "factory";
  });
}

/** Celebrity/person videos: never search wildlife metaphors (flamingo etc.) — anchor on the named person. */
function sanitizeSceneForPersonTopic(scene: Scene, primaryPerson: string): void {
  const anchor = primaryPerson.trim();
  if (!anchor) return;
  const first = anchor.split(/\s+/)[0] ?? anchor;
  const safe = (q: string): string => {
    const trimmed = q.trim();
    if (!trimmed || PERSON_OFFTOPIC_VISUAL_RE.test(trimmed)) {
      return `${first} interview`;
    }
    if (/\b(wildlife|bird|zoo|animal|flamingo|ocean|dolphin)\b/i.test(trimmed)) {
      return `${first} interview`;
    }
    const lower = trimmed.toLowerCase();
    if (!lower.includes(first.toLowerCase()) && !/\b(celebrity|interview|fashion|makeup|red carpet)\b/i.test(lower)) {
      return anchor;
    }
    return simplifyStockSearchWord(trimmed, `${anchor} ${scene.text}`, true);
  };
  if (scene.literalVisualCue) scene.literalVisualCue = safe(scene.literalVisualCue);
  scene.pexelsQuery = anchor;
  scene.visualCue = safe(scene.visualCue) || `${anchor} interview`;
  scene.pexelsQueries = [...new Set([anchor, `${anchor} interview`, `${first} celebrity`, ...(scene.pexelsQueries ?? []).map(safe)])]
    .filter((q) => q.length >= 3 && !PERSON_OFFTOPIC_VISUAL_RE.test(q))
    .slice(0, 4);
  scene.brollQueries = [`${first} fashion`, `${first} interview`].filter((q) => !isBlockedStockQuery(q));
  if (!scene.personNames?.length) scene.personNames = [anchor];
}

function isMuskApprovedRocketQuery(q: string): boolean {
  return MUSK_APPROVED_ROCKET_QUERY_RE.test(q);
}

function isAmbiguousRocketQuery(q: string): boolean {
  const lower = q.toLowerCase();
  if (!/\brocket\b/.test(lower) && !/\bspace shuttle\b/.test(lower)) return false;
  return !isMuskApprovedRocketQuery(q);
}

function isPipelineFallbackClip(filePath: string): boolean {
  return /_fallback\.mp4$/i.test(path.basename(filePath));
}

async function probeClipMeanLuma(filePath: string, atSec: number): Promise<number | null> {
  try {
    const lumCmd =
      `"${FFMPEG_BIN}" -y -ss ${atSec.toFixed(2)} -i "${filePath}" -vframes 1 -vf "scale=64:36,format=gray" -f rawvideo -`;
    const { stdout } = await withTimeout(exec(lumCmd), 10_000, `luma ${path.basename(filePath)}@${atSec}`);
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "", "binary");
    if (buf.length === 0) return null;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    return sum / buf.length;
  } catch {
    return null;
  }
}

async function isMostlyBlackClip(filePath: string): Promise<boolean> {
  if (isPipelineFallbackClip(filePath)) return true;
  // Railway: one luma sample — full blackdetect runs 3+ FFmpeg probes per clip
  if (IS_RAILWAY) {
    const mid = await probeClipMeanLuma(filePath, 0.5);
    return mid !== null && mid < 24;
  }
  const dur = await probeVideoDurationSec(filePath);
  const sampleTimes = [0.2, 0.9, 2.0];
  if (dur > 2.5) sampleTimes.push(Math.max(0.3, dur - 0.35));
  let darkSamples = 0;
  for (const t of sampleTimes) {
    const mean = await probeClipMeanLuma(filePath, Math.min(t, Math.max(0, dur - 0.1)));
    if (mean !== null && mean < 34) darkSamples++;
  }
  if (darkSamples >= 2) return true;
  try {
    const cmd =
      `"${FFMPEG_BIN}" -y -i "${filePath}" -vf "blackdetect=d=0.06:pix_th=0.10" -an -f null -`;
    const { stderr } = await withTimeout(exec(cmd), 12_000, `blackdetect ${path.basename(filePath)}`);
    const out = typeof stderr === "string" ? stderr : String(stderr ?? "");
    const startMatch = out.match(/black_start:([\d.]+)/g);
    const endMatch = out.match(/black_end:([\d.]+)/g);
    if (!startMatch?.length || !endMatch?.length) return false;
    let blackDur = 0;
    for (let i = 0; i < Math.min(startMatch.length, endMatch.length); i++) {
      const start = parseFloat(startMatch[i].replace("black_start:", ""));
      const end = parseFloat(endMatch[i].replace("black_end:", ""));
      if (!isNaN(start) && !isNaN(end) && end > start) blackDur += end - start;
    }
    const totalDur = dur > 0 ? dur : 4;
    if (totalDur > 0 && blackDur / totalDur > 0.12) return true;
  } catch {
    /* fall through */
  }
  const mid = await probeClipMeanLuma(filePath, 0.5);
  return mid !== null && mid < 28;
}

function isMuskTeslaTopic(videoTitle?: string, sceneText?: string): boolean {
  const text = `${videoTitle ?? ""} ${sceneText ?? ""}`.toLowerCase();
  return /musk|tesla|spacex|starlink|gigafactory|cybertruck|falcon|starship|elon/.test(text);
}

function buildTopicContext(userPrompt: string | undefined, videoTitle: string): string {
  return [userPrompt?.trim(), videoTitle.trim()].filter(Boolean).join(" — ").slice(0, 240);
}

function isOffTopicVisualForMusk(sourceQuery: string, filePath: string): boolean {
  const hay = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  if (MUSK_OFFTOPIC_VISUAL_RE.test(hay)) return true;
  if (/\b(ocean wave|beach sunset|tropical beach|underwater|snorkel|diving)\b/.test(hay) && !hasMuskBrandSignal(sourceQuery, filePath)) {
    return true;
  }
  return false;
}

function isOffTopicVisualForPersonTopic(sourceQuery: string, filePath: string, primaryPerson: string): boolean {
  const hay = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  if (PERSON_OFFTOPIC_VISUAL_RE.test(hay)) return true;
  const parts = primaryPerson.toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
  if (parts.length >= 2 && parts.every((p) => hay.includes(p))) return false;
  if (parts.length === 1 && hay.includes(parts[0])) return false;
  if (/\b(celebrity|interview|red carpet|paparazzi|influencer|makeup|fashion)\b/.test(hay)) return false;
  if (MUSK_OFFTOPIC_VISUAL_RE.test(hay)) return true;
  return false;
}

function hasBlockedStockTags(tags?: string): boolean {
  return BLOCKED_STOCK_TAGS_RE.test(tags ?? "");
}

function isBlockedStockQuery(q: string): boolean {
  if (BLOCKED_STOCK_QUERY_RE.test(q)) return true;
  if (isAmbiguousRocketQuery(q)) return true;
  if (/\b(highway|motorway|freeway|country road|rural road|pickup truck|off road truck|desert road|coastal road|ferry route)\b/i.test(q)) {
    return true;
  }
  return false;
}

function isRejectedPexelsVideo(video: { url?: string }): boolean {
  const slug = (video.url ?? "").toLowerCase();
  return BLOCKED_STOCK_VISUAL_RE.test(slug) || BLOCKED_MUSK_COMPETITOR_RE.test(slug);
}

function isRejectedStockClip(filePath: string, sourceQuery = ""): boolean {
  const combined = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  if (BLOCKED_STOCK_VISUAL_RE.test(combined)) return true;
  if (hasBlockedStockTags(combined)) return true;
  return false;
}

function isPublishableChapterTitle(title: string | undefined): boolean {
  if (!title?.trim()) return false;
  const lower = title.trim().toLowerCase();
  const blocked = new Set([
    "hook", "call to action", "cta", "intro", "introduction", "outro", "conclusion", "opening", "closing",
  ]);
  if (blocked.has(lower)) return false;
  if (/^(section|part|chapter|scene)\s*\d*$/i.test(lower)) return false;
  return title.trim().length >= 4;
}

function clipContentKey(filePath: string): string {
  const curatedId = curatedClipPathAssetId(filePath);
  if (curatedId != null) return curatedAssetContentKey(curatedId);
  const base = path.basename(filePath).replace(/_transformed(?=\.mp4)/, "");
  const vidMatch = base.match(/_vid(\d+)/);
  if (vidMatch) return `stock:vid:${vidMatch[1]}`;
  if (isStillPhotoClip(filePath)) {
    try {
      const buf = fs.readFileSync(filePath);
      const sample = buf.subarray(0, Math.min(buf.length, 48_000));
      const hash = createHash("sha256").update(sample).digest("hex").slice(0, 20);
      return `still:${hash}`;
    } catch {
      /* fall through */
    }
  }
  try {
    const stat = fs.statSync(filePath);
    return `file:${stat.size}:${base}`;
  } catch {
    return base;
  }
}

function montageClipStartSec(_sceneIndex: number, clipIndex: number): number {
  return 0.25 * (clipIndex % 7);
}

function estimateBeatHoldSec(text: string, mergedSentenceCount: number): number {
  const words = text.replace(/\[visual:[^\]]+\]/gi, "").split(/\s+/).filter(Boolean).length;
  const byWords = words / 2.4;
  if (mergedSentenceCount >= 2 || byWords > 16) {
    return Math.min(
      VIDRUSH_CLIP_HOLD_SEC,
      Math.max(VIDRUSH_CLIP_MAX_SEC + 0.5, Math.min(byWords, VIDRUSH_CLIP_HOLD_SEC))
    );
  }
  return VIDRUSH_BEAT_SEC;
}

function beatsBelongTogether(prevText: string, nextText: string, prevVisual: string, nextVisual: string): boolean {
  if (prevVisual && nextVisual && prevVisual.toLowerCase() === nextVisual.toLowerCase()) return true;
  const prevEntities = extractBeatRealEntities(prevText).map((r) => r.id).join(",");
  const nextEntities = extractBeatRealEntities(nextText).map((r) => r.id).join(",");
  if (prevEntities && nextEntities && prevEntities === nextEntities) return true;
  if (!extractInlineVisualCues(nextText).length && nextText.length < 90) return true;
  return false;
}

function normalizeMontageDurations(durations: number[], outDur: number): number[] {
  const n = durations.length;
  if (n === 0) return durations;
  const xfade = n > 1 ? montageXfadeSec() : 0;
  const total = durations.reduce((s, d) => s + d, 0) - (n - 1) * xfade;
  if (total <= 0.1) return durations;
  const scale = outDur / total;
  return durations.map((d) =>
    Math.max(VIDRUSH_CLIP_MIN_SEC * 0.85, Math.min(VIDRUSH_CLIP_HOLD_SEC, d * scale))
  );
}

/** Keep per-beat timing when compose drops invalid/duplicate clips. */
function alignBeatDurationsWithClips(
  originalClips: string[],
  keptClips: string[],
  beatDurations?: number[]
): number[] | undefined {
  if (!beatDurations?.length || beatDurations.length !== originalClips.length) return undefined;
  if (originalClips.length === keptClips.length) return beatDurations;
  const aligned = keptClips.map((clip) => {
    const idx = originalClips.indexOf(clip);
    return idx >= 0 ? beatDurations[idx] : VIDRUSH_BEAT_SEC;
  });
  return aligned.length === keptClips.length ? aligned : undefined;
}

/** Default per-clip duration when beat metadata is missing. */
function computeMontageClipDuration(sceneDuration: number, clipCount: number): number {
  if (clipCount <= 0) return VIDRUSH_BEAT_SEC;
  const ideal = Math.max(1, Math.ceil(sceneDuration / VIDRUSH_BEAT_SEC));
  if (clipCount >= ideal - 1) return VIDRUSH_BEAT_SEC;
  const xfade = clipCount > 1 ? montageXfadeSec() : 0;
  const evenSplit = (sceneDuration + (clipCount - 1) * xfade) / clipCount;
  return Math.max(VIDRUSH_CLIP_MIN_SEC, Math.min(VIDRUSH_CLIP_MAX_SEC, evenSplit));
}

/** xfade montage — trim in-filter; optional per-beat durations (3–4s, longer when merged). */
function buildMontageXfadeFilter(
  clipCount: number,
  outDur: number,
  sceneIndex: number,
  clipDurations?: number[]
): { scaleFilters: string; mergeFilter: string; montageLabel: string } {
  const n = Math.max(1, clipCount);
  const xfade = montageXfadeSec();
  let durs =
    clipDurations?.length === n
      ? clipDurations.map((d) =>
          Math.max(VIDRUSH_CLIP_MIN_SEC, Math.min(VIDRUSH_CLIP_HOLD_SEC, d))
        )
      : Array.from({ length: n }, () => computeMontageClipDuration(outDur, n));
  durs = normalizeMontageDurations(durs, outDur);

  if (n === 1) {
    return {
      scaleFilters:
        `[0:v]trim=start=${montageClipStartSec(sceneIndex, 0).toFixed(2)}:duration=${durs[0].toFixed(3)},` +
        `${CROP_FILL_VF},setpts=PTS-STARTPTS[v0]`,
      mergeFilter: "",
      montageLabel: "v0",
    };
  }

  const scaleFilters = Array.from({ length: n }, (_, i) =>
    `[${i}:v]trim=start=${montageClipStartSec(sceneIndex, i).toFixed(2)}:duration=${durs[i].toFixed(3)},` +
    `${CROP_FILL_VF},setpts=PTS-STARTPTS[v${i}]`
  ).join(";");

  if (xfade <= 0.001) {
    const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
    return {
      scaleFilters,
      mergeFilter: `;${concatInputs}concat=n=${n}:v=1:a=0[montage]`,
      montageLabel: "montage",
    };
  }

  let mergeFilter = "";
  let prev = "v0";
  let offset = durs[0] - xfade;
  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? "montage" : `xf${i}`;
    mergeFilter += `;[${prev}][v${i}]xfade=transition=fade:duration=${xfade.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`;
    prev = outLabel;
    offset += durs[i] - xfade;
  }
  return { scaleFilters, mergeFilter, montageLabel: "montage" };
}

function extractTopicStockQueries(scriptText: string): string[] {
  const queries = scriptStockSearchQueries(scriptText);
  return queries.length > 0 ? queries : ["documentary"];
}

function buildTopicAnchoredQueries(
  scene: Scene,
  videoTitle?: string,
  personName?: string,
  _prompt?: string,
  beatText?: string
): string[] {
  const person = personName || scene.personNames?.[0] || extractPrimaryPersonFromTitle(videoTitle) || "";
  const titleLower = (videoTitle ?? "").toLowerCase();
  const textLower = (beatText ?? scene.text).toLowerCase();
  const script = beatText?.trim() || scene.text;
  const queries: string[] = [];

  queries.push(...scriptStockSearchQueries(script));
  queries.push(
    enrichStockQuery(scene.literalVisualCue ?? "", scene, videoTitle, person, script),
    enrichStockQuery(scene.pexelsQuery, scene, videoTitle, person, script),
    enrichStockQuery(scene.visualCue, scene, videoTitle, person, script),
    ...(scene.pexelsQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, person, script)),
    ...(scene.brollQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, person, script)),
  );

  if (titleLower.includes("tesla") || textLower.includes("tesla")) {
    queries.push("tesla", "factory", "car");
  }
  if (titleLower.includes("spacex") || textLower.includes("spacex") || textLower.includes("rocket")) {
    queries.push("spacex", "rocket");
  }

  const allowSolar = /solar|photovoltaic|sun energy|panel|zon\b|sun\b/.test(textLower);
  return [...new Set(queries.filter((q) => {
    if (!q.trim() || q.trim().length <= 2 || isBlockedStockQuery(q)) return false;
    if (!allowSolar && stockVisualCategory(q) === "solar") return false;
    return true;
  }))];
}

/** Dutch (and common non-English) → single English Pexels keyword. */
const DUTCH_STOCK_WORD_MAP: Record<string, string> = {
  zon: "sun", strand: "beach", zee: "ocean", berg: "mountain", bos: "forest", stad: "city",
  regen: "rain", sneeuw: "snow", vuur: "fire", wind: "wind", wolk: "cloud", hemel: "sky",
  hond: "dog", kat: "cat", paard: "horse", vogel: "bird", vis: "fish", olifant: "elephant",
  politie: "police", ziekenhuis: "hospital", school: "school", universiteit: "university",
  fiets: "bicycle", vliegtuig: "airplane", trein: "train", auto: "car", bus: "bus", boot: "boat",
  fabriek: "factory", kantoor: "office", restaurant: "restaurant", keuken: "kitchen", koffie: "coffee",
  voetbal: "football", wielrennen: "cycling", zwemmen: "swimming", hardlopen: "running",
  oorlog: "war", soldaat: "soldier", demonstratie: "protest", regering: "government", verkiezing: "election",
  klimaat: "climate", overstroming: "flood", storm: "storm", rook: "smoke", aarde: "earth",
  kunst: "art", muziek: "music", concert: "concert", kerk: "church", bruiloft: "wedding",
  kind: "child", gezin: "family", vrouw: "woman", man: "man", mensen: "people", menigte: "crowd",
  geld: "money", bank: "bank", winkel: "shop", markt: "market", boerderij: "farm", oogst: "harvest",
  ruimte: "space", planeet: "planet", sterren: "stars", maan: "moon",
};

/** Topic patterns → one English stock keyword (all documentary subjects). */
const STOCK_TOPIC_WORD_RULES: [RegExp, string][] = [
  [/\b(cybertruck|gigafactory|supercharger|model\s*[3y])\b|\btesla\b|\bmusk\b|\belon\b/, "tesla"],
  [/\bspacex\b|\bfalcon\b|\bstarship\b/, "spacex"],
  [/\brocket\b|\blaunch\b|\bbooster\b|\borbit\b|\bmissile\b/, "rocket"],
  [/\bsolar\b|\bphotovoltaic\b/, "solar"],
  [/\bsun\b|\bsunshine\b|\bzon\b/, "sun"],
  [/\bwind\s*turbine\b|\bwindmill\b|\bwindenergy\b/, "wind"],
  [/\bclimate\b|\bglobal warming\b|\bcarbon\b|\bgreenhouse\b/, "climate"],
  [/\bflood\b|\btsunami\b|\bhurricane\b|\btyphoon\b|\bearthquake\b/, "storm"],
  [/\bfire\b|\bwildfire\b|\bflame\b|\bbrand\b/, "fire"],
  [/\bocean\b|\bsea\b|\bwave\b|\bcoast\b|\bbeach\b|\bdolphin\b|\bwhale\b|\bzee\b|\bstrand\b/, "ocean"],
  [/\bforest\b|\bjungle\b|\btree\b|\bwood\b|\bbos\b/, "forest"],
  [/\bmountain\b|\bhill\b|\bvalley\b|\bberg\b/, "mountain"],
  [/\briver\b|\blake\b|\bwaterfall\b/, "river"],
  [/\bsnow\b|\bice\b|\barctic\b|\bantarctic\b|\bsneeuw\b/, "snow"],
  [/\brain\b|\bstorm\b|\bthunder\b|\bregen\b/, "rain"],
  [/\bcity\b|\burban\b|\bskyline\b|\bdowntown\b|\bmetropolis\b|\bstad\b/, "city"],
  [/\bstreet\b|\btraffic\b|\bhighway\b|\broad\b|\bbridge\b/, "street"],
  [/\bbuilding\b|\bskyscraper\b|\barchitecture\b|\bconstruction\b/, "building"],
  [/\bairport\b|\bairplane\b|\baircraft\b|\bflight\b|\bvliegtuig\b/, "airplane"],
  [/\btrain\b|\brailway\b|\bmetro\b|\bstation\b|\btrein\b/, "train"],
  [/\bship\b|\bharbor\b|\bport\b|\bcargo\b|\bboot\b/, "ship"],
  [/\bcar\b|\bautomobile\b|\bvehicle\b|\bdriving\b|\bauto\b/, "car"],
  [/\btruck\b|\blorry\b|\bfreight\b/, "truck"],
  [/\bmotorcycle\b|\bbike\b|\bcycling\b|\bfiets\b/, "bicycle"],
  [/\bfactory\b|\bassembly\b|\bmanufacturing\b|\bplant\b|\bfabriek\b/, "factory"],
  [/\brobot\b|\bautomation\b|\bdrone\b/, "robot"],
  [/\bcomputer\b|\blaptop\b|\bcoding\b|\bsoftware\b|\bserver\b|\bdatacenter\b/, "computer"],
  [/\bphone\b|\bsmartphone\b|\bmobile\b|\bapp\b/, "phone"],
  [/\bai\b|artificial intelligence|\bmachine learning\b|\bchatgpt\b/, "technology"],
  [/\bchip\b|\bsemiconductor\b|\bprocessor\b/, "computer"],
  [/\bhospital\b|\bdoctor\b|\bnurse\b|\bmedical\b|\bsurgery\b|\bziekenhuis\b/, "hospital"],
  [/\bhealth\b|\bfitness\b|\bgym\b|\byoga\b|\bworkout\b/, "fitness"],
  [/\bfood\b|\bcooking\b|\bchef\b|\bkitchen\b|\brestaurant\b|\bmeal\b|\bkeuken\b/, "food"],
  [/\bcoffee\b|\bcafe\b|\bkoffie\b/, "coffee"],
  [/\bwine\b|\bbeer\b|\bbar\b/, "bar"],
  [/\bfarm\b|\btractor\b|\bwheat\b|\bcorn\b|\bharvest\b|\bagriculture\b|\bboerderij\b/, "farm"],
  [/\banimal\b|\bwildlife\b|\bzoo\b/, "wildlife"],
  [/\bdog\b|\bpuppy\b|\bhond\b/, "dog"],
  [/\bcat\b|\bkitten\b|\bkat\b/, "cat"],
  [/\bhorse\b|\bequestrian\b|\bpaard\b/, "horse"],
  [/\bbird\b|\beagle\b|\bvogel\b/, "bird"],
  [/\blion\b|\btiger\b|\belephant\b|\bbear\b|\bgiraffe\b/, "wildlife"],
  [/\bfish\b|\baquarium\b|\bcoral\b|\bvis\b/, "fish"],
  [/\bfootball\b|\bsoccer\b|\bbasketball\b|\btennis\b|\bolympic\b|\bvoetbal\b/, "sport"],
  [/\brunning\b|\bmarathon\b|\bathlete\b|\bhardlopen\b/, "running"],
  [/\bswimming\b|\bpool\b|\bzwemmen\b/, "swimming"],
  [/\bwar\b|\bmilitary\b|\bsoldier\b|\barmy\b|\btank\b|\bcombat\b|\boorlog\b/, "military"],
  [/\bprotest\b|\bdemonstration\b|\briot\b|\bdemonstratie\b/, "protest"],
  [/\belection\b|\bvote\b|\bparliament\b|\bgovernment\b|\bpolitics\b|\bverkiezing\b/, "government"],
  [/\bpolice\b|\bcrime\b|\bcourt\b|\bprison\b|\blaw\b|\bpolitie\b/, "police"],
  [/\bmoney\b|\bfinance\b|\bstock market\b|\btrading\b|\bcrypto\b|\bbitcoin\b|\bgeld\b/, "finance"],
  [/\boffice\b|\bmeeting\b|\bbusiness\b|\bcorporate\b|\bceo\b|\bkantoor\b/, "office"],
  [/\bshopping\b|\bstore\b|\bretail\b|\bmall\b|\bwinkel\b/, "shop"],
  [/\bschool\b|\bclassroom\b|\bstudent\b|\beducation\b|\buniversity\b/, "school"],
  [/\blibrary\b|\bbook\b|\breading\b|\bstudy\b/, "library"],
  [/\bchurch\b|\btemple\b|\bmosque\b|\breligion\b|\bprayer\b|\bkerk\b/, "church"],
  [/\bwedding\b|\bmarriage\b|\bbride\b|\bbruiloft\b/, "wedding"],
  [/\bfamily\b|\bchild\b|\bbaby\b|\bkinderen\b|\bkind\b|\bgezin\b/, "family"],
  [/\bwoman\b|\bwomen\b|\bfemale\b|\bvrouw\b/, "woman"],
  [/\bman\b|\bmen\b|\bmale\b|\bman\b/, "man"],
  [/\bpeople\b|\bcrowd\b|\baudience\b|\bconcert goers\b|\bmensen\b|\bmenigte\b/, "crowd"],
  [/\bcelebrity\b|\bpaparazzi\b|\bfamous\b|\bstar\b|\binfluencer\b|\bkardashian\b/, "celebrity"],
  [/\bcamera\b|\bphotography\b|\bfilming\b|\bmedia\b/, "camera"],
  [/\bnews\b|\bpress\b|\bjournalist\b|\breporter\b|\banchor\b/, "news"],
  [/\bmovie\b|\bfilm\b|\bhollywood\b|\bcinema\b|\bactor\b/, "cinema"],
  [/\bmusic\b|\bconcert\b|\bguitar\b|\bpiano\b|\borchestra\b|\bmuziek\b/, "music"],
  [/\bart\b|\bmuseum\b|\bgallery\b|\bpainting\b|\bsculpture\b|\bkunst\b/, "museum"],
  [/\bhistory\b|\bancient\b|\bruins\b|\bcastle\b|\bmonument\b/, "history"],
  [/\bspace\b|\bnasa\b|\bastronaut\b|\bplanet\b|\bgalaxy\b|\bruimte\b/, "space"],
  [/\bmoon\b|\blunar\b|\bmaan\b/, "moon"],
  [/\bmars\b/, "mars"],
  [/\bsatellite\b|\bstarlink\b|\borbit\b/, "satellite"],
  [/\bneuralink\b|\bbrain\b|\bneuroscience\b/, "brain"],
  [/\btravel\b|\bvacation\b|\btourism\b|\bhotel\b|\bresort\b/, "travel"],
  [/\bnight\b|\bevening\b|\bsunset\b|\bdawn\b/, "sunset"],
  [/\bdesert\b|\bsahara\b/, "desert"],
  [/\bisland\b|\btropical\b|\bpalm\b/, "island"],
  [/\benergy\b|\boil\b|\bgas\b|\bpipeline\b|\brefinery\b/, "energy"],
  [/\bmining\b|\bcoal\b|\bquarry\b/, "mining"],
  [/\btextile\b|\bfashion\b|\bclothing\b|\bmodel runway\b/, "fashion"],
  [/\bbeauty\b|\bmakeup\b|\bsalon\b/, "beauty"],
  [/\bscience\b|\blaboratory\b|\bexperiment\b|\bresearch\b/, "science"],
  [/\bvolcano\b|\beruption\b/, "volcano"],
  [/\bglacier\b|\bmelting\b/, "glacier"],
];

/** Pexels/Pixabay: one simple English word. scriptOnly = ignore scene/title hint context. */
function simplifyStockSearchWord(input: string, hintText = "", scriptOnly = false): string {
  const cleanedInput = input.replace(/\[visual:[^\]]*\]/gi, " ").trim();
  const combined = (scriptOnly ? cleanedInput : `${cleanedInput} ${hintText}`)
    .toLowerCase()
    .replace(/\[visual:[^\]]*\]/gi, " ");
  for (const [nl, en] of Object.entries(DUTCH_STOCK_WORD_MAP)) {
    if (new RegExp(`\\b${nl}\\b`).test(combined)) return en;
  }
  for (const [re, word] of STOCK_TOPIC_WORD_RULES) {
    if (re.test(combined)) return word;
  }
  const tokens = scriptOnly
    ? tokenizeForRelevance(cleanedInput)
    : [
        ...tokenizeForRelevance(cleanedInput),
        ...tokenizeForRelevance(hintText),
      ];
  const seen = new Set<string>();
  const unique = tokens.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  unique.sort((a, b) => b.length - a.length);
  for (const t of unique) {
    if (DUTCH_STOCK_WORD_MAP[t]) return DUTCH_STOCK_WORD_MAP[t];
    if (t.length >= 4 && !RELEVANCE_STOP_WORDS.has(t)) return t.slice(0, 24);
  }
  for (const t of unique) {
    if (t.length >= 3 && !RELEVANCE_STOP_WORDS.has(t)) return t.slice(0, 24);
  }
  if (/\bmodel\s*3\b/.test(combined)) return "tesla";
  return "documentary";
}

function enrichStockQuery(
  query: string,
  scene: Scene,
  videoTitle?: string,
  personName?: string,
  beatText?: string
): string {
  if (beatText?.trim()) {
    const persons = personName ? [personName, ...(scene.personNames ?? [])] : (scene.personNames ?? []);
    const fromScript = scriptStockSearchQueries(beatText, persons, scene.text, videoTitle);
    if (fromScript.length > 0) return fromScript[0];
  }
  const hint = beatText?.trim() || scene.text;
  if (isBlockedStockQuery(query)) return simplifyStockSearchWord(hint, hint, true);
  return simplifyStockSearchWord(query, hint, Boolean(beatText?.trim()));
}

function tokenizeForRelevance(text: string): string[] {
  return text
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !RELEVANCE_STOP_WORDS.has(w));
}

function buildRelevanceKeywords(scene: Scene, beatText: string, videoTitle?: string): string[] {
  const parts = [
    ...tokenizeForRelevance(beatText),
    ...tokenizeForRelevance(scene.visualCue),
    ...tokenizeForRelevance(scene.pexelsQuery),
    ...(scene.pexelsQueries ?? []).flatMap((q) => tokenizeForRelevance(q)),
    ...(scene.personNames ?? []).flatMap((n) => tokenizeForRelevance(n)),
    ...tokenizeForRelevance(videoTitle ?? ""),
  ];
  return Array.from(new Set(parts)).slice(0, 20);
}

function scoreVisualRelevance(text: string, keywords: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (kw.length < 3) continue;
    if (t.includes(kw)) score++;
  }
  return score;
}

/** Map narration sentence → Pexels search from script text only. */
function deriveBeatStockQuery(
  beatText: string,
  scene: Scene,
  videoTitle?: string,
  personName?: string,
  _muskTopic = false
): string {
  const persons = resolveScenePersons(scene, videoTitle, personName);
  return stockQueryFromBeatScript(beatText, persons, scene.text, videoTitle);
}

function buildSceneBeats(
  scene: Scene,
  duration: number,
  maxBeatsCap = 16,
  videoTitle?: string,
  scenePersons: string[] = []
): SceneBeat[] {
  const targetBeats = Math.max(2, Math.ceil(duration / VIDRUSH_BEAT_SEC));
  const beatCap = Math.min(maxBeatsCap, targetBeats);

  const rawSentences =
    scene.text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter((s) => s.length > 5) ??
    [scene.text.trim()];

  // Eén beat per zin; alleen samenvoegen als we boven het beat-cap zitten.
  let groups: { text: string; sentenceCount: number }[] = rawSentences.map((text) => ({
    text,
    sentenceCount: 1,
  }));

  while (groups.length < targetBeats && groups.length > 0) {
    let splitIdx = 0;
    let maxWords = 0;
    for (let i = 0; i < groups.length; i++) {
      const w = groups[i].text.split(/\s+/).filter(Boolean).length;
      if (w > maxWords) {
        maxWords = w;
        splitIdx = i;
      }
    }
    const words = groups[splitIdx].text.split(/\s+/).filter(Boolean);
    if (words.length < 16) break;
    const mid = Math.ceil(words.length / 2);
    const a = words.slice(0, mid).join(" ");
    const b = words.slice(mid).join(" ");
    groups.splice(splitIdx, 1, { text: a, sentenceCount: 1 }, { text: b, sentenceCount: 1 });
  }

  while (groups.length > beatCap) {
    let mergeIdx = 0;
    let minWords = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      const w = groups[i].text.split(/\s+/).filter(Boolean).length;
      if (w < minWords) {
        minWords = w;
        mergeIdx = i;
      }
    }
    const merged = `${groups[mergeIdx].text} ${groups[mergeIdx + 1].text}`;
    groups.splice(mergeIdx, 2, {
      text: merged,
      sentenceCount: groups[mergeIdx].sentenceCount + groups[mergeIdx + 1].sentenceCount,
    });
  }

  const beats: SceneBeat[] = [];
  for (let i = 0; i < groups.length; i++) {
    const text = groups[i].text;
    const powerWord = extractPowerWordFromSentence(text, scenePersons);
    let searchQuery = simplifyStockSearchWord(powerWord, text, true);
    if (!searchQuery || isBlockedStockQuery(searchQuery)) {
      searchQuery = stockQueryFromBeatScript(text, scenePersons, scene.text, videoTitle);
    }
    beats.push({
      index: i,
      text,
      searchQuery,
      powerWord,
      keywords: buildRelevanceKeywords(scene, text),
      holdSec: estimateBeatHoldSec(text, groups[i].sentenceCount),
    });
  }
  return beats;
}

async function adoptClip(
  paths: string[],
  dedup: VisualDedupState,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  workDir: string,
  sourceQuery = "",
  opts: VisualAdoptOptions = {}
): Promise<string | null> {
  const keywords = opts.keywords ?? [];
  const muskTopic = opts.muskTopic ?? false;
  const entityRules = extractBeatRealEntities(beatText, opts.sceneText ?? "", opts.videoTitle ?? "");
  const sortedPaths = [...paths].sort((a, b) => {
    const stillA = isStillPhotoClip(a) ? 1 : 0;
    const stillB = isStillPhotoClip(b) ? 1 : 0;
    if (stillA !== stillB) return stillA - stillB;
    const scoreB =
      scoreVisualRelevance(`${sourceQuery} ${path.basename(b)} ${beatText}`, keywords) +
      scoreVisualRelevance(beatText, tokenizeForRelevance(sourceQuery)) +
      scoreBeatNarrationMatch(beatText, sourceQuery, b) * 4 +
      realEntityScore(entityRules, sourceQuery, b) +
      (muskTopic ? muskBrandScore(sourceQuery, b) : 0);
    const scoreA =
      scoreVisualRelevance(`${sourceQuery} ${path.basename(a)} ${beatText}`, keywords) +
      scoreVisualRelevance(beatText, tokenizeForRelevance(sourceQuery)) +
      scoreBeatNarrationMatch(beatText, sourceQuery, a) * 4 +
      realEntityScore(entityRules, sourceQuery, a) +
      (muskTopic ? muskBrandScore(sourceQuery, a) : 0);
    return scoreB - scoreA;
  });

  return withVisualDedupLock(dedup, async () => {
    for (const p of sortedPaths) {
      if (!p || dedup.usedPaths.has(p) || !fs.existsSync(p)) continue;
      if (!(await isValidVideoFile(p))) continue;
      if (isStillPhotoClip(p)) {
        const scriptStill = Boolean(opts.scriptImageFallback);
        if (!scriptStill && !canUseGlobalStillPhoto(dedup)) continue;
        const sceneStillCap = dedup.stillPhotosMaxThisScene;
        if (!scriptStill && sceneStillCap > 0 && dedup.stillPhotosThisScene >= sceneStillCap) continue;
        if (scriptStill || canUseGlobalStillPhoto(dedup)) {
          dedup.stillPhotosThisScene++;
          if (canUseGlobalStillPhoto(dedup)) markGlobalStillPhotoUsed(dedup);
        }
      }
      if (isAIGeneratedClip(p) && dedup.stillPhotosMaxThisScene === 0) continue;
      if (isAIGeneratedClip(p)) continue;
      if (isRejectedStockClip(p, sourceQuery)) continue;
      if (isPipelineFallbackClip(p)) continue;
      if (await isMostlyBlackClip(p)) continue;
      if (!opts.scriptImageFallback) {
        if (muskTopic && isOffTopicVisualForMusk(sourceQuery, p)) continue;
        if (
          opts.personTopic &&
          opts.primaryPerson &&
          isOffTopicVisualForPersonTopic(sourceQuery, p, opts.primaryPerson)
        ) {
          continue;
        }
        if (opts.personTopic && opts.primaryPerson && isStockVideoClip(p)) {
          const hay = `${sourceQuery} ${path.basename(p)}`.toLowerCase();
          const personHit = textMentionsPersonName(hay, opts.primaryPerson);
          const celebCue = /\b(interview|red carpet|talk show|celebrity|paparazzi|jenner|kardashian)\b/.test(hay);
          if (!personHit && !celebCue) continue;
        }
      }
      const category = stockVisualCategory(sourceQuery, p);
      if (category === "blocked_model" || category === "blocked_offtopic") continue;
      if (categoryAtLimit(dedup, category, muskTopic)) continue;
      // Musk/Tesla topics: reject generic clips when query targets a specific category
      const queryCategory = stockVisualCategory(sourceQuery);
      if (queryCategory !== "generic" && category === "generic") continue;
      if (opts.requireMuskBrand && !hasMuskBrandSignal(sourceQuery, p)) continue;
      const beatMatch = scoreBeatNarrationMatch(beatText, sourceQuery, p);
      const queryWords = sourceQuery.split(/\s+/).filter((w) => w.length >= 3);
      const queryInBeat = scoreVisualRelevance(beatText, queryWords) >= 1;
      if (!opts.scriptImageFallback) {
        if (opts.requireBeatMatch && beatMatch < 1 && !queryInBeat) continue;
        if (opts.scriptAnchored && beatMatch < 1 && !queryInBeat && entityRules.length === 0) continue;
        if (opts.personTopic && opts.primaryPerson) {
          const parts = opts.primaryPerson.toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
          const hay = `${sourceQuery} ${path.basename(p)}`.toLowerCase();
          const personHit = parts.some((pt) => hay.includes(pt));
          const eventHit = /\b(interview|celebrity|red carpet|keynote|conference|launch)\b/.test(hay);
          if (!personHit && !eventHit && beatMatch < 1) continue;
        }
        if (entityRules.length > 0 && !clipSatisfiesRealEntities(entityRules, sourceQuery, p)) continue;
      }
      if (muskTopic) {
        if (category === "solar" && !/solar|photovoltaic|sun panel/.test(beatText.toLowerCase())) continue;
        if ((category === "rocket" || category === "space") && !isMuskApprovedRocketQuery(sourceQuery)) {
          continue;
        }
        if (BLOCKED_MUSK_COMPETITOR_RE.test(`${sourceQuery} ${path.basename(p)}`)) continue;
        const rel = scoreVisualRelevance(`${sourceQuery} ${path.basename(p)}`, keywords);
        const topicRel = scoreVisualRelevance(`${sourceQuery} ${path.basename(p)}`, MUSK_TOPIC_TOKENS);
        const brand = muskBrandScore(sourceQuery, p);
        // Pexels filenames rarely include "Tesla" — reject only when clearly unrelated.
        if (rel < 1 && topicRel < 1 && brand === 0 && category === "generic") continue;
        if (category === "generic" && queryCategory !== "generic" && rel < 1 && brand === 0) continue;
      }
      let fileSize = 0;
      try { fileSize = fs.statSync(p).size; } catch { continue; }
      if (fileSize < 180_000) continue;
      if (
        !(await clipPassesVisionGate(
          p,
          beatText,
          opts.videoTitle,
          workDir,
          sceneIndex,
          beatIndex,
          dedup.perf.fastStockMode
        ))
      ) {
        continue;
      }
      const contentKey = clipContentKey(p);
      if (dedup.usedContentKeys.has(contentKey)) continue;
      dedup.usedPaths.add(p);
      dedup.usedContentKeys.add(contentKey);
      dedup.usedCategories.set(category, (dedup.usedCategories.get(category) ?? 0) + 1);
      const mustFairUse = clipRequiresFairUseTransform(p);
      if (dedup.perf.skipFairUseTransform && !mustFairUse) {
        if (await isValidVideoFile(p)) {
          if (!isPipelineFallbackClip(p) && !(await isMostlyBlackClip(p))) dedup.lastMuskStockClip = p;
          return p;
        }
        dedup.usedCategories.set(category, Math.max(0, (dedup.usedCategories.get(category) ?? 1) - 1));
        continue;
      }
      const transformMs = mustFairUse
        ? Math.max(dedup.perf.transformTimeoutMs, 25_000)
        : dedup.perf.transformTimeoutMs;
      const transformed = await transformClipForFairUse(
        p, beatText, sceneIndex, beatIndex, workDir, transformMs
      );
      if (
        mustFairUse &&
        (!transformed || !transformed.includes("_transformed") || !fs.existsSync(transformed))
      ) {
        dedup.usedCategories.set(category, Math.max(0, (dedup.usedCategories.get(category) ?? 1) - 1));
        continue;
      }
      if (await isValidVideoFile(transformed)) {
        if (!isPipelineFallbackClip(transformed) && !(await isMostlyBlackClip(transformed))) {
          dedup.lastMuskStockClip = transformed;
        }
        return transformed;
      }
      dedup.usedCategories.set(category, Math.max(0, (dedup.usedCategories.get(category) ?? 1) - 1));
      if (mustFairUse) continue;
      if (await isValidVideoFile(p) && !isPipelineFallbackClip(p) && !(await isMostlyBlackClip(p))) {
        dedup.lastMuskStockClip = p;
      }
    }
    return null;
  });
}

async function tryStockSources(
  fetchers: Array<{ query: string; fetch: () => Promise<string[]> }>,
  dedup: VisualDedupState,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  workDir: string,
  logLabel: string,
  adoptOpts: VisualAdoptOptions = {}
): Promise<string | null> {
  const maxFetchers = Math.max(2, dedup.perf.maxStockQueriesPerBeat + 1);
  for (const { query, fetch } of fetchers.slice(0, maxFetchers)) {
    if (isBlockedStockQuery(query)) continue;
    const category = stockVisualCategory(query);
    if (adoptOpts.muskTopic && (category === "rocket" || category === "space") && !isMuskApprovedRocketQuery(query)) {
      continue;
    }
    if (categoryAtLimit(dedup, category, adoptOpts.muskTopic)) continue;
    const fetchMs = dedup.perf.fastStockMode ? 12_000 : 35_000;
    let paths: string[] = [];
    try {
      paths = await withTimeout(fetch(), fetchMs, `${logLabel} fetch s${sceneIndex} b${beatIndex}`);
    } catch {
      continue;
    }
    if (!paths.length) continue;
    const adoptMs = dedup.perf.fastStockMode ? 8_000 : 60_000;
    let clip: string | null = null;
    try {
      clip = await withTimeout(
        adoptClip(paths, dedup, sceneIndex, beatIndex, beatText, workDir, query, adoptOpts),
        adoptMs,
        `${logLabel} adopt s${sceneIndex} b${beatIndex}`
      );
    } catch {
      continue;
    }
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beatIndex}: ${logLabel} "${query}"`);
      return clip;
    }
  }
  return null;
}

/** Guaranteed-unique stock for one beat — Pexels/Pixabay/YouTube with global dedup (no grey, no repeats). */
async function fetchUniqueStockForBeat(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle?: string,
  adoptOpts: VisualAdoptOptions = {}
): Promise<string | null> {
  const wallMs = youtubeSourcingEnabled() && youtubeCcReady()
    ? youtubeBeatFetchTimeoutMs(dedup.perf.fastStockMode) + 8_000
    : dedup.perf.fastStockMode
      ? 24_000
      : 32_000;
  try {
    return await withTimeout(
      fetchUniqueStockForBeatInner(
        beat, scene, workDir, sceneIndex, clipFetchDur, dedup, personName, videoTitle, adoptOpts
      ),
      wallMs,
      `unique stock s${sceneIndex} b${beat.index}`
    );
  } catch {
    return null;
  }
}

async function fetchUniqueStockForBeatInner(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle?: string,
  adoptOpts: VisualAdoptOptions = {}
): Promise<string | null> {
  if (!youtubeCcReady() && !PEXELS_API_KEY && !PIXABAY_API_KEY) return null;
  const perf = dedup.perf;
  const muskTopic = isMuskTeslaTopic(videoTitle, beat.text);
  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const offset = dedup.globalBeatIndex * 11 + sceneIndex * 5 + beat.index * 3;
  const tag = `b${beat.index}_uniq`;
  const looseOpts: VisualAdoptOptions = {
    ...adoptOpts,
    muskTopic,
    requireBeatMatch: false,
    scriptAnchored: false,
    personTopic: dedup.personTopicLock,
    primaryPerson: dedup.primaryPerson || personName,
    keywords: beat.keywords,
    sceneText: scene.text,
    videoTitle,
  };
  const ytMs = youtubeBeatFetchTimeoutMs(perf.fastStockMode);

  const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle);
  let clip = await tryBeatRealYouTubeFootage(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, looseOpts, entityYt, "unique event YouTube", ytMs
  );
  if (clip) return clip;

  const primary = scenePersons[0] ?? personName ?? dedup.primaryPerson;
  if (primary) {
    clip = await tryBeatRealYouTubeFootage(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      looseOpts,
      buildPersonCelebrityVideoQueries(primary, beat.text, beat.index),
      `unique person YouTube (${primary})`,
      ytMs
    );
    if (clip) return clip;
  }

  clip = await tryBeatTopicRealFootage(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    looseOpts,
    videoTitle,
    primary ?? personName,
    { includeTopicYoutube: true, fileTag: tag }
  );
  if (clip) return clip;

  if (!PEXELS_API_KEY && !PIXABAY_API_KEY) return null;
  if (perf.minimizeStockFootage && !canUseLicensedStockBeat(dedup)) return null;

  if (
    !perf.minimizeStockFootage &&
    beat.index % 2 === 1 &&
    beat.index > 0 &&
    (scene.brollQueries?.length ?? 0) > 0 &&
    PEXELS_API_KEY &&
    canUseLicensedStockBeat(dedup)
  ) {
    const brollQ = enrichStockQuery(
      scene.brollQueries![beat.index % scene.brollQueries!.length],
      scene,
      videoTitle,
      personName,
      beat.text
    );
    const brollPaths = await fetchBrollClips(
      [brollQ],
      clipFetchDur,
      workDir,
      sceneIndex,
      dedup.usedPexelsIds
    );
    clip = await adoptClip(
      brollPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      brollQ,
      looseOpts
    );
    if (clip) {
      markLicensedStockBeatUsed(dedup);
      return clip;
    }
  }

  const queryCap = perf.minimizeStockFootage ? 1 : perf.fastStockMode ? 4 : 6;
  const queries = [
    ...buildBeatVisualQueryList(beat.text, scene, videoTitle, scenePersons, queryCap),
    ...(muskTopic ? GOLDEN_MUSK_QUERIES.slice(0, perf.fastStockMode ? 2 : 4) : []),
    enrichStockQuery(scene.pexelsQuery, scene, videoTitle, personName, beat.text),
    stockQueryFromBeatScript(beat.text, scenePersons, scene.text, videoTitle),
    ...(scene.brollQueries ?? []).map((q) =>
      enrichStockQuery(q, scene, videoTitle, personName, beat.text)
    ),
  ].filter(
    (q): q is string => typeof q === "string" && q.trim().length > 2 && !isBlockedStockQuery(q)
  );
  const stockQueries = [...new Set(queries)].slice(
    0,
    perf.minimizeStockFootage ? 1 : perf.fastStockMode ? 3 : 5
  );

  const pexFetch = (query: string, t: string, off: number) => () =>
    fetchPexelsClips(
      query, clipFetchDur, workDir, sceneIndex, perf.fastStockMode ? 2 : 3, [query], true, t,
      dedup.usedPexelsIds, off, dedup.perf.pexelsDownloadRetries
    );
  const pixFetch = (query: string, t: string, off: number) => () =>
    fetchPixabayClips(query, clipFetchDur, workDir, sceneIndex, 2, t, true, dedup.usedPixabayIds, off);

  for (let qi = 0; qi < stockQueries.length; qi++) {
    const q = stockQueries[qi];
    const off = offset + qi * 2;
    if (PEXELS_API_KEY) {
      clip = await tryStockSources(
        [{ query: q, fetch: pexFetch(q, `${tag}_pex`, off) }],
        dedup, sceneIndex, beat.index, beat.text, workDir, "unique Pexels fallback", looseOpts
      );
      if (clip) {
        markLicensedStockBeatUsed(dedup);
        return clip;
      }
    }
    if (PIXABAY_API_KEY) {
      clip = await tryStockSources(
        [{ query: q, fetch: pixFetch(q, `${tag}_pix`, off + 40) }],
        dedup, sceneIndex, beat.index, beat.text, workDir, "unique Pixabay fallback", looseOpts
      );
      if (clip) {
        markLicensedStockBeatUsed(dedup);
        return clip;
      }
    }
  }
  return null;
}

/** Fill a scene that has zero usable clips (never grey placeholders). */
async function recoverSceneClipsIfEmpty(
  scene: Scene,
  workDir: string,
  topicContext: string | undefined,
  dedup: VisualDedupState
): Promise<SceneVisualsResult> {
  const clipFetchDur = 4;
  const scenePersons = resolveScenePersons(scene, topicContext, dedup.primaryPerson || undefined);
  const historicalDoc = isHistoricalDocumentary(topicContext, scene.text) && !dedup.personTopicLock;
  const personName = historicalDoc
    ? ""
    : (scenePersons[0] ?? dedup.primaryPerson ?? extractPrimaryPersonFromTitle(topicContext) ?? "");
  const recoverAdopt: VisualAdoptOptions = {
    muskTopic: isMuskTeslaTopic(topicContext, scene.text),
    personTopic: dedup.personTopicLock,
    primaryPerson: dedup.primaryPerson || personName,
    keywords: buildRelevanceKeywords(scene, scene.text),
    sceneText: scene.text,
    videoTitle: topicContext,
    requireBeatMatch: false,
    scriptAnchored: false,
  };
  const n = Math.max(1, Math.min(4, Math.ceil(scene.duration / VIDRUSH_BEAT_SEC)));
  const clips: string[] = [];
  const beatDurations: number[] = [];

  if (curatedArchiveOnlyVisuals()) {
    const stubPower = extractPowerWordFromSentence(scene.text.slice(0, 220), scenePersons);
    const stubBeat: SceneBeat = {
      index: 0,
      text: scene.text.slice(0, 220),
      searchQuery: enrichStockQuery(stubPower, scene, topicContext, scenePersons[0], scene.text),
      powerWord: stubPower,
      keywords: recoverAdopt.keywords ?? [],
      holdSec: VIDRUSH_BEAT_SEC,
    };
    for (let fi = 0; fi < n + 2; fi++) {
      stubBeat.index = fi;
      const clip = await fetchCuratedArchiveBeatClip(
        stubBeat,
        scene,
        workDir,
        scene.index,
        stubBeat.holdSec,
        dedup.usedCuratedAssetIds,
        dedup.usedCuratedStorageUrls,
        topicContext
      );
      if (!clip || isPipelineFallbackClip(clip)) continue;
      const key = clipContentKey(clip);
      if (clips.some((c) => clipContentKey(c) === key)) continue;
      clips.push(clip);
      beatDurations.push(VIDRUSH_BEAT_SEC);
      if (clips.length >= n) break;
    }
    return { clips, beatDurations };
  }

  const stubPower = extractPowerWordFromSentence(scene.text.slice(0, 220), scenePersons);
  const stubBeat: SceneBeat = {
    index: 0,
    text: scene.text.slice(0, 220),
    searchQuery: enrichStockQuery(stubPower, scene, topicContext, scenePersons[0], scene.text),
    powerWord: stubPower,
    keywords: recoverAdopt.keywords ?? [],
    holdSec: VIDRUSH_BEAT_SEC,
  };
  const realOnly = realFootageFirstEnabled();
  for (let fi = 0; fi < n + 2; fi++) {
    stubBeat.index = fi;
    stubBeat.searchQuery = stockQueryFromBeatScript(
      scene.text.slice(0, 220),
      scenePersons,
      scene.text,
      topicContext
    );
    let clip: string | null = null;
    if (realOnly) {
      clip = await beatPrimaryFetch(
        stubBeat,
        scene,
        workDir,
        scene.index,
        clipFetchDur,
        dedup,
        personName,
        topicContext,
        recoverAdopt,
        scenePersons,
        `rcv${fi}`,
        "recover"
      );
    }
    if (
      !youtubeOnlySourcingEnabled() &&
      (!clip || isPipelineFallbackClip(clip)) &&
      canUseLicensedStockBeat(dedup)
    ) {
      clip = await fetchUniqueStockForBeat(
        stubBeat, scene, workDir, scene.index, clipFetchDur, dedup, personName, topicContext, recoverAdopt
      );
      if (clip && !isPipelineFallbackClip(clip)) markLicensedStockBeatUsed(dedup);
    }
    if (!youtubeOnlySourcingEnabled() && !clip && canUseGlobalStillPhoto(dedup)) {
      clip = await fetchBeatScriptImageClip(
        stubBeat,
        scene,
        workDir,
        scene.index,
        clipFetchDur,
        dedup,
        scenePersons,
        topicContext,
        { ...recoverAdopt, scriptImageFallback: true },
        `rcv${fi}`
      );
    }
    if (
      !youtubeOnlySourcingEnabled() &&
      (!clip || isPipelineFallbackClip(clip)) &&
      canUseGlobalStillPhoto(dedup)
    ) {
      clip = await fetchBeatScriptImageForced(
        stubBeat,
        scene,
        workDir,
        scene.index,
        clipFetchDur,
        dedup,
        scenePersons,
        topicContext,
        `rcv${fi}`
      );
    }
    if ((!clip || isPipelineFallbackClip(clip)) && dedup.perf.enableAiFallback && dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo) {
      clip = await fetchBeatAIClip(
        stubBeat, scene, workDir, scene.index, fi, clipFetchDur, dedup, topicContext
      );
    }
    if (!clip || isPipelineFallbackClip(clip)) continue;
    const key = clipContentKey(clip);
    if (clips.some((c) => clipContentKey(c) === key)) continue;
    clips.push(clip);
    beatDurations.push(VIDRUSH_BEAT_SEC);
    if (clips.length >= n) break;
  }
  return { clips, beatDurations };
}

/** Last-resort real stock video — broad queries, non-strict mode. No still photos. */
async function fetchLastResortRealClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle?: string,
  adoptOpts: VisualAdoptOptions = {}
): Promise<string | null> {
  if (curatedArchiveOnlyVisuals()) {
    return fetchCuratedArchiveBeatClip(
      beat,
      scene,
      workDir,
      sceneIndex,
      beat.holdSec,
      dedup.usedCuratedAssetIds,
      dedup.usedCuratedStorageUrls,
      videoTitle
    );
  }
  const tag = `b${beat.index}_lr`;
  const candidateOffset = beat.index * 5 + sceneIndex + 11;
  const queries = [
    ...scriptStockSearchQueries(beat.text),
    enrichStockQuery(beat.searchQuery, scene, videoTitle, personName, beat.text),
    enrichStockQuery(scene.visualCue, scene, videoTitle, personName, beat.text),
    enrichStockQuery(scene.pexelsQuery, scene, videoTitle, personName, beat.text),
    ...(scene.pexelsQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, personName, beat.text)),
    ...(scene.brollQueries ?? []).map((q) => enrichStockQuery(q, scene, videoTitle, personName, beat.text)),
  ].filter((q): q is string => typeof q === "string" && q.trim().length > 2 && !isBlockedStockQuery(q));

  const uniqueQueries = [...new Set(queries)];

  const ytQueries = [
    ...realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle),
    ...(personName.trim()
      ? buildPersonCelebrityVideoQueries(personName, beat.text, beat.index)
      : []),
  ];
  const ytClip = await tryBeatRealYouTubeFootage(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    adoptOpts,
    ytQueries,
    "last-resort YouTube",
    youtubeBeatFetchTimeoutMs(dedup.perf.fastStockMode)
  );
  if (ytClip) return ytClip;

  const topicReal = await tryBeatTopicRealFootage(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    adoptOpts,
    videoTitle,
    personName,
    { includeTopicYoutube: false, fileTag: tag }
  );
  if (topicReal) return topicReal;

  if ((dedup.perf.minimizeStockFootage || realFootageFirstEnabled()) && !canUseLicensedStockBeat(dedup)) {
    return null;
  }

  const stockTryCap = dedup.perf.minimizeStockFootage
    ? 1
    : dedup.perf.fastStockMode
      ? 4
      : 6;
  for (const q of uniqueQueries.slice(0, stockTryCap)) {
    const pex = await fetchPexelsClips(
      q, clipFetchDur, workDir, sceneIndex, 2, undefined, true, `${tag}_pex`,
      dedup.usedPexelsIds, candidateOffset, dedup.perf.pexelsDownloadRetries
    );
    let clip = await adoptClip(pex, dedup, sceneIndex, beat.index, beat.text, workDir, q, adoptOpts);
    if (clip) {
      markLicensedStockBeatUsed(dedup);
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: last-resort Pexels "${q}"`);
      return clip;
    }

    const pix = await fetchPixabayClips(
      q, clipFetchDur, workDir, sceneIndex, 2, `${tag}_pix`, true,
      dedup.usedPixabayIds, candidateOffset
    );
    clip = await adoptClip(pix, dedup, sceneIndex, beat.index, beat.text, workDir, q, adoptOpts);
    if (clip) {
      markLicensedStockBeatUsed(dedup);
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: last-resort Pixabay "${q}"`);
      return clip;
    }
  }

  return null;
}

/** Real footage of a named person (Pexels video → YouTube → max 1 still). */
async function fetchPersonBeatClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  pexFetch: (query: string, t: string, off: number, count?: number) => () => Promise<string[]>,
  candidateOffset: number,
  tag: string
): Promise<string | null> {
  const personLocked = dedup.personTopicLock && Boolean(dedup.primaryPerson);
  if (!personName.trim()) return null;
  if (!personLocked && !beatMentionsPerson(beat.text, personName)) return null;

  const personQueries = buildPersonCelebrityVideoQueries(personName, beat.text, beat.index);
  const loosePerson: VisualAdoptOptions = {
    ...adoptOpts,
    requireBeatMatch: false,
    personTopic: true,
    primaryPerson: personName,
    keywords: buildPersonBeatRelevanceKeywords(personName, beat.text),
  };

  const fast = dedup.perf.fastStockMode;
  let clip = await tryBeatRealYouTubeFootage(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    loosePerson,
    personQueries,
    `person YouTube (${personName})`,
    youtubeBeatFetchTimeoutMs(fast)
  );
  if (clip) return clip;

  const celebVids = await withTimeout(
    fetchPersonCelebrityVideoClips(
      personName,
      clipFetchDur,
      workDir,
      sceneIndex,
      celebrityFetchFastMode(dedup.perf, scene.duration) ? 2 : 3,
      `${tag}_person`,
      beat.index,
      beat.text,
      celebrityFetchFastMode(dedup.perf, scene.duration)
    ),
    personCelebrityVideoWallMs(dedup.perf, scene.duration),
    `person celebrity video s${sceneIndex} b${beat.index}`
  ).catch(() => [] as CelebrityClipCandidate[]);
  clip = await adoptBestCelebrityClip(
    celebVids,
    dedup,
    sceneIndex,
    beat.index,
    beat.text,
    workDir,
    personName,
    loosePerson
  );
  if (clip && !isStillPhotoClip(clip)) {
    console.log(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: person video Wiki/Sepia/Archive (${personName})`
    );
    return clip;
  }

  if (canUseLicensedStockBeat(dedup)) {
    clip = await tryStockSources(
      [{
        query: `${personName} interview`,
        fetch: pexFetch(`${personName} interview`, `${tag}_person_vid`, candidateOffset, 2),
      }],
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      `person Pexels video (${personName})`,
      loosePerson
    );
    if (clip && !isStillPhotoClip(clip)) {
      markLicensedStockBeatUsed(dedup);
      return clip;
    }
  }

  if (SERPAPI_KEY && canUseGlobalStillPhoto(dedup)) {
    const serpQ = buildPersonSerpQuery(personName, sceneIndex, beat.index, beat.text);
    const serpPaths = await fetchSerpAPIImages(
      serpQ,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_person`,
      {
        dedup,
        personPortrait: true,
        resultOffset: sceneIndex * 2 + beat.index,
      }
    );
    clip = await adoptClip(
      serpPaths, dedup, sceneIndex, beat.index, beat.text, workDir, serpQ, loosePerson
    );
    if (clip) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: SerpAPI portrait (${serpQ})`);
      return clip;
    }
  }

  if (canUseGlobalStillPhoto(dedup)) {
    const ovPaths = await fetchOpenverseImages(
      `${personName} portrait face`,
      clipFetchDur,
      workDir,
      sceneIndex,
      1,
      `${tag}_person`,
      { dedup, personPortrait: true }
    );
    clip = await adoptClip(
      ovPaths, dedup, sceneIndex, beat.index, beat.text, workDir, personName, loosePerson
    );
    if (clip) return clip;
  }

  if (!dedup.perf.minimizeStockFootage && canUseLicensedStockBeat(dedup)) {
    const personPexels = personQueries.slice(0, fast ? 1 : 2);
    clip = await tryStockSources(
      personPexels.map((pq, pi) => ({
        query: pq,
        fetch: pexFetch(pq, `${tag}_person`, candidateOffset + pi, fast ? 1 : 2),
      })),
      dedup, sceneIndex, beat.index, beat.text, workDir, `person Pexels fallback (${personName})`, loosePerson
    );
    if (clip && !isStillPhotoClip(clip)) {
      markLicensedStockBeatUsed(dedup);
      return clip;
    }
  }

  return null;
}

/** Archival real video for historical beats — Wiki → Archive → YouTube CC (no stills/stock). */
async function fetchHistoricalBeatVideo(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  intent: ReturnType<typeof buildMediaSearchIntent>,
  adoptOpts: VisualAdoptOptions,
  tag: string,
  opts: { skipYoutube?: boolean } = {}
): Promise<string | null> {
  const beatKeywords = adoptOpts.keywords ?? beat.keywords;
  const loose: VisualAdoptOptions = { ...adoptOpts, requireBeatMatch: false, scriptAnchored: false };
  const queries = buildHistoricalArchivalQueries(intent, beat.text);
  const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, adoptOpts.videoTitle);
  const queryCap = dedup.perf.fastStockMode ? 2 : 6;
  const allQueries = [...entityYt, ...queries].slice(0, queryCap);
  const archiveHitsPerQuery = dedup.perf.fastStockMode ? 1 : 2;

  if (!opts.skipYoutube && youtubeSourcingEnabled() && youtubeCcReady()) {
    for (const q of allQueries) {
      const ytPaths = await fetchYouTubeCCClips(
        q,
        clipFetchDur,
        workDir,
        sceneIndex,
        1,
        beatKeywords,
        1,
        "",
        {
          beatText: beat.text,
          videoTitle: adoptOpts.videoTitle,
          fastMode: dedup.perf.fastStockMode,
        }
      );
      const ytClip = await adoptClip(
        ytPaths,
        dedup,
        sceneIndex,
        beat.index,
        beat.text,
        workDir,
        q,
        loose
      );
      if (isRealVideoClip(ytClip)) {
        console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: historical YouTube "${q}"`);
        return ytClip;
      }
    }
  }

  for (const q of allQueries) {
    if (dedup.perf.enableArchival) {
      const archiveHits = await fetchInternetArchiveClips(
        q,
        clipFetchDur,
        workDir,
        sceneIndex,
        archiveHitsPerQuery,
        `${tag}_hist`,
        "",
        beatKeywords
      );
      const clip = await adoptClip(
        archiveHits.map((h) => h.path),
        dedup,
        sceneIndex,
        beat.index,
        beat.text,
        workDir,
        q,
        loose
      );
      if (isRealVideoClip(clip)) {
        console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: historical Archive "${q}"`);
        return clip;
      }
    }

    const wikiHits = await fetchWikimediaVideos(
      q,
      clipFetchDur,
      workDir,
      sceneIndex,
      2,
      `${tag}_hist`,
      "",
      beatKeywords
    );
    let clip = await adoptClip(
      wikiHits.map((h) => h.path),
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      q,
      loose
    );
    if (isRealVideoClip(clip)) {
      console.log(`[Pipeline] Scene ${sceneIndex} beat ${beat.index}: historical Wikimedia video "${q}"`);
      return clip;
    }
  }

  return null;
}

/** Last-resort archival video for historical scenes (no SerpAPI/stock stills). */
async function fetchHistoricalBeatRescue(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  tag: string
): Promise<string | null> {
  const intent = buildMediaSearchIntent({
    beatText: beat.text,
    searchQueries: [beat.searchQuery],
    keywords: adoptOpts.keywords ?? beat.keywords,
    primaryPerson: "",
    persons: [],
    videoTitle,
    powerWord: beat.powerWord,
    personTopicLock: false,
    spaceTopic: false,
    muskTopic: adoptOpts.muskTopic ?? false,
  });
  return fetchHistoricalBeatVideo(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    intent,
    { ...adoptOpts, requireBeatMatch: false, scriptAnchored: false },
    tag
  );
}

/**
 * Universal media research (Laag 2+3): parallel multi-source fetch, rank, adopt best clip.
 * Falls through to the legacy waterfall when nothing passes adoption gates.
 */
async function researchBeatClipUnified(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  beatQueries: string[],
  scenePersons: string[],
  primary: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  tag: string,
  muskTopic: boolean,
  pexFetch: (query: string, t: string, off: number, count?: number) => () => Promise<string[]>,
  candidateOffset: number
): Promise<string | null> {
  if (process.env.ENABLE_MEDIA_RESEARCH === "false") return null;

  const perf = dedup.perf;
  const spaceTopic = isSpaceRelatedTopic(
    scene.visualCue,
    scene.pexelsQuery,
    beat.text,
    scene.text,
    videoTitle ?? "",
    beat.powerWord
  );

  const historicalCtx =
    isHistoricalDocumentary(videoTitle, beat.text, scene.text) && !dedup.personTopicLock;
  const effectivePrimary = historicalCtx ? "" : (primary?.trim() ?? "");

  const intent = buildMediaSearchIntent({
    beatText: beat.text,
    searchQueries: beatQueries,
    keywords: adoptOpts.keywords ?? beat.keywords,
    primaryPerson: effectivePrimary,
    persons: scenePersons,
    videoTitle,
    powerWord: beat.powerWord,
    personTopicLock: dedup.personTopicLock && !historicalCtx,
    spaceTopic,
    muskTopic,
  });

  const archivalFirst = prefersRealFootageOnly(intent);
  const realOnly = realFootageFirstEnabled();

  if (archivalFirst || realOnly) {
    if (youtubeSourcingEnabled()) {
      const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle);
      const ytFirstQueries = [
        ...entityYt,
        ...buildTopicDocumentaryYoutubeQueries(beat, scene, videoTitle),
        ...(effectivePrimary.trim()
          ? buildPersonCelebrityVideoQueries(effectivePrimary, beat.text, beat.index)
          : []),
      ];
      const ytFirst = await tryBeatRealYouTubeFootage(
        beat,
        scene,
        workDir,
        sceneIndex,
        clipFetchDur,
        dedup,
        { ...adoptOpts, requireBeatMatch: false, scriptAnchored: false },
        [...new Set(ytFirstQueries.filter((q) => q.trim().length > 3))].slice(0, 6),
        "research YouTube first",
        youtubeBeatFetchTimeoutMs(perf.fastStockMode)
      );
      if (ytFirst && isAuthenticVideoClip(ytFirst)) return ytFirst;
    } else {
      const histFirst = await fetchHistoricalBeatVideo(
        beat,
        scene,
        workDir,
        sceneIndex,
        clipFetchDur,
        dedup,
        intent,
        adoptOpts,
        tag,
        { skipYoutube: true }
      );
      if (histFirst && isAuthenticVideoClip(histFirst)) return histFirst;
    }
  }

  if (archivalFirst) {
    const histClip = await fetchHistoricalBeatVideo(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      intent,
      adoptOpts,
      tag,
      { skipYoutube: true }
    );
    if (histClip && isAuthenticVideoClip(histClip)) return histClip;
  }

  const queries = archivalFirst
    ? buildHistoricalArchivalQueries(intent, beat.text).slice(0, perf.fastStockMode ? 4 : 6)
    : intent.searchQueries.slice(0, perf.fastStockMode ? 2 : 4);
  const primaryQ = queries[0] || beat.searchQuery || beat.powerWord;
  const beatKeywords = adoptOpts.keywords ?? beat.keywords;
  const entityRules = extractBeatRealEntities(beat.text, scene.text, videoTitle ?? "");
  const fetchMs = archivalFirst
    ? (perf.fastStockMode ? 40_000 : 45_000)
    : (perf.fastStockMode ? 18_000 : 35_000);
  const maxTasks = archivalFirst
    ? (perf.fastStockMode ? 14 : 18)
    : (perf.fastStockMode ? 10 : 18);

  const toCandidates = (
    paths: string[],
    query: string,
    source: MediaSourceKind,
    isVideo: boolean
  ): MediaCandidate[] =>
    paths.filter(Boolean).map((p) => ({ path: p, query, source, isVideo }));

  type ResearchTask = { run: () => Promise<MediaCandidate[]> };
  const ytTasks: ResearchTask[] = [];
  const tasks: ResearchTask[] = [];

  const ytAvailable =
    youtubeSourcingEnabled() &&
    (process.env.YOUTUBE_API_KEY || RAPIDAPI_KEY || process.env.YOUTUBE_CC_DL_SERVICE);
  if (ytAvailable) {
    const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle);
    if (
      entityYt.length > 0 &&
      dedup.entityYoutubeFetchesUsed < perf.maxEntityYoutubePerVideo
    ) {
      const eq = entityYt[0];
      ytTasks.push({
        run: async () => {
          dedup.entityYoutubeFetchesUsed++;
          const paths = await fetchYouTubeCCClips(
            entityYt.slice(0, 2),
            clipFetchDur,
            workDir,
            sceneIndex,
            1,
            beatKeywords,
            1,
            primary ?? "",
            {
              beatText: beat.text,
              videoTitle,
              fastMode: perf.fastStockMode,
            }
          );
          return toCandidates(paths, eq, "youtube_cc", true);
        },
      });
    }

    const ytQueries = primary?.trim()
      ? buildPersonCelebrityVideoQueries(primary, beat.text, beat.index).slice(0, 2)
      : queries.slice(0, 2);
    for (const q of ytQueries) {
      ytTasks.push({
        run: async () => {
          const paths = await fetchYouTubeCCClips(
            q,
            clipFetchDur,
            workDir,
            sceneIndex,
            1,
            beatKeywords,
            1,
            primary ?? "",
            {
              beatText: beat.text,
              videoTitle,
              fastMode: perf.fastStockMode,
            }
          );
          return toCandidates(paths, q, "youtube_cc", true);
        },
      });
    }
  }

  if (effectivePrimary) {
    tasks.push({
      run: async () => {
        const fast = celebrityFetchFastMode(perf, scene.duration);
        const hits = await fetchPersonCelebrityVideoClips(
          effectivePrimary,
          clipFetchDur,
          workDir,
          sceneIndex,
          fast ? 2 : 3,
          `${tag}_research`,
          beat.index,
          beat.text,
          fast
        );
        return hits.map((h) => ({
          path: h.path,
          query: h.query,
          source: "person_celebrity" as const,
          isVideo: true,
        }));
      },
    });
  }

  const querySlice = archivalFirst ? queries.slice(0, 4) : queries.slice(0, 2);
  for (const q of querySlice) {
    tasks.push({
      run: async () => {
        const hits = await fetchWikimediaVideos(
          q,
          clipFetchDur,
          workDir,
          sceneIndex,
          archivalFirst ? 3 : 2,
          `${tag}_research`,
          primary ?? "",
          beatKeywords
        );
        return hits.map((h) => ({
          path: h.path,
          query: h.query,
          source: "wikimedia_video" as const,
          isVideo: true,
        }));
      },
    });

    if (perf.enableArchival) {
      tasks.push({
        run: async () => {
          const hits = await fetchInternetArchiveClips(
            q,
            clipFetchDur,
            workDir,
            sceneIndex,
            2,
            `${tag}_research`,
            primary ?? "",
            beatKeywords
          );
          return hits.map((h) => ({
            path: h.path,
            query: h.query,
            source: "internet_archive" as const,
            isVideo: true,
          }));
        },
      });
    }
  }

  const allResearchTasks = [...ytTasks, ...tasks];

  if (
    EUROPEANA_API_KEY?.trim() &&
    (intent.topicKind === "historical" || intent.topicKind === "news")
  ) {
    tasks.push({
      run: async () => {
        const hits = await fetchEuropeanaVideos(
          queries.slice(0, 2),
          clipFetchDur,
          workDir,
          sceneIndex,
          2,
          `${tag}_research`,
          primary ?? "",
          beatKeywords
        );
        return hits.map((h) => ({
          path: h.path,
          query: h.query,
          source: "europeana" as const,
          isVideo: true,
        }));
      },
    });
  }

  if (perf.enableNasa && spaceTopic && primaryQ) {
    tasks.push({
      run: async () => {
        const paths = await fetchNasaVideoClips(primaryQ, clipFetchDur, workDir, sceneIndex, 1);
        return toCandidates(paths, primaryQ, "nasa", true);
      },
    });
  }

  if (!archivalFirst && !dedup.personTopicLock) {
    tasks.push({
      run: async () => {
        const imgs = await fetchWikimediaImages(
          primaryQ,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          `${tag}_research`
        );
        return toCandidates(imgs, primaryQ, "wikimedia_image", false);
      },
    });
    tasks.push({
      run: async () => {
        const ovQuery = primary?.trim() ? `${primary} ${primaryQ}` : primaryQ;
        const paths = await fetchOpenverseImages(
          ovQuery,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          `${tag}_research`,
          { dedup, personPortrait: Boolean(primary?.trim()) }
        );
        return toCandidates(paths, ovQuery, "openverse", false);
      },
    });
    if (UNSPLASH_ACCESS_KEY?.trim()) {
      tasks.push({
        run: async () => {
          const unsplashQ = primary?.trim() ? `${primary} ${primaryQ}` : primaryQ;
          const paths = await fetchUnsplashImages(
            unsplashQ,
            clipFetchDur,
            workDir,
            sceneIndex,
            1,
            `${tag}_research`,
            { dedup, personPortrait: Boolean(primary?.trim()) }
          );
          return toCandidates(paths, unsplashQ, "unsplash", false);
        },
      });
    }
  }

  const allowStill =
    !archivalFirst &&
    (dedup.stillPhotosMaxThisScene === 0
      ? canUseGlobalStillPhoto(dedup)
      : dedup.stillPhotosThisScene < dedup.stillPhotosMaxThisScene);

  if (!archivalFirst && SERPAPI_KEY && allowStill && canUseGlobalStillPhoto(dedup)) {
    const serpQ = primary?.trim()
      ? buildPersonSerpQuery(primary, sceneIndex, beat.index, beat.text)
      : (primaryQ || beat.powerWord);
    tasks.push({
      run: async () => {
        const paths = await fetchSerpAPIImages(
          serpQ,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          `${tag}_research`,
          {
            dedup,
            personPortrait: Boolean(primary?.trim()) || dedup.personTopicLock,
            resultOffset: sceneIndex * 2 + beat.index,
          }
        );
        return toCandidates(paths, serpQ, "serpapi", false);
      },
    });
  }

  if (!archivalFirst && process.env.YOUTUBE_API_KEY && allowStill && canUseGlobalStillPhoto(dedup)) {
    const thumbQ =
      buildTopicDocumentaryYoutubeQueries(beat, scene, videoTitle)[0] ||
      queries[0] ||
      primaryQ;
    tasks.push({
      run: async () => {
        const paths = await fetchYouTubeThumbnails(
          thumbQ,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          `${tag}_research`
        );
        return toCandidates(paths, thumbQ, "youtube_cc", false);
      },
    });
  }

  const allowStock =
    !realOnly &&
    ((intent.personTopicLock && effectivePrimary)
      ? true
      : !perf.minimizeStockFootage && canUseLicensedStockBeat(dedup));

  if (!archivalFirst && allowStock) {
    if (intent.personTopicLock && primary?.trim()) {
      tasks.push({
        run: async () => {
          const personQueries = buildPersonStockVideoQueries(primary, beat, scene, videoTitle).slice(0, 3);
          const out: MediaCandidate[] = [];
          for (const q of personQueries) {
            if (PEXELS_API_KEY) {
              const pex = await fetchPexelsClips(
                q,
                clipFetchDur,
                workDir,
                sceneIndex,
                1,
                undefined,
                true,
                `${tag}_research`,
                dedup.usedPexelsIds,
                candidateOffset,
                perf.pexelsDownloadRetries
              );
              out.push(...toCandidates(pex, q, "pexels", true));
            }
            if (PIXABAY_API_KEY) {
              const pix = await fetchPixabayClips(
                q,
                clipFetchDur,
                workDir,
                sceneIndex,
                1,
                `${tag}_research`,
                true,
                dedup.usedPixabayIds,
                candidateOffset
              );
              out.push(...toCandidates(pix, q, "pixabay", true));
            }
          }
          return out;
        },
      });
    } else {
      for (const q of queries.slice(0, 2)) {
        if (PEXELS_API_KEY) {
          tasks.push({
            run: async () => {
              const paths = await pexFetch(q, `${tag}_research`, candidateOffset, muskTopic ? 2 : 1)();
              return toCandidates(paths, q, "pexels", true);
            },
          });
        }
        if (PIXABAY_API_KEY) {
          tasks.push({
            run: async () => {
              const paths = await fetchPixabayClips(
                q,
                clipFetchDur,
                workDir,
                sceneIndex,
                1,
                `${tag}_research`,
                true,
                dedup.usedPixabayIds,
                candidateOffset
              );
              return toCandidates(paths, q, "pixabay", true);
            },
          });
        }
      }
    }
  }

  const researchMs = archivalFirst
    ? (perf.fastStockMode ? 95_000 : 110_000)
    : (perf.fastStockMode ? 50_000 : 100_000);
  let allCandidates: MediaCandidate[] = [];

  try {
    const settled = await withTimeout(
      Promise.allSettled(
        allResearchTasks.slice(0, maxTasks).map((task) =>
          withTimeout(task.run(), fetchMs, `media research s${sceneIndex} b${beat.index}`).catch(
            () => [] as MediaCandidate[]
          )
        )
      ),
      researchMs,
      `media research s${sceneIndex} b${beat.index}`
    );
    for (const result of settled) {
      if (result.status === "fulfilled") allCandidates.push(...result.value);
    }
  } catch {
    return null;
  }

  if (!allCandidates.length) return null;

  const enrichScore = (c: MediaCandidate, base: number) =>
    base +
    scoreBeatNarrationMatch(beat.text, c.query, c.path) * 4 +
    realEntityScore(entityRules, c.query, c.path) +
    (primary && textMentionsPersonName(`${c.query} ${path.basename(c.path)}`, primary) ? 5 : 0) +
    (muskTopic ? muskBrandScore(c.query, c.path) : 0);

  let ranked = rankMediaCandidates(allCandidates, intent, enrichScore);
  ranked = await applyAiRelevanceRanking(ranked, intent, {
    fastMode: perf.fastStockMode,
    timeoutMs: perf.fastStockMode ? 8_000 : 14_000,
  });
  const adoptMs = perf.fastStockMode ? 12_000 : 45_000;
  const topN = perf.fastStockMode ? 12 : 20;
  const { videoFirst, stillFallback, stockFallback } = partitionCandidatesForIntent(ranked, intent);
  const adoptPools = archivalFirst
    ? realOnly
      ? [videoFirst]
      : [videoFirst, stillFallback, stockFallback]
    : [ranked];

  for (const pool of adoptPools) {
    if (!pool.length) continue;
    for (const candidate of pool.slice(0, topN)) {
      let clip: string | null = null;
      try {
        clip = await withTimeout(
          adoptClip(
            [candidate.path],
            dedup,
            sceneIndex,
            beat.index,
            beat.text,
            workDir,
            candidate.query,
            adoptOpts
          ),
          adoptMs,
          `media research adopt s${sceneIndex} b${beat.index}`
        );
      } catch {
        continue;
      }
      if (!clip) continue;
      if (archivalFirst && pool === videoFirst && !isAuthenticVideoClip(clip)) continue;
      if (archivalFirst && pool === stillFallback && !isStillPhotoClip(clip) && !isAuthenticVideoClip(clip)) {
        continue;
      }
      if (candidate.source === "pexels" || candidate.source === "pixabay") {
        if (!canUseLicensedStockBeat(dedup)) continue;
        markLicensedStockBeatUsed(dedup);
      }
      console.log(
        `[MediaResearch] Scene ${sceneIndex} beat ${beat.index}: ${candidate.source} "${candidate.query}" (score ${candidate.score})`
      );
      return clip;
    }
  }

  return null;
}

/** Script-anchored clip fetch: real footage first; licensed stock only when minimize is off or cap allows later. */
async function fetchBeatClipFromScript(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  pexFetch: (query: string, t: string, off: number, count?: number) => () => Promise<string[]>,
  candidateOffset: number,
  tag: string,
  muskTopic: boolean
): Promise<string | null> {
  const perf = dedup.perf;
  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const historicalDoc =
    isHistoricalDocumentary(videoTitle, scene.text, beat.text) && !dedup.personTopicLock;
  const primary = historicalDoc
    ? ""
    : (scenePersons[0] ?? personName ?? dedup.primaryPerson ?? "");
  const maxQ = perf.fastStockMode ? Math.min(3, perf.maxStockQueriesPerBeat) : perf.maxStockQueriesPerBeat;
  const beatQueries = buildBeatVisualQueryList(beat.text, scene, videoTitle, scenePersons, maxQ);
  const ytMs = youtubeBeatFetchTimeoutMs(perf.fastStockMode);

  let clip: string | null = null;

  if (realFootageFirstEnabled()) {
    const primary = await beatPrimaryFetch(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      primary ?? personName,
      videoTitle,
      adoptOpts,
      scenePersons,
      `${tag}_primary`,
      "script primary"
    );
    if (primary) return primary;

    clip = await fetchBeatAuthenticVideo(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      videoTitle,
      adoptOpts,
      scenePersons,
      primary ?? personName,
      `${tag}_auth`
    );
    if (clip) return clip;
  }

  clip = await researchBeatClipUnified(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    beatQueries,
    scenePersons,
    primary ?? "",
    videoTitle,
    adoptOpts,
    tag,
    muskTopic,
    pexFetch,
    candidateOffset
  );
  if (clip && realFootageFirstEnabled()) {
    if (isLicensedStockClip(clip)) clip = null;
    else if (isAuthenticVideoClip(clip) || !isPipelineFallbackClip(clip)) return clip;
  } else if (clip) {
    return clip;
  }

  const legacyEngine = process.env.ENABLE_MEDIA_RESEARCH === "false";

  if (!legacyEngine) {
    if (
      muskTopic &&
      perf.enableMuskHeroFetch &&
      !dedup.muskHeroFetchUsed &&
      beat.index === 0 &&
      sceneIndex === 0
    ) {
      dedup.muskHeroFetchUsed = true;
      clip = await tryBeatRealYouTubeFootage(
        beat,
        scene,
        workDir,
        sceneIndex,
        clipFetchDur,
        dedup,
        { ...adoptOpts, requireMuskBrand: false },
        HERO_YOUTUBE_QUERIES,
        "hero YouTube",
        ytMs
      );
      if (clip) return clip;
    }

    if (canUseLicensedStockBeat(dedup)) {
      clip = await fetchBeatStockFallback(
        beat,
        scene,
        workDir,
        sceneIndex,
        clipFetchDur,
        dedup,
        personName,
        videoTitle,
        adoptOpts,
        "post-authentic"
      );
      if (clip) return clip;
    }

    if (
      beat.index % 2 === 1 &&
      beat.index > 0 &&
      (scene.brollQueries?.length ?? 0) > 0 &&
      PEXELS_API_KEY &&
      canUseLicensedStockBeat(dedup)
    ) {
      const brollQ = enrichStockQuery(
        scene.brollQueries![beat.index % scene.brollQueries!.length],
        scene,
        videoTitle,
        primary ?? personName,
        beat.text
      );
      const brollPaths = await fetchBrollClips(
        [brollQ],
        clipFetchDur,
        workDir,
        sceneIndex,
        dedup.usedPexelsIds
      );
      clip = await adoptClip(
        brollPaths,
        dedup,
        sceneIndex,
        beat.index,
        beat.text,
        workDir,
        brollQ,
        adoptOpts
      );
      if (clip) {
        markLicensedStockBeatUsed(dedup);
        return clip;
      }
    }

    return null;
  }

  // Legacy waterfall — only when ENABLE_MEDIA_RESEARCH=false
  const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle);
  clip = await tryBeatRealYouTubeFootage(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, adoptOpts, entityYt, "event YouTube", ytMs
  );
  if (clip) return clip;

  if (
    muskTopic &&
    perf.enableMuskHeroFetch &&
    !dedup.muskHeroFetchUsed &&
    beat.index === 0 &&
    sceneIndex === 0
  ) {
    dedup.muskHeroFetchUsed = true;
    clip = await tryBeatRealYouTubeFootage(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      { ...adoptOpts, requireMuskBrand: false },
      HERO_YOUTUBE_QUERIES,
      "hero YouTube",
      ytMs
    );
    if (clip) return clip;
  }

  if (primary) {
    clip = await fetchPersonBeatClip(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      primary,
      videoTitle,
      adoptOpts,
      pexFetch,
      candidateOffset,
      tag
    );
    if (clip) return clip;
  }

  clip = await tryBeatTopicRealFootage(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    adoptOpts,
    videoTitle,
    primary ?? personName,
    { includeTopicYoutube: true, fileTag: tag }
  );
  if (clip) return clip;

  if (
    !perf.minimizeStockFootage &&
    beat.index % 2 === 1 &&
    beat.index > 0 &&
    (scene.brollQueries?.length ?? 0) > 0 &&
    PEXELS_API_KEY &&
    canUseLicensedStockBeat(dedup)
  ) {
    const brollQ = enrichStockQuery(
      scene.brollQueries![beat.index % scene.brollQueries!.length],
      scene,
      videoTitle,
      primary ?? personName,
      beat.text
    );
    const brollPaths = await fetchBrollClips(
      [brollQ],
      clipFetchDur,
      workDir,
      sceneIndex,
      dedup.usedPexelsIds
    );
    clip = await adoptClip(
      brollPaths,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      brollQ,
      adoptOpts
    );
    if (clip) {
      markLicensedStockBeatUsed(dedup);
      return clip;
    }
  }

  if (canUseLicensedStockBeat(dedup)) {
    clip = await fetchBeatStockFallback(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      personName,
      videoTitle,
      adoptOpts,
      "legacy stock"
    );
    if (clip) return clip;
  }

  return null;
}

async function fetchBeatClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  spaceTopic: boolean,
  personName: string,
  videoTitle?: string
): Promise<string | null> {
  if (curatedArchiveOnlyVisuals()) {
    return fetchCuratedArchiveBeatClip(
      beat,
      scene,
      workDir,
      sceneIndex,
      beat.holdSec,
      dedup.usedCuratedAssetIds,
      dedup.usedCuratedStorageUrls,
      videoTitle
    );
  }
  const tag = `b${beat.index}`;
  const candidateOffset = beat.index * 3 + sceneIndex + dedup.globalBeatIndex;
  const muskTopic = isMuskTeslaTopic(videoTitle, scene.text);
  const perf = dedup.perf;
  const adoptOpts: VisualAdoptOptions = {
    muskTopic,
    personTopic: dedup.personTopicLock,
    primaryPerson: dedup.primaryPerson || personName,
    keywords: beat.keywords,
    sceneText: scene.text,
    videoTitle,
    requireBeatMatch: false,
    requireMuskBrand: false,
    scriptAnchored: perf.scriptOnlyVisuals,
  };

  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const maxQ = perf.maxStockQueriesPerBeat;
  let q = stockQueryFromBeatScript(beat.text, scenePersons, scene.text, videoTitle);
  if (isBlockedStockQuery(q)) {
    q = stockQueryFromBeatScript(beat.text, scenePersons, scene.text, videoTitle);
  }

  const pexCount = muskTopic ? 4 : 2;
  const pexFetch = (query: string, t: string, off: number, count = pexCount) =>
    () => fetchPexelsClips(
      query, clipFetchDur, workDir, sceneIndex, count, [query], true, t,
      dedup.usedPexelsIds, off, perf.pexelsDownloadRetries
    );
  const pixFetch = (query: string, t: string, off: number) =>
    () => fetchPixabayClips(query, clipFetchDur, workDir, sceneIndex, 2, t, true, dedup.usedPixabayIds, off);
  const brollFetch = (query: string) =>
    () => fetchBrollClips([query], clipFetchDur, workDir, sceneIndex, dedup.usedPexelsIds);

  let clip: string | null = await fetchBeatClipFromScript(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    adoptOpts,
    pexFetch,
    candidateOffset,
    tag,
    muskTopic
  );
  if (clip) {
    dedup.globalBeatIndex++;
    return clip;
  }

  if (realFootageFirstEnabled()) {
    const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
    clip = await fetchBeatAuthenticVideo(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      videoTitle,
      {
        muskTopic: isMuskTeslaTopic(videoTitle, scene.text),
        personTopic: dedup.personTopicLock,
        primaryPerson: dedup.primaryPerson || personName,
        keywords: beat.keywords,
        sceneText: scene.text,
        videoTitle,
        requireBeatMatch: false,
      },
      scenePersons,
      personName,
      `${tag}_auth`
    );
    if (clip) {
      dedup.globalBeatIndex++;
      return clip;
    }
  }

  if (perf.scriptOnlyVisuals) {
    if (perf.enableAiFallback) {
      const ai = await fetchBeatAIClip(
        beat, scene, workDir, sceneIndex, beat.index, clipFetchDur, dedup, videoTitle
      );
      if (ai) {
        dedup.globalBeatIndex++;
        return ai;
      }
    }
    if (canUseLicensedStockBeat(dedup)) {
      const extra = await fetchUniqueStockForBeat(
        beat, scene, workDir, sceneIndex, clipFetchDur, dedup, personName, videoTitle, adoptOpts
      );
      if (extra) {
        markLicensedStockBeatUsed(dedup);
        dedup.globalBeatIndex++;
        return extra;
      }
    }
    dedup.globalBeatIndex++;
    return null;
  }

  // 0a) Hero beat: YouTube CC + NASA for recognizable SpaceX/Tesla (once per video)
  if (
    muskTopic &&
    perf.enableMuskHeroFetch &&
    !dedup.muskHeroFetchUsed &&
    beat.index === 0 &&
    sceneIndex === 0
  ) {
    const heroKw = [...MUSK_TOPIC_TOKENS, ...beat.keywords];
    const heroOpts = { ...adoptOpts, requireMuskBrand: true };
    clip = await tryStockSources(
      [
        {
          query: "SpaceX Falcon 9 launch",
          fetch: () =>
            fetchYouTubeCCClips(HERO_YOUTUBE_QUERIES, clipFetchDur, workDir, sceneIndex, 1, heroKw, 2, "", {
              beatText: beat.text,
              videoTitle,
              fastMode: perf.fastStockMode,
            }),
        },
        {
          query: "SpaceX Starship",
          fetch: () => fetchNasaVideoClips("SpaceX Starship launch", clipFetchDur, workDir, sceneIndex, 1),
        },
        ...HERO_MUSK_QUERIES.map((hq, hi) => ({
          query: hq,
          fetch: pexFetch(hq, `${tag}_hero`, candidateOffset + hi, 6),
        })),
        ...HERO_MUSK_QUERIES.slice(0, 3).map((hq, hi) => ({
          query: hq,
          fetch: pixFetch(hq, `${tag}_hero_px`, candidateOffset + hi + 20),
        })),
      ],
      dedup, sceneIndex, beat.index, beat.text, workDir, "hero", heroOpts
    );
    if (clip) {
      dedup.muskHeroFetchUsed = true;
      dedup.globalBeatIndex++;
      return clip;
    }
    dedup.muskHeroFetchUsed = true;
  }

  // 0) Opening beat when hero waterfall missed (scene 0 only; hero returns early on success)
  if (!clip && beat.index === 0 && sceneIndex === 0 && muskTopic) {
    const heroOpts = { ...adoptOpts, requireMuskBrand: true };
    clip = await tryStockSources(
      OPENING_MUSK_QUERIES.map((oq, oi) => ({
        query: oq,
        fetch: pexFetch(oq, `${tag}_open`, candidateOffset + oi, 4),
      })),
      dedup, sceneIndex, beat.index, beat.text, workDir, "opening", heroOpts
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 1a) Real-world YouTube CC — only when this beat names the entity (capped per video; slow)
  const entityYt = realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle);
  if (
    entityYt.length > 0 &&
    dedup.entityYoutubeFetchesUsed < dedup.perf.maxEntityYoutubePerVideo &&
    (process.env.YOUTUBE_API_KEY || RAPIDAPI_KEY || process.env.YOUTUBE_CC_DL_SERVICE)
  ) {
    dedup.entityYoutubeFetchesUsed++;
    clip = await tryStockSources(
      [{
        query: entityYt[0],
        fetch: () =>
          fetchYouTubeCCClips(entityYt.slice(0, 2), clipFetchDur, workDir, sceneIndex, 1, beat.keywords, 1, "", {
            beatText: beat.text,
            videoTitle,
            fastMode: perf.fastStockMode,
          }),
      }],
      dedup, sceneIndex, beat.index, beat.text, workDir, "real-event YouTube", adoptOpts
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  if (perf.enableArchival) {
    clip = await tryStockSources(
      [
        {
          query: q,
          fetch: async () =>
            (await fetchInternetArchiveClips(q, clipFetchDur, workDir, sceneIndex, 1, tag)).map((c) => c.path),
        },
        {
          query: q,
          fetch: () =>
            fetchYouTubeCCClips(q, clipFetchDur, workDir, sceneIndex, 1, beat.keywords, 2, "", {
              beatText: beat.text,
              videoTitle,
              fastMode: perf.fastStockMode,
            }),
        },
      ],
      dedup, sceneIndex, beat.index, beat.text, workDir, "archival early", adoptOpts
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 2) Licensed stock — only after authentic sources above
  const topicQueries = buildTopicAnchoredQueries(scene, videoTitle, personName, videoTitle, beat.text);
  if (canUseLicensedStockBeat(dedup)) {
    clip = await tryStockSources(
      topicQueries.slice(0, perf.maxTopicQueries).map((tq, ti) => ({
        query: tq,
        fetch: pexFetch(tq, `${tag}_topic`, candidateOffset + ti, 2),
      })),
      dedup, sceneIndex, beat.index, beat.text, workDir, "topic Pexels", adoptOpts
    );
    if (clip) {
      markLicensedStockBeatUsed(dedup);
      dedup.globalBeatIndex++;
      return clip;
    }
  }

  // 3) Golden pool fallback for Musk when beat-specific search missed
  if (muskTopic) {
    const golden = GOLDEN_MUSK_QUERIES[dedup.globalBeatIndex % GOLDEN_MUSK_QUERIES.length];
    const goldenCat = stockVisualCategory(golden);
    const goldenFetchers: Array<{ query: string; fetch: () => Promise<string[]> }> = [];
    if (perf.enableNasa && spaceTopic && goldenCat === "rocket" && (dedup.usedCategories.get("rocket") ?? 0) === 0) {
      goldenFetchers.push({
        query: golden,
        fetch: () => fetchNasaVideoClips(golden, clipFetchDur, workDir, sceneIndex, 1),
      });
    }
    goldenFetchers.push({ query: golden, fetch: pexFetch(golden, `${tag}_golden`, candidateOffset + 1) });
    goldenFetchers.push({ query: golden, fetch: pixFetch(golden, `${tag}_golden`, candidateOffset + 1) });
    clip = await tryStockSources(goldenFetchers, dedup, sceneIndex, beat.index, beat.text, workDir, "golden", adoptOpts);
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 4) Dedicated B-roll cutaways on odd beats
  if (beat.index % 2 === 1 && beat.index > 0 && (scene.brollQueries?.length ?? 0) > 0) {
    const brollQ = enrichStockQuery(
      scene.brollQueries![beat.index % scene.brollQueries!.length],
      scene, videoTitle, personName
    );
    clip = await tryStockSources(
      [{ query: brollQ, fetch: brollFetch(brollQ) }],
      dedup, sceneIndex, beat.index, beat.text, workDir, "B-roll", adoptOpts
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 5) Pixabay + archival sources (archival only when Pexels/Pixabay exhausted)
  clip = await tryStockSources(
    [{ query: q, fetch: pixFetch(q, `${tag}_pix`, candidateOffset) }],
    dedup, sceneIndex, beat.index, beat.text, workDir, "Pixabay", adoptOpts
  );
  if (clip) { dedup.globalBeatIndex++; return clip; }

  if (perf.enableNasa && spaceTopic && stockVisualCategory(q) === "rocket") {
    clip = await tryStockSources(
      [{ query: q, fetch: () => fetchNasaVideoClips(q, clipFetchDur, workDir, sceneIndex, 1) }],
      dedup, sceneIndex, beat.index, beat.text, workDir, "NASA", adoptOpts
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  if (perf.enableArchival) {
    clip = await tryStockSources(
      [
        {
          query: q,
          fetch: async () =>
            (await fetchInternetArchiveClips(q, clipFetchDur, workDir, sceneIndex, 1, tag)).map((c) => c.path),
        },
        {
          query: q,
          fetch: () =>
            fetchYouTubeCCClips(q, clipFetchDur, workDir, sceneIndex, 1, beat.keywords, 2, "", {
              beatText: beat.text,
              videoTitle,
              fastMode: perf.fastStockMode,
            }),
        },
      ],
      dedup, sceneIndex, beat.index, beat.text, workDir, "archival", adoptOpts
    );
    if (clip) { dedup.globalBeatIndex++; return clip; }
  }

  // 6) Scene fallback queries
  const fallbackQueries = [
    scene.visualCue,
    scene.pexelsQuery,
    ...(scene.pexelsQueries ?? []),
  ].filter((fq): fq is string => typeof fq === "string" && fq.trim().length > 2 && fq !== q && !isBlockedStockQuery(fq));

  const looseAdopt: VisualAdoptOptions = { ...adoptOpts, requireBeatMatch: false };
  clip = await tryStockSources(
    fallbackQueries.map((fq, fi) => ({ query: fq, fetch: pexFetch(fq, `${tag}_fb`, candidateOffset + fi, 1) })),
    dedup, sceneIndex, beat.index, beat.text, workDir, "fallback Pexels", looseAdopt
  );
  if (clip) { dedup.globalBeatIndex++; return clip; }

  const lastResort = await fetchLastResortRealClip(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, personName, videoTitle, looseAdopt
  );
  if (lastResort) {
    dedup.globalBeatIndex++;
    return lastResort;
  }

  if (perf.enableAiFallback && (!personName || !beatMentionsPerson(beat.text, personName))) {
    clip = await fetchBeatAIClip(
      beat, scene, workDir, sceneIndex, beat.index, clipFetchDur, dedup, videoTitle
    );
  }
  dedup.globalBeatIndex++;
  return clip;
}

/** Stock queries that always include the named person (VidRush person-docs). */
function buildPersonStockVideoQueries(
  personName: string,
  beat: SceneBeat,
  scene: Scene,
  videoTitle?: string
): string[] {
  const persons = [personName];
  const out = [
    `${personName} interview`,
    `${personName} red carpet`,
    `${personName} talk show`,
    `${personName} makeup brand`,
    ...buildPersonCelebrityVideoQueries(personName, beat.text, beat.index).slice(0, 5),
    ...scriptEventSearchQueries(beat.text, persons),
  ].filter((q) => q.trim().length > 3 && !isBlockedStockQuery(q));
  return [...new Set(out)].slice(0, 6);
}

/** Pexels/Pixabay with person name in every query — no generic b-roll for celebrity topics. */
async function fetchBeatPersonStockVideo(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  reason: string
): Promise<string | null> {
  if (!personName.trim()) return null;
  const personAdopt: VisualAdoptOptions = {
    ...adoptOpts,
    requireBeatMatch: false,
    scriptAnchored: false,
    personTopic: true,
    primaryPerson: personName,
  };
  const queries = buildPersonStockVideoQueries(personName, beat, scene, videoTitle);
  const tag = `b${beat.index}_person_stock`;
  const off = beat.index + sceneIndex * 5;

  return withTimeout(
    (async () => {
      for (const q of queries) {
        const pex = await fetchPexelsClips(
          q,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          undefined,
          true,
          tag,
          dedup.usedPexelsIds,
          off,
          dedup.perf.pexelsDownloadRetries
        );
        let clip = await adoptClip(
          pex, dedup, sceneIndex, beat.index, beat.text, workDir, q, personAdopt
        );
        if (isRealVideoClip(clip)) {
          if (canUseLicensedStockBeat(dedup)) markLicensedStockBeatUsed(dedup);
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: person stock (${reason}) — Pexels "${q}"`
          );
          return clip;
        }

        const pix = await fetchPixabayClips(
          q, clipFetchDur, workDir, sceneIndex, 1, tag, true, dedup.usedPixabayIds, off
        );
        clip = await adoptClip(
          pix, dedup, sceneIndex, beat.index, beat.text, workDir, q, personAdopt
        );
        if (isRealVideoClip(clip)) {
          if (canUseLicensedStockBeat(dedup)) markLicensedStockBeatUsed(dedup);
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: person stock (${reason}) — Pixabay "${q}"`
          );
          return clip;
        }
      }
      return null;
    })(),
    beatStockFallbackWallMs(dedup.perf),
    `person stock s${sceneIndex} b${beat.index}`
  ).catch(() => {
    dedup.lock = Promise.resolve();
    return null;
  });
}

/** Pexels/Pixabay when online search exceeds 1 minute or finds nothing. */
async function fetchBeatStockFallback(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  reason: string
): Promise<string | null> {
  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const primary =
    personName?.trim() ||
    adoptOpts.primaryPerson?.trim() ||
    dedup.primaryPerson?.trim() ||
    scenePersons[0]?.trim() ||
    "";
  if (primary || dedup.personTopicLock) {
    const personClip = await fetchBeatPersonStockVideo(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      primary || dedup.primaryPerson || scenePersons[0] || "",
      videoTitle,
      adoptOpts,
      reason
    );
    if (personClip) return personClip;
    if (dedup.personTopicLock || primary) return null;
  }

  const loose: VisualAdoptOptions = {
    ...adoptOpts,
    requireBeatMatch: false,
    scriptAnchored: false,
  };
  const queries = [
    beat.searchQuery,
    enrichStockQuery(beat.powerWord, scene, videoTitle, personName, beat.text),
    scene.visualCue,
    scene.pexelsQuery,
    ...buildBeatVisualQueryList(beat.text, scene, videoTitle, scenePersons, 3),
  ].filter((q): q is string => typeof q === "string" && q.trim().length > 2 && !isBlockedStockQuery(q));
  const unique = [...new Set(queries)].slice(0, 3);
  const tag = `b${beat.index}_stock`;
  const off = beat.index + sceneIndex * 3;

  return withTimeout(
    (async () => {
      for (const q of unique) {
        const pex = await fetchPexelsClips(
          q,
          clipFetchDur,
          workDir,
          sceneIndex,
          1,
          undefined,
          true,
          tag,
          dedup.usedPexelsIds,
          off,
          dedup.perf.pexelsDownloadRetries
        );
        let clip = await adoptClip(
          pex, dedup, sceneIndex, beat.index, beat.text, workDir, q, loose
        );
        if (clip && !isStillPhotoClip(clip) && !isPipelineFallbackClip(clip)) {
          if (canUseLicensedStockBeat(dedup)) markLicensedStockBeatUsed(dedup);
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: stock fallback (${reason}) — Pexels "${q}"`
          );
          return clip;
        }

        const pix = await fetchPixabayClips(
          q, clipFetchDur, workDir, sceneIndex, 1, tag, true, dedup.usedPixabayIds, off
        );
        clip = await adoptClip(
          pix, dedup, sceneIndex, beat.index, beat.text, workDir, q, loose
        );
        if (clip && !isStillPhotoClip(clip) && !isPipelineFallbackClip(clip)) {
          if (canUseLicensedStockBeat(dedup)) markLicensedStockBeatUsed(dedup);
          console.log(
            `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: stock fallback (${reason}) — Pixabay "${q}"`
          );
          return clip;
        }
      }
      return null;
    })(),
    beatStockFallbackWallMs(dedup.perf),
    `stock fallback s${sceneIndex} b${beat.index}`
  ).catch((err) => {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: stock fallback skipped:`,
      (err as Error).message
    );
    dedup.lock = Promise.resolve();
    return null;
  });
}

/** True video clip (not Ken-Burns still). */
function isRealVideoClip(filePath: string): boolean {
  return Boolean(filePath) && !isStillPhotoClip(filePath) && !isPipelineFallbackClip(filePath);
}

/** Exhaust authentic sources (Archive, Wikimedia, YouTube CC) before stills/stock. */
async function fetchBeatAuthenticVideo(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  videoTitle: string | undefined,
  adoptOpts: VisualAdoptOptions,
  scenePersons: string[],
  personName: string,
  tag: string
): Promise<string | null> {
  const topicHay = [videoTitle, scene.text, beat.text].filter(Boolean).join(" ");
  const historicalDoc = isHistoricalDocumentary(topicHay) && !dedup.personTopicLock;
  const intent = buildMediaSearchIntent({
    beatText: beat.text,
    searchQueries: [beat.searchQuery, videoTitle ?? ""].filter((q) => q.trim().length >= 3),
    keywords: adoptOpts.keywords ?? beat.keywords,
    primaryPerson: historicalDoc ? "" : personName,
    persons: scenePersons,
    videoTitle,
    powerWord: beat.powerWord,
    personTopicLock: dedup.personTopicLock && !historicalDoc,
    spaceTopic: isSpaceRelatedTopic(scene.visualCue, scene.pexelsQuery, beat.text, scene.text, videoTitle ?? ""),
    muskTopic: adoptOpts.muskTopic ?? false,
  });
  const loose: VisualAdoptOptions = { ...adoptOpts, requireBeatMatch: false, scriptAnchored: false };

  if (youtubeSourcingEnabled()) {
    const ytQueries = [
      ...realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle),
      ...(personName.trim() ? buildPersonCelebrityVideoQueries(personName, beat.text, beat.index) : []),
      ...(videoTitle?.trim() ? [`${videoTitle} documentary footage`, `${videoTitle} archival`] : []),
    ];
    const yt = await tryBeatRealYouTubeFootage(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      loose,
      ytQueries,
      "authentic YouTube",
      youtubeBeatFetchTimeoutMs(dedup.perf.fastStockMode)
    );
    if (isAuthenticVideoClip(yt ?? "")) return yt;
    if (youtubeOnlySourcingEnabled()) return null;
  }

  const hist = await fetchHistoricalBeatVideo(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, intent, loose, tag, { skipYoutube: true }
  );
  if (isAuthenticVideoClip(hist ?? "")) return hist;

  if (personName.trim()) {
    const celebVids = await fetchPersonCelebrityVideoClips(
      personName,
      clipFetchDur,
      workDir,
      sceneIndex,
      3,
      `${tag}_auth`,
      beat.index,
      beat.text,
      false
    );
    const celeb = await adoptBestCelebrityClip(
      celebVids,
      dedup,
      sceneIndex,
      beat.index,
      beat.text,
      workDir,
      personName,
      { ...loose, personTopic: true, primaryPerson: personName }
    );
    if (isAuthenticVideoClip(celeb ?? "")) return celeb;
  }

  return null;
}

const FAST_AI_CLIP_TIMEOUT_MS = 55_000;

/** Fast 1-min path: ≤20s real footage, then AI, then Pexels. */
async function resolveBeatClipFastTurbo(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  beatAdoptOpts: VisualAdoptOptions
): Promise<string | null> {
  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const historicalDoc =
    isHistoricalDocumentary(videoTitle, scene.text, beat.text) && !dedup.personTopicLock;
  const tag = `b${beat.index}`;

  let clip = await fetchBeatInternetStillsFirst(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    scenePersons,
    videoTitle,
    beatAdoptOpts,
    `${tag}_inet`
  );
  if (clip && isRealVideoClip(clip) && !isPipelineFallbackClip(clip)) return clip;

  const primaryMs = historicalDoc ? 15_000 : 20_000;
  try {
    clip = await withTimeout(
      beatPrimaryFetch(
        beat,
        scene,
        workDir,
        sceneIndex,
        clipFetchDur,
        dedup,
        personName,
        videoTitle,
        beatAdoptOpts,
        scenePersons,
        `${tag}_fast`,
        "fast primary"
      ),
      primaryMs,
      `fast primary s${sceneIndex} b${beat.index}`
    );
  } catch (err) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: fast primary cap:`,
      (err as Error).message
    );
    dedup.lock = Promise.resolve();
  }
  if (clip && isRealVideoClip(clip) && !isPipelineFallbackClip(clip)) return clip;

  if (dedup.perf.enableAiFallback && dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo) {
    try {
      clip = await withTimeout(
        fetchBeatAIClip(
          beat, scene, workDir, sceneIndex, beat.index, clipFetchDur, dedup, videoTitle
        ),
        FAST_AI_CLIP_TIMEOUT_MS,
        `fast AI s${sceneIndex} b${beat.index}`
      );
    } catch {
      dedup.lock = Promise.resolve();
    }
    if (clip && !isPipelineFallbackClip(clip)) return clip;
  }

  if (canUseLicensedStockBeat(dedup)) {
    clip = await fetchBeatStockFallback(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      personName,
      videoTitle,
      beatAdoptOpts,
      "fast turbo"
    );
    if (clip && isRealVideoClip(clip)) {
      markLicensedStockBeatUsed(dedup);
      return clip;
    }
  }

  clip = await fetchBeatScriptImageForced(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    scenePersons,
    videoTitle,
    `${tag}_must`
  );
  return clip && !isPipelineFallbackClip(clip) ? clip : null;
}

/**
 * Turbo path for 1–2 min videos: real video first (YouTube → stock, ≤1min), still only as last resort.
 */
async function resolveBeatClipTurbo(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  personName: string,
  videoTitle: string | undefined,
  beatAdoptOpts: VisualAdoptOptions
): Promise<string | null> {
  if (dedup.perf.fastStockMode) {
    return resolveBeatClipFastTurbo(
      beat, scene, workDir, sceneIndex, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts
    );
  }

  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const historicalDoc =
    isHistoricalDocumentary(videoTitle, scene.text, beat.text) && !dedup.personTopicLock;
  const turboAdopt: VisualAdoptOptions = {
    ...beatAdoptOpts,
    requireBeatMatch: false,
    scriptAnchored: false,
    personTopic: !historicalDoc && (dedup.personTopicLock || scenePersons.length > 0),
    primaryPerson: historicalDoc
      ? ""
      : (beatAdoptOpts.primaryPerson || scenePersons[0] || personName),
  };

  const person = historicalDoc
    ? ""
    : (scenePersons[0] ?? personName ?? dedup.primaryPerson ?? "").trim();
  const muskTopic = isMuskTeslaTopic(videoTitle, scene.text);
  const maxQ = Math.min(3, dedup.perf.maxStockQueriesPerBeat);
  const beatQueries = buildBeatVisualQueryList(beat.text, scene, videoTitle, scenePersons, maxQ);
  const tag = `b${beat.index}`;
  const candidateOffset = beat.index * 3 + sceneIndex + dedup.globalBeatIndex;
  const pexFetch = (query: string, t: string, off: number, count = 1) =>
    () =>
      fetchPexelsClips(
        query,
        clipFetchDur,
        workDir,
        sceneIndex,
        count,
        [query],
        true,
        t,
        dedup.usedPexelsIds,
        off,
        dedup.perf.pexelsDownloadRetries
      );

  if (realFootageFirstEnabled()) {
    const primary = await beatPrimaryFetch(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      personName,
      videoTitle,
      beatAdoptOpts,
      scenePersons,
      `${tag}_primary`,
      "turbo primary"
    );
    if (primary) return primary;

    const authFirst = await fetchBeatAuthenticVideo(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      videoTitle,
      turboAdopt,
      scenePersons,
      person,
      `${tag}_auth0`
    );
    if (authFirst) return authFirst;
  }

  const unified = await researchBeatClipUnified(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    beatQueries,
    scenePersons,
    person,
    videoTitle,
    turboAdopt,
    tag,
    muskTopic,
    pexFetch,
    candidateOffset
  );
  const topicHay = [beat.text, videoTitle, scene.text].filter(Boolean).join(" ");
  const archivalBeat =
    historicalDoc ||
    inferTopicKind(
      topicHay,
      person,
      isSpaceRelatedTopic(scene.visualCue, scene.pexelsQuery, beat.text, scene.text, videoTitle ?? "", beat.powerWord),
      dedup.personTopicLock
    ) === "historical" ||
    inferTopicKind(topicHay, person, false, dedup.personTopicLock) === "news";

  if (unified && !isPipelineFallbackClip(unified) && !(await isMostlyBlackClip(unified))) {
    if (realFootageFirstEnabled()) {
      if (isAuthenticVideoClip(unified)) return unified;
      if (!isStillPhotoClip(unified) && !isLicensedStockClip(unified)) return unified;
    } else if (!archivalBeat || isRealVideoClip(unified)) {
      return unified;
    }
  }

  if (archivalBeat || realFootageFirstEnabled()) {
    const histIntent = buildMediaSearchIntent({
      beatText: beat.text,
      searchQueries: beatQueries,
      keywords: beatAdoptOpts.keywords ?? beat.keywords,
      primaryPerson: person,
      persons: scenePersons,
      videoTitle,
      powerWord: beat.powerWord,
      personTopicLock: dedup.personTopicLock && !historicalDoc,
      spaceTopic: false,
      muskTopic,
    });
    const turboYtQueries = [
      ...realEntityYoutubeQueriesForBeat(beat.text, scene.text, videoTitle),
      ...(person.trim() ? buildPersonCelebrityVideoQueries(person, beat.text, beat.index) : []),
      ...beatQueries.slice(0, 2),
    ];
    const turboYt = await tryBeatRealYouTubeFootage(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      turboAdopt,
      [...new Set(turboYtQueries.filter((q) => q.trim().length > 3))].slice(0, 5),
      "turbo archival YouTube",
      youtubeBeatFetchTimeoutMs(dedup.perf.fastStockMode)
    );
    if (turboYt && isAuthenticVideoClip(turboYt)) return turboYt;

    const hist = await fetchHistoricalBeatVideo(
      beat, scene, workDir, sceneIndex, clipFetchDur, dedup, histIntent, turboAdopt, tag, {
        skipYoutube: true,
      }
    );
    if (hist && isAuthenticVideoClip(hist)) return hist;
  }

  let c: string | null = null;
  let searchTimedOut = false;
  try {
    c = await withTimeout(
      (async () => {
        if (youtubeSourcingEnabled() && person && youtubeCcReady()) {
          const ytQueries = buildPersonCelebrityVideoQueries(person, beat.text, beat.index).slice(0, 3);
          const yt = await tryBeatRealYouTubeFootage(
            beat,
            scene,
            workDir,
            sceneIndex,
            clipFetchDur,
            dedup,
            { ...turboAdopt, personTopic: true, primaryPerson: person },
            ytQueries,
            "turbo person YouTube",
            42_000
          );
          if (isRealVideoClip(yt) && !(await isMostlyBlackClip(yt!))) return yt;
        } else if (youtubeSourcingEnabled() && youtubeCcReady()) {
          const ytQueries = [beat.searchQuery, scene.visualCue].filter((q) => q?.trim());
          const yt = await tryBeatRealYouTubeFootage(
            beat, scene, workDir, sceneIndex, clipFetchDur, dedup, turboAdopt, ytQueries, "turbo YouTube", 35_000
          );
          if (isRealVideoClip(yt) && !(await isMostlyBlackClip(yt!))) return yt;
        }

        if (person) {
          const celebVids = await withTimeout(
            fetchPersonCelebrityVideoClips(
              person,
              clipFetchDur,
              workDir,
              sceneIndex,
              2,
              `b${beat.index}_turbo_celeb`,
              beat.index,
              beat.text,
              true
            ),
            22_000,
            `turbo celebrity s${sceneIndex} b${beat.index}`
          ).catch(() => [] as CelebrityClipCandidate[]);
          const celeb = await adoptBestCelebrityClip(
            celebVids,
            dedup,
            sceneIndex,
            beat.index,
            beat.text,
            workDir,
            person,
            { ...turboAdopt, personTopic: true, primaryPerson: person }
          );
          if (isRealVideoClip(celeb)) return celeb;
        }

        return null;
      })(),
      beatVisualSearchMaxMs(dedup.perf),
      `turbo video search s${sceneIndex} b${beat.index}`
    );
  } catch (err) {
    searchTimedOut = true;
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: video search >1min:`,
      (err as Error).message
    );
    dedup.lock = Promise.resolve();
  }

  if (isAuthenticVideoClip(c ?? "")) return c;
  if (realFootageFirstEnabled() && c && isLicensedStockClip(c)) c = null;

  const stock = await fetchBeatStockFallback(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    beatAdoptOpts,
    searchTimedOut ? ">1min cap" : "no video"
  );
  if (isLicensedStockClip(stock ?? "")) {
    if (canUseLicensedStockBeat(dedup) && isRealVideoClip(stock!)) return stock;
  } else if (isRealVideoClip(stock)) {
    return stock;
  }

  if (!canUseGlobalStillPhoto(dedup)) return null;

  const imgAdopt: VisualAdoptOptions = { ...turboAdopt, scriptImageFallback: true };
  let img = await fetchBeatScriptImageClip(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, scenePersons, videoTitle, imgAdopt, `b${beat.index}`
  );
  if (img && !isPipelineFallbackClip(img)) return img;

  img = await fetchBeatScriptImageForced(
    beat, scene, workDir, sceneIndex, clipFetchDur, dedup, scenePersons, videoTitle, `b${beat.index}`
  );
  return img && !isPipelineFallbackClip(img) ? img : null;
}

/** Real footage first (capped); script-matched still image; AI/stock last resort. */
async function resolveBeatClipForBeat(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  sceneIndex: number,
  clipFetchDur: number,
  dedup: VisualDedupState,
  spaceTopic: boolean,
  personName: string,
  videoTitle: string | undefined,
  beatAdoptOpts: VisualAdoptOptions
): Promise<string | null> {
  if (curatedArchiveOnlyVisuals()) {
    return fetchCuratedArchiveBeatClip(
      beat,
      scene,
      workDir,
      sceneIndex,
      beat.holdSec,
      dedup.usedCuratedAssetIds,
      dedup.usedCuratedStorageUrls,
      videoTitle
    );
  }

  if (dedup.perf.fastStockMode) {
    return resolveBeatClipTurbo(
      beat, scene, workDir, sceneIndex, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts
    );
  }

  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const minimize = dedup.perf.minimizeStockFootage;
  let c: string | null = null;
  try {
    c = await withTimeout(
      (async () => {
        let v = await runBeatClipFetch(
          beat, scene, workDir, sceneIndex, clipFetchDur, dedup, spaceTopic, personName, videoTitle
        );
        if (!v || isPipelineFallbackClip(v)) {
          v = await resolveBeatClipFast(
            beat, scene, workDir, sceneIndex, clipFetchDur, dedup, scenePersons, videoTitle, beatAdoptOpts
          );
        }
        return v;
      })(),
      beatVideoSearchWallMs(dedup.perf),
      `video search s${sceneIndex} b${beat.index}`
    );
  } catch (err) {
    console.warn(
      `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: video search capped:`,
      (err as Error).message
    );
    dedup.lock = Promise.resolve();
  }
  if (c && !isPipelineFallbackClip(c) && !(await isMostlyBlackClip(c))) {
    if (!realFootageFirstEnabled() || isAuthenticVideoClip(c) || isStillPhotoClip(c)) return c;
  }

  if (realFootageFirstEnabled()) {
    const auth = await fetchBeatAuthenticVideo(
      beat,
      scene,
      workDir,
      sceneIndex,
      clipFetchDur,
      dedup,
      videoTitle,
      beatAdoptOpts,
      scenePersons,
      personName,
      `b${beat.index}_auth`
    );
    if (auth) return auth;
  }

  c = await fetchBeatStockFallback(
    beat,
    scene,
    workDir,
    sceneIndex,
    clipFetchDur,
    dedup,
    personName,
    videoTitle,
    beatAdoptOpts,
    "after search"
  );
  if (c && !isPipelineFallbackClip(c)) return c;

  if (canUseGlobalStillPhoto(dedup)) {
    const imgAdopt: VisualAdoptOptions = { ...beatAdoptOpts, scriptImageFallback: true };
    let img = await fetchBeatScriptImageClip(
      beat, scene, workDir, sceneIndex, clipFetchDur, dedup, scenePersons, videoTitle, imgAdopt, `b${beat.index}`
    );
    if (img && !isPipelineFallbackClip(img)) return img;
    img = await fetchBeatScriptImageForced(
      beat, scene, workDir, sceneIndex, clipFetchDur, dedup, scenePersons, videoTitle, `b${beat.index}`
    );
    if (img && !isPipelineFallbackClip(img)) return img;
  }

  const tryAi = async (): Promise<string | null> => {
    if (!dedup.perf.enableAiFallback) return null;
    const aiMs = dedup.perf.fastStockMode ? 95_000 : 180_000;
    try {
      return await withTimeout(
        fetchBeatAIClip(
          beat, scene, workDir, sceneIndex, beat.index, clipFetchDur, dedup, videoTitle
        ),
        aiMs,
        `AI clip s${sceneIndex} b${beat.index}`
      );
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${sceneIndex} beat ${beat.index}: AI generation skipped:`,
        (err as Error).message
      );
      return null;
    }
  };
  if (!minimize) {
    c = await tryAi();
    if (c && !isPipelineFallbackClip(c)) return c;
  }
  return null;
}

// ─── 3e. Fetch All Visuals for a Scene (beat-aligned) ───────────────────────
// One stock clip per ~3.5s narration beat, in narrative order. No clip recycling.
type SceneVisualsResult = { clips: string[]; beatDurations: number[] };
type BeatProgressPhase = "beat" | "backfill";

const ARCHIVE_BEAT_CLIP_RETRIES = 12;

async function adoptArchiveBeatClip(
  beat: SceneBeat,
  scene: Scene,
  workDir: string,
  videoTitle: string | undefined,
  dedup: VisualDedupState,
  pushClip: (clipPath: string, holdSec?: number) => boolean,
  initialClip: string | null = null,
  holdSec = beat.holdSec
): Promise<boolean> {
  const tryClip = (clipPath: string | null | undefined, sec = holdSec): boolean => {
    if (!clipPath || isPipelineFallbackClip(clipPath)) return false;
    return pushClip(clipPath, sec);
  };

  if (tryClip(initialClip, holdSec)) return true;

  for (let attempt = 0; attempt < ARCHIVE_BEAT_CLIP_RETRIES; attempt++) {
    const clip = await fetchCuratedArchiveBeatClip(
      beat,
      scene,
      workDir,
      scene.index,
      holdSec,
      dedup.usedCuratedAssetIds,
      dedup.usedCuratedStorageUrls,
      videoTitle
    );
    if (tryClip(clip, holdSec)) return true;
  }
  return false;
}

async function fetchSceneVisuals(
  scene: Scene,
  workDir: string,
  videoTitle: string | undefined,
  dedup: VisualDedupState,
  onBeatProgress?: (beatIndex: number, beatTotal: number, phase?: BeatProgressPhase) => void
): Promise<SceneVisualsResult> {
  const clipFetchDur = 4;
  const scenePersons = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  const historicalDoc = isHistoricalDocumentary(videoTitle, scene.text) && !dedup.personTopicLock;
  const personName = historicalDoc
    ? ""
    : (scenePersons[0] ?? dedup.primaryPerson ?? extractPrimaryPersonFromTitle(videoTitle) ?? "");
  const spaceTopic = isSpaceRelatedTopic(scene.visualCue, scene.pexelsQuery, scene.text, videoTitle ?? "");
  const beatCap = dedup.perf.fastStockMode
    ? Math.min(
        dedup.perf.maxBeatsPerScene,
        Math.max(1, Math.ceil(scene.duration / VIDRUSH_BEAT_SEC))
      )
    : Math.min(
        dedup.perf.maxBeatsPerScene,
        Math.max(2, Math.ceil(scene.duration / VIDRUSH_BEAT_SEC))
      );
  dedup.stillPhotosThisScene = 0;
  const realOnly = realFootageFirstEnabled();
  dedup.stillPhotosMaxThisScene = historicalDoc && dedup.perf.fastStockMode
    ? beatCap
    : realOnly
      ? (historicalDoc ? beatCap : 1)
      : historicalDoc
        ? beatCap
        : dedup.perf.fastStockMode
          ? 2
          : maxStillPhotosForScene(scene.index, scenePersons.length > 0, dedup.personTopicLock);
  const beats = buildSceneBeats(scene, scene.duration, beatCap, videoTitle, scenePersons);
  const clips: string[] = [];
  const beatDurations: number[] = [];
  const archiveOnly = curatedArchiveOnlyVisuals();

  console.log(
    `[Pipeline] Scene ${scene.index}: ${beats.length} zin-beats (~${VIDRUSH_BEAT_SEC}s) — ` +
    `power words: [${beats.map((b) => b.powerWord).join(", ")}]` +
    (archiveOnly ? " [curated archive only]" : "")
  );

  const muskTopic = isMuskTeslaTopic(videoTitle, scene.text);
  const beatAdoptOpts: VisualAdoptOptions = {
    muskTopic,
    personTopic: dedup.personTopicLock,
    primaryPerson: dedup.primaryPerson || personName,
    keywords: [],
    sceneText: scene.text,
    videoTitle,
    requireBeatMatch: false,
    scriptAnchored: dedup.perf.fastStockMode ? false : dedup.perf.scriptOnlyVisuals,
  };

  const pushSceneClip = (clipPath: string, holdSec: number, beatIndex: number): boolean => {
    const key = clipContentKey(clipPath);
    if (dedup.usedContentKeys.has(key)) {
      console.warn(
        `[Pipeline] Scene ${scene.index} beat ${beatIndex}: skipping duplicate clip ${path.basename(clipPath)}`
      );
      return false;
    }
    dedup.usedContentKeys.add(key);
    clips.push(clipPath);
    beatDurations.push(holdSec);
    markCuratedAssetUsed(clipPath, dedup.usedCuratedAssetIds, dedup.usedCuratedStorageUrls);
    if (
      clipPath && !isPipelineFallbackClip(clipPath) && !isStillPhotoClip(clipPath) &&
      fs.existsSync(clipPath)
    ) {
      dedup.lastMuskStockClip = clipPath;
    }
    return true;
  };

  for (let bi = 0; bi < beats.length; bi++) {
    const beat = beats[bi];
    beatAdoptOpts.keywords = beat.keywords;
    onBeatProgress?.(bi, beats.length, "beat");
    const pushClip = (clipPath: string, holdSec = beat.holdSec): boolean =>
      pushSceneClip(clipPath, holdSec, beat.index);
    const beatWallMs = beatVisualWallMs(dedup.perf);
    let clip: string | null = null;
    const beatPulse = setInterval(() => {
      onBeatProgress?.(bi, beats.length, "beat");
    }, 10_000);
    try {
      clip = await withTimeout(
        resolveBeatClipForBeat(
          beat,
          scene,
          workDir,
          scene.index,
          clipFetchDur,
          dedup,
          spaceTopic,
          personName,
          videoTitle,
          beatAdoptOpts
        ),
        beatWallMs,
        `scene ${scene.index} beat ${bi} visuals`
      );
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${scene.index} beat ${beat.index}: capped at ${Math.round(beatWallMs / 1000)}s:`,
        (err as Error).message
      );
      dedup.lock = Promise.resolve();
      if (archiveOnly) {
        clip = await fetchCuratedArchiveBeatClip(
          beat, scene, workDir, scene.index, beat.holdSec, dedup.usedCuratedAssetIds, dedup.usedCuratedStorageUrls, videoTitle
        );
      } else if (
        realOnly &&
        (!clip || isPipelineFallbackClip(clip) || isStillPhotoClip(clip ?? "") || isLicensedStockClip(clip ?? ""))
      ) {
        clip = dedup.perf.fastStockMode
          ? await resolveBeatClipFastTurbo(
              beat, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts
            )
          : await beatPrimaryFetch(
              beat,
              scene,
              workDir,
              scene.index,
              clipFetchDur,
              dedup,
              personName,
              videoTitle,
              beatAdoptOpts,
              scenePersons,
              `b${beat.index}_cap`,
              "beat cap"
            );
      }
      if (
        !archiveOnly &&
        (!clip || isPipelineFallbackClip(clip)) &&
        dedup.perf.enableAiFallback &&
        dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo
      ) {
        try {
          clip = await withTimeout(
            fetchBeatAIClip(
              beat, scene, workDir, scene.index, beat.index, clipFetchDur, dedup, videoTitle
            ),
            dedup.perf.fastStockMode ? FAST_AI_CLIP_TIMEOUT_MS : 120_000,
            `beat cap AI s${scene.index} b${beat.index}`
          );
        } catch {
          dedup.lock = Promise.resolve();
        }
      }
      if (
        !archiveOnly &&
        !youtubeOnlySourcingEnabled() &&
        (!clip || isPipelineFallbackClip(clip)) &&
        canUseLicensedStockBeat(dedup)
      ) {
        clip = await fetchBeatStockFallback(
          beat, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "beat cap"
        );
      }
      if (
        !archiveOnly &&
        !youtubeOnlySourcingEnabled() &&
        (!clip || isPipelineFallbackClip(clip)) &&
        canUseGlobalStillPhoto(dedup)
      ) {
        clip = dedup.perf.fastStockMode
          ? await fetchBeatScriptImageForced(
              beat, scene, workDir, scene.index, clipFetchDur, dedup, scenePersons, videoTitle, `b${beat.index}_cap`
            )
          : await fetchBeatScriptImageClip(
              beat,
              scene,
              workDir,
              scene.index,
              clipFetchDur,
              dedup,
              scenePersons,
              videoTitle,
              { ...beatAdoptOpts, scriptImageFallback: true },
              `b${beat.index}_cap`
            );
      }
    } finally {
      clearInterval(beatPulse);
    }
    if (clip && !isPipelineFallbackClip(clip)) {
      if (realOnly && isLicensedStockClip(clip) && !canUseLicensedStockBeat(dedup)) {
        clip = null;
      } else if (archiveOnly) {
        if (!(await adoptArchiveBeatClip(beat, scene, workDir, videoTitle, dedup, pushClip, clip))) {
          console.warn(
            `[Pipeline] Scene ${scene.index} beat ${beat.index}: no unique archive clip after retries`
          );
        }
        clip = null;
      } else {
        pushClip(clip);
      }
    }
    if (
      !archiveOnly &&
      (!clip || isPipelineFallbackClip(clip)) &&
      dedup.perf.enableAiFallback &&
      dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo
    ) {
      let aiOnly: string | null = null;
      try {
        aiOnly = await withTimeout(
          fetchBeatAIClip(
            beat, scene, workDir, scene.index, beat.index, clipFetchDur, dedup, videoTitle
          ),
          120_000,
          `post-beat AI s${scene.index} b${beat.index}`
        );
      } catch {
        dedup.lock = Promise.resolve();
      }
      if (aiOnly && !isPipelineFallbackClip(aiOnly)) {
        pushClip(aiOnly);
        console.log(
          `[Pipeline] Scene ${scene.index} beat ${beat.index}: AI clip (power word "${beat.powerWord}")`
        );
      } else {
        console.warn(
          `[Pipeline] Scene ${scene.index} beat ${beat.index}: no stock or AI clip (beat skipped, no grey)`
        );
      }
    } else if (!clip || isPipelineFallbackClip(clip)) {
      let rescue: string | null = null;
      if (archiveOnly) {
        if (!(await adoptArchiveBeatClip(beat, scene, workDir, videoTitle, dedup, pushClip, null))) {
          console.warn(
            `[Pipeline] Scene ${scene.index} beat ${beat.index}: no clip (beat skipped, no grey)`
          );
        }
      } else if (realOnly) {
        rescue = await beatPrimaryFetch(
          beat,
          scene,
          workDir,
          scene.index,
          clipFetchDur,
          dedup,
          personName,
          videoTitle,
          beatAdoptOpts,
          scenePersons,
          `b${beat.index}_miss`,
          "miss beat"
        );
      }
      if (
        !archiveOnly &&
        (!rescue || isPipelineFallbackClip(rescue)) &&
        dedup.perf.enableAiFallback &&
        dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo
      ) {
        try {
          rescue = await withTimeout(
            fetchBeatAIClip(
              beat, scene, workDir, scene.index, beat.index, clipFetchDur, dedup, videoTitle
            ),
            dedup.perf.fastStockMode ? FAST_AI_CLIP_TIMEOUT_MS : 120_000,
            `miss AI s${scene.index} b${beat.index}`
          );
        } catch {
          dedup.lock = Promise.resolve();
        }
      }
      if (
        !archiveOnly &&
        !youtubeOnlySourcingEnabled() &&
        (!rescue || isPipelineFallbackClip(rescue)) &&
        canUseLicensedStockBeat(dedup)
      ) {
        rescue = await fetchBeatStockFallback(
          beat, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "miss"
        );
      }
      if (!archiveOnly && (!rescue || isPipelineFallbackClip(rescue)) && canUseGlobalStillPhoto(dedup)) {
        rescue = await fetchBeatScriptImageClip(
          beat,
          scene,
          workDir,
          scene.index,
          clipFetchDur,
          dedup,
          scenePersons,
          videoTitle,
          { ...beatAdoptOpts, scriptImageFallback: true },
          `b${beat.index}_miss`
        );
      }
      if (!archiveOnly && (!rescue || isPipelineFallbackClip(rescue)) && canUseGlobalStillPhoto(dedup)) {
        rescue = await fetchBeatScriptImageForced(
          beat, scene, workDir, scene.index, clipFetchDur, dedup, scenePersons, videoTitle, `b${beat.index}_miss`
        );
      }
      if (rescue && !isPipelineFallbackClip(rescue)) {
        pushClip(rescue);
      } else if (!archiveOnly) {
        console.warn(
          `[Pipeline] Scene ${scene.index} beat ${beat.index}: no clip (beat skipped, no grey)`
        );
      }
    }
  }

  if (archiveOnly) {
    for (let bi = clips.length; bi < beats.length; bi++) {
      const beat = beats[bi];
      const pushBeat = (clipPath: string, holdSec = beat.holdSec) =>
        pushSceneClip(clipPath, holdSec, beat.index);
      if (!(await adoptArchiveBeatClip(beat, scene, workDir, videoTitle, dedup, pushBeat, null))) {
        console.warn(
          `[Pipeline] Scene ${scene.index}: could not fill beat ${beat.index} with a unique archive clip`
        );
      }
    }
  }

  const minClips = minClipsForScene(scene.duration, beats.length, dedup.perf.fastStockMode);
  let backfillAttempts = 0;
  const maxBackfill = maxBackfillAttempts(dedup.perf, scene.duration);
  const backfillMs = backfillClipWallMs(dedup.perf, scene.duration);
  const scenePersonsForBackfill = resolveScenePersons(scene, videoTitle, dedup.primaryPerson || undefined);
  while (
    clips.filter((c) => c && !isPipelineFallbackClip(c)).length < minClips &&
    backfillAttempts < maxBackfill
  ) {
    const stub = beats[beats.length - 1] ?? beats[0];
    if (!stub) break;
    onBeatProgress?.(backfillAttempts + 1, maxBackfill, "backfill");
    let extra: string | null = null;
    const backfillPulse = setInterval(() => {
      onBeatProgress?.(backfillAttempts + 1, maxBackfill, "backfill");
    }, 10_000);
    try {
        extra = await withTimeout(
          (async () => {
            if (archiveOnly) {
              return fetchCuratedArchiveBeatClip(
                stub, scene, workDir, scene.index, stub.holdSec, dedup.usedCuratedAssetIds, dedup.usedCuratedStorageUrls, videoTitle
              );
            }
            if (dedup.perf.fastStockMode) {
              if (
                dedup.perf.enableAiFallback &&
                dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo
              ) {
                try {
                  const ai = await withTimeout(
                    fetchBeatAIClip(
                      stub, scene, workDir, scene.index, stub.index, clipFetchDur, dedup, videoTitle
                    ),
                    FAST_AI_CLIP_TIMEOUT_MS,
                    `backfill AI s${scene.index}`
                  );
                  if (ai && !isPipelineFallbackClip(ai)) return ai;
                } catch {
                  dedup.lock = Promise.resolve();
                }
              }
              if (canUseLicensedStockBeat(dedup)) {
                const stock = await fetchBeatStockFallback(
                  stub, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "backfill"
                );
                if (isRealVideoClip(stock)) return stock;
              }
              return null;
            }
            if (realOnly) {
              const primary = await beatPrimaryFetch(
                stub,
                scene,
                workDir,
                scene.index,
                clipFetchDur,
                dedup,
                personName,
                videoTitle,
                beatAdoptOpts,
                scenePersonsForBackfill,
                `bf${backfillAttempts + 1}`,
                "backfill"
              );
              if (primary && isRealVideoClip(primary)) return primary;
            }
            if (!youtubeOnlySourcingEnabled() && canUseLicensedStockBeat(dedup)) {
              const stock = await fetchBeatStockFallback(
                stub, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "backfill"
              );
              if (isRealVideoClip(stock)) return stock;
            }
            if (canUseGlobalStillPhoto(dedup)) {
              const still = await fetchBeatScriptImageClip(
                stub,
                scene,
                workDir,
                scene.index,
                clipFetchDur,
                dedup,
                scenePersonsForBackfill,
                videoTitle,
                { ...beatAdoptOpts, scriptImageFallback: true },
                `bf${backfillAttempts + 1}`
              );
              if (still && !isPipelineFallbackClip(still)) return still;
            }
            return null;
          })(),
        backfillMs,
        `scene ${scene.index} backfill ${backfillAttempts + 1}`
      );
    } catch (err) {
      console.warn(
        `[Pipeline] Scene ${scene.index}: backfill ${backfillAttempts + 1} timed out:`,
        (err as Error).message
      );
      dedup.lock = Promise.resolve();
    } finally {
      clearInterval(backfillPulse);
    }
    if (!extra || isPipelineFallbackClip(extra)) break;
    if (archiveOnly) {
      if (!pushSceneClip(extra, stub.holdSec, stub.index)) continue;
    } else {
      if (clips.some((c) => clipContentKey(c) === clipContentKey(extra))) break;
      clips.push(extra);
      beatDurations.push(stub.holdSec);
    }
    backfillAttempts++;
  }

  if (clips.filter((c) => c && !isPipelineFallbackClip(c)).length === 0 && beats[0]) {
    console.warn(`[Pipeline] Scene ${scene.index}: no beat clips — stock then image rescue`);
    const rescueTries = dedup.perf.fastStockMode ? 1 : 3;
    for (let si = 0; si < rescueTries; si++) {
      const stub = { ...beats[0], index: si };
      onBeatProgress?.(si + 1, rescueTries, "backfill");
      let extra: string | null = null;
      try {
        extra = await withTimeout(
          (async () => {
            if (dedup.perf.fastStockMode) {
              if (
                dedup.perf.enableAiFallback &&
                dedup.aiClipsUsed < dedup.perf.maxAiClipsPerVideo
              ) {
                try {
                  const ai = await withTimeout(
                    fetchBeatAIClip(
                      stub, scene, workDir, scene.index, stub.index, clipFetchDur, dedup, videoTitle
                    ),
                    FAST_AI_CLIP_TIMEOUT_MS,
                    `rescue AI s${scene.index}`
                  );
                  if (ai && !isPipelineFallbackClip(ai)) return ai;
                } catch {
                  dedup.lock = Promise.resolve();
                }
              }
              if (canUseLicensedStockBeat(dedup)) {
                const stock = await fetchBeatStockFallback(
                  stub, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "rescue"
                );
                if (isRealVideoClip(stock)) return stock;
              }
              return null;
            }
            if (realOnly) {
              const primary = await beatPrimaryFetch(
                stub,
                scene,
                workDir,
                scene.index,
                clipFetchDur,
                dedup,
                personName,
                videoTitle,
                beatAdoptOpts,
                scenePersonsForBackfill,
                `res${si + 1}`,
                "rescue"
              );
              if (primary && isRealVideoClip(primary)) return primary;
            }
            if (!youtubeOnlySourcingEnabled() && canUseLicensedStockBeat(dedup)) {
              const stock = await fetchBeatStockFallback(
                stub, scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "rescue"
              );
              if (isRealVideoClip(stock)) return stock;
            }
            if (canUseGlobalStillPhoto(dedup)) {
              const still = await fetchBeatScriptImageForced(
                stub, scene, workDir, scene.index, clipFetchDur, dedup, scenePersonsForBackfill, videoTitle, `res${si + 1}`
              );
              if (still && !isPipelineFallbackClip(still)) return still;
            }
            return null;
          })(),
          backfillMs,
          `scene ${scene.index} rescue ${si + 1}`
        );
      } catch {
        dedup.lock = Promise.resolve();
      }
      if (extra && !isPipelineFallbackClip(extra) && !clips.some((c) => clipContentKey(c) === clipContentKey(extra))) {
        clips.push(extra);
        beatDurations.push(VIDRUSH_BEAT_SEC);
      }
      if (clips.length >= minClips) break;
    }
  }

  const videoCount = clips.filter((c) => !isStillPhotoClip(c)).length;
  const photoCount = clips.filter((c) => isStillPhotoClip(c)).length;
  const personLabel = scenePersons.length > 0 ? ` [persons: ${scenePersons.join(", ")}]` : "";
  let usable = clips.filter((c) => c && !isPipelineFallbackClip(c));
  if (usable.length === 0 && beats[0]) {
    let forced: string | null = null;
    if (archiveOnly) {
      forced = await fetchCuratedArchiveBeatClip(
        beats[0],
        scene,
        workDir,
        scene.index,
        beats[0].holdSec,
        dedup.usedCuratedAssetIds,
        dedup.usedCuratedStorageUrls,
        videoTitle
      );
    } else if (realOnly) {
      forced = await beatPrimaryFetch(
        beats[0],
        scene,
        workDir,
        scene.index,
        clipFetchDur,
        dedup,
        personName,
        videoTitle,
        beatAdoptOpts,
        scenePersons,
        `force_s${scene.index}`,
        "force"
      );
    }
    if (
      !archiveOnly &&
      !youtubeOnlySourcingEnabled() &&
      !isAuthenticVideoClip(forced ?? "") &&
      canUseLicensedStockBeat(dedup)
    ) {
      forced = await fetchBeatStockFallback(
        beats[0], scene, workDir, scene.index, clipFetchDur, dedup, personName, videoTitle, beatAdoptOpts, "force"
      );
    }
    if (!archiveOnly && (!forced || isPipelineFallbackClip(forced)) && canUseGlobalStillPhoto(dedup)) {
      forced = dedup.perf.fastStockMode
        ? await fetchBeatScriptImageForced(
            beats[0], scene, workDir, scene.index, clipFetchDur, dedup, scenePersons, videoTitle, `force_s${scene.index}`
          )
        : await fetchBeatScriptImageClip(
            beats[0],
            scene,
            workDir,
            scene.index,
            clipFetchDur,
            dedup,
            scenePersons,
            videoTitle,
            { ...beatAdoptOpts, scriptImageFallback: true, requireBeatMatch: false, scriptAnchored: false },
            `force_s${scene.index}`
          );
    }
    if (forced && !isPipelineFallbackClip(forced)) {
      clips.push(forced);
      beatDurations.push(beats[0].holdSec);
      usable = [forced];
      console.warn(`[Pipeline] Scene ${scene.index}: forced script image fallback`);
    }
  }
  if (usable.length === 0) {
    console.warn(`[Pipeline] Scene ${scene.index}: no beat clips — inline recovery`);
    return recoverSceneClipsIfEmpty(scene, workDir, videoTitle, dedup);
  }

  console.log(
    `[Pipeline] Scene ${scene.index}${personLabel}: ${usable.length} beat clip(s) (${videoCount} video, ${photoCount} photo)`
  );
  return { clips: usable, beatDurations: beatDurations.slice(0, usable.length) };
}

// ─── 3e. Extract Key Words for Kinetic Typography ───────────────────────────
// Extracts 3-5 impactful keywords from narration text without an LLM call.
// Strategy: remove stopwords, pick longest/most-impactful words.
function extractKeywords(text: string, count: number = 4): string[] {
  const STOP_WORDS = new Set([
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "by","from","is","are","was","were","be","been","being","have","has",
    "had","do","does","did","will","would","could","should","may","might",
    "shall","can","this","that","these","those","it","its","we","they","he",
    "she","you","i","my","our","their","his","her","your","as","so","if",
    "not","no","up","out","about","into","than","then","when","where","who",
    "which","what","how","all","each","more","most","also","just","very",
    "over","after","before","through","during","between","while","because",
    "since","even","only","still","now","here","there","some","any","every",
  ]);

  // Clean text: remove punctuation, lowercase, split into words
  const words = text
    .replace(/[^a-zA-Z\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  // Score: prefer longer words (more impactful), pick first `count` unique ones
  // Sort by length descending, then take top `count`, then re-sort by original order
  const topByLength = [...unique].sort((a, b) => b.length - a.length).slice(0, count * 2);
  // Restore original order among top candidates
  const topSet = new Set(topByLength);
  const ordered = unique.filter(w => topSet.has(w)).slice(0, count);

  // Capitalize first letter of each word for display
  return ordered.map(w => w.charAt(0).toUpperCase() + w.slice(1));
}

// ─── 3f. Render Kinetic Typography Frames ────────────────────────────────────
// Renders each keyword as a PNG overlay image for FFmpeg overlay.
// Returns array of { path, startTime, endTime } for each keyword.
interface KineticFrame {
  path: string;
  startTime: number;
  endTime: number;
}

async function renderKineticFrames(
  keywords: string[],
  sceneDuration: number,
  sceneIndex: number,
  workDir: string,
  overrideStartTime?: number,
  overrideEndTime?: number
): Promise<KineticFrame[]> {
  if (keywords.length === 0) return [];

  // FFmpeg-only implementation: render yellow pill with black text as PNG
  // No canvas dependency required — works in all environments

  const frames: KineticFrame[] = [];
  // Distribute keywords evenly across the scene duration (or use override timing)
  const slotDuration = sceneDuration / keywords.length;
  const showDuration = Math.max(1.5, slotDuration - 0.3);

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    const startTime = overrideStartTime !== undefined ? overrideStartTime : i * slotDuration + 0.15;
    const endTime = overrideEndTime !== undefined ? overrideEndTime : Math.min(startTime + showDuration, sceneDuration - 0.2);

    const OVERLAY_H = 160;
    const FONT_SIZE = 72;
    const pngPath = path.join(workDir, `scene_${sceneIndex}_kword_${i}.png`);
    const safeKw = sanitizeForDrawtext(keyword.toUpperCase(), 40);

    // Estimate pill width: ~0.6 * fontSize per char + padding
    const estTextW = Math.min(safeKw.length * FONT_SIZE * 0.6, VIDEO_WIDTH - 200);
    const pillW = Math.round(estTextW + 80);
    const pillH = FONT_SIZE + 40;
    const pillX = Math.round((VIDEO_WIDTH - pillW) / 2);
    const pillY = Math.round((OVERLAY_H - pillH) / 2);

    try {
      // Generate yellow pill PNG using FFmpeg lavfi + drawbox + drawtext
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ` +
          `-f lavfi -i "color=c=black@0:size=${VIDEO_WIDTH}x${OVERLAY_H}:rate=1" ` +
          `-vf "drawbox=x=${pillX}:y=${pillY}:w=${pillW}:h=${pillH}:color=FFD200@0.97:t=fill,` +
          `drawtext=text='${safeKw}':fontcolor=black:fontsize=${FONT_SIZE}:x=(w-text_w)/2:y=(h-text_h)/2" ` +
          `-frames:v 1 -pix_fmt rgba "${pngPath}"`
        ),
        8_000, `Kinetic PNG scene ${sceneIndex} word ${i}`
      );
    } catch (err) {
      console.warn(`[Pipeline] Kinetic PNG failed for scene ${sceneIndex} word ${i}:`, err);
      continue;
    }

    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      frames.push({ path: pngPath, startTime, endTime });
    }
  }

  return frames;
}

// ─── 4a. Stat Callout Box Renderer ──────────────────────────────────────────
// Renders a yellow corner callout box (bottom-right) with a key statistic in black bold text.
// Appears via hard cut, stays 2.5s, then disappears via hard cut — reference video style.
async function renderStatCallout(
  stat: string,
  sceneIndex: number,
  workDir: string
): Promise<{ path: string; startTime: number; endTime: number } | null> {
  if (!stat || stat.trim().length === 0) return null;

  const FONT_SIZE = 64;
  const PAD_X = 36;
  const PAD_Y = 24;
  const CORNER_MARGIN = 40;

  const safeStat = sanitizeForDrawtext(stat.trim().toUpperCase(), 30);
  // Estimate box dimensions: ~0.6 * fontSize per char + padding
  const estTextW = Math.min(safeStat.length * FONT_SIZE * 0.6, VIDEO_WIDTH / 2);
  const boxW = Math.round(estTextW + PAD_X * 2);
  const boxH = FONT_SIZE + PAD_Y * 2;
  const boxX = VIDEO_WIDTH - boxW - CORNER_MARGIN;
  const boxY = VIDEO_HEIGHT - boxH - CORNER_MARGIN;

  const pngPath = path.join(workDir, `scene_${sceneIndex}_stat_callout.png`);

  try {
    // Generate stat callout PNG using FFmpeg lavfi + drawbox + drawtext
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "color=c=black@0:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=1" ` +
        `-vf "drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=FFD200@0.97:t=fill,` +
        `drawtext=text='${safeStat}':fontcolor=black:fontsize=${FONT_SIZE}:x=${boxX + PAD_X}:y=${boxY + PAD_Y}" ` +
        `-frames:v 1 -pix_fmt rgba "${pngPath}"`
      ),
      8_000, `Stat callout PNG scene ${sceneIndex}`
    );

    if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 100) {
      console.log(`[Pipeline] Scene ${sceneIndex}: stat callout rendered: "${stat}"`);
      return { path: pngPath, startTime: 1.0, endTime: 3.5 };
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${sceneIndex}: stat callout render failed (non-fatal):`, err);
  }
  return null;
}

// ─── 4b. Canvas Subtitle Overlay ─────────────────────────────────────────────
// FFmpeg-only fallback: creates a transparent PNG with drawtext (no canvas needed)
async function renderSubtitleOverlayFFmpeg(
  text: string,
  sceneIndex: number,
  totalScenes: number,
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${sceneIndex}_subtitle.png`);
  const OVERLAY_H = 220;
  // Create a semi-transparent black bar PNG using FFmpeg lavfi
  const safeText = sanitizeForDrawtext(text, 80);
  const badge = sanitizeForDrawtext(`${sceneIndex + 1}/${totalScenes}`, 20);
  // Use FFmpeg to create a PNG: black gradient bar with white text
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=black@0.85:size=${VIDEO_WIDTH}x${OVERLAY_H}:rate=1" ` +
      `-vf "drawtext=text='${badge}':fontcolor=yellow:fontsize=22:x=28:y=14,` +
      `drawtext=text='${safeText}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=100:line_spacing=10" ` +
      `-frames:v 1 "${outputPath}"`
    ),
    10_000, `Subtitle overlay FFmpeg scene ${sceneIndex}`
  );
  return outputPath;
}

async function renderSubtitleOverlay(
  text: string,
  sceneIndex: number,
  totalScenes: number,
  workDir: string
): Promise<string> {
  // Always use FFmpeg-only implementation (no canvas dependency)
  return renderSubtitleOverlayFFmpeg(text, sceneIndex, totalScenes, workDir);
}

// ─── 4a2. Chapter Card Renderer (Vox/Wendover style) ──────────────────────────────────
// Renders a 1.5s black-background title card with:
//   - Thin horizontal accent line above the title
//   - Large ALL CAPS white title text (bold, centered)
//   - Thin horizontal accent line below the title
//   - Hard cut in, hard cut out (no fade) — like reference video
async function renderChapterCard(
  chapterTitle: string,
  chapterIndex: number,
  workDir: string
): Promise<string> {
  const CARD_DURATION = 1.5; // seconds
  const outputPath = path.join(workDir, `chapter_card_${chapterIndex}.mp4`);

  // FFmpeg-only: yellow background with black bold text (no canvas dependency)
  const safeTitle = sanitizeForDrawtext(chapterTitle.toUpperCase(), 50);
  const centerY = VIDEO_HEIGHT / 2;
  const lineY1 = centerY - 80;
  const lineY2 = centerY + 70;
  const lineX1 = Math.round(VIDEO_WIDTH * 0.15);
  const lineX2 = Math.round(VIDEO_WIDTH * 0.85);

  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "color=c=FFD700:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
        `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
        `-filter_complex "[0:v]` +
        `drawbox=x=${lineX1}:y=${lineY1}:w=${lineX2 - lineX1}:h=3:color=black@0.4:t=fill,` +
        `drawbox=x=${lineX1}:y=${lineY2}:w=${lineX2 - lineX1}:h=3:color=black@0.4:t=fill,` +
        `drawtext=text='${safeTitle}':fontcolor=black:fontsize=80:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=10` +
        `[vout]" ` +
        `-map "[vout]" -map "1:a" ` +
        `-t ${CARD_DURATION} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 320k -shortest "${outputPath}"`
      ),
      15_000, `Chapter card ${chapterIndex}`
    );
    console.log(`[Pipeline] Chapter card ${chapterIndex}: "${chapterTitle}" rendered (FFmpeg)`);
  } catch (err) {
    console.warn(`[Pipeline] Chapter card ${chapterIndex} failed (non-fatal):`, (err as Error).message);
  }
  return outputPath;
}

// ─── 4b. Branded Intro Title Card ────────────────────────────────────────────
async function renderIntroCardFFmpeg(videoTitle: string, duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "intro_card.mp4");
  // Sanitize title for FFmpeg drawtext filter
  const safeTitle = sanitizeForDrawtext(videoTitle, 60);
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=#0a0a1e:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "[0:v]drawtext=text='${safeTitle}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h/2-40:line_spacing=10,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 320k -shortest "${outputPath}"`
    ),
    60_000, "Intro card FFmpeg render"
  );
  return outputPath;
}

async function renderIntroCard(videoTitle: string, duration: number, workDir: string): Promise<string> {
  // Always use FFmpeg-only implementation (no canvas dependency)
  return renderIntroCardFFmpeg(videoTitle, duration, workDir);
}

//// ─── 4c. Branded Outro Card ────────────────────────────────────────────
async function renderOutroCardFFmpeg(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "outro_card.mp4");
  await withTimeout(
    exec(
      `${FFMPEG_BIN} -y -f lavfi -i "color=c=#0a0a1e:size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=25" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "[0:v]drawtext=text='Thanks for watching!':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=h/2-80,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${duration - 0.4}:d=0.4[vout]" ` +
      `-map "[vout]" -map "1:a" ` +
      `-t ${duration} -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 320k -shortest "${outputPath}"`
    ),
    90_000, "Outro card FFmpeg render"
  );
  return outputPath;
}

async function renderOutroCard(duration: number, workDir: string): Promise<string> {
  // Always use FFmpeg-only implementation (no canvas dependency)
  return renderOutroCardFFmpeg(duration, workDir);
}

// ─── 5. Compose Scene Video (Vidrush-style hard-cut montage) ───────────────
async function composeSceneVideo(
  scene: Scene,
  clips: string[],
  audioPath: string,
  duration: number,
  workDir: string,
  totalScenes: number,
  enableSubtitles = false,  // Subtitles disabled by default
  rescueStockClip?: string | null,
  beatDurations?: number[]
): Promise<string> {
  const outputPath = path.join(workDir, `scene_${scene.index}_composed.mp4`);

  // Real stock only — no grey placeholders, no duplicate clips in this scene.
  const existingClips = clips.filter(
    (p) => p && fs.existsSync(p) && fs.statSync(p).size > 100 && !isPipelineFallbackClip(p)
  );
  const validClips: string[] = [];
  const seenKeys = new Set<string>();
  for (const clipPath of existingClips) {
    if (!(await isValidVideoFile(clipPath)) || (await isMostlyBlackClip(clipPath))) {
      console.warn(`[Pipeline] Scene ${scene.index}: skipping bad clip ${path.basename(clipPath)}`);
      continue;
    }
    const key = clipContentKey(clipPath);
    if (seenKeys.has(key)) {
      console.warn(`[Pipeline] Scene ${scene.index}: skipping duplicate clip ${path.basename(clipPath)}`);
      continue;
    }
    seenKeys.add(key);
    validClips.push(clipPath);
  }

  if (
    validClips.length === 0 &&
    rescueStockClip &&
    fs.existsSync(rescueStockClip) &&
    !isPipelineFallbackClip(rescueStockClip) &&
    (await isValidVideoFile(rescueStockClip))
  ) {
    validClips.push(rescueStockClip);
  }

  if (validClips.length === 0) {
    throw pipelineError(
      PIPELINE_ERROR.NO_SCENES,
      `Scene ${scene.index}: no usable stock clips (grey placeholders disabled)`
    );
  }

  let safeClips = validClips;

  const verifiedClips: string[] = [];
  for (const clip of safeClips) {
    const ok = await requireValidClip(clip, scene.index, duration, workDir);
    if (ok) verifiedClips.push(ok);
  }
  safeClips = verifiedClips.filter((clip, i, arr) => {
    const key = clipContentKey(clip);
    return arr.findIndex((c) => clipContentKey(c) === key) === i;
  });
  if (safeClips.length === 0) {
    throw pipelineError(
      PIPELINE_ERROR.NO_SCENES,
      `Scene ${scene.index}: all clips failed validation`
    );
  }

  // Validate audio
  const audioValid = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 100;
  let safeAudioPath = audioPath;
  if (!audioValid) {
    safeAudioPath = path.join(workDir, `scene_${scene.index}_silent.mp3`);
    try {
      await withTimeout(
        exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${safeAudioPath}"`),
        10_000, `Silent fallback scene ${scene.index}`
      );
    } catch {
      fs.writeFileSync(safeAudioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(413).fill(0)]));
    }
  }

  // Subtitle overlay: render if user has enabled subtitles
  let subtitlePath: string | null = null;
  if (enableSubtitles) {
    try {
      subtitlePath = await renderSubtitleOverlay(scene.text, scene.index, totalScenes, workDir);
    } catch (err) {
      console.warn(`[Pipeline] Scene ${scene.index}: subtitle overlay failed (non-fatal):`, err);
      subtitlePath = null;
    }
  }

  // Documentary overlays: orange name badge + yellow highlight caption (reference video style)
  let kineticFrames: KineticFrame[] = [];
  let docOverlays: TimedOverlay[] = [];
  try {
    if (documentaryStyleEnabled()) {
      const primaryPerson = (scene.personNames ?? []).find((n) => n?.trim());
      if (primaryPerson) {
        const badge = await renderNameBadgeOverlay(
          primaryPerson,
          scene.index,
          workDir,
          FFMPEG_BIN,
          (cmd, ms, lbl) => withTimeout(exec(cmd), ms, lbl)
        );
        if (badge) docOverlays.push(badge);
      }

      const llmWords = (scene.highlightWords || []).filter((w) => w && w.trim().length > 0);
      const highlightWord = llmWords[0] || extractKeywords(scene.text, 1)[0];
      if (highlightWord) {
        const caption = await renderHighlightCaptionOverlay(
          highlightWord,
          scene.index,
          workDir,
          FFMPEG_BIN,
          (cmd, ms, lbl) => withTimeout(exec(cmd), ms, lbl),
          duration
        );
        if (caption) docOverlays.push(caption);
      }
    }

    const shouldShowKinetic = false; // legacy center pills disabled
    if (shouldShowKinetic) {
      const legacyWords = (scene.highlightWords || []).filter((w) => w && w.trim().length > 0);
      const keywords = legacyWords.length > 0 ? legacyWords.slice(0, 2) : extractKeywords(scene.text, 1);
      if (keywords.length > 0) {
        // Show each word for 2s, distributed across the scene
        const wordDuration = 2.0;
        const gap = 0.4; // gap between words
        const totalWordTime = keywords.length * (wordDuration + gap);
        const startOffset = Math.max(0.5, (duration - totalWordTime) / 2);
        const allFrames: KineticFrame[] = [];
        for (let wi = 0; wi < keywords.length; wi++) {
          const wordStart = startOffset + wi * (wordDuration + gap);
          const wordEnd = Math.min(wordStart + wordDuration, duration - 0.3);
          if (wordStart >= duration - 0.5) break;
          const frames = await renderKineticFrames(
            [keywords[wi]],
            duration,
            scene.index,
            workDir,
            wordStart,
            wordEnd
          );
          allFrames.push(...frames);
        }
        kineticFrames = allFrames;
        console.log(`[Pipeline] Scene ${scene.index}: kinetic words: [${keywords.join(', ')}] (${legacyWords.length > 0 ? 'LLM' : 'fallback'})`);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Scene ${scene.index}: documentary overlays failed (non-fatal):`, err);
    kineticFrames = [];
    docOverlays = [];
  }

  // Stat callout box: yellow corner box with key statistic (reference video style)
  let statCalloutFrame: { path: string; startTime: number; endTime: number } | null = null;
  try {
    if (
      process.env.ENABLE_STAT_CALLOUTS === "true" &&
      scene.statCallout &&
      scene.statCallout.trim().length > 0
    ) {
      statCalloutFrame = await renderStatCallout(scene.statCallout, scene.index, workDir);
    }
  } catch {
    statCalloutFrame = null;
  }

  // On Railway, limit FFmpeg threads to reduce memory usage
  const threadFlag = IS_RAILWAY ? "-threads 2" : "";
  // Kinetic text position: upper-center area
  const kineticY = 80;
  // Cinematic color grading (documentaryStyle module when enabled)
  const colorGrade = documentaryStyleEnabled()
    ? buildPostGradeVF()
    : `eq=contrast=1.12:saturation=0.92:brightness=-0.02:gamma=1.02,colorbalance=rs=-0.02:gs=0:bs=0.03:rm=-0.01:gm=0:bm=0.02:rh=-0.01:gh=0:bh=0.02,vignette=angle=0.6:mode=forward`;
  const subtitleDrawtext = '';
  const fadeFilter = documentaryStyleEnabled() ? colorGrade : `${colorGrade}${subtitleDrawtext}`;

  // Helper: build the full overlay chain
  // Kinetic frames: full-width PNG at y=kineticY, timed with enable='between(t,...)'.
  // Stat callout: full-frame transparent PNG overlaid at x=0:y=0 (box is positioned inside the PNG).
  function buildKineticChain(
    baseLabel: string,
    baseInputCount: number
  ): { extraInputs: string; filterChain: string; finalLabel: string } {
    const allOverlays: Array<{ path: string; startTime: number; endTime: number; isStatCallout?: boolean }> = [
      ...kineticFrames,
      ...docOverlays,
      ...(statCalloutFrame ? [{ ...statCalloutFrame, isStatCallout: true }] : []),
    ];
    if (allOverlays.length === 0) {
      return { extraInputs: "", filterChain: "", finalLabel: baseLabel };
    }
    const extraInputs = allOverlays.map(f => `-loop 1 -i "${f.path}"`).join(" ");
    let chain = "";
    let prevLabel = baseLabel;
    allOverlays.forEach((frame, idx) => {
      const inputIdx = baseInputCount + idx;
      const outLabel = idx === allOverlays.length - 1 ? "kfinal" : `kf${idx}`;
      if ((frame as { isStatCallout?: boolean }).isStatCallout) {
        // Stat callout: full-frame overlay (box positioned inside PNG), bottom-right corner
        chain += `;[${prevLabel}][${inputIdx}:v]overlay=x=0:y=0:enable='between(t,${frame.startTime.toFixed(2)},${frame.endTime.toFixed(2)})'[${outLabel}]`;
      } else {
        // Kinetic word: top-center overlay
        chain += `;[${prevLabel}][${inputIdx}:v]overlay=x=0:y=${kineticY}:enable='between(t,${frame.startTime.toFixed(2)},${frame.endTime.toFixed(2)})'[${outLabel}]`;
      }
      prevLabel = outLabel;
    });
    return { extraInputs, filterChain: chain, finalLabel: "kfinal" };
  }

  // Final existence check before compose — log clearly if something is missing
  for (const clip of safeClips) {
    if (!fs.existsSync(clip)) {
      console.error(`[Pipeline] Scene ${scene.index}: clip file MISSING before compose: ${clip}`);
    }
  }
  if (!fs.existsSync(safeAudioPath)) {
    console.error(`[Pipeline] Scene ${scene.index}: audio file MISSING before compose: ${safeAudioPath}`);
  }

  const voiceDur =
    (audioValid ? (await probeVideoDurationSec(safeAudioPath)) : 0) ||
    Math.max(0.5, duration - 0.35);
  const outDur = voiceDur + 0.12;

  const montageDurationsRaw = alignBeatDurationsWithClips(clips, safeClips, beatDurations);
  let montageDurations = montageDurationsRaw;
  if (montageDurations?.length === safeClips.length) {
    montageDurations = await Promise.all(
      montageDurations.map(async (d, i) => {
        const probed = await probeVideoDurationSec(safeClips[i]);
        if (probed > 0.2 && d > probed * 0.98) {
          console.warn(
            `[Pipeline] Scene ${scene.index}: capping beat ${i} montage ${d.toFixed(2)}s → ${probed.toFixed(2)}s (avoid frozen frame)`
          );
          return probed * 0.98;
        }
        return d;
      })
    );
  }

  try {
    const { scaleFilters, mergeFilter, montageLabel: xfadeLabel } =
      buildMontageXfadeFilter(safeClips.length, outDur, scene.index, montageDurations);
    const inputs = safeClips.map((c) => `-i "${c}"`).join(" ");
    const durs =
      montageDurations ??
      Array.from({ length: safeClips.length }, () => computeMontageClipDuration(outDur, safeClips.length));
    const montageLabel = xfadeLabel;
    const padFilter = "";

    const audioIdx = safeClips.length;
    const kineticBaseIdx = audioIdx + 1;
    const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
      buildKineticChain(montageLabel, kineticBaseIdx);

    const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
    const kineticChainStr = kChain ? kChain : "";
    const hasOverlays = kineticFrames.length > 0 || docOverlays.length > 0 || statCalloutFrame !== null;
    const preGradeLabel = hasOverlays ? kFinalLabel : montageLabel;
    const audioFadeOutStart = Math.max(0, voiceDur - 0.15);
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}"${kineticInput} ` +
        `-filter_complex "${scaleFilters}${mergeFilter}${padFilter}${kineticChainStr};` +
        `[${preGradeLabel}]${FPS_FORMAT_VF}[vtimed];[vtimed]${fadeFilter}[vout];` +
        `[${audioIdx}:a]afade=t=in:st=0:d=0.06,afade=t=out:st=${audioFadeOutStart.toFixed(3)}:d=0.12,` +
        `atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
        `-map "[vout]" -map "[aout]" -vsync cfr ` +
        `-t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
      ),
      120_000, `Compose multi-clip scene ${scene.index}`
    );
  } catch (composeErr) {
    console.warn(`[Pipeline] Scene ${scene.index}: compose failed, trying simplified compose:`, composeErr);
    if (docOverlays.length > 0 || statCalloutFrame) {
      try {
        const { scaleFilters, mergeFilter, montageLabel: xfadeLabel } =
          buildMontageXfadeFilter(safeClips.length, outDur, scene.index, montageDurations);
        const inputs = safeClips.map((c) => `-i "${c}"`).join(" ");
        const montageLabel = xfadeLabel;
        const audioIdx = safeClips.length;
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ` +
              `-filter_complex "${scaleFilters}${mergeFilter};[${montageLabel}]${FPS_FORMAT_VF}[vtimed];[vtimed]${fadeFilter}[vout];` +
              `[${audioIdx}:a]afade=t=in:st=0:d=0.06,afade=t=out:st=${Math.max(0, voiceDur - 0.15).toFixed(3)}:d=0.12,` +
              `atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
              `-map "[vout]" -map "[aout]" -vsync cfr ` +
              `-t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
          ),
          120_000,
          `Compose without overlays scene ${scene.index}`
        );
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
          if (subtitlePath) { try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ } }
          for (const frame of kineticFrames) { try { fs.unlinkSync(frame.path); } catch { /* ignore */ } }
          for (const overlay of docOverlays) { try { fs.unlinkSync(overlay.path); } catch { /* ignore */ } }
          return outputPath;
        }
      } catch (noOverlayErr) {
        console.warn(`[Pipeline] Scene ${scene.index}: compose without overlays failed:`, noOverlayErr);
      }
    }
    try {
      const clipDur = computeMontageClipDuration(outDur, safeClips.length);
      const n = Math.min(12, Math.max(2, safeClips.length));
      const subset = safeClips.slice(0, n);
      const inputs = subset.map((c) => `-i "${c}"`).join(" ");
      const { scaleFilters, mergeFilter, montageLabel } = buildMontageXfadeFilter(n, outDur, scene.index);
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ` +
          `-filter_complex "${scaleFilters}${mergeFilter};[${montageLabel}]copy[vout];[${n}:a]atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
          `-map "[vout]" -map "[aout]" -vsync cfr ` +
          `-t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        90_000,
        `Simplified multi-clip scene ${scene.index}`
      );
    } catch (simpleErr) {
      console.warn(`[Pipeline] Scene ${scene.index}: simplified compose failed, trying looped montage mux:`, simpleErr);
      try {
        const loopVideo = safeClips;
        const n = loopVideo.length;
        if (n > 1) {
          const inputs = loopVideo.map((c) => `-i "${c}"`).join(" ");
          const { scaleFilters, mergeFilter, montageLabel } = buildMontageXfadeFilter(n, outDur, scene.index, montageDurations);
          await withTimeout(
            exec(
              `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}" ` +
                `-filter_complex "${scaleFilters}${mergeFilter};[${montageLabel}]${FPS_FORMAT_VF}[vout];[${n}:a]atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
                `-map "[vout]" -map "[aout]" -vsync cfr ` +
                `-t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
            ),
            90_000,
            `Looped montage scene ${scene.index}`
          );
        } else {
          const singleDur = await probeVideoDurationSec(safeClips[0]);
          const clipPlay = Math.min(outDur, singleDur > 0.2 ? singleDur : outDur);
          const padTail = Math.max(0, outDur - clipPlay);
          await withTimeout(
            exec(
              `${FFMPEG_BIN} -y -i "${safeClips[0]}" -i "${safeAudioPath}" ` +
                `-filter_complex "[0:v]trim=duration=${clipPlay.toFixed(3)},setpts=PTS-STARTPTS,` +
                `tpad=stop_mode=clone:stop_duration=${padTail.toFixed(3)},${FPS_FORMAT_VF}[vout];` +
                `[1:a]atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
                `-map "[vout]" -map "[aout]" -vsync cfr ` +
                `-t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
            ),
            45_000,
            `Hold-last-frame mux scene ${scene.index}`
          );
        }
      } catch (muxErr) {
        console.warn(`[Pipeline] Scene ${scene.index}: simple mux failed:`, muxErr);
        if (!safeClips[0] || isPipelineFallbackClip(safeClips[0])) {
          throw pipelineError(PIPELINE_ERROR.FFMPEG, `Scene ${scene.index}: compose failed (no grey fallback)`);
        }
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${safeClips[0]}" -i "${safeAudioPath}" ` +
            `-filter_complex "[1:a]atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
            `-map "0:v" -map "[aout]" ` +
            `-t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
          ),
          60_000,
          `Color fallback scene ${scene.index}`
        );
      }
    }
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
    throw pipelineError(PIPELINE_ERROR.FFMPEG, `Scene ${scene.index} produced no output video`);
  }

  if (await isMostlyBlackClip(outputPath) && rescueStockClip && fs.existsSync(rescueStockClip)) {
    console.warn(`[Pipeline] Scene ${scene.index}: composed output mostly black — retry with rescue clip`);
    try {
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -ss 0.3 -i "${rescueStockClip}" -i "${safeAudioPath}" ` +
          `-filter_complex "[1:a]atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]" ` +
          `-map "0:v" -map "[aout]" -t ${outDur.toFixed(3)} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 ` +
          `-c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        90_000,
        `Rescue recompose scene ${scene.index}`
      );
    } catch (err) {
      console.warn(`[Pipeline] Scene ${scene.index}: rescue recompose failed:`, (err as Error).message);
    }
  }

  if (subtitlePath) { try { fs.unlinkSync(subtitlePath); } catch { /* ignore */ } }
  // Clean up kinetic frame PNGs
  for (const frame of kineticFrames) {
    try { fs.unlinkSync(frame.path); } catch { /* ignore */ }
  }
  for (const overlay of docOverlays) {
    try { fs.unlinkSync(overlay.path); } catch { /* ignore */ }
  }
  return outputPath;
}

// ─── 6. Ambient Documentary Background Music ─────────────────────────────────
// Generates a rich ambient documentary track inspired by Vox/Wendover/Kurzgesagt style:
// - Layered harmonic pads (root, fifth, octave, minor seventh) for emotional depth
// - Subtle rhythmic pulse via amplitude modulation for forward momentum
// - Noise-based hi-hat texture for organic feel
// - Deep sub-bass foundation
// - Long reverb tails for spacious, cinematic atmosphere
// Mixed at -20dB relative to voiceover (ducked further by sidechaincompress in final mix)
async function generateBackgroundMusic(duration: number, workDir: string): Promise<string> {
  const outputPath = path.join(workDir, "bg_music.mp3");
  try {
    // Root: A2 (110Hz) — warm, serious documentary tone
    // Fifth: E3 (165Hz) — harmonic stability
    // Octave: A3 (220Hz) — brightness
    // Minor seventh: G3 (196Hz) — slight tension, modern feel
    // Sub-bass: A1 (55Hz) — foundation
    // Pulse: 2Hz AM on root for subtle rhythmic breathing
    // Hi-hat texture: bandpass-filtered white noise at very low volume
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y ` +
        // Root pad — A2, warm and central
        `-f lavfi -i "sine=frequency=110:duration=${duration}" ` +
        // Perfect fifth — E3
        `-f lavfi -i "sine=frequency=165:duration=${duration}" ` +
        // Octave — A3
        `-f lavfi -i "sine=frequency=220:duration=${duration}" ` +
        // Minor seventh — G3 (adds modern tension)
        `-f lavfi -i "sine=frequency=196:duration=${duration}" ` +
        // Sub-bass — A1
        `-f lavfi -i "sine=frequency=55:duration=${duration}" ` +
        // Second harmonic of root — A4 (330Hz, very quiet shimmer)
        `-f lavfi -i "sine=frequency=330:duration=${duration}" ` +
        // White noise for hi-hat texture
        `-f lavfi -i "anoisesrc=r=44100:color=white:duration=${duration}" ` +
        `-filter_complex "` +
          // Root pad: volume + long echo reverb + gentle 2Hz AM pulse (aeval) + lowpass
          `[0]volume=0.40,aecho=0.97:0.94:400:0.65,aeval='val(0)*(0.82+0.18*sin(2*PI*2*t))',lowpass=f=180[root];` +
          // Fifth: volume + echo + lowpass for warmth
          `[1]volume=0.28,aecho=0.95:0.92:300:0.55,lowpass=f=250[fifth];` +
          // Octave: quieter, echo, lowpass
          `[2]volume=0.18,aecho=0.92:0.88:200:0.45,lowpass=f=350[oct];` +
          // Minor seventh: very quiet, adds modern color
          `[3]volume=0.12,aecho=0.90:0.86:250:0.40,lowpass=f=300[seventh];` +
          // Sub-bass: deep, slow 1Hz AM pulse for breathing feel
          `[4]volume=0.30,aecho=0.98:0.96:600:0.70,aeval='val(0)*(0.75+0.25*sin(2*PI*1*t))',lowpass=f=100[sub];` +
          // High shimmer: very quiet
          `[5]volume=0.06,aecho=0.88:0.84:150:0.35,lowpass=f=500[shimmer];` +
          // Hi-hat: bandpass 6kHz-12kHz, very quiet, adds organic texture
          `[6]volume=0.04,highpass=f=6000,lowpass=f=12000[hihat];` +
          // Mix all layers
          `[root][fifth][oct][seventh][sub][shimmer][hihat]amix=inputs=7:duration=first:dropout_transition=3,` +
          // Global EQ: remove rumble below 30Hz, gentle high shelf cut above 1kHz
          `highpass=f=30,lowpass=f=1200,` +
          // Subtle room reverb on the full mix
          `aecho=0.75:0.72:500:0.20,` +
          // Final volume
          `volume=0.50[music]` +
        `" ` +
        `-map "[music]" -c:a libmp3lame -b:a 320k "${outputPath}"`
      ),
      45_000, "Background music generation"
    );
    console.log(`[Pipeline] Background music generated: ${(fs.statSync(outputPath).size / 1024).toFixed(0)}KB`);
    return outputPath;
  } catch (err) {
    console.warn("[Pipeline] Music generation failed, using silence:", err);
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -c:a libmp3lame -b:a 64k "${outputPath}"`).catch((e) => { console.error('[Pipeline] Music silence fallback failed:', e); });
    return outputPath;
  }
}


// ─── 6b. Sound Effects (SFX) Generation ──────────────────────────────────────
// Generates camera shutter, whoosh, and impact sounds using FFmpeg lavfi synthesis.
// These are mixed into the final audio at low volume for Vidrush-style energy.
async function generateSFX(
  type: 'shutter' | 'whoosh' | 'impact',
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `sfx_${type}.mp3`);
  try {
    let cmd = '';
    if (type === 'shutter') {
      // Camera shutter: short high-freq click (2kHz, 0.05s) + mechanical thud (200Hz, 0.08s)
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=2000:duration=0.05" ` +
        `-f lavfi -i "sine=frequency=200:duration=0.08" ` +
        `-filter_complex "[0]volume=0.6,aecho=0.8:0.3:10:0.2[click];[1]volume=0.4,lowpass=f=400[thud];[click][thud]amix=inputs=2:duration=longest[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    } else if (type === 'whoosh') {
      // Whoosh: swept sine 200Hz→2000Hz over 0.2s for transition sound
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=200:duration=0.2" ` +
        `-f lavfi -i "sine=frequency=2000:duration=0.2" ` +
        `-filter_complex "[0]volume=0.5,aecho=0.7:0.5:20:0.3[low];[1]volume=0.3,aecho=0.7:0.5:15:0.2[high];[low][high]amix=inputs=2:duration=longest,atempo=1.5[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    } else {
      // Impact: low thud (80Hz, 0.15s) with decay
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=80:duration=0.15" ` +
        `-filter_complex "[0]volume=0.7,aecho=0.9:0.6:30:0.4,lowpass=f=300[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    }
    await withTimeout(exec(cmd), 10_000, `SFX generation: ${type}`);
    return outputPath;
  } catch (err) {
    console.warn(`[Pipeline] SFX generation failed for ${type}:`, err);
    // Return empty audio as fallback
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 0.1 -c:a libmp3lame -b:a 64k "${outputPath}"`).catch(() => {});
    return outputPath;
  }
}

async function probeVideoDurationSec(filePath: string): Promise<number> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  for (const probe of FFPROBE_PATHS()) {
    try {
      const { stdout } = await execFileAsync(probe, [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", filePath,
      ]);
      const d = parseFloat(String(stdout).trim());
      if (!isNaN(d) && d > 0) return d;
    } catch { /* try next */ }
  }
  return 0;
}

/** Trim leading/trailing silence so scenes concatenate without dead air. */
async function trimVoiceoverSilence(audioPath: string): Promise<number> {
  if (!fs.existsSync(audioPath)) return 0;
  const tmpPath = audioPath.replace(/\.mp3$/i, "_trim.mp3");
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${audioPath}" -af ` +
        `"silenceremove=start_periods=1:start_duration=0.06:start_threshold=-42dB:detection=peak,` +
        `areverse,silenceremove=start_periods=1:start_duration=0.1:start_threshold=-42dB:detection=peak,areverse" ` +
        `-c:a libmp3lame -b:a 192k "${tmpPath}"`
      ),
      45_000,
      "Trim voiceover silence"
    );
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 400) {
      fs.unlinkSync(audioPath);
      fs.renameSync(tmpPath, audioPath);
    } else if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn(`[Pipeline] Voice trim skipped for ${path.basename(audioPath)}:`, (err as Error).message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
  const probed = await probeVideoDurationSec(audioPath);
  return probed > 0 ? probed : 0;
}

/** Pad with last-frame hold so 2-min tests reliably hit 118s (no black tail). */
async function ensureFinalVideoDuration(
  inputPath: string,
  workDir: string,
  videoId: number,
  targetSec: number
): Promise<string> {
  let working = inputPath;
  const trimmed = path.join(workDir, `fastvid_${videoId}_trimtail.mp4`);
  try {
    const detectCmd =
      `"${FFMPEG_BIN}" -y -i "${working}" -vf "blackdetect=d=0.04:pix_th=0.12" -an -f null -`;
    const { stderr } = await withTimeout(exec(detectCmd), 60_000, "Final blackdetect trim");
    const out = typeof stderr === "string" ? stderr : String(stderr ?? "");
    const starts = [...out.matchAll(/black_start:([\d.]+)/g)].map((m) => parseFloat(m[1]));
    const ends = [...out.matchAll(/black_end:([\d.]+)/g)].map((m) => parseFloat(m[1]));
    let trimTo = await probeVideoDurationSec(working);
    if (starts.length > 0 && ends.length > 0) {
      const lastBlackStart = starts[starts.length - 1];
      const lastBlackEnd = ends[ends.length - 1];
      const probedBeforeTrim = await probeVideoDurationSec(working);
      // Only trim trailing black in the last ~25% — avoid chopping mid-video on dark grading.
      if (
        probedBeforeTrim > 0 &&
        lastBlackStart >= probedBeforeTrim * 0.72 &&
        lastBlackEnd >= trimTo - 0.25 &&
        lastBlackStart < trimTo - 0.15
      ) {
        trimTo = Math.max(1, lastBlackStart - 0.02);
      }
    }
    const probed = await probeVideoDurationSec(working);
    if (trimTo < probed - 0.4) {
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -i "${working}" -t ${trimTo.toFixed(3)} -c:v libx264 -preset veryfast -crf 18 ` +
          `-c:a aac -b:a 320k -movflags +faststart "${trimmed}"`
        ),
        90_000,
        "Trim trailing black from final"
      );
      working = trimmed;
      console.log(`[Pipeline] Trimmed trailing black: ${probed.toFixed(1)}s → ${trimTo.toFixed(1)}s`);
    }
  } catch (err) {
    console.warn("[Pipeline] Final black trim skipped (non-fatal):", (err as Error).message);
  }

  let dur = await probeVideoDurationSec(working);
  if (dur >= targetSec - 0.3) return working;
  const pad = Math.max(0.5, targetSec - dur);
  const out = path.join(workDir, `fastvid_${videoId}_padded.mp4`);
  const holdAt = Math.max(0, dur - 0.15);
  console.log(`[Pipeline] Final ${dur.toFixed(1)}s < ${targetSec}s — padding ${pad.toFixed(1)}s from t=${holdAt.toFixed(1)}s`);
  try {
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -ss ${holdAt.toFixed(3)} -i "${working}" ` +
        `-vf "tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}" ` +
        `-af "apad=pad_dur=${pad.toFixed(3)}" ` +
        `-c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -movflags +faststart -shortest "${out}"`
      ),
      120_000,
      `Pad final video to ${targetSec}s`
    );
    if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
      dur = await probeVideoDurationSec(out);
      if (dur >= targetSec - 0.5) return out;
    }
  } catch (err) {
    console.warn("[Pipeline] Final tpad pad failed (non-fatal):", (err as Error).message);
  }
  return working;
}

// ─── 7. Final Concatenation + Music Mix ───────────────────────────────────────
async function concatenateScenesWithMusic(
  scenePaths: string[],
  workDir: string,
  videoId: number,
  totalDuration: number,
  videoTitle: string
): Promise<string> {
  const listFile = path.join(workDir, "concat_list.txt");
  const concatPath = path.join(workDir, `fastvid_${videoId}_concat.mp4`);
  const outputPath = path.join(workDir, `fastvid_${videoId}_final.mp4`);

  const validScenePaths = scenePaths.filter(p => {
    try {
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : 0;
      if (!exists) console.error(`[Pipeline] Concat: scene file MISSING: ${p}`);
      else if (size <= 100) console.error(`[Pipeline] Concat: scene file too small (${size} bytes): ${p}`);
      return exists && size > 100;
    } catch { return false; }
  });
  if (validScenePaths.length === 0) {
    throw pipelineError(PIPELINE_ERROR.NO_SCENES, "No valid composed scene files to concatenate");
  }

  const allClips = [...validScenePaths];
  const listContent = allClips.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent, "utf-8");

  const totalWithCards = totalDuration;

  const [, musicPath] = await Promise.all([
    withTimeout(
      exec(`${FFMPEG_BIN} -y -f concat -safe 0 -i "${listFile}" -vsync cfr -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -movflags +faststart "${concatPath}"`),
      900_000, // 15 min for large videos (30+ scenes)
      "Scene concatenation"
    ),
    generateBackgroundMusic(totalWithCards + 5, workDir),
  ]);

  // Verify concat output exists before music mixing
  if (!fs.existsSync(concatPath) || fs.statSync(concatPath).size < 1000) {
    throw pipelineError(PIPELINE_ERROR.CONCAT, "Concat failed: output file missing or empty");
  }
  console.log(`[Pipeline] Concat output: ${(fs.statSync(concatPath).size / 1024 / 1024).toFixed(1)}MB`);

  // Check if concat video has an audio stream
  // Try multiple probe methods; if all fail, assume audio IS present to avoid silent videos
  let concatHasAudio = true; // default: assume audio present
  try {
    const { execSync: es } = await import("child_process");
    let probed = false;
    for (const probePath of FFPROBE_PATHS()) {
      try {
        const probeOut = es(`${probePath} -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${concatPath}"`, { encoding: 'utf8', timeout: 10000 });
        concatHasAudio = probeOut.trim().includes('audio');
        probed = true;
        console.log(`[Pipeline] Audio probe (${probePath}): hasAudio=${concatHasAudio}`);
        break;
      } catch { /* try next */ }
    }
    if (!probed) {
      console.warn('[Pipeline] All ffprobe paths failed — assuming audio present to avoid silent video');
      concatHasAudio = true;
    }
  } catch {
    console.warn('[Pipeline] Audio probe completely failed — assuming audio present');
    concatHasAudio = true;
  }
  console.log(`[Pipeline] Concat has audio: ${concatHasAudio}`);

  if (concatHasAudio) {
    // Normal path: mix voiceover audio with background music
    // VO at 100%, ambient music at 18% (like reference video: -20dB to -25dB relative)
    try {
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
          // Dynamic ducking: music drops to 8% under voiceover, rises to 22% during pauses
          // sidechaincompress: music is compressed when VO is present (attack=5ms, release=200ms)
          // This matches the reference video: VO always dominant, music swells in pauses
          `-filter_complex "[0:a]volume=1.0,asplit=2[voice][voicedet];[1:a]volume=0.22,aloop=loop=-1:size=2e+09[musicloop];[musicloop][voicedet]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200:makeup=1[music_ducked];[voice][music_ducked]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
          `-map "0:v" -map "[aout]" ` +
          `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`
        ),
        180_000,
        "Background music mixing"
      );
    } catch (err) {
      console.warn("[Pipeline] Audio mixing failed, trying without aloop:", err);
      try {
        await withTimeout(
          exec(
            `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
            `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.12[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
            `-map "0:v" -map "[aout]" ` +
            `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`
          ),
          180_000,
          "Background music mixing (no loop)"
        );
      } catch (err2) {
        console.warn("[Pipeline] Audio mixing failed completely, copying video:", err2);
        await withTimeout(
          exec(`${FFMPEG_BIN} -y -i "${concatPath}" -c copy -movflags +faststart "${outputPath}"`),
          60_000, "Copy concat as output"
        );
      }
    }
  } else {
    // Fallback: concat has no audio — use only background music at 25%
    console.warn("[Pipeline] Concat has no audio stream, using background music only");
    await withTimeout(
      exec(
        `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
        `-filter_complex "[1:a]volume=0.25,aloop=loop=-1:size=2e+09[aout]" ` +
        `-map "0:v" -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`
      ),
      120_000, "Background music mixing (no voiceover)"
    );
  }

  try {
    fs.unlinkSync(concatPath);
    fs.unlinkSync(musicPath);
  } catch { /* ignore */ }

  return outputPath;
}

/** Voiceover-timeline in editor vóór beelden (stap 4 in PIPELINE_WORKFLOW). */
async function persistEditorDraftAfterVoiceover(videoId: number, scenes: Scene[]): Promise<void> {
  try {
    const editorScenes: EditorScene[] = scenes.map((scene) => ({
      sceneIndex: scene.index,
      title: scene.visualCue,
      narration: scene.text,
      durationMs: Math.round(scene.duration * 1000),
      clips: [],
      chapterTitle: scene.chapterTitle,
    }));
    await updateVideoScenes(videoId, editorScenes);
    console.log(
      `[Pipeline] Editor draft: ${editorScenes.length} scenes (voiceover in edit system, visuals next)`
    );
  } catch (err) {
    console.warn("[Pipeline] Editor draft save failed (non-fatal):", (err as Error).message);
  }
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────
export async function runVideoPipeline(
  videoId: number,
  script: string,
  onProgress?: (p: PipelineProgress) => void,
  voiceId?: string,
  customVoiceoverUrl?: string,
  videoLength: string = "8-12",
  enableSubtitles = false,  // Subtitles disabled by default — user can enable via UI
  userPrompt?: string
): Promise<string> {
  const maxScenes = getScenesForLength(videoLength);
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
  const workDir = path.join(TMP_DIR, `fastvid_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const videoRow = await getVideoById(videoId);
  const effectiveVoiceId = voiceId?.trim() || videoRow?.voiceId?.trim() || undefined;
  if (effectiveVoiceId) {
    console.log(`[Pipeline] Video ${videoId}: using selected ElevenLabs voice ${effectiveVoiceId.slice(0, 12)}…`);
  } else if (!customVoiceoverUrl) {
    console.warn(`[Pipeline] Video ${videoId}: no voiceId on record — using default narrator`);
  }

  const titleMatch = script.match(/^#\s+(.+)/m);
  const videoTitle = titleMatch?.[1]?.trim().slice(0, 80)
    || script.split("\n").find(l => l.trim().length > 5)?.trim().slice(0, 80)
    || "AI Generated Video";
  const topicContext = buildTopicContext(userPrompt ?? videoRow?.prompt, videoTitle);
  const muskLocked = isMuskTeslaTopic(topicContext, script);
  const primaryPerson =
    extractPrimaryPersonFromText(userPrompt ?? videoRow?.prompt ?? "") ||
    extractPrimaryPersonFromText(videoTitle) ||
    extractPrimaryPersonFromText(topicContext) ||
    extractPersonNamesFromText(script)[0] ||
    "";
  const personLocked = Boolean(primaryPerson) || isPersonCelebrityTopic(topicContext);

  console.log(
    `[Pipeline] Video ${videoId}: ${maxScenes} scenes for ${videoLength} min` +
    (muskLocked ? " [Musk/Tesla topic lock]" : "") +
    (personLocked ? ` [person lock: ${primaryPerson}]` : "") +
    (curatedArchiveOnlyVisuals() ? " [curated archive visuals]" : "") +
    (elevenLabsOnlyVoice() ? " [ElevenLabs voice]" : "")
  );

  try {
    // ── Stage 1: Parse script into scenes ────────────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.parsing, percent: 3 });
    const t0 = Date.now();
    const scenes = await parseScriptIntoScenes(script, maxScenes, topicContext);
    for (const scene of scenes) {
      sanitizeSceneStockQueries(scene, topicContext ?? videoTitle);
      if (muskLocked) sanitizeSceneForMuskTopic(scene, scene.index, topicContext ?? videoTitle);
      if (personLocked && primaryPerson) sanitizeSceneForPersonTopic(scene, primaryPerson);
    }
    console.log(`[Pipeline] Stage 1 (parse): ${scenes.length} scenes in ${((Date.now()-t0)/1000).toFixed(1)}s`);

    // ── Stage 2: Generate ALL voiceovers in parallel batches ──────────────────
    onProgress?.({ stage: STAGE_LABELS.voiceovers, percent: 8 });
    const t1 = Date.now();
    const audioPaths = scenes.map((_, i) => path.join(workDir, `scene_${i}_audio.mp3`));
    let durations: number[];

    if (customVoiceoverUrl) {
      const customAudioPath = path.join(workDir, "custom_voiceover.mp3");
      const resp = await fetch(customVoiceoverUrl);
      if (!resp.ok) {
        throw pipelineError(PIPELINE_ERROR.CUSTOM_VOICEOVER, `Failed to download custom voiceover: ${resp.status}`);
      }
      fs.writeFileSync(customAudioPath, Buffer.from(await resp.arrayBuffer()));
      const { execFile } = await import("child_process");
      const totalDuration = await new Promise<number>((resolve) => {
        execFile(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", customAudioPath], (_err: unknown, stdout: string) => {
          resolve(parseFloat(stdout?.trim() ?? "60") || 60);
        });
      });
      const perScene = Math.max(totalDuration / scenes.length, 5);
      for (let i = 0; i < scenes.length; i++) {
        const start = i * perScene;
        await exec(`${FFMPEG_BIN} -y -i "${customAudioPath}" -ss ${start} -t ${perScene} -c copy "${audioPaths[i]}"`);
      }
      durations = scenes.map(() => perScene);
    } else {
      durations = await withTimeout(
        generateBulkSceneVoiceovers(scenes, audioPaths, workDir, effectiveVoiceId, (done, total) => {
          onProgress?.({
            stage:
              done === 0
                ? STAGE_LABELS.voiceovers
                : `${STAGE_LABELS.voiceovers} (${done}/${total})`,
            percent: 8 + Math.round((done / total) * 10),
          });
        }, script),
        bulkVoiceoverTimeoutMs(scenes.length),
        "Bulk voiceover generation"
      );
    }
    // Tight VO sync: scene length tracks narration; target length padded only on final export
    const shortTargetSec: Record<string, number> = { "1": 58, "2": 118 };
    const targetTotal = shortTargetSec[videoLength];
    const VO_SCENE_TAIL_SEC = 0.35;
    for (let i = 0; i < scenes.length; i++) {
      const probed = await probeVideoDurationSec(audioPaths[i]);
      const audioSec = Math.max(durations[i] || 3, probed || durations[i] || 3);
      durations[i] = audioSec;
      scenes[i].duration = audioSec + VO_SCENE_TAIL_SEC;
    }
    const voTotal = scenes.reduce((sum, s) => sum + s.duration, 0);
    if (targetTotal) {
      console.log(
        `[Pipeline] ${videoLength}-min: VO-synced ${voTotal.toFixed(1)}s (${scenes.length} scenes); ` +
        `final pad to ~${targetTotal}s at export if needed`
      );
    } else {
      console.log(`[Pipeline] VO-synced total ${voTotal.toFixed(1)}s (${scenes.length} scenes)`);
    }
    console.log(`[Pipeline] Stage 2 (voiceovers): ${scenes.length} in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    onProgress?.({ stage: STAGE_LABELS.editorDraft, percent: 17 });
    await persistEditorDraftAfterVoiceover(videoId, scenes);

    // ── Stage 3: Per-zin visuals (power word → clip) ─────────────────────────
    onProgress?.({ stage: STAGE_LABELS.visuals, percent: 20 });
    const t2 = Date.now();
    if (curatedArchiveOnlyVisuals()) {
      const archiveReady = await archiveVisualSourcesReady();
      if (!archiveReady.ok) {
        throw pipelineError(
          PIPELINE_ERROR.NO_SCENES,
          archiveReady.message ?? "No media archive assets available for visuals"
        );
      }
      console.log(
        `[Pipeline] Visual sourcing: media archive only (${archiveReady.activeArchives} active archive(s), ${archiveReady.totalAssets} asset(s))`
      );
    } else {
      const hasRealOrAi =
        youtubeCcReady() ||
        Boolean(SERPAPI_KEY) ||
        cheapAiImageProvidersReady() ||
        Boolean(PEXELS_API_KEY || PIXABAY_API_KEY);
      if (!hasRealOrAi) {
        throw pipelineError(
          PIPELINE_ERROR.NO_SCENES,
          "No visual sources: set YOUTUBE_API_KEY+RAPIDAPI_KEY and/or STABILITY_AI_API_KEY (stock optional)"
        );
      }
    }
    const perf = getPipelinePerfProfile(videoLength);
    if (!curatedArchiveOnlyVisuals()) {
      if (minimizeStockFootageEnabled()) {
        console.log(
          `[Pipeline] Minimize stock: real footage → AI; ≤${perf.maxStockBeatsPerVideo} licensed stock clip(s) per video`
        );
      } else if (!PEXELS_API_KEY && !PIXABAY_API_KEY) {
        console.warn("[Pipeline] No Pexels/Pixabay — relying on YouTube CC and AI only");
      }
      if (SERPAPI_KEY) {
        console.log("[Pipeline] SERPAPI_KEY set — celebrity/person image fallback enabled");
      } else if (/kylie|jenner|celebrity|musk|tesla/i.test(topicContext ?? userPrompt ?? "")) {
        console.warn("[Pipeline] SERPAPI_KEY not set — named-person videos may lack real photos of the subject");
      }
    }
    console.log(
      `[Pipeline] Perf budget: ≤${perf.targetWallClockMin}min wall-clock, ` +
      `≤${perf.maxBeatsPerScene} beats/scene, ${perf.sceneParallelism} parallel scenes, ` +
      `sourcing=${curatedArchiveOnlyVisuals() ? "media archive only" : youtubeOnlySourcingEnabled() ? `YouTube-only ≤${youtubeBeatSearchBudgetMs() / 1000}s → Pexels` : youtubeSourcingEnabled() ? "YouTube+archival" : "archival+stills → Pexels (YouTube off)"}, ` +
      `clip-vision=${clipVisionGateEnabled() ? "on" : "off"}, ` +
      `fair-use transform=${perf.skipFairUseTransform ? "skip" : "on"}, ` +
      `AI fallback=${perf.enableAiFallback ? `on (max ${perf.maxAiClipsPerVideo} clips)` : "off"}, ` +
      `minimize stock=${perf.minimizeStockFootage ? `yes (≤${perf.maxStockBeatsPerVideo} Pexels/Pixabay)` : "no"}`
    );
    if (!perf.enableAiFallback && !cheapAiImageProvidersReady()) {
      console.warn(
        "[Pipeline] No cheap AI keys — empty beats stay empty (set STABILITY_AI_API_KEY, ~$0.03/img)"
      );
    } else if (perf.enableAiFallback) {
      console.log(
        `[Pipeline] AI fallback: cheap image tier (Stability Core → Leonardo); ` +
        `video APIs ${premiumAiVideoFallbackEnabled() ? "on" : "off (set ENABLE_AI_VIDEO_FALLBACK=true to enable)"}`
      );
    }
    const visualDedup = createVisualDedupState(perf, { primaryPerson, personTopicLock: personLocked });

    const visualLimit = pLimit(perf.sceneParallelism);
    let completedVisuals = 0;
    let activeSceneIdx = 0;
    let heartbeatTick = 0;
    const visualHeartbeat = setInterval(() => {
      heartbeatTick++;
      const sceneNum = Math.min(activeSceneIdx + 1, scenes.length);
      onProgress?.({
        stage: `Fetching visuals (scene ${sceneNum}/${scenes.length}, ${completedVisuals} done, tick ${heartbeatTick})...`,
        percent: 20 + Math.round(((completedVisuals + 0.15) / scenes.length) * 25),
      });
    }, 10_000);
    let sceneVisualResults: SceneVisualsResult[];
    try {
    sceneVisualResults = await withTimeout(
      Promise.all(scenes.map((scene, sceneIdx) => visualLimit(async () => {
        activeSceneIdx = sceneIdx;
        let result: SceneVisualsResult;
        try {
          result = await withTimeout(
            fetchSceneVisuals(scene, workDir, topicContext, visualDedup, (beatIdx, beatTotal, phase) => {
              const stage =
                phase === "backfill"
                  ? `Scene ${sceneIdx + 1}/${scenes.length}: backfill ${beatIdx}/${beatTotal}...`
                  : `Scene ${sceneIdx + 1}/${scenes.length}: beat ${beatIdx + 1}/${beatTotal}...`;
              onProgress?.({
                stage,
                percent: 20 + Math.round(((sceneIdx + (beatIdx + 1) / Math.max(1, beatTotal)) / scenes.length) * 25),
              });
            }),
            perf.sceneVisualTimeoutMs,
            `Scene ${scene.index} visuals`
          );
        } catch (sceneErr) {
          console.warn(
            `[Pipeline] Scene ${scene.index} visuals failed after ${Math.round(perf.sceneVisualTimeoutMs / 1000)}s — recovering:`,
            (sceneErr as Error).message
          );
          visualDedup.lock = Promise.resolve();
          result = await recoverSceneClipsIfEmpty(scene, workDir, topicContext, visualDedup);
          if (result.clips.length === 0) throw sceneErr;
        }
        completedVisuals++;
        onProgress?.({
          stage: curatedArchiveOnlyVisuals()
            ? `Matching archive visuals... (${completedVisuals}/${scenes.length} scenes done)`
            : `Generating AI visuals... (${completedVisuals}/${scenes.length} scenes done)`,
          percent: 20 + Math.round((completedVisuals / scenes.length) * 25),
        });
        return result;
      }))),
      visualStageTimeoutMs(videoLength, perf),
      `Visual generation stage (≤${Math.round(visualStageTimeoutMs(videoLength, perf) / 60_000)}min cap)`
    );
    } finally {
      clearInterval(visualHeartbeat);
    }
    console.log(`[Pipeline] Stage 3 (visuals): ${((Date.now()-t2)/1000).toFixed(1)}s`);

    for (let si = 0; si < scenes.length; si++) {
      const usable = (sceneVisualResults[si]?.clips ?? []).filter(
        (c) => c && !isPipelineFallbackClip(c)
      );
      if (usable.length > 0) continue;
      console.warn(`[Pipeline] Scene ${scenes[si].index}: empty after fetch — recovery sweep`);
      sceneVisualResults[si] = await recoverSceneClipsIfEmpty(
        scenes[si], workDir, topicContext, visualDedup
      );
      if (
        sceneVisualResults[si].clips.length === 0 &&
        perf.enableAiFallback &&
        visualDedup.aiClipsUsed < perf.maxAiClipsPerVideo
      ) {
        const scene = scenes[si];
        const scenePersons = resolveScenePersons(scene, topicContext, visualDedup.primaryPerson || undefined);
        const power = extractPowerWordFromSentence(scene.text.slice(0, 200), scenePersons);
        const rescueBeat: SceneBeat = {
          index: 0,
          text: scene.text.slice(0, 200),
          searchQuery: stockQueryFromBeatScript(scene.text, scenePersons, scene.text, topicContext),
          powerWord: power,
          keywords: buildRelevanceKeywords(scene, scene.text),
          holdSec: VIDRUSH_BEAT_SEC,
        };
        const aiClip = await fetchBeatAIClip(
          rescueBeat,
          scene,
          workDir,
          scene.index,
          0,
          4,
          visualDedup,
          topicContext
        );
        if (aiClip && !isPipelineFallbackClip(aiClip)) {
          sceneVisualResults[si] = {
            clips: [aiClip],
            beatDurations: [Math.max(VIDRUSH_BEAT_SEC, scene.duration / 2)],
          };
          console.warn(`[Pipeline] Scene ${scene.index}: last-resort AI clip`);
        }
      }
      if (sceneVisualResults[si].clips.length === 0) {
        throw pipelineError(
          PIPELINE_ERROR.NO_SCENES,
          curatedArchiveOnlyVisuals()
            ? `Scene ${scenes[si].index} has no matching clips in the media archive — add more tagged assets`
            : `Scene ${scenes[si].index} has no stock footage after recovery`
        );
      }
    }

    // ── Save scene manifest for editor ───────────────────────────────────────
    try {
      const editorScenes: EditorScene[] = scenes.map((scene, i) => {
        const clipPaths = sceneVisualResults[i]?.clips ?? [];
        const editorClips: EditorClip[] = clipPaths.map(clipPath => {
          const source = inferClipSourceFromPath(clipPath);
          const isVideo = clipPath.endsWith(".mp4") || clipPath.endsWith(".webm");
          return { url: clipPath, type: isVideo ? "video" : "image", source };
        });
        return {
          sceneIndex: scene.index,
          title: scene.visualCue,
          narration: scene.text,
          durationMs: Math.round(scene.duration * 1000),
          clips: editorClips,
          chapterTitle: scene.chapterTitle,
        };
      });
      await updateVideoScenes(videoId, editorScenes);
      console.log(`[Pipeline] Scene manifest saved: ${editorScenes.length} scenes`);
    } catch (err) {
      console.warn(`[Pipeline] Failed to save scene manifest (non-fatal):`, (err as Error).message);
    }

    // ── Stage 4: Compose all scenes in parallel batches ───────────────────────
    onProgress?.({ stage: STAGE_LABELS.composing, percent: 47 });
    const t3 = Date.now();

    // Railway: one FFmpeg compose at a time (avoids "Resource temporarily unavailable" decoder errors)
    const composeLimit = pLimit(composeParallelism());
    let completedCompose = 0;
    const composedScenes = await withTimeout(
      Promise.all(
        scenes.map((scene, i) => composeLimit(async () => {
          const result = await composeSceneVideo(
            scene, sceneVisualResults[i]?.clips ?? [], audioPaths[i], scene.duration, workDir, scenes.length,
            enableSubtitles, visualDedup.lastMuskStockClip, sceneVisualResults[i]?.beatDurations
          );
          completedCompose++;
          onProgress?.({
            stage: `Composing scenes... (${completedCompose}/${scenes.length} done)`,
            percent: 47 + Math.round((completedCompose / scenes.length) * 28)
          });
          return result;
        }))
      ),
      2400_000, // 40 min hard limit for compositing
      "Scene composition stage"
    );
    console.log(`[Pipeline] Stage 4 (compose): ${scenes.length} scenes in ${((Date.now()-t3)/1000).toFixed(1)}s`);

    // Cleanup intermediates
    for (let i = 0; i < scenes.length; i++) {
      try { fs.unlinkSync(audioPaths[i]); } catch { /* ignore */ }
      for (const clip of sceneVisualResults[i]?.clips ?? []) {
        try { if (clip !== composedScenes[i]) fs.unlinkSync(clip); } catch { /* ignore */ }
      }
    }

        // ── Stage 4b: Vidrush chapter cards (yellow title cards between sections) ──
    const useChapterCards =
      process.env.ENABLE_CHAPTER_CARDS === "true" && videoLength !== "1" && videoLength !== "2";
    const orderedClips: string[] = [];
    let chapterCardCount = 0;
    for (let i = 0; i < composedScenes.length; i++) {
      const scene = scenes[i];
      const cardTitle = scene.chapterTitle || scene.sectionTitle;
      // Never open on a card — real footage first; skip script meta labels (HOOK, CTA)
      if (useChapterCards && i > 0 && isPublishableChapterTitle(cardTitle)) {
        try {
          const card = await renderChapterCard(cardTitle, i, workDir);
          if (fs.existsSync(card) && fs.statSync(card).size > 1000) {
            orderedClips.push(card);
            chapterCardCount++;
          }
        } catch (err) {
          console.warn(`[Pipeline] Chapter card ${i} failed (non-fatal):`, (err as Error).message);
        }
      }
      orderedClips.push(composedScenes[i]);
    }

    // ── Stage 5: Concatenate + intro/outro + music ────────────────────────
    onProgress?.({ stage: STAGE_LABELS.assembling, percent: 77 });
    const t4 = Date.now();
    const totalDuration =
      scenes.reduce((sum, s) => sum + s.duration, 0) + chapterCardCount * CHAPTER_CARD_DURATION;
    let finalVideoPath = await concatenateScenesWithMusic(orderedClips, workDir, videoId, totalDuration, videoTitle);
    if (videoLength === "1" || videoLength === "2") {
      const targetSec = videoLength === "1" ? 58 : 118;
      finalVideoPath = await ensureFinalVideoDuration(finalVideoPath, workDir, videoId, targetSec);
    }
    console.log(`[Pipeline] Stage 5 (assemble+music): ${((Date.now()-t4)/1000).toFixed(1)}s`);

    // ── Stage 6: Upload to S3 ─────────────────────────────────────────────────
    onProgress?.({ stage: STAGE_LABELS.uploading, percent: 93 });
    const t5 = Date.now();
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await withTimeout(
      storagePut(`videos/${videoId}/final.mp4`, videoBuffer, "video/mp4"),
      600_000, // 10 min upload timeout for large files
      "S3 upload"
    );
    console.log(`[Pipeline] Stage 6 (upload): ${((Date.now()-t5)/1000).toFixed(1)}s, size: ${(videoBuffer.length/1024/1024).toFixed(1)}MB`);

    // Persist URL immediately so a crash during finalization cannot lose the finished video
    const finalStatus = skipEffectsStage() ? "completed" as const : "generating_effects" as const;
    const finalStep = skipEffectsStage() ? "Video complete!" : STAGE_LABELS.complete;
    const finalPercent = skipEffectsStage() ? 100 : 95;
    await updateVideoStatus(videoId, finalStatus, {
      videoUrl: url,
      progressStep: finalStep,
      progressPercent: finalPercent,
    }).catch((err) => console.warn(`[Pipeline] Failed to persist videoUrl for ${videoId}:`, err));

    onProgress?.({ stage: STAGE_LABELS.complete, percent: 100 });
    const totalMs = Date.now() - t0;
    console.log(`[Pipeline] Video ${videoId} COMPLETE in ${(totalMs/60000).toFixed(1)} min: ${url}`);
    return url;
  } finally {
    try {
      const { exec: execCp } = await import("child_process");
      execCp(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}

// ─── Re-render from editor scene manifest ────────────────────────────────────
/**
 * Re-renders a video using the updated scene manifest from the editor.
 * Downloads clips from their stored URLs, regenerates voiceovers, composes
 * each scene, then assembles the final video and uploads to S3.
 */
export async function rerenderFromScenes(
  videoId: number,
  scenes: EditorScene[],
  onProgress?: (step: string, pct: number) => void
): Promise<string> {
  const workDir = path.join(TMP_DIR, `fastvid_rerender_${videoId}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    onProgress?.("Preparing re-render...", 5);

    // ── Step 1: Download all clips from their URLs ──────────────────────────
    onProgress?.("Downloading clips...", 10);
    const sceneClipPaths: string[][] = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const clipPaths: string[] = [];

      for (let j = 0; j < scene.clips.length; j++) {
        const clip = scene.clips[j];
        const ext = clip.type === "video" ? "mp4" : "jpg";
        const clipPath = path.join(workDir, `rerender_scene_${i}_clip_${j}.${ext}`);

        try {
          // If the URL is a local file path (from original pipeline), check if it exists
          if (!clip.url.startsWith("http") && fs.existsSync(clip.url)) {
            clipPaths.push(clip.url);
            continue;
          }

          // Download from URL with 15s timeout
          const resp = await fetchWithTimeout(clip.url, 15_000, `clip ${i}-${j}`);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(clipPath, buf);
            if (fs.statSync(clipPath).size > 100) {
              clipPaths.push(clipPath);
            }
          }
        } catch (err) {
          console.warn(`[Rerender] Scene ${i} clip ${j} download failed (skipping):`, (err as Error).message);
        }
      }

      sceneClipPaths.push(clipPaths);
      onProgress?.(`Downloading clips... (${i + 1}/${scenes.length})`, 10 + Math.round((i + 1) / scenes.length * 20));
    }

    // ── Step 2: Full-script voiceover (same as main pipeline) ───────────────
    onProgress?.("Generating voiceovers...", 30);
    const audioPaths: string[] = scenes.map((_, i) => path.join(workDir, `rerender_scene_${i}_audio.mp3`));
    const durations: number[] = [];
    const voScenes: Scene[] = scenes.map((edScene, i) => ({
      index: edScene.sceneIndex ?? i,
      text: edScene.narration,
      visualCue: edScene.title ?? "scene",
      pexelsQuery: edScene.title ?? "scene",
      aiImagePrompt: edScene.title ?? "scene",
      duration: Math.max(edScene.durationMs / 1000, 5),
    }));
    try {
      const bulkDurations = await withTimeout(
        generateBulkSceneVoiceovers(voScenes, audioPaths, workDir, undefined, (done, total) => {
          onProgress?.(
            done === 0 ? "Creating full voiceover (one take)..." : `Generating voiceovers... (${done}/${total})`,
            30 + Math.round((done / total) * 15)
          );
        }),
        bulkVoiceoverTimeoutMs(scenes.length),
        "Rerender bulk voiceover"
      );
      bulkDurations.forEach((d, i) => { durations[i] = d; });
    } catch (err) {
      console.warn(`[Rerender] Bulk voiceover failed:`, (err as Error).message);
      for (let i = 0; i < scenes.length; i++) {
        const silentDur = Math.round(scenes[i].durationMs / 1000) || 20;
        const audioPath = audioPaths[i];
        try {
          await exec(
            `${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${silentDur} -c:a libmp3lame -b:a 64k "${audioPath}"`
          );
          durations[i] = silentDur;
        } catch {
          durations[i] = silentDur;
        }
      }
    }

    // ── Step 3: Build Scene objects for composeSceneVideo ──────────────────
    const internalScenes: Scene[] = scenes.map((edScene, i) => ({
      index: edScene.sceneIndex,
      text: edScene.narration,
      visualCue: edScene.title ?? "scene",
      pexelsQuery: edScene.title ?? "scene",
      aiImagePrompt: edScene.title ?? "scene",
      duration: Math.max((durations[i] || 20) + 0.35, 5),
      chapterTitle: edScene.chapterTitle,
    }));

    // ── Step 4: Compose all scenes ──────────────────────────────────────────
    onProgress?.("Composing scenes...", 45);
    const composeLimit = pLimit(composeParallelism());
    let completedCompose = 0;

    const composedScenes = await Promise.all(
      internalScenes.map((scene, i) => composeLimit(async () => {
        const clips = sceneClipPaths[i].filter((c) => c && !isPipelineFallbackClip(c));
        if (clips.length === 0) {
          throw pipelineError(
            PIPELINE_ERROR.NO_SCENES,
            `Re-render scene ${i}: no downloaded clips (grey placeholders disabled)`
          );
        }

        const result = await composeSceneVideo(
          scene,
          clips,
          audioPaths[i],
          scene.duration,
          workDir,
          internalScenes.length,
          false
        );
        completedCompose++;
        onProgress?.(
          `Composing scenes... (${completedCompose}/${internalScenes.length})`,
          45 + Math.round((completedCompose / internalScenes.length) * 30)
        );
        return result;
      }))
    );

    // ── Step 5: Chapter cards DISABLED — user requested no on-screen text ───────────────────────────────────────────────────────────────────────────
    const orderedClips: string[] = [...composedScenes];

    // ── Step 6: Concatenate + music ───────────────────────────────────────────────────────────────────────────
    onProgress?.("Assembling final video...", 78);
    const videoTitle = (internalScenes[0] as any)?.title ?? `Video ${videoId}`;
    const totalDuration = internalScenes.reduce((sum, s) => sum + s.duration, 0); // No chapter cards
    const finalVideoPath = await concatenateScenesWithMusic(orderedClips, workDir, videoId, totalDuration, videoTitle);

    // ── Step 7: Upload to S3 ────────────────────────────────────────────────
    onProgress?.("Uploading re-rendered video...", 93);
    const videoBuffer = fs.readFileSync(finalVideoPath);
    const { url } = await withTimeout(
      storagePut(`videos/${videoId}/edited_final.mp4`, videoBuffer, "video/mp4"),
      600_000,
      "S3 upload (re-render)"
    );

    onProgress?.("Re-render complete!", 100);
    console.log(`[Rerender] Video ${videoId} re-render COMPLETE: ${url}`);
    return url;
  } finally {
    try {
      const { exec: execCp } = await import("child_process");
      execCp(`rm -rf "${workDir}"`);
    } catch { /* ignore */ }
  }
}
