/**
 * VISUAL JUDGE — the one content decision.
 *
 * "Does this picture belong under this sentence?" is answered here and nowhere else. Every route
 * reaches the timeline through the same order:
 *
 *     search → TechnicalMediaGate → ranking → VisualJudge → adoptClip → push → timeline
 *
 * The TechnicalMediaGate (`technicalMediaGate.ts`) answers "can this FILE be used at all?" and never
 * reads narration. Ranking orders candidates and never refuses one. This module is the only place
 * that refuses a candidate for what it shows — on its metadata before anything is downloaded or
 * looked at, on someone else's on-screen text, and on its pixels through the one picture model.
 *
 * Every answer has one shape: ACCEPT or REJECT, a reason, a confidence. A metadata rule is
 * deterministic (confidence 1); a picture verdict carries the model's own certainty.
 */
import path from "path";
import { normalizeMediaTags } from "./db";
import type { MediaArchiveAsset } from "../drizzle/schema";
import type { CandidateMeta } from "./assetDirector";
import { isAIGeneratedClip, isOpenArchiveVideoClip, isStockVideoClip } from "./documentaryStyle";
import { recordGateVerdict } from "./gateFiringStats";
import {
  archiveClipBakedEditTextVerdict,
  archiveClipTextVerdict,
  cachedClipBakedEditTextVerdict,
  type OverlayTextKind,
} from "./archiveClipFilter";
import {
  checkBeatRelevance,
  composeBarrierAllows,
  type BeatRelevanceDecision,
  type BeatRelevanceParams,
} from "./beatVisualRelevance";
import { adoptionGuardVerdict, visionVerdictFromGate } from "./adoptionPolicy";
import { asVideoTitleString, coercePersonName } from "./stringCoercion";
import { vidrushDocumentaryQualityEnabled } from "./sourcingPolicy";
import { isNonDocumentaryClipPath, isNonDocumentaryVisualHay, resolveBeatRegionLock, isOffTopicGeoUrbanVisual, isWrongRegionForSegmentLock, offTopicVisualAllowedForBeat } from "./vidrushQuality";
import { effectiveArchiveAssetTags } from "./visualBeatTags";

export type VisualJudgeDecision = "ACCEPT" | "REJECT";

export type VisualJudgeVerdict = {
  decision: VisualJudgeDecision;
  /** Machine-readable reason; the same strings the reject audit has always recorded. */
  reason: string;
  /** 0..1. Deterministic metadata rules are 1; a model verdict carries its own certainty. */
  confidence: number;
  stage: "metadata" | "on_screen_text" | "picture";
  /**
   * false when nothing was looked at (budget spent, detector off, no answer). Such a verdict is an
   * ACCEPT that must never be written down as a clean bill — see `judgeOnScreenText`.
   */
  evaluated?: boolean;
};

const accept = (stage: VisualJudgeVerdict["stage"], reason = "ok", confidence = 1): VisualJudgeVerdict => ({
  decision: "ACCEPT",
  reason,
  confidence,
  stage,
});
const reject = (stage: VisualJudgeVerdict["stage"], reason: string, confidence = 1): VisualJudgeVerdict => ({
  decision: "REJECT",
  reason,
  confidence,
  stage,
});

/** True when haystack contains the celebrity name (last name or full name). */
export function textMentionsPersonName(haystack: string, personName: string): boolean {
  const name = coercePersonName(personName);
  if (!name) return false;
  const hay = haystack.toLowerCase();
  const parts = name.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
  if (!parts.length) return false;
  if (parts.length === 1) return hay.includes(parts[0]);
  const last = parts[parts.length - 1];
  if (hay.includes(last)) return true;
  return parts.every((p) => hay.includes(p));
}

/**
 * VIDEO 623 — what a stock clip IS (a cartoon, a render, a miniature), never what it is ABOUT.
 * The list also refused bridges, campfires, journalists, courtrooms, textile mills and roads on
 * every topic — words chosen for one kind of film. What a clip shows is the picture editor's call.
 */
/*
 * VIDEO 638 — a term is a WORD, not a run of letters. "icon" refused every candidate of a sentence
 * that said "its iconic face"; "toy" would refuse "Toyota", "graphic" "infographic". Each term now
 * matches only between non-letters/digits (spaces, punctuation, "-", "_" and "." of a file name all
 * separate), with its plural ("icons", "graphics", "glitches"). The terms themselves are unchanged.
 */
export const BLOCKED_STOCK_TAGS_RE =
  /(?<![a-z0-9])(?:emoji|cartoon|animation|icon|illustration|graphic|pattern|sticker|clipart|motion graphics|3d render|abstract background|wallpaper|seamless loop|looping|dashcam|miniature|scale model|toy|diorama|tabletop|model rocket|science fiction|sci-fi|vhs|glitch|archival)(?:e?s)?(?![a-z0-9])/i;

/** When narration names a real company/product, clip slug/query must show that same entity (real-world footage). */
export type RealEntityRuleBase = {
  id: string;
  mentionRe: RegExp;
  clipMustMatchRe: RegExp;
  stockQueries: string[];
  youtubeQueries: string[];
  /**
   * RONDE 177 — WHAT the named entity is.
   *
   * Added so the cinematic engine's `VisualIntent.brands` / `.companies` / `.objects` can be filled
   * from a table that already knows every one of these names, instead of a second name list or a
   * guess made at read time. Tesla is a company and the Cybertruck is a product; that is a fact
   * about the world, not a search term, and nothing in the query path reads this field.
   *
   * `person` is here so the people in this table are NOT offered as brands. A beat that says
   * "Elon Musk" would otherwise put an animated icon labelled "Elon Musk" on screen, and the
   * person channel (extractPersonNamesFromText) already answers that question properly.
   */
  kind: "person" | "company" | "brand" | "object";
};

/**
 * RONDE 249 — A SURNAME IS NOT A PERSON, AND THE TYPE SAYS SO.
 *
 * Render 584's scene 2 was about KRIS Jenner. The kylie rule's `mentionRe` ends in `jenner\b`, so
 * it matched, and YouTube was asked for "Kylie Jenner" — the wrong person, 26 times in eight
 * minutes. Measured, not deduced: `extractBeatRealEntities` on the render's own sentence returns
 * the kylie rule, and on the bare word "Jenner" it returns it too.
 *
 * A surname belongs to a family, not to a person. So a rule that claims to recognise a PERSON now
 * has to carry the name it recognises, and `extractBeatRealEntities` requires the beat to contain
 * that whole name before the rule may speak.
 *
 * This is a union rather than an optional field on purpose. Optional would let rule thirteen be
 * added without one and fail silently — either matching a surname again, or (fail-closed) going
 * quiet for no visible reason. The compiler asks the question instead.
 *
 * The other ten rules are companies, brands and objects, where the bare token IS the whole name:
 * "Tesla", "SpaceX", "Neuralink". Those are unchanged, and `fullName` would mean nothing on them.
 */
export type RealEntityRule =
  | (RealEntityRuleBase & {
      kind: "person";
      /** The person's full name as narration writes it — the rule may not fire on less. */
      fullName: string;
    })
  | (RealEntityRuleBase & { kind: "company" | "brand" | "object" });

/**
 * P0/P1 image-quality patch — Fix 1: reliable entity evidence.
 *
 * The search query that produced a candidate is never proof of what the candidate actually
 * shows — a provider can and does return mislabeled/irrelevant hits for a perfectly good query.
 * A candidate only counts as having entity evidence when there is SOME independently-authored
 * signal to check the rule against:
 *   - curated-archive annotation (`meta.annotation`) — the pipeline's own AI-derived
 *     persons/objects/location/era fields for this exact asset, or
 *   - provider-supplied text (`meta.providerText` — title/description/tags, as returned by the
 *     source itself), which is authored independently of whatever query this render happened to
 *     search with.
 * `sourceQuery` and the positional download filename are deliberately excluded — see
 * `clipSatisfiesRealEntities` below.
 */
export function hasReliableEntityEvidence(rules: RealEntityRule[], meta?: CandidateMeta): boolean {
  const ann = meta?.annotation;
  if (ann) {
    const annHay = [
      ...(ann.persons?.named ?? []),
      ...(ann.persons?.categories ?? []),
      ...(ann.objects ?? []),
      ...(ann.actions ?? []),
      ann.location?.continent, ann.location?.country, ann.location?.region, ann.location?.city,
      ann.environment?.setting,
      ann.historicalContext?.event, ann.historicalContext?.period,
      ann.historicalContext?.year, ann.historicalContext?.decade, ann.historicalContext?.century,
    ].filter(Boolean).join(" ").toLowerCase();
    if (annHay && rules.some((r) => r.clipMustMatchRe.test(annHay))) return true;
  }
  const pt = meta?.providerText;
  if (pt) {
    const providerHay = [pt.title, pt.description, pt.tags].filter(Boolean).join(" ").toLowerCase();
    if (providerHay && rules.some((r) => r.clipMustMatchRe.test(providerHay))) return true;
  }
  return false;
}

export function clipSatisfiesRealEntities(
  rules: RealEntityRule[],
  meta?: CandidateMeta
): boolean {
  if (rules.length === 0) return true;
  // P0/P1 image-quality patch: a search query containing "Elon Musk" does not prove Elon Musk
  // is in the pixels — it only proves what we searched for. sourceQuery/filename used to be the
  // sole "evidence" here, which made this gate pass by construction on every candidate a
  // REAL_ENTITY_RULES-triggering query itself produced. Now this gate requires independently-
  // authored evidence (archive annotation or provider title/description/tags); with neither
  // available, the conservative outcome is reject, not an unproven pass.
  return hasReliableEntityEvidence(rules, meta);
}

/** Reject model/CGI/archival-looking clips (Pexels slugs + local filenames) — form only. */
export const BLOCKED_STOCK_VISUAL_RE =
  /miniature|diorama|tabletop|model[- ]?rocket|scale[- ]?model|toy[- ]?rocket|replica|maquette|science[- ]?fiction|sci[- ]?fi|cgi|3d[- ]?animation|vhs|glitch|archival|rocket[- ]?model|model[- ]?launch|dashcam/i;

/** Animals / random nature B-roll that must not appear on named-celebrity videos (e.g. Kylie → flamingos). */
export const PERSON_OFFTOPIC_VISUAL_RE =
  /\b(flamingo|flamingos|peacock|parrot|zoo|safari|wildlife|aquarium|dolphin|whale|penguin|giraffe|elephant|lion|tiger|bear|crocodile|snake|monkey|gorilla|zebra|hippo|bird flock|flock of birds|exotic bird|pink birds)\b/i;

/**
 * RONDE 621 — A MODEL ROCKET AND THE APOLLO PROGRAMME ARE NOT THE SAME REFUSAL.
 *
 * These two lists were one. `blocked_model` matched
 *
 *     miniature | diorama | tabletop | toy | model rocket | scale model | vhs | glitch | sci-fi
 *     | cgi | saturn | apollo | lunar | moon-landing | moon-surface | space shuttle | shuttle
 *
 * and `categoryAtLimit` refuses that category unconditionally, on every topic. The first nine
 * words say "this footage is fake" — true of any film ever made. The last seven say "this is a
 * different space programme than SpaceX", which is true of a Musk video and is the SUBJECT of a
 * film about the moon landing. On such a film every query for its own subject was refused before
 * a provider was asked, with no log line that could explain why.
 *
 * This is RONDE 617's finding one category over, and the two are deliberately not fixed together:
 * a quota of 2 still yields two clips, while a block yields none. A refusal that can never be
 * satisfied is the urgent half, so it is the half this round takes.
 *
 * The split is by MEANING, not by topic: the fake-footage list still refuses everywhere, because a
 * diorama is a diorama on any subject. Only the "other programme" half asks whose film this is.
 */
export const BLOCKED_FAKE_FOOTAGE_RE =
  /miniature|diorama|tabletop|toy|model rocket|scale model|vhs|glitch|sci[- ]?fi|cgi/;

export function stockVisualCategory(query: string, filePath?: string): string {
  const combined = `${query} ${path.basename(filePath ?? "")}`.toLowerCase();
  /**
   * VIDEO 623 — the ladder's other rungs (gigafactory, solar, tesla, rocket, robot, factory,
   * space, the other space programmes, ships, roads, textile mills) were one film's vocabulary,
   * with quotas and refusals no other subject had. What is left is about the footage itself.
   */
  if (BLOCKED_FAKE_FOOTAGE_RE.test(combined)) {
    return "blocked_model";
  }
  return "generic";
}

/**
 * RONDE 621 — CONTENT REFUSALS, AND THE ONE THAT ASKS WHOSE FILM THIS IS.
 *
 * `blocked_model` and `blocked_offtopic` are refusals about the FOOTAGE — a diorama, a dashcam, a
 * container ship — and they hold on every topic, unchanged. `blocked_other_programme` is a refusal
 * about the SUBJECT: Apollo, Saturn, the Shuttle are the wrong space programme on a SpaceX video
 * and are the whole point of a film about the moon landing.
 *
 * One place, so a caller cannot answer this question differently by accident — which is how the
 * two came to be one list in the first place.
 */
export function categoryIsBlockedContent(category: string): boolean {
  return category === "blocked_model";
}

export function isOffTopicVisualForPersonTopic(
  sourceQuery: string,
  filePath: string,
  primaryPerson: string,
  providerTitle?: string
): boolean {
  const hay = `${sourceQuery} ${path.basename(filePath)}`.toLowerCase();
  if (PERSON_OFFTOPIC_VISUAL_RE.test(hay)) return true;
  const person = coercePersonName(primaryPerson);
  const parts = person.toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
  const queryMentionsPerson =
    (parts.length >= 2 && parts.every((p) => hay.includes(p))) ||
    (parts.length === 1 && hay.includes(parts[0]));
  if (queryMentionsPerson) {
    // Point 4 (final production hardening): a query built FROM primaryPerson trivially
    // "mentions" them — that alone is not independent evidence the visual actually shows that
    // person. When the provider itself supplied real title text, corroborate against it before
    // trusting the query's self-reference: if the title clearly points somewhere else (matches
    // one of the existing off-topic blocklists) and doesn't itself mention the person, don't
    // let the query override that. No providerText available -> unchanged existing behavior.
    if (providerTitle && providerTitle.trim()) {
      const titleHay = providerTitle.toLowerCase();
      const titleMentionsPerson =
        (parts.length >= 2 && parts.every((p) => titleHay.includes(p))) ||
        (parts.length === 1 && titleHay.includes(parts[0]));
      if (
        !titleMentionsPerson &&
        PERSON_OFFTOPIC_VISUAL_RE.test(titleHay)
      ) {
        return true;
      }
    }
    return false;
  }
  if (/\b(celebrity|interview|red carpet|paparazzi|influencer|makeup|fashion)\b/.test(hay)) return false;
  return false;
}

export function hasBlockedStockTags(tags?: string): boolean {
  return BLOCKED_STOCK_TAGS_RE.test(tags ?? "");
}


export function isRejectedStockClip(filePath: string, sourceQuery = ""): boolean {
  /**
   * Video 613 — FastVid adds "archival footage" to its own search queries (`askForFootage`, the
   * YouTube planner), and "archival" is on the stock block lists below. Every YouTube clip found
   * with such a query was refused as stock before the picture editor ever saw it. The words this
   * pipeline added itself say nothing about the clip, so they are not tested; the rest of the query
   * and the file name are tested exactly as before.
   */
  const ownQuery = sourceQuery.replace(/\barchival footage\b/gi, " ");
  const combined = `${ownQuery} ${path.basename(filePath)}`.toLowerCase();
  if (BLOCKED_STOCK_VISUAL_RE.test(combined)) return true;
  if (hasBlockedStockTags(combined)) return true;
  return false;
}

/** How strongly an asset matches geo/visual tags from the spoken beat. */
export function countVisualTagHits(
  asset: Pick<MediaArchiveAsset, "title" | "tags">,
  visualTags: string[]
): number {
  if (!visualTags.length) return 0;
  const assetTags = effectiveArchiveAssetTags(asset);
  let hits = 0;
  for (const vt of visualTags) {
    for (const t of assetTags) {
      if (t === vt || t.includes(vt) || vt.includes(t)) hits++;
    }
  }
  return hits;
}

/**
 * ONE ROUTE — the archive asset's metadata refusals, all in production. What used to follow (topic,
 * geography, country, literal words, semantic tier, minimum score) sat behind
 * ENABLE_METADATA_VISUAL_BLOCKS, which production never set: it never ran, and is gone. Whether the
 * picture fits the sentence is the picture judgement at the push.
 */
function archiveAssetMinimumRefusal(
  asset: Pick<MediaArchiveAsset, "tags">,
  score: number
): string | null {
  const material = judgeArchiveAssetMaterial(asset);
  if (material.decision === "REJECT") return material.reason;
  return judgeArchiveAssetScore(score).decision === "REJECT" ? "negative_match_score" : null;
}

/** Modern talking-head / historian interview clips — poor B-roll for documentaries. */
export function isCuratedInterviewAsset(asset: Pick<MediaArchiveAsset, "title" | "tags">): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  return /\b(interview|historicus|bespreekt|talking head|woonkamer|bibliotheek|oudere man|man geeft|gesprek met)\b/i.test(
    hay
  );
}

/** Archival parade footage, speeches, period video — not generic stills. */
export function isCuratedHistoricalFootage(asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">): boolean {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  if (asset.mediaType === "video") {
    return /\b(parade|militair|zwart-wit|archief|1930|1934|1939|1945|hitler|nazi|berlijn|troepen|soldaten|propaganda|rally|march|speech|toespraak|crowd|war|oorlog|wehrmacht|ss|bijeenkomst|sporting|balkon)\b/i.test(
      hay
    );
  }
  if (asset.mediaType === "image") {
    return /\b(propaganda poster|poster|portret|propaganda|archief|foto)\b/i.test(hay);
  }
  return false;
}

// ─── Public API: metadata ────────────────────────────────────────────────────────────────────────

export type ArchiveAssetJudgeInput = {
  asset: Pick<MediaArchiveAsset, "title" | "tags" | "mediaType" | "mixKind">;
  /** What the matcher measured. Read here, never produced here. */
  score: number;
};

/** An own-archive asset, judged on its tags and title before anything is prepared. */
/**
 * Is this archive asset documentary material at all, by its tags (no cartoon, gameplay, emoji…)?
 * Always on. The archive matcher asks it before scoring, so the same rule refuses in one place.
 */
export function judgeArchiveAssetMaterial(asset: Pick<MediaArchiveAsset, "tags">): VisualJudgeVerdict {
  const hay = normalizeMediaTags(asset.tags ?? []).join(" ");
  return isNonDocumentaryVisualHay(hay) ? reject("metadata", "non_documentary_tags") : accept("metadata");
}

/**
 * RONDE 9 — a negative match score is the matcher's measured evidence of a mismatch (a sentence about
 * cycling and an asset without one, a named place the asset is not). The matcher measures it; the
 * refusal is this judge's, so the archive has one content owner.
 */
export function judgeArchiveAssetScore(score: number): VisualJudgeVerdict {
  return score < 0 ? reject("metadata", "negative_match_score") : accept("metadata");
}

export function judgeArchiveAsset(input: ArchiveAssetJudgeInput): VisualJudgeVerdict {
  const refusal = archiveAssetMinimumRefusal(input.asset, input.score);
  return refusal ? reject("metadata", refusal) : accept("metadata");
}

/**
 * RONDE 174 — the same verdict, plus whether the gate had a rule that could apply at all.
 *
 * This gate is a set of blocklists about particular subjects: non-documentary filename patterns,
 * off-topic geo-urban visuals (pharmacies, retail, Columbus/Ohio/Wisconsin), and a Dutch/US region
 * lock. On a WWII documentary not one of them can match — so "asked 20 times, rejected nothing"
 * is the gate being out of scope, not the gate being broken.
 *
 * Without that distinction the silent-gate detector reports it as a suspected defect on every
 * render of every topic outside its scope, which is how a real alarm gets trained away. `armed`
 * says whether any rule was live for this candidate; the boolean verdict is unchanged.
 */
export function judgeDocumentaryBeatGate(
  clipPath: string,
  sourceQuery = "",
  beatText = "",
  videoTitle?: string
): { passes: boolean; armed: boolean } {
  if (!vidrushDocumentaryQualityEnabled()) return { passes: true, armed: false };
  if (isNonDocumentaryClipPath(clipPath, sourceQuery, beatText)) return { passes: false, armed: true };
  const hay = `${sourceQuery} ${path.basename(clipPath)} ${beatText} ${asVideoTitleString(videoTitle)}`.toLowerCase();
  const geoUrban = isOffTopicGeoUrbanVisual(hay);
  if (geoUrban && !offTopicVisualAllowedForBeat(hay, beatText)) return { passes: false, armed: true };
  const lockRegion = resolveBeatRegionLock(beatText, videoTitle);
  const regionLocked = lockRegion !== "neutral" && lockRegion !== "both";
  if (regionLocked && isWrongRegionForSegmentLock(hay, lockRegion)) {
    return { passes: false, armed: true };
  }
  // Nothing this gate knows about was present: no non-documentary pattern, no geo-urban visual and
  // no region to be on the wrong side of. It passed the candidate because it had nothing to say.
  return { passes: true, armed: geoUrban || regionLocked };
}

export type CandidateJudgeInput = {
  /** The downloaded candidate. */
  path: string;
  /** The query that found it — evidence of what was ASKED for, never of what it shows. */
  sourceQuery: string;
  beatText: string;
  videoTitle?: string;
  /** Independently-authored evidence: archive annotation, provider title/description/tags. */
  meta?: CandidateMeta;
  personTopic?: boolean;
  primaryPerson?: string;
  /**
   * The script-image route: a generic image search for the sentence's own words. It skips the
   * strict anchoring rules (it is anchored by construction) and nothing else.
   */
  scriptImageFallback?: boolean;
  requireBeatMatch: boolean;
  scriptAnchored: boolean;
  /** The named things this sentence mentions (see `namedEntityRules`). */
  entityRules: RealEntityRule[];
  /** Ranking signals the caller measured. Read here, never produced here. */
  signals: {
    /** Narration-to-candidate token overlap. */
    beatMatch: number;
    /** The query's own words appear in the sentence. */
    queryInBeat: boolean;
    /** The provider gave a title and it shares nothing with the sentence, query or title. */
    providerTitleSharesNothing: boolean;
  };
  /** `s{scene}b{beat}`, for the log line. */
  where: string;
  /** The content key's family (provider name for provider-tagged assets), for the log line. */
  provider?: string;
};

/**
 * A downloaded candidate, judged on what is written about it — before anyone pays to look at its
 * frames. The rules and their order are the ones `adoptClip` applied inline; each refusal now
 * names itself (the person-topic rule used to drop a candidate without a word).
 */
export function judgeCandidateMetadata(input: CandidateJudgeInput): VisualJudgeVerdict {
  const { path: p, sourceQuery, beatText } = input;
  if (isAIGeneratedClip(p)) return reject("metadata", "ai_generated");
  if (isRejectedStockClip(p, sourceQuery)) return reject("metadata", "rejected_stock");
  if (!input.scriptImageFallback && input.personTopic && input.primaryPerson) {
    if (isOffTopicVisualForPersonTopic(sourceQuery, p, input.primaryPerson, input.meta?.providerText?.title)) {
      return reject("metadata", "person_topic_off_topic_visual");
    }
    /**
     * VIDEO 636 — commercial stock only. An Internet Archive or Wikimedia film is historical
     * footage, not "a businessman walking": 39 of them (24 distinct) were refused here unseen for
     * a Tesla film because "Musk" was not in their file name. They now go to the picture editor,
     * which judges them against the sentence like every other picture. A sentence that names a
     * person still asks for evidence of that person (`entity_evidence` below).
     */
    if (isStockVideoClip(p) && !isOpenArchiveVideoClip(p)) {
      const hay = `${sourceQuery} ${path.basename(p)}`.toLowerCase();
      const personHit = textMentionsPersonName(hay, input.primaryPerson);
      const celebCue = /\b(interview|red carpet|talk show|celebrity|paparazzi)\b/.test(hay);
      if (!personHit && !celebCue) return reject("metadata", "stock_without_person");
    }
  }
  const category = stockVisualCategory(sourceQuery, p);
  if (categoryIsBlockedContent(category)) return reject("metadata", `blocked_category:${category}`);
  // Applies to every route, the script-image route included: it was once exempt, which let an
  // unrelated image-search hit reach adoption with no topical scrutiny at all.
  const docGate = judgeDocumentaryBeatGate(p, sourceQuery, beatText, input.videoTitle);
  // RONDE 174: `armed` separates "this gate had nothing to say" from "this gate is broken".
  recordGateVerdict("documentary_beat_gate", !docGate.passes, { armed: docGate.armed });
  if (!docGate.passes) return reject("metadata", "documentary_beat_gate");
  // VIDEO 623 — gated on the PEOPLE a sentence names. Only counted when there are any: a sentence
  // that names nobody was never asked, and counting it would bury a broken gate in noise.
  const personRules = input.entityRules.filter((r) => r.kind === "person");
  if (personRules.length > 0) {
    const failsEntityEvidence = !clipSatisfiesRealEntities(personRules, input.meta);
    recordGateVerdict("entity_evidence", failsEntityEvidence);
    if (failsEntityEvidence) return reject("metadata", "entity_evidence");
  }
  /**
   * RONDE 114 — a provider TITLE that shares nothing with the sentence is flagged, not refused.
   * Real archive titles do that constantly ("Bundesarchiv Bild 183-S33882"); only the picture
   * model may take material away on that basis. Recorded so how often it WOULD have fired stays
   * measurable.
   */
  const providerTitle = input.meta?.providerText?.title;
  if (providerTitle) recordGateVerdict("off_topic_visual", input.signals.providerTitleSharesNothing);
  if (input.signals.providerTitleSharesNothing) {
    console.log(
      `[VisualJudge] ${input.where}: provider title shares nothing with the sentence for ` +
        `"${path.basename(p)}" — flagged, not rejected; the picture decides ` +
        `(provider=${input.provider || "unknown"} query="${sourceQuery.slice(0, 60)}" ` +
        `title="${(providerTitle ?? "").slice(0, 60)}")`
    );
  }
  if (!input.scriptImageFallback) {
    const { beatMatch, queryInBeat } = input.signals;
    if (input.requireBeatMatch && beatMatch < 1 && !queryInBeat) return reject("metadata", "no_beat_match");
    if (input.scriptAnchored && beatMatch < 1 && !queryInBeat && input.entityRules.length === 0) {
      return reject("metadata", "not_script_anchored");
    }
    if (input.personTopic && input.primaryPerson) {
      const parts = input.primaryPerson.toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
      const hay = `${sourceQuery} ${path.basename(p)}`.toLowerCase();
      const personHit = parts.some((pt) => hay.includes(pt));
      const eventHit = /\b(interview|celebrity|red carpet|keynote|conference|launch)\b/.test(hay);
      if (!personHit && !eventHit && beatMatch < 1) return reject("metadata", "person_not_named");
    }
  }
  return accept("metadata");
}

// ─── Public API: someone else's text on screen ───────────────────────────────────────────────────

/**
 * Someone else's subtitle, title bar or logo never enters the film, and never enters the archive.
 * One question, three ways of paying for it, one answer shape:
 *
 *   memoKey + budget   a render asking about a candidate: memoised, counted against the render's
 *                      ceiling (past it the clip is allowed, unchecked — an exhausted budget must
 *                      not become "refuse everything").
 *   memoKey only       the archive's own door (ingestion, shot pieces): memoised, never on a
 *                      render's budget.
 *   neither            preparing one archive asset whose row has no stored answer yet.
 */
export async function judgeOnScreenText(input: {
  path: string;
  mimeType: string;
  memoKey?: string;
  budget?: number;
}): Promise<VisualJudgeVerdict & { notAskedReason?: string; textKind?: OverlayTextKind }> {
  const result =
    input.memoKey && input.budget !== undefined
      ? await cachedClipBakedEditTextVerdict(input.path, input.mimeType, input.memoKey, input.budget)
      : input.memoKey
        ? await archiveClipTextVerdict(input.path, input.mimeType, input.memoKey)
        : await archiveClipBakedEditTextVerdict(input.path, input.mimeType);
  if (result.verdict === "has_text") {
    return {
      ...reject("on_screen_text", result.reason ?? "baked_edit_text", 0.9),
      evaluated: true,
      ...(result.textKind ? { textKind: result.textKind } : {}),
    };
  }
  if (result.verdict === "not_asked") {
    return {
      ...accept("on_screen_text", "not_asked", 0),
      evaluated: false,
      notAskedReason: result.reason ?? "no reason recorded",
    };
  }
  return { ...accept("on_screen_text", "clean", 0.9), evaluated: true };
}

/**
 * P0 (VIDEO 630) — TEXT ON SCREEN IS NOT THE SAME AS AN UNUSABLE PICTURE.
 *
 * Render 630 refused twelve of twelve YouTube stock shots on `has_text` before the picture editor
 * saw one, and put 0 seconds of YouTube in the film. Before the picture editor, only text that IS
 * the picture — a title card, a leader, a screenshot of a page (`fills_picture`) — is refused.
 * A logo, a watermark or a subtitle over real footage (`overlay`), and a `has_text` whose kind the
 * detector did not say, go on to the same picture editor and the same push checks as every other
 * clip; nothing here approves anything.
 */
export function onScreenTextRefusesBeforeVision(
  text: Pick<VisualJudgeVerdict, "decision"> & { textKind?: OverlayTextKind } | null | undefined
): boolean {
  return text?.decision === "REJECT" && text.textKind === "fills_picture";
}

/**
 * A stock search RESULT, judged on what the provider wrote about it (Pexels' slug, Pixabay's tags)
 * before it is downloaded: a cartoon, a render, a miniature is never a documentary shot.
 */
export function judgeStockResult(result: { slug?: string; tags?: string }): VisualJudgeVerdict {
  if (result.slug && BLOCKED_STOCK_VISUAL_RE.test(result.slug.toLowerCase())) return reject("metadata", "rejected_stock");
  if (result.tags && hasBlockedStockTags(result.tags)) return reject("metadata", "rejected_stock_tags");
  return accept("metadata");
}

// ─── Public API: the picture ─────────────────────────────────────────────────────────────────────

/**
 * The one look at the pixels. One model (`judgeBeatImage`), asked through the relevance ledger
 * (`checkBeatRelevance`), which records the answer under the clip, its asset identity and the
 * sentence — so every later reader reads THIS answer instead of asking again.
 *
 * `allowed` stays the ledger's own word: false only on a definite `does_not_fit` that was not
 * reprieved. `unknown` and "nobody looked" are ACCEPT with low confidence and `evaluated=false`
 * where nothing looked — never a fit, and never a refusal.
 */
export async function judgePicture(
  params: BeatRelevanceParams
): Promise<{ decision: BeatRelevanceDecision; verdict: VisualJudgeVerdict }> {
  const decision = await checkBeatRelevance(params);
  const evaluated = decision.evaluated !== false;
  const verdict: VisualJudgeVerdict = !decision.allowed
    ? { ...reject("picture", decision.reason || "does_not_fit", 0.9), evaluated }
    : decision.verdict === "fits"
      ? { ...accept("picture", decision.reason || "fits", 0.9), evaluated }
      : { ...accept("picture", decision.reason || decision.verdict, evaluated ? 0.5 : 0), evaluated };
  return { decision, verdict };
}

/**
 * At the push — the last moment before a picture becomes part of a scene — the one answer the
 * ledger holds about it is read ONCE, by two rules that used to be two separate readers:
 *
 *   the barrier    a `does_not_fit` nobody reprieved is turned away;
 *   the route      a route that claims real footage must show the verdict it claims (RONDE 94/199),
 *                  suspended only when no look was possible (RONDE 215).
 *
 * Pure: the caller has already asked for the look and passes what it learned.
 */
export function judgeAtPush(input: {
  barrier: Parameters<typeof composeBarrierAllows>;
  route: Parameters<typeof adoptionGuardVerdict>[0] | null;
}): VisualJudgeVerdict & { by: "barrier" | "route" | null; code?: string } {
  const barrier = composeBarrierAllows(...input.barrier);
  if (!barrier.allow) return { ...reject("picture", barrier.reason), by: "barrier" };
  if (input.route) {
    const guard = adoptionGuardVerdict(input.route);
    if (!guard.allowed) return { ...reject("picture", guard.reason, 1), by: "route", code: guard.code };
    return { ...accept("picture"), by: "route" };
  }
  return { ...accept("picture"), by: null };
}

export { visionVerdictFromGate };

/**
 * The relevance ledger's own entry points, owned here: asking for the look before a picture is
 * composed, the one sanctioned overrule (a reprieve), and the readers of the answer it holds.
 */
export {
  beatAlreadyRefusedPicture,
  ensureVerdictBeforeCompose,
  nothingToJudgeAgainst,
  relevanceVerdictForRenderedAsset,
  reprieveBeatClip,
} from "./beatVisualRelevance";
/**
 * RONDE 649 — A YOUTUBE RESULT WHOSE TITLE SAYS IT IS NOT FOOTAGE IS NOT DOWNLOADED.
 *
 * Render 606 searched YouTube for its lines about Hitler's fate and downloaded, among others:
 *
 *     "Hitler Reacts to The Last Guardian Being 'Cancelled'"
 *     "Hitler is informed Jane Withers has died"
 *     "Last Days of Hitler, 7th Edition Audiobook by Hugh Trevor-Roper"
 *
 * A parody with subtitles, a meme, an audiobook with a still cover. Each cost a download slot, a
 * text check and a refusal (BAKED_EDIT_TEXT) — and none of them could ever have been a shot. The
 * title said so before a byte moved.
 *
 * The words below name a GENRE of video that is never archive footage, whatever its subject. None
 * of them is about a topic, so the list does not grow with the films FastVid makes. A word that
 * could title a real documentary ("finds out", "explained", "story") is deliberately not here: the
 * picture editor judges those, as before.
 */

export const NOT_FOOTAGE: ReadonlyArray<[RegExp, string]> = [
  [/\bparod(y|ies)\b/i, "parody"],
  [/\breacts?\b|\breaction\b/i, "reaction"],
  [/\baudio ?books?\b/i, "audiobook"],
  [/\bmemes?\b/i, "meme"],
  [/\bpodcasts?\b/i, "podcast"],
  [/\bgameplay\b|\bwalkthrough\b|\blet'?s play\b/i, "gameplay"],
  [/\blyrics?\b/i, "lyrics"],
  [/\bytp\b|\byoutube poop\b/i, "youtube poop"],
  /** The Downfall-parody format: "<name> is informed …" / "<name> gets informed …". */
  [/\b(is|gets) informed\b/i, "parody"],
];

/** The genre a title announces when it is not footage, or null when it may be. */
export function youtubeTitleIsNotFootage(title: string | null | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  for (const [re, genre] of NOT_FOOTAGE) if (re.test(t)) return genre;
  return null;
}

// ─── Public API: a YouTube result, before it is downloaded ───────────────────────────────────────

/** A parody, a reaction video, an audiobook is never a shot — read off the result's own title. */
export function judgeFootageTitle(title: string | null | undefined): VisualJudgeVerdict {
  const genre = youtubeTitleIsNotFootage(title);
  return genre ? reject("metadata", `title genre ${genre}`) : accept("metadata");
}

/**
 * What the thumbnail look (`triageYoutubeThumbnail`, the result's annotator) says the video IS.
 * Only real or archival footage is worth a transfer; the frames are still judged after download.
 */
export function judgeFootageType(footageType: string): VisualJudgeVerdict {
  return footageType === "real_footage" || footageType === "archival_footage"
    ? accept("metadata", footageType)
    : reject("metadata", `footage type ${footageType}`);
}

/**
 * RONDE 22: an asset already judged to have baked-in edit text (burnt-on subtitles, channel
 * bumpers, hard-coded captions) can never be adopted — adoptCuratedArchiveAsset throws on it.
 *
 * That verdict is cached on the row, but it was only ever read at adoption time, i.e. AFTER the
 * selector had already picked the asset and materialized it to disk. So the selector kept
 * re-choosing assets it already knew were dead: render 526/527 logged 255 "has baked edit text —
 * skipped" failures across just 10 distinct assets, each one paying a download/cache-restore
 * first. With a small archive that is severe — 10 of 17 assets were flagged, so roughly six in
 * ten picks were guaranteed to fail before the beat could reach a usable clip.
 *
 * Treating it as a selection-time filter (like the off-topic/geo/non-documentary checks beside it)
 * points the selector at the assets that can actually be used. Only `=== 1` is filtered: null
 * means "not checked yet" and must still flow through to the adoption-time check that fills it in.
 */
export function hasKnownBakedEditText(asset: Pick<MediaArchiveAsset, "hasBakedEditText">): boolean {
  return asset.hasBakedEditText === 1;
}
