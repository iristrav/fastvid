/** Shared niche request labels and format options (client + server). */

export const NICHE_VIDEO_FORMATS = [
  { value: "5-8", label: "5–8 min — kort & punchy" },
  { value: "8-12", label: "8–12 min — tutorial" },
  { value: "12-15", label: "12–15 min — diepgaand" },
  { value: "15-20", label: "15–20 min — extended" },
  { value: "20+", label: "20+ min — long-form" },
] as const;

export type NicheVideoFormat = (typeof NICHE_VIDEO_FORMATS)[number]["value"];

export const NICHE_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "In behandeling",
  approved: "Goedgekeurd",
  in_progress: "Archief in opbouw",
  ready: "Klaar om te starten",
  rejected: "Afgewezen",
};

export const ONBOARDING_PENDING_MESSAGE =
  "Je aanvraag is ontvangen. Binnen 2 werkdagen ontvang je een goedkeuringsbericht. Na goedkeuring kun je binnen 24 uur starten met je eerste video.";

export const ONBOARDING_APPROVED_MESSAGE =
  "Goedgekeurd! Je kunt binnen 24 uur starten — kies je abonnement en maak je eerste video.";

export const ARCHIVE_BUILDING_MESSAGE =
  "Er zijn nog weinig of geen beelden in het archief voor dit onderwerp. Het duurt iets langer — we zijn bezig met het archief voor jouw niche.";
