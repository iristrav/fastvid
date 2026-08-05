/**
 * Script Generator stage — single responsibility: generate the script.
 *
 * Adapter around the existing runScriptEngineV2 (server/scriptEngine.ts) — the LLM calls,
 * story-architecture/scene-plan/narration generation, and quality scoring are unchanged, just
 * exposed through this stage's contract. Unlike generateScriptOnly (server/routers.ts, the
 * legacy call site), which discards EngineOutput.scenes and keeps only markdown+title, this
 * stage returns the full structured EngineOutput — the richer per-scene data
 * (goal/reveal/emotion/visualIntent/searchKeywords) the engine already computes but the legacy
 * path throws away. Has no DB/progress side effects of its own (those stay in the orchestrator
 * / legacy call site, matching "single responsibility").
 */
import { runScriptEngineV2 } from "../../scriptEngine";
import { getScriptLengthBudget } from "../../scriptWriter";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type ScriptGeneratorInput, type ScriptGeneratorOutput, type StageResult } from "../types";

export async function generateScript(
  input: ScriptGeneratorInput
): Promise<StageResult<ScriptGeneratorOutput>> {
  return runStage(PIPELINE_ERROR.SCRIPT_FAILED, true, async () => {
    const budget = getScriptLengthBudget(input.videoLength);
    return runScriptEngineV2(input.topic, input.videoType, budget, input.onProgress);
  });
}
