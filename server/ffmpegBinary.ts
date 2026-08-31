/**
 * RONDE 146 §1 — ONE FFmpeg resolution, and a fallback that can tell two failures apart.
 *
 * ── Why this moved out of videoPipeline ──────────────────────────────────────────────────────
 *
 * `resolveFFmpegBin` has lived inside videoPipeline.ts since the beginning, and it encodes a real
 * decision the whole application depends on: prefer a SYSTEM ffmpeg, because ffmpeg-static is
 * built without libfreetype and therefore has no `drawtext` filter. Its own comments say so.
 *
 * RONDE 144's timeline renderer did not know that. It took `ffmpeg-static` straight from the
 * package and used it unconditionally, so the newest renderer was the one guaranteed to run on the
 * weakest binary — even on a machine where a better one was sitting at /usr/bin/ffmpeg. The audit
 * recorded that as BUG B2.
 *
 * The fix is not to copy the resolver into the renderer. It is to have one, here, that every
 * renderer asks. Copying it would have made a third answer to a question that must have one.
 *
 * ── The second half: capability failure is not executable failure ────────────────────────────
 *
 * The existing retry in videoPipeline switches binaries when a command fails with "not found" or
 * "Permission denied" — an EXECUTABLE failure. It has never switched on:
 *
 *     No such filter: 'drawtext'
 *
 * which is a CAPABILITY failure: the binary ran perfectly and cannot do the thing asked of it.
 * That was BUG B1, and it is why a text render on a container without a system ffmpeg fails
 * silently, per command, forever.
 *
 * The distinction matters in both directions, and the second direction is the dangerous one. A
 * fallback that fired on any ffmpeg error would retry genuine problems — a corrupt input, a bad
 * filter argument, a full disk — against a second binary, get the same failure, and bury the real
 * cause under a switch that was never going to help. So `isCapabilityFailure` matches a short,
 * explicit list of messages that mean "this build lacks a component", and nothing else.
 */
import * as fs from "fs";
import { execSync } from "child_process";
import ffmpegStatic from "ffmpeg-static";

/** Does this path run at all? Existing on disk is not the same as being executable here. */
export function testBinary(binPath: string): boolean {
  try {
    execSync(`"${binPath}" -version`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * System paths tried before ffmpeg-static, in order.
 *
 * Exported so the fallback list and the resolver cannot drift apart: a binary worth resolving to
 * is a binary worth failing over to.
 */
export const SYSTEM_FFMPEG_PATHS: readonly string[] = [
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/nix/var/nix/profiles/default/bin/ffmpeg",
];

/** The bundled binary's path, or "ffmpeg" when the package resolves to nothing. */
export function staticFFmpegPath(): string {
  return (ffmpegStatic as unknown as string) || "ffmpeg";
}

/**
 * The binary this process should use.
 *
 * Order, and the reason for it, unchanged from the original in videoPipeline:
 *
 *   FFMPEG_BIN env  — an operator naming one explicitly always wins
 *   system paths    — these have libfreetype, so `drawtext` exists
 *   ffmpeg-static   — always present, no drawtext; the safe floor
 *   which / nix / find — last resorts on hosts that put it somewhere else
 *
 * Memoised: `testBinary` spawns a process per candidate, and this is asked on every render.
 */
let cachedBin: string | null = null;

export function resolveFFmpegBin(): string {
  if (cachedBin) return cachedBin;
  cachedBin = resolveFFmpegBinUncached();
  return cachedBin;
}

/** Testing seam: forget the memoised answer. */
export function _resetFFmpegBinCache(): void {
  cachedBin = null;
}

function resolveFFmpegBinUncached(): string {
  const envPath = process.env.FFMPEG_BIN || "";
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[Fastvid] Using FFMPEG_BIN env: ${envPath}`);
    return envPath;
  }
  for (const p of SYSTEM_FFMPEG_PATHS) {
    if (fs.existsSync(p) && testBinary(p)) {
      console.log(`[Fastvid] Using system FFmpeg (drawtext-capable): ${p}`);
      return p;
    }
  }
  const staticPath = staticFFmpegPath();
  if (staticPath && fs.existsSync(staticPath)) {
    try {
      execSync(`chmod +x "${staticPath}"`, { shell: "/bin/sh" });
    } catch {
      /* already executable, or not ours to chmod */
    }
    if (testBinary(staticPath)) {
      console.warn(`[Fastvid] Using ffmpeg-static (NO drawtext support): ${staticPath}`);
      return staticPath;
    }
    console.warn(`[Fastvid] ffmpeg-static exists but CANNOT RUN (missing glibc?): ${staticPath}`);
  }
  try {
    const systemPath = execSync("which ffmpeg", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (systemPath && testBinary(systemPath)) {
      console.log(`[Fastvid] Using system FFmpeg (which): ${systemPath}`);
      return systemPath;
    }
  } catch {
    /* not on PATH */
  }
  try {
    const nixPath = execSync("ls /nix/store/*/bin/ffmpeg 2>/dev/null | head -1", {
      encoding: "utf8",
      shell: "/bin/sh",
    }).trim();
    if (nixPath && fs.existsSync(nixPath) && testBinary(nixPath)) {
      console.log(`[Fastvid] Using nix store FFmpeg: ${nixPath}`);
      return nixPath;
    }
  } catch {
    /* no nix store */
  }
  try {
    const found = execSync("find /nix /usr /opt -name ffmpeg -type f 2>/dev/null | head -1", {
      encoding: "utf8",
      shell: "/bin/sh",
    }).trim();
    if (found && fs.existsSync(found) && testBinary(found)) {
      console.log(`[Fastvid] Using found FFmpeg: ${found}`);
      return found;
    }
  } catch {
    /* find unavailable */
  }
  if (testBinary("ffmpeg")) {
    console.log(`[Fastvid] Using 'ffmpeg' from PATH`);
    return "ffmpeg";
  }
  const fallback = staticFFmpegPath();
  console.error(`[Fastvid] CRITICAL: No working FFmpeg binary found! staticPath=${fallback}`);
  return fallback;
}

/**
 * Alternatives to try after `current` failed, in order of preference.
 *
 * System builds first and `ffmpeg` from PATH before ffmpeg-static, because a capability retry is
 * looking for a MORE capable binary — and the bundled one is the least capable by construction
 * (no libfreetype, hence no drawtext). ffmpeg-static stays on the list so a host without any
 * system binary still has somewhere to fall back to; it is simply last.
 *
 * `current` is excluded, because retrying the binary that just failed is not a fallback.
 */
export function ffmpegFallbackCandidates(current: string): string[] {
  return [...SYSTEM_FFMPEG_PATHS, "ffmpeg", staticFFmpegPath()].filter((p) => p && p !== current);
}

/**
 * May a retry on another binary REPLACE the process-wide choice?
 *
 * ── The bug this answers, found by RONDE 158's own test ──────────────────────────────────────
 *
 * The pre-existing fallback switched `FFMPEG_BIN` permanently, which is right for the failure it
 * was written for: a missing executable is missing for every command that follows.
 *
 * A capability gap is not like that. It is a property of ONE COMMAND — this filter, this encoder —
 * and the binary is otherwise fine. Making it permanent was measurably wrong: with the widened
 * detection in place, one command that failed on an unsupported encoder downgraded the whole
 * worker to ffmpeg-static, and a later scene repair then produced a 17.04s clip where the system
 * binary produces 21.20s. Same command, same inputs, different build — a silently different video.
 *
 * So: a missing binary switches for good; a missing capability is borrowed for one command.
 */
export function retryReasonIsPermanent(
  reason: "binary_not_found" | "capability_missing"
): boolean {
  return reason === "binary_not_found";
}

/* ═══════════════════════ telling the two failures apart ═══════════════════════ */

/**
 * Messages that mean THIS BUILD lacks a component. Deliberately short and literal.
 *
 * Every entry is a message ffmpeg emits when a named piece is absent from the build — not when an
 * argument is wrong, an input is broken, or the disk is full. Widening this list is how a
 * capability fallback turns into an error-swallowing retry loop, so an addition needs the same
 * justification each of these has: the binary ran, and cannot do the thing.
 */
const CAPABILITY_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /No such filter/i,
  /Unknown filter/i,
  /Filter .* not found/i,
  /Unknown encoder/i,
  /Unknown decoder/i,
  /Encoder .* not found/i,
  /Decoder .* not found/i,
  /Unknown bitstream filter/i,
  /Cannot load .*libfreetype/i,
];

/**
 * Did the command fail because this BUILD cannot do it?
 *
 * True means "a different binary might succeed". False means "a different binary will fail the
 * same way", which is the answer for the overwhelming majority of ffmpeg errors — and returning
 * false for those is the entire point. See the module note.
 */
export function isCapabilityFailure(message: string | undefined | null): boolean {
  const text = (message ?? "").toString();
  if (!text) return false;
  return CAPABILITY_FAILURE_PATTERNS.some((re) => re.test(text));
}

/**
 * Did the command fail because the BINARY is not there?
 *
 * The pre-existing rule, unchanged and now in one place: an input file's ENOENT must never be read
 * as a missing executable, because switching binaries would then hide a missing input behind a
 * confusing message about ffmpeg.
 */
export function isBinaryNotFoundFailure(message: string | undefined | null): boolean {
  const text = (message ?? "").toString();
  if (!text) return false;
  /**
   * `text.includes("not found")` was the original test, and it is too loose.
   *
   * ffmpeg says "moov atom not found" for a truncated MP4 — a perfectly ordinary broken-input
   * error that has nothing to do with the binary. Under the old rule that switched binaries, got
   * the identical failure from the second one, and buried the real cause. Found by this round's
   * TEST 9; it predates this round.
   *
   * A shell reporting a missing executable has a distinctive shape: `sh: 1: ffmpeg: not found`,
   * `ffmpeg: command not found`. The colon before "not found" is what separates it from a
   * sentence that merely contains the words.
   */
  const shellNotFound = /:\s*(command\s+)?not found/i.test(text);
  const permissionDenied = text.includes("Permission denied");
  if (!shellNotFound && !permissionDenied) return false;
  return !text.includes("ENOENT") && !text.includes("No such file or directory");
}

/** Why a retry on another binary is worth attempting, or null when it is not. */
export function ffmpegRetryReason(
  message: string | undefined | null
): "binary_not_found" | "capability_missing" | null {
  if (isBinaryNotFoundFailure(message)) return "binary_not_found";
  if (isCapabilityFailure(message)) return "capability_missing";
  return null;
}

/**
 * Which filters a binary actually has.
 *
 * Used to say out loud, once at startup, whether the chosen binary can draw text — the fact that
 * silently decided whether ten text engines worked, and that nothing ever reported.
 */
export function ffmpegHasFilter(bin: string, filter: string): boolean {
  try {
    const out = execSync(`"${bin}" -hide_banner -filters`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000,
    });
    return new RegExp(`\\b${filter}\\b`).test(out);
  } catch {
    return false;
  }
}

/** One startup line naming the binary and what it can do. */
export function describeFFmpegCapabilities(bin = resolveFFmpegBin()): string {
  const drawtext = ffmpegHasFilter(bin, "drawtext");
  const subtitles = ffmpegHasFilter(bin, "subtitles");
  return (
    `[FFmpegBinary] bin=${bin} drawtext=${drawtext} subtitles=${subtitles}` +
    (!drawtext && subtitles
      ? " — no drawtext in this build; text must be rendered through libass (subtitles)"
      : "") +
    (!drawtext && !subtitles ? " — THIS BUILD CANNOT RENDER TEXT AT ALL" : "")
  );
}
