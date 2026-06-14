/** Shared niche request labels (client + server). */

export const NICHE_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "Under review",
  approved: "Approved",
  in_progress: "Archive building",
  ready: "Ready to start",
  rejected: "Rejected",
};

export const ONBOARDING_PENDING_MESSAGE =
  "We received your application. You will get an approval email within 2 business days. Once approved, you can start your first video within 24 hours.";

export const ONBOARDING_APPROVED_MESSAGE =
  "Approved! You can start within 24 hours — choose your subscription and create your first video.";

export const ARCHIVE_BUILDING_MESSAGE =
  "There is still little or no footage in the archive for this topic. Generation may take longer while we expand the archive for your niche.";
