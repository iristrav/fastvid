import type { BeatSelectionTraceStore } from "./types";
import type { SelectorTrace } from "../types";

/** No-op store — used when the feature flag is off. save() resolves immediately. */
export class NullTraceStore implements BeatSelectionTraceStore {
  async save(_trace: SelectorTrace): Promise<void> {
    // intentional no-op
  }
}
