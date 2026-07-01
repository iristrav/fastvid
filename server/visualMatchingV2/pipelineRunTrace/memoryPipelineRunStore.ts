import type { PipelineRunTrace, PipelineRunTraceStore } from "./types";

/** In-memory store for tests. */
export class MemoryPipelineRunStore implements PipelineRunTraceStore {
  private readonly traces: PipelineRunTrace[] = [];

  async save(trace: PipelineRunTrace): Promise<void> {
    this.traces.push({ ...trace });
  }

  getAll(): readonly PipelineRunTrace[] {
    return [...this.traces];
  }

  clear(): void {
    this.traces.length = 0;
  }
}
