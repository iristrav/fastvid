/** Cinematic Editing Engine — Visual Effects Planner (Phase 4).
 *
 *  Decides which visual effects apply to a beat and at what intensity — never renders them.
 *  Distinct from server/pipeline/stages/effectsPlanner.ts (Phase 2's stage, which reorders
 *  clips and adjusts beat hold durations — a pacing/sequencing stage that was misleadingly
 *  named "Effects Planner" despite not touching a single visual effect; see the Phase 4 audit
 *  in this session for the full comparison). This module is what that name actually means:
 *  glow, film grain, vignette, noise, particles, dust, lens flare, bloom, chromatic
 *  aberration, letterbox.
 *
 *  Vignette and film grain already exist as render primitives in documentaryStyle.ts
 *  (buildDocumentaryVignetteVF, buildFilmGrainVF, live in production) — this planner decides
 *  WHEN to apply them (a decision that render primitive doesn't make itself), it doesn't
 *  reimplement the rendering. The remaining eight effect types have no existing render
 *  primitive anywhere in the codebase (confirmed by this session's Phase 4 research) and are
 *  genuinely new instructions.
 *
 *  Deliberately conservative: most beats get zero or one effect. "Only apply effects when
 *  they improve the scene" is enforced by requiring each effect to have its own specific
 *  trigger — there is no default/fallback effect the way ShotPlanner has "medium" or
 *  TransitionPlanner has "cut".
 */
import type { CandidateAsset } from "../visualMatchingV2/types";
import type { EffectInstruction, PacingProfile, ShotInstruction } from "./types";

const BRIGHT_LIGHT_SIGNALS = ["light", "sun", "bright", "glow", "shine", "stage lighting", "spotlight", "neon"];
const FLARE_SIGNALS = ["sun", "sunset", "sunrise", "flare", "backlit"];
const BROADCAST_SIGNALS = ["broadcast", "news", "transmission", "signal", "static"];
const ATMOSPHERE_SIGNALS = ["dust", "smoke", "fire", "snow", "rain", "fog", "mist"];

function candidateSearchText(candidate: CandidateAsset): string {
  return [candidate.searchQuery, candidate.title ?? "", candidate.description ?? ""].join(" ").toLowerCase();
}

function textMatchesAny(text: string, signals: string[]): string | null {
  return signals.find((s) => text.includes(s)) ?? null;
}

function effect(effectType: EffectInstruction["effectType"], intensity: number, reason: string): EffectInstruction {
  return { effectType, intensity: Math.max(0.05, Math.min(1, intensity)), reason };
}

/** Builds every visual-effect instruction that applies to this beat. Returns an empty array
 *  for the (common, correct) case of a clean, unadorned shot. */
export function planVisualEffects(shot: ShotInstruction, candidate: CandidateAsset, pacing: PacingProfile): EffectInstruction[] {
  const out: EffectInstruction[] = [];
  const searchText = candidateSearchText(candidate);
  const isArchive = shot.shotType === "archive_footage";

  if (isArchive || pacing.tone === "dramatic") {
    out.push(
      effect(
        "vignette",
        isArchive ? 0.55 : 0.4,
        isArchive
          ? "Archive footage — a vignette matches the framed, aged look of historical documentary footage."
          : "Dramatic pacing — a subtle vignette draws focus inward and adds visual weight."
      )
    );
  }

  if (isArchive) {
    out.push(effect("film_grain", 0.45, "Archive footage — film grain matches the texture of period film stock."));
    out.push(effect("dust", 0.2, "Archive footage — light dust/scratch texture reinforces the aged-film look."));
  } else if (pacing.tone === "dramatic") {
    out.push(effect("film_grain", 0.2, "Dramatic pacing on modern footage — light film grain adds cinematic texture without looking archival."));
  }

  const broadcastSignal = textMatchesAny(searchText, BROADCAST_SIGNALS);
  if (broadcastSignal && !isArchive) {
    out.push(effect("noise", 0.25, `Candidate's search text matches "${broadcastSignal}" — subtle noise suggests a broadcast/transmission feel.`));
  }

  if (shot.shotType === "establishing" || shot.shotType === "wide") {
    if (pacing.tone === "dramatic") {
      out.push(effect("letterbox", 0.5, "Dramatic pacing on a wide/establishing shot — letterboxing adds cinematic scale to the frame."));
    }
    const atmosphere = textMatchesAny(searchText, ATMOSPHERE_SIGNALS);
    if (atmosphere) {
      out.push(effect("particles", 0.3, `Candidate's search text matches "${atmosphere}" — light particle atmosphere reinforces the environment.`));
    }
  }

  const flareSignal = textMatchesAny(searchText, FLARE_SIGNALS);
  if (flareSignal && (shot.shotType === "establishing" || shot.shotType === "wide")) {
    out.push(effect("lens_flare", 0.35, `Candidate's search text matches "${flareSignal}" — a lens flare matches a bright, backlit outdoor shot.`));
  } else {
    const brightSignal = textMatchesAny(searchText, BRIGHT_LIGHT_SIGNALS);
    if (brightSignal) {
      out.push(effect("bloom", 0.3, `Candidate's search text matches "${brightSignal}" — bloom softens and emphasizes the light source.`));
    }
  }

  if (["close_up", "detail"].includes(shot.shotType) && pacing.tone === "exciting") {
    out.push(effect("glow", 0.3, `Exciting pacing on a ${shot.shotType} shot — a soft glow adds energy and polish.`));
  }

  if (pacing.tone === "exciting" && pacing.cutSpeedMultiplier > 1.3) {
    out.push(effect("chromatic_aberration", 0.15, "Fast, exciting pacing — a light chromatic aberration adds a stylized, high-energy edge without overdoing it."));
  }

  return out;
}
