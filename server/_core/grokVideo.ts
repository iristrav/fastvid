/**
 * Grok Imagine Video Generation Helper
 * Generates videos from text prompts using xAI's Grok Imagine API via Replicate
 */

import fetch from "node-fetch";

const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
const REPLICATE_MODEL = "xai/grok-imagine-video";

export interface GrokVideoResponse {
  url: string;
  duration: number;
}

/**
 * Generate a video from a text prompt using Grok Imagine API
 * @param prompt - Text description of the video to generate
 * @param duration - Desired video duration in seconds (4-8s typical)
 * @returns URL to the generated video
 */
export async function generateGrokVideo(
  prompt: string,
  duration: number = 6
): Promise<GrokVideoResponse | null> {
  if (!REPLICATE_API_KEY) {
    console.warn("[Grok] REPLICATE_API_KEY not set, skipping Grok video generation");
    return null;
  }

  try {
    // Create prediction on Replicate
    const createResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "xai/grok-imagine-video",
        input: {
          prompt: prompt.substring(0, 500), // Limit prompt length
          duration: Math.min(duration, 8), // Max 8 seconds
        },
      }),
    });

    if (!createResponse.ok) {
      console.error(`[Grok] Creation failed: ${createResponse.status}`);
      return null;
    }

    const prediction = (await createResponse.json()) as any;
    const predictionId = prediction.id;

    // Poll for completion (max 60 seconds)
    const startTime = Date.now();
    const maxWait = 60_000;

    while (Date.now() - startTime < maxWait) {
      const statusResponse = await fetch(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: { "Authorization": `Token ${REPLICATE_API_KEY}` },
        }
      );

      if (!statusResponse.ok) {
        console.error(`[Grok] Status check failed: ${statusResponse.status}`);
        return null;
      }

      const status = (await statusResponse.json()) as any;

      if (status.status === "succeeded" && status.output) {
        const videoUrl = Array.isArray(status.output) ? status.output[0] : status.output;
        console.log(`[Grok] Video generated: ${videoUrl}`);
        return { url: videoUrl, duration };
      }

      if (status.status === "failed") {
        console.error(`[Grok] Generation failed: ${status.error}`);
        return null;
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.error("[Grok] Generation timeout");
    return null;
  } catch (err) {
    console.error("[Grok] Error:", err);
    return null;
  }
}
