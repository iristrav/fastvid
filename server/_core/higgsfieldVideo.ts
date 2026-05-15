/**
 * Higgsfield AI Video Generation Helper
 * Generates videos from text prompts and images using Higgsfield API
 * Supports both text-to-video and image-to-video generation
 */

import fetch from "node-fetch";

const HIGGSFIELD_API_KEY = process.env.HIGGSFIELD_API_KEY;
const HIGGSFIELD_API_SECRET = process.env.HIGGSFIELD_API_SECRET;
const HIGGSFIELD_API_URL = "https://api.higgsfield.ai/v1";

export interface HiggsfieldVideoResponse {
  url: string;
  duration: number;
  taskId: string;
}

/**
 * Generate a video from a text prompt using Higgsfield text-to-video
 * @param prompt - Text description of the video to generate
 * @param duration - Desired video duration in seconds (4-8s typical)
 * @returns URL to the generated video
 */
export async function generateHiggsfieldTextToVideo(
  prompt: string,
  duration: number = 6
): Promise<HiggsfieldVideoResponse | null> {
  if (!HIGGSFIELD_API_KEY || !HIGGSFIELD_API_SECRET) {
    console.warn("[Higgsfield] API credentials not set, skipping text-to-video generation");
    return null;
  }

  try {
    // Create text-to-video generation task
    const createResponse = await fetch(`${HIGGSFIELD_API_URL}/text-to-video`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HIGGSFIELD_API_KEY}`,
        "X-API-Secret": HIGGSFIELD_API_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: prompt.substring(0, 500), // Limit prompt length
        duration: Math.min(Math.max(duration, 4), 8), // Clamp to 4-8 seconds
        resolution: "1280x720", // Match pipeline resolution
        fps: 25,
        quality: "high",
      }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      console.error(`[Higgsfield] Text-to-video creation failed: ${createResponse.status}`, error);
      return null;
    }

    const result = (await createResponse.json()) as any;
    const taskId = result.taskId || result.id;

    if (!taskId) {
      console.error("[Higgsfield] No task ID returned from text-to-video API");
      return null;
    }

    // Poll for completion (max 120 seconds for text-to-video)
    const videoUrl = await pollHiggsfieldTask(taskId, 120_000);
    if (!videoUrl) return null;

    console.log(`[Higgsfield] Text-to-video generated: ${videoUrl}`);
    return { url: videoUrl, duration, taskId };
  } catch (err) {
    console.error("[Higgsfield] Text-to-video error:", err);
    return null;
  }
}

/**
 * Generate a video from an image using Higgsfield image-to-video
 * @param imageUrl - URL or base64 of the image to animate
 * @param prompt - Optional text description for animation guidance
 * @param duration - Desired video duration in seconds (4-8s typical)
 * @returns URL to the generated video
 */
export async function generateHiggsfieldImageToVideo(
  imageUrl: string,
  prompt: string = "",
  duration: number = 6
): Promise<HiggsfieldVideoResponse | null> {
  if (!HIGGSFIELD_API_KEY || !HIGGSFIELD_API_SECRET) {
    console.warn("[Higgsfield] API credentials not set, skipping image-to-video generation");
    return null;
  }

  try {
    // Create image-to-video generation task
    const createResponse = await fetch(`${HIGGSFIELD_API_URL}/image-to-video`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HIGGSFIELD_API_KEY}`,
        "X-API-Secret": HIGGSFIELD_API_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: imageUrl, // Can be URL or base64
        prompt: prompt.substring(0, 300), // Optional animation guidance
        duration: Math.min(Math.max(duration, 4), 8), // Clamp to 4-8 seconds
        resolution: "1280x720", // Match pipeline resolution
        fps: 25,
        quality: "high",
      }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      console.error(`[Higgsfield] Image-to-video creation failed: ${createResponse.status}`, error);
      return null;
    }

    const result = (await createResponse.json()) as any;
    const taskId = result.taskId || result.id;

    if (!taskId) {
      console.error("[Higgsfield] No task ID returned from image-to-video API");
      return null;
    }

    // Poll for completion (max 120 seconds for image-to-video)
    const videoUrl = await pollHiggsfieldTask(taskId, 120_000);
    if (!videoUrl) return null;

    console.log(`[Higgsfield] Image-to-video generated: ${videoUrl}`);
    return { url: videoUrl, duration, taskId };
  } catch (err) {
    console.error("[Higgsfield] Image-to-video error:", err);
    return null;
  }
}

/**
 * Poll a Higgsfield task until completion
 * @param taskId - The task ID to poll
 * @param maxWait - Maximum time to wait in milliseconds
 * @returns Video URL if successful, null otherwise
 */
async function pollHiggsfieldTask(
  taskId: string,
  maxWait: number = 120_000
): Promise<string | null | undefined> {
  const startTime = Date.now();
  const pollInterval = 2000; // Poll every 2 seconds

  while (Date.now() - startTime < maxWait) {
    try {
      const statusResponse = await fetch(`${HIGGSFIELD_API_URL}/tasks/${taskId}`, {
        headers: {
          "Authorization": `Bearer ${HIGGSFIELD_API_KEY || ""}`,
          "X-API-Secret": HIGGSFIELD_API_SECRET || "",
        },
      });

      if (!statusResponse.ok) {
        console.error(`[Higgsfield] Status check failed: ${statusResponse.status}`);
        return null;
      }

      const status = (await statusResponse.json()) as any;

      if (status.status === "completed" || status.status === "success") {
        const videoUrl = status.videoUrl || status.url || status.output;
        if (videoUrl) return videoUrl;
      }

      if (status.status === "failed" || status.status === "error") {
        console.error(`[Higgsfield] Task failed: ${status.error || status.message}`);
        return null;
      }

      // Still processing, wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (err) {
      console.error("[Higgsfield] Poll error:", err);
      return null;
    }
  }

  console.error("[Higgsfield] Task polling timeout");
  return null;
}

/**
 * Check if Higgsfield API is available
 */
export function isHiggsfieldAvailable(): boolean {
  return !!(HIGGSFIELD_API_KEY && HIGGSFIELD_API_SECRET);
}
