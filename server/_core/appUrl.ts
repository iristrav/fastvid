import type { Express, Request } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Canonical public URL, e.g. https://fastvid.app — set APP_URL in Railway. */
export function getConfiguredAppUrl(): string | null {
  const raw = (process.env.APP_URL ?? process.env.PUBLIC_APP_URL ?? "").trim();
  if (!raw) return null;
  const withScheme = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  return withScheme.replace(/\/$/, "");
}

function requestProto(req: Pick<Request, "headers" | "protocol">): string {
  if (req.protocol === "https") return "https";
  const forwarded = req.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim().toLowerCase() === "https" ? "https" : "http";
}

function requestHost(req: Pick<Request, "headers">): string | null {
  const host = req.headers.host?.split(":")[0]?.trim().toLowerCase();
  return host || null;
}

/** Origin for Stripe, password-reset emails, etc. Prefers APP_URL when configured. */
export function resolveAppOrigin(
  req: Pick<Request, "headers" | "protocol">,
  clientOrigin?: string | null
): string {
  const configured = getConfiguredAppUrl();
  if (configured) return configured;

  const client = clientOrigin?.trim().replace(/\/$/, "");
  if (client && (client.startsWith("http://") || client.startsWith("https://"))) {
    return client;
  }

  const headerOrigin = req.headers.origin?.trim().replace(/\/$/, "");
  if (headerOrigin) return headerOrigin;

  const host = requestHost(req);
  if (!host) return "http://localhost:3000";
  return `${requestProto(req)}://${host}`;
}

function registrableCookieDomain(hostname: string): string | undefined {
  if (LOCAL_HOSTS.has(hostname) || hostname.includes(":")) return undefined;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;
  return `.${parts.slice(-2).join(".")}`;
}

export function getCookieDomain(req: Request): string | undefined {
  const configured = getConfiguredAppUrl();
  if (configured) {
    try {
      return registrableCookieDomain(new URL(configured).hostname);
    } catch {
      /* fall through */
    }
  }
  const host = requestHost(req);
  if (!host || LOCAL_HOSTS.has(host)) return undefined;
  return registrableCookieDomain(host);
}

/** Redirect Railway / www hosts to APP_URL (HTML routes only — keep /api on any host). */
export function registerCanonicalAppUrl(app: Express): void {
  const appUrl = getConfiguredAppUrl();
  if (!appUrl) return;

  let canonical: URL;
  try {
    canonical = new URL(appUrl);
  } catch {
    console.warn("[AppUrl] Invalid APP_URL — canonical redirects disabled:", appUrl);
    return;
  }

  console.log("[AppUrl] Canonical URL:", canonical.origin);

  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return next();

    const host = requestHost(req);
    if (!host || host === canonical.hostname) return next();

    const shouldRedirect =
      host.endsWith(".up.railway.app") ||
      host === `www.${canonical.hostname}`;

    if (!shouldRedirect) return next();

    const target = `${canonical.origin}${req.originalUrl}`;
    res.redirect(301, target);
  });
}
