import Stripe from "stripe";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import {
  createVideo, getAllUsers, getAllVideos, getUserById, getUserByEmail,
  searchVideos, getUserStats, getVideoById, getVideosByUserId, getVideoStats,
  updateUserRole, updateUserSubscription, updateVideoStatus, updateVideoProgress,
  getAllVoices, getAllVoicesAdmin, getVoiceById, createVoice, updateVoice, deleteVoice, seedDefaultVoices,
  deleteVideo, updateVideoTitle, deleteAllFailedVideosForUser, expireStuckVideos,
  createUser, updateUserLastSignedIn,
  getInviteCodeByCode, createInviteCode, getAllInviteCodes, markInviteCodeUsed, deleteInviteCode, deactivateInviteCode,
} from "./db";
import { ONE_YEAR_MS } from "@shared/const";

function getSessionSecret() {
  const secret = process.env.JWT_SECRET ?? "fallback-secret-change-in-production";
  return new TextEncoder().encode(secret);
}

async function signSessionToken(userId: number): Promise<string> {
  const expiresAt = Math.floor((Date.now() + ONE_YEAR_MS) / 1000);
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expiresAt)
    .sign(getSessionSecret());
}

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += "-";
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code; // e.g. ABCD-EFGH-IJKL
}
import { storagePut } from "./storage";
import { FASTVID_PRO_PLAN } from "./products";
import { runVideoPipeline, generateStabilityAIThumbnail } from "./videoPipeline";
import { forgotPassword, validateResetToken as validateResetTokenProcedure, resetPassword } from "./authPasswordReset";

// Lazy Stripe initialization — prevents crash on startup when STRIPE_SECRET_KEY is not yet set
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe is not configured. Please add STRIPE_SECRET_KEY to your environment variables." });
    _stripe = new Stripe(key);
  }
  return _stripe;
}

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

// Global 90-min hard cap — large videos (30+ scenes) can take up to 60 min
const MAX_VIDEO_GENERATION_MS = 90 * 60 * 1000; // 90 min

async function generateVideoWithAI(videoId: number, prompt: string, videoLength: string, voiceId?: string, customVoiceoverUrl?: string) {
  // Wrap the entire pipeline in a 30-min timeout
  const timeoutHandle = setTimeout(async () => {
    console.error(`[Video Generation] Video ${videoId} exceeded 90-min limit — marking as failed`);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: "Video generation exceeded 90 minutes. Please retry.",
      progressStep: "Generation timed out (max 90 min exceeded)",
      progressPercent: 0,
    }).catch(() => {});
  }, MAX_VIDEO_GENERATION_MS);

  try {
    await _generateVideoWithAI(videoId, prompt, videoLength, voiceId, customVoiceoverUrl);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─── Full pipeline: script generation + video production (no approval pause) ────
async function generateFullVideo(videoId: number, prompt: string, videoLength: string, videoType: string, voiceId?: string, customVoiceoverUrl?: string, enableSubtitles = true) {
  const timeoutHandle = setTimeout(async () => {
    console.error(`[Video Generation] Video ${videoId} exceeded 90-min limit — marking as failed`);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: "Video generation exceeded 90 minutes. Please retry.",
      progressStep: "Generation timed out (max 90 min exceeded)",
      progressPercent: 0,
    }).catch(() => {});
  }, MAX_VIDEO_GENERATION_MS);

  try {
    // Step 1: Generate script (same logic as before, but no pause)
    await generateScriptOnly(videoId, prompt, videoLength, videoType);

    // Check if script generation failed — read from DB to get the saved script
    const videoAfterScript = await getVideoById(videoId);
    console.log(`[Video Generation] After script gen: video ${videoId} status=${videoAfterScript?.status}, scriptLen=${videoAfterScript?.script?.length ?? 0}`);
    if (!videoAfterScript?.script || videoAfterScript.status === "failed") {
      console.error(`[Video Generation] Script generation failed for video ${videoId} — status: ${videoAfterScript?.status}, script: ${videoAfterScript?.script ? 'present' : 'MISSING'}`);
      // Ensure video is marked as failed with a clear message
      if (videoAfterScript?.status !== "failed") {
        await updateVideoStatus(videoId, "failed", {
          errorMessage: "Script generation failed — no script was saved. Please retry.",
          progressStep: "Script generation failed",
          progressPercent: 0,
        });
      }
      return;
    }

    // Step 2: Immediately continue to full video pipeline
    // Pass script/title/metadata directly to avoid any DB re-read race condition
    console.log(`[Video Generation] Starting video pipeline for video ${videoId} with script (${videoAfterScript.script.length} chars)`);
    await updateVideoStatus(videoId, "generating_voiceover", {
      scriptApproved: 1,
      progressStep: "🎥 Script ready — starting video production...",
      progressPercent: 29,
    });
    await _generateVideoWithAI(
      videoId, prompt, videoLength, voiceId, customVoiceoverUrl,
      videoAfterScript.script,
      videoAfterScript.title ?? undefined,
      videoAfterScript.metadata ?? undefined,
      enableSubtitles
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─── Phase A: Script-only generation (stops at awaiting_approval) ────────────
async function generateScriptOnly(videoId: number, prompt: string, videoLength: string, videoType: string) {
  const lengthMap: Record<string, string> = {
    "5-8": "5 to 8 minutes", "8-12": "8 to 12 minutes", "12-15": "12 to 15 minutes",
    "15-20": "15 to 20 minutes", "20+": "20+ minutes",
  };
  const lengthDesc = lengthMap[videoLength] ?? "15 to 20 minutes";

  const typeInstructions: Record<string, string> = {
    documentary: "Structure as a documentary with research-backed narration, expert insights, and visual evidence.",
    listicle: "Structure as a Top 10 / listicle with numbered items, each with a hook, explanation, and example.",
    tutorial: "Structure as a step-by-step tutorial with clear numbered steps, tips, and a summary.",
    explainer: "Structure as an explainer video with simple analogies, visual metaphors, and a clear conclusion.",
  };
  const typeInstruction = typeInstructions[videoType] ?? typeInstructions.documentary;

  try {
    await updateVideoStatus(videoId, "generating_script", { progressStep: "🔍 Researching topic...", progressPercent: 5, generationStartedAt: new Date() });

    // Step 1a: Short outline call (~5-8s)
    const outlineResp = await invokeLLM({
      messages: [
        { role: "system", content: `You are a YouTube scriptwriter. ${typeInstruction} Be concise.` },
        { role: "user", content: `Create a YouTube video outline for: "${prompt}"\nVideo length: ${lengthDesc}\nFormat: ${videoType}\nRespond with JSON: { title, hook (2 sentences), sections (max 5, each: {title, keyPoints: string[]}), cta }` },
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

    await updateVideoProgress(videoId, `✍️ Writing ${outline.sections.length} sections in parallel...`, 12);

    // Step 1b: Generate each section AND metadata in parallel
    const sectionPromises = outline.sections.map((sec, idx) =>
      invokeLLM({
        messages: [
          { role: "system", content: `Write engaging YouTube script text for a ${videoType}. ${typeInstruction} Include [VISUAL: description] tags every 2-3 sentences. Be conversational and natural.` },
          { role: "user", content: `Section ${idx + 1}: "${sec.title}"\nCover: ${sec.keyPoints.join(", ")}\nWrite 2-3 short paragraphs. Start directly with content.` },
        ],
      }).then(r => { const c = r?.choices?.[0]?.message?.content ?? ""; return typeof c === "string" ? c : ""; })
      .catch(() => sec.keyPoints.join(". ") + ".")
    );

    const metaPromise = invokeLLM({
      messages: [
        { role: "system", content: "YouTube SEO expert. Respond with valid JSON only." },
        { role: "user", content: `YouTube metadata for: ${prompt} (${lengthDesc}, ${videoType} format)\nJSON: { title, description, tags: string[], chapters: [{time, title}] }` },
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
    await updateVideoProgress(videoId, "📋 Assembling script...", 22);

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

    // Save script and return (no pause — caller decides next step)
    console.log(`[Script Generation] Saving script for video ${videoId}, length=${scriptContent.length} chars`);
    await updateVideoStatus(videoId, "awaiting_approval", {
      script: scriptContent,
      title,
      metadata,
      progressStep: "✅ Script ready — starting video production...",
      progressPercent: 28,
    });
    // Verify the script was actually saved
    const savedVideo = await getVideoById(videoId);
    if (!savedVideo?.script) {
      throw new Error(`Script save verification failed for video ${videoId} — DB write did not persist`);
    }
    console.log(`[Script Generation] Script saved and verified for video ${videoId} (${savedVideo.script.length} chars)`);
  } catch (error) {
    console.error("[Script Generation] Error:", error);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: error instanceof Error ? error.message : "Script generation failed — please retry",
      progressStep: "Script generation failed",
      progressPercent: 0,
    });
  }
}

// ─── Phase B: Full pipeline after script approval ─────────────────────────────
async function _generateVideoWithAI(
  videoId: number,
  prompt: string,
  videoLength: string,
  voiceId?: string,
  customVoiceoverUrl?: string,
  // Optional: pass script/title/metadata directly to avoid DB re-read race condition
  preloadedScript?: string,
  preloadedTitle?: string,
  preloadedMetadata?: unknown,
  enableSubtitles = true
) {
  try {
    // Use preloaded script if available, otherwise read from DB (legacy path)
    let approvedScript: string;
    let approvedTitle: string;
    let approvedMetadata: unknown;
    if (preloadedScript) {
      approvedScript = preloadedScript;
      approvedTitle = preloadedTitle ?? prompt.slice(0, 100);
      approvedMetadata = preloadedMetadata ?? { title: approvedTitle, description: prompt, tags: [], chapters: [] };
    } else {
      const video = await getVideoById(videoId);
      if (!video?.script) throw new Error("No approved script found");
      approvedScript = video.script;
      approvedTitle = video.title ?? prompt.slice(0, 100);
      approvedMetadata = video.metadata ?? { title: approvedTitle, description: prompt, tags: [], chapters: [] };
    }

    // ── Stage 3: Run Full Video Pipeline (TTS + Visuals + FFmpeg) ────
    await updateVideoStatus(videoId, "generating_voiceover", { progressStep: "🎙️ Generating voiceover...", progressPercent: 30 });
    const videoUrl = await runVideoPipeline(
      videoId,
      approvedScript,
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
      voiceId,
      customVoiceoverUrl,
      videoLength,
      enableSubtitles
    );

    // ── Stage 4: Generate Thumbnail via Stability AI (no Manus credits) ────────────
    await updateVideoProgress(videoId, "Generating thumbnail...", 97);
    let thumbnailUrl: string | undefined;
    try {
      const videoTitle = (approvedMetadata as Record<string, string>).title ?? approvedTitle;
      const thumbPrompt = `YouTube thumbnail: "${videoTitle.slice(0, 80)}". Cinematic, vibrant colors, high contrast, dramatic lighting, photorealistic, 16:9 aspect ratio, professional quality`;
      const thumbB64 = await generateStabilityAIThumbnail(thumbPrompt);
      if (thumbB64) {
        const thumbBuf = Buffer.from(thumbB64, "base64");
        const { url: s3Url } = await storagePut(`thumbnails/${videoId}.jpg`, thumbBuf, "image/jpeg");
        thumbnailUrl = s3Url;
      }
    } catch (thumbErr) {
      console.warn(`[Video ${videoId}] Thumbnail generation failed (non-fatal):`, thumbErr);
    }
    const finalTitle = (approvedMetadata as Record<string, string>).title ?? approvedTitle;
    await updateVideoStatus(videoId, "completed", {
      metadata: approvedMetadata,
      title: finalTitle,
      thumbnailUrl: thumbnailUrl ?? `https://picsum.photos/seed/${videoId}/1280/720`,
      videoUrl,
      progressStep: "Video complete!",
      progressPercent: 100,
    });
    // Notify owner on completion (non-blocking)
    notifyOwner({
      title: `✅ Video #${videoId} completed`,
      content: `**${finalTitle}**\n\nVideo generation completed successfully.\n- Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}\n- Length: ${videoLength} min\n- Video URL: ${videoUrl ?? "N/A"}`,
    }).catch(() => {});
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

    /** Step 1: Validate invite code before registration */
    validateInviteCode: publicProcedure
      .input(z.object({ code: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const invite = await getInviteCodeByCode(input.code.trim().toUpperCase());
        if (!invite || invite.isActive === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or already used invite code" });
        }
        return { valid: true };
      }),

    /** Step 2: Register with invite code + email + password */
    register: publicProcedure
      .input(z.object({
        inviteCode: z.string().min(1),
        name: z.string().min(1).max(128),
        email: z.string().email(),
        password: z.string().min(8).max(128),
      }))
      .mutation(async ({ input, ctx }) => {
        const code = input.inviteCode.trim().toUpperCase();
        const invite = await getInviteCodeByCode(code);
        if (!invite || invite.isActive === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or already used invite code" });
        }
        // Check email not already taken
        const existing = await getUserByEmail(input.email.toLowerCase());
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists" });
        }
        const passwordHash = await bcrypt.hash(input.password, 12);
        const userId = await createUser({
          name: input.name,
          email: input.email.toLowerCase(),
          passwordHash,
          loginMethod: "email",
          lastSignedIn: new Date(),
        });
        // Mark invite code as used
        await markInviteCodeUsed(code, userId);
        // Sign in immediately
        const token = await signSessionToken(userId);
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        const user = await getUserById(userId);
        return { success: true, user };
      }),

    /** Login with email + password */
    login: publicProcedure
      .input(z.object({
        email: z.string().email(),
        password: z.string().min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const user = await getUserByEmail(input.email.toLowerCase());
        if (!user || !user.passwordHash) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password" });
        }
        const valid = await bcrypt.compare(input.password, user.passwordHash);
        if (!valid) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password" });
        }
        await updateUserLastSignedIn(user.id);
        const token = await signSessionToken(user.id);
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        return { success: true, user };
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),

    forgotPassword,
    validateResetToken: validateResetTokenProcedure,
    resetPassword,
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
      videoType: z.enum(["documentary", "listicle", "tutorial", "explainer"]).default("documentary"),
      voiceId: z.string().optional(),
      customVoiceoverUrl: z.string().optional(),
      enableSubtitles: z.boolean().default(true),
    })).mutation(async ({ ctx, input }) => {
      const videoId = await createVideo({
        userId: ctx.user.id,
        prompt: input.prompt,
        videoLength: input.videoLength,
        videoType: input.videoType,
        customVoiceoverUrl: input.customVoiceoverUrl,
        voiceId: input.voiceId,
        enableSubtitles: input.enableSubtitles ? 1 : 0,
        status: "pending",
      });
      if (!videoId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create video" });
      // Direct full pipeline — no script review step
      generateFullVideo(videoId, input.prompt, input.videoLength, input.videoType, input.voiceId, input.customVoiceoverUrl, input.enableSubtitles).catch(console.error);
      return { videoId, message: "Video generation started" };
    }),
    approveScript: protectedProcedure.input(z.object({
      id: z.number(),
      editedScript: z.string().optional(), // allow user to edit script before approving
    })).mutation(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      if (video.status !== "awaiting_approval") throw new TRPCError({ code: "BAD_REQUEST", message: "Video is not awaiting approval" });
      // Use edited script if provided, otherwise use the stored script
      const finalScript = input.editedScript ?? video.script;
      if (!finalScript) throw new TRPCError({ code: "BAD_REQUEST", message: "No script found" });
      if (input.editedScript) {
        await updateVideoStatus(video.id, "awaiting_approval", { script: input.editedScript });
      }
      await updateVideoStatus(video.id, "generating_voiceover", {
        scriptApproved: 1,
        progressStep: "✅ Script approved — starting video production...",
        progressPercent: 29,
      });
      // Phase B: pass script directly to avoid DB re-read race condition
      const voiceIdForApprove = (video as { voiceId?: string | null }).voiceId ?? undefined;
      const customVoiceoverForApprove = video.customVoiceoverUrl ?? undefined;
      const titleForApprove = video.title ?? undefined;
      const metadataForApprove = video.metadata ?? undefined;
      setImmediate(() => {
        _generateVideoWithAI(
          video.id, video.prompt, video.videoLength ?? "15-20",
          voiceIdForApprove, customVoiceoverForApprove,
          finalScript, titleForApprove, metadataForApprove
        ).catch(console.error);
      });
      return { success: true };
    }),
    regenScript: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      if (video.status !== "failed") throw new TRPCError({ code: "BAD_REQUEST", message: "Only failed videos can be retried" });
      // Reset to pending and re-run full pipeline (no script review)
      await updateVideoStatus(video.id, "pending", {
        progressStep: "🔄 Retrying...",
        progressPercent: 0,
      });
      generateFullVideo(video.id, video.prompt, video.videoLength ?? "15-20", (video as { videoType?: string | null }).videoType ?? "documentary", (video as { voiceId?: string | null }).voiceId ?? undefined, video.customVoiceoverUrl ?? undefined).catch(console.error);
      return { success: true };
    }),
    rejectScript: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      if (video.status !== "awaiting_approval") throw new TRPCError({ code: "BAD_REQUEST", message: "Video is not awaiting approval" });
      await updateVideoStatus(video.id, "failed", {
        scriptApproved: 2,
        errorMessage: "Script rejected by user",
        progressStep: "Script rejected",
        progressPercent: 0,
      });
      return { success: true };
    }),
    pollStatus: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      return { status: video.status, title: video.title, script: video.script, metadata: video.metadata, thumbnailUrl: video.thumbnailUrl, progressStep: video.progressStep, progressPercent: video.progressPercent ?? 0, generationStartedAt: video.generationStartedAt, videoType: video.videoType };
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
      videoType: z.enum(["documentary", "listicle", "tutorial", "explainer"]).default("documentary"),
    })).mutation(async ({ ctx, input }) => {
      const videoId = await createVideo({ userId: ctx.user.id, prompt: input.prompt, videoLength: input.videoLength, videoType: input.videoType });
      // Use generateFullVideo (full pipeline: script → voiceover → visuals → assembly)
      generateFullVideo(videoId, input.prompt, input.videoLength, input.videoType).catch(console.error);
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

    // ─── Invite Codes ────────────────────────────────────────────────────────
    listInviteCodes: adminProcedure.query(async () => getAllInviteCodes()),
    createInviteCode: adminProcedure
      .input(z.object({ note: z.string().max(256).optional() }))
      .mutation(async ({ ctx, input }) => {
        const code = generateInviteCode();
        const id = await createInviteCode({
          code,
          createdByUserId: ctx.user.id,
          note: input.note ?? null,
          isActive: 1,
        });
        return { id, code };
      }),
    deleteInviteCode: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteInviteCode(input.id);
        return { success: true };
      }),
    deactivateInviteCode: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deactivateInviteCode(input.id);
        return { success: true };
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
        const customer = await getStripe().customers.create({
          email: ctx.user.email ?? undefined,
          name: ctx.user.name ?? undefined,
          metadata: { userId: ctx.user.id.toString() },
        });
        customerId = customer.id;
        await updateUserSubscription(ctx.user.id, { stripeCustomerId: customerId });
      }
      // Create a recurring price on the fly (or use a pre-created one)
      const price = await getStripe().prices.create({
        currency: FASTVID_PRO_PLAN.currency,
        unit_amount: FASTVID_PRO_PLAN.priceEur,
        recurring: { interval: FASTVID_PRO_PLAN.interval },
        product_data: { name: FASTVID_PRO_PLAN.name },
      });
      const session = await getStripe().checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: `${input.origin}/dashboard?payment=success`,
        cancel_url: `${input.origin}/subscribe?payment=cancelled`,
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

    /** Admin: reset / upsert all default voices with real Fish Audio reference IDs */
    resetDefaults: adminProcedure.mutation(async () => {
      const db = await import("./db").then(m => m.getDb());
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const { voices: voicesTable } = await import("../drizzle/schema");
      const defaults = [
        { name: "Energetic Male",  description: "American Male — energetic, YouTube-style narrator",  fishAudioReferenceId: "802e3bc2b27e49c2995d23ef70e6ac89", flag: "🇺🇸", sortOrder: 1, isActive: 1 },
        { name: "Adrian",          description: "American Male — deep, authoritative documentary voice", fishAudioReferenceId: "bf322df2096a46f18c579d0baa36f41d", flag: "🇺🇸", sortOrder: 2, isActive: 1 },
        { name: "Ethan",           description: "American Male — clear, conversational narrator",        fishAudioReferenceId: "536d3a5e000945adb7038665781a4aca", flag: "🇺🇸", sortOrder: 3, isActive: 1 },
        { name: "Sarah",           description: "American Female — warm, professional narrator",         fishAudioReferenceId: "933563129e564b19a115bedd57b7406a", flag: "🇺🇸", sortOrder: 4, isActive: 1 },
        { name: "JJK Narrator",    description: "Male — dramatic, cinematic storytelling voice",         fishAudioReferenceId: "179b5cc736974d96913c7849d0bb68c5", flag: "🎙️", sortOrder: 5, isActive: 1 },
        { name: "Jasphina",        description: "Female — clear, expressive English narrator",           fishAudioReferenceId: "e9b134e4c0b547a3894793be502314f1", flag: "🎙️", sortOrder: 6, isActive: 1 },
      ];
      // Delete all voices with placeholder IDs, then upsert real defaults
      const { eq, like } = await import("drizzle-orm");
      await db.delete(voicesTable).where(like(voicesTable.fishAudioReferenceId, "PLACEHOLDER%"));
      // Insert defaults that don't already exist (match by fishAudioReferenceId)
      let upserted = 0;
      for (const v of defaults) {
        const existing = await db.select().from(voicesTable).where(eq(voicesTable.fishAudioReferenceId, v.fishAudioReferenceId)).limit(1);
        if (existing.length === 0) {
          await db.insert(voicesTable).values(v);
          upserted++;
        } else {
          await db.update(voicesTable).set({ name: v.name, description: v.description, flag: v.flag, sortOrder: v.sortOrder, isActive: v.isActive }).where(eq(voicesTable.fishAudioReferenceId, v.fishAudioReferenceId));
          upserted++;
        }
      }
      return { success: true, upserted };
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

    /** Subscribed users: upload their own voiceover audio (base64) and get back a storage URL */
    uploadCustom: subscribedProcedure.input(z.object({
      base64: z.string(),
      mimeType: z.string().default("audio/mpeg"),
      filename: z.string().max(256).optional(),
    })).mutation(async ({ ctx, input }) => {
      const buffer = Buffer.from(input.base64, "base64");
      const maxBytes = 50 * 1024 * 1024; // 50 MB
      if (buffer.length > maxBytes) throw new TRPCError({ code: "BAD_REQUEST", message: "File too large (max 50MB)" });
      const ext = input.mimeType.includes("wav") ? "wav" : input.mimeType.includes("ogg") ? "ogg" : "mp3";
      const key = `custom-voiceovers/${ctx.user.id}-${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      return { url };
    }),

    /** Public: generate a live 5-second Fish Audio preview for a given voice reference ID */
    preview: protectedProcedure.input(z.object({
      fishAudioReferenceId: z.string().min(1),
    })).mutation(async ({ input }) => {
      const apiKey = process.env.FISH_AUDIO_API_KEY;
      if (!apiKey) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Fish Audio API key not configured" });
      const previewText = "Hello! This is a preview of how this voice sounds. I hope you enjoy using it for your YouTube videos.";
      const response = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: previewText, reference_id: input.fishAudioReferenceId, format: "mp3", mp3_bitrate: 128, latency: "normal" }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const err = await response.text();
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Fish Audio preview failed: ${err}` });
      }
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const key = `voice-previews/${input.fishAudioReferenceId}-${Date.now()}.mp3`;
      const { url } = await storagePut(key, audioBuffer, "audio/mpeg");
      return { url };
    }),
  }),

  // ── Video Management ──────────────────────────────────────────────────────
  videoManage: router({
    /** Delete a single video (owner or admin) */
    delete: protectedProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      await deleteVideo(input.id);
      return { success: true };
    }),

    /** Update the title of a video (owner or admin) */
    updateTitle: protectedProcedure.input(z.object({ id: z.number().int(), title: z.string().min(1).max(200) })).mutation(async ({ ctx, input }) => {
      const video = await getVideoById(input.id);
      if (!video) throw new TRPCError({ code: "NOT_FOUND" });
      if (video.userId !== ctx.user.id && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      await updateVideoTitle(input.id, input.title);
      return { success: true };
    }),

    /** Delete all failed videos for the current user */
    deleteAllFailed: protectedProcedure.mutation(async ({ ctx }) => {
      const count = await deleteAllFailedVideosForUser(ctx.user.id);
      return { deleted: count };
    }),

    /** Admin: mark all stuck in-progress videos as failed */
    expireStuck: adminProcedure.mutation(async () => {
      const count = await expireStuckVideos(35);
      return { expired: count };
    }),

    /** Admin: reset stuck generating_voiceover/visuals/effects videos back to awaiting_approval */
    retryStuck: adminProcedure.mutation(async () => {
      const { getDb } = await import("./db");
      const { eq, or } = await import("drizzle-orm");
      const { videos } = await import("../drizzle/schema");
      const db = await getDb();
      if (!db) return { reset: 0 };
      const result = await db
        .update(videos)
        .set({
          status: "awaiting_approval",
          progressStep: "\u2705 Script ready \u2014 awaiting your approval",
          progressPercent: 28,
          errorMessage: null,
        })
        .where(
          or(
            eq(videos.status, "generating_voiceover"),
            eq(videos.status, "generating_visuals"),
            eq(videos.status, "generating_effects"),
          )
        );
      return { reset: (result as { rowsAffected?: number }).rowsAffected ?? 0 };
    }),
  }),
});

export type AppRouter = typeof appRouter;
