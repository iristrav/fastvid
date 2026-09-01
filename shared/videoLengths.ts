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

/**
 * RONDE 147 — the one-minute option is the owner's, and the server is what says so.
 *
 * A minute-long render is a test harness: it exercises the whole pipeline for a fraction of the
 * compute, which is exactly why it must not be generally available. Every worker minute it takes
 * is a minute a paying customer's documentary is not being made.
 *
 * Hiding the button was never going to be enough. `videoLengthSchema` accepts "1" because the
 * value is legitimate — for one role — so the request reaches `create` fully valid and the check
 * has to happen where the role is known. Frontend conditioning stays (there is no reason to show
 * an option that will be refused), but it is a courtesy, not the control.
 *
 * Expressed as a length→roles table rather than a role→lengths one so adding a future restricted
 * length is a single entry here and nothing at the call sites.
 */
export const VIDEO_LENGTH_REQUIRED_ROLES: Readonly<Partial<Record<VideoLength, ReadonlyArray<string>>>> = {
  "1": ["admin"],
};

/**
 * May an account with this role generate at this length?
 *
 * Unknown or missing roles are treated as ordinary users: a caller that cannot prove a role does
 * not get the restricted option. The length is normalised first, so a legacy alias ("2" → "1")
 * cannot be used to slip past the table.
 */
export function videoLengthAllowedForRole(
  raw: string | null | undefined,
  role: string | null | undefined
): boolean {
  const required = VIDEO_LENGTH_REQUIRED_ROLES[normalizeVideoLength(raw)];
  if (!required) return true;
  return role != null && required.includes(role);
}

/** The lengths this role may pick — what the frontend should offer. */
export function allowedVideoLengthsForRole(
  role: string | null | undefined
): ReadonlyArray<VideoLength> {
  return VIDEO_LENGTH_VALUES.filter((v) => videoLengthAllowedForRole(v, role));
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
