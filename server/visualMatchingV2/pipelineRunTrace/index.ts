import { visualMatchingV2PipelineRunTraceEnabled } from "../../sourcingPolicy";
import type { PipelineRunTraceStore } from "./types";
import { DatabasePipelineRunStore } from "./databasePipelineRunStore";
import { NullPipelineRunStore } from "./nullPipelineRunStore";

export function createPipelineRunTraceStore(): PipelineRunTraceStore {
  if (!visualMatchingV2PipelineRunTraceEnabled()) {
    return new NullPipelineRunStore();
  }
  return new DatabasePipelineRunStore();
}

export type { PipelineRunTrace, PipelineRunTraceStore, StageTimings } from "./types";
export { MemoryPipelineRunStore } from "./memoryPipelineRunStore";
export { NullPipelineRunStore } from "./nullPipelineRunStore";
export { DatabasePipelineRunStore } from "./databasePipelineRunStore";
