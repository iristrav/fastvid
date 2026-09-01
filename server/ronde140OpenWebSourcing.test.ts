/**
 * RONDE 140 — the open web as a source, with the site written down.
 *
 * ── What this round did and did not change ───────────────────────────────────────────────────
 *
 * The brief was "loosen the licence restriction on YouTube and the open web". On the open web
 * there was no restriction to loosen: `fetchSerpAPIImages` has always downloaded whatever Google
 * Images returned, without asking a rights question of anybody. So this round adds nothing to that
 * route's permission and takes nothing away from it — every assertion below about UNVERIFIED is
 * describing what was already true and is now finally reported.
 *
 * What it adds is the half Vidrush ships as "Compliance": which SITE each picture came from, an
 * operator control over which sites may contribute, and two rights-check lists at the end of a
 * render — one of which (`formatYoutubeUsageReport`) has existed since RONDE 124 and had never
 * been called.
 *
 * ── The assertions that matter most ──────────────────────────────────────────────────────────
 *
 *   · An EMPTY allow-list must mean "no restriction", never "allow nothing". An unset environment
 *     variable that silently switched the open web off would be the worst possible failure here.
 *   · The refusal line carries the HOST and nothing else — a search-result image URL routinely
 *     carries a signed token, and this line goes to a log.
 *   · Nothing in the module can produce VERIFIED.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  OPEN_WEB_REJECT_REASONS,
  REHOSTED_IMAGE_HOSTS,
  WATERMARKED_STOCK_HOSTS,
  createOpenWebPolicyStats,
  formatOpenWebPolicyReport,
  formatOpenWebReject,
  formatOpenWebUsageReport,
  hostMatches,
  noteOpenWebDecision,
  openWebHost,
  openWebSourceDecision,
  operatorAllowedHosts,
  operatorBlockedHosts,
  parseHostList,
  type OpenWebUsageEntry,
} from "./openWebSourcePolicy";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};
/**
 * Source with PROSE comments removed — line-anchored, for the reason RONDE 134/136/138 record:
 * the obvious `/\*[\s\S]*?\*​/` desynchronises on a `*​/` inside a string or a regex, and on
 * videoPipeline.ts that silently deletes real code, making every `not.toContain` pass for the
 * wrong reason.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

afterEach(() => {
  delete process.env.OPEN_WEB_BLOCKED_DOMAINS;
  delete process.env.OPEN_WEB_ALLOWED_DOMAINS;
});

/* ═══════════════════════ 1. reading the host ═══════════════════════ */

describe("RONDE 140 §1 — the host, normalised", () => {
  it("lower-cases, strips www. and a trailing dot", () => {
    expect(openWebHost("https://WWW.Archives.GOV/photo.jpg")).toBe("archives.gov");
    expect(openWebHost("https://media.gettyimages.com./x.jpg")).toBe("media.gettyimages.com");
  });

  it("keeps subdomains — they are what the match rule works on", () => {
    expect(openWebHost("https://media.gettyimages.com/id/515/photo.jpg")).toBe(
      "media.gettyimages.com"
    );
  });

  it("a URL with no readable host is null, not a guess", () => {
    // Not a case where absence is neutral: with no host there is no request to make either.
    expect(openWebHost("not a url")).toBeNull();
    expect(openWebHost("/local-storage/x.jpg")).toBeNull();
    expect(openWebHost("")).toBeNull();
    expect(openWebHost(undefined)).toBeNull();
    expect(openWebHost(null)).toBeNull();
  });
});

describe("RONDE 140 §1 — hostMatches covers subdomains and nothing else", () => {
  it("exact and subdomain match", () => {
    expect(hostMatches("gettyimages.com", "gettyimages.com")).toBe(true);
    expect(hostMatches("media.gettyimages.com", "gettyimages.com")).toBe(true);
    expect(hostMatches("a.b.gettyimages.com", "gettyimages.com")).toBe(true);
  });

  it("THE BUG A SUBSTRING TEST WOULD HAVE: a different site that ends in the same letters", () => {
    expect(hostMatches("notgettyimages.com", "gettyimages.com")).toBe(false);
    expect(hostMatches("gettyimages.com.example.org", "gettyimages.com")).toBe(false);
  });

  it("a leading dot or www. in the pattern is tolerated", () => {
    expect(hostMatches("media.gettyimages.com", ".gettyimages.com")).toBe(true);
    expect(hostMatches("archives.gov", "www.archives.gov")).toBe(true);
  });

  it("empty on either side matches nothing", () => {
    expect(hostMatches("", "gettyimages.com")).toBe(false);
    expect(hostMatches("gettyimages.com", "")).toBe(false);
  });
});

/* ═══════════════════════ 2. the decision ═══════════════════════ */

describe("RONDE 140 §2 — what the policy refuses", () => {
  it("an ordinary site is allowed, which is the default behaviour of this route", () => {
    const d = openWebSourceDecision({ url: "https://www.archives.gov/x.jpg" });
    expect(d.allowed).toBe(true);
    expect(d.host).toBe("archives.gov");
    expect(d.reason).toBeNull();
  });

  it("watermarked agency comps are refused, including the CDN host the file actually lives on", () => {
    // The page host and the image host are different, and the image host is the one that matters:
    // matching only the exact page host would block nothing that is ever downloaded.
    for (const host of ["gettyimages.com", "media.gettyimages.com", "www.shutterstock.com"]) {
      const d = openWebSourceDecision({ url: `https://${host}/a.jpg` });
      expect(d.allowed, `${host} was allowed`).toBe(false);
      expect(d.reason).toBe("watermarked_stock_preview");
    }
  });

  it("re-hosts with no findable origin are refused, under their own reason", () => {
    const d = openWebSourceDecision({ url: "https://i.pinimg.com/564x/ab.jpg" });
    expect(d.allowed).toBe(false);
    // A separate reason from the watermark one: they fail for different causes and the log says which.
    expect(d.reason).toBe("rehosted_no_provenance");
  });

  it("a URL with no host is refused rather than fetched", () => {
    const d = openWebSourceDecision({ url: "javascript:void(0)" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_host");
    expect(d.host).toBeNull();
  });

  it("the operator's blacklist refuses a site that would otherwise pass", () => {
    const d = openWebSourceDecision({
      url: "https://news.example.com/a.jpg",
      blockedHosts: ["example.com"],
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("operator_blocked");
  });

  it("the operator's whitelist is EXCLUSIVE once it is set", () => {
    const allowedHosts = ["archives.gov", "bbc.co.uk"];
    expect(
      openWebSourceDecision({ url: "https://www.archives.gov/a.jpg", allowedHosts }).allowed
    ).toBe(true);
    // A subdomain of a listed site is on the list — that is what listing a site means.
    expect(
      openWebSourceDecision({ url: "https://catalog.archives.gov/a.jpg", allowedHosts }).allowed
    ).toBe(true);
    const off = openWebSourceDecision({ url: "https://example.com/a.jpg", allowedHosts });
    expect(off.allowed).toBe(false);
    expect(off.reason).toBe("not_on_operator_allowlist");
  });

  it("THE RULE THAT MUST NOT BREAK: an EMPTY whitelist means no restriction, not 'allow nothing'", () => {
    /**
     * An unset variable that switched the open web off would be a silent, total coverage loss with
     * no log line saying why. Asserted for both the injected empty list and the unset environment.
     */
    expect(
      openWebSourceDecision({ url: "https://example.com/a.jpg", allowedHosts: [] }).allowed
    ).toBe(true);
    withEnv({ OPEN_WEB_ALLOWED_DOMAINS: undefined, OPEN_WEB_BLOCKED_DOMAINS: undefined }, () => {
      expect(openWebSourceDecision({ url: "https://example.com/a.jpg" }).allowed).toBe(true);
    });
    withEnv({ OPEN_WEB_ALLOWED_DOMAINS: "   " }, () => {
      expect(operatorAllowedHosts()).toEqual([]);
      expect(openWebSourceDecision({ url: "https://example.com/a.jpg" }).allowed).toBe(true);
    });
  });

  it("a whitelisted site does NOT get past the watermark list", () => {
    /**
     * A whitelist says which sites the operator is interested in. It does not make a watermarked
     * comp usable — that refusal is about the FILE, and the order of the checks is what keeps the
     * two questions apart.
     */
    const d = openWebSourceDecision({
      url: "https://media.gettyimages.com/a.jpg",
      allowedHosts: ["gettyimages.com"],
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("watermarked_stock_preview");
  });

  it("both built-in lists are non-empty and disjoint", () => {
    expect(WATERMARKED_STOCK_HOSTS.length).toBeGreaterThan(5);
    expect(REHOSTED_IMAGE_HOSTS.length).toBeGreaterThan(0);
    for (const h of REHOSTED_IMAGE_HOSTS) {
      expect(WATERMARKED_STOCK_HOSTS).not.toContain(h);
    }
  });
});

/* ═══════════════════════ 3. the environment lists ═══════════════════════ */

describe("RONDE 140 §3 — the operator's lists come from the environment, read at call time", () => {
  it("commas, spaces, leading dots and www. all parse to the same host", () => {
    expect(parseHostList("example.com, .foo.org  www.bar.net")).toEqual([
      "example.com",
      "foo.org",
      "bar.net",
    ]);
    expect(parseHostList("")).toEqual([]);
    expect(parseHostList(undefined)).toEqual([]);
  });

  it("a change in the environment takes effect without a reimport", () => {
    // Read at call time rather than captured at import — the same shape allowOperatorLicensedYoutube
    // uses, so a worker picks a change up from its own environment without a code change.
    withEnv({ OPEN_WEB_BLOCKED_DOMAINS: "spam.example" }, () => {
      expect(operatorBlockedHosts()).toEqual(["spam.example"]);
      expect(openWebSourceDecision({ url: "https://spam.example/a.jpg" }).reason).toBe(
        "operator_blocked"
      );
    });
    expect(operatorBlockedHosts()).toEqual([]);
    expect(openWebSourceDecision({ url: "https://spam.example/a.jpg" }).allowed).toBe(true);
  });
});

/* ═══════════════════════ 4. the counters ═══════════════════════ */

describe("RONDE 140 §4 — the policy report counts a denominator, not only refusals", () => {
  it("every decision counts as considered; only refusals count as blocked", () => {
    const stats = createOpenWebPolicyStats();
    noteOpenWebDecision(stats, openWebSourceDecision({ url: "https://archives.gov/a.jpg" }));
    noteOpenWebDecision(stats, openWebSourceDecision({ url: "https://gettyimages.com/a.jpg" }));
    noteOpenWebDecision(stats, openWebSourceDecision({ url: "https://i.pinimg.com/a.jpg" }));
    expect(stats.considered).toBe(3);
    expect(stats.blocked.watermarked_stock_preview).toBe(1);
    expect(stats.blocked.rehosted_no_provenance).toBe(1);
    expect(stats.blocked.operator_blocked).toBe(0);
    const line = formatOpenWebPolicyReport(stats);
    expect(line).toContain("considered=3");
    expect(line).toContain("blocked=2");
    // Every reason is printed even at zero, so an absent reason in a log is unambiguous.
    for (const r of OPEN_WEB_REJECT_REASONS) expect(line).toContain(`${r}=`);
  });

  it("an absent stats object is a no-op, not a crash", () => {
    expect(() =>
      noteOpenWebDecision(undefined, openWebSourceDecision({ url: "https://a.example/a.jpg" }))
    ).not.toThrow();
  });
});

/* ═══════════════════════ 5. what the logs say ═══════════════════════ */

describe("RONDE 140 §5 — the refusal line carries the host and nothing else", () => {
  it("no query string, no token, no full URL", () => {
    const decision = openWebSourceDecision({
      url: "https://media.gettyimages.com/id/515/photo.jpg?s=2048x2048&sig=SECRETTOKEN",
    });
    const line = formatOpenWebReject({ sceneIndex: 3, beatIndex: 1, decision });
    expect(line).toContain("host=media.gettyimages.com");
    expect(line).toContain("reason=watermarked_stock_preview");
    expect(line).not.toContain("SECRETTOKEN");
    expect(line).not.toContain("?");
    expect(line).not.toContain("sig=");
  });

  it("the beat is optional and absent means absent", () => {
    const d = openWebSourceDecision({ url: "https://i.pinimg.com/a.jpg" });
    expect(formatOpenWebReject({ sceneIndex: 0, decision: d })).not.toContain("beat=");
  });
});

/* ═══════════════════════ 6. the usage report ═══════════════════════ */

describe("RONDE 140 §6 — the open-web rights-check list", () => {
  const entry = (over: Partial<OpenWebUsageEntry> = {}): OpenWebUsageEntry => ({
    sceneIndex: 1,
    beatIndex: 0,
    host: "archives.gov",
    sourceUrl: "https://catalog.archives.gov/id/1.jpg",
    visionVerdict: "fits",
    ...over,
  });

  it("nothing used says so, and says it in one line", () => {
    expect(formatOpenWebUsageReport([])).toBe("[OpenWebUsage] used=0");
  });

  it("EVERY entry is UNVERIFIED, and the header says why", () => {
    /**
     * The claim this report must never make. A Google Images result carries a URL and a page title
     * and no rights information at all, so there is nothing here that could be VERIFIED — and the
     * person reading the report is the one who has to check.
     */
    const out = formatOpenWebUsageReport([entry()]);
    expect(out).toContain("UNVERIFIED");
    expect(out).toContain("manual rights check");
    expect(out).not.toContain("VERIFIED\n"); // never the bare word as a status
    expect(out).toContain("used=1");
  });

  it("groups by host, most-used first, so 'which sites' is one glance", () => {
    const out = formatOpenWebUsageReport([
      entry({ host: "rare.example", sceneIndex: 5 }),
      entry({ sceneIndex: 1 }),
      entry({ sceneIndex: 2 }),
    ]);
    expect(out).toContain("hosts=2");
    expect(out).toContain("host=archives.gov clips=2");
    expect(out).toContain("host=rare.example clips=1");
    expect(out.indexOf("host=archives.gov")).toBeLessThan(out.indexOf("host=rare.example"));
  });

  it("an unknown host is labelled, not dropped", () => {
    const out = formatOpenWebUsageReport([entry({ host: null })]);
    expect(out).toContain("host=unknown");
    expect(out).toContain("used=1");
  });
});

/* ═══════════════════════ 7. the wiring ═══════════════════════ */

describe("RONDE 140 §7 — the policy runs before the download, and both lists are printed", () => {
  const pipeline = readCode("server/videoPipeline.ts");
  const serpBody = pipeline.slice(
    pipeline.indexOf("async function fetchSerpAPIImages("),
    pipeline.indexOf("async function padShortClipWithNext(")
  );

  it("fetchSerpAPIImages asks the policy BEFORE it fetches anything", () => {
    expect(serpBody.length).toBeGreaterThan(1000);
    const decided = serpBody.indexOf("openWebSourceDecision(");
    const downloaded = serpBody.indexOf("downloadToFileStreaming(");
    expect(decided).toBeGreaterThan(0);
    expect(downloaded).toBeGreaterThan(0);
    // The whole saving: a host refusal costs no request, no bytes and no shortlist slot.
    expect(decided, "the policy runs after the download").toBeLessThan(downloaded);
    expect(serpBody).toContain("if (!webDecision.allowed) {");
    expect(serpBody).toContain("noteOpenWebDecision(");
  });

  it("the counter lives on the render state, never at module scope", () => {
    // A counter that outlived a render would be a lie the moment two renders shared a worker —
    // the reason searchMemoryMetrics and visualDedupStats sit on VisualDedupState too.
    expect(pipeline).toContain("openWebPolicyStats: createOpenWebPolicyStats(),");
    expect(serpBody).toContain("opts.dedup?.openWebPolicyStats");
    expect(pipeline, "a module-scope counter would leak between renders").not.toMatch(
      /^(const|let) openWebPolicyStats/m
    );
  });

  it("formatYoutubeUsageReport is no longer dead code", () => {
    /**
     * It has existed since RONDE 124 and was never called once. It is the starting point of a
     * manual YouTube rights check, which matters a great deal more now that the operator may
     * switch ALLOW_OPERATOR_LICENSED_YOUTUBE on and needs to see what that admitted.
     */
    // The import names it without a paren, so a `(` match is a CALL and nothing else.
    const calls = pipeline.match(/formatYoutubeUsageReport\(/g) ?? [];
    expect(calls.length, "imported and never called, as it was for sixteen rounds").toBe(1);
    expect(pipeline).toContain("formatYoutubeUsageReport(youtubeEntries)");
    expect(pipeline).toContain("formatOpenWebUsageReport(openWebEntries)");
    expect(pipeline).toContain("formatOpenWebPolicyReport(visualDedup.openWebPolicyStats)");
  });

  it("both lists are built from the ledger's own finalVideoAt, not from a second collector", () => {
    // A second count of "what reached the delivered file" is exactly how two numbers start
    // disagreeing — RONDE 137's whole subject.
    const block = pipeline.slice(
      pipeline.indexOf("const rendered = allRecords.filter((r) => r.finalVideoAt != null);")
    );
    expect(block.length).toBeGreaterThan(500);
    expect(block.slice(0, 2000)).toContain('r.provider === "youtube_cc"');
    expect(block.slice(0, 2000)).toContain('r.provider === "serpapi"');
  });

  it("the YouTube list claims no licence it does not have", () => {
    /**
     * The ledger records where a clip came from, not which licence pass found it, and YouTube's own
     * videoLicense=creativeCommon filter is YouTube's assertion rather than a verification FastVid
     * performed. So the entries are UNVERIFIED with a null licence, which is what is known.
     */
    const block = pipeline.slice(
      pipeline.indexOf("const youtubeEntries: YoutubeUsageEntry[]"),
      pipeline.indexOf("const openWebEntries: OpenWebUsageEntry[]")
    );
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain('licenseStatus: "UNVERIFIED" as const');
    expect(block).toContain("licenseUrl: null");
    expect(block).toContain("rights: null");
    expect(block, "a licence would have to be invented to say this").not.toContain('"VERIFIED"');
  });

  it("the module decides sites, never licences", () => {
    const mod = readCode("server/openWebSourcePolicy.ts");
    // No status vocabulary at all: this module has no metadata to classify, and borrowing
    // youtubeLicenseStatus's words would be the start of exactly the confusion RONDE 124 removed.
    expect(mod).not.toContain('"VERIFIED"');
    expect(mod).not.toContain("OPERATOR_AUTHORIZED");
    expect(mod).not.toContain("classifyArchiveLicense");
  });
});
