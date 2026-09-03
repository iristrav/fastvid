/**
 * THE SCORE — a cue sheet from the film's own emotional curve, and a catalogue to fill it from.
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────
 *
 * Nothing, and that is the point. FastVid has never had music. The compose route synthesised a
 * sine bed (`generateBackgroundMusic`), which is a tone and not a score; the cinematic route
 * refuses to lay that down and reports `musicSourceUnavailable` instead. Both are honest. Neither
 * is a documentary score.
 *
 * ── Why the catalogue is empty by default, and why that is not a stub ───────────────────────
 *
 * Music is the one asset class where getting it wrong is a legal problem rather than an editorial
 * one. This module therefore ships the ARCHITECTURE and no tracks: a `MusicTrack` carries a real
 * provider identity and a real licence, a `MusicCatalogue` is something a deployment plugs in, and
 * the default catalogue is empty and says so.
 *
 * Inventing plausible-looking Freesound or Incompetech ids here would be fabrication — the exact
 * failure this codebase has spent rounds removing everywhere else. An id nobody has verified is
 * worse than no id: it renders, it sounds like music, and it is somebody's copyright.
 *
 * So the external dependency is stated rather than faked. A deployment that has a licensed
 * catalogue registers it; one that has not gets a film with no music and a line saying why.
 *
 * ── The two halves ──────────────────────────────────────────────────────────────────────────
 *
 *     planMusicCues     the EDITORIAL half — where music should be, what it should do, and how
 *                       intense. Derived from the emotional curve the Documentary Planning Engine
 *                       already produces, so it follows the story rather than the clock.
 *
 *     MusicCatalogue    the SUPPLY half — what a deployment actually holds, with identity and
 *                       licence. Asked for a cue's requirements; free to answer "nothing fits".
 *
 * They are separate because they fail separately. A film with no catalogue still has a correct cue
 * sheet, which is what makes the gap measurable rather than invisible.
 */
import type { AssetSourceIdentity } from "./projectTimeline";

/* ═══════════════════════ the editorial half ═══════════════════════ */

/**
 * What a cue is FOR. This is the vocabulary an editor uses when spotting a film, and each entry
 * says something different about how the music should behave — not merely how loud it is.
 */
export type MusicCueRole =
  /** Over the opening. Establishes tone before the viewer knows anything. */
  | "intro"
  /** Rising. The narration is accumulating facts towards something. */
  | "build"
  /** Held, unresolved. Something is wrong or about to be. */
  | "tension"
  /** After a tension or climax cue. The listener is allowed to breathe. */
  | "release"
  /** The peak of an act. Used sparingly; a film with four climaxes has none. */
  | "climax"
  /** Between acts. Short, and its job is to carry the cut rather than to be noticed. */
  | "transition"
  /** Over the close. */
  | "outro"
  /**
   * Deliberate silence.
   *
   * A spotting decision, not an absence of one. The most effective moment in a documentary score
   * is frequently the bar where it stops, and a cue sheet that cannot express that will lay music
   * under the whole film because nothing told it not to.
   */
  | "silence";

export type MusicCue = {
  role: MusicCueRole;
  startSec: number;
  endSec: number;
  /** 0–100, from the emotional curve. Drives track choice, not gain. */
  intensity: number;
  /** The scenes this cue spans, for the log and for the editor UI. */
  sceneIndices: number[];
  /** Why this cue is here, in one sentence. §2: nothing decided without a stated reason. */
  reason: string;
};

/** One point of the film's emotional shape. Matches `EmotionalCurvePoint` structurally. */
export type CurvePoint = {
  sceneIndex: number;
  beatIndex: number;
  emotion: string;
  intensity: number;
};

/** How long a cue must be before it is worth having. Below this it is a sting, not a cue. */
export const MIN_CUE_SEC = 6;

/**
 * Where the score should be, and what it should be doing there.
 *
 * ── Why scenes and not beats ────────────────────────────────────────────────────────────────
 *
 * Music that changes every beat is not scoring, it is stabbing. A documentary cue runs across a
 * paragraph of narration and changes when the argument does. So the curve is read per SCENE — the
 * mean of its beats' intensities — and neighbouring scenes with the same shape are joined into one
 * cue.
 *
 * ── Why silence is a cue ────────────────────────────────────────────────────────────────────
 *
 * The lowest-intensity stretch of a film is the one where music does the most damage: a quiet,
 * factual passage with a bed under it reads as manipulation. `silence` is emitted for those rather
 * than simply leaving a gap, so the decision is visible in the cue sheet and an editor can argue
 * with it.
 */
export function planMusicCues(params: {
  curve: readonly CurvePoint[];
  /** Scene start/end on the film's clock. Index-aligned with the scenes themselves. */
  sceneWindows: ReadonlyArray<{ startSec: number; endSec: number }>;
  /** The whole film, so the outro can be placed against a real ending. */
  totalDurationSec: number;
}): MusicCue[] {
  const { sceneWindows, totalDurationSec } = params;
  if (sceneWindows.length === 0 || totalDurationSec <= 0) return [];

  /** Mean intensity per scene. A scene the curve says nothing about is neutral, not silent. */
  const intensityByScene = new Map<number, number>();
  for (let i = 0; i < sceneWindows.length; i++) {
    const points = params.curve.filter((p) => p.sceneIndex === i);
    intensityByScene.set(
      i,
      points.length === 0
        ? 50
        : Math.round(points.reduce((sum, p) => sum + p.intensity, 0) / points.length)
    );
  }

  const peak = Math.max(...[...intensityByScene.values()], 0);

  /**
   * One role per scene, before any joining.
   *
   * The rules are deliberately few and stated. A scene is a climax only if it is AT the film's
   * peak and the peak is genuinely high — a flat film has no climax, and labelling its loudest
   * scene one would put a swell under an ordinary paragraph.
   */
  const roleFor = (sceneIndex: number): MusicCueRole => {
    const here = intensityByScene.get(sceneIndex) ?? 50;
    const before = intensityByScene.get(sceneIndex - 1);
    const isFirst = sceneIndex === 0;
    const isLast = sceneIndex === sceneWindows.length - 1;
    if (isFirst) return "intro";
    if (isLast) return "outro";
    if (here <= 25) return "silence";
    if (peak >= 70 && here >= peak - 5) return "climax";
    if (before != null && here >= before + 15) return "build";
    if (before != null && here <= before - 15) return "release";
    if (here >= 60) return "tension";
    return "transition";
  };

  const raw = sceneWindows.map((w, i) => ({
    sceneIndex: i,
    role: roleFor(i),
    intensity: intensityByScene.get(i) ?? 50,
    startSec: w.startSec,
    endSec: w.endSec,
  }));

  /** Neighbouring scenes doing the same job are one cue, not two identical ones back to back. */
  const cues: MusicCue[] = [];
  for (const scene of raw) {
    const open = cues[cues.length - 1];
    if (open && open.role === scene.role && Math.abs(open.endSec - scene.startSec) < 0.5) {
      open.endSec = scene.endSec;
      open.sceneIndices.push(scene.sceneIndex);
      open.intensity = Math.round((open.intensity + scene.intensity) / 2);
      continue;
    }
    cues.push({
      role: scene.role,
      startSec: scene.startSec,
      endSec: scene.endSec,
      intensity: scene.intensity,
      sceneIndices: [scene.sceneIndex],
      reason: reasonFor(scene.role, scene.intensity, peak),
    });
  }

  /**
   * A cue shorter than `MIN_CUE_SEC` is a sting, and a sting under narration reads as a mistake.
   * It is absorbed into the cue before it rather than dropped, so the film keeps its shape.
   */
  const merged: MusicCue[] = [];
  for (const cue of cues) {
    const previous = merged[merged.length - 1];
    if (previous && cue.endSec - cue.startSec < MIN_CUE_SEC) {
      previous.endSec = cue.endSec;
      previous.sceneIndices.push(...cue.sceneIndices);
      continue;
    }
    merged.push(cue);
  }
  return merged;
}

function reasonFor(role: MusicCueRole, intensity: number, peak: number): string {
  switch (role) {
    case "intro":
      return "the film's opening — tone is set before the viewer knows anything";
    case "outro":
      return "the film's close — the last thing the viewer hears under the final words";
    case "silence":
      return `the quietest stretch of the film (intensity ${intensity}) — a bed here would read as manipulation`;
    case "climax":
      return `at the film's emotional peak (${intensity} of ${peak})`;
    case "build":
      return `intensity rises to ${intensity} — the narration is accumulating towards something`;
    case "release":
      return `intensity falls to ${intensity} — the listener is allowed to breathe`;
    case "tension":
      return `sustained high intensity (${intensity}), unresolved`;
    case "transition":
      return "between acts — the cue carries the cut rather than being noticed";
  }
}

/* ═══════════════════════ the supply half ═══════════════════════ */

/**
 * One piece of music a deployment is ALLOWED to use, with everything needed to prove that.
 *
 * `identity` and `licence` are not optional and not free text by accident. A track with no
 * provable source is a track nobody can defend, and this system already learned that lesson about
 * pictures: the lineage ledger exists because a file in a temp directory is not a source.
 */
export type MusicTrack = {
  /** How the renderer fetches it again tomorrow. Same shape every other asset uses. */
  identity: AssetSourceIdentity;
  title: string;
  /** The moods this track can honestly serve. Free-form, matched loosely against a cue's role. */
  moods: readonly string[];
  /** Beats per minute, when the catalogue knows it. Unknown is better than invented. */
  bpm?: number;
  /** 0–100. What this track feels like at full gain, independent of how it will be mixed. */
  energy: number;
  instrumentation: readonly string[];
  durationSec: number;
  /**
   * The licence, verbatim from the source. "CC0", "CC-BY-4.0", "public-domain",
   * "licensed:<agreement>". Never inferred, never "probably fine".
   */
  licence: string;
  /** Where a human can go and check all of the above. */
  sourcePageUrl?: string;
};

export type MusicRequest = {
  role: MusicCueRole;
  intensity: number;
  minDurationSec: number;
};

/**
 * What a deployment plugs in.
 *
 * Deliberately one method. A catalogue that can answer "what have you got for a build cue at
 * intensity 70 that lasts at least 40 seconds" is enough to score a film; anything richer is a
 * search engine, and this system already has too many of those.
 */
export type MusicCatalogue = {
  /** A name for the log, so a render says WHICH catalogue scored it. */
  readonly name: string;
  find(request: MusicRequest): MusicTrack | null;
};

/**
 * The catalogue this repository ships: none.
 *
 * ── Why this is the right default ───────────────────────────────────────────────────────────
 *
 * There is no licensed music in this repository, and there is no way for this file to obtain any
 * without inventing identifiers it cannot verify. A curated list of Freesound or public-domain ids
 * written from memory would render, would sound like music, and would be somebody's copyright with
 * a fabricated licence field attached.
 *
 * So the honest catalogue is the empty one, and the gap is reported on every render rather than
 * filled with something that merely passes.
 */
export const EMPTY_MUSIC_CATALOGUE: MusicCatalogue = {
  name: "none",
  find: () => null,
};

let registered: MusicCatalogue = EMPTY_MUSIC_CATALOGUE;

/**
 * Plug a catalogue in.
 *
 * The one seam a deployment with licensed music needs. Called once at startup; the module holds
 * no state beyond this, so a catalogue swapped between renders takes effect on the next one.
 */
export function registerMusicCatalogue(catalogue: MusicCatalogue): void {
  registered = catalogue;
}

/** The catalogue in force. `EMPTY_MUSIC_CATALOGUE` until a deployment registers one. */
export function activeMusicCatalogue(): MusicCatalogue {
  return registered;
}

/** Restore the shipped default. For tests, and for a deployment that revokes a licence. */
export function resetMusicCatalogue(): void {
  registered = EMPTY_MUSIC_CATALOGUE;
}

/* ═══════════════════════ putting the two together ═══════════════════════ */

export type ScoredCue = {
  cue: MusicCue;
  /** Null when the catalogue held nothing for this cue, or the cue is deliberate silence. */
  track: MusicTrack | null;
  /** Why there is no track, when there is none. Empty when there is one. */
  unavailableReason: string;
};

/**
 * The cue sheet, with whatever the catalogue could actually supply.
 *
 * A `silence` cue is never given a track — that is the whole point of it — and it is not reported
 * as a gap either. Everything else that comes back empty says so, by cue, so a render's log
 * distinguishes "we chose not to score this" from "we had nothing to score it with".
 */
export function scoreCues(
  cues: readonly MusicCue[],
  catalogue: MusicCatalogue = activeMusicCatalogue()
): ScoredCue[] {
  return cues.map((cue) => {
    if (cue.role === "silence") {
      return { cue, track: null, unavailableReason: "" };
    }
    const track = catalogue.find({
      role: cue.role,
      intensity: cue.intensity,
      minDurationSec: Math.max(MIN_CUE_SEC, cue.endSec - cue.startSec),
    });
    return {
      cue,
      track,
      unavailableReason: track
        ? ""
        : catalogue.name === "none"
          ? "no music catalogue is registered in this deployment"
          : `${catalogue.name} held nothing for a ${cue.role} cue at intensity ${cue.intensity}`,
    };
  });
}

/** The cue sheet as render-log lines. One per cue, plus a verdict. */
export function formatCueSheet(scored: readonly ScoredCue[]): string[] {
  if (scored.length === 0) return ["[Music] no cue sheet — the film has no scenes to score"];
  const lines = scored.map((s) => {
    const len = (s.cue.endSec - s.cue.startSec).toFixed(1);
    const head =
      `[Music] ${s.cue.role} ${s.cue.startSec.toFixed(1)}–${s.cue.endSec.toFixed(1)}s (${len}s) ` +
      `intensity=${s.cue.intensity} scenes=${s.cue.sceneIndices.join(",")}`;
    if (s.cue.role === "silence") return `${head} — ${s.cue.reason}`;
    if (s.track) {
      return (
        `${head} track="${s.track.title}" ` +
        `${s.track.identity.provider}:${s.track.identity.providerAssetId ?? "?"} ` +
        `licence=${s.track.licence}`
      );
    }
    return `${head} UNSCORED — ${s.unavailableReason}`;
  });
  const wanted = scored.filter((s) => s.cue.role !== "silence").length;
  const got = scored.filter((s) => s.track).length;
  lines.push(
    `[Music] TOTAL cues=${scored.length} scored=${got}/${wanted} ` +
      `catalogue=${activeMusicCatalogue().name}` +
      (got === 0 && wanted > 0
        ? " — THIS FILM HAS NO MUSIC. Register a licensed catalogue with registerMusicCatalogue()."
        : "")
  );
  return lines;
}
