/**
 * AWS Rekognition Celebrity Recognition for archive clips.
 * Extracts frames from a video (or uses the image directly),
 * sends them to Rekognition RecognizeCelebrities, and returns
 * identified person names with confidence scores.
 */

import { RekognitionClient, RecognizeCelebritiesCommand } from "@aws-sdk/client-rekognition";
import fs from "fs";
import os from "os";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);

export type RekognitionPerson = {
  name: string;
  confidence: number; // 0–100
  urls: string[];     // Wikipedia / IMDB links provided by AWS
};

export type RekognitionResult = {
  persons: RekognitionPerson[];
  framesAnalyzed: number;
};

function getClient(): RekognitionClient {
  const accessKeyId = process.env.AWS_REKOGNITION_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_REKOGNITION_SECRET_ACCESS_KEY?.trim();
  const region = process.env.AWS_REKOGNITION_REGION?.trim() || "us-east-1";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS_REKOGNITION_ACCESS_KEY_ID and AWS_REKOGNITION_SECRET_ACCESS_KEY must be set");
  }

  return new RekognitionClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function isRekognitionEnabled(): boolean {
  return !!(
    process.env.AWS_REKOGNITION_ACCESS_KEY_ID?.trim() &&
    process.env.AWS_REKOGNITION_SECRET_ACCESS_KEY?.trim()
  );
}

/** Recognize celebrities in a single JPEG/PNG buffer. */
async function recognizeInBuffer(
  client: RekognitionClient,
  imageBuffer: Buffer,
): Promise<RekognitionPerson[]> {
  const cmd = new RecognizeCelebritiesCommand({
    Image: { Bytes: imageBuffer },
  });

  const response = await client.send(cmd);
  const persons: RekognitionPerson[] = [];

  for (const celeb of response.CelebrityFaces ?? []) {
    if (!celeb.Name) continue;
    const confidence = celeb.MatchConfidence ?? 0;
    if (confidence < 70) continue; // Skip low-confidence matches

    persons.push({
      name: celeb.Name,
      confidence: Math.round(confidence * 10) / 10,
      urls: celeb.Urls ?? [],
    });
  }

  return persons;
}

/** Extract a JPEG frame from a video at `seekSec` seconds. Returns buffer or null. */
async function extractFrame(videoPath: string, seekSec: number, workDir: string): Promise<Buffer | null> {
  const outPath = path.join(workDir, `rek_frame_${Math.floor(seekSec * 1000)}.jpg`);
  const ffmpeg = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg";
  try {
    await exec(
      `${ffmpeg} -y -ss ${seekSec.toFixed(2)} -i "${videoPath}" -vframes 1 -q:v 2 "${outPath}"`,
      { timeout: 15_000 },
    );
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) return null;
    return fs.readFileSync(outPath);
  } catch {
    return null;
  }
}

/**
 * Run Rekognition Celebrity Recognition on a local file (video or image).
 * For videos, samples up to 5 frames spread through the clip.
 * Returns deduplicated persons ranked by highest confidence across frames.
 */
export async function recognizeCelebritiesInFile(
  filePath: string,
  mediaType: "video" | "image",
  durationSec?: number | null,
): Promise<RekognitionResult> {
  const client = getClient();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rek-"));
  const bestByName = new Map<string, RekognitionPerson>();

  try {
    if (mediaType === "image") {
      const buf = fs.readFileSync(filePath);
      const persons = await recognizeInBuffer(client, buf);
      for (const p of persons) {
        if (!bestByName.has(p.name) || bestByName.get(p.name)!.confidence < p.confidence) {
          bestByName.set(p.name, p);
        }
      }
      return { persons: [...bestByName.values()], framesAnalyzed: 1 };
    }

    // Video: sample frames at 20%, 40%, 60%, 80% of duration (max 5 frames)
    const dur = durationSec && durationSec > 0 ? durationSec : 10;
    const seekPoints = dur > 4
      ? [0.15, 0.35, 0.55, 0.75, 0.9].map((r) => dur * r)
      : [dur * 0.3, dur * 0.7];

    let framesAnalyzed = 0;
    for (const seek of seekPoints) {
      const buf = await extractFrame(filePath, seek, workDir);
      if (!buf) continue;
      framesAnalyzed++;

      const persons = await recognizeInBuffer(client, buf);
      for (const p of persons) {
        if (!bestByName.has(p.name) || bestByName.get(p.name)!.confidence < p.confidence) {
          bestByName.set(p.name, p);
        }
      }
    }

    return {
      persons: [...bestByName.values()].sort((a, b) => b.confidence - a.confidence),
      framesAnalyzed,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
