export const COOKIE_NAME = "app_session_id";
export const FASTVID_CONTACT_EMAIL = "contact@fastvid.tech";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;

/** Media archive — max source video length and file size (server env can override). */
export const ARCHIVE_MAX_VIDEO_DURATION_SEC = 2 * 60 * 60;
export const ARCHIVE_MAX_UPLOAD_MB = 2048;
export const ARCHIVE_MAX_UPLOAD_BYTES = ARCHIVE_MAX_UPLOAD_MB * 1024 * 1024;
/** Minimum stored on-screen duration for archive clips (still = Ken Burns hold; video = shot length). */
export const ARCHIVE_MIN_SAVED_CLIP_SEC = 3;

export {
  APP_ERROR,
  PIPELINE_ERROR,
  appErrorMessage,
  appErrorText,
  appTrpcError,
  matchesAppError,
  normalizeStoredError,
  parseAppErrorCode,
  pipelineError,
  toastErrorMessage,
  UNAUTHED_ERR_MSG,
  NOT_ADMIN_ERR_MSG,
  SUBSCRIPTION_REQUIRED_ERR_MSG,
  FORBIDDEN_RESOURCE_ERR_MSG,
  NOT_FOUND_ERR_MSG,
  INVALID_CREDENTIALS_ERR_MSG,
  INVALID_INVITE_ERR_MSG,
  EMAIL_EXISTS_ERR_MSG,
  INVALID_RESET_LINK_ERR_MSG,
} from "./appErrors";
