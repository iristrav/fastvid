/** Cinematic Editing Engine — Shot Planner (Phase 4).
 *
 *  Chooses one ShotType per beat from the full documentary vocabulary. Deliberately a pure,
 *  deterministic decision tree (not an LLM call): every signal it reads (VisualIntent's
 *  entities/action, the winning CandidateAsset's source/searchQuery/dimensions) was already
 *  produced by Phase 2/3, so classifying it into a shot type needs no new inference step —
 *  only a policy over data that already exists. This also keeps the planner instantly
 *  testable with plain objects, matching "each planner must be independently testable."
 *
 *  Reuses editorialSequencePlanner.ts's shot-type vocabulary as its reference point (that
 *  module already assigns a shotType per beat pre-retrieval, for search-query planning) but
 *  classifies post-retrieval, against the actual winning candidate — the two operate on
 *  different sides of retrieval (see Phase 3's queryGeneration.ts doc comment on the same
 *  distinction) and are not redundant with each other.
 */
import { GENERIC_ENTITY_FALLBACK_CATEGORIES } from "../visualMatchingV2/intelligentFallback";
import type { CandidateAsset, VisualIntent } from "../visualMatchingV2/types";
import type { ShotInstruction, VisualContinuityState } from "./types";

const REACTION_SIGNALS = ["reaction", "applause", "audience", "crowd", "cheering", "spectator"];
const DETAIL_ACTION_SIGNALS = ["hold", "reveal", "show", "unveil", "display", "operate", "open", "close", "type", "write"];
const EXTREME_DETAIL_SIGNALS = ["texture", "close detail", "zoom", "tiny", "micro", "fine detail"];
const PORTRAIT_ACTION_SIGNALS = ["speak", "talk", "interview", "announce", "smile", "look", "react", "cry", "laugh", "explain"];
const ARCHIVE_SOURCES: CandidateAsset["source"][] = ["own_archive", "internet_archive", "wikimedia", "europeana"];

function textMatchesAny(text: string, signals: string[]): string | null {
  const lower = text.toLowerCase();
  return signals.find((s) => lower.includes(s)) ?? null;
}

function candidateSearchText(candidate: CandidateAsset): string {
  return [candidate.searchQuery, candidate.title ?? "", candidate.description ?? ""].join(" ").toLowerCase();
}

function isPortraitAsset(candidate: CandidateAsset): boolean {
  if (candidate.assetType !== "image" || !candidate.width || !candidate.height) return false;
  return candidate.width / candidate.height < 0.85;
}

/**
 * Chooses this beat's shot type. Checked in priority order — the first matching rule wins,
 * and every branch states exactly why. `continuity` (optional) lets the establishing-shot
 * rule fire only the first time a location appears in the scene, not on every beat that
 * mentions it.
 */
export function planShot(
  intent: VisualIntent,
  candidate: CandidateAsset,
  continuity?: VisualContinuityState
): ShotInstruction {
  const searchText = candidateSearchText(candidate);
  const action = (intent.visualAction ?? "").toLowerCase();

  if (intent.historicalContext.trim() && ARCHIVE_SOURCES.includes(candidate.source)) {
    return {
      shotType: "archive_footage",
      reason: `Beat has historical context ("${intent.historicalContext}") and the winning candidate came from ${candidate.source}, an archival source.`,
    };
  }

  const reactionHit = textMatchesAny(searchText, REACTION_SIGNALS);
  if (reactionHit) {
    return {
      shotType: "reaction",
      reason: `Candidate's search text matches "${reactionHit}" — footage of people reacting, not the primary subject itself.`,
    };
  }

  const fallbackCategory = GENERIC_ENTITY_FALLBACK_CATEGORIES.find((c) => searchText.includes(c));
  if (fallbackCategory) {
    return {
      shotType: "b_roll",
      reason: `Candidate was retrieved via the generic-category fallback ("${fallbackCategory}") — supplementary coverage, not a direct match for a named entity.`,
    };
  }

  const extremeDetailHit = textMatchesAny(searchText, EXTREME_DETAIL_SIGNALS);
  if (extremeDetailHit && intent.objects.length > 0) {
    return {
      shotType: "extreme_close_up",
      reason: `Candidate's search text matches "${extremeDetailHit}" and the beat names a specific object (${intent.objects[0]}) — an extreme close-up isolates that detail.`,
    };
  }

  const detailActionHit = textMatchesAny(action, DETAIL_ACTION_SIGNALS);
  if (detailActionHit && intent.objects.length > 0) {
    return {
      shotType: "detail",
      reason: `Beat's action ("${intent.visualAction}") matches "${detailActionHit}" and names an object (${intent.objects[0]}) — a detail shot shows what's being ${detailActionHit === "hold" ? "held" : detailActionHit}.`,
    };
  }

  const portraitActionHit = textMatchesAny(action, PORTRAIT_ACTION_SIGNALS);
  if ((portraitActionHit && intent.people.length > 0) || isPortraitAsset(candidate)) {
    return {
      shotType: "close_up",
      reason: portraitActionHit
        ? `Beat names a person (${intent.people[0]}) and the action ("${intent.visualAction}") matches "${portraitActionHit}" — a close-up reads the person's expression.`
        : "Winning candidate is a portrait-oriented still image, framed like a headshot.",
    };
  }

  if (intent.visualLocation.trim()) {
    const alreadyEstablished = continuity?.establishedSubjects.some(
      (s) => s.toLowerCase() === intent.visualLocation.trim().toLowerCase()
    );
    if (!alreadyEstablished) {
      return {
        shotType: "establishing",
        reason: `First time "${intent.visualLocation}" appears in this scene — an establishing shot orients the viewer before cutting closer.`,
      };
    }
    return {
      shotType: "wide",
      reason: `"${intent.visualLocation}" was already established earlier in this scene — a wide shot keeps context without re-establishing.`,
    };
  }

  if (candidate.source === "ai_generated") {
    return {
      shotType: "overlay_shot",
      reason: "Winning candidate is an AI-generated asset, typically used as a graphic overlay rather than a standalone documentary shot.",
    };
  }

  if (intent.countries.length > 0) {
    return {
      shotType: "wide",
      reason: `Beat references a country/region (${intent.countries[0]}) with no specific location named — a wide shot suits geographic context.`,
    };
  }

  return {
    shotType: "medium",
    reason: "No stronger signal (no person action, no named object, no location) — medium shot is the safe documentary default.",
  };
}
