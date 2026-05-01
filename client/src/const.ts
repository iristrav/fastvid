export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = () => "/login";
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;

  // If OAuth is not configured (e.g. Railway without Manus env vars), return a
  // safe fallback so the app doesn't crash with "Invalid URL".
  if (!oauthPortalUrl || !appId) {
    console.warn("[Fastvid] OAuth not configured: VITE_OAUTH_PORTAL_URL or VITE_APP_ID missing.");
    return "#login-not-configured";
  }

  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const state = btoa(redirectUri);

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};
