import type { PipelineRunTrace, PipelineRunTraceStore } from "./types";

/** No-op store — used when the feature flag is off. */
export class NullPipelineRunStore implements PipelineRunTraceStore {
  async save(_trace: PipelineRunTrace): Promise<void> {
    // intentional no-op
  }
}
