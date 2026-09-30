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
import { isoDurationSec } from "./youtubeVideoDuration";

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

/**
 * VIDEO 616 — WHAT THE VIDEO SHOWS, NOT WHAT IT IS ABOUT.
 *
 * The triage used to be told to look past a thumbnail's headline text and presenter and "judge the
 * underlying footage". Render 616 shows what that admits: "How the Kardashians Made Their BILLIONS",
 * "THE KARDASHIAN CULT", "You Will NEVER BELIEVE How Kris Jenner…" — explainer and commentary
 * channels, all judged real footage because the thumbnail carried the right face, all refused later
 * for burnt-in captions and logos, none of them usable. The same six categories and the same
 * `judge` rule decide; the question is sharpened: someone talking ABOUT the subject, or a video
 * dressed in captions and branding, is not footage OF it. A real interview WITH the subject, a red
 * carpet, a press event, paparazzi or archival film stays real or archival footage.
 */
export function youtubeTriagePrompt(
  item: Pick<SearchItem, "title" | "channel" | "description">,
  title: string,
  sentences: string[]
): string {
  return (
    `Video being made: "${title}".\nYouTube result: "${item.title}" (channel: ${item.channel}).\n` +
    (item.description ? `Description: ${item.description.slice(0, 200)}\n` : "") +
    "This is the result's THUMBNAIL. Judge what the VIDEO ITSELF shows on screen for most of its running time — " +
    "not what the thumbnail advertises. A thumbnail with the right face proves nothing: channels that explain or " +
    "comment on a subject put that face in their thumbnails too.\n" +
    "footageType:\n" +
    "- real_footage: filmed real-world scenes OF the subject — events, appearances, red carpets, press conferences, " +
    "paparazzi, TV or press interviews in which the subject is on camera, news film of the event itself.\n" +
    "- archival_footage: historical film or photographs of the subject.\n" +
    "- talking_head: someone ELSE talking ABOUT the subject — a presenter, commentator, YouTuber, podcast, " +
    "reaction, explainer, analysis, 'story of', 'untold story', 'the truth about', news commentary. " +
    "An interview WITH the subject is real_footage, not talking_head.\n" +
    "- text_or_graphic: listicles and top-10s, compilations dressed in large captions or burnt-in subtitles, " +
    "headline text, logos or channel branding over the picture, slides, infographics, screenshots.\n" +
    "- animation_or_game, other.\n" +
    "Signs of talking_head or text_or_graphic: clickbait titles (ALL CAPS, 'you won't believe', 'explained', " +
    "'untold', 'dark secret', 'top 10', 'how X became'), a commentary or explainer channel, a thumbnail built from " +
    "big text, arrows, circles or a collage. When the video is more likely commentary than footage, say so.\n" +
    "servesBeats: the numbers of the beats below that real footage from this video could honestly be shown under " +
    "(empty if none). Be strict: the subject must match, not just the theme.\n\nBeats:\n" +
    sentences.map((s, i) => `[${i}] ${s}`).join("\n")
  );
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
      items?: Array<{
        id: string;
        contentDetails?: { duration?: string };
        status?: { embeddable?: boolean };
        snippet?: { liveBroadcastContent?: string; title?: string; description?: string; channelTitle?: string };
      }>;
    };
    for (const v of data.items ?? []) {
      out.set(v.id, {
        durationSec: isoDurationSec(v.contentDetails?.duration),
        embeddable: v.status?.embeddable !== false,
        live: (v.snippet?.liveBroadcastContent ?? "none") !== "none",
        title: v.snippet?.title ?? "",
        description: v.snippet?.description ?? "",
        channel: v.snippet?.channelTitle ?? "",
      });
    }
    return out;
  };

  /** VIDEO 618 — the same look, now shared with the per-beat search: see `triageYoutubeThumbnail`. */
  const triage = (item: SearchItem, title: string, sentences: string[]): Promise<Triage | null> =>
    triageYoutubeThumbnail(item, title, sentences, llm, clipFilter);

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

/**
 * The thumbnail look the pool gives every YouTube result: what the video shows most of the time,
 * judged by the picture editor's vision model on the thumbnail at low detail.
 *
 * VIDEO 618 — exported so the per-beat search, which runs when the pool is empty, looks the same
 * way before it downloads. That route downloaded ten videos for 618, eight of them commentary and
 * list videos full of on-screen text, each refused only after its transfer.
 */
export async function triageYoutubeThumbnail(
  item: SearchItem,
  title: string,
  sentences: string[],
  llm?: (p: unknown) => Promise<unknown>,
  clipFilter?: typeof import("./archiveClipFilter")
): Promise<Triage | null> {
  llm ??= (await import("./_core/llm")).invokeLLM as unknown as (p: unknown) => Promise<unknown>;
  clipFilter ??= await import("./archiveClipFilter");
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
              text: youtubeTriagePrompt(item, title, sentences),
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
}
