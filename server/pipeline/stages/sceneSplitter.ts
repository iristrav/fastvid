/**
 * Scene Splitter stage — single responsibility: split the completed script into scenes.
 *
 * Adapter around the existing parseScriptIntoScenes (server/videoPipeline.ts) — a genuinely
 * distinct, mostly-deterministic stage in the current pipeline already, sandwiched between
 * script generation and voice generation. It first tries a regex-based parse of the `##`
 * markdown headings the Script Generator's output already contains (no LLM call), and only
 * falls back to an LLM re-parse if that yields fewer than 2 scenes — this stage doesn't change
 * that behavior, it just formalizes the boundary. Uses semantic (markdown-heading /
 * LLM-assisted) boundaries, not a fixed sentence count, per the spec's explicit requirement.
 */
import { parseScriptIntoScenes } from "../../videoPipeline";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type SceneSplitterInput, type SceneSplitterOutput, type StageResult } from "../types";

export async function splitScenes(
  input: SceneSplitterInput
): Promise<StageResult<SceneSplitterOutput>> {
  return runStage(PIPELINE_ERROR.SCRIPT_PARSE, true, async () => {
    const scenes = await parseScriptIntoScenes(input.script, input.maxScenes, input.topicContext);
    return { scenes };
  });
}
