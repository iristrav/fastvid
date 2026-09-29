/**
 * FASTVID — voice preview playback (RONDE 147)
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * Both preview buttons — the admin Voice Library and the dashboard voice picker — built an
 * `Audio` element and called `.play()` without awaiting it. `play()` returns a Promise, and it
 * REJECTS for the two things that actually go wrong in production: the browser's autoplay policy
 * refusing a sound the user did not obviously ask for, and a source that 404s (an expired preview
 * URL in object storage). Nothing was attached to catch either, so the rejection was swallowed and
 * the UI flipped to "Stop" over silence. That is the reported symptom: a button, and no audio.
 *
 * Three smaller faults sat alongside it:
 *
 *  · no `onerror` handler, so a source that failed to load left the button stuck on "Stop" with
 *    nothing to stop and no way back except a reload;
 *  · nothing cancelled a preview that was still in flight, so clicking voice A then voice B could
 *    play A over B when A's response arrived second — the UI naming one voice while another spoke;
 *  · the admin panel ignored `exampleAudioUrl` entirely and spent an ElevenLabs generation on every
 *    single click, including for voices that already had a stored sample.
 *
 * ── What this hook is ────────────────────────────────────────────────────────────────────────
 *
 * One implementation of "play a preview for this voice", used by both surfaces so they cannot
 * drift apart again. It is playback wiring only: no TTS provider, no voice engine, no second
 * preview route. Generating a preview is still `trpc.voice.preview`, and it is still only reached
 * when a voice has no stored sample — passed in by the caller rather than imported, so this file
 * stays free of tRPC and can be reasoned about (and tested) on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type VoicePreviewTarget = {
  id: number;
  /** The stored sample, when the voice has one. Preferred over generating a new one. */
  exampleAudioUrl?: string | null;
};

export type VoicePreviewState = {
  /** The voice currently making sound, or null. */
  playingId: number | null;
  /** The voice whose preview is being fetched, or null. */
  loadingId: number | null;
  /** Toggle: plays the voice, or stops it if it is the one already playing. */
  toggle: (voice: VoicePreviewTarget) => void;
  /** Stop whatever is playing. Safe to call when nothing is. */
  stop: () => void;
};

export type UseVoicePreviewOptions = {
  /**
   * Fetches a freshly generated preview URL for a voice with no stored sample. Rejections are
   * reported through `onError` — the caller does not need its own try/catch.
   */
  generate: (voice: VoicePreviewTarget) => Promise<string>;
  onError?: (message: string, voice: VoicePreviewTarget) => void;
};

export function useVoicePreview({ generate, onError }: UseVoicePreviewOptions): VoicePreviewState {
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /**
   * Which request the user is actually waiting for. Incremented on every toggle, so a response
   * that arrives after the user has moved on can see that it is stale and drop itself instead of
   * playing over whatever replaced it.
   */
  const requestRef = useRef(0);

  const stop = useCallback(() => {
    requestRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      // Detach before clearing the source: an empty src on some browsers fires `error`, which
      // would otherwise re-enter the error path for a preview the user deliberately stopped.
      audio.onended = null;
      audio.onerror = null;
      audio.src = "";
    }
    audioRef.current = null;
    setPlayingId(null);
    setLoadingId(null);
  }, []);

  // Leaving the page must not leave a voice talking.
  useEffect(() => stop, [stop]);

  const play = useCallback(
    /**
     * VIDEO 619 — `onLoadFailed`: a stored sample that does not load (a file the storage no longer
     * holds) is not the end of the preview. The caller passes a way to make a fresh one, and the
     * server writes that one back to the voice, so the next click plays at once.
     */
    async (url: string, voice: VoicePreviewTarget, requestId: number, onLoadFailed?: () => void) => {
      if (requestRef.current !== requestId) return;
      /** `onerror` and a rejected `play()` can both report the same failed load — fall back once. */
      let fellBack = false;
      const fallBack = () => {
        if (fellBack) return;
        fellBack = true;
        onLoadFailed?.();
      };
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        if (requestRef.current !== requestId) return;
        audioRef.current = null;
        setPlayingId(null);
      };
      audio.onerror = () => {
        if (requestRef.current !== requestId) return;
        audioRef.current = null;
        setPlayingId(null);
        if (onLoadFailed) {
          fallBack();
          return;
        }
        setLoadingId(null);
        onError?.("This preview could not be loaded", voice);
      };
      try {
        // The await is the whole point: an autoplay refusal or an unreachable source lands here
        // instead of vanishing into an unhandled rejection.
        await audio.play();
        if (requestRef.current !== requestId) {
          audio.pause();
          return;
        }
        setPlayingId(voice.id);
        setLoadingId(null);
      } catch (err) {
        if (requestRef.current !== requestId) return;
        /** A source that cannot be decoded rejects here too; that is a load failure, not autoplay. */
        if (onLoadFailed && (err as DOMException)?.name === "NotSupportedError") {
          audioRef.current = null;
          fallBack();
          return;
        }
        audioRef.current = null;
        setPlayingId(null);
        setLoadingId(null);
        onError?.("Your browser blocked playback — click the preview again", voice);
      }
    },
    [onError]
  );

  const toggle = useCallback(
    (voice: VoicePreviewTarget) => {
      if (playingId === voice.id) {
        stop();
        return;
      }
      stop();
      const requestId = requestRef.current;

      const generateAndPlay = () => {
        setLoadingId(voice.id);
        void (async () => {
          try {
            const url = await generate(voice);
            if (requestRef.current !== requestId) return;
            await play(url, voice, requestId);
          } catch (err) {
            if (requestRef.current !== requestId) return;
            setLoadingId(null);
            setPlayingId(null);
            onError?.((err as Error)?.message || "Could not generate this preview", voice);
          }
        })();
      };

      if (voice.exampleAudioUrl) {
        // A stored sample plays straight away — no generation, no spend, no wait. If it does not
        // load, a fresh one is made instead of leaving the button silent.
        void play(voice.exampleAudioUrl, voice, requestId, generateAndPlay);
        return;
      }
      generateAndPlay();
    },
    [generate, onError, play, playingId, stop]
  );

  return { playingId, loadingId, toggle, stop };
}
