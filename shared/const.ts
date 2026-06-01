export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;

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
