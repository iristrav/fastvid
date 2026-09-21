import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  sourceMayEnterCuratedArchive,
  archiveMetadataForExternalClip,
  type ExternalClipArchiveFacts,
} from "./videoPipeline";

/**
 * TWENTY-FIVE ROUTES, ONE BOUNDARY.
 *
 * The previous round made the funnel, the scene pool and the two web-wide rescue routes
 * archive-first, and reported honestly that the historical tier cascade — some twenty-five
 * `adoptClip` call sites — could still put a Wikimedia, NASA, Openverse or SerpAPI clip in the
 * film with no handle of ours.
 *
 * Twenty-five patches would be twenty-four chances to forget. The codebase had already named the
 * single point, twice: RONDE 93 ("the `clips.push` inside the four scene-push variants is where a
 * picture actually enters the film") and RONDE 232 ("there are four `pushSceneClip` definitions
 * and every one of them opens with this call"). That call is
 * `beatClipRefusedByRelevanceGate`, and one of its five call sites lives inside
 * `fetchSceneVisualsInner`, where the funnel, the pool, the cascade and the rescue ladders all
 * end.
 *
 * These tests pin the invariant at that boundary, prove it is not provider-specific and not
 * subject-specific, and pin the four exemptions as the deliberate categories they are.
 */

const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The universal gate. */
const GATE = (() => {
  const at = PIPELINE.indexOf("export async function beatClipRefusedByRelevanceGate(");
  expect(at, "the universal push gate is gone").toBeGreaterThan(0);
  const end = PIPELINE.indexOf("async function relevanceGateRefusesClip(", at);
  expect(end).toBeGreaterThan(at);
  return PIPELINE.slice(at, end);
})();

/** The archive decision the gate makes. */
const DECIDER = (() => {
  const at = PIPELINE.indexOf("async function ensureArchiveBackedBeforePush(");
  expect(at, "the archive decision is gone").toBeGreaterThan(0);
  const end = PIPELINE.indexOf("export async function beatClipRefusedByRelevanceGate(", at);
  expect(end).toBeGreaterThan(at);
  return PIPELINE.slice(at, end);
})();

describe("the boundary is the one every picture crosses", () => {
  it("every scene-push variant opens with the gate — five call sites, no exceptions", () => {
    const calls = [...PIPELINE.matchAll(/await beatClipRefusedByRelevanceGate\(/g)];
    expect(calls.length, "a push route stopped asking the gate").toBe(5);
    /** And every one of them refuses the push on a true answer. */
    for (const m of calls) {
      const line = PIPELINE.slice(m.index!, PIPELINE.indexOf("\n", m.index!));
      expect(line, `a gate call site ignores the answer: ${line}`).toContain("return false;");
    }
  });

  it("ONE OF THEM IS INSIDE fetchSceneVisualsInner — where the cascade actually ends", () => {
    /**
     * This is the whole argument for choosing this boundary: the funnel, the scene pool, the
     * historical tier cascade and the rescue ladders all place their picture from inside this
     * function, so a gate here covers all of them at once.
     */
    const fn = PIPELINE.indexOf("async function fetchSceneVisualsInner(");
    expect(fn).toBeGreaterThan(0);
    const next = PIPELINE.indexOf("\nasync function ", fn + 10);
    const body = PIPELINE.slice(fn, next > fn ? next : PIPELINE.length);
    expect(body).toContain("await beatClipRefusedByRelevanceGate(");
  });

  it("the editorial answer is asked FIRST — a refused clip is never stored", () => {
    /**
     * Storing on the way out would ingest every candidate the picture editor turned away, which
     * is the archive poisoning RONDE 9 exists to prevent, arriving through the back door.
     */
    const editorialAt = GATE.indexOf("if (await relevanceGateRefusesClip(");
    const archiveAt = GATE.indexOf("await ensureArchiveBackedBeforePush(");
    expect(editorialAt).toBeGreaterThan(0);
    expect(archiveAt).toBeGreaterThan(editorialAt);
  });

  it("the editorial gate itself is untouched — it was renamed, not rewritten", () => {
    expect(PIPELINE).toContain("async function relevanceGateRefusesClip(");
    expect(PIPELINE).toContain("const barrier = composeBarrierAllows(");
    expect(PIPELINE).toContain("if (barrier.allow) return false;");
  });
});

describe("§18 — THE SWEEP: no push closure exists outside the invariant", () => {
  /**
   * The proof the round asks for, and the reason a list is not one.
   *
   * This does not enumerate routes. It finds every closure in the pipeline that actually places a
   * picture — the `pushClip` / `pushSceneClip` definitions, which RONDE 93 identified as the
   * narrowest point at which a clip becomes a beat's clip — and requires each to reach the archive
   * invariant, either through the universal gate or by asking `ensureArchiveBackedBeforePush`
   * directly. A closure added tomorrow appears here on its own; nobody has to remember to list it.
   *
   * It is what caught the one genuine hole this round: `rescueFastShortComposeClips` has its own
   * editorial gate (`montageClipPassesComposeGate`) and never passed through the relevance gate,
   * so a picture it placed was outside the invariant. Having a different editorial question is not
   * a reason to be outside the ARCHIVE one.
   */
  const SRC_LINES = PIPELINE.split("\n");
  const FN_STARTS: Array<[number, string]> = [];
  SRC_LINES.forEach((l, i) => {
    const m = /^(?:export )?(?:async )?function (\w+)/.exec(l);
    if (m) FN_STARTS.push([i, m[1]!]);
  });
  const enclosingBody = (lineNo: number): { name: string; body: string } => {
    let cur: [number, string] | null = null;
    for (const s of FN_STARTS) {
      if (s[0] <= lineNo) cur = s;
      else break;
    }
    const k = FN_STARTS.findIndex((s) => s[0] === cur![0]);
    const end = k + 1 < FN_STARTS.length ? FN_STARTS[k + 1]![0] : SRC_LINES.length;
    return { name: cur![1], body: SRC_LINES.slice(cur![0], end).join("\n") };
  };

  const CLOSURES = [...PIPELINE.matchAll(/const (?:pushSceneClip|pushClip)\s*=\s*async\s*\(/g)].map(
    (m) => enclosingBody(PIPELINE.slice(0, m.index!).split("\n").length - 1)
  );

  it("there are push closures to check, and every one of them is found", () => {
    expect(CLOSURES.length, "the push closures moved or were renamed").toBe(6);
  });

  it("EVERY PUSH CLOSURE REACHES THE ARCHIVE INVARIANT — not archive-backed = 0", () => {
    const ungated = CLOSURES.filter(
      (c) =>
        !c.body.includes("beatClipRefusedByRelevanceGate(") &&
        !c.body.includes("ensureArchiveBackedBeforePush(")
    ).map((c) => c.name);
    expect(
      ungated,
      `routes that can place a picture outside the archive invariant: ${ungated.join(", ")}`
    ).toEqual([]);
  });

  it("and the rescue with its own editorial gate asks the archive question anyway", () => {
    const rescue = CLOSURES.find((c) => c.name === "rescueFastShortComposeClips");
    expect(rescue, "rescueFastShortComposeClips is gone").toBeTruthy();
    /** Its own gate is kept — a different editorial question, correctly so. */
    expect(rescue!.body).toContain("montageClipPassesComposeGate(");
    expect(rescue!.body).toContain("await ensureArchiveBackedBeforePush(");
    expect(rescue!.body).toContain("recordArchivePushRefusal(dedup, clipPath, scene.index, undefined, archived.reason)");
  });

  it("both gates refuse in ONE spelling", () => {
    expect((PIPELINE.match(/function recordArchivePushRefusal\(/g) ?? []).length).toBe(1);
    expect((PIPELINE.match(/recordArchivePushRefusal\(/g) ?? []).length).toBe(3); // 1 definition + 2 callers
  });
});

describe("Tests 16/17 — an archive failure prevents adoption", () => {
  it("A FAILED STORE REFUSES THE PUSH", () => {
    expect(GATE).toContain("if (archived.ok) return false;");
    expect(GATE).toMatch(
      /recordArchivePushRefusal\(dedup, clipPath, sceneIndex, beatIndex, archived\.reason\);\s*\n\s*return true;/
    );
    /** The refusal itself, in the one function both gates call. */
    const at = PIPELINE.indexOf("function recordArchivePushRefusal(");
    expect(at).toBeGreaterThan(0);
    const body = PIPELINE.slice(at, at + 1200);
    expect(body).toContain("const reason = `archive not ready (${cause})`;");
    expect(body).toContain("tracePushOutcome(dedup, clipPath, sceneIndex, beatIndex, false, reason);");
  });

  it("and the refusal is recorded like every other refusal, not swallowed", () => {
    const at = PIPELINE.indexOf("function recordArchivePushRefusal(");
    const body = PIPELINE.slice(at, at + 1200);
    expect(body).toContain("recordRejection(clipPath, reason, clipContentKey(clipPath))");
    expect(body).toContain("recordClipReject(dedup.clipRejectAudit, sceneIndex, beatIndex, clipPath, reason)");
  });

  it("the store is AWAITED — 'archive later' is the thing being removed", () => {
    expect(GATE).toContain("const archived = await ensureArchiveBackedBeforePush(");
    expect(GATE).not.toContain("void ensureArchiveBackedBeforePush");
    expect(DECIDER).toContain("const stored = await storeExternalClipForTimeline({");
  });
});

describe("Tests 1–9 — every provider, decided by one rule", () => {
  /**
   * The point of the round: the invariant is architectural. It reads a provider name from the
   * lineage record and asks one predicate — it does not know which provider it is looking at.
   */
  const ARCHIVABLE = [
    "youtube_cc", "wikimedia", "openverse", "internet_archive",
    "sepiasearch", "europeana", "nara", "loc", "nasa",
  ];

  for (const provider of ARCHIVABLE) {
    it(`${provider} winner must be archived before adoption`, () => {
      expect(sourceMayEnterCuratedArchive(provider)).toBe(true);
    });
  }

  it("NOTHING IN THE DECISION NAMES A PROVIDER", () => {
    /**
     * A provider-specific branch here would be the fix this round refused to make. The decision
     * reads `root.provider` and asks `sourceMayEnterCuratedArchive`; it spells no provider out.
     */
    const code = stripComments(DECIDER);
    for (const provider of [...ARCHIVABLE, "pexels", "pixabay"]) {
      expect(code, `the archive decision special-cases ${provider}`).not.toContain(provider);
    }
    expect(code).toContain("sourceMayEnterCuratedArchive(provider)");
  });

  it("the provider is READ FROM THE LEDGER, never guessed from a filename", () => {
    expect(DECIDER).toContain("const record = ledger?.resolve(clipPath, contentKey) ?? null;");
    expect(DECIDER).toContain('const provider = root?.provider?.trim().toLowerCase() || null;');
    const code = stripComments(DECIDER);
    expect(code).not.toContain("basename(clipPath).split");
    expect(code).not.toContain("inferClipSourceFromPath");
  });

  it("A TRIMMED OR TRANSFORMED FILE IS JUDGED BY THE ASSET IT WAS MADE FROM", () => {
    /** Otherwise a fair-use transform would look like an independent source with no provider. */
    expect(DECIDER).toContain("ledger.rootOf(record.lineageId) ?? record");
  });
});

describe("Tests 10–15 — the routes", () => {
  const ROUTES: Array<[string, string]> = [
    ["funnel", 'route: "funnel",'],
    ["scene pool", 'route: "pool",'],
    ["rescue (both web-wide routes)", 'route: "rescue",'],
    ["historical cascade / everything else", 'route: "push_gate",'],
  ];

  for (const [name, marker] of ROUTES) {
    it(`${name} stores through the shared wrapper`, () => {
      expect(PIPELINE).toContain(marker);
    });
  }

  it("the rescue marker appears on BOTH web-wide routes", () => {
    expect(PIPELINE.split('route: "rescue",').length - 1).toBe(2);
  });

  it("THERE IS STILL EXACTLY ONE storeForProduction CALL SITE", () => {
    expect((PIPELINE.match(/await storeForProduction\(\{/g) ?? []).length).toBe(1);
    const wrapper = PIPELINE.indexOf("async function storeExternalClipForTimeline(params: {");
    const call = PIPELINE.indexOf("await storeForProduction({");
    expect(call).toBeGreaterThan(wrapper);
  });

  it("the four eager routes remain, because the gate is a backstop and not a replacement", () => {
    /**
     * They store earlier and carry their route's own richer provenance; the gate guarantees no
     * route can skip the step. A clip they stored reaches the gate already archived.
     */
    expect((PIPELINE.match(/await storeExternalClipForTimeline\(\{/g) ?? []).length).toBe(5);
  });

  /**
   * AN ALREADY-ARCHIVED CLIP IS EXEMPT — AND THE EXEMPTION NOW CARRIES THE HANDLE.
   *
   * ── What this assertion used to be ──────────────────────────────────────────────────────
   *
   * One exact line:
   *
   *     if (root.archiveAssetId != null) return { ok: true, reason: "already_archived" };
   *
   * Round 596 deliberately made that branch do more, because the line was the defect. The gate
   * reads the lineage ROOT and the cinematic planner reads the record AT THE PATH, so a root
   * archived after its child was created took the exemption while the timeline kept reading
   * `archiveAssetId=null` — render 595's `vc_999c384232`, never offered to the archive at all.
   *
   * ── What is asserted instead ────────────────────────────────────────────────────────────
   *
   * The four properties the exemption must have, none of them tied to one line's formatting:
   * it is decided on the root's handle, it answers `already_archived`, it stores NOTHING, and it
   * passes the handle on. The `ARCHIVE_HANDLE_INHERITED` semantics are exercised against the real
   * ledger in `theHandleReachesTheRowTheTimelineReads.test.ts`; `ensureArchiveBackedBeforePush`
   * is not exported, so its own branching is read here.
   */
  describe("the already-archived exemption", () => {
    /** The branch, by brace matching, so indentation and line breaks are not the contract. */
    const BRANCH = (() => {
      const at = DECIDER.indexOf("if (root.archiveAssetId != null)");
      expect(at, "the already-archived exemption is gone").toBeGreaterThan(-1);
      const end = DECIDER.indexOf('reason: "already_archived" }', at);
      expect(end, "the exemption no longer answers already_archived").toBeGreaterThan(at);
      return DECIDER.slice(at, end);
    })();

    it("is decided on the ROOT's handle, and answers ok:true / already_archived", () => {
      expect(DECIDER).toMatch(/if \(root\.archiveAssetId != null\)/);
      expect(DECIDER).toMatch(/ok:\s*true,\s*reason:\s*"already_archived"/);
    });

    it("STORES NOTHING — the asset is already held, and §14 keeps one row per file", () => {
      expect(stripComments(BRANCH)).not.toContain("storeExternalClipForTimeline");
      expect(stripComments(BRANCH)).not.toContain("storeForProduction");
      expect(stripComments(BRANCH)).not.toContain("deps.ingest");
    });

    it("AND PASSES THE HANDLE TO THE ROW THE TIMELINE READS", () => {
      /**
       * The RC-1 fix. Without this the exemption is the render-595 defect again: a handle read
       * from one row and a null delivered from another.
       */
      expect(BRANCH).toContain("attachArchiveAsset(record, root.archiveAssetId)");
      expect(BRANCH).toContain("ARCHIVE_HANDLE_INHERITED");
      /** Onto the record at the path — attaching to the root would change nothing. */
      expect(BRANCH).not.toContain("attachArchiveAsset(root,");
    });

    it("and the gate still reads the record the planner reads", () => {
      expect(PIPELINE).toContain("const record = lineage.resolve(clipPath, clipContentKey(clipPath));");
    });
  });
});

describe("Test 18/19 — reuse, and no second download", () => {
  const ARCHIVE = readFileSync(join(__dirname, "productionMediaArchive.ts"), "utf8");
  const DB = readFileSync(join(__dirname, "db.ts"), "utf8");

  it("an already-READY archive asset is reused, by checksum or provider asset id", () => {
    expect(ARCHIVE).toContain("reused: boolean;");
    expect(ARCHIVE).toContain('reusedBy: "checksum" | "provider_asset_id" | null;');
    for (const fn of [
      "export async function findMediaArchiveAssetByChecksum",
      "export async function findMediaArchiveAssetByProviderAsset",
    ]) {
      const at = DB.indexOf(fn);
      expect(at, `${fn} is gone`).toBeGreaterThan(0);
      expect(DB.slice(at, at + 900)).toContain('eq(mediaArchiveAssets.mediaStatus, "READY")');
    }
  });

  it("A CLIP ALREADY CARRYING A HANDLE IS NOT STORED AGAIN", () => {
    const already = DECIDER.indexOf('reason: "already_archived"');
    const store = DECIDER.indexOf("await storeExternalClipForTimeline({");
    expect(already).toBeGreaterThan(0);
    expect(store).toBeGreaterThan(already);
  });

  it("the file on disk is what is stored — nothing is fetched from the provider again", () => {
    expect(DECIDER).toContain("clipPath,");
    const wrapper = PIPELINE.slice(
      PIPELINE.indexOf("async function storeExternalClipForTimeline(params: {"),
      PIPELINE.indexOf("\n// Thin wrapper so fetchSceneVisualsInner")
    );
    expect(wrapper).toContain("localPath: clipPath,");
    /** The only fetch in the wrapper is the archive's own read-back verification. */
    expect(wrapper.match(/downloadToFileStreaming\(/g)?.length ?? 0).toBe(1);
    expect(wrapper).toContain('"productionArchive:readBack"');
  });
});

describe("Test 20 + §9 — runners-up keep their background behaviour", () => {
  it("the runner-up path is still fire-and-forget, and is not a timeline asset", () => {
    const at = PIPELINE.indexOf("const queueArchiveIngestion = (");
    expect(at).toBeGreaterThan(0);
    const body = PIPELINE.slice(at, at + 500);
    expect(body).toContain("void (async () => {");
    expect(body).toContain("await ingestExternalClipToArchive(clipPath, archiveMetadataFor(wec));");
  });

  it("A RUNNER-UP THAT LATER BECOMES A TIMELINE CLIP STILL PASSES THE GATE", () => {
    /**
     * The distinction is not "which route fetched it" but "is it entering the film". Nothing about
     * having been a runner-up exempts a clip from the boundary every picture crosses.
     */
    const code = stripComments(DECIDER);
    expect(code).not.toContain("runnerUp");
    expect(code).not.toContain("queueArchiveIngestion");
  });
});

describe("§8 — the RONDE 9 exception, unchanged", () => {
  it("Pexels and Pixabay still may not enter the curated archive", () => {
    expect(sourceMayEnterCuratedArchive("pexels")).toBe(false);
    expect(sourceMayEnterCuratedArchive("pixabay")).toBe(false);
    expect(sourceMayEnterCuratedArchive("PEXELS")).toBe(false);
    expect(sourceMayEnterCuratedArchive(" Pixabay ")).toBe(false);
  });

  it("AND THEY ARE STILL ALLOWED INTO THE FILM — the exemption is from the archive, not the timeline", () => {
    /**
     * The distinction that makes this an exception rather than a ban: stock footage is refused by
     * the ARCHIVE, and the gate lets it push. Turning RONDE 9 into a push refusal would remove
     * stock footage from the product, which is not what RONDE 9 decided.
     */
    expect(DECIDER).toContain('if (!sourceMayEnterCuratedArchive(provider)) return { ok: true, reason: "exempt_source" };');
  });

  it("the curated archive is not stored into itself", () => {
    expect(sourceMayEnterCuratedArchive("archive")).toBe(false);
  });

  it("the ingestion module's own refusal is still the second, independent guard", () => {
    const ING = readFileSync(join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(ING).toContain('sourcePrefix.startsWith("pexels:") || sourcePrefix.startsWith("pixabay:")');
    expect(ING).toContain("stock footage is never ingested into the curated archive");
  });
});

describe("§18 — the four exemptions are categories, not loopholes", () => {
  it("each one is named, and there are exactly four — plus the stored case", () => {
    /**
     * Five `ok: true` outcomes in total: the four exemptions, and the clip that was actually
     * stored. Naming all five is the point — a sixth would be a way past the invariant.
     */
    const reasons = [...DECIDER.matchAll(/return \{ ok: true, reason: "([a-z_]+)" \}/g)].map((m) => m[1]);
    expect(new Set(reasons)).toEqual(
      new Set(["not_external", "already_archived", "exempt_source", "ingestion_stopped", "stored"])
    );
    expect(reasons.length).toBe(5);
  });

  it("A CLIP WITH NO PROVABLE PROVIDER IS NOT TURNED INTO A CLAIM", () => {
    /**
     * Generated cards, guaranteed fillers and local files have no external asset to archive. So do
     * clips whose provenance this render lost — those are counted in the UNVERIFIED bucket by
     * `clipAdoptAudit`, which is where that gap is reported, and inventing a provider here to
     * force them through would be the class of guess RONDE 86 removed.
     */
    expect(DECIDER).toContain('if (!root || !provider) return { ok: true, reason: "not_external" };');
  });

  it("switching ingestion off is a configuration choice, not an outage", () => {
    expect(DECIDER).toContain('if (!externalAssetIngestionEnabled()) return { ok: true, reason: "ingestion_stopped" };');
  });

  it("and nothing else can allow a push without a handle", () => {
    const code = stripComments(DECIDER);
    const oks = (code.match(/ok: true/g) ?? []).length;
    expect(oks, "a fifth way past the invariant appeared").toBe(5); // four exemptions + "stored"
    expect(code).toContain('return { ok: true, reason: "stored" };');
  });
});

describe("§6 — the invariant is not subject-specific", () => {
  /**
   * The round's own requirement: this must hold for any topic. The decision never reads narration,
   * a semantic profile, an entity list or a subject anchor — so it cannot behave differently for
   * one subject than another. Proven two ways: structurally, and by running the shared provenance
   * builder across unrelated subject categories.
   */
  it("THE DECISION READS NO SUBJECT, NO NARRATION AND NO SEMANTIC PROFILE", () => {
    const code = stripComments(DECIDER);
    for (const forbidden of [
      "semanticProfile", "subjectAnchor", "ensureSubjectAnchor", "beatVisualIntent",
      "entities", "personName", "keywords", "videoTitle",
    ]) {
      expect(code, `the archive decision reads ${forbidden} — it is subject-dependent`)
        .not.toContain(forbidden);
    }
  });

  const SUBJECTS: Array<[string, string, string]> = [
    ["public figure", "Kim Kardashian 2018 interview", "kim kardashian"],
    ["historical person", "Marie Curie in her Paris laboratory", "marie curie"],
    ["historical event", "Apollo 11 lifts off from Pad 39A", "apollo 11"],
    ["historical topic", "Allied landings in Normandy, 1944", "world war ii"],
    ["business figure", "Elon Musk on the Fremont factory floor", "elon musk"],
    ["science", "Arctic sea ice minimum, satellite record", "climate change"],
    ["sport", "the second half at the Maracanã", "football match"],
    ["place", "Amsterdam canals from the air", "amsterdam"],
  ];

  for (const [category, title, query] of SUBJECTS) {
    it(`the same provenance is built for a ${category}`, () => {
      const facts: ExternalClipArchiveFacts = {
        source: "wikimedia",
        providerAssetId: `File:${category}.webm`,
        title,
        mediaType: "video",
      };
      const md = archiveMetadataForExternalClip(facts, {
        beatQuery: query,
        personContext: false,
        topics: [],
      });
      // RONDE 9 holds for every subject: narration keywords never become archive tags.
      expect(md.tags).toEqual([]);
      // RONDE 28 holds for every subject: the query that found it, never the asset's title.
      expect(md.matchedQuery).toBe(query);
      expect(md.title).toBe(title);
      expect(md.sourcePlatform).toBe("wikimedia");
      expect(md.mimeType).toBe("video/mp4");
    });
  }

  it("AND THE ELIGIBILITY ANSWER IS IDENTICAL ACROSS ALL OF THEM", () => {
    /** One provider, eight subjects, one answer — the rule is about the source, never the story. */
    const answers = SUBJECTS.map(() => sourceMayEnterCuratedArchive("wikimedia"));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(true);
  });
});

describe("what this round did not touch", () => {
  it("the gates, thresholds and budgets named as untouchable are where they were", () => {
    expect(PIPELINE).toContain("ensureSubjectAnchor(q, stockSubjectAnchor)");
    expect(PIPELINE).toContain("capCandidatesPerSource(poolCandidates, before)");
    expect(PIPELINE).toContain("if (dedup.stockQueriesAsked.has(askKey)) {");
    const CURATED = readFileSync(join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(CURATED).toContain("NO_RELEVANT_ARCHIVE");
  });

  it("the YouTube operator authorisation default is still ON unless literally false", () => {
    const LIC = readFileSync(join(__dirname, "youtubeLicenseStatus.ts"), "utf8");
    expect(LIC).toContain(
      'return process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE?.trim().toLowerCase() !== "false";'
    );
  });

  it("the canonical egress reader, the bot_check classification and the latch are intact", () => {
    const WORKER = readFileSync(join(__dirname, "worker.ts"), "utf8");
    const PROBE = readFileSync(join(__dirname, "youtubeEgressProbe.ts"), "utf8");
    expect(WORKER).toContain("canReachYoutubeEgress: async () => askYoutubeEgress(");
    expect(stripComments(WORKER)).not.toContain("/health/egress");
    expect(PROBE).toContain("return `cloud_egress_${verdict.reason ?? \"blocked\"}`;");
    expect(PROBE).toContain("export const YOUTUBE_EGRESS_PROBE_TIMEOUT_MS = 3_000;");
    expect(PIPELINE).toContain('if (thrownAs === "DOWNLOAD_TIMEOUT" && !cloudEgressRefusal()) {');
    expect(PIPELINE).toContain("if (noteCloudEgressBlocked(videoId, blocked)) {");
    expect(PIPELINE).toContain("falling back to RapidAPI");
  });
});
