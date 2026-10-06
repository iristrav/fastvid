/**
 * VIDEO 637 — two of the render's four problems (A and A2, the year on its spoken word, are in
 * openingWordAndSubtitlesOff.test.ts and graphicsCarryRealData.test.ts).
 *
 *   C  a YouTube moment's title was looked up under the moment's key (`youtube_cc:<hash>@t…`)
 *      while it was filed under the video's (`youtube_cc:<hash>`): never found, so `entity_evidence`
 *      refused all six YouTube moments of s2b0 before the picture editor saw one — the TED video
 *      titled "Elon Musk: …" included — and the sentence got a chapter card
 *   D  the background fetch downloaded again what the render had just downloaded and archived,
 *      on a replica that thought nothing was rendering because it only counted its own process
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  processing: 0,
  renderJobs: 0,
  inserted: [] as Array<Array<{ videoId: string }>>,
}));
vi.mock("./db", () => ({
  countRenderingVideos: async () => db.processing,
  countActiveRenderJobs: async () => db.renderJobs,
  affectedRowCount: (r: unknown) => (r as { affected?: number })?.affected ?? 0,
  getDb: async () => ({
    insert: () => ({
      ignore: () => ({
        values: async (rows: Array<{ videoId: string }>) => {
          db.inserted.push(rows);
          return { affected: rows.length };
        },
      }),
    }),
  }),
}));
vi.mock("./videoQueue", () => ({ workerLocalActiveJobs: () => 0 }));
vi.mock("./renderJobWorker", () => ({ activeRenderJobCount: () => 0 }));

import {
  clipContentKey,
  createSourcingCache,
  extractBeatRealEntities,
  providerAssetKey,
  providerTextCacheKey,
  putCachedProviderAsset,
  setRenderPeopleReadingForTests,
  tagPathWithProviderAsset,
  youtubeFragmentFileTag,
} from "./videoPipeline";
import { hasReliableEntityEvidence, judgeCandidateMetadata, type CandidateJudgeInput } from "./visualJudge";
import {
  enqueueYoutubePrefetch,
  noteYoutubeVideoDeliveredToArchive,
  nothingRendersAnywhere,
  resetYoutubeVideosDeliveredToArchive,
  runYoutubePrefetchBatch,
  workerIsGloballyIdle,
} from "./youtubePrefetch";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PREFETCH = fs.readFileSync(path.join(__dirname, "youtubePrefetch.ts"), "utf8");

/* ═══════════════ C — the video's own title reaches its moments ═══════════════ */

describe("C — a YouTube moment is judged with its video's own title", () => {
  const TED = { id: "zIwLWfaAg-8", title: "Elon Musk: The future we're building -- and boring | TED" };
  const MODEL_Y = { id: "i1Mah46LHIc", title: "Hands-On With the 2026 Tesla Model Y: What's New with Model Y" };
  /** s2b1 of video 637 — a sentence that names a person. */
  const SENTENCE = "Was it all Elon Musk's doing?";
  const moment = (videoId: string, startSec: number) =>
    tagPathWithProviderAsset(`/w/scene_2_ytfu_0m0_${youtubeFragmentFileTag(startSec, 4)}.mp4`, "youtube_cc", videoId);

  const cache = createSourcingCache(637);
  /** Exactly what `offerMoments` files for the film's stock: under the VIDEO. */
  putCachedProviderAsset(cache, "youtube_cc", TED.id, { providerText: { title: TED.title } });
  putCachedProviderAsset(cache, "youtube_cc", MODEL_Y.id, { providerText: { title: MODEL_Y.title } });
  const tedMoment = moment(TED.id, 411.42);
  const modelYMoment = moment(MODEL_Y.id, 291.52);

  beforeEach(() => setRenderPeopleReadingForTests(["Elon Musk"]));
  afterEach(() => setRenderPeopleReadingForTests(null));

  const judge = (p: string) => {
    const providerText = cache.assets.get(providerTextCacheKey(p))?.providerText;
    const input: CandidateJudgeInput = {
      path: p,
      sourceQuery: "elon musk",
      beatText: SENTENCE,
      videoTitle: "How Elon Musk Built Tesla",
      meta: providerText ? { providerText } : undefined,
      requireBeatMatch: false,
      scriptAnchored: true,
      entityRules: extractBeatRealEntities(SENTENCE),
      signals: { beatMatch: 1, queryInBeat: true, providerTitleSharesNothing: false },
      where: "s2b1",
      provider: "youtube_cc",
    };
    return { providerText, verdict: judgeCandidateMetadata(input) };
  };

  it("the mismatch: a moment's key is not the key its video's title was filed under", () => {
    expect(clipContentKey(tedMoment)).toBe(`${providerAssetKey("youtube_cc", TED.id)}@t4114d40`);
    expect(cache.assets.get(clipContentKey(tedMoment))?.providerText).toBeUndefined();
  });

  it("1 — the title is found through the VIDEO's key", () => {
    expect(providerTextCacheKey(tedMoment)).toBe(providerAssetKey("youtube_cc", TED.id));
    expect(judge(tedMoment).providerText?.title).toBe(TED.title);
  });

  it("2 — the sentence names a person, and the TED title is evidence of him", () => {
    const rules = extractBeatRealEntities(SENTENCE);
    expect(rules.some((r) => r.kind === "person")).toBe(true);
    expect(hasReliableEntityEvidence(rules, { providerText: { title: TED.title } })).toBe(true);
  });

  it("3/4 — the TED moment is no longer refused before anyone looks: it goes on to the picture editor", () => {
    const { verdict } = judge(tedMoment);
    expect(verdict.reason).not.toBe("entity_evidence");
    expect(verdict.decision).toBe("ACCEPT");
  });

  it("5 — the picture editor still decides: a metadata pass only lets it continue to the vision step", () => {
    /** In adoptClip a metadata REJECT is the only early exit; everything after it is still judged on its frames. */
    expect(PIPE).toContain('if (judgedOnMetadata.decision === "REJECT" && refuse(judgedOnMetadata.reason)) continue;');
  });

  it("6 — the Model Y video, whose title does not name him, is still refused for entity_evidence", () => {
    const { providerText, verdict } = judge(modelYMoment);
    expect(providerText?.title).toBe(MODEL_Y.title);
    expect(verdict.decision).toBe("REJECT");
    expect(verdict.reason).toBe("entity_evidence");
  });

  it("a moment with no title on file is refused exactly as before (no evidence is invented)", () => {
    const unknown = moment("aqz-KE-bpKQ", 30);
    const { providerText, verdict } = judge(unknown);
    expect(providerText).toBeUndefined();
    expect(verdict.reason).toBe("entity_evidence");
  });

  it("any other clip keeps its own key", () => {
    const ia = tagPathWithProviderAsset("/w/scene_1_b3_primary_arch_archive_0.mp4", "internet_archive", "tesla-1");
    expect(providerTextCacheKey(ia)).toBe(clipContentKey(ia));
    expect(providerTextCacheKey("/w/scene_1_b2_curated_a60278.mp4")).toBe(clipContentKey("/w/scene_1_b2_curated_a60278.mp4"));
  });

  it("all three provider-text readers use the video's key; none reads it with a moment's key", () => {
    expect(PIPE.match(/assets\.get\(providerTextCacheKey\(p\)\)\?\.providerText/g)?.length).toBe(3);
    expect(PIPE).not.toContain("assets.get(clipContentKey(p))?.providerText");
  });
});

/* ═══════════════ D1 — what the render already archived is not fetched again ═══════════════ */

describe("D1 — a video the render already downloaded and archived is not put on the fetch list", () => {
  beforeEach(() => {
    db.inserted = [];
    resetYoutubeVideosDeliveredToArchive();
  });
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const row = (videoId: string) => ({ videoId, title: `video ${videoId}`, query: "elon musk", licenseMode: null });

  it("the render downloaded and archived X: X is skipped, the others are queued", async () => {
    noteYoutubeVideoDeliveredToArchive("zIwLWfaAg-8");
    enqueueYoutubePrefetch([row("zIwLWfaAg-8"), row("mr9kK0_7x08")]);
    await flush();
    expect(db.inserted.flat().map((r) => r.videoId)).toEqual(["mr9kK0_7x08"]);
  });

  it("a video the render did not archive is still queued exactly as before", async () => {
    enqueueYoutubePrefetch([row("zIwLWfaAg-8")]);
    await flush();
    expect(db.inserted.flat().map((r) => r.videoId)).toEqual(["zIwLWfaAg-8"]);
  });

  it("the next render starts with an empty memory", async () => {
    noteYoutubeVideoDeliveredToArchive("zIwLWfaAg-8");
    resetYoutubeVideosDeliveredToArchive();
    enqueueYoutubePrefetch([row("zIwLWfaAg-8")]);
    await flush();
    expect(db.inserted.flat().map((r) => r.videoId)).toEqual(["zIwLWfaAg-8"]);
  });

  it("wired: noted where every delivered YouTube file goes into the archive, cleared at render start", () => {
    const at = PIPE.indexOf("function archiveYoutubeDownloadInBackground(");
    expect(PIPE.slice(at, at + 1200)).toContain("noteYoutubeVideoDeliveredToArchive(info.videoId);");
    const reset = PIPE.indexOf("resetYoutubeFragmentsFetched();\n");
    expect(PIPE.slice(reset, reset + 400)).toContain("resetYoutubeVideosDeliveredToArchive();");
  });
});

/* ═══════════════ D2 — not while anything renders anywhere ═══════════════ */

describe("D2 — the background fetch waits while ANY worker renders", () => {
  beforeEach(() => {
    db.processing = 0;
    db.renderJobs = 0;
  });

  it("the rule: no video in a pipeline status and no render job queued or running", () => {
    expect(nothingRendersAnywhere({ processingVideos: 0, activeRenderJobs: 0 })).toBe(true);
    expect(nothingRendersAnywhere({ processingVideos: 1, activeRenderJobs: 0 })).toBe(false);
    expect(nothingRendersAnywhere({ processingVideos: 0, activeRenderJobs: 1 })).toBe(false);
  });

  it("nothing renders anywhere: allowed", async () => {
    expect(await workerIsGloballyIdle()).toBe(true);
  });

  it("another replica renders (this process counts 0 itself): busy, and the batch fetches nothing", async () => {
    db.processing = 1;
    expect(await workerIsGloballyIdle()).toBe(false);
    expect(await runYoutubePrefetchBatch()).toEqual({ videos: 0, archived: 0 });
  });

  it("an editor render job on another replica: busy", async () => {
    db.renderJobs = 1;
    expect(await workerIsGloballyIdle()).toBe(false);
    expect(await runYoutubePrefetchBatch()).toEqual({ videos: 0, archived: 0 });
  });

  it("asked before the batch starts and again before every video; this process's own check is unchanged", () => {
    expect(PREFETCH).toContain("if (!(await workerIsGloballyIdle())) return { videos: 0, archived: 0 };");
    expect(PREFETCH).toContain("if (!deps.isIdle()) break;\n      if (!(await workerIsGloballyIdle())) break;");
    expect(PREFETCH).toContain("workerLocalActiveJobs() === 0 && activeRenderJobCount() === 0");
  });
});
