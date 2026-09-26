/**
 * RONDE 658 — the real modules behind `buildVideoYoutubePool`.
 *
 * Lazy imports, so the pool module stays testable without them and no new import cycle is created
 * with videoPipeline.ts. Every piece is one that already exists: the key rotation and the process
 * cache of the old search, the quota counter and its log line, the vision model the picture editor
 * uses (on a thumbnail, at low detail), the archive's own selection, and SEARCH_GATE_STRICT's own
 * validator — given the whole narration as its evidence rather than one beat.
 *
 * The key is never logged: URLs are built here and only the query, status and counts are printed.
 */
import type { PoolDeps, SearchItem, ItemDetails, Triage } from "./youtubeVideoPool";
import type { PlannerInput } from "./youtubeVideoSearchPlanner";

const TRIAGE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "youtube_thumbnail_triage",
    strict: true,
    schema: {
      type: "object",
      properties: {
        footageType: {
          type: "string",
          enum: ["real_footage", "archival_footage", "talking_head", "text_or_graphic", "animation_or_game", "other"],
        },
        servesBeats: { type: "array", items: { type: "integer" } },
        depicts: { type: "string" },
      },
      required: ["footageType", "servesBeats", "depicts"],
      additionalProperties: false,
    },
  },
};

function isoDurationSec(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

function llmText(resp: unknown): string {
  const c = (resp as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p as { text?: string }).text ?? "").join("");
  return "";
}

export async function productionVideoPoolDeps(input: PlannerInput & { videoId: number; renderId?: string }): Promise<PoolDeps> {
  const [{ invokeLLM }, pipeline, contract, { dbYoutubeSearchBudgetStore }, quota, nonFootage, clipFilter, curated, db] =
    await Promise.all([
      import("./_core/llm"),
      import("./videoPipeline"),
      import("./searchQueryContract"),
      import("./db"),
      import("./youtubeSearchQuota"),
      import("./youtubeNonFootage"),
      import("./archiveClipFilter"),
      import("./curatedMediaSourcing"),
      import("./db"),
    ]);
  const narration = input.sceneTexts.join(" ");
  /** The whole video's evidence: every word of the narration, and the user's own prompt as topic. */
  const ctx = pipeline.buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt });
  const llm = invokeLLM as unknown as (p: unknown) => Promise<unknown>;

  const search = async (query: string): Promise<{ status: number; items: SearchItem[] }> => {
    const key = `${query}#video_pool#n50`;
    const callContext = { videoId: input.videoId, renderId: input.renderId, sceneIndex: -1, query };
    type Payload = { items?: Array<{ id?: { videoId?: string }; snippet?: Record<string, unknown> }> };
    const reused = quota.cachedYoutubeSearchPayload(key) as Payload | undefined;
    let payload: Payload | null = null;
    let status = 200;
    if (reused !== undefined) {
      console.log(quota.formatYoutubeSearchCall({ ...callContext, source: "process_cache", callsToday: quota.youtubeQuotaCallsToday() }));
      payload = reused;
    } else {
      const apiKey = (process.env.YOUTUBE_API_KEY ?? "").trim();
      if (!apiKey) return { status: 0, items: [] };
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("q", query);
      url.searchParams.set("type", "video");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("order", "relevance");
      url.searchParams.set("videoEmbeddable", "true");
      const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      status = resp.status;
      console.log(
        quota.formatYoutubeSearchCall({ ...callContext, source: "network", status, callsToday: quota.countYoutubeQuotaCall() })
      );
      /**
       * No retry, no next key: a refused call is this search, spent. A 429 still starts the renders'
       * cooldown, so the next video does not spend its search #1 on a refusal.
       */
      if (resp.status === 429) pipeline.markYoutubeRateLimited();
      if (!resp.ok) return { status, items: [] };
      payload = (await resp.json()) as Payload;
      quota.storeYoutubeSearchPayload(key, payload);
    }
    return {
      status,
      items: (payload?.items ?? [])
        .filter((i) => i.id?.videoId)
        .map((i) => {
          const sn = (i.snippet ?? {}) as { title?: string; description?: string; channelTitle?: string; thumbnails?: { high?: { url?: string }; medium?: { url?: string } } };
          return {
            videoId: i.id!.videoId!,
            title: sn.title ?? "",
            description: sn.description ?? "",
            channel: sn.channelTitle ?? "",
            thumb: sn.thumbnails?.high?.url ?? sn.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.id!.videoId}/hqdefault.jpg`,
          };
        }),
    };
  };

  const details = async (ids: string[]): Promise<Map<string, ItemDetails>> => {
    const out = new Map<string, ItemDetails>();
    const apiKey = (process.env.YOUTUBE_API_KEY ?? "").trim();
    if (!apiKey || !ids.length) return out;
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("id", ids.slice(0, 50).join(","));
    url.searchParams.set("part", "contentDetails,status,snippet");
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    console.log(`[YouTubeVideosList] video=${input.videoId} ids=${Math.min(ids.length, 50)} status=${resp.status} quotaUnits=1`);
    if (!resp.ok) return out;
    const data = (await resp.json()) as {
      items?: Array<{ id: string; contentDetails?: { duration?: string }; status?: { embeddable?: boolean }; snippet?: { liveBroadcastContent?: string } }>;
    };
    for (const v of data.items ?? []) {
      out.set(v.id, {
        durationSec: isoDurationSec(v.contentDetails?.duration),
        embeddable: v.status?.embeddable !== false,
        live: (v.snippet?.liveBroadcastContent ?? "none") !== "none",
      });
    }
    return out;
  };

  const triage = async (item: SearchItem, title: string, sentences: string[]): Promise<Triage | null> => {
    if (!item.thumb) return null;
    const r = await fetch(item.thumb, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const prepared = await clipFilter.prepareImageForVision(Buffer.from(await r.arrayBuffer()), "image/jpeg");
    if (!prepared) return null;
    const resp = await Promise.race([
      llm({
        messages: [
          { role: "system", content: "You triage YouTube results for a documentary editor. Return only JSON." },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Video being made: "${title}".\nYouTube result: "${item.title}" (channel: ${item.channel}).\n` +
                  "This is the result's THUMBNAIL. Thumbnails often carry added headline text or a presenter's face; judge " +
                  "the underlying footage the video most likely contains.\nfootageType: real_footage (filmed real-world " +
                  "scenes), archival_footage (historical film or photo), talking_head (presenter, interview, podcast, " +
                  "reaction), text_or_graphic (slides, infographics, text), animation_or_game, other.\nservesBeats: the " +
                  "numbers of the beats below that real footage from this video could honestly be shown under (empty if " +
                  "none). Be strict: the subject must match, not just the theme.\n\nBeats:\n" +
                  sentences.map((s, i) => `[${i}] ${s}`).join("\n"),
              },
              {
                type: "image_url",
                image_url: { url: clipFilter.imageMimeToDataUrl(prepared.buffer, prepared.mimeType), detail: "low" },
              },
            ],
          },
        ],
        response_format: TRIAGE_SCHEMA,
        maxTokens: 250,
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("triage timeout")), 25_000)),
    ]);
    try {
      const v = JSON.parse(llmText(resp)) as Triage;
      return { footageType: v.footageType, servesBeats: Array.isArray(v.servesBeats) ? v.servesBeats : [], depicts: v.depicts ?? "" };
    } catch {
      return null;
    }
  };

  /**
   * The archive's own YouTube material. The dry run found that the archive answers ~140 assets for
   * any topic when asked this way, so a pick must clear the curated route's own floor (22) and is
   * then judged on its thumbnail exactly like a search result. At most 20, the best-scored.
   */
  const archive = async (sentences: string[]): Promise<SearchItem[]> => {
    const cache = new Map();
    const anchors = db.normalizeMediaTags(
      `${input.prompt} ${input.title}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4)
    );
    const seen = new Map<string, { score: number; title: string }>();
    for (const s of sentences) {
      const tags = db.normalizeMediaTags(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
      const picks = await curated
        .listCuratedArchiveCandidates(tags, new Set(), new Set(), anchors, undefined, s, new Set(), cache, true, true)
        .catch(() => []);
      for (const p of picks) {
        const id =
          /youtube/i.test(p.asset.sourcePlatform ?? "") && /^[\w-]{11}$/.test(p.asset.providerAssetId ?? "")
            ? p.asset.providerAssetId!
            : /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(p.asset.sourceUrl ?? "")?.slice(1).find(Boolean);
        if (!id || p.score < 22) continue;
        const prev = seen.get(id);
        if (!prev || p.score > prev.score) seen.set(id, { score: p.score, title: p.asset.title ?? "" });
      }
    }
    return [...seen.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 20)
      .map(([id, a]) => ({ videoId: id, title: a.title, description: "", channel: "archive", thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }));
  };

  return {
    llm,
    /**
     * The FULL SEARCH_GATE_STRICT decision — the ticket, the strict block, the audit counters and the
     * canonical narrowing every production YouTube query goes through — run inside the whole video's
     * provenance. The validator is asked again only to name the reason for a refusal.
     */
    gate: (query) =>
      contract.withSearchProvenance(ctx, () => {
        const decision = contract.searchGateDecision("youtube", query, "video_pool");
        if (decision.admitted) return { ok: true, sentAs: decision.text };
        const why = contract.validateSearchQuery(query, ctx);
        return { ok: false, reason: why.ok ? "NO_SEARCH_CONTEXT" : why.reason, offendingTerm: why.ok ? undefined : why.offendingTerm };
      }),
    store: dbYoutubeSearchBudgetStore,
    search,
    details,
    triage,
    archive,
    notFootage: nonFootage.youtubeTitleIsNotFootage,
    inCooldown: pipeline.isYoutubeInCooldown,
    log: (l) => console.log(l),
  };
}
