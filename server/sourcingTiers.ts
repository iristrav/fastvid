/**
 * THE SOURCING LADDER, WRITTEN DOWN ONCE.
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────
 *
 * The order FastVid tries its sources in — YouTube, then its own archive, then the open sources,
 * then licensed stock — is real policy, and until now it existed only as the SHAPE of about thirty
 * beat-resolution functions. `resolveBeatClipFast`, `resolveBeatClipTurbo`, `fetchBeatClipFromScript`,
 * `researchBeatClipUnified`, `fetchLastResortRealClip`, `fetchBeatStockFallback` and the rest each
 * call providers in an order they decide for themselves, across 94 direct call sites.
 *
 * Thirty functions each holding a copy of a policy is thirty chances for one of them to hold a
 * different copy, and no way to read the policy without reading all thirty. This module is the
 * policy itself: one table, one vocabulary, and a place for the checks that keep the copies honest.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────────────────────
 *
 * Not an orchestrator, not a router, not a second sourcing engine. It calls no provider, starts no
 * search and changes no route. Collapsing those thirty strategies into one caller is a separate
 * piece of work — a larger one than the YouTube consolidation was — and doing half of it would
 * leave the pipeline with two orderings instead of one. What this gives that work is the thing it
 * needs first: a written-down answer to "which tier is this provider, and which tier comes next".
 *
 * ── Tiers, and why these four ───────────────────────────────────────────────────────────────
 *
 *   1  YOUTUBE       the widest corpus of real footage, and the only tier with its own reserved
 *                    budget and a one-turn-per-beat rule (RONDE 260/260B)
 *   2  OWN_ARCHIVE   material FastVid holds itself: no rights question, no network, no quota
 *   3  OPEN_SOURCES  public and openly-licensed collections — archives, museums, institutions
 *   4  STOCK         licensed stock libraries, which answer almost any query with something
 *                    plausible and are therefore the last place to look rather than the first
 *
 * The ordering is not about quality — a Pexels clip can be beautiful. It is about SPECIFICITY.
 * Tier 4 will always return something for "courthouse exterior"; that is exactly why it must not
 * be asked before the tiers that would have returned THAT courthouse.
 */

/** The ladder, best-specificity first. Index in this array IS the tier number, one-based. */
export const SOURCING_TIERS = ["YOUTUBE", "OWN_ARCHIVE", "OPEN_SOURCES", "STOCK"] as const;
export type SourcingTier = (typeof SOURCING_TIERS)[number];

/** 1-based, so `tierNumber("STOCK") === 4` reads the way the round's brief writes it. */
export function tierNumber(tier: SourcingTier): number {
  return SOURCING_TIERS.indexOf(tier) + 1;
}

/**
 * Every provider this pipeline can search, and the tier it belongs to.
 *
 * The keys are the provider strings the code already uses — the same ones `searchGateDecision`
 * receives, `cachedProviderSearch` caches under and `FunnelCandidateSource` ranks. Inventing a
 * second naming scheme here would put the drift back in a new place.
 */
export const PROVIDER_TIER: Readonly<Record<string, SourcingTier>> = {
  /* ── Tier 1 ─────────────────────────────────────────────────────────────────────────────── */
  youtube_cc: "YOUTUBE",
  /**
   * The search half of the same tier. `searchYoutubeViaRapidApi` gates under the bare name
   * `youtube` while the download side gates under `youtube_cc` — one provider, two labels,
   * because the search and the fetch were built in different rounds. Both are tier 1; giving the
   * search a different tier than the download it feeds would be meaningless.
   */
  youtube: "YOUTUBE",

  /* ── Tier 2 — what FastVid holds itself ─────────────────────────────────────────────────── */
  archive: "OWN_ARCHIVE",
  curated: "OWN_ARCHIVE",

  /* ── Tier 3 — public and openly-licensed collections ────────────────────────────────────── */
  internet_archive: "OPEN_SOURCES",
  wikimedia: "OPEN_SOURCES",
  europeana: "OPEN_SOURCES",
  nara: "OPEN_SOURCES",
  loc: "OPEN_SOURCES",
  nasa: "OPEN_SOURCES",
  flickr: "OPEN_SOURCES",
  sepiasearch: "OPEN_SOURCES",
  vimeo: "OPEN_SOURCES",
  media_ccc: "OPEN_SOURCES",
  openverse: "OPEN_SOURCES",
  gdelt_tv: "OPEN_SOURCES",
  /**
   * `web_wide` reads like a general web crawl and is not one: `searchWebWideVideoClips` queries
   * `api.openverse.org` with a commercial-use licence filter. Same collection as `openverse`
   * above, under the label a different round gave it — so, the same tier.
   */
  web_wide: "OPEN_SOURCES",

  /* ── Tier 4 — licensed stock, and the image search that behaves like it ─────────────────── */
  pexels: "STOCK",
  pixabay: "STOCK",
  unsplash: "STOCK",
  /**
   * SerpAPI is a general image search rather than a collection, so it answers anything — which is
   * the property that puts a source in tier 4. Not a judgement on the pictures it finds.
   */
  serpapi: "STOCK",
};

/**
 * Which tier a provider belongs to, or null for a name this table has never heard of.
 *
 * Null rather than a default. A provider silently defaulting to a tier is exactly how `youtube_cc`
 * ended up ranked with Pexels in `EXTERNAL_SOURCE_TIER_BONUS` — a missing row reading as a
 * deliberate placement. `everyProviderHasATier` fails on an untiered provider instead.
 */
export function providerTier(provider: string): SourcingTier | null {
  return PROVIDER_TIER[provider.trim().toLowerCase()] ?? null;
}

/** Every provider on one tier, for a caller that wants to ask a whole tier at once. */
export function providersInTier(tier: SourcingTier): string[] {
  return Object.keys(PROVIDER_TIER)
    .filter((p) => PROVIDER_TIER[p] === tier)
    .sort();
}

/**
 * May `provider` be searched when `attempted` is everything tried for this beat so far?
 *
 * The rule is the ladder: a tier may run once every tier above it has been attempted, or has been
 * declined for a reason the caller can state. Same tier, or a tier further up, is always allowed —
 * going back up the ladder is not skipping it.
 *
 * `declined` carries the tiers the caller has decided are unavailable — no key configured, the
 * archive empty for this topic, a provider in cooldown. §13 of the brief allows exactly that, and
 * requires it to be a decision rather than an omission, which is why it is a separate argument and
 * not an absence.
 */
export function tierMayRun(
  provider: string,
  attempted: ReadonlySet<SourcingTier>,
  declined: ReadonlySet<SourcingTier> = new Set()
): { ok: true } | { ok: false; skipped: SourcingTier[] } {
  const tier = providerTier(provider);
  if (!tier) return { ok: true };
  /**
   * RENDER 592 — THE SENTENCE ABOVE SAID THIS AND THE CODE DID NOT DO IT.
   *
   * "Same tier … is always allowed" was written here from the first version and never implemented:
   * the filter below only ever looked at tiers strictly ABOVE the provider's, so a tier already
   * being attempted did nothing to admit the next query to that same tier.
   *
   * Render 592 is what that costs. Its scenes were built by the funnel, which searches tiers 2, 3
   * and 4 at scene level and does NOT search YouTube, so every beat opened with
   * `1=NOT_REACHED 2=ATTEMPTED 3=ATTEMPTED 4=ATTEMPTED`. Ninety-nine tier-3 queries — Internet
   * Archive, Wikimedia, SepiaSearch, Europeana, GDELT, media.ccc, Openverse — were then refused as
   * TIER_OUT_OF_ORDER for skipping a tier 1 that nothing was ever going to ask, while tier 3 stood
   * marked as attempted. Not one Pexels or Pixabay query was refused. The ladder was holding back
   * the archives and waving the stock through: the exact inverse of what it is for.
   *
   * Asking more of a tier that has ALREADY been attempted cannot skip anything. Whatever the first
   * query to that tier did or did not skip was decided when it was admitted; the second query to
   * the same tier adds no new ordering claim. So it is admitted, and the refusal is reserved for
   * what it was built for: a tier being opened for the first time while a higher one is untouched.
   */
  if (attempted.has(tier)) return { ok: true };
  const skipped = SOURCING_TIERS.filter(
    (t) => tierNumber(t) < tierNumber(tier) && !attempted.has(t) && !declined.has(t)
  );
  return skipped.length === 0 ? { ok: true } : { ok: false, skipped };
}

/** One line, for a render log that has to be readable as a ladder. */
export function formatTierAttempt(
  sceneIndex: number,
  beatIndex: number,
  provider: string,
  verdict: ReturnType<typeof tierMayRun>
): string {
  const tier = providerTier(provider);
  const head =
    `[SourcingTier] s${sceneIndex}b${beatIndex} provider=${provider} ` +
    `tier=${tier ? `${tierNumber(tier)}:${tier}` : "UNTIERED"}`;
  return verdict.ok
    ? `${head} order=OK`
    : `${head} order=OUT_OF_ORDER skipped=${verdict.skipped
        .map((t) => `${tierNumber(t)}:${t}`)
        .join(",")}`;
}
