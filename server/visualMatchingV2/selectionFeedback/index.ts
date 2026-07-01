import { visualMatchingV2SelectionFeedbackEnabled } from "../../sourcingPolicy";
import { DatabaseSelectionFeedbackStore } from "./feedbackStore";
import type { SelectionFeedbackStore } from "./types";

export function createSelectionFeedbackStore(): SelectionFeedbackStore {
  if (!visualMatchingV2SelectionFeedbackEnabled()) {
    throw new Error(
      "SelectionFeedback is disabled (VISUAL_MATCHING_V2_SELECTION_FEEDBACK is not set). " +
      "Check the flag before calling createSelectionFeedbackStore()."
    );
  }
  return new DatabaseSelectionFeedbackStore();
}

export type {
  FeedbackType,
  SelectionFeedback,
  InsertSelectionFeedback,
  SelectionFeedbackEvent,
  FeedbackEventType,
  SelectionFeedbackStore,
} from "./types";
export { DatabaseSelectionFeedbackStore, MemorySelectionFeedbackStore } from "./feedbackStore";
