import Stripe from "stripe";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import {
  createVideo, getAllUsers, getAllVideos, getUserById,
  searchVideos, getUserStats, getVideoById, getVideosByUserId, getVideoStats,
  updateUserRole, updateUserSubscription, updateVideoStatus, updateVideoProgress,
  getAllVoices, getAllVoicesAdmin, getVoiceById, createVoice, updateVoice, deleteVoice, seedDefaultVoices,
} from "./db";
import { storagePut } from "./storage";
import { FASTVID_PRO_PLAN } from "./products";
import { runVideoPipeline } from "./videoPipeline";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

const subscribedProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role === "admin") return next({ ctx });
  if ((ctx.user as { subscriptionStatus?: string }).subscriptionStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Active subscription required" });
  }
  return next({ ctx });
});

// Global 1-hour hard cap — if anything hangs, mark as failed with a clear message
const MAX_VIDEO_GENERATION_MS = 60 * 60 * 1000; // 1 hour

async function generateVideoWithAI(videoId: number, prompt: string, videoLength: string, voiceId?: string) {
  // Wrap the entire pipeline in a 1-hour timeout
  const timeoutHandle = setTimeout(async () => {
    console.error(`[Video Generation] Video ${videoId} exceeded 1-hour limit — marking as failed`);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: "Video generation exceeded the maximum time limit of 1 hour. Please try again with a shorter prompt.",
      progressStep: "Generation timed out (max 1 hour exceeded)",
      progressPercent: 0,
    }).catch(() => {});
  }, MAX_VIDEO_GENERATION_MS);

  try {
    await _generateVideoWithAI(videoId, prompt, videoLength, voiceId);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function _generateVideoWithAI(videoId: number, prompt: string, videoLength: string, voiceId?: string) {
  const lengthMap: Record<string, string> = {
    "5-8": "5 to 8 minutes", "8-12": "8 to 12 minutes", "12-15": "12 to 15 minutes",
    "15-20": "15 to 20 minutes", "20+": "20+ minutes",
  };
  const lengthDesc = lengthMap[videoLength] ?? "15 to 20 minutes";
  try {
    // ── Stage 1: Fast outline, then parallel section + metadata generation ────
    await updateVideoStatus(videoId, "generating_script", { progressStep: "Creating video outline...", progressPercent: 5, generationStartedAt: new Date() });

    // Step 1a: Short outline call (~5-8s)
    const outlineResp = await invokeLLM({
      messages: [
        { role: "system", content: "You are a YouTube scriptwriter. Be concise." },
        { role: "user", content: `Create a YouTube video outline for: "${prompt}"\nVideo length: ${lengthDesc}\nRespond with JSON: { title, hook (2 sentences), sections (max 5, each: {title, keyPoints: string[]}), cta }` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "video_outline", strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              hook: { type: "string" },
              sections: { type: "array", items: { type: "object", properties: { title: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } } }, required: ["title", "keyPoints"], additionalProperties: false } },
              cta: { type: "string" },
            },
            required: ["title", "hook", "sections", "cta"], additionalProperties: false,
          },
        },
      },
    });

    type Outline = { title: string; hook: string; sections: { title: string; keyPoints: string[] }[]; cta: string };
    let outline: Outline = { title: prompt.slice(0, 80), hook: "", sections: [], cta: "" };
    try {
      const raw = outlineResp?.choices?.[0]?.message?.content ?? "{}";
      outline = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Outline;
    } catch { /* use default */ }
    const title = outline.title || prompt.slice(0, 100);

    await updateVideoProgress(videoId, `Outline ready — writing ${outline.sections.length} sections in parallel...`, 12);

    // Step 1b: Generate each section AND metadata in parallel (all at once)
    const sectionPromises = outline.sections.map((sec, idx) =>
      invokeLLM({
        messages: [
          { role: "system", content: "Write engaging YouTube script text. Include [VISUAL: description] tags every 2-3 sentences. Be conversational and natural." },
          { role: "user", content: `Section ${idx + 1}: "${sec.title}"\nCover: ${sec.keyPoints.join(", ")}\nWrite 2-3 short paragraphs. Start directly with content.` },
        ],
      }).then(r => { const c = r?.choices?.[0]?.message?.content ?? ""; return typeof c === "string" ? c : ""; })
      .catch(() => sec.keyPoints.join(". ") + ".")
    );

    const metaPromise = invokeLLM({
      messages: [
        { role: "system", content: "YouTube SEO expert. Respond with valid JSON only." },
        { role: "user", content: `YouTube metadata for: ${prompt} (${lengthDesc})\nJSON: { title, description, tags: string[], chapters: [{time, title}] }` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "youtube_metadata", strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" }, description: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              chapters: { type: "array", items: { type: "object", properties: { time: { type: "string" }, title: { type: "string" } }, required: ["time", "title"], additionalProperties: false } },
            },
            required: ["title", "description", "tags", "chapters"], additionalProperties: false,
          },
        },
      },
    });

    const [sectionTexts, metaResponse] = await Promise.all([Promise.all(sectionPromises), metaPromise]);
    await updateVideoProgress(videoId, "Assembling script...", 22);

    // Assemble full script
    const scriptParts: string[] = [`# ${title}\n`, `## HOOK\n${outline.hook}\n[VISUAL: Opening shot for ${prompt}]\n`];
    outline.sections.forEach((sec, idx) => scriptParts.push(`## ${sec.title}\n${sectionTexts[idx] ?? ""}\n`));
    scriptParts.push(`## CALL TO ACTION\n${outline.cta}\n[VISUAL: Subscribe button animation]\n`);
    const scriptContent = scriptParts.join("\n");

    let metadata: unknown = {};
    try {
      const rawMetaContent = metaResponse?.choices?.[0]?.message?.content ?? "{}";
      const metaContent = typeof rawMetaContent === "string" ? rawMetaContent : JSON.stringify(rawMetaContent);
      metadata = JSON.parse(metaContent);
    } catch { metadata = { title, description: prompt, tags: [], chapters: [] }; }

    await updateVideoStatus(videoId, "generating_voiceover", { script: scriptContent, title });

    // ── Stage 3: Run Full Video Pipeline (TTS + Visuals + FFmpeg) ────────────
    await updateVideoStatus(videoId, "generating_visuals", { metadata, title: (metadata as Record<string, string>).title ?? title, progressStep: "Metadata ready — generating voiceover...", progressPercent: 30 });
    const videoUrl = await runVideoPipeline(
      videoId,
      scriptContent,
      async (progress) => {
        // Update granular progress step label + percent
        const basePercent = 30;
        const pipelinePercent = Math.round(basePercent + (progress.percent * 0.65));
        await updateVideoProgress(videoId, progress.stage, Math.min(pipelinePercent, 95)).catch(() => {});
        // Also update the status enum for coarse-grained tracking
        if (progress.percent < 35) {
          await updateVideoStatus(videoId, "generating_voiceover").catch(() => {});
        } else if (progress.percent < 75) {
          await updateVideoStatus(videoId, "generating_visuals").catch(() => {});
        } else {
          await updateVideoStatus(videoId, "generating_effects").catch(() => {});
        }
      },
      voiceId
    );

    // ── Stage 4: Mark as Completed ───────────────────────────────────────────
    await updateVideoStatus(videoId, "completed", {
      metadata,
      title: (metadata as Record<string, string>).title ?? title,
      thumbnailUrl: `https://picsum.photos/seed/${videoId}/1280/720`,
      videoUrl,
      progressStep: "Video complete!",
      progressPercent: 100,
    });
  } catch (error) {
    console.error("[Video Generation] Error:", error);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      progressStep: "Generation failed",
      progressPercent: 0,
    });
  }
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  video: router({
    list: protectedProcedure.query(async ({ ctx }) => getVideosByUserId(ctx.user.id)),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      return video;
    }),
    generate: subscribedProcedure.input(z.object({
      prompt: z.string().min(10).max(1000),
      videoLength: z.enum(["5-8", "8-12", "12-15", "15-20", "20+"]),
      voiceId: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const videoId = await createVideo({ userId: ctx.user.id, prompt: input.prompt, videoLength: input.videoLength, status: "pending" });
      if (!videoId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create video" });
      generateVideoWithAI(videoId, input.prompt, input.videoLength, input.voiceId).catch(console.error);
      return { videoId, message: "Video generation started" };
    }),
    pollStatus: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      return { status: video.status, title: video.title, script: video.script, metadata: video.metadata, thumbnailUrl: video.thumbnailUrl, progressStep: video.progressStep, progressPercent: video.progressPercent ?? 0, generationStartedAt: video.generationStartedAt };
    }),
  }),

  admin: router({
    stats: adminProcedure.query(async () => {
      const [userStats, videoStats] = await Promise.all([getUserStats(), getVideoStats()]);
      return { users: userStats, videos: videoStats };
    }),
    listUsers: adminProcedure.input(z.object({ limit: z.number().default(100), offset: z.number().default(0) })).query(async ({ input }) => getAllUsers(input.limit, input.offset)),
    listVideos: adminProcedure.input(z.object({ limit: z.number().default(100), offset: z.number().default(0) })).query(async ({ input }) => getAllVideos(input.limit, input.offset)),
    updateUserRole: adminProcedure.input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) })).mutation(async ({ input }) => { await updateUserRole(input.userId, input.role); return { success: true }; }),
    updateUserSubscription: adminProcedure.input(z.object({ userId: z.number(), subscriptionStatus: z.enum(["active", "inactive", "cancelled"]) })).mutation(async ({ input }) => {
      await updateUserSubscription(input.userId, { subscriptionStatus: input.subscriptionStatus, subscriptionStartDate: input.subscriptionStatus === "active" ? new Date() : undefined });
      return { success: true };
    }),
    generateVideo: adminProcedure.input(z.object({
      prompt: z.string().min(10).max(500),
      videoLength: z.enum(["5-8", "8-12", "12-15", "15-20", "20+"]),
    })).mutation(async ({ ctx, input }) => {
      const videoId = await createVideo({ userId: ctx.user.id, prompt: input.prompt, videoLength: input.videoLength });
      generateVideoWithAI(videoId, input.prompt, input.videoLength).catch(console.error);
      return { videoId };
    }),
    searchVideos: adminProcedure.input(z.object({
      query: z.string().optional(),
      status: z.string().optional(),
      userId: z.number().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    })).query(async ({ input }) => searchVideos(input)),
    getUser: adminProcedure.input(z.object({ userId: z.number() })).query(async ({ input }) => {
      const user = await getUserById(input.userId);
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });
      return user;
    }),
  }),

  subscription: router({
    activate: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input }) => {
      await updateUserSubscription(input.userId, { subscriptionStatus: "active", subscriptionStartDate: new Date() });
      return { success: true };
    }),
    deactivate: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input }) => {
      await updateUserSubscription(input.userId, { subscriptionStatus: "inactive" });
      return { success: true };
    }),
  }),

  billing: router({
    createCheckout: protectedProcedure.input(z.object({ origin: z.string() })).mutation(async ({ ctx, input }) => {
      if (!process.env.STRIPE_SECRET_KEY) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe not configured" });
      // Create or retrieve Stripe customer
      let customerId = (ctx.user as { stripeCustomerId?: string }).stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: ctx.user.email ?? undefined,
          name: ctx.user.name ?? undefined,
          metadata: { userId: ctx.user.id.toString() },
        });
        customerId = customer.id;
        await updateUserSubscription(ctx.user.id, { stripeCustomerId: customerId });
      }
      // Create a recurring price on the fly (or use a pre-created one)
      const price = await stripe.prices.create({
        currency: FASTVID_PRO_PLAN.currency,
        unit_amount: FASTVID_PRO_PLAN.priceEur,
        recurring: { interval: FASTVID_PRO_PLAN.interval },
        product_data: { name: FASTVID_PRO_PLAN.name },
      });
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: `${input.origin}/dashboard?payment=success`,
        cancel_url: `${input.origin}/dashboard?payment=cancelled`,
        client_reference_id: ctx.user.id.toString(),
        allow_promotion_codes: true,
        metadata: {
          user_id: ctx.user.id.toString(),
          customer_email: ctx.user.email ?? "",
          customer_name: ctx.user.name ?? "",
        },
      });
      return { url: session.url };
    }),

    status: protectedProcedure.query(async ({ ctx }) => {
      const user = await getUserById(ctx.user.id);
      return {
        subscriptionStatus: (user as { subscriptionStatus?: string })?.subscriptionStatus ?? "inactive",
        stripeCustomerId: (user as { stripeCustomerId?: string })?.stripeCustomerId ?? null,
      };
    }),
  }),

  // ── Voice Library ────────────────────────────────────────────────────────────
  voice: router({
    /** Public: list all active voices (used in dashboard voice picker) */
    list: publicProcedure.query(async () => {
      await seedDefaultVoices();
      return getAllVoices();
    }),

    /** Admin: list all voices including hidden ones */
    listAll: adminProcedure.query(async () => {
      await seedDefaultVoices();
      return getAllVoicesAdmin();
    }),

    /** Admin: create a new voice */
    create: adminProcedure.input(z.object({
      name: z.string().min(1).max(128),
      description: z.string().max(256).optional(),
      fishAudioReferenceId: z.string().min(1).max(128),
      exampleAudioUrl: z.string().max(1024).optional(),
      flag: z.string().max(8).optional(),
      sortOrder: z.number().int().optional(),
    })).mutation(async ({ input }) => {
      const id = await createVoice({
        name: input.name,
        description: input.description ?? null,
        fishAudioReferenceId: input.fishAudioReferenceId,
        exampleAudioUrl: input.exampleAudioUrl ?? null,
        flag: input.flag ?? "🇺🇸",
        sortOrder: input.sortOrder ?? 0,
        isActive: 1,
      });
      return { id };
    }),

    /** Admin: update a voice */
    update: adminProcedure.input(z.object({
      id: z.number().int(),
      name: z.string().min(1).max(128).optional(),
      description: z.string().max(256).optional(),
      fishAudioReferenceId: z.string().min(1).max(128).optional(),
      exampleAudioUrl: z.string().max(1024).nullable().optional(),
      flag: z.string().max(8).optional(),
      isActive: z.number().int().min(0).max(1).optional(),
      sortOrder: z.number().int().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      await updateVoice(id, data);
      return { success: true };
    }),

    /** Admin: delete a voice */
    delete: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
      await deleteVoice(input.id);
      return { success: true };
    }),

    /** Admin: upload example audio for a voice — receives base64-encoded audio */
    uploadExampleAudio: adminProcedure.input(z.object({
      voiceId: z.number().int(),
      audioBase64: z.string(),
      mimeType: z.string().default("audio/mpeg"),
    })).mutation(async ({ input }) => {
      const voice = await getVoiceById(input.voiceId);
      if (!voice) throw new TRPCError({ code: "NOT_FOUND", message: "Voice not found" });
      const buffer = Buffer.from(input.audioBase64, "base64");
      const ext = input.mimeType.includes("mp3") || input.mimeType.includes("mpeg") ? "mp3" : "wav";
      const { url } = await storagePut(`voices/${input.voiceId}/example.${ext}`, buffer, input.mimeType);
      await updateVoice(input.voiceId, { exampleAudioUrl: url });
      return { url };
    }),
  }),
});

export type AppRouter = typeof appRouter;
