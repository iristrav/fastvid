/**
 * RONDE 146 §5/§6/§7 — the narration survives the render.
 *
 * ── What was being thrown away ───────────────────────────────────────────────────────────────
 *
 * A render produces `full_voiceover.mp3` and `tts_word_alignment.json` in its work directory, uses
 * both, and then runs `fs.rmSync(workDir)` in its `finally`. The only thing that ever reached
 * permanent storage was `videos/<id>/final.mp4` — measured, by counting every `storagePut*` call
 * in the pipeline: there are two, and both write that same key.
 *
 * `videos.voiceoverUrl` has existed as a column the whole time and has never had a writer.
 *
 * ── Why this is the round's most important change ────────────────────────────────────────────
 *
 * Without the narration file, a re-render has two options and both are wrong. It can render the
 * new cut silently, which is not the user's video. Or it can call TTS again — which costs money,
 * and, far worse, produces DIFFERENT WORD TIMINGS. Every caption and every beat boundary in this
 * system is derived from those timings (`planBeatsFromTtsWords`), so regenerating the voice
 * silently re-cuts the whole video. An edit that moves one word must not move every shot.
 *
 * So both files are uploaded, and the timings are stored as data next to them.
 *
 * ── Failure is reported, never assumed away ──────────────────────────────────────────────────
 *
 * If the upload fails the render does NOT claim the voiceover is persistent. It logs
 * `VOICEOVER_PERSISTENCE_FAILED` with the reason and returns a result saying so. A render that
 * quietly recorded a URL it never wrote would be worse than one that never tried: the failure
 * would surface months later, as a re-render that cannot find its own audio.
 */
import * as fs from "fs";
import * as path from "path";
import type { TtsWordTiming } from "./voiceTtsAlignment";

/** The narration facts a future re-render needs. Stored in `videos.metadata.narration`. */
export type NarrationPersistence = {
  /** Permanent URL of the voiceover audio, or null when it could not be stored. */
  voiceoverUrl: string | null;
  /** Seconds. Measured from the file, not estimated from the script. */
  durationSec: number | null;
  /** Which TTS produced it, when the render knows. Never invented. */
  provider: string | null;
  /** The voice id the user chose, when there was one. */
  voiceId: string | null;
  /** Word-level timings exactly as the TTS supplied them. */
  words: TtsWordTiming[];
  /** How the words were obtained. `null` when no alignment was available at all. */
  timingSource: "tts_word_alignment" | null;
  storedAt: string;
};

export type VoiceoverPersistResult =
  | { ok: true; url: string; key: string; bytes: number; sourcePath: string }
  | { ok: false; reason: VoicePersistFailure; detail: string };

export type VoicePersistFailure =
  | "no_voiceover_file"
  | "empty_voiceover_file"
  | "upload_failed";

/**
 * The candidate narration files a render may have produced, in order of preference.
 *
 * `full_voiceover.mp3` is what `synthesizeFullNarrationMp3` writes for every generated narration.
 * `custom_voiceover.mp3` is a user upload, and is just as much this video's audio — a re-render
 * must reproduce the voice the video actually has, not the voice it would have had.
 */
export const VOICEOVER_CANDIDATE_FILES = ["full_voiceover.mp3", "custom_voiceover.mp3"] as const;

/** The narration file in a work directory, or null. */
export function findVoiceoverFile(workDir: string): string | null {
  for (const name of VOICEOVER_CANDIDATE_FILES) {
    const p = path.join(workDir, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    } catch {
      /* unreadable is the same as absent here */
    }
  }
  return null;
}

/**
 * The storage key for a video's narration.
 *
 * Stable and derived from the video id alone, so re-running a render overwrites its own audio
 * rather than accumulating a copy per attempt — §5's "niet per render onnodig tientallen kopieen".
 * (The S3 backend appends a content hash of its own for cache-busting; that is its business and
 * does not make the key unstable from this side.)
 */
export function voiceoverStorageKey(videoId: number): string {
  return `videos/${videoId}/voiceover.mp3`;
}

/**
 * Upload the narration, or say why not.
 *
 * `upload` is injected rather than imported so this can be tested against a real temporary
 * directory without a storage backend, and so the module has no opinion about S3 versus local —
 * `storagePutFromFile` already decides that.
 */
export async function persistVoiceover(params: {
  videoId: number;
  workDir: string;
  upload: (key: string, filePath: string, contentType: string) => Promise<{ key: string; url: string }>;
}): Promise<VoiceoverPersistResult> {
  const file = findVoiceoverFile(params.workDir);
  if (!file) {
    return {
      ok: false,
      reason: "no_voiceover_file",
      detail: `no ${VOICEOVER_CANDIDATE_FILES.join(" or ")} in ${params.workDir}`,
    };
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    bytes = 0;
  }
  if (bytes <= 0) {
    return { ok: false, reason: "empty_voiceover_file", detail: `${path.basename(file)} is empty` };
  }
  try {
    const result = await params.upload(voiceoverStorageKey(params.videoId), file, "audio/mpeg");
    return { ok: true, url: result.url, key: result.key, bytes, sourcePath: file };
  } catch (err) {
    return {
      ok: false,
      reason: "upload_failed",
      detail: (err as Error)?.message?.slice(0, 300) ?? "unknown upload error",
    };
  }
}

/** The line a failed persistence writes. Named so it can be grepped in a production log. */
export function formatVoicePersistFailure(
  videoId: number,
  result: Extract<VoiceoverPersistResult, { ok: false }>
): string {
  return (
    `VOICEOVER_PERSISTENCE_FAILED video=${videoId} reason=${result.reason} ` +
    `detail="${result.detail}" — this video's narration will NOT be recoverable after cleanup, ` +
    "so a later re-render cannot reproduce its audio"
  );
}

export function formatVoicePersistSuccess(
  videoId: number,
  result: Extract<VoiceoverPersistResult, { ok: true }>,
  words: number
): string {
  return (
    `[RenderPersistence] video=${videoId} voiceover stored key=${result.key} ` +
    `bytes=${result.bytes} words=${words}`
  );
}

/**
 * Assemble the narration record.
 *
 * Nothing here is computed or estimated. `words` are exactly what the TTS returned (RONDE 146 §6:
 * "Niet opnieuw alignment berekenen"), and every field the render does not know is `null` rather
 * than filled with a plausible value.
 */
export function buildNarrationPersistence(params: {
  voiceoverUrl: string | null;
  durationSec: number | null;
  provider: string | null;
  voiceId: string | null;
  words: TtsWordTiming[] | null | undefined;
}): NarrationPersistence {
  const words = params.words ?? [];
  return {
    voiceoverUrl: params.voiceoverUrl,
    durationSec:
      params.durationSec != null && Number.isFinite(params.durationSec) && params.durationSec > 0
        ? Number(params.durationSec.toFixed(3))
        : null,
    provider: params.provider?.trim() || null,
    voiceId: params.voiceId?.trim() || null,
    words,
    timingSource: words.length > 0 ? "tts_word_alignment" : null,
    storedAt: new Date().toISOString(),
  };
}

/**
 * Read a narration record back, tolerating everything an older row can be.
 *
 * §15: a video rendered before this round has no `narration` key at all, and one rendered during
 * a partial failure may have a record with a null URL. Both must load. `null` means "this video
 * has no stored narration", which is a fact the caller can act on — it is not an error.
 */
export function readNarrationPersistence(
  metadata: unknown
): NarrationPersistence | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as { narration?: unknown }).narration;
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Partial<NarrationPersistence>;
  const words = Array.isArray(n.words)
    ? n.words.filter(
        (w): w is TtsWordTiming =>
          Boolean(w) &&
          typeof (w as TtsWordTiming).word === "string" &&
          typeof (w as TtsWordTiming).startSec === "number" &&
          typeof (w as TtsWordTiming).endSec === "number"
      )
    : [];
  return {
    voiceoverUrl: typeof n.voiceoverUrl === "string" ? n.voiceoverUrl : null,
    durationSec: typeof n.durationSec === "number" ? n.durationSec : null,
    provider: typeof n.provider === "string" ? n.provider : null,
    voiceId: typeof n.voiceId === "string" ? n.voiceId : null,
    words,
    timingSource: words.length > 0 ? "tts_word_alignment" : null,
    storedAt: typeof n.storedAt === "string" ? n.storedAt : "",
  };
}

/** Can this video's audio be reproduced without calling TTS again? */
export function narrationIsRecoverable(n: NarrationPersistence | null): boolean {
  return Boolean(n?.voiceoverUrl);
}
