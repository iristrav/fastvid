import Stripe from "stripe";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  subscribedProcedure,
} from "./_core/trpc";
import {
  APP_ERROR,
  PIPELINE_ERROR,
  appErrorMessage,
  appErrorText,
  appTrpcError,
  normalizeStoredError,
  pipelineError,
} from "@shared/appErrors";
import type { TrpcContext } from "./_core/context";
import type { Video } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import {
  createVideo, getAllUsers, getAllVideos, getUserById, getUserByEmail,
  searchVideos, getUserStats, getVideoById, getVideosByUserId, getVideoStats,
  updateUserRole, updateUserSubscription, updateVideoStatus, updateVideoProgress, updateVideoProgressLog,
  touchVideoProgress,
  getAllVoices, getAllVoicesAdmin, getVoiceById, createVoice, updateVoice, deleteVoice, seedDefaultVoices,
  deleteVideo, updateVideoTitle, deleteAllFailedVideosForUser, expireStuckVideos, recoverVideoCompletionState, recoverAllStuckVideos, failPipelineIfStalled, ORPHANED_PIPELINE_STATUSES,
  createUser, updateUserLastSignedIn,
  getInviteCodeByCode, createInviteCode, getAllInviteCodes, markInviteCodeUsed, deleteInviteCode, deactivateInviteCode,
  getAllMediaArchives, getMediaArchiveById, createMediaArchiveUnique, updateMediaArchive, deleteMediaArchive,
  getMediaArchiveAssets, getMediaArchiveAssetById, createMediaArchiveAsset, updateMediaArchiveAsset, deleteMediaArchiveAsset, deleteMediaArchiveAssets, deleteAllMediaArchiveAssets,
  countMediaArchiveAssets, filterMediaArchiveAssets, normalizeMediaTags,
} from "./db";
import { storageGetSignedUrl } from "./storage";
import type { ProgressLogEntry } from "./db";
import { PIPELINE_DISPLAY_STAGES, resolvePipelineDisplayStage } from "@shared/pipelineProgress";
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

function isMuskTeslaPromptTopic(prompt: string, title: string): boolean {
  const text = `${prompt} ${title}`.toLowerCase();
  return /musk|tesla|spacex|starlink|gigafactory|cybertruck|falcon|starship/.test(text);
}

import { storagePut } from "./storage";
import { FASTVID_PRO_PLAN } from "./products";
import { processArchiveAssetUpload, ArchiveUploadError } from "./archiveUpload";
import { archiveAiTaggingEnabled } from "./archiveAssetTagging";
import { autoTitleArchiveAssets } from "./archiveBulkVisionTagging";
import { dedupeArchiveVisualDuplicates } from "./archiveClipDedup";
import { assessArchiveCoverageForPrompt } from "./archiveCoverage";
import {
  createNicheRequest,
  getLatestNicheRequest,
  getLatestOnboardingRequest,
  getNicheRequestById,
  linkNicheRequestsToUser,
  listAllNicheRequests,
  listNicheRequestsByUser,
  nicheRequestAllowsPlatformAccess,
  updateNicheRequest,
} from "./nicheRequestsDb";
import { updateVideoScenes, updateEditedVideoUrl, getVideoScenes, readVideoEditorSettings, updateVideoEditorSettings, type EditorScene, type EditorClip, getAllMediaArchives, getMediaArchiveAssets, countMediaArchiveAssets, filterMediaArchiveAssets } from "./db";
import {
  buildBeatMatchTags,
  listCuratedArchiveCandidates,
  rankArchivesForVisualQuery,
} from "./curatedMediaSourcing";
import { editorArchiveMediaUrl } from "./archiveMediaStream";
import { editorClipFromArchiveAsset, resolveEditorClipPreviewUrl } from "./editorClips";
import { runVideoPipeline } from "./videoPipeline";
import { forgotPassword, validateResetToken as validateResetTokenProcedure, resetPassword } from "./authPasswordReset";
import {
  buildOneShotScriptUserPrompt,
  buildOutlineUserPrompt,
  buildScriptLengthRefinePrompt,
  buildScriptWriterSystemPrompt,
  buildSectionUserPrompt,
  countNarrationWords,
  getScriptLengthBudget,
  scriptStillOnTopic,
  stripVisualTagsFromScript,
  OUTLINE_JSON_SCHEMA,
  type ScriptOutline,
} from "./scriptWriter";

// Lazy Stripe initialization — prevents crash on startup when STRIPE_SECRET_KEY is not yet set
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw appTrpcError(
        "INTERNAL_SERVER_ERROR",
        APP_ERROR.STRIPE_NOT_CONFIGURED,
        "Stripe is not configured. Please add STRIPE_SECRET_KEY to your environment variables"
      );
    }
    _stripe = new Stripe(key);
  }
  return _stripe;
}

function readEnableSubtitles(video: { enableSubtitles?: number | null }): boolean {
  return video.enableSubtitles !== 0;
}

function requireVideoAccess(
  video: Video | null | undefined,
  ctx: TrpcContext & { user: NonNullable<TrpcContext["user"]> }
): Video {
  if (!video) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Resource not found");
  if (video.userId !== ctx.user.id && ctx.user.role !== "admin") {
    throw appTrpcError("FORBIDDEN", APP_ERROR.FORBIDDEN_RESOURCE, "You do not have access to this resource");
  }
  return video;
}

// Global 1.5-hour (90-min) hard cap — pipeline is killed and marked failed after this
const MAX_VIDEO_GENERATION_MS = 90 * 60 * 1000; // 1.5 hours = 90 minutes

async function generateVideoWithAI(videoId: number, prompt: string, videoLength: string, voiceId?: string, customVoiceoverUrl?: string) {
  // Wrap the entire pipeline in a 1.5-hour hard timeout
  const timeoutHandle = setTimeout(async () => {
    console.error(`[Video Generation] Video ${videoId} exceeded 1.5-hour limit — marking as failed`);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: appErrorMessage(
        PIPELINE_ERROR.GENERATION_TIMEOUT,
        "Video generation exceeded 1.5 hours (90 minutes). Please retry with a shorter video"
      ),
      progressStep: "⏰ Generation timed out (max 1.5 hours exceeded)",
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
export async function generateFullVideoInternal(videoId: number, prompt: string, videoLength: string, videoType: string, voiceId?: string, customVoiceoverUrl?: string, enableSubtitles = false) {
  return generateFullVideo(videoId, prompt, videoLength, videoType, voiceId, customVoiceoverUrl, enableSubtitles);
}

async function generateFullVideo(videoId: number, prompt: string, videoLength: string, videoType: string, voiceId?: string, customVoiceoverUrl?: string, enableSubtitles = false) {
  const timeoutHandle = setTimeout(async () => {
    console.error(`[Video Generation] Video ${videoId} exceeded 1.5-hour limit — marking as failed`);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: appErrorMessage(
        PIPELINE_ERROR.GENERATION_TIMEOUT,
        "Video generation exceeded 1.5 hours (90 minutes). Please retry with a shorter video"
      ),
      progressStep: "⏰ Generation timed out (max 1.5 hours exceeded)",
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
          errorMessage: appErrorMessage(
            PIPELINE_ERROR.SCRIPT_FAILED,
            "Script generation failed — no script was saved. Please retry"
          ),
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
  } catch (error) {
    console.error(`[Video Generation] Pipeline error for video ${videoId}:`, error);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: normalizeStoredError(error),
      progressStep: "Generation failed",
      progressPercent: 0,
    }).catch(() => {});
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─── Phase A: Script-only generation (stops at awaiting_approval) ────────────
async function generateScriptOnly(videoId: number, prompt: string, videoLength: string, videoType: string) {
  const budget = getScriptLengthBudget(videoLength);
  const isTwoMin = videoLength === "2";
  const muskTopic = isMuskTeslaPromptTopic(prompt, prompt);
  const writerSystem = buildScriptWriterSystemPrompt(videoType);

  // Initialize progressLog for script stage
  const scriptStage = resolvePipelineDisplayStage("Script schrijven", 5);
  const scriptLog: ProgressLogEntry[] = [
    { step: scriptStage.label, startedAt: Date.now(), status: "active" },
  ];
  await updateVideoProgressLog(videoId, scriptLog).catch(() => {});

  try {
    await updateVideoStatus(videoId, "generating_script", {
      progressStep: scriptStage.label,
      progressPercent: 5,
      generationStartedAt: new Date(),
    });

    // 1–2 min: one LLM call (saves ~2–4 min vs outline + parallel sections + metadata)
    if (isTwoMin || videoLength === "1") {
      scriptLog[0].step = scriptStage.label;
      await updateVideoProgressLog(videoId, scriptLog).catch(() => {});
      await updateVideoProgress(videoId, scriptStage.label, 12);

      const shotResp = await invokeLLM({
        messages: [
          { role: "system", content: writerSystem },
          { role: "user", content: buildOneShotScriptUserPrompt(prompt, videoType, budget, muskTopic) },
        ],
      });
      let scriptContent = shotResp?.choices?.[0]?.message?.content ?? "";
      if (typeof scriptContent !== "string") scriptContent = "";
      scriptContent = scriptContent.trim();
      if (scriptContent.length < 200) {
        throw pipelineError(PIPELINE_ERROR.SCRIPT_FAILED, "Script generation returned empty content");
      }

      const titleMatch = scriptContent.match(/^#\s+(.+)$/m);
      let title = titleMatch?.[1]?.trim() || prompt.slice(0, 100);
      scriptContent = stripVisualTagsFromScript(scriptContent);

      let narrationWords = countNarrationWords(scriptContent);
      if (narrationWords < budget.minWords || narrationWords > budget.maxWords) {
        scriptLog.push({ step: scriptStage.label, startedAt: Date.now(), status: "active" });
        await updateVideoProgress(videoId, scriptStage.label, 22);
        const scriptBeforeRefine = scriptContent;
        try {
          const refineResp = await invokeLLM({
            messages: [
              { role: "system", content: writerSystem },
              {
                role: "user",
                content: buildScriptLengthRefinePrompt(scriptContent, budget, narrationWords, prompt),
              },
            ],
          });
          const refined = refineResp?.choices?.[0]?.message?.content ?? "";
          if (typeof refined === "string" && refined.trim().length > 200) {
            const candidate = refined.trim();
            if (scriptStillOnTopic(prompt, candidate)) {
              scriptContent = stripVisualTagsFromScript(candidate);
              narrationWords = countNarrationWords(scriptContent);
              const refinedTitle = scriptContent.match(/^#\s+(.+)$/m)?.[1]?.trim();
              if (refinedTitle) title = refinedTitle;
            } else {
              console.warn(
                `[Script] Video ${videoId}: length refine ignored — off-topic (${narrationWords} words kept)`
              );
              scriptContent = scriptBeforeRefine;
            }
          }
        } catch (err) {
          console.warn("[Script] Fast-path length refine failed (non-fatal):", err);
        }
      }
      console.log(
        `[Script] Video ${videoId} (fast): ${narrationWords} words (target ${budget.targetWords})`
      );

      scriptLog[0].completedAt = Date.now();
      scriptLog[0].status = "done";
      await updateVideoProgressLog(videoId, scriptLog).catch(() => {});

      scriptContent = stripVisualTagsFromScript(scriptContent);
      const metadata = { title, description: prompt, tags: [] as string[], chapters: [] as { time: string; title: string }[] };
      await updateVideoStatus(videoId, "awaiting_approval", {
        script: scriptContent,
        title,
        metadata,
        progressStep: "✅ Script ready — starting video production...",
        progressPercent: 28,
      });
      const savedVideo = await getVideoById(videoId);
      if (!savedVideo?.script) {
        throw pipelineError(
          PIPELINE_ERROR.SCRIPT_FAILED,
          `Script save verification failed for video ${videoId} — DB write did not persist`
        );
      }
      console.log(`[Script Generation] Fast script saved for video ${videoId} (${savedVideo.script.length} chars)`);
      return;
    }

    // Step 1a: Retention-first outline with exact section count + word budget
    const outlineResp = await invokeLLM({
      messages: [
        { role: "system", content: writerSystem },
        { role: "user", content: buildOutlineUserPrompt(prompt, videoType, budget) },
      ],
      response_format: OUTLINE_JSON_SCHEMA,
    });

    let outline: ScriptOutline = { title: prompt.slice(0, 80), hook: "", sections: [], cta: "" };
    try {
      const raw = outlineResp?.choices?.[0]?.message?.content ?? "{}";
      outline = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as ScriptOutline;
    } catch { /* use default */ }
    if (outline.sections.length !== budget.sectionCount) {
      console.warn(
        `[Script] Outline returned ${outline.sections.length} sections, expected ${budget.sectionCount}`
      );
    }
    let title = outline.title || prompt.slice(0, 100);

    // Mark research done, start writing
    scriptLog[0].completedAt = Date.now(); scriptLog[0].status = "done";
    scriptLog.push({ step: `✍️ Writing ${outline.sections.length} sections in parallel...`, startedAt: Date.now(), status: "active" });
    await updateVideoProgressLog(videoId, scriptLog).catch(() => {});
    await updateVideoProgress(videoId, `✍️ Writing ${outline.sections.length} sections in parallel...`, 12);

    // Step 1b: Generate each section AND metadata in parallel
    const sectionTotal = outline.sections.length || budget.sectionCount;
    const sectionPromises = outline.sections.map((sec, idx) =>
      invokeLLM({
        messages: [
          { role: "system", content: writerSystem },
          {
            role: "user",
            content: buildSectionUserPrompt(sec, idx, sectionTotal, prompt, title, budget, muskTopic),
          },
        ],
      }).then(r => { const c = r?.choices?.[0]?.message?.content ?? ""; return typeof c === "string" ? c : ""; })
      .catch(() => sec.keyPoints.join(". ") + ".")
    );

    const metaPromise = invokeLLM({
      messages: [
        { role: "system", content: "YouTube SEO expert. Respond with valid JSON only." },
        { role: "user", content: `YouTube metadata for: ${prompt} (${budget.label}, ${videoType} format)\nJSON: { title, description, tags: string[], chapters: [{time, title}] }` },
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
    // Mark writing done, start assembling
    const writingStep = scriptLog.find(e => e.status === "active");
    if (writingStep) { writingStep.completedAt = Date.now(); writingStep.status = "done"; }
    scriptLog.push({ step: "📋 Assembling final script...", startedAt: Date.now(), status: "active" });
    await updateVideoProgressLog(videoId, scriptLog).catch(() => {});
    await updateVideoProgress(videoId, "📋 Assembling script...", 22);

    // Assemble full script
    const scriptParts: string[] = [`# ${title}\n`, `## Opening\n${outline.hook}\n`];
    outline.sections.forEach((sec, idx) => scriptParts.push(`## ${sec.title}\n${sectionTexts[idx] ?? ""}\n`));
    scriptParts.push(`## CALL TO ACTION\n${outline.cta}\n`);
    let scriptContent = stripVisualTagsFromScript(scriptParts.join("\n"));

    let narrationWords = countNarrationWords(scriptContent);
    if (narrationWords < budget.minWords || narrationWords > budget.maxWords) {
      scriptLog.push({ step: "✂️ Adjusting script to target length...", startedAt: Date.now(), status: "active" });
      await updateVideoProgress(videoId, "✂️ Matching script length to video...", 24);
      const scriptBeforeRefine = scriptContent;
      try {
        const refineResp = await invokeLLM({
          messages: [
            { role: "system", content: writerSystem },
            {
              role: "user",
              content: buildScriptLengthRefinePrompt(scriptContent, budget, narrationWords, prompt),
            },
          ],
        });
        const refined = refineResp?.choices?.[0]?.message?.content ?? "";
        if (typeof refined === "string" && refined.trim().length > 200) {
          const candidate = refined.trim();
          if (scriptStillOnTopic(prompt, candidate)) {
            scriptContent = stripVisualTagsFromScript(candidate);
            narrationWords = countNarrationWords(scriptContent);
            const refinedTitle = scriptContent.match(/^#\s+(.+)$/m)?.[1]?.trim();
            if (refinedTitle) title = refinedTitle;
          } else {
            console.warn(
              `[Script] Video ${videoId}: length refine ignored — off-topic (${narrationWords} words kept)`
            );
            scriptContent = scriptBeforeRefine;
          }
        }
      } catch (err) {
        console.warn("[Script] Length refine pass failed (non-fatal):", err);
      }
      const refineStep = scriptLog.find((e) => e.status === "active");
      if (refineStep) {
        refineStep.completedAt = Date.now();
        refineStep.status = "done";
      }
    }
    console.log(
      `[Script] Video ${videoId}: ${narrationWords} words (target ${budget.targetWords}, ` +
      `${budget.minWords}–${budget.maxWords}) · ~${budget.targetSpokenSec}s VO`
    );

    let metadata: unknown = {};
    try {
      const rawMetaContent = metaResponse?.choices?.[0]?.message?.content ?? "{}";
      const metaContent = typeof rawMetaContent === "string" ? rawMetaContent : JSON.stringify(rawMetaContent);
      metadata = JSON.parse(metaContent);
    } catch { metadata = { title, description: prompt, tags: [], chapters: [] }; }

    // Mark assembling done
    const assemblingStep = scriptLog.find(e => e.status === "active");
    if (assemblingStep) { assemblingStep.completedAt = Date.now(); assemblingStep.status = "done"; }
    await updateVideoProgressLog(videoId, scriptLog).catch(() => {});

    // Save script and return (no pause — caller decides next step)
    scriptContent = stripVisualTagsFromScript(scriptContent);
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
      throw pipelineError(
        PIPELINE_ERROR.SCRIPT_FAILED,
        `Script save verification failed for video ${videoId} — DB write did not persist`
      );
    }
    console.log(`[Script Generation] Script saved and verified for video ${videoId} (${savedVideo.script.length} chars)`);
  } catch (error) {
    console.error("[Script Generation] Error:", error);
    await updateVideoStatus(videoId, "failed", {
      errorMessage: normalizeStoredError(error, PIPELINE_ERROR.SCRIPT_FAILED),
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
  enableSubtitles = false
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
      if (!video?.script) {
        throw pipelineError(PIPELINE_ERROR.SCRIPT_FAILED, "No approved script found");
      }
      approvedScript = video.script;
      approvedTitle = video.title ?? prompt.slice(0, 100);
      approvedMetadata = video.metadata ?? { title: approvedTitle, description: prompt, tags: [], chapters: [] };
    }

    // ── Stage 3: Run Full Video Pipeline (TTS + Visuals + FFmpeg) ────
    await updateVideoStatus(videoId, "generating_voiceover", {
      progressStep: resolvePipelineDisplayStage("Volledige voiceover in ElevenLabs", 30).label,
      progressPercent: 30,
    });

    // ── Step-by-step progress log ────────────────────────────────────────────
    // Each unique stage name becomes a row in the step list UI.
    // We track: startedAt, completedAt, status per step.
    const progressLog: ProgressLogEntry[] = [];
    let currentStageKey = "";

    const pushStep = async (rawStepName: string, percent: number) => {
      const { key, label } = resolvePipelineDisplayStage(rawStepName, percent);
      const now = Date.now();
      if (currentStageKey && currentStageKey !== key) {
        const prevLabel = PIPELINE_DISPLAY_STAGES.find((s) => s.key === currentStageKey)?.label;
        const prevEntry = prevLabel ? progressLog.find((e) => e.step === prevLabel) : undefined;
        if (prevEntry && prevEntry.status === "active") {
          prevEntry.completedAt = now;
          prevEntry.status = "done";
        }
      }
      if (key !== currentStageKey) {
        currentStageKey = key;
        const existing = progressLog.find((e) => e.step === label);
        if (!existing) {
          progressLog.push({ step: label, startedAt: now, status: "active" });
        } else {
          existing.status = "active";
        }
      }
      await Promise.all([
        updateVideoProgress(videoId, label, Math.min(percent, 95)).catch(() => {}),
        updateVideoProgressLog(videoId, progressLog).catch(() => {}),
      ]);
      // Update coarse status enum
      if (percent < 35) {
        await updateVideoStatus(videoId, "generating_voiceover").catch(() => {});
      } else if (percent < 75) {
        await updateVideoStatus(videoId, "generating_visuals").catch(() => {});
      } else {
        await updateVideoStatus(videoId, "generating_effects").catch(() => {});
      }
    };

    const pipelineHeartbeat = setInterval(() => {
      touchVideoProgress(videoId).catch(() => {});
    }, 20_000);
    let videoUrl: string;
    try {
      videoUrl = await runVideoPipeline(
        videoId,
        approvedScript,
        async (progress) => {
          const basePercent = 30;
          const pipelinePercent = Math.round(basePercent + (progress.percent * 0.65));
          await pushStep(progress.stage, pipelinePercent);
        },
        voiceId,
        customVoiceoverUrl,
        videoLength,
        enableSubtitles,
        prompt
      );
    } finally {
      clearInterval(pipelineHeartbeat);
    }

    // Mark last active step as done
    const lastActive = progressLog.find(e => e.status === "active");
    if (lastActive) { lastActive.completedAt = Date.now(); lastActive.status = "done"; }
    await updateVideoProgressLog(videoId, progressLog).catch(() => {});

    const finalTitle = (approvedMetadata as Record<string, string>).title ?? approvedTitle;

    progressLog.push({ step: resolvePipelineDisplayStage("Video complete", 100).label, startedAt: Date.now(), completedAt: Date.now(), status: "done" });
    await updateVideoProgressLog(videoId, progressLog).catch(() => {});

    await updateVideoStatus(videoId, "completed", {
      metadata: approvedMetadata,
      title: finalTitle,
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
      errorMessage: normalizeStoredError(error),
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
          throw appTrpcError("BAD_REQUEST", APP_ERROR.INVALID_INVITE, "Invalid or already used invite code");
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
          throw appTrpcError("BAD_REQUEST", APP_ERROR.INVALID_INVITE, "Invalid or already used invite code");
        }
        // Check email not already taken
        const existing = await getUserByEmail(input.email.toLowerCase());
        if (existing) {
          throw appTrpcError("CONFLICT", APP_ERROR.EMAIL_EXISTS, "An account with this email already exists");
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
        await linkNicheRequestsToUser(input.email.toLowerCase(), userId);
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
          throw appTrpcError("UNAUTHORIZED", APP_ERROR.INVALID_CREDENTIALS, "Invalid email or password");
        }
        const valid = await bcrypt.compare(input.password, user.passwordHash);
        if (!valid) {
          throw appTrpcError("UNAUTHORIZED", APP_ERROR.INVALID_CREDENTIALS, "Invalid email or password");
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
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await getVideosByUserId(ctx.user.id);
      return Promise.all(
        rows.map((v) =>
          v.status === "completed" || v.status === "failed" || v.status === "awaiting_approval"
            ? v
            : recoverVideoCompletionState(v)
        )
      );
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const raw = requireVideoAccess(await getVideoById(input.id), ctx);
      return recoverVideoCompletionState(raw);
    }),
    /** Return a direct presigned CloudFront URL for video playback (bypasses 307 redirect) */
    getVideoUrl: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.id), ctx);
      if (!video.videoUrl) return { url: null };
      // /local-storage/ URLs are served directly by Express — return as-is (Railway mode)
      if (video.videoUrl.startsWith("/local-storage/")) {
        const { localVideoFileExists } = await import("./storageLocal");
        if (!localVideoFileExists(video.videoUrl)) {
          return { url: null, fileMissing: true };
        }
        // Stream via authenticated endpoint (supports Range requests for HTML5 video)
        return { url: `/api/stream/video/${video.id}`, fileMissing: false };
      }
      // /manus-storage/ URLs need a presigned GET URL from Forge (Manus sandbox mode)
      const key = video.videoUrl.replace(/^\/manus-storage\//, "");
      try {
        const directUrl = await storageGetSignedUrl(key);
        return { url: directUrl };
      } catch (err) {
        console.error("[getVideoUrl] Failed to get signed URL:", err);
        // Fallback to the /manus-storage/ URL (works via 307 redirect in some browsers)
        return { url: video.videoUrl };
      }
    }),
    generate: subscribedProcedure.input(z.object({
      prompt: z.string().min(10).max(1000),
      videoLength: z.enum(["1", "2", "5-8", "8-12", "12-15", "15-20", "20+"]),
      videoType: z.enum(["documentary", "listicle", "tutorial", "explainer"]).default("documentary"),
      voiceId: z.string().optional(),
      customVoiceoverUrl: z.string().optional(),
      enableSubtitles: z.boolean().default(true),
    })).mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        const onboarding = await getLatestOnboardingRequest(ctx.user.id, ctx.user.email);
        if (onboarding && !nicheRequestAllowsPlatformAccess(onboarding, ctx.user.role)) {
          throw appTrpcError(
            "FORBIDDEN",
            APP_ERROR.SERVICE_ERROR,
            "Je niche-aanvraag wacht nog op goedkeuring. Binnen 2 werkdagen hoor je van ons."
          );
        }
      }

      const coverage = await assessArchiveCoverageForPrompt(input.prompt);
      const coverageNote = coverage.hasCoverage
        ? "🔍 Starting generation..."
        : "📦 Nog weinig archiefbeelden voor dit onderwerp — we bouwen verder aan je archief. Generatie duurt langer.";

      const videoId = await createVideo({
        userId: ctx.user.id,
        prompt: input.prompt,
        videoLength: input.videoLength,
        videoType: input.videoType,
        customVoiceoverUrl: input.customVoiceoverUrl,
        voiceId: input.voiceId,
        enableSubtitles: input.enableSubtitles ? 1 : 0,
        status: "pending",
        metadata: { archiveCoverage: coverage },
      });
      if (!videoId) throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.FAILED_CREATE_VIDEO, "Failed to create video");
      await updateVideoStatus(videoId, "generating_script", {
        progressStep: coverageNote,
        progressPercent: 1,
        generationStartedAt: new Date(),
      }).catch(() => {});
      // Direct full pipeline — no script review step
      generateFullVideo(videoId, input.prompt, input.videoLength, input.videoType, input.voiceId, input.customVoiceoverUrl, input.enableSubtitles).catch(console.error);
      return { videoId, message: "Video generation started" };
    }),
    approveScript: protectedProcedure.input(z.object({
      id: z.number(),
      editedScript: z.string().optional(), // allow user to edit script before approving
    })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.id), ctx);
      if (video.status !== "awaiting_approval") {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.VIDEO_NOT_AWAITING_APPROVAL, "Video is not awaiting approval");
      }
      // Use edited script if provided, otherwise use the stored script
      const finalScript = stripVisualTagsFromScript(input.editedScript ?? video.script ?? "");
      if (!finalScript) throw appTrpcError("BAD_REQUEST", APP_ERROR.NO_SCRIPT, "No script found");
      if (input.editedScript) {
        await updateVideoStatus(video.id, "awaiting_approval", { script: finalScript });
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
          finalScript, titleForApprove, metadataForApprove,
          readEnableSubtitles(video)
        ).catch(console.error);
      });
      return { success: true };
    }),
    regenScript: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.id), ctx);
      const retryable = video.status === "failed" || ORPHANED_PIPELINE_STATUSES.includes(
        video.status as (typeof ORPHANED_PIPELINE_STATUSES)[number]
      );
      if (!retryable) {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.VIDEO_RETRY_INVALID, "Only failed or stuck videos can be retried");
      }
      await updateVideoStatus(video.id, "pending", {
        errorMessage: "",
        progressStep: "🔄 Retrying...",
        progressPercent: 0,
        generationStartedAt: new Date(),
      });
      generateFullVideo(
        video.id,
        video.prompt,
        video.videoLength ?? "15-20",
        (video as { videoType?: string | null }).videoType ?? "documentary",
        (video as { voiceId?: string | null }).voiceId ?? undefined,
        video.customVoiceoverUrl ?? undefined,
        readEnableSubtitles(video)
      ).catch(console.error);
      return { success: true };
    }),
    rejectScript: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.id), ctx);
      if (video.status !== "awaiting_approval") {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.VIDEO_NOT_AWAITING_APPROVAL, "Video is not awaiting approval");
      }
      await updateVideoStatus(video.id, "failed", {
        scriptApproved: 2,
        errorMessage: appErrorMessage(PIPELINE_ERROR.SCRIPT_REJECTED, "Script rejected by user"),
        progressStep: "Script rejected",
        progressPercent: 0,
      });
      return { success: true };
    }),
    pollStatus: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const raw = requireVideoAccess(await getVideoById(input.id), ctx);
      let video = await recoverVideoCompletionState(raw);
      video = await failPipelineIfStalled(video);
      return {
        status: video.status,
        title: video.title,
        script: video.script,
        metadata: video.metadata,
        thumbnailUrl: video.thumbnailUrl,
        videoUrl: video.videoUrl,
        progressStep: video.progressStep,
        progressPercent: video.progressPercent ?? 0,
        progressLog: ((video as unknown as Record<string, unknown>).progressLog ?? []) as import('./db').ProgressLogEntry[],
        generationStartedAt: video.generationStartedAt,
        videoType: video.videoType,
      };
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
      videoLength: z.enum(["1", "2", "5-8", "8-12", "12-15", "15-20", "20+"]),
      videoType: z.enum(["documentary", "listicle", "tutorial", "explainer"]).default("documentary"),
    })).mutation(async ({ ctx, input }) => {
      const videoId = await createVideo({ userId: ctx.user.id, prompt: input.prompt, videoLength: input.videoLength, videoType: input.videoType });
      if (!videoId) throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.FAILED_CREATE_VIDEO, "Failed to create video");
      await updateVideoStatus(videoId, "generating_script", {
        progressStep: "🔍 Starting generation...",
        progressPercent: 1,
        generationStartedAt: new Date(),
      }).catch(() => {});
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
      if (!user) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Resource not found");
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
      if (!process.env.STRIPE_SECRET_KEY) {
        throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.STRIPE_NOT_CONFIGURED, "Stripe not configured");
      }
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
      if (!db) throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.DATABASE_UNAVAILABLE, "Database not available");
      const { voices: voicesTable } = await import("../drizzle/schema");
      const defaults = [
        // ElevenLabs premade voice IDs — always available on any ElevenLabs account
        { name: "Adam",     description: "American Male — deep, authoritative documentary voice",     fishAudioReferenceId: "pNInz6obpgDQGcFmaJgB", flag: "🇺🇸", sortOrder: 1, isActive: 1 },
        { name: "Rachel",   description: "American Female — warm, calm narrator",                    fishAudioReferenceId: "21m00Tcm4TlvDq8ikWAM", flag: "🇺🇸", sortOrder: 2, isActive: 1 },
        { name: "Domi",     description: "American Female — strong, confident narrator",             fishAudioReferenceId: "AZnzlk1XvdvUeBnXmlld", flag: "🇺🇸", sortOrder: 3, isActive: 1 },
        { name: "Bella",    description: "American Female — clear, professional narrator",            fishAudioReferenceId: "EXAVITQu4vr4xnSDxMaL", flag: "🇺🇸", sortOrder: 4, isActive: 1 },
        { name: "Arnold",   description: "American Male — crisp, authoritative narrator",            fishAudioReferenceId: "VR6AewLTigWG4xSOukaG", flag: "🇺🇸", sortOrder: 5, isActive: 1 },
        { name: "Josh",     description: "American Male — natural, YouTube-style narrator",          fishAudioReferenceId: "TxGEqnHWrfWFTfGW9XjX", flag: "🇺🇸", sortOrder: 6, isActive: 1 },
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
      if (!voice) throw appTrpcError("NOT_FOUND", APP_ERROR.VOICE_NOT_FOUND, "Voice not found");
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
      if (buffer.length > maxBytes) {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.FILE_TOO_LARGE, "File too large (max 50MB)");
      }
      const ext = input.mimeType.includes("wav") ? "wav" : input.mimeType.includes("ogg") ? "ogg" : "mp3";
      const key = `custom-voiceovers/${ctx.user.id}-${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      return { url };
    }),

    /** Public: generate a live 5-second ElevenLabs preview for a given voice ID */
    preview: protectedProcedure.input(z.object({
      fishAudioReferenceId: z.string().min(1),
    })).mutation(async ({ input }) => {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.ELEVENLABS_NOT_CONFIGURED, "ElevenLabs API key not configured");
      }
      const previewText = "Hello! This is a preview of how this voice sounds. I hope you enjoy using it for your YouTube videos.";
      const voiceId = input.fishAudioReferenceId; // column still named fishAudioReferenceId but stores ElevenLabs voice ID
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({ text: previewText, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const err = await response.text();
        throw appTrpcError(
          "INTERNAL_SERVER_ERROR",
          APP_ERROR.SERVICE_ERROR,
          `ElevenLabs preview failed: ${err.slice(0, 200)}`
        );
      }
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const key = `voice-previews/${voiceId}-${Date.now()}.mp3`;
      const { url } = await storagePut(key, audioBuffer, "audio/mpeg");
      return { url };
    }),
  }),

  nicheRequest: router({
    accessStatus: protectedProcedure.query(async ({ ctx }) => {
      const onboarding = await getLatestOnboardingRequest(ctx.user.id, ctx.user.email);
      const canUsePlatform = nicheRequestAllowsPlatformAccess(onboarding, ctx.user.role);
      return {
        canUsePlatform,
        onboarding: onboarding ?? null,
        hasOnboardingRequest: Boolean(onboarding),
      };
    }),

    listMine: protectedProcedure.query(async ({ ctx }) => {
      return listNicheRequestsByUser(ctx.user.id);
    }),

    submitRequest: publicProcedure.input(z.object({
      contactEmail: z.string().email(),
      nicheTitle: z.string().min(2).max(256),
      titleStructure: z.string().min(3).max(2000),
      topics: z.string().min(3).max(2000),
      requestType: z.enum(["onboarding", "new_channel"]).default("onboarding"),
    })).mutation(async ({ ctx, input }) => {
      if (input.requestType === "new_channel" && !ctx.user) {
        throw appTrpcError("UNAUTHORIZED", APP_ERROR.SERVICE_ERROR, "Log in om een extra kanaal aan te vragen.");
      }

      const contactEmail = input.contactEmail.toLowerCase().trim();
      const userId = ctx.user?.id ?? null;

      if (input.requestType === "onboarding") {
        const existing = await getLatestOnboardingRequest(userId ?? undefined, contactEmail);
        if (existing && existing.status === "pending") {
          throw appTrpcError("BAD_REQUEST", APP_ERROR.SERVICE_ERROR, "Je aanvraag is al ingediend en wacht op goedkeuring.");
        }
        if (existing && ["approved", "in_progress", "ready"].includes(existing.status)) {
          throw appTrpcError("BAD_REQUEST", APP_ERROR.SERVICE_ERROR, "Je niche-aanvraag is al goedgekeurd.");
        }
      }

      const id = await createNicheRequest({
        userId,
        contactEmail,
        requestType: input.requestType,
        nicheTitle: input.nicheTitle.trim(),
        channelName: null,
        videoFormat: null,
        titleStructure: input.titleStructure.trim(),
        topics: input.topics.trim(),
        description: null,
        status: "pending",
      });
      if (!id) throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.SERVICE_ERROR, "Aanvraag opslaan mislukt");

      const request = await getNicheRequestById(id);
      return { request };
    }),

    checkArchiveCoverage: protectedProcedure.input(z.object({
      prompt: z.string().min(3).max(1000),
    })).query(async ({ input }) => {
      return assessArchiveCoverageForPrompt(input.prompt);
    }),

    listAll: adminProcedure.query(async () => {
      const rows = await listAllNicheRequests();
      const enriched = await Promise.all(
        rows.map(async (r) => {
          const user = r.userId ? await getUserById(r.userId) : undefined;
          return {
            ...r,
            userName: user?.name ?? null,
            userEmail: user?.email ?? r.contactEmail ?? null,
          };
        })
      );
      return enriched;
    }),

    updateStatus: adminProcedure.input(z.object({
      id: z.number().int(),
      status: z.enum(["pending", "approved", "in_progress", "ready", "rejected"]),
      adminNotes: z.string().max(2000).optional(),
      linkedArchiveId: z.number().int().optional(),
    })).mutation(async ({ ctx, input }) => {
      const req = await getNicheRequestById(input.id);
      if (!req) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Aanvraag niet gevonden");

      await updateNicheRequest(input.id, {
        status: input.status,
        adminNotes: input.adminNotes?.trim() || null,
        linkedArchiveId: input.linkedArchiveId ?? null,
        reviewedByUserId: ctx.user.id,
        reviewedAt: new Date(),
      });
      return { success: true };
    }),
  }),

  mediaArchive: router({
    listArchives: adminProcedure.query(async () => {
      const archives = await getAllMediaArchives();
      const counts = await Promise.all(archives.map((a) => countMediaArchiveAssets(a.id)));
      return archives.map((a, i) => ({ ...a, assetCount: counts[i] ?? 0 }));
    }),

    createArchive: adminProcedure.input(z.object({
      name: z.string().min(1).max(256),
      description: z.string().max(2000).optional(),
      nicheTags: z.array(z.string().min(1).max(64)).max(32).default([]),
    })).mutation(async ({ ctx, input }) => {
      const id = await createMediaArchiveUnique({
        name: input.name.trim(),
        slugBase: input.name,
        description: input.description?.trim() || null,
        nicheTags: normalizeMediaTags(input.nicheTags),
        createdByUserId: ctx.user.id,
        isActive: 1,
      });
      if (!id) throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.SERVICE_ERROR, "Failed to create archive");
      const archive = await getMediaArchiveById(id);
      return { archive };
    }),

    updateArchive: adminProcedure.input(z.object({
      id: z.number().int(),
      name: z.string().min(1).max(256).optional(),
      description: z.string().max(2000).optional(),
      nicheTags: z.array(z.string().min(1).max(64)).max(32).optional(),
      isActive: z.number().int().min(0).max(1).optional(),
    })).mutation(async ({ input }) => {
      const archive = await getMediaArchiveById(input.id);
      if (!archive) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive not found");
      const patch: Parameters<typeof updateMediaArchive>[1] = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.description !== undefined) patch.description = input.description.trim() || null;
      if (input.nicheTags !== undefined) patch.nicheTags = normalizeMediaTags(input.nicheTags);
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      await updateMediaArchive(input.id, patch);
      return { success: true };
    }),

    deleteArchive: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
      const archive = await getMediaArchiveById(input.id);
      if (!archive) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive not found");
      await deleteMediaArchive(input.id);
      return { success: true };
    }),

    listAssets: adminProcedure.input(z.object({
      archiveId: z.number().int(),
      search: z.string().max(128).optional(),
      tag: z.string().max(64).optional(),
    })).query(async ({ input }) => {
      const archive = await getMediaArchiveById(input.archiveId);
      if (!archive) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive not found");
      const assets = await getMediaArchiveAssets(input.archiveId);
      return filterMediaArchiveAssets(assets, { search: input.search, tag: input.tag });
    }),

    uploadAsset: adminProcedure.input(z.object({
      archiveId: z.number().int(),
      title: z.string().max(512).optional(),
      tags: z.array(z.string().min(1).max(64)).max(32).default([]),
      mixKind: z.enum(["real_video", "photo", "stock", "screenshot", "motion_graphics"]).optional(),
      sourceNote: z.string().max(512).optional(),
      fileBase64: z.string().min(1),
      mimeType: z.string().min(1),
      filename: z.string().max(256).optional(),
      /** Video only: auto-detect scene changes and store multiple clips (default on). */
      autoSplitScenes: z.boolean().default(true),
      /** Analyze image / video frame with AI for title + tags (default on, needs LLM_API_KEY). */
      autoGenerateTags: z.boolean().default(true),
    })).mutation(async ({ input }) => {
      try {
        const buffer = Buffer.from(input.fileBase64, "base64");
        return await processArchiveAssetUpload({
          archiveId: input.archiveId,
          buffer,
          mimeType: input.mimeType,
          filename: input.filename,
          title: input.title,
          tags: input.tags,
          mixKind: input.mixKind,
          sourceNote: input.sourceNote,
          autoSplitScenes: input.autoSplitScenes,
          autoGenerateTags: input.autoGenerateTags,
        });
      } catch (err) {
        if (err instanceof ArchiveUploadError) {
          const trpcCode =
            err.status === 404 ? "NOT_FOUND" as const
            : err.status === 400 ? "BAD_REQUEST" as const
            : "INTERNAL_SERVER_ERROR" as const;
          const appCode =
            err.status === 404 ? APP_ERROR.NOT_FOUND
            : err.status === 400 ? APP_ERROR.FILE_TOO_LARGE
            : APP_ERROR.SERVICE_ERROR;
          throw appTrpcError(trpcCode, appCode, appErrorText(err.message));
        }
        throw err;
      }
    }),

    updateAsset: adminProcedure.input(z.object({
      id: z.number().int(),
      title: z.string().max(512).optional(),
      tags: z.array(z.string().min(1).max(64)).max(32).optional(),
      mixKind: z.enum(["real_video", "photo", "stock", "screenshot", "motion_graphics"]).optional(),
      sourceNote: z.string().max(512).optional(),
    })).mutation(async ({ input }) => {
      const asset = await getMediaArchiveAssetById(input.id);
      if (!asset) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Asset not found");
      const patch: Parameters<typeof updateMediaArchiveAsset>[1] = {};
      if (input.title !== undefined) patch.title = input.title.trim() || null;
      if (input.tags !== undefined) patch.tags = normalizeMediaTags(input.tags);
      if (input.mixKind !== undefined) patch.mixKind = input.mixKind;
      if (input.sourceNote !== undefined) patch.sourceNote = input.sourceNote.trim() || null;
      await updateMediaArchiveAsset(input.id, patch);
      return { success: true };
    }),

    /** Vision AI: title + tags from clip content (batch max 50 ids per call). */
    autoTitleAssets: adminProcedure.input(z.object({
      archiveId: z.number().int(),
      ids: z.array(z.number().int()).min(1).max(50),
    })).mutation(async ({ input }) => {
      if (!archiveAiTaggingEnabled()) {
        throw appTrpcError(
          "BAD_REQUEST",
          APP_ERROR.SERVICE_ERROR,
          "AI-tags uitgeschakeld — zet LLM_API_KEY op de server"
        );
      }
      const archive = await getMediaArchiveById(input.archiveId);
      if (!archive) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive not found");
      try {
        return await autoTitleArchiveAssets({
          archiveId: input.archiveId,
          ids: input.ids,
        });
      } catch (err) {
        throw appTrpcError(
          "INTERNAL_SERVER_ERROR",
          APP_ERROR.SERVICE_ERROR,
          (err as Error).message ?? "Auto-title failed"
        );
      }
    }),

    /** Remove visually duplicate clips (keeps oldest per duplicate group). */
    dedupeDuplicateAssets: adminProcedure.input(z.object({
      archiveId: z.number().int(),
      ids: z.array(z.number().int()).optional(),
    })).mutation(async ({ input }) => {
      const archive = await getMediaArchiveById(input.archiveId);
      if (!archive) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive not found");

      let assets = await getMediaArchiveAssets(input.archiveId);
      if (input.ids?.length) {
        const idSet = new Set(input.ids);
        assets = assets.filter((a) => idSet.has(a.id));
      }
      if (assets.length < 2) {
        return { scanned: assets.length, deleted: 0, kept: assets.length };
      }

      const { deleteIds, scanned } = await dedupeArchiveVisualDuplicates(assets);
      if (deleteIds.length > 0) {
        await deleteMediaArchiveAssets(deleteIds);
      }
      return {
        scanned,
        deleted: deleteIds.length,
        kept: assets.length - deleteIds.length,
      };
    }),

    deleteAsset: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
      const asset = await getMediaArchiveAssetById(input.id);
      if (!asset) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Asset not found");
      await deleteMediaArchiveAsset(input.id);
      return { success: true };
    }),

    deleteAssets: adminProcedure.input(z.object({
      ids: z.array(z.number().int()).min(1),
    })).mutation(async ({ input }) => {
      const uniqueIds = [...new Set(input.ids)];
      for (const id of uniqueIds) {
        const asset = await getMediaArchiveAssetById(id);
        if (!asset) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, `Asset ${id} not found`);
      }
      const deleted = await deleteMediaArchiveAssets(uniqueIds);
      return { success: true, deleted: deleted ?? uniqueIds.length };
    }),

    deleteAllAssets: adminProcedure.input(z.object({
      archiveId: z.number().int(),
      search: z.string().max(200).optional(),
    })).mutation(async ({ input }) => {
      const archive = await getMediaArchiveById(input.archiveId);
      if (!archive) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive not found");
      const deleted = await deleteAllMediaArchiveAssets(input.archiveId, {
        search: input.search?.trim() || undefined,
      });
      return { success: true, deleted };
    }),
  }),

  // ── Video Management ──────────────────────────────────────────────────────
  videoManage: router({
    /** Delete a single video (owner or admin) */
    delete: protectedProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.id), ctx);
      await deleteVideo(input.id);
      return { success: true };
    }),

    /** Update the title of a video (owner or admin) */
    updateTitle: protectedProcedure.input(z.object({ id: z.number().int(), title: z.string().min(1).max(200) })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.id), ctx);
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

  // ── Video Editor ─────────────────────────────────────────────────────────────
  editor: router({
    /** Get the scene manifest for a completed video */
    getScenes: protectedProcedure.input(z.object({ videoId: z.number().int() })).query(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.videoId), ctx);
      const rawScenes = await getVideoScenes(input.videoId);
      const scenes = (rawScenes ?? []).map((scene) => ({
        ...scene,
        clips: scene.clips.map((clip) => ({
          ...clip,
          url: resolveEditorClipPreviewUrl(clip),
          thumbnailUrl: resolveEditorClipPreviewUrl(clip),
        })),
      }));
      return {
        scenes,
        videoTitle: video.title ?? video.prompt,
        videoUrl: video.editedVideoUrl ?? video.videoUrl,
        originalVideoUrl: video.videoUrl,
        editedVideoUrl: video.editedVideoUrl,
        archiveOnly: true,
        ...readVideoEditorSettings(video),
      };
    }),

    /** Update editor audio/visual settings (subtitles, background music). */
    updateSettings: protectedProcedure.input(z.object({
      videoId: z.number().int(),
      enableSubtitles: z.boolean().optional(),
      backgroundMusicUrl: z.string().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);
      await updateVideoEditorSettings(input.videoId, {
        enableSubtitles: input.enableSubtitles,
        backgroundMusicUrl: input.backgroundMusicUrl,
      });
      return { success: true };
    }),

    /** Upload custom background music (MP3/WAV) for re-render. */
    uploadBackgroundMusic: protectedProcedure.input(z.object({
      videoId: z.number().int(),
      base64: z.string(),
      mimeType: z.string().default("audio/mpeg"),
      filename: z.string().max(256).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);
      const buffer = Buffer.from(input.base64, "base64");
      const maxBytes = 50 * 1024 * 1024;
      if (buffer.length > maxBytes) {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.FILE_TOO_LARGE, "File too large (max 50MB)");
      }
      const allowed = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/aac"];
      if (!input.mimeType.startsWith("audio/") && !allowed.includes(input.mimeType)) {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.SERVICE_ERROR, "Unsupported audio format. Use MP3 or WAV.");
      }
      const ext = input.mimeType.includes("wav") ? "wav" : input.mimeType.includes("ogg") ? "ogg" : "mp3";
      const key = `editor-bgm/${ctx.user.id}-${input.videoId}-${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      await updateVideoEditorSettings(input.videoId, { backgroundMusicUrl: url });
      return { url };
    }),

    /** Update a single scene's clips or narration */
    updateScene: protectedProcedure.input(z.object({
      videoId: z.number().int(),
      sceneIndex: z.number().int(),
      clips: z.array(z.object({
        url: z.string(),
        type: z.enum(["video", "image"]),
        source: z.string(),
        thumbnailUrl: z.string().optional(),
        archiveAssetId: z.number().int().optional(),
        storageUrl: z.string().optional(),
        title: z.string().optional(),
      })).optional(),
      narration: z.string().optional(),
      durationMs: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.videoId), ctx);
      const scenes = await getVideoScenes(input.videoId);
      if (!scenes) {
        throw appTrpcError(
          "NOT_FOUND",
          APP_ERROR.SCENE_MANIFEST_NOT_FOUND,
          "Scene manifest not found. Video may need to be regenerated"
        );
      }
      const sceneIdx = scenes.findIndex(s => s.sceneIndex === input.sceneIndex);
      if (sceneIdx === -1) {
        throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, `Scene ${input.sceneIndex} not found`);
      }
      if (input.clips !== undefined) scenes[sceneIdx].clips = input.clips as EditorClip[];
      if (input.narration !== undefined) scenes[sceneIdx].narration = input.narration;
      if (input.durationMs !== undefined) scenes[sceneIdx].durationMs = input.durationMs;
      await updateVideoScenes(input.videoId, scenes);
      return { success: true, scene: scenes[sceneIdx] };
    }),

    /** List active media archives for the editor media picker. */
    listArchives: protectedProcedure.query(async () => {
      const archives = (await getAllMediaArchives()).filter((a) => a.isActive === 1);
      const withCounts = await Promise.all(
        archives.map(async (a) => ({
          id: a.id,
          name: a.name,
          nicheTags: a.nicheTags ?? [],
          assetCount: await countMediaArchiveAssets(a.id),
        }))
      );
      return { archives: withCounts };
    }),

    /** Search the media archive to replace a clip (title + tags). */
    searchArchive: protectedProcedure.input(z.object({
      videoId: z.number().int(),
      query: z.string().max(200).optional(),
      archiveId: z.number().int().optional(),
      tag: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(80).default(40),
    })).query(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.videoId), ctx);
      const topic = video.title ?? video.prompt ?? "";
      const q = input.query?.trim() ?? "";

      if (input.archiveId) {
        let assets = await getMediaArchiveAssets(input.archiveId);
        if (q || input.tag) {
          assets = filterMediaArchiveAssets(assets, { search: q || undefined, tag: input.tag });
        }
        return {
          results: assets.slice(0, input.limit).map((asset) => ({
            assetId: asset.id,
            title: asset.title ?? `Asset ${asset.id}`,
            tags: asset.tags ?? [],
            mediaType: asset.mediaType,
            previewUrl: editorArchiveMediaUrl(asset.id),
            durationSec: asset.durationSec,
            archiveName: "",
            score: 1,
          })),
        };
      }

      const { beatTags, topicAnchors, allTags } = buildBeatMatchTags(
        { keywords: [], text: q || topic, index: 0, searchQuery: q || undefined },
        { text: topic },
        topic
      );
      const autoArchives = await rankArchivesForVisualQuery(allTags, topicAnchors);
      const candidates = await listCuratedArchiveCandidates(
        beatTags,
        new Set(),
        new Set(),
        topicAnchors,
        allTags
      );

      return {
        autoArchives: autoArchives.filter((a) => a.score >= 8).slice(0, 3),
        results: candidates.slice(0, input.limit).map(({ asset, archiveName, score }) => ({
          assetId: asset.id,
          title: asset.title ?? `Asset ${asset.id}`,
          tags: asset.tags ?? [],
          mediaType: asset.mediaType,
          previewUrl: editorArchiveMediaUrl(asset.id),
          durationSec: asset.durationSec,
          archiveName,
          score,
        })),
      };
    }),

    /** Build an EditorClip from a selected archive asset. */
    pickArchiveAsset: protectedProcedure.input(z.object({
      videoId: z.number().int(),
      assetId: z.number().int(),
    })).query(async ({ ctx, input }) => {
      requireVideoAccess(await getVideoById(input.videoId), ctx);
      const { getMediaArchiveAssetById } = await import("./db");
      const asset = await getMediaArchiveAssetById(input.assetId);
      if (!asset || asset.isActive !== 1) {
        throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Archive asset not found");
      }
      return { clip: editorClipFromArchiveAsset(asset) };
    }),

    /** Search for media clips from Pexels or Pixabay */
    searchMedia: protectedProcedure.input(z.object({
      query: z.string().min(1).max(200),
      source: z.enum(["pexels", "pixabay"]).default("pexels"),
      mediaType: z.enum(["video", "image", "both"]).default("both"),
      page: z.number().int().min(1).default(1),
    })).query(async ({ input }) => {
      const results: Array<{ url: string; thumbnailUrl: string; type: "video" | "image"; source: string; width?: number; height?: number; duration?: number; author?: string }> = [];

      if (input.source === "pexels") {
        const pexelsKey = process.env.PEXELS_API_KEY;
        if (!pexelsKey) {
          throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.PEXELS_NOT_CONFIGURED, "Pexels API key not configured");
        }

        if (input.mediaType === "video" || input.mediaType === "both") {
          try {
            const resp = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(input.query)}&per_page=12&page=${input.page}`, {
              headers: { Authorization: pexelsKey },
              signal: AbortSignal.timeout(10_000),
            });
            if (resp.ok) {
              const data = await resp.json() as { videos?: Array<{ video_files: Array<{ link: string; width: number; height: number; quality: string }>; image: string; duration: number; user: { name: string } }> };
              for (const v of (data.videos ?? []).slice(0, 8)) {
                const hd = v.video_files.find(f => f.quality === "hd") ?? v.video_files[0];
                if (hd) results.push({ url: hd.link, thumbnailUrl: v.image, type: "video", source: "pexels", width: hd.width, height: hd.height, duration: v.duration, author: v.user?.name });
              }
            }
          } catch { /* ignore */ }
        }

        if (input.mediaType === "image" || input.mediaType === "both") {
          try {
            const resp = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(input.query)}&per_page=12&page=${input.page}`, {
              headers: { Authorization: pexelsKey },
              signal: AbortSignal.timeout(10_000),
            });
            if (resp.ok) {
              const data = await resp.json() as { photos?: Array<{ src: { original: string; large: string }; width: number; height: number; photographer: string }> };
              for (const p of (data.photos ?? []).slice(0, 8)) {
                results.push({ url: p.src.original, thumbnailUrl: p.src.large, type: "image", source: "pexels", width: p.width, height: p.height, author: p.photographer });
              }
            }
          } catch { /* ignore */ }
        }
      } else if (input.source === "pixabay") {
        const pixabayKey = process.env.PIXABAY_API_KEY;
        if (!pixabayKey) {
          throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.PIXABAY_NOT_CONFIGURED, "Pixabay API key not configured");
        }

        if (input.mediaType === "video" || input.mediaType === "both") {
          try {
            const resp = await fetch(`https://pixabay.com/api/videos/?key=${pixabayKey}&q=${encodeURIComponent(input.query)}&per_page=12&page=${input.page}`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (resp.ok) {
              const data = await resp.json() as { hits?: Array<{ videos: { medium: { url: string; width: number; height: number } }; userImageURL: string; duration: number; user: string }> };
              for (const v of (data.hits ?? []).slice(0, 8)) {
                const med = v.videos?.medium;
                if (med) results.push({ url: med.url, thumbnailUrl: v.userImageURL, type: "video", source: "pixabay", width: med.width, height: med.height, duration: v.duration, author: v.user });
              }
            }
          } catch { /* ignore */ }
        }

        if (input.mediaType === "image" || input.mediaType === "both") {
          try {
            const resp = await fetch(`https://pixabay.com/api/?key=${pixabayKey}&q=${encodeURIComponent(input.query)}&per_page=12&page=${input.page}&image_type=photo`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (resp.ok) {
              const data = await resp.json() as { hits?: Array<{ largeImageURL: string; webformatURL: string; imageWidth: number; imageHeight: number; user: string }> };
              for (const p of (data.hits ?? []).slice(0, 8)) {
                results.push({ url: p.largeImageURL, thumbnailUrl: p.webformatURL, type: "image", source: "pixabay", width: p.imageWidth, height: p.imageHeight, author: p.user });
              }
            }
          } catch { /* ignore */ }
        }
      }

      return { results };
    }),

    /** Re-render the video using the updated scene manifest */
    rerender: protectedProcedure.input(z.object({
      videoId: z.number().int(),
    })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.videoId), ctx);
      const scenes = await getVideoScenes(input.videoId);
      if (!scenes || scenes.length === 0) {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.NO_SCENE_DATA, "No scene data found. Cannot re-render");
      }

      // Mark video as generating so the dashboard shows progress
      await updateVideoStatus(input.videoId, "generating_visuals");
      await updateVideoProgress(input.videoId, "Re-rendering video with your edits...", 10);

      // Run re-render in background (non-blocking)
      (async () => {
        try {
          const { rerenderFromScenes } = await import("./videoPipeline");
          const newVideoUrl = await rerenderFromScenes(input.videoId, scenes, (step, pct) => {
            updateVideoProgress(input.videoId, step, pct).catch(() => {});
          });
          await updateEditedVideoUrl(input.videoId, newVideoUrl);
          await updateVideoStatus(input.videoId, "completed");
          await updateVideoProgress(input.videoId, "Re-render complete!", 100);
          await notifyOwner({ title: "Video re-render complete", content: `Video #${input.videoId} has been re-rendered with user edits.` });
        } catch (err) {
          console.error("[rerender] failed:", err);
          await updateVideoStatus(input.videoId, "failed");
          await updateVideoProgress(input.videoId, `Re-render failed: ${String(err).slice(0, 100)}`, 0);
        }
      })();

      return { started: true, message: "Re-render started. Check the dashboard for progress." };
    }),

    /** Upload a user's own image or video file to use in the editor */
    uploadMedia: protectedProcedure.input(z.object({
      videoId: z.number().int(),
      base64: z.string(),
      mimeType: z.string(),
      filename: z.string().max(256).optional(),
    })).mutation(async ({ ctx, input }) => {
      const video = requireVideoAccess(await getVideoById(input.videoId), ctx);
      const buffer = Buffer.from(input.base64, "base64");
      const maxBytes = 100 * 1024 * 1024; // 100 MB
      if (buffer.length > maxBytes) {
        throw appTrpcError("BAD_REQUEST", APP_ERROR.FILE_TOO_LARGE, "File too large (max 100MB)");
      }
      const isVideo = input.mimeType.startsWith("video/");
      const ext = input.mimeType.includes("mp4") ? "mp4" : input.mimeType.includes("webm") ? "webm" : input.mimeType.includes("png") ? "png" : input.mimeType.includes("gif") ? "gif" : "jpg";
      const key = `editor-uploads/${ctx.user.id}/${input.videoId}-${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      return { url, type: isVideo ? "video" : "image", source: "upload" };
    }),
  }),
});

export type AppRouter = typeof appRouter;
