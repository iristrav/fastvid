import type { MediaForm } from "./beatVisualIntent";

/**
 * WHAT EACH SOURCE CAN ACTUALLY DO — in one place, as data.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────
 *
 * The audit asked a simple question of every provider: can it supply historical video, photos,
 * maps, documents, news; how good is its metadata, its date evidence, its rights evidence, its
 * search, its download. The answer for most of them was that NOTHING IN THE CODEBASE SAYS. The
 * knowledge existed only in the shape of the fetchers and in the heads of the people who wrote
 * them, so retrieval could not use it: `videoPipeline` queues fourteen provider tasks in
 * source-code order and slices the first `maxTasks` of them, identically for every beat of every
 * topic. A beat about the Japanese economy and a beat about a bunker in 1945 ask the same
 * fourteen sources in the same order.
 *
 * The ranking engine has a `DEFAULT_SOURCE_PRIORITY` table, and its own comment admits the
 * problem: "Known only here; no other component (retrieval, CLIP) is aware sources are
 * prioritized at all."
 *
 * ── What this file is NOT ───────────────────────────────────────────────────────────────────
 *
 * It is not a second source-selection engine and it decides nothing on its own. It is a lookup
 * table. Routing reads it, ranking reads it, and both keep their existing logic — same fetchers,
 * same gates, same shortlist, same vision, same adoption.
 *
 * ── The honesty rule ────────────────────────────────────────────────────────────────────────
 *
 * `UNKNOWN` means the codebase does not establish the answer. It does NOT mean "no" and it does
 * NOT mean "yes". A router must therefore treat UNKNOWN as "do not use this as a reason to
 * prefer or to skip", never as a refusal — a source that has never been characterised is not
 * thereby a bad source.
 *
 * Every non-UNKNOWN grade carries `evidence`: the thing in the repository that establishes it.
 * A grade without evidence is a guess, and a table of guesses is worse than no table, because a
 * router would act on it.
 */

export type CapabilityGrade = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

/**
 * What kind of institution stands behind the material.
 *
 * Deliberately about the SOURCE, not about the quality: a national archive and a stock library
 * are different kinds of thing even on a day when the stock library has the better clip.
 */
export type SourceClass =
  | "OWN_ARCHIVE"
  | "INSTITUTIONAL_ARCHIVE"
  | "OPEN_ARCHIVE"
  | "ENCYCLOPEDIC"
  | "STOCK"
  | "NEWS"
  | "PLATFORM"
  | "GENERATED";

export type ProviderCapability = {
  provider: string;
  sourceClass: SourceClass;
  /**
   * The media forms this source can actually supply. Empty is never correct — a source that can
   * supply nothing has no reason to be in the ladder — so an empty list is a bug, and a test says so.
   */
  mediaForms: readonly MediaForm[];
  historical: CapabilityGrade;
  modern: CapabilityGrade;
  people: CapabilityGrade;
  events: CapabilityGrade;
  locations: CapabilityGrade;
  objects: CapabilityGrade;
  documents: CapabilityGrade;
  maps: CapabilityGrade;
  news: CapabilityGrade;
  metadataQuality: CapabilityGrade;
  dateEvidence: CapabilityGrade;
  placeEvidence: CapabilityGrade;
  rightsEvidence: CapabilityGrade;
  searchQuality: CapabilityGrade;
  downloadCapability: CapabilityGrade;
  /** What in this repository establishes the non-UNKNOWN grades above. */
  evidence: string;
};

/** Everything unknown, so an entry states only what it can prove and inherits the rest. */
const UNCHARACTERISED = {
  historical: "UNKNOWN",
  modern: "UNKNOWN",
  people: "UNKNOWN",
  events: "UNKNOWN",
  locations: "UNKNOWN",
  objects: "UNKNOWN",
  documents: "UNKNOWN",
  maps: "UNKNOWN",
  news: "UNKNOWN",
  metadataQuality: "UNKNOWN",
  dateEvidence: "UNKNOWN",
  placeEvidence: "UNKNOWN",
  rightsEvidence: "UNKNOWN",
  searchQuality: "UNKNOWN",
  downloadCapability: "UNKNOWN",
} as const;

/**
 * The registry.
 *
 * Keys are the provider labels the rest of the pipeline already uses — the same strings
 * `adoptionPolicy` declares and `lineage.providerFor` returns — so no translation layer is needed
 * and a typo shows up as a missing entry rather than as a silently different provider.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapability>> = {
  own_archive: {
    ...UNCHARACTERISED,
    provider: "own_archive",
    sourceClass: "OWN_ARCHIVE",
    mediaForms: ["ARCHIVAL_FOOTAGE", "PERSON", "LOCATION", "OBJECT", "B_ROLL"],
    historical: "GREEN",
    modern: "RED",
    people: "GREEN",
    events: "GREEN",
    locations: "GREEN",
    metadataQuality: "GREEN",
    dateEvidence: "GREEN",
    placeEvidence: "GREEN",
    rightsEvidence: "GREEN",
    searchQuality: "GREEN",
    downloadCapability: "GREEN",
    evidence:
      "curated archive with its own embeddings, geo-tagging and vision-tagging " +
      "(archiveClipEmbedding, archiveGeoTagging, archiveBulkVisionTagging); modern=RED because the " +
      "collection is a single historical subject",
  },
  internet_archive: {
    ...UNCHARACTERISED,
    provider: "internet_archive",
    sourceClass: "OPEN_ARCHIVE",
    mediaForms: ["ARCHIVAL_FOOTAGE", "REAL_FOOTAGE", "PERSON", "LOCATION", "OBJECT", "B_ROLL"],
    historical: "GREEN",
    modern: "YELLOW",
    metadataQuality: "YELLOW",
    rightsEvidence: "YELLOW",
    searchQuality: "YELLOW",
    downloadCapability: "YELLOW",
    evidence:
      "fetchInternetArchiveClips plus the segment route fetchArchiveSegmentViaFfmpeg; " +
      "downloadCapability=YELLOW because full-length items need the segment route and that route " +
      "takes a fixed window (videoPipeline.ts, -ss 90)",
  },
  wikimedia: {
    ...UNCHARACTERISED,
    provider: "wikimedia",
    sourceClass: "ENCYCLOPEDIC",
    mediaForms: ["PHOTO", "PERSON", "LOCATION", "OBJECT", "MAP", "ARCHIVAL_FOOTAGE"],
    historical: "YELLOW",
    modern: "YELLOW",
    people: "GREEN",
    locations: "GREEN",
    objects: "GREEN",
    metadataQuality: "GREEN",
    rightsEvidence: "GREEN",
    searchQuality: "YELLOW",
    downloadCapability: "GREEN",
    evidence:
      "fetchWikimediaImages / fetchWikimediaVideos / fetchWikimediaImageInfoBatch; rights and " +
      "metadata GREEN because imageinfo returns a licence and an author per file",
  },
  europeana: {
    ...UNCHARACTERISED,
    provider: "europeana",
    sourceClass: "INSTITUTIONAL_ARCHIVE",
    mediaForms: ["ARCHIVAL_FOOTAGE", "PHOTO", "B_ROLL"],
    historical: "GREEN",
    modern: "RED",
    evidence: "fetchEuropeanaVideos; a European cultural-heritage aggregator, so modern=RED",
  },
  nara: {
    ...UNCHARACTERISED,
    provider: "nara",
    sourceClass: "INSTITUTIONAL_ARCHIVE",
    mediaForms: ["ARCHIVAL_FOOTAGE", "PHOTO", "DOCUMENT", "B_ROLL"],
    historical: "GREEN",
    modern: "RED",
    evidence: "fetchNaraClips; a national archive, so modern=RED",
  },
  nasa: {
    ...UNCHARACTERISED,
    provider: "nasa",
    sourceClass: "INSTITUTIONAL_ARCHIVE",
    mediaForms: ["REAL_FOOTAGE", "ARCHIVAL_FOOTAGE", "PHOTO", "OBJECT", "B_ROLL"],
    historical: "YELLOW",
    modern: "GREEN",
    rightsEvidence: "GREEN",
    searchQuality: "YELLOW",
    evidence:
      "fetchNasaVideoClips against images-api.nasa.gov; rights GREEN because NASA media is " +
      "released for reuse by the agency's own policy",
  },
  gdelt: {
    ...UNCHARACTERISED,
    provider: "gdelt",
    sourceClass: "NEWS",
    mediaForms: ["NEWS", "REAL_FOOTAGE"],
    historical: "RED",
    modern: "GREEN",
    news: "GREEN",
    evidence: "fetchGdeltTvNewsClips; a television-news index, and the only news source in the ladder",
  },
  sepiasearch: {
    ...UNCHARACTERISED,
    provider: "sepiasearch",
    sourceClass: "PLATFORM",
    mediaForms: ["REAL_FOOTAGE", "B_ROLL"],
    modern: "YELLOW",
    evidence: "fetchSepiaSearchVideos; a PeerTube federation index",
  },
  mediaccc: {
    ...UNCHARACTERISED,
    provider: "mediaccc",
    sourceClass: "PLATFORM",
    mediaForms: ["REAL_FOOTAGE", "INTERVIEW"],
    modern: "YELLOW",
    rightsEvidence: "GREEN",
    evidence: "fetchMediaCccVideos; conference recordings published under stated free licences",
  },
  flickr: {
    ...UNCHARACTERISED,
    provider: "flickr",
    sourceClass: "PLATFORM",
    mediaForms: ["PHOTO", "REAL_FOOTAGE", "LOCATION", "OBJECT"],
    rightsEvidence: "YELLOW",
    evidence: "fetchFlickrCCVideos; the CC filter is the platform's own assertion",
  },
  openverse: {
    ...UNCHARACTERISED,
    provider: "openverse",
    sourceClass: "ENCYCLOPEDIC",
    mediaForms: ["PHOTO", "OBJECT", "LOCATION"],
    historical: "RED",
    modern: "RED",
    rightsEvidence: "GREEN",
    searchQuality: "YELLOW",
    downloadCapability: "GREEN",
    evidence:
      "fetchOpenverseImages requests license_type=commercial,modification, so the rights question " +
      "is asked at retrieval; historical/modern RED because it indexes images, not footage",
  },
  pexels: {
    ...UNCHARACTERISED,
    provider: "pexels",
    sourceClass: "STOCK",
    mediaForms: ["REAL_FOOTAGE", "PHOTO", "B_ROLL", "PROCESS"],
    historical: "RED",
    modern: "GREEN",
    news: "RED",
    documents: "RED",
    maps: "RED",
    metadataQuality: "YELLOW",
    rightsEvidence: "GREEN",
    searchQuality: "GREEN",
    downloadCapability: "GREEN",
    evidence:
      "fetchPexelsClips; a licensed stock library — historical=RED because stock footage is shot " +
      "now, which is exactly why render 577's archival beats should not have been filled from it",
  },
  pixabay: {
    ...UNCHARACTERISED,
    provider: "pixabay",
    sourceClass: "STOCK",
    mediaForms: ["REAL_FOOTAGE", "PHOTO", "B_ROLL", "PROCESS"],
    historical: "RED",
    modern: "GREEN",
    news: "RED",
    documents: "RED",
    maps: "RED",
    metadataQuality: "YELLOW",
    rightsEvidence: "GREEN",
    searchQuality: "GREEN",
    downloadCapability: "GREEN",
    evidence: "fetchPixabayClips; same class as pexels",
  },
  youtube_cc: {
    ...UNCHARACTERISED,
    provider: "youtube_cc",
    sourceClass: "PLATFORM",
    mediaForms: [
      "ARCHIVAL_FOOTAGE",
      "REAL_FOOTAGE",
      "NEWS",
      "PERSON",
      "LOCATION",
      "PROCESS",
      "INTERVIEW",
      "B_ROLL",
    ],
    historical: "GREEN",
    modern: "GREEN",
    news: "GREEN",
    people: "GREEN",
    documents: "RED",
    maps: "RED",
    metadataQuality: "YELLOW",
    rightsEvidence: "YELLOW",
    searchQuality: "GREEN",
    downloadCapability: "UNKNOWN",
    evidence:
      "Data API search plus the project's own download service; metadata=YELLOW because channel " +
      "and publishedAt are captured and never read (youtubePoolSource.ts); rights=YELLOW because " +
      "the licence is recorded but nothing downstream reads it; download=UNKNOWN because the JS " +
      "runtime repair in 59f6996 is not production-proven",
  },
  ai_generated: {
    ...UNCHARACTERISED,
    provider: "ai_generated",
    sourceClass: "GENERATED",
    mediaForms: ["GRAPHIC", "B_ROLL"],
    historical: "RED",
    modern: "RED",
    news: "RED",
    dateEvidence: "RED",
    placeEvidence: "RED",
    evidence:
      "model-generated imagery: real pixels, no provenance in the world, which is why date and " +
      "place evidence are RED rather than UNKNOWN",
  },
};

/** The capability for a provider label, or null when the registry has never heard of it. */
export function providerCapability(provider: string | null | undefined): ProviderCapability | null {
  const key = (provider ?? "").trim().toLowerCase();
  return PROVIDER_CAPABILITIES[key] ?? null;
}

/**
 * DOES THIS SOURCE SUPPLY THIS KIND OF PICTURE?
 *
 * `null` — not "no" — when the registry cannot say, so a caller has to decide what to do with a
 * source nobody has characterised instead of being handed a false.
 */
export function providerSuppliesForm(
  provider: string | null | undefined,
  form: MediaForm
): boolean | null {
  const cap = providerCapability(provider);
  if (!cap) return null;
  return cap.mediaForms.includes(form);
}

/**
 * HOW WELL THIS SOURCE ANSWERS THIS NEED — 0..1, or null when the registry cannot say.
 *
 * Deliberately a small, monotone score rather than a decision:
 *
 *   · every PREFERRED form the source supplies is worth a full point
 *   · every ACCEPTABLE form is worth a third of one
 *   · the total is divided by what a perfect source would score, so the result is comparable
 *     between beats with different numbers of preferred forms
 *
 * A source that supplies none of the forms scores 0 and is still usable: 0 is a weak match, not a
 * refusal. Nothing in this module may refuse a candidate — eligibility, the shortlist bound and
 * the vision verdict keep their own jobs, and a scorer that could also reject would be a second
 * selection engine.
 */
export function providerFitForNeed(
  provider: string | null | undefined,
  need: { preferred: readonly MediaForm[]; acceptable: readonly MediaForm[] }
): number | null {
  const cap = providerCapability(provider);
  if (!cap) return null;
  /** A beat with no opinion cannot rank sources; say so rather than returning a flat zero. */
  if (need.preferred.length === 0) return null;

  const supplies = (form: MediaForm): boolean => cap.mediaForms.includes(form);
  let score = 0;
  for (const form of need.preferred) if (supplies(form)) score += 1;
  for (const form of need.acceptable) {
    if (need.preferred.includes(form)) continue;
    if (supplies(form)) score += 1 / 3;
  }
  const best = need.preferred.length + (need.acceptable.length - need.preferred.length) / 3;
  return best > 0 ? Math.min(1, score / best) : null;
}

/**
 * THE RETRIEVAL ROUND, ORDERED BY WHAT THE BEAT NEEDS.
 *
 * A STABLE sort, which is the whole design. Ties keep their original order, and so does every
 * task whose provider the registry cannot score — an unlabelled or uncharacterised source is not
 * demoted for being unknown, it simply keeps the place the author gave it.
 *
 * ── Why ordering and not filtering ──────────────────────────────────────────────────────────
 *
 * The caller slices the first `maxTasks` of this list. Dropping a source outright would mean this
 * function could silently remove the only route that would have found the shot, on the strength
 * of a registry entry somebody typed. Reordering cannot do that: every task is still in the list,
 * and the same budget still decides how many run. The worst this can do is ask a good source
 * later than it might have.
 *
 * ── The null rule, stated once more because it is the whole safety argument ──────────────────
 *
 * `providerFitForNeed` returns null for (a) a task with no provider label, (b) a provider the
 * registry has never characterised, and (c) a beat that proved nothing. In all three cases this
 * returns the input order unchanged. There is no path by which missing information reorders a
 * round.
 */
export function orderResearchTasksByNeed<T extends { provider?: string }>(
  tasks: readonly T[],
  need: { preferred: readonly MediaForm[]; acceptable: readonly MediaForm[] }
): T[] {
  if (need.preferred.length === 0) return [...tasks];
  const scored = tasks.map((task, index) => ({
    task,
    index,
    fit: providerFitForNeed(task.provider, need),
  }));
  /** Unscored tasks sort as if they were average, so they are neither promoted nor buried. */
  const NEUTRAL = 0.5;
  return scored
    .sort((a, b) => (b.fit ?? NEUTRAL) - (a.fit ?? NEUTRAL) || a.index - b.index)
    .map((s) => s.task);
}
