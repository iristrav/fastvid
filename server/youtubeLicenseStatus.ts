/**
 * RONDE 124 — "we could not verify the rights" is not the same claim as "the rights forbid this".
 *
 * ── What the production log actually says ────────────────────────────────────────────────────
 *
 * A correction to the brief that shaped this round, because it changes where the fix belongs.
 * The 56 refusals in the worker log are NOT the YouTube Data API path:
 *
 *     Archive item youtube-cS2JdEghHDo has no usable license (licenseurl=none, rights=none) — skipping
 *     Archive item youtube-zUU-LNi7FBc has no usable license (licenseurl=none, rights=none) — skipping
 *     …
 *
 * Those are INTERNET ARCHIVE items whose identifier begins with `youtube-` — mirrors of YouTube
 * videos, uploaded to archive.org, refused by `isAllowedInternetArchiveLicense`. The live YouTube
 * search in that same render returned nothing at all ("YouTube CC 0 relevant results" ×14,
 * "YouTube fair-use 0 relevant results" ×14), so no live result was ever license-checked.
 *
 * That is where the flag has to act. Changing the YouTube Data API path would have left all 56
 * refusals exactly as they were.
 *
 * ── The distinction this module draws ────────────────────────────────────────────────────────
 *
 * `isAllowedInternetArchiveLicense` answers one boolean, so two very different situations came
 * out identical:
 *
 *     licenseurl=https://creativecommons.org/licenses/by-nc-nd/4.0/   the licence forbids this use
 *     licenseurl=none, rights=none                                    nobody filled the field in
 *
 * The first is a refusal by the rightsholder. The second is a gap in archive.org metadata, and it
 * is emphatically NOT evidence that the material is free to use. Both remain refused by default;
 * only the second can be opened up, only for YouTube-origin items, and only deliberately.
 *
 * UNVERIFIED means exactly one thing: FastVid could not prove the rights automatically, and a
 * human has to. Every report says so in those words, and nothing in this module ever claims a
 * licence exists.
 */

/** What FastVid was able to establish about an item's rights. */
export type LicenseStatus = "VERIFIED" | "UNVERIFIED" | "REJECTED";

export type LicenseAction = "ALLOW" | "ALLOW_UNVERIFIED_YOUTUBE" | "REJECT";

/**
 * Is the operator willing to use YouTube-origin material whose rights FastVid cannot prove?
 *
 * Default false, and false is the current behaviour exactly — an unset variable changes nothing.
 * Read at call time rather than captured at import, so the worker picks it up from its own
 * environment without a code change.
 */
export function allowUnverifiedYoutube(): boolean {
  return process.env.ALLOW_UNVERIFIED_YOUTUBE?.trim().toLowerCase() === "true";
}

/**
 * Does this archive identifier come from YouTube?
 *
 * archive.org's YouTube mirrors are named `youtube-<videoId>`; that prefix is the only marker
 * available at the point the licence decision has to be made. Deliberately narrow: the flag is
 * about YouTube, and an Internet Archive item from any other source keeps its current treatment.
 */
export function isYoutubeOriginIdentifier(identifier: string | null | undefined): boolean {
  return /^youtube[-_]/i.test((identifier ?? "").trim());
}

/** The `<videoId>` half of a `youtube-<videoId>` identifier, or null. */
export function youtubeVideoIdFromIdentifier(identifier: string | null | undefined): string | null {
  const m = (identifier ?? "").trim().match(/^youtube[-_](.+)$/i);
  return m?.[1]?.trim() || null;
}

/**
 * Classify what the metadata says, without deciding anything.
 *
 * The VERIFIED cases are exactly `isAllowedInternetArchiveLicense`'s `true` cases, character for
 * character — that equivalence is what makes the default behaviour provably unchanged, and it has
 * its own test. What this adds is a split of that function's single `false` into two:
 *
 *   REJECTED    the metadata says something, and what it says is no. An -nc or -nd licence, a
 *               non-commercial or no-derivatives rights statement.
 *   UNVERIFIED  the metadata does not answer the question. Empty fields, or a rights note that
 *               is about attribution rather than permission.
 *
 * An unrecognised licence URL lands in UNVERIFIED rather than REJECTED: a URL FastVid cannot
 * parse is a limit of this parser, not a statement by the rightsholder. It still needs a human.
 */
export function classifyArchiveLicense(
  licenseUrl: string | undefined | null,
  rights?: string | undefined | null
): LicenseStatus {
  const u = licenseUrl?.trim().toLowerCase();
  if (u) {
    if (u.includes("publicdomain")) return "VERIFIED";
    if (u.includes("creativecommons.org/licenses/")) {
      if (u.includes("-nc") || u.includes("-nd")) return "REJECTED";
      if (u.includes("/by/") || u.includes("/by-sa/")) return "VERIFIED";
      // A Creative Commons URL in a shape this parser does not know.
      return "UNVERIFIED";
    }
    return "UNVERIFIED";
  }

  const r = rights?.trim().toLowerCase();
  if (!r) return "UNVERIFIED";
  if (r.includes("-nc") || r.includes("-nd") || /non.?commercial|no derivative/.test(r)) {
    return "REJECTED";
  }
  if (/public domain|no known copyright|no copyright restrictions/.test(r)) return "VERIFIED";
  // Rights text that says something else entirely — an attribution note, a contact address.
  return "UNVERIFIED";
}

export type LicenseDecision = {
  status: LicenseStatus;
  action: LicenseAction;
  /** May the pipeline go on to download, preview and judge this item? */
  allowed: boolean;
  /** Present only when the item is a YouTube mirror. */
  youtubeVideoId: string | null;
  /** Echoed back verbatim, never invented. Null stays null. */
  licenseUrl: string | null;
  rights: string | null;
};

/**
 * Decide, for one archive item, whether sourcing may continue.
 *
 * Three rules, and the third is the one that matters:
 *
 *  1. VERIFIED always continues — unchanged.
 *  2. REJECTED always stops, flag or no flag. An explicit refusal is never overridden.
 *  3. UNVERIFIED continues only when it is a YouTube-origin item AND the operator has switched
 *     the flag on. Anything else — a non-YouTube archive item, or the flag off — stops exactly
 *     as it does today.
 *
 * Continuing is not the same as using. An allowed item still has to survive the preview check
 * (RONDE 118), the vision gate and ranking, all untouched by this module.
 */
export function youtubeLicenseDecision(params: {
  identifier: string | null | undefined;
  licenseUrl?: string | null;
  rights?: string | null;
  /** Injected so a test can drive both settings without touching the environment. */
  allowUnverified?: boolean;
}): LicenseDecision {
  const status = classifyArchiveLicense(params.licenseUrl, params.rights);
  const isYoutube = isYoutubeOriginIdentifier(params.identifier);
  const allowUnverified = params.allowUnverified ?? allowUnverifiedYoutube();

  let action: LicenseAction = "REJECT";
  if (status === "VERIFIED") action = "ALLOW";
  else if (status === "UNVERIFIED" && isYoutube && allowUnverified) {
    action = "ALLOW_UNVERIFIED_YOUTUBE";
  }

  return {
    status,
    action,
    allowed: action !== "REJECT",
    youtubeVideoId: isYoutube ? youtubeVideoIdFromIdentifier(params.identifier) : null,
    licenseUrl: params.licenseUrl?.trim() || null,
    rights: params.rights?.trim() || null,
  };
}

/**
 * The line the pipeline logs for a YouTube-origin item.
 *
 * Only for YouTube items: an ordinary archive refusal already has its own line and this round
 * must not start rewriting other providers' logs.
 */
export function formatYoutubeLicenseLine(decision: LicenseDecision): string {
  return (
    `[YouTubeLicense] video=${decision.youtubeVideoId ?? "unknown"} ` +
    `status=${decision.status} action=${decision.action}` +
    (decision.licenseUrl ? ` licenseUrl=${decision.licenseUrl}` : " licenseUrl=null") +
    (decision.status === "UNVERIFIED" && decision.action !== "REJECT"
      ? " — rights NOT proven, verify manually before publishing"
      : "")
  );
}

/** One YouTube item that actually reached the finished video. */
export type YoutubeUsageEntry = {
  sceneIndex: number;
  beatIndex: number;
  youtubeVideoId: string;
  title?: string;
  channel?: string;
  licenseStatus: LicenseStatus;
  licenseUrl: string | null;
  rights: string | null;
  previewStatus: string;
  visionVerdict: string;
};

/**
 * The section of the render report that answers "did this video actually use YouTube footage,
 * and which items were they" — the question a manual rights check starts from.
 */
export function formatYoutubeUsageReport(entries: ReadonlyArray<YoutubeUsageEntry>): string {
  if (entries.length === 0) return "[YouTubeUsage] used=0";
  const lines = [`[YouTubeUsage] used=${entries.length}`];
  entries.forEach((e, i) => {
    lines.push(
      `${i + 1}. scene=${e.sceneIndex} beat=${e.beatIndex} youtubeVideoId=${e.youtubeVideoId}` +
        ` youtubeUrl=https://www.youtube.com/watch?v=${e.youtubeVideoId}`
    );
    if (e.title) lines.push(`   title="${e.title.slice(0, 120)}"`);
    if (e.channel) lines.push(`   channel="${e.channel.slice(0, 80)}"`);
    lines.push(
      `   licenseStatus=${e.licenseStatus} licenseUrl=${e.licenseUrl ?? "null"} ` +
        `rights=${e.rights ?? "null"}`
    );
    lines.push(`   preview=${e.previewStatus} vision=${e.visionVerdict} used=true`);
    if (e.licenseStatus === "UNVERIFIED") {
      lines.push("   ⚠ rights NOT verified by FastVid — check this one manually");
    }
  });
  return lines.join("\n");
}
