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

/**
 * What the METADATA established about an item's rights.
 *
 * This is the archive's answer and nothing else. It is produced only by `classifyArchiveLicense`,
 * which reads `licenseurl` and `rights` and no setting of any kind. RONDE 147 does not extend it —
 * the operator's authorisation is not a fourth thing the metadata can say.
 */
export type LicenseStatus = "VERIFIED" | "UNVERIFIED" | "REJECTED";

/**
 * RONDE 147 — what the DECISION concluded, which is a wider question.
 *
 * `OPERATOR_AUTHORIZED` exists so the operator's blanket YouTube authorisation never has to borrow
 * the word VERIFIED. VERIFIED means the verification flow actually established a licence; that
 * claim stays available for the cases that earn it, and the override cannot produce it.
 */
export type DecisionStatus = LicenseStatus | "OPERATOR_AUTHORIZED";

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
 * RONDE 147 — is the operator's YouTube authorisation in force?
 *
 * The FastVid owner states they hold authorisation to use YouTube content, and asked for that to
 * apply to YouTube as a whole rather than clip by clip. One switch, therefore, and it is the
 * authorisation itself:
 *
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE=false   (default)  RONDE 124's flow, untouched
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE=true               every youtube-* item is allowed
 *
 * Default false, and false is the previous behaviour exactly — an unset variable changes nothing.
 * Read at call time rather than captured at import, so the worker picks it up from its own
 * environment without a code change.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────────────────────
 *
 * It does not change `classifyArchiveLicense`. A `-nc` or `-nd` licence still classifies as
 * REJECTED and an empty field still classifies as UNVERIFIED, whatever this flag is set to; the
 * decision keeps that verdict on `metadataStatus` so it survives the override. Nothing in this
 * module is made to claim a licence that the metadata does not show — RONDE 124's founding rule,
 * unchanged.
 *
 * It also does not produce VERIFIED. The override's own status is `OPERATOR_AUTHORIZED`, which
 * exists precisely so "the operator permits this" never has to borrow the word for "the licence
 * was verified". VERIFIED stays reachable only through the flow that earns it.
 *
 * ── What the operator is taking on ───────────────────────────────────────────────────────────
 *
 * A REJECTED classification means the UPLOADER chose "non-commercial" or "no derivative works" on
 * their own video. That choice belongs to the uploader rather than to the platform. Switching this
 * on asserts an authorisation from elsewhere, for YouTube material generally. The assertion is
 * recorded on every decision it carries — `operatorAuthorized`, `licenseBasis`, and the log line —
 * so the record always shows what was known and who decided to proceed anyway.
 */
export function allowOperatorLicensedYoutube(): boolean {
  return process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE?.trim().toLowerCase() === "true";
}

/**
 * Is this item covered by the operator's YouTube authorisation?
 *
 * Two conditions, and only two: the flag is on, and the item is YouTube-origin. There is no
 * per-video list — the FastVid owner has stated a blanket authorisation for YouTube content, and
 * RONDE 147 implements exactly that. (RONDE 146 briefly required a per-clip allowlist; the owner
 * withdrew that requirement, so it was deleted rather than left dead. Its variable name is
 * deliberately not repeated anywhere in this file, so a test can assert the codebase is clean
 * of it.)
 *
 * The YouTube-origin check is what keeps the scope honest: Pexels, Pixabay, Wikimedia, NARA, LOC
 * and ordinary Internet Archive items can never reach this branch, whatever the flag is set to.
 */
export function isOperatorAuthorizedYoutube(params: {
  identifier: string | null | undefined;
  allowOperatorLicensed: boolean;
}): boolean {
  if (!params.allowOperatorLicensed) return false;
  return isYoutubeOriginIdentifier(params.identifier);
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

/**
 * RONDE 146 — WHO is the authority for using this item.
 *
 * `status` says what the metadata showed. `licenseBasis` says who decided, and the two must never
 * be collapsed: an operator-cleared asset is used on a human's say-so, not because YouTube or the
 * archive supplied a licence. Keeping the field separate is what stops a report from ever reading
 * as though the platform verified something it did not.
 */
export type LicenseBasis = "archive_metadata" | "operator_assertion";

export type LicenseDecision = {
  /**
   * The decision's own conclusion — `OPERATOR_AUTHORIZED` when the override carried it.
   * Never VERIFIED unless the verification flow actually said so.
   */
  status: DecisionStatus;
  /**
   * RONDE 147 — what the archive metadata said, kept whatever the decision concluded.
   *
   * The override changes the conclusion, never the evidence. A -nc licence still reads REJECTED
   * here, and an empty field still reads UNVERIFIED, so a rights check can always recover what
   * was actually known before a human overrode it.
   */
  metadataStatus: LicenseStatus;
  action: LicenseAction;
  /** Who authorised this — the metadata, or a human overriding it. */
  licenseBasis: LicenseBasis;
  /** RONDE 147 — true only when the operator's YouTube authorisation carried this item. */
  operatorAuthorized: boolean;
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
 *  3. RONDE 147: a YouTube-origin item continues whatever the metadata said, whenever
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE is on. The FastVid owner has stated a blanket authorisation
 *     for YouTube content, so there is no per-video list to consult — the flag IS the
 *     authorisation. With the flag off, the default, this branch does not exist and RONDE 124's
 *     flow runs untouched.
 *
 * Rule 3 is checked LAST on purpose. An item already allowed on its own licence keeps
 * `archive_metadata` as its basis and its own status: the override must not rewrite the record of
 * why something was usable when it did not need overriding.
 *
 * The scope is YouTube and only YouTube. Pexels, Pixabay, Wikimedia, NARA, LOC and ordinary
 * Internet Archive items cannot reach either override, under any setting of either flag.
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
  /** RONDE 145: injected the same way, for the operator authorisation. */
  allowOperatorLicensed?: boolean;
}): LicenseDecision {
  const metadataStatus = classifyArchiveLicense(params.licenseUrl, params.rights);
  const isYoutube = isYoutubeOriginIdentifier(params.identifier);
  const allowUnverified = params.allowUnverified ?? allowUnverifiedYoutube();
  const allowOperatorLicensed = params.allowOperatorLicensed ?? allowOperatorLicensedYoutube();

  let action: LicenseAction = "REJECT";
  let licenseBasis: LicenseBasis = "archive_metadata";
  let status: DecisionStatus = metadataStatus;
  let operatorAuthorized = false;
  if (metadataStatus === "VERIFIED") action = "ALLOW";
  else if (metadataStatus === "UNVERIFIED" && isYoutube && allowUnverified) {
    action = "ALLOW_UNVERIFIED_YOUTUBE";
  } else if (
    isOperatorAuthorizedYoutube({ identifier: params.identifier, allowOperatorLicensed })
  ) {
    action = "ALLOW_OPERATOR_LICENSED_YOUTUBE";
    licenseBasis = "operator_assertion";
    /**
     * The conclusion is OPERATOR_AUTHORIZED, never VERIFIED.
     *
     * `metadataStatus` above still carries what the archive actually said, so nothing is lost —
     * but the decision's own status names the authority correctly. This is the single line that
     * keeps "the operator permits this" from ever being read as "the licence was verified".
     */
    status = "OPERATOR_AUTHORIZED";
    operatorAuthorized = true;
  }

  return {
    status,
    metadataStatus,
    action,
    licenseBasis,
    operatorAuthorized,
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
    // `video=` stays the first field: RONDE 124 asserts that prefix, and that assertion is still
    // exactly right. `provider=` is appended after it rather than inserted before.
    `[YouTubeLicense] video=${decision.youtubeVideoId ?? "unknown"} provider=youtube ` +
    `status=${decision.status} action=${decision.action} ` +
    /**
     * RONDE 146/147 — the authority, on every line, never inferred from the status.
     *
     * `operatorAuthorized` is printed for both values rather than only the true one, so its
     * absence in a log is unambiguous: a line without it is a line from an older build, not a
     * line where the override happened to be off.
     */
    `operatorAuthorized=${decision.operatorAuthorized} ` +
    `source=${decision.licenseBasis === "operator_assertion" ? "operator" : "archive"}` +
    (decision.licenseUrl ? ` licenseUrl=${decision.licenseUrl}` : " licenseUrl=null") +
    (decision.status === "UNVERIFIED" && decision.action !== "REJECT"
      ? " — rights NOT proven, verify manually before publishing"
      : "") +
    // RONDE 147: the metadata is still reported, next to the authorisation that overrode it.
    (decision.operatorAuthorized
      ? ` — archive metadata says ${decision.metadataStatus}; used under the operator's ` +
        "YouTube authorisation. NOT verified by FastVid and NOT verified by YouTube"
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
  /** RONDE 147: `OPERATOR_AUTHORIZED` here means the operator's authorisation carried it. */
  licenseStatus: DecisionStatus;
  /**
   * RONDE 146 — who authorised it. Optional so existing callers compile unchanged; absent is read
   * as `archive_metadata`, which is what every pre-RONDE-145 entry was.
   */
  licenseBasis?: LicenseBasis;
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
    const basis = e.licenseBasis ?? "archive_metadata";
    lines.push(
      `   licenseStatus=${e.licenseStatus} licenseUrl=${e.licenseUrl ?? "null"} ` +
        `rights=${e.rights ?? "null"} ` +
        /**
         * RONDE 146: the authority, on the same line as the status so neither can be read alone.
         *
         * Appended rather than inserted: RONDE 124 asserts the existing three fields as one
         * contiguous string, and that assertion is still exactly right. Adding a field is not a
         * reason to make an older test rewrite what it was already checking correctly.
         */
        `source=${basis === "operator_assertion" ? "operator" : "archive"}`
    );
    lines.push(`   preview=${e.previewStatus} vision=${e.visionVerdict} used=true`);
    if (e.licenseStatus === "UNVERIFIED" && basis !== "operator_assertion") {
      lines.push("   ⚠ rights NOT verified by FastVid — check this one manually");
    }
    /**
     * RONDE 145/146 — the strongest warning in the report, because this is the strongest claim.
     *
     * A manual rights check starts from this report. An item used against what its own metadata
     * said has to be findable here in one pass, with the reason stated next to it. Keyed on the
     * BASIS rather than the status: an operator-cleared UNVERIFIED item is the same kind of claim
     * as an operator-cleared REJECTED one, and both need the human to be able to find them.
     */
    if (basis === "operator_assertion") {
      lines.push(
        "   ⛔ used under the operator's YouTube authorisation " +
          "(ALLOW_OPERATOR_LICENSED_YOUTUBE) — status OPERATOR_AUTHORIZED, not VERIFIED. " +
          "FastVid verified no right to it, and neither did YouTube."
      );
    }
  });
  return lines.join("\n");
}
