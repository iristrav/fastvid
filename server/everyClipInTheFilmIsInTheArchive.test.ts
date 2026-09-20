import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  sourceMayEnterCuratedArchive,
  archiveMetadataForExternalClip,
  type ExternalClipArchiveFacts,
} from "./videoPipeline";

/**
 * THE ARCHIVE HANDLE WAS THE FUNNEL'S PRIVILEGE, AND THE POOL WON BEATS TOO.
 *
 * `storeForProduction` is the only function that turns a downloaded external clip into an
 * `archiveAssetId` attached to THIS render's lineage. The de1c88b audit found it had exactly one
 * call site, behind `winningExternalCandidate` — set only for a funnel winner. The scene-pool
 * route adopted through `recordClipAdopt` → `recordUse` → `formatSelection` and asked for no
 * handle at all, so every clip it won reached the timeline carrying a provider id and nothing of
 * ours.
 *
 * `assetRehydrator` reads `archiveAssetId` first and falls through to the provider without one.
 * YouTube has lived in the scene pool since RONDE 175, and its egress is measurably blocked at
 * intervals — 503 `bot_check` in production on de1c88b — so a pool-won YouTube clip was a timeline
 * asset whose only route home was the one route that intermittently fails.
 *
 * Two routes, one persistence semantic. That is what these tests pin.
 */

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const WORKER = readFileSync(join(__dirname, "worker.ts"), "utf8");
/**
 * The worker with its block comments removed.
 *
 * The comment above the probe QUOTES the defective line so the next reader knows what was wrong
 * and why. A test that greps the raw file therefore finds `if (!res.ok) return null;` forever and
 * can never go green — it would be testing the documentation, not the code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const WORKER_CODE = stripComments(WORKER);
const PROBE = readFileSync(join(__dirname, "youtubeEgressProbe.ts"), "utf8");

/** The scene-pool adoption block, bounded so the assertions cannot wander. */
const POOL = (() => {
  const at = PIPELINE.indexOf("const adopted = poolCandidates.find(");
  expect(at, "the pool adoption block is gone").toBeGreaterThan(0);
  const end = PIPELINE.indexOf("recordUse(", at);
  expect(end).toBeGreaterThan(at);
  return PIPELINE.slice(at, end);
})();

/** The funnel's archive block. */
const FUNNEL = (() => {
  const at = PIPELINE.indexOf("if (archiveEligible && funnelClip && winningExternalCandidate) {");
  expect(at, "the funnel archive block is gone").toBeGreaterThan(0);
  return PIPELINE.slice(at, at + 700);
})();

/** The one shared wrapper both routes go through. */
const WRAPPER = (() => {
  const at = PIPELINE.indexOf("async function storeExternalClipForTimeline(params: {");
  expect(at, "storeExternalClipForTimeline is gone").toBeGreaterThan(0);
  const end = PIPELINE.indexOf("\n// Thin wrapper so fetchSceneVisualsInner", at);
  expect(end).toBeGreaterThan(at);
  return PIPELINE.slice(at, end);
})();

describe("Test 1 — a scene-pool external winner is archived before it is adopted", () => {
  it("the pool route calls the shared store, and awaits it", () => {
    expect(POOL).toContain("await storeExternalClipForTimeline({");
    expect(POOL).toContain('route: "pool",');
    expect(POOL).toContain("clipPath: poolClip,");
  });

  it("IT RUNS BEFORE recordClipAdopt — afterwards is 'attempted', not 'guaranteed'", () => {
    const storeAt = POOL.indexOf("await storeExternalClipForTimeline({");
    const adoptAt = POOL.indexOf("recordClipAdopt(");
    expect(storeAt).toBeGreaterThan(0);
    expect(adoptAt).toBeGreaterThan(storeAt);
  });

  it("it is not fire-and-forget on either route", () => {
    /** `void` here would reintroduce exactly the defect: adopted now, archived maybe. */
    expect(POOL).not.toContain("void storeExternalClipForTimeline");
    expect(FUNNEL).not.toContain("void storeExternalClipForTimeline");
    expect(FUNNEL).toContain("await storeExternalClipForTimeline({");
    expect(FUNNEL).toContain('route: "funnel",');
  });

  it("THE HANDLE IS ATTACHED TO THE LEDGER, which is the whole point", () => {
    expect(WRAPPER).toContain("params.lineage?.attachArchiveAssetToPath(");
    expect(WRAPPER).toContain("clipPath, stored.archiveAssetId, clipContentKey(clipPath)");
  });

  it("both routes go through ONE store — there is no second archive path", () => {
    const calls = PIPELINE.split("await storeForProduction({").length - 1;
    expect(calls, "storeForProduction is called from more than the shared wrapper").toBe(1);
    const inWrapper = WRAPPER.includes("await storeForProduction({");
    expect(inWrapper, "the single storeForProduction call is not inside the shared wrapper").toBe(true);
  });
});

describe("Test 2 — an archive failure is never silent, and never fails the render", () => {
  /**
   * The brief allowed either "clip NOT adopted" or "the existing safe failure/recovery
   * semantics". The funnel has had the second since the handle first existed, deliberately:
   * "It does not stop the render and it does not invent a reference. The beat keeps the identity
   * it already had … so a storage outage costs the render its archive handle and nothing else."
   *
   * Making the pool route fail a beat on a storage outage would give the two routes DIFFERENT
   * semantics again — the exact thing this round removes — and would let an S3 blip cost a render.
   * So both routes keep that behaviour, and what is pinned here is that the failure is NAMED.
   */
  it("a failed store is named, with its route and its cause", () => {
    /**
     * UNIVERSAL-INVARIANT ROUND — one message became two, because a failed store means two
     * different things depending on where it happened. On the four EAGER routes the push gate will
     * still decide; at the gate itself there is no second chance and the clip is refused. Saying
     * the wrong one is how a log stops being evidence.
     */
    expect(WRAPPER).toContain("ARCHIVE_NOT_READY_AT_PUSH");
    expect(WRAPPER).toContain("ARCHIVE_STORE_FAILED_BEFORE_PUSH");
    expect(WRAPPER).toContain('route === "push_gate"');
    expect(WRAPPER).toContain("route=${route}");
    expect(WRAPPER).toContain("code=${stored.code}");
    expect(WRAPPER).toContain("status=${stored.mediaStatus}");
  });

  it("a thrown store is caught and named, not swallowed", () => {
    expect(WRAPPER).toContain('code: "ARCHIVE_RECORD_FAILED"');
    expect(WRAPPER).toContain('mediaStatus: "FAILED"');
    /** An empty catch is how this became invisible in the first place. */
    expect(WRAPPER).not.toMatch(/catch\s*\{\s*\}/);
  });

  it("a stored-but-unattachable handle is also named", () => {
    expect(WRAPPER).toContain("ARCHIVE_ASSET_UNATTACHED");
  });
});

describe("Test 3 — an already-archived candidate is not ingested twice", () => {
  /**
   * Not a new mechanism: `storeForProduction` answers this itself and reports HOW. Both lookups
   * require `mediaStatus = READY`, so a half-written earlier attempt is not mistaken for a hit.
   */
  const ARCHIVE = readFileSync(join(__dirname, "productionMediaArchive.ts"), "utf8");
  const DB = readFileSync(join(__dirname, "db.ts"), "utf8");

  it("the store reports reuse and how it was decided", () => {
    expect(ARCHIVE).toContain("reused: boolean;");
    expect(ARCHIVE).toContain('reusedBy: "checksum" | "provider_asset_id" | null;');
  });

  it("BOTH dedup lookups require READY — a failed attempt is not a hit", () => {
    const byChecksum = DB.indexOf("export async function findMediaArchiveAssetByChecksum");
    const byProvider = DB.indexOf("export async function findMediaArchiveAssetByProviderAsset");
    expect(byChecksum).toBeGreaterThan(0);
    expect(byProvider).toBeGreaterThan(0);
    expect(DB.slice(byChecksum, byChecksum + 700)).toContain('eq(mediaArchiveAssets.mediaStatus, "READY")');
    expect(DB.slice(byProvider, byProvider + 900)).toContain('eq(mediaArchiveAssets.mediaStatus, "READY")');
  });

  it("the pool route passes the file it already has — nothing is downloaded again", () => {
    expect(POOL).toContain("clipPath: poolClip,");
    expect(WRAPPER).toContain("localPath: clipPath,");
    /** The only fetch in the wrapper is the archive's own read-back verification. */
    expect(WRAPPER).toContain('"productionArchive:readBack"');
  });
});

describe("Test 4 — RONDE 9's exception is intact", () => {
  it("stock footage still may not enter the curated archive", () => {
    expect(sourceMayEnterCuratedArchive("pexels")).toBe(false);
    expect(sourceMayEnterCuratedArchive("pixabay")).toBe(false);
    expect(sourceMayEnterCuratedArchive("PEXELS")).toBe(false);
    expect(sourceMayEnterCuratedArchive("  Pixabay ")).toBe(false);
  });

  it("the curated archive is not stored into itself", () => {
    expect(sourceMayEnterCuratedArchive("archive")).toBe(false);
  });

  it("every authentic source still may — including YouTube", () => {
    for (const s of [
      "youtube_cc", "wikimedia", "internet_archive", "europeana",
      "openverse", "nasa", "nara", "loc",
    ]) {
      expect(sourceMayEnterCuratedArchive(s), `${s} must be archivable`).toBe(true);
    }
  });

  it("BOTH routes ask the same predicate — that is why they cannot disagree again", () => {
    expect(FUNNEL.length + POOL.length).toBeGreaterThan(0);
    const eligAt = PIPELINE.indexOf("const archiveEligible = !!(");
    expect(PIPELINE.slice(eligAt, eligAt + 600)).toContain(
      "sourceMayEnterCuratedArchive(winningExternalCandidate.source)"
    );
    expect(POOL).toContain("sourceMayEnterCuratedArchive(adopted.source)");
  });

  it("and both still honour the ingestion switch", () => {
    const eligAt = PIPELINE.indexOf("const archiveEligible = !!(");
    expect(PIPELINE.slice(eligAt, eligAt + 600)).toContain("externalAssetIngestionEnabled()");
    expect(POOL).toContain("externalAssetIngestionEnabled()");
  });
});

describe("Test 5a — the rescue routes are in the film, so they are archived too", () => {
  /**
   * The audit found `ingestExternalClipToArchive` at three sites with the assetId discarded. Two
   * of them — Europeana web-wide and the Openverse still-to-video fallback — `return` the clip on
   * the very next line, so that clip IS the beat's picture. The comment above one of them read
   * "never blocks the current video, which already has its clip", which is the right reasoning for
   * a runner-up and the wrong one here.
   */
  const RESCUE = (() => {
    const at = PIPELINE.indexOf("const euroHits = await fetchEuropeanaVideos(");
    expect(at, "the Europeana rescue route is gone").toBeGreaterThan(0);
    const end = PIPELINE.indexOf("if (coercePersonName(personName) && !historicalDoc) {", at);
    expect(end).toBeGreaterThan(at);
    return PIPELINE.slice(at, end);
  })();

  it("both rescue winners go through the shared store, awaited", () => {
    const calls = RESCUE.split("await storeExternalClipForTimeline({").length - 1;
    expect(calls, "a rescue winner is still archived fire-and-forget").toBe(2);
    expect(RESCUE).toContain('route: "rescue",');
  });

  it("NEITHER DISCARDS THE HANDLE ANY MORE", () => {
    expect(stripComments(RESCUE)).not.toContain("void ingestExternalClipToArchive(");
    /** And the comment still records what it was, so the next reader is not left guessing. */
    expect(RESCUE).toContain("It was `void ingestExternalClipToArchive(...)`");
  });

  it("each one is the clip that is returned, which is why it needed a handle", () => {
    const euroStore = RESCUE.indexOf("clipPath: euroClip!,");
    const euroReturn = RESCUE.indexOf("return euroClip;");
    expect(euroStore).toBeGreaterThan(0);
    expect(euroReturn).toBeGreaterThan(euroStore);
    const webStore = RESCUE.indexOf("clipPath: webWideClip!,");
    const webReturn = RESCUE.indexOf("return webWideClip;");
    expect(webStore).toBeGreaterThan(0);
    expect(webReturn).toBeGreaterThan(webStore);
  });

  it("THEIR PROVENANCE IS UNCHANGED — only the discarding stopped", () => {
    /**
     * These two routes keep their own metadata literal, passed straight through. Re-routing them
     * onto the shared builder would have silently rewritten `sourceNote` and `tags` for material
     * already in the archive, which is a different change than the one this round is making.
     */
    /** Counted, not merely present: both routes carry it, so `toContain` passes on either one. */
    const noteCount = RESCUE.split("sourceNote: `webwide:${winner.sourcePlatform}`").length - 1;
    expect(noteCount, "a rescue route's sourceNote was rewritten").toBe(2);
    expect(RESCUE).toContain("matchedQuery: winner.query,");
    expect(RESCUE).toContain("matchedQuery: winner.matchedQuery,");
  });

  it("a route with no provider asset id says so rather than inventing one", () => {
    expect(RESCUE).toContain("providerAssetId: null,");
    expect(RESCUE).not.toContain('providerAssetId: "unknown"');
  });
});

describe("Test 5 — runners-up keep their background ingestion", () => {
  /**
   * The invariant is about clips entering the CURRENT timeline. A runner-up is kept for FUTURE
   * renders' searches; nothing in this render waits on it, and making it awaitable would spend a
   * beat's budget on an asset the beat is not using.
   */
  it("the runner-up path is still fire-and-forget", () => {
    const at = PIPELINE.indexOf("const queueArchiveIngestion = (");
    expect(at).toBeGreaterThan(0);
    const body = PIPELINE.slice(at, at + 500);
    expect(body).toContain("void (async () => {");
    expect(body).toContain("await ingestExternalClipToArchive(clipPath, archiveMetadataFor(wec));");
  });

  it("and it builds its provenance from the SAME literal as the winner", () => {
    /** Two copies would be two chances for one clip to be archived under different provenance. */
    const literals = PIPELINE.split("export function archiveMetadataForExternalClip(").length - 1;
    expect(literals).toBe(1);
    expect(PIPELINE).toContain("archiveMetadataForExternalClip(archiveFactsFor(wec), {");
    expect(POOL).toContain("archiveMetadataForExternalClip(facts, {");
  });

  it("the shared provenance keeps RONDE 9's and RONDE 28's rules", () => {
    const facts: ExternalClipArchiveFacts = {
      source: "youtube_cc",
      providerAssetId: "youtube_cc:abc123",
      title: "Kim Kardashian interview 2018",
      mediaType: "video",
      license: "CC BY 3.0",
      licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
      durationSec: 41,
      sourceCreator: "Some Channel",
      remoteUrl: "https://example.invalid/v.mp4",
    };
    const md = archiveMetadataForExternalClip(facts, {
      beatQuery: "kim kardashian 2018",
      personContext: true,
      topics: ["kardashian"],
    });
    // RONDE 9: narration keywords describe what is SAID, never what is SHOWN.
    expect(md.tags).toEqual([]);
    // RONDE 28: the query that found it, not the asset's title.
    expect(md.matchedQuery).toBe("kim kardashian 2018");
    expect(md.originalQuery).toBe("kim kardashian 2018");
    expect(md.title).toBe("Kim Kardashian interview 2018");
    // FASE 1: the provider's own per-asset licence beats the per-source literal.
    expect(md.licenseNote).toBe("CC BY 3.0");
    expect(md.sourcePlatform).toBe("youtube_cc");
    expect(md.sourceNote).toBe("youtube_cc:youtube_cc:abc123");
    expect(md.mimeType).toBe("video/mp4");
    expect(md.personContext).toBe(true);
  });

  it("the per-source licence fallback only applies when the provider gave none", () => {
    const base = { providerAssetId: "x", title: "t", mediaType: "video" as const };
    expect(archiveMetadataForExternalClip(
      { ...base, source: "wikimedia" }, { beatQuery: "q", personContext: false, topics: [] }
    ).licenseNote).toBe("CC BY-SA / CC0");
    expect(archiveMetadataForExternalClip(
      { ...base, source: "nara" }, { beatQuery: "q", personContext: false, topics: [] }
    ).licenseNote).toBe("Public Domain (NARA / U.S. Government Work)");
    expect(archiveMetadataForExternalClip(
      { ...base, source: "youtube_cc" }, { beatQuery: "q", personContext: false, topics: [] }
    ).licenseNote).toBeUndefined();
  });
});

describe("Test 6 — a YouTube pool winner reaches the archive", () => {
  it("youtube_cc is a pool source, so this is the route it actually takes", () => {
    const POOLSRC = readFileSync(join(__dirname, "scenePool.ts"), "utf8");
    expect(POOLSRC).toContain('| "youtube_cc"');
  });

  it("nothing in the pool archive branch is provider-specific", () => {
    /**
     * The fix must not be a YouTube special case. The branch asks one predicate about the source
     * and otherwise treats every archivable provider identically.
     */
    const branch = POOL.slice(POOL.indexOf("if (\n            adopted &&"));
    expect(branch).not.toMatch(/youtube/i);
    expect(branch).not.toMatch(/wikimedia/i);
    expect(branch).toContain("sourceMayEnterCuratedArchive(adopted.source)");
  });

  it("the identity it stores is the pool's own stable key, not a filename", () => {
    expect(POOL).toContain('providerAssetId: String(adopted.id ?? adopted.assetId ?? "").trim() || null,');
  });
});

describe("Test 7 — rehydration prefers the archive, and the YouTube fallback is untouched", () => {
  const REHY = readFileSync(join(__dirname, "assetRehydrator.ts"), "utf8");

  it("the archive branch is tried on the ID ALONE, before any provider", () => {
    const archiveAt = REHY.indexOf("if (identity.archiveAssetId != null) {");
    const ytAt = REHY.indexOf('if (provider === "youtube" || provider === "youtube_cc") {');
    expect(archiveAt).toBeGreaterThan(0);
    expect(ytAt).toBeGreaterThan(archiveAt);
    expect(REHY).toContain("RONDE 148 — the condition is `archiveAssetId != null` ALONE");
  });

  it("A HANDLE MEANS THE ASSET IS RECOVERABLE WITHOUT THE PROVIDER", () => {
    const at = REHY.indexOf("if (identity.archiveAssetId != null) return true;");
    expect(at).toBeGreaterThan(0);
  });

  it("without a handle the YouTube route still goes through the licence layer — unchanged", () => {
    const at = REHY.indexOf('if (provider === "youtube" || provider === "youtube_cc") {');
    const body = REHY.slice(at, at + 900);
    expect(body).toContain("if (!deps.youtubeResolver) {");
    expect(body).toContain('"REHYDRATION_NOT_AUTHORIZED"');
    expect(body).toContain("refusing rather than bypassing it");
  });
});

describe("the worker egress probe reads the answer, not the status code", () => {
  it("THE `!res.ok` LINE IS GONE — a 503 is what the service says when YouTube blocks it", () => {
    expect(WORKER_CODE).not.toContain("if (!res.ok) return null;");
    /** And the comment still explains it, so the next reader is not left guessing. */
    expect(WORKER).toContain("The STATUS is not");
  });

  it("there is one reader of the contract again", () => {
    expect(WORKER).toContain("canReachYoutubeEgress: async () => askYoutubeEgress(");
    expect(WORKER).toContain('import { askYoutubeEgress } from "./youtubeEgressProbe";');
    /** No second inline copy of the request anywhere in the worker. */
    /**
     * Scoped to the endpoint, not to `fetch` — the worker legitimately probes other things. What
     * may not exist twice is a second reader of THIS contract.
     */
    expect(WORKER_CODE).not.toContain("/health/egress");
  });

  it("the canonical reader reads the BODY", () => {
    expect(PROBE).toContain("const body = (await res.json().catch(() => null))");
    expect(PROBE).toContain('if (typeof body?.ok !== "boolean")');
    expect(PROBE).toContain("return { ok: body.ok, reason: body.reason ?? undefined };");
    /** Reading the status is the defect this round removed from worker.ts. */
    expect(PROBE).not.toContain("if (!res.ok) return null;");
  });

  it("a blocked verdict still becomes a named refusal, not a timeout", () => {
    expect(PROBE).toContain("return `cloud_egress_${verdict.reason ?? \"blocked\"}`;");
    expect(PROBE).toContain("if (!verdict || verdict.ok) return null;");
  });

  it("NEITHER TIMEOUT WAS TUNED — the hypothesis is measured, not guessed at", () => {
    expect(PROBE).toContain("export const YOUTUBE_EGRESS_PROBE_TIMEOUT_MS = 3_000;");
    expect(PROBE).toContain("export const YOUTUBE_EGRESS_CACHE_MS = 30_000;");
    expect(WORKER).toContain("const WORKER_EGRESS_PROBE_TIMEOUT_MS = 25_000;");
  });

  it("and the probe now says how long the answer took", () => {
    expect(PROBE).toContain("[YouTubeEgress] status=${status}");
    expect(PROBE).toContain("durationMs=${Date.now() - startedAt}");
    /**
     * EVERY outcome, not only the failures. The open question is whether a BLOCKED service is
     * slower than a healthy one, and that cannot be answered from the blocked timings alone —
     * the healthy ones are the baseline the comparison needs.
     */
    expect(PROBE).toContain('noteProbeTiming(startedAt, "no_answer");');
    expect(PROBE).toContain('noteProbeTiming(startedAt, res.status, "unreadable_body");');
    expect(PROBE).toContain(
      'noteProbeTiming(startedAt, res.status, body.reason ?? (body.ok ? "reachable" : "blocked"));'
    );
  });

  it("the latch and the RapidAPI fallback are untouched", () => {
    expect(PIPELINE).toContain("if (thrownAs === \"DOWNLOAD_TIMEOUT\" && !cloudEgressRefusal()) {");
    expect(PIPELINE).toContain("if (noteCloudEgressBlocked(videoId, blocked)) {");
    expect(PIPELINE).toContain("cloud route is skipped for the rest of this render.");
    expect(PIPELINE).toContain("falling back to RapidAPI");
  });
});

describe("what this round did not touch", () => {
  it("the operator authorisation default is still ON unless literally false", () => {
    const LIC = readFileSync(join(__dirname, "youtubeLicenseStatus.ts"), "utf8");
    expect(LIC).toContain(
      'return process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE?.trim().toLowerCase() !== "false";'
    );
  });

  it("the subject anchor, the archive router and the per-source caps are where they were", () => {
    expect(PIPELINE).toContain("ensureSubjectAnchor(q, stockSubjectAnchor)");
    expect(PIPELINE).toContain("capCandidatesPerSource(poolCandidates, before)");
    const CURATED = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(CURATED).toContain("NO_RELEVANT_ARCHIVE");
  });
});
