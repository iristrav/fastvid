import { useEffect } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2 } from "lucide-react";

/**
 * Login page — redirects to Manus OAuth.
 * After OAuth completes, the server sets a session cookie and redirects back to /.
 */
export default function Login() {
  const { isAuthenticated, loading } = useAuth();

  useEffect(() => {
    if (loading) return;

    if (isAuthenticated) {
      // Already logged in — go to dashboard
      window.location.href = "/dashboard";
      return;
    }

    // Build the OAuth login URL using the Manus portal
    const appId = import.meta.env.VITE_APP_ID;
    const portalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;

    if (!appId || !portalUrl) {
      console.error("[Login] Missing VITE_APP_ID or VITE_OAUTH_PORTAL_URL");
      return;
    }

    // The redirect URI must be the current origin + /api/oauth/callback
    const redirectUri = `${window.location.origin}/api/oauth/callback`;
    // State encodes the return URL (origin) so the server can redirect back
    const state = btoa(`${window.location.origin}/`);

    const loginUrl = `${portalUrl}/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;

    window.location.href = loginUrl;
  }, [isAuthenticated, loading]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a1a] text-white">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
        <p className="text-slate-400 text-sm">Doorsturen naar inlogpagina...</p>
      </div>
    </div>
  );
}
