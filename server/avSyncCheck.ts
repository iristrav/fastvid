/**
 * DOES THE PICTURE AND THE SOUND START AND STOP TOGETHER?
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * FastVid checked resolution, frame rate, stream presence, black frames, freezes and silence, and
 * never once checked that the two streams line up. A film whose audio runs four seconds past its
 * picture, or opens on two seconds of silence, or ends with the narrator cut mid-word, passed every
 * gate — because each gate asked about one stream on its own.
 *
 * That is the failure mode a viewer notices first and a checklist notices last.
 *
 * ── What is measured, and what deliberately is not ──────────────────────────────────────────
 *
 * Four things, all of them structural and all of them measurable from the container:
 *
 *   1. STREAM LENGTH DISAGREEMENT   the two streams claim different durations
 *   2. LEADING SILENCE              the film opens on picture with nothing under it
 *   3. TRAILING SILENCE             the film ends on picture after the sound has stopped
 *   4. AUDIO PAST PICTURE           there is sound the viewer will never see anything under
 *
 * NOT measured: true lip-sync offset. Detecting that means correlating a speaker's mouth against a
 * waveform, which needs a face track and a model, and a documentary of archive footage over
 * voice-over has no lip-sync to be out of. Claiming to check it would be the fabricated metric this
 * codebase keeps removing. What IS checkable is the envelope, and the envelope is where FastVid's
 * real failures have lived: a picture track shortened by a dropped beat, a mux bounded by the wrong
 * stream, a voice-over that outlasts the montage.
 *
 * ── Reported, not blocking ──────────────────────────────────────────────────────────────────
 *
 * A documentary that opens on a second of atmosphere before the narrator begins is a choice, not a
 * defect, and this cannot tell the two apart. The thresholds below are set where a human would
 * start to call it wrong rather than where a measurement first differs from zero.
 */

/** Measured facts about the two streams. All seconds. */
export type StreamEnvelope = {
  /** Container duration of the video stream, or null when it could not be read. */
  videoSec: number | null;
  /** Container duration of the audio stream, or null. */
  audioSec: number | null;
  /** Where audio first rises above the silence floor, or null when it never does. */
  firstSoundSec: number | null;
  /** Where audio last drops below it, or null. */
  lastSoundSec: number | null;
};

export type AvSyncFinding = {
  code:
    | "stream_length_mismatch"
    | "leading_silence"
    | "trailing_silence"
    | "audio_past_picture"
    | "no_audio"
    | "no_video";
  /** How far out, in seconds. Zero for the presence findings. */
  deltaSec: number;
  reason: string;
};

export type AvSyncResult = {
  ok: boolean;
  envelope: StreamEnvelope;
  findings: AvSyncFinding[];
};

/**
 * How far the two stream lengths may differ before it is worth saying.
 *
 * A quarter of a second is roughly a frame at 4fps and six frames at 25 — below it, the difference
 * is container rounding and the way an AAC frame does not divide evenly into a video frame. Above
 * it, something in the mux decided one stream's length without consulting the other.
 */
export const LENGTH_TOLERANCE_SEC = 0.25;

/**
 * How much silence at either end reads as a mistake rather than as air.
 *
 * A documentary routinely opens on a beat of atmosphere and closes on one. Two seconds is where a
 * viewer stops hearing a pause and starts wondering whether the file is broken.
 */
export const EDGE_SILENCE_SEC = 2.0;

/**
 * Judge one rendered file's envelope.
 *
 * Pure: it takes the measurements and returns the findings. The ffprobe/ffmpeg calls that produce a
 * `StreamEnvelope` live with the other probes, so this can be tested against every shape of broken
 * file without rendering one.
 */
export function checkAvSync(envelope: StreamEnvelope): AvSyncResult {
  const findings: AvSyncFinding[] = [];
  const { videoSec, audioSec, firstSoundSec, lastSoundSec } = envelope;

  if (videoSec == null || videoSec <= 0) {
    findings.push({
      code: "no_video",
      deltaSec: 0,
      reason: "the file has no readable video stream",
    });
  }
  if (audioSec == null || audioSec <= 0) {
    findings.push({
      code: "no_audio",
      deltaSec: 0,
      reason: "the file has no readable audio stream — a documentary with no narration",
    });
  }

  if (videoSec != null && audioSec != null && videoSec > 0 && audioSec > 0) {
    const delta = audioSec - videoSec;
    if (Math.abs(delta) > LENGTH_TOLERANCE_SEC) {
      findings.push({
        code: "stream_length_mismatch",
        deltaSec: Number(delta.toFixed(3)),
        reason:
          `the audio stream is ${Math.abs(delta).toFixed(2)}s ` +
          `${delta > 0 ? "longer" : "shorter"} than the video stream ` +
          `(video ${videoSec.toFixed(2)}s, audio ${audioSec.toFixed(2)}s) — ` +
          "the mux bounded one without consulting the other",
      });
    }

    /**
     * Sound the viewer will never see anything under.
     *
     * Distinct from a length mismatch: the streams can be the same length in the container and the
     * last of the audio still fall past where the picture stops being anything. This catches the
     * case a mux "fixed" by padding the video with a held frame.
     */
    if (lastSoundSec != null && lastSoundSec - videoSec > LENGTH_TOLERANCE_SEC) {
      findings.push({
        code: "audio_past_picture",
        deltaSec: Number((lastSoundSec - videoSec).toFixed(3)),
        reason:
          `sound continues to ${lastSoundSec.toFixed(2)}s but the picture ends at ` +
          `${videoSec.toFixed(2)}s`,
      });
    }
  }

  if (firstSoundSec != null && firstSoundSec > EDGE_SILENCE_SEC) {
    findings.push({
      code: "leading_silence",
      deltaSec: Number(firstSoundSec.toFixed(3)),
      reason:
        `the film opens on ${firstSoundSec.toFixed(2)}s of picture with nothing under it — ` +
        "a beat of air is a choice, this is long enough to read as a fault",
    });
  }

  if (videoSec != null && lastSoundSec != null) {
    const trailing = videoSec - lastSoundSec;
    if (trailing > EDGE_SILENCE_SEC) {
      findings.push({
        code: "trailing_silence",
        deltaSec: Number(trailing.toFixed(3)),
        reason:
          `the last ${trailing.toFixed(2)}s of the film are silent picture — ` +
          "the sound stopped before the video did",
      });
    }
  }

  return { ok: findings.length === 0, envelope, findings };
}

/** One line per finding, plus a verdict. For the render log. */
export function formatAvSync(result: AvSyncResult): string[] {
  const e = result.envelope;
  const head =
    `[AVSync] video=${e.videoSec?.toFixed(2) ?? "?"}s audio=${e.audioSec?.toFixed(2) ?? "?"}s ` +
    `firstSound=${e.firstSoundSec?.toFixed(2) ?? "?"}s lastSound=${e.lastSoundSec?.toFixed(2) ?? "?"}s ` +
    `${result.ok ? "OK" : `findings=${result.findings.length}`}`;
  return [head, ...result.findings.map((f) => `[AVSync] ${f.code} ${f.deltaSec}s — ${f.reason}`)];
}

/* ═══════════════════════ measuring a real file ═══════════════════════ */

import { promisify } from "util";
import { exec as execCb } from "child_process";

const exec = promisify(execCb);

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN?.trim() || process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/** One stream's container duration, or null when the stream is absent or unreadable. */
async function streamDuration(filePath: string, kind: "v" | "a"): Promise<number | null> {
  try {
    const { stdout } = await exec(
      `"${ffprobeBin()}" -v error -select_streams ${kind}:0 ` +
        `-show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 20_000 }
    );
    const n = parseFloat(String(stdout).trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* falls through to the format-level read below */
  }
  /**
   * Some muxers write no per-stream duration. The container's own is then the best available
   * answer for that stream, and it is better than reporting the stream as missing — which would
   * turn a metadata quirk into a `no_audio` finding.
   */
  try {
    const { stdout } = await exec(
      `"${ffprobeBin()}" -v error -select_streams ${kind}:0 -show_entries format=duration ` +
        `-of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 20_000 }
    );
    const n = parseFloat(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Where sound actually starts and stops, from `silencedetect`.
 *
 * ── Why not simply trust the audio stream's duration ────────────────────────────────────────
 *
 * A stream that is thirty seconds long and silent for the first four is thirty seconds long. The
 * container cannot tell you the film opens on nothing; only the waveform can. This is also how a
 * trailing gap is found — the mux pads audio to the video's length routinely, so the stream ends
 * exactly on time while the narrator stopped ten seconds earlier.
 *
 * The threshold matches the one `postRenderSpotCheck` already uses (-50dB), so the two agree about
 * what counts as silence rather than each having an opinion.
 */
async function soundWindow(
  filePath: string,
  durationSec: number | null
): Promise<{ firstSoundSec: number | null; lastSoundSec: number | null }> {
  const timeoutMs = durationSec != null
    ? Math.min(600_000, Math.max(60_000, Math.ceil(durationSec * 1000 * 2)))
    : 120_000;
  let stderr = "";
  try {
    const r = await exec(
      `"${ffmpegBin()}" -hide_banner -nostats -i "${filePath}" ` +
        `-af silencedetect=n=-50dB:d=0.5 -f null - 2>&1`,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }
    );
    stderr = String(r.stdout) + String(r.stderr);
  } catch (err) {
    stderr = String((err as { stdout?: string; stderr?: string }).stdout ?? "") +
      String((err as { stdout?: string; stderr?: string }).stderr ?? "");
  }
  if (!stderr) return { firstSoundSec: null, lastSoundSec: null };

  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/gi)].map((m) => parseFloat(m[1]!));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/gi)].map((m) => parseFloat(m[1]!));

  /**
   * A silence beginning at (or before) zero means the file opens silent; sound starts where that
   * silence ends. No leading silence at all means sound starts at zero.
   */
  const opensSilent = starts.length > 0 && starts[0]! <= 0.05;
  const firstSoundSec = opensSilent ? (ends[0] ?? null) : 0;

  /**
   * A silence that begins and never ends runs to the end of the file, so sound last occurred where
   * it began. A file whose silences all close has sound up to its duration.
   */
  const endsSilent = starts.length > ends.length;
  const lastSoundSec = endsSilent ? (starts[starts.length - 1] ?? null) : durationSec;

  return {
    firstSoundSec: Number.isFinite(firstSoundSec as number) ? firstSoundSec : null,
    lastSoundSec: Number.isFinite(lastSoundSec as number) ? lastSoundSec : null,
  };
}

/** Measure one rendered file and judge its envelope. Never throws. */
export async function checkFileAvSync(filePath: string): Promise<AvSyncResult> {
  const [videoSec, audioSec] = await Promise.all([
    streamDuration(filePath, "v"),
    streamDuration(filePath, "a"),
  ]);
  const { firstSoundSec, lastSoundSec } = audioSec
    ? await soundWindow(filePath, audioSec)
    : { firstSoundSec: null, lastSoundSec: null };
  return checkAvSync({ videoSec, audioSec, firstSoundSec, lastSoundSec });
}
