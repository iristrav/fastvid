/**
 * Kling AI video generation — direct Kling API (JWT) or FAL.ai (cheaper, single key).
 */
import { createHmac } from "crypto";
import fetch from "node-fetch";
import fs from "fs";

const KLING_API_KEY = process.env.KLING_API_KEY?.trim() || "";
const KLING_API_SECRET = process.env.KLING_API_SECRET?.trim() || "";
const FAL_KEY = process.env.FAL_KEY?.trim() || process.env.FAL_API_KEY?.trim() || "";

const FAL_T2V_MODEL =
  process.env.KLING_FAL_MODEL?.trim() || "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
const FAL_I2V_MODEL =
  process.env.KLING_FAL_I2V_MODEL?.trim() || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";

export type KlingVideoResult = {
  filePath: string;
  durationSec: number;
  provider: "kling" | "fal";
};

export function isKlingDirectAvailable(): boolean {
  return Boolean(KLING_API_KEY && KLING_API_SECRET);
}

export function isKlingFalAvailable(): boolean {
  return Boolean(FAL_KEY);
}

export function isKlingAvailable(): boolean {
  return isKlingDirectAvailable() || isKlingFalAvailable();
}

/** On when API keys set; set ENABLE_KLING_BEAT_FALLBACK=false to disable. */
export function klingBeatFallbackEnabled(): boolean {
  if (process.env.ENABLE_KLING_BEAT_FALLBACK === "false") return false;
  return isKlingAvailable();
}

export function maxKlingClipsPerVideo(): number {
  const n = parseInt(process.env.KLING_MAX_CLIPS_PER_VIDEO || "6", 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(20, n) : 6;
}

function klingDurationSec(requested: number): 5 | 10 {
  return requested > 6 ? 10 : 5;
}

function klingDurationLabel(requested: number): "5" | "10" {
  return klingDurationSec(requested) === 10 ? "10" : "5";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function buildKlingJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: KLING_API_KEY,
      exp: Math.floor(Date.now() / 1000) + 1800,
      nbf: Math.floor(Date.now() / 1000) - 5,
    })
  ).toString("base64url");
  const sig = createHmac("sha256", KLING_API_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function downloadVideoToFile(url: string, outputPath: string, label: string): Promise<boolean> {
  const resp = await fetch(url);
  if (!resp.ok) {
    console.warn(`[Kling] ${label} download failed: ${resp.status}`);
    return false;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 5_000) return false;
  fs.writeFileSync(outputPath, buf);
  return true;
}

type FalQueueStatus = {
  status?: string;
  response_url?: string;
};

type FalVideoPayload = {
  video?: { url?: string };
};

async function pollFalRequest(modelId: string, requestId: string, maxWaitMs: number): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const statusResp = await fetch(`https://queue.fal.run/${modelId}/requests/${requestId}/status`, {
      headers: { Authorization: `Key ${FAL_KEY}` },
    });
    if (!statusResp.ok) {
      await sleep(3_000);
      continue;
    }
    const status = (await statusResp.json()) as FalQueueStatus;
    if (status.status === "COMPLETED") {
      const resultResp = await fetch(`https://queue.fal.run/${modelId}/requests/${requestId}`, {
        headers: { Authorization: `Key ${FAL_KEY}` },
      });
      if (!resultResp.ok) return null;
      const payload = (await resultResp.json()) as FalVideoPayload;
      return payload.video?.url ?? null;
    }
    if (status.status === "FAILED" || status.status === "CANCELLED") return null;
    await sleep(4_000);
  }
  return null;
}

async function generateKlingViaFal(
  prompt: string,
  durationSec: number,
  outputPath: string,
  imageUrl?: string | null
): Promise<KlingVideoResult | null> {
  if (!FAL_KEY) return null;
  const modelId = imageUrl ? FAL_I2V_MODEL : FAL_T2V_MODEL;
  const body: Record<string, unknown> = {
    prompt: prompt.slice(0, 2400),
    duration: klingDurationLabel(durationSec),
    aspect_ratio: "16:9",
    negative_prompt: "blur, distort, low quality, watermark, text overlay, logo",
    cfg_scale: 0.5,
  };
  if (imageUrl) body.image_url = imageUrl;

  const createResp = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!createResp.ok) {
    console.warn(`[Kling/FAL] create failed ${createResp.status}: ${(await createResp.text()).slice(0, 160)}`);
    return null;
  }
  const created = (await createResp.json()) as { request_id?: string };
  if (!created.request_id) return null;

  const videoUrl = await pollFalRequest(modelId, created.request_id, 180_000);
  if (!videoUrl) return null;
  const ok = await downloadVideoToFile(videoUrl, outputPath, "FAL");
  if (!ok) return null;
  return { filePath: outputPath, durationSec: klingDurationSec(durationSec), provider: "fal" };
}

async function generateKlingViaDirectApi(
  prompt: string,
  durationSec: number,
  outputPath: string,
  imageUrl?: string | null
): Promise<KlingVideoResult | null> {
  if (!isKlingDirectAvailable()) return null;
  const jwt = buildKlingJwt();
  const modelName = process.env.KLING_MODEL?.trim() || "kling-v2-master";
  const body: Record<string, unknown> = {
    model_name: modelName,
    prompt: prompt.slice(0, 2000),
    duration: klingDurationLabel(durationSec),
    mode: process.env.KLING_MODE?.trim() || "std",
    cfg_scale: 0.5,
  };
  if (imageUrl) body.image_url = imageUrl;

  const endpoint = imageUrl
    ? "https://api.klingai.com/v1/videos/image2video"
    : "https://api.klingai.com/v1/videos/text2video";

  const createResp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!createResp.ok) {
    console.warn(`[Kling] API ${createResp.status}: ${(await createResp.text()).slice(0, 160)}`);
    return null;
  }
  const createData = (await createResp.json()) as { data?: { task_id?: string } };
  const taskId = createData.data?.task_id;
  if (!taskId) return null;

  const pollEndpoint = imageUrl
    ? `https://api.klingai.com/v1/videos/image2video/${taskId}`
    : `https://api.klingai.com/v1/videos/text2video/${taskId}`;

  let videoUrl: string | null = null;
  for (let poll = 0; poll < 40; poll++) {
    await sleep(5_000);
    const pollResp = await fetch(pollEndpoint, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!pollResp.ok) continue;
    const pollData = (await pollResp.json()) as {
      data?: { task_status?: string; task_result?: { videos?: Array<{ url?: string }> } };
    };
    const status = pollData.data?.task_status;
    if (status === "succeed" && pollData.data?.task_result?.videos?.[0]?.url) {
      videoUrl = pollData.data.task_result.videos[0].url!;
      break;
    }
    if (status === "failed") break;
  }
  if (!videoUrl) return null;
  const ok = await downloadVideoToFile(videoUrl, outputPath, "direct");
  if (!ok) return null;
  return { filePath: outputPath, durationSec: klingDurationSec(durationSec), provider: "kling" };
}

/**
 * Generate a documentary B-roll clip with Kling (FAL preferred when both keys set — simpler billing).
 */
export async function generateKlingBeatVideo(
  prompt: string,
  outputPath: string,
  durationSec = 5,
  imageUrl?: string | null
): Promise<KlingVideoResult | null> {
  if (!isKlingAvailable()) return null;
  const preferFal = process.env.KLING_PROVIDER?.trim().toLowerCase() === "fal" || (!isKlingDirectAvailable() && isKlingFalAvailable());
  const preferDirect = process.env.KLING_PROVIDER?.trim().toLowerCase() === "direct";

  if (preferDirect && isKlingDirectAvailable()) {
    const direct = await generateKlingViaDirectApi(prompt, durationSec, outputPath, imageUrl);
    if (direct) return direct;
  }
  if (isKlingFalAvailable()) {
    const fal = await generateKlingViaFal(prompt, durationSec, outputPath, imageUrl);
    if (fal) return fal;
  }
  if (!preferDirect && isKlingDirectAvailable()) {
    return generateKlingViaDirectApi(prompt, durationSec, outputPath, imageUrl);
  }
  return null;
}
