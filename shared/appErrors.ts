import { TRPCError } from "@trpc/server";

/** Stable numeric codes embedded in API error messages for client handling. */
export const APP_ERROR = {
  UNAUTHED: 10001,
  NOT_ADMIN: 10002,
  SUBSCRIPTION_REQUIRED: 10003,
  FORBIDDEN_RESOURCE: 10004,
  NOT_FOUND: 10005,
  INVALID_CREDENTIALS: 10006,
  INVALID_INVITE: 10007,
  EMAIL_EXISTS: 10008,
  INVALID_RESET_LINK: 10009,
  VIDEO_NOT_AWAITING_APPROVAL: 10010,
  NO_SCRIPT: 10011,
  VIDEO_RETRY_INVALID: 10012,
  FILE_TOO_LARGE: 10013,
  VOICE_NOT_FOUND: 10014,
  SCENE_MANIFEST_NOT_FOUND: 10015,
  NO_SCENE_DATA: 10016,
  STRIPE_NOT_CONFIGURED: 10017,
  DATABASE_UNAVAILABLE: 10018,
  ELEVENLABS_NOT_CONFIGURED: 10019,
  PEXELS_NOT_CONFIGURED: 10020,
  PIXABAY_NOT_CONFIGURED: 10021,
  FAILED_CREATE_VIDEO: 10022,
  USER_NOT_FOUND: 10023,
  INVALID_SESSION: 10024,
  OAUTH_SYNC_FAILED: 10025,
  OAUTH_USER_NOT_FOUND: 10026,
  NOTIFICATION_INVALID: 10027,
  SERVICE_ERROR: 10050,
  QUEUE_LIMIT_REACHED: 10028,
  SCRIPT_REVIEW_PENDING: 10029,
} as const;

/** Video pipeline failures (stored in videos.errorMessage). */
export const PIPELINE_ERROR = {
  TIMEOUT: 10101,
  SCRIPT_PARSE: 10102,
  VOICEOVER: 10103,
  VOICEOVER_EMPTY: 10104,
  CUSTOM_VOICEOVER: 10105,
  NO_SCENES: 10106,
  CONCAT: 10107,
  FFMPEG: 10108,
  GENERATION_TIMEOUT: 10109,
  SCRIPT_FAILED: 10110,
  SERVER_RESTART: 10111,
  SCRIPT_REJECTED: 10112,
  STUCK_TIMEOUT: 10113,
  FFMPEG_OVERLOAD: 10114,
  GENERIC: 10199,
} as const;

export type AppErrorCode = (typeof APP_ERROR)[keyof typeof APP_ERROR];

export function appErrorMessage(code: number, text: string): string {
  return `${text} (${code})`;
}

export function appTrpcError(
  trpcCode: TRPCError["code"],
  appCode: number,
  text: string
): TRPCError {
  return new TRPCError({ code: trpcCode, message: appErrorMessage(appCode, text) });
}

export function matchesAppError(message: string, code: number): boolean {
  return message.includes(`(${code})`);
}

/** User-facing text without the numeric suffix. */
export function appErrorText(message: string): string {
  return message.replace(/\s*\(\d{5}\)\s*$/, "").trim();
}

/** Clean tRPC/API error for toast descriptions. */
export function toastErrorMessage(error: unknown, fallback = "Something went wrong"): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : fallback;
  return appErrorText(raw);
}

export function parseAppErrorCode(message: string): number | null {
  const match = message.match(/\((\d{5})\)\s*$/);
  return match ? Number(match[1]) : null;
}

/** Throw a coded Error for the video pipeline (caught and stored in DB). */
export function pipelineError(code: number, text: string): Error {
  return new Error(appErrorMessage(code, text));
}

const CODE_SUFFIX = /\(\d{5}\)\s*$/;

function truncateStoredMessage(msg: string, max = 2000): string {
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

function extractExecDetail(error: Error): string {
  const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr;
  if (stderr) {
    const lines = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const interesting = lines.find((l) =>
      /invalid|error|failed|no such|could not|unable|corrupt/i.test(l)
    );
    if (interesting) return interesting.slice(0, 400);
    const last = lines[lines.length - 1];
    if (last) return last.slice(0, 400);
  }

  let detail = error.message;
  if (/resource temporarily unavailable/i.test(detail)) {
    return "Server overloaded: FFmpeg could not open a video decoder (too many parallel encodes or low RAM on the host). Retry after deploy finishes; we limit parallel FFmpeg on Railway.";
  }
  if (detail.startsWith("Command failed:")) {
    const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
    const ffmpegLine = lines.find(
      (l) =>
        !l.startsWith("Command failed") &&
        !l.includes("ffmpeg version") &&
        !l.startsWith("built with")
    );
    return (ffmpegLine ?? "Video processing failed").slice(0, 400);
  }
  return detail.slice(0, 400);
}

/**
 * Normalize any thrown value into a user-storable message with a numeric code.
 * Use when writing videos.errorMessage.
 */
export function normalizeStoredError(
  error: unknown,
  defaultCode: number = PIPELINE_ERROR.GENERIC
): string {
  if (error instanceof Error) {
    if (CODE_SUFFIX.test(error.message)) {
      return truncateStoredMessage(error.message);
    }
    const detail = extractExecDetail(error);
    const code = /resource temporarily unavailable/i.test(detail)
      ? PIPELINE_ERROR.FFMPEG_OVERLOAD
      : defaultCode;
    return appErrorMessage(code, detail);
  }
  if (typeof error === "string") {
    if (CODE_SUFFIX.test(error)) return truncateStoredMessage(error);
    return appErrorMessage(defaultCode, error.slice(0, 400));
  }
  return appErrorMessage(defaultCode, "Unknown error");
}

export const UNAUTHED_ERR_MSG = appErrorMessage(APP_ERROR.UNAUTHED, "Please login");
export const NOT_ADMIN_ERR_MSG = appErrorMessage(
  APP_ERROR.NOT_ADMIN,
  "You do not have required permission"
);
export const SUBSCRIPTION_REQUIRED_ERR_MSG = appErrorMessage(
  APP_ERROR.SUBSCRIPTION_REQUIRED,
  "Active subscription required"
);
export const FORBIDDEN_RESOURCE_ERR_MSG = appErrorMessage(
  APP_ERROR.FORBIDDEN_RESOURCE,
  "You do not have access to this resource"
);
export const NOT_FOUND_ERR_MSG = appErrorMessage(APP_ERROR.NOT_FOUND, "Resource not found");
export const INVALID_CREDENTIALS_ERR_MSG = appErrorMessage(
  APP_ERROR.INVALID_CREDENTIALS,
  "Invalid email or password"
);
export const INVALID_INVITE_ERR_MSG = appErrorMessage(
  APP_ERROR.INVALID_INVITE,
  "Invalid or already used invite code"
);
export const EMAIL_EXISTS_ERR_MSG = appErrorMessage(
  APP_ERROR.EMAIL_EXISTS,
  "An account with this email already exists"
);
export const INVALID_RESET_LINK_ERR_MSG = appErrorMessage(
  APP_ERROR.INVALID_RESET_LINK,
  "Invalid or expired reset link"
);
