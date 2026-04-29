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
} from "./db";
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

async function generateVideoWithAI(videoId: number, prompt: string, videoLength: string) {
  const lengthMap: Record<string, string> = {
    "5-8": "5 to 8 minutes", "8-12": "8 to 12 minutes", "12-15": "12 to 15 minutes",
    "15-20": "15 to 20 minutes", "20+": "20+ minutes",
  };
  const lengthDesc = lengthMap[videoLength] ?? "15 to 20 minutes";
  try {
    // ── Stage 1: Generate Script ──────────────────────────────────────────────
    await updateVideoStatus(videoId, "generating_script", { progressStep: "Writing viral script...", progressPercent: 5, generationStartedAt: new Date() });
    const scriptResponse = await invokeLLM({
      messages: [
        { role: "system", content: `You are an expert YouTube scriptwriter who creates viral, engaging scripts optimized for maximum watch time and engagement. Structure scripts with: Hook (first 30 seconds), Introduction, Main Content (with chapters), and Call-to-Action. Include [VISUAL: description] tags for B-roll cues.` },
        { role: "user", content: `Create a complete YouTube video script for a video that is ${lengthDesc} long.\n\nTopic: ${prompt}\n\nRequirements:\n- Irresistible hook in first 5 seconds\n- Brief intro (30-60 seconds)\n- Clear chapters with titles\n- [VISUAL: description] tags throughout\n- Strong call-to-action at end\n- Include timestamps for chapters` },
      ],
    });
    const rawScriptContent = scriptResponse?.choices?.[0]?.message?.content ?? "";
    const scriptContent = typeof rawScriptContent === "string" ? rawScriptContent : "";
    const titleMatch = (scriptContent as string).match(/^#\s*(.+)|^Title:\s*(.+)/m);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2]) : prompt.slice(0, 100);
    await updateVideoStatus(videoId, "generating_voiceover", { script: scriptContent, title });

    // ── Stage 2: Generate SEO Metadata ───────────────────────────────────────
    const metaResponse = await invokeLLM({
      messages: [
        { role: "system", content: "You are a YouTube SEO expert. Generate optimized metadata. Always respond with valid JSON." },
        { role: "user", content: `Generate YouTube SEO metadata for:\nTopic: ${prompt}\nLength: ${lengthDesc}\n\nJSON format: { "title": "...", "description": "...", "tags": [], "chapters": [{"time": "0:00", "title": "..."}] }` },
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
    let metadata: unknown = {};
    try {
      const rawMetaContent = metaResponse?.choices?.[0]?.message?.content ?? "{}";
      const metaContent = typeof rawMetaContent === "string" ? rawMetaContent : JSON.stringify(rawMetaContent);
      metadata = JSON.parse(metaContent);
    } catch { metadata = { title, description: prompt, tags: [], chapters: [] }; }

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
      }
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
    })).mutation(async ({ ctx, input }) => {
      const videoId = await createVideo({ userId: ctx.user.id, prompt: input.prompt, videoLength: input.videoLength, status: "pending" });
      if (!videoId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create video" });
      generateVideoWithAI(videoId, input.prompt, input.videoLength).catch(console.error);
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
});

export type AppRouter = typeof appRouter;
