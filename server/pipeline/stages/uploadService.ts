/**
 * Upload Service stage — single responsibility: upload the finished video, return a URL.
 *
 * Thin wrap of storagePut (server/storage.ts) — already a clean, storage-backend-agnostic
 * "key+bytes in, URL out" facade (dispatches to S3/R2, Manus Forge, or local disk depending on
 * configuration; see Phase 1's docs/STORAGE.md), so there's essentially nothing to adapt.
 * Pipeline-specific glue that lives at the legacy call site today (reading the file buffer off
 * disk, timeout wrapping, running concurrently with the post-upload spot-check) stays in the
 * orchestrator — this stage's only job is the upload itself.
 */
import { storagePut } from "../../storage";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type StageResult, type UploadInput, type UploadResult } from "../types";

export async function uploadVideo(input: UploadInput): Promise<StageResult<UploadResult>> {
  return runStage(PIPELINE_ERROR.GENERIC, true, async () => {
    const { key, url } = await storagePut(input.key, input.data, input.contentType);
    return { key, url };
  });
}
