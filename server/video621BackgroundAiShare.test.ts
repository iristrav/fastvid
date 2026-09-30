/**
 * VIDEO 621 — background work stops at half the day's AI budget; the rest is kept for renders.
 *
 * On 30 September the archive's shot sweep spent the whole $15 by 09:50 and the next render was
 * refused before it started. No network: spend is recorded locally, no model is ever called.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  BACKGROUND_SHARE,
  isBackgroundLlmShareSpent,
  isBackgroundLlmWork,
  isLlmBudgetExceeded,
  llmDailyBudgetUsd,
  recordLlmUsage,
  runAsBackgroundLlmWork,
} from "./_core/llmBudget";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("Video 621 — the background share of the AI budget", () => {
  it("background work is marked as such, including the timers and promises it starts", async () => {
    expect(isBackgroundLlmWork()).toBe(false);
    const seen = await runAsBackgroundLlmWork(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(isBackgroundLlmWork()), 5))
    );
    expect(seen).toBe(true);
    expect(isBackgroundLlmWork()).toBe(false);
  });

  it("at half the budget background work stops; a render may still spend up to the whole budget", async () => {
    expect(BACKGROUND_SHARE).toBe(0.5);
    /** gpt-4o: $10 per 1M output tokens — spend just over half the budget. */
    const halfPlus = (llmDailyBudgetUsd() * BACKGROUND_SHARE + 0.01) / 10;
    recordLlmUsage("gpt-4o", 0, Math.ceil(halfPlus * 1_000_000));
    expect(await isBackgroundLlmShareSpent()).toBe(true);
    expect(await isLlmBudgetExceeded()).toBe(false);
  });

  it("the model call refuses background work past its share, before anything is sent", () => {
    const llm = read("_core/llm.ts");
    const at = llm.indexOf("export async function invokeLLM(");
    const body = llm.slice(at, at + 1500);
    expect(body).toContain("if (isBackgroundLlmWork() && (await isBackgroundLlmShareSpent())) {");
    expect(body.indexOf("isBackgroundLlmShareSpent")).toBeLessThan(body.indexOf("if (await isLlmBudgetExceeded())"));
  });

  it("every background starter in the worker runs as background work", () => {
    const worker = read("worker.ts");
    expect(worker).toContain("runAsBackgroundLlmWork(() => scheduleClipEmbeddingBackfill());");
    expect(worker).toContain("runAsBackgroundLlmWork(() => startClipBackgroundAuditor());");
    expect(worker).toContain("await runAsBackgroundLlmWork(() => startYoutubePrefetchWorker())");
    expect(worker).toContain("runAsBackgroundLlmWork(() =>\n      startArchiveShotSplitSweep(");
  });

  it("a queued shot split and a download's archiving are background work too, whoever started them", () => {
    expect(read("archiveShotPieces.ts")).toContain("return runAsBackgroundLlmWork(async () => splitArchiveAssetIntoShots(");
    expect(read("videoPipeline.ts")).toContain("void runAsBackgroundLlmWork(async () => {\n    try {\n      const [{ archiveMetadataForPrefetchedSegment }");
  });

  it("the sweep does not start while its shots could not be judged", () => {
    const src = read("archiveShotPieces.ts");
    const at = src.indexOf("export async function sweepArchiveShotSplits(");
    expect(src.slice(at, at + 600)).toContain("(await budget.isBackgroundLlmShareSpent()) || (await budget.isLlmBudgetExceeded())");
  });
});
