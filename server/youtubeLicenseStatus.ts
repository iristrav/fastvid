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

export type LicenseAction =
  | "ALLOW"
  | "ALLOW_UNVERIFIED_YOUTUBE"
  | "ALLOW_OPERATOR_LICENSED_YOUTUBE"
  | "REJECT";

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
 * RONDE 145 — does the operator hold rights this metadata cannot see?
 *
 * The FastVid owner states they have a separate agreement covering YouTube material and has asked
 * for the REJECTED category to be opened on that basis. This flag is how that assertion enters the
 * pipeline: deliberately, per environment, off unless switched on.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────────────────────
 *
 * It does not change `classifyArchiveLicense`. A `-nc` or `-nd` licence still classifies as
 * REJECTED, every report still prints REJECTED, and the audit trail still records that the
 * metadata said no. Nothing in this module is made to claim a licence that the metadata does not
 * show — that was RONDE 124's founding rule and it is unchanged.
 *
 * What the flag changes is only the ACTION taken on that status, which is the operator's call to
 * make and is recorded as theirs. The distinction matters: if a rightsholder ever asks, the log
 * shows the licence was read correctly, the refusal was seen, and a human overrode it — not that
 * FastVid mistook an -nc licence for permission.
 *
 * ── What the operator is taking on ───────────────────────────────────────────────────────────
 *
 * REJECTED means the UPLOADER chose "non-commercial" or "no derivative works" on their own video.
 * That choice belongs to the uploader, not to YouTube, and a platform-level agreement does not
 * transfer it. Whoever turns this on is asserting they have rights from another source. This
 * comment exists so that assertion is visible in the code that acts on it.
 */
export function allowOperatorLicensedYoutube(): boolean {
  return process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE?.trim().toLowerCase() === "true";
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
 *  2. UNVERIFIED continues only when it is a YouTube-origin item AND the operator has switched
 *     ALLOW_UNVERIFIED_YOUTUBE on. Anything else — a non-YouTube archive item, or the flag off —
 *     stops exactly as it does today.
 *  3. RONDE 145: REJECTED continues only when it is a YouTube-origin item AND the operator has
 *     switched ALLOW_OPERATOR_LICENSED_YOUTUBE on, asserting rights from an agreement this
 *     metadata cannot see. The status stays REJECTED and every report goes on saying so; what
 *     changes is who is answerable for using it. With the flag off — the default — an explicit
 *     refusal is never overridden, exactly as before.
 *
 * Both overrides are narrow by construction: YouTube-origin identifiers only, so an Internet
 * Archive item from any other source keeps its current treatment under either flag.
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
  /** RONDE 145: injected the same way, for the operator-licence override. */
  allowOperatorLicensed?: boolean;
}): LicenseDecision {
  const status = classifyArchiveLicense(params.licenseUrl, params.rights);
  const isYoutube = isYoutubeOriginIdentifier(params.identifier);
  const allowUnverified = params.allowUnverified ?? allowUnverifiedYoutube();
  const allowOperatorLicensed = params.allowOperatorLicensed ?? allowOperatorLicensedYoutube();

  let action: LicenseAction = "REJECT";
  if (status === "VERIFIED") action = "ALLOW";
  else if (status === "UNVERIFIED" && isYoutube && allowUnverified) {
    action = "ALLOW_UNVERIFIED_YOUTUBE";
  } else if (status === "REJECTED" && isYoutube && allowOperatorLicensed) {
    action = "ALLOW_OPERATOR_LICENSED_YOUTUBE";
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
      : "") +
    // RONDE 145: the licence itself said no. Say that plainly on the line that let it through,
    // so the override is never mistaken for a permission FastVid established.
    (decision.action === "ALLOW_OPERATOR_LICENSED_YOUTUBE"
      ? " — licence FORBIDS this use (uploader chose -nc/-nd); used on the operator's asserted " +
        "agreement, NOT on any right FastVid verified"
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
    /**
     * RONDE 145 — the strongest warning in the report, because this is the strongest claim.
     *
     * A manual rights check starts from this report. An item whose own licence forbids the use
     * has to be findable here in one pass, with the reason it was used anyway stated next to it.
     */
    if (e.licenseStatus === "REJECTED") {
      lines.push(
        "   ⛔ the uploader's licence FORBIDS this use (-nc/-nd). Used under " +
          "ALLOW_OPERATOR_LICENSED_YOUTUBE on the operator's asserted agreement — FastVid " +
          "verified no right to it. Clear this one before publishing or monetising."
      );
    }
  });
  return lines.join("\n");
}
