/**
 * Shared fetch-with-real-cancellation helper for external HTTP calls that don't already have
 * one. Unlike a bare `Promise.race([fetch(...), timeout])` ("zombie" timeout — the underlying
 * request keeps running in the background after the race resolves, holding a socket and
 * process-exit handle), this uses AbortController so the request is actually torn down when
 * the timeout fires.
 */
import fetch, { type RequestInit, type Response } from "node-fetch";

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options: RequestInit = {}
): Promise<Response> {
  const delayMs = Math.max(1, Math.round(timeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), delayMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal as never });
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Timeout: request to ${url} exceeded ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
