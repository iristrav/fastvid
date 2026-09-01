/**
 * RONDE 140 — the open web as a source, with the site written down.
 *
 * ── What was already true, and needs saying plainly ──────────────────────────────────────────
 *
 * The brief for this round was "loosen the licence restriction on YouTube and the open web". On
 * the open web there was nothing to loosen. `fetchSerpAPIImages` searches Google Images and
 * downloads whatever comes back; it has never asked a licence question, of anybody, and this
 * module does not add one. The open-web route was already the widest one FastVid has.
 *
 * What it did NOT have is the other half of what Vidrush ships under "Compliance": a record of
 * WHICH SITE each picture came from, and an operator control over which sites may contribute.
 * That is the gap, and it is the gap this module fills.
 *
 * ── This module does not decide licences ─────────────────────────────────────────────────────
 *
 * Worth stating in the code, because the file sits next to `youtubeLicenseStatus.ts` and the two
 * answer different questions. That one classifies what an archive's METADATA said about rights.
 * This one has no metadata to classify — a Google Images result carries a URL and a page title and
 * nothing else. So every open-web asset is UNVERIFIED, always, under every setting here, and the
 * usage report at the bottom of this file says so in those words. Nothing in this module can
 * produce VERIFIED, and none of its switches is an authorisation.
 *
 * ── The two rules ────────────────────────────────────────────────────────────────────────────
 *
 * 1. A built-in refusal list, which is a QUALITY rule and not a legal one. The stock agencies
 *    below serve watermarked comps on their public pages, and the re-hosts below serve someone
 *    else's picture stripped of its origin. Both were already going to fail — the first at the
 *    baked-text detector, the second at provenance — after FastVid had paid for the download and
 *    spent a shortlist slot. The host is knowable before the request, so the answer is taken
 *    there. No production count backs this list; it rests on how those sites serve images, and it
 *    is deliberately short for that reason.
 *
 * 2. An operator list, from the environment, which is Vidrush's blacklist/whitelist:
 *
 *        OPEN_WEB_BLOCKED_DOMAINS=example.com,foo.org    never use these
 *        OPEN_WEB_ALLOWED_DOMAINS=archives.gov,bbc.co.uk ONLY use these
 *
 *    Both unset is the default and changes nothing. An allow-list, once set, is exclusive: that
 *    is the point of a whitelist, and a "whitelist" that let unlisted sites through would be a
 *    lie in the shape of a setting.
 */

/** Why an open-web candidate was refused before it was fetched. */
export type OpenWebRejectReason =
  | "no_host"
  | "watermarked_stock_preview"
  | "rehosted_no_provenance"
  | "operator_blocked"
  | "not_on_operator_allowlist";

export type OpenWebDecision = {
  /** The normalised host, or null when the URL has none this code can read. */
  host: string | null;
  allowed: boolean;
  reason: OpenWebRejectReason | null;
};

/**
 * The site an image URL points at, lower-cased and without a leading `www.`.
 *
 * Returns null rather than guessing. A URL with no parseable host cannot be downloaded either, so
 * "unreadable" and "unusable" are the same answer here — this is not a case where absence is
 * neutral, because there is no request to make.
 */
export function openWebHost(rawUrl: string | null | undefined): string | null {
  const raw = (rawUrl ?? "").trim();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  const normalised = host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return normalised || null;
}

/**
 * Does `host` fall under `pattern`?
 *
 * Exact match, or a subdomain of it. `gettyimages.com` therefore also covers
 * `media.gettyimages.com`, which is where the actual image files live — matching only the exact
 * host would let every real download through while blocking only the page URL.
 *
 * Deliberately not a substring test: `notgettyimages.com` is a different site, and a substring
 * rule would refuse it.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase().replace(/^www\./, "");
  const p = pattern.trim().toLowerCase().replace(/^\./, "").replace(/^www\./, "");
  if (!h || !p) return false;
  return h === p || h.endsWith(`.${p}`);
}

/**
 * Agencies that watermark every public preview.
 *
 * Not a judgement about their rights — a statement about the FILE their public pages serve. A
 * Getty comp is a picture with "gettyimages" printed diagonally across it, and FastVid's
 * baked-text detector refuses those on sight. Refusing the host is the same decision taken one
 * download earlier.
 */
export const WATERMARKED_STOCK_HOSTS: readonly string[] = [
  "gettyimages.com",
  "gettyimages.co.uk",
  "shutterstock.com",
  "shutterstock.ai",
  "alamy.com",
  "istockphoto.com",
  "dreamstime.com",
  "depositphotos.com",
  "123rf.com",
  "agefotostock.com",
  "stock.adobe.com",
  "imago-images.de",
  "profimedia.com",
  "zumapress.com",
  "canstockphoto.com",
];

/**
 * Sites that re-host other people's pictures without their origin.
 *
 * A Pinterest thumbnail has no findable source, so a clip taken from one can never answer "where
 * did this come from" — the question the whole lineage ledger exists to answer. Kept separate from
 * the watermark list because it is a different reason and the log says which one applied.
 */
export const REHOSTED_IMAGE_HOSTS: readonly string[] = [
  "pinterest.com",
  "pinimg.com",
  "lookaside.fbsbx.com",
  "encrypted-tbn0.gstatic.com",
];

/** Split a comma- or space-separated environment list into hosts. */
export function parseHostList(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\./, "").replace(/^www\./, ""))
    .filter(Boolean);
}

/**
 * The operator's blacklist. Empty by default; empty means "no extra refusals".
 *
 * Read at call time rather than captured at import, so the worker picks a change up from its own
 * environment without a code change — the same shape `allowOperatorLicensedYoutube` uses.
 */
export function operatorBlockedHosts(): string[] {
  return parseHostList(process.env.OPEN_WEB_BLOCKED_DOMAINS);
}

/**
 * The operator's whitelist. Empty by default, and EMPTY MEANS "no restriction" — not "allow
 * nothing". An unset variable must never be able to switch the open web off by accident.
 */
export function operatorAllowedHosts(): string[] {
  return parseHostList(process.env.OPEN_WEB_ALLOWED_DOMAINS);
}

/**
 * May this open-web image be fetched?
 *
 * Order matters and is the order a person would defend: the built-in quality refusals first, then
 * the operator's blacklist, then the operator's whitelist. A host on the operator's whitelist does
 * NOT get past the watermark list — a whitelist says which sites the operator is interested in,
 * not that a watermarked comp from one of them is suddenly usable.
 */
export function openWebSourceDecision(params: {
  url: string | null | undefined;
  /** Injected so a test can drive both lists without touching the environment. */
  blockedHosts?: readonly string[];
  allowedHosts?: readonly string[];
}): OpenWebDecision {
  const host = openWebHost(params.url);
  if (!host) return { host: null, allowed: false, reason: "no_host" };

  if (WATERMARKED_STOCK_HOSTS.some((p) => hostMatches(host, p))) {
    return { host, allowed: false, reason: "watermarked_stock_preview" };
  }
  if (REHOSTED_IMAGE_HOSTS.some((p) => hostMatches(host, p))) {
    return { host, allowed: false, reason: "rehosted_no_provenance" };
  }

  const blocked = params.blockedHosts ?? operatorBlockedHosts();
  if (blocked.some((p) => hostMatches(host, p))) {
    return { host, allowed: false, reason: "operator_blocked" };
  }

  const allowed = params.allowedHosts ?? operatorAllowedHosts();
  if (allowed.length > 0 && !allowed.some((p) => hostMatches(host, p))) {
    return { host, allowed: false, reason: "not_on_operator_allowlist" };
  }

  return { host, allowed: true, reason: null };
}

/**
 * The refusal line.
 *
 * The HOST and nothing else — no full URL, no query string. An image URL from a search result
 * routinely carries a signed token or a tracking parameter, and this line goes to a log that is
 * read by people who do not need either. The same rule the Wikimedia logging follows.
 */
export function formatOpenWebReject(params: {
  sceneIndex: number;
  beatIndex?: number;
  decision: OpenWebDecision;
}): string {
  const beat = params.beatIndex != null ? ` beat=${params.beatIndex}` : "";
  return (
    `[OpenWeb] scene=${params.sceneIndex}${beat} host=${params.decision.host ?? "unknown"} ` +
    `skipped reason=${params.decision.reason ?? "unknown"}`
  );
}

/** One open-web picture that actually reached the finished video. */
export type OpenWebUsageEntry = {
  sceneIndex: number;
  beatIndex: number;
  host: string | null;
  sourceUrl?: string | null;
  title?: string;
  visionVerdict: string;
};

/**
 * The section of the render report that answers "which websites are in this video".
 *
 * The counterpart to `formatYoutubeUsageReport`, and written to the same standard: it lists what
 * was used so a person can check it, and it never implies more than was established. Every entry
 * here is UNVERIFIED by construction — a Google Images result carries no rights information at
 * all — and the header says that once rather than repeating it per line.
 *
 * Grouped by host, because the question a person actually asks of this list is "what sites did we
 * take from", and twenty lines from one archive is a different answer from twenty lines from
 * twenty sites.
 */
export function formatOpenWebUsageReport(entries: ReadonlyArray<OpenWebUsageEntry>): string {
  if (entries.length === 0) return "[OpenWebUsage] used=0";
  const byHost = new Map<string, OpenWebUsageEntry[]>();
  for (const e of entries) {
    const host = e.host ?? "unknown";
    const list = byHost.get(host);
    if (list) list.push(e);
    else byHost.set(host, [e]);
  }
  const lines = [
    `[OpenWebUsage] used=${entries.length} hosts=${byHost.size}`,
    "   ⚠ open-web material carries NO licence information. FastVid proved no right to any of " +
      "these — every one is UNVERIFIED and needs a manual rights check before publishing.",
  ];
  for (const [host, list] of [...byHost.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`   host=${host} clips=${list.length}`);
    for (const e of list.sort((a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex)) {
      lines.push(
        `      scene=${e.sceneIndex} beat=${e.beatIndex} vision=${e.visionVerdict}` +
          (e.title ? ` title="${e.title.slice(0, 90)}"` : "") +
          (e.sourceUrl ? ` sourceUrl=${e.sourceUrl}` : "")
      );
    }
  }
  return lines.join("\n");
}

export const OPEN_WEB_REJECT_REASONS: readonly OpenWebRejectReason[] = [
  "no_host",
  "watermarked_stock_preview",
  "rehosted_no_provenance",
  "operator_blocked",
  "not_on_operator_allowlist",
];

/** What the policy saw and refused, for one render. */
export type OpenWebPolicyStats = {
  considered: number;
  blocked: Record<OpenWebRejectReason, number>;
};

export function createOpenWebPolicyStats(): OpenWebPolicyStats {
  return {
    considered: 0,
    blocked: {
      no_host: 0,
      watermarked_stock_preview: 0,
      rehosted_no_provenance: 0,
      operator_blocked: 0,
      not_on_operator_allowlist: 0,
    },
  };
}

/**
 * Count one decision.
 *
 * EVERY decision, allowed or not — `considered` is the denominator, and a blocked count without
 * one says nothing about whether the policy is doing anything.
 */
export function noteOpenWebDecision(
  stats: OpenWebPolicyStats | undefined,
  decision: OpenWebDecision
): void {
  if (!stats) return;
  stats.considered++;
  if (!decision.allowed && decision.reason) stats.blocked[decision.reason]++;
}

/**
 * What the policy did this render, as counts.
 *
 * Printed even when it refused nothing, so `blocked=0` is a measurement rather than a missing
 * line — the same reason `operatorAuthorized` is printed for both of its values.
 */
export function formatOpenWebPolicyReport(stats: OpenWebPolicyStats): string {
  const total = OPEN_WEB_REJECT_REASONS.reduce((n, r) => n + (stats.blocked[r] ?? 0), 0);
  const detail = OPEN_WEB_REJECT_REASONS.map((r) => `${r}=${stats.blocked[r] ?? 0}`).join(" ");
  const lists =
    `operatorBlocked=${operatorBlockedHosts().length} ` +
    `operatorAllowed=${operatorAllowedHosts().length}`;
  return `[OpenWebPolicy] considered=${stats.considered} blocked=${total} ${detail} ${lists}`;
}
