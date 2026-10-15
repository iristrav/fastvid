/**
 * VIDEO 659 (cost) — WHAT ONE VIDEO COST, ON ONE LINE.
 *
 * The owner asked how to spend less, and the honest answer was that nobody could say where the
 * money goes: the LLM spend was counted per DAY (`llmBudget.ts`), the paid services not at all.
 * Every paid call now adds to the ledger of the render it ran in (the active render's video id,
 * `getActiveVideoId`), and the pipeline prints one `[RenderCost]` line when the video is done.
 *
 * Counts only — no decision anywhere reads this. A call outside a render (background work, the
 * editor) has no video id and is not counted here; the daily LLM budget still counts it.
 */
import { getActiveVideoId } from "./videoGenerationCancel";

export type RenderCost = {
  llmCalls: number;
  visionCalls: number;
  promptTokens: number;
  completionTokens: number;
  llmUsd: number;
  youtubeDownloads: number;
  youtubeBytes: number;
  tunelioPaidCalls: number;
  serpapiSearches: number;
  aiVideos: number;
  aiVideoSec: number;
  aiStills: number;
  voiceChars: number;
};

const empty = (): RenderCost => ({
  llmCalls: 0, visionCalls: 0, promptTokens: 0, completionTokens: 0, llmUsd: 0,
  youtubeDownloads: 0, youtubeBytes: 0, tunelioPaidCalls: 0, serpapiSearches: 0,
  aiVideos: 0, aiVideoSec: 0, aiStills: 0, voiceChars: 0,
});

const ledgers = new Map<number, RenderCost>();

/** Adds to the active render's ledger (or to `videoId`'s). Never throws; outside a render it does nothing. */
export function noteRenderCost(add: Partial<RenderCost>, videoId: number | null | undefined = getActiveVideoId()): void {
  if (videoId == null) return;
  const l = ledgers.get(videoId) ?? empty();
  for (const [k, v] of Object.entries(add) as Array<[keyof RenderCost, number]>) {
    if (typeof v === "number" && Number.isFinite(v)) l[k] += v;
  }
  ledgers.set(videoId, l);
}

export function renderCost(videoId: number): RenderCost {
  return { ...(ledgers.get(videoId) ?? empty()) };
}

export function formatRenderCost(videoId: number, c: RenderCost = renderCost(videoId)): string {
  return (
    `[RenderCost] video=${videoId} llm=${c.llmCalls} (vision=${c.visionCalls}) ` +
    `tokens=${c.promptTokens}+${c.completionTokens} llmUsd=${c.llmUsd.toFixed(3)} ` +
    `youtubeDownloads=${c.youtubeDownloads} youtubeMB=${(c.youtubeBytes / 1_048_576).toFixed(1)} ` +
    `tunelioPaid=${c.tunelioPaidCalls} serpapi=${c.serpapiSearches} ` +
    `aiVideos=${c.aiVideos} (${c.aiVideoSec.toFixed(0)}s) aiStills=${c.aiStills} voiceChars=${c.voiceChars}`
  );
}

/** The line, and the ledger forgotten — called once when the video is done. */
export function takeRenderCostLine(videoId: number): string {
  const line = formatRenderCost(videoId);
  ledgers.delete(videoId);
  return line;
}
