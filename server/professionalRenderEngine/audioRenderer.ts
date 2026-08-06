/** Professional Render Engine — Audio Renderer (Phase 7).
 *
 *  Turns a SoundInstruction (already decided by Phase 4's SoundPlanner — this file makes no
 *  audio-choice decisions of its own) plus the EDL's global fade/ducking parameters into real
 *  FFmpeg audio filter strings.
 *
 *  Every template here is reused verbatim from live production (all confirmed by this phase's
 *  research):
 *    - `adelay=MS|MS,volume=V,atrim=0:0.35,asetpts=PTS-STARTPTS` — cinematicEffectsEngine.ts's
 *      `buildCinematicSfxAudioFilter`. The 0.35s trim is that function's own assumption that
 *      SFX source clips are short stingers; kept as-is rather than silently changed, and
 *      layered with a real `afade` when the instruction actually specifies fade durations.
 *    - `afade=t=in:st=0:d=X,afade=t=out:st=Y:d=Z` — the voice fade template used at every
 *      voice-track mix site across videoPipeline.ts (originally fixed at 0.06s/0.12s; here
 *      generalized to whatever fade durations the EDL specifies).
 *    - The full sidechain-ducking mini-graph — `asplit`, `aloop`, `sidechaincompress`,
 *      `amix` — reused from videoPipeline.ts's music-under-voice mix, unchanged parameters
 *      (`threshold=0.02:ratio=8:attack=5:release=200:makeup=1`).
 *  `acrossfade` (crossfades) is FFmpeg's own native audio-crossfade filter — real, just not
 *  used anywhere in this codebase yet (same "native primitive this repo hadn't reached for"
 *  situation as transitionRenderer.ts's slideleft/coverleft). Volume automation is genuinely
 *  new: a piecewise-linear `volume='...'` expression interpolating between keyframes, evaluated
 *  per-frame — a real, standard FFmpeg technique (`volume` accepts a time expression), not
 *  fabricated syntax.
 *
 *  Ducking's mini-graph has its own internal fork (`asplit`) and merge (`amix`) with several
 *  intermediate labels — it doesn't fit this directory's `FilterGraphNode` shape (one filter,
 *  one input set, one output). `buildDuckingFilterComplex()` therefore returns the raw,
 *  already-`;`-joined filter_complex snippet directly, the same way filterGraphBuilder.ts's
 *  `buildFilterComplex()` joins independently-built graph pieces with `;`.
 */
import type { FilterFragment, FilterGraphNode, SoundInstruction } from "./types";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** cinematicEffectsEngine.ts's own assumption for SFX stinger length — kept verbatim. */
const DEFAULT_SFX_TRIM_SEC = 0.35;

/** Builds one sound effect's adelay/volume/(optional fade)/trim chain. `inputTimeSec` places
 *  it on the timeline via millisecond delay, exactly like the legacy per-cue chain. */
export function renderSoundEffectFragment(instruction: SoundInstruction): FilterFragment[] {
  const { timeSec, volume, fadeInSec, fadeOutSec, reason } = instruction;
  const delayMs = Math.round(Math.max(0, timeSec) * 1000);
  const trimSec = DEFAULT_SFX_TRIM_SEC;
  const parts = [`adelay=${delayMs}|${delayMs}`, `volume=${clamp01(volume).toFixed(2)}`];

  if (fadeInSec > 0 || fadeOutSec > 0) {
    const fadeOutStart = Math.max(0, trimSec - fadeOutSec);
    if (fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`);
    if (fadeOutSec > 0) parts.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`);
  }

  parts.push(`atrim=0:${trimSec.toFixed(2)}`, "asetpts=PTS-STARTPTS");
  return [{ filter: parts.join(","), reason }];
}

/** The voice-track fade template used at every mix site in videoPipeline.ts, generalized from
 *  its fixed 0.06s/0.12s to whatever fade durations the EDL specifies. */
export function buildVoiceFadeFragment(fadeInSec: number, fadeOutSec: number, totalDurationSec: number): FilterFragment {
  const fadeOutStart = Math.max(0, totalDurationSec - fadeOutSec);
  return {
    filter: `afade=t=in:st=0:d=${Math.max(0, fadeInSec).toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${Math.max(0, fadeOutSec).toFixed(3)}`,
    reason: "voice fade in/out",
  };
}

/** FFmpeg's native audio crossfade filter — real, just not previously used anywhere in this
 *  codebase. `curve` defaults to "tri" (linear triangular fade), matching the simplest,
 *  safest default for a documentary-style cut. */
export function buildCrossfadeNode(inputs: [string, string], durationSec: number, output: string, curve = "tri"): FilterGraphNode {
  return {
    inputs,
    filter: `acrossfade=d=${Math.max(0.01, durationSec).toFixed(3)}:c1=${curve}:c2=${curve}`,
    output,
  };
}

/** The exact sidechain-ducking mini-graph reused from videoPipeline.ts's music-under-voice
 *  mix: split the voice for sidechain detection, loop the music bed, duck it under the voice,
 *  then mix voice and ducked music together. Returns the raw filter_complex snippet (already
 *  bracket-labeled and `;`-joined) rather than a single FilterGraphNode, since this sub-graph
 *  forks and merges internally. */
export function buildDuckingFilterComplex(
  voiceInput: string,
  musicInput: string,
  musicVolume: number,
  output: string
): string {
  const vol = clamp01(musicVolume).toFixed(2);
  return (
    `[${voiceInput}]volume=1.0,asplit=2[voice_${output}][voicedet_${output}];` +
    `[${musicInput}]volume=${vol},aloop=loop=-1:size=2e+09[musicloop_${output}];` +
    `[musicloop_${output}][voicedet_${output}]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200:makeup=1[ducked_${output}];` +
    `[voice_${output}][ducked_${output}]amix=inputs=2:duration=first:dropout_transition=3[${output}]`
  );
}

export type VolumeKeyframe = { timeSec: number; volume: number };

/** Piecewise-linear volume automation: a real `volume='...'` time expression interpolating
 *  between keyframes, evaluated per output frame. Constant before the first keyframe and after
 *  the last. Keyframes are sorted by time; fewer than 2 keyframes yields a flat volume. */
export function buildVolumeAutomationFragment(keyframes: VolumeKeyframe[], reason: string): FilterFragment {
  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);

  if (sorted.length === 0) {
    return { filter: "volume=1.0", reason };
  }
  if (sorted.length === 1) {
    return { filter: `volume=${clamp01(sorted[0]!.volume).toFixed(3)}`, reason };
  }

  let expr = clamp01(sorted[sorted.length - 1]!.volume).toFixed(3);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const va = clamp01(a.volume);
    const vb = clamp01(b.volume);
    const span = Math.max(0.001, b.timeSec - a.timeSec);
    const lerp = `${va.toFixed(3)}+(${(vb - va).toFixed(3)})*(t-${a.timeSec.toFixed(3)})/${span.toFixed(3)}`;
    expr = `if(lt(t,${b.timeSec.toFixed(3)}),${lerp},${expr})`;
  }
  expr = `if(lt(t,${sorted[0]!.timeSec.toFixed(3)}),${clamp01(sorted[0]!.volume).toFixed(3)},${expr})`;

  return { filter: `volume='${expr}':eval=frame`, reason };
}
