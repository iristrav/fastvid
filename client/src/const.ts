export {
  APP_ERROR,
  COOKIE_NAME,
  ONE_YEAR_MS,
  PIPELINE_ERROR,
  appErrorText,
  toastErrorMessage,
  matchesAppError,
  parseAppErrorCode,
  NOT_ADMIN_ERR_MSG,
  SUBSCRIPTION_REQUIRED_ERR_MSG,
  UNAUTHED_ERR_MSG,
} from "@shared/const";

/**
 * Returns the local login page URL.
 * Standalone auth — no Manus OAuth.
 */
export const getLoginUrl = (returnPath = "/"): string => {
  if (returnPath && returnPath !== "/") {
    return `/login?return=${encodeURIComponent(returnPath)}`;
  }
  return "/login";
};
