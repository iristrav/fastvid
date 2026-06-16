import { z } from "zod";

/** Allowed video length values for new generations. */
export const VIDEO_LENGTH_VALUES = ["1", "8-10", "10-15", "15-20"] as const;
export type VideoLength = (typeof VIDEO_LENGTH_VALUES)[number];

export const videoLengthSchema = z.enum(VIDEO_LENGTH_VALUES);

export const VIDEO_LENGTH_OPTIONS: ReadonlyArray<{
  label: string;
  value: VideoLength;
  desc: string;
}> = [
  { label: "1 min", value: "1", desc: "Quick test" },
  { label: "8–10 min", value: "8-10", desc: "Standard documentary" },
  { label: "10–15 min", value: "10-15", desc: "Deep-dive" },
  { label: "15–20 min", value: "15-20", desc: "Extended narrative" },
];

/** Map legacy stored values to current pipeline buckets. */
const LEGACY_VIDEO_LENGTH_MAP: Record<string, VideoLength> = {
  "2": "1",
  "5-8": "8-10",
  "8-12": "8-10",
  "12-15": "10-15",
  "20+": "15-20",
};

export function normalizeVideoLength(raw: string | null | undefined): VideoLength {
  if (raw && VIDEO_LENGTH_VALUES.includes(raw as VideoLength)) {
    return raw as VideoLength;
  }
  if (raw && LEGACY_VIDEO_LENGTH_MAP[raw]) {
    return LEGACY_VIDEO_LENGTH_MAP[raw]!;
  }
  return "8-10";
}

export function isShortVideoLength(raw: string | null | undefined): boolean {
  return normalizeVideoLength(raw) === "1";
}

/** Target on-screen duration (minutes) for pipeline budget scaling. Uses upper bound of each bucket. */
export function targetVideoDurationMinutes(raw: string | null | undefined): number {
  switch (normalizeVideoLength(raw)) {
    case "1":
      return 1;
    case "8-10":
      return 10;
    case "10-15":
      return 15;
    case "15-20":
      return 20;
    default:
      return 10;
  }
}

/** Wall-clock generation budget (minutes) = video minutes × ratio (default 10:1). */
export function generationBudgetMinutes(
  raw: string | null | undefined,
  minutesPerVideoMinute = 10
): number {
  return Math.round(targetVideoDurationMinutes(raw) * minutesPerVideoMinute);
}

const DISPLAY_LABELS: Record<string, string> = {
  "1": "1 min",
  "8-10": "8–10 min",
  "10-15": "10–15 min",
  "15-20": "15–20 min",
  "2": "2 min",
  "5-8": "5–8 min",
  "8-12": "8–12 min",
  "12-15": "12–15 min",
  "20+": "20+ min",
};

export function getVideoLengthLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  return DISPLAY_LABELS[raw] ?? DISPLAY_LABELS[normalizeVideoLength(raw)] ?? raw;
}
