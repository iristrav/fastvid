export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

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
