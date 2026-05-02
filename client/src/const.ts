export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Build the Manus OAuth login URL.
 * The redirect_uri points to our server's /api/oauth/callback.
 * The state encodes the current origin so the server can redirect back after login.
 */
export const getLoginUrl = (returnPath = "/"): string => {
  const appId = import.meta.env.VITE_APP_ID;
  const portalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;

  if (!appId || !portalUrl) {
    // Fallback: redirect to /login page which shows a loading spinner
    return "/login";
  }

  try {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const redirectUri = `${origin}/api/oauth/callback`;
    // State = base64(origin + returnPath) so server can redirect back
    const state = btoa(`${origin}${returnPath}`);

    const url = new URL(`${portalUrl}/oauth/authorize`);
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);

    return url.toString();
  } catch {
    return "/login";
  }
};
