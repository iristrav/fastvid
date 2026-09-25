/**
 * RONDE 652 — ONE CEILING FOR EVERY /api REQUEST, PER CLIENT.
 *
 * Only the auth procedures were throttled (`rateLimitedProcedure`). Everything else under /api —
 * tRPC, the plain Express routes, the health probes — accepted any number of requests from one
 * address. This is abuse prevention, not metering: the ceiling is far above what the app itself
 * sends (the editor polls a render job every few seconds), so a person using FastVid never meets
 * it and a script hammering it does.
 *
 * Video bytes and live progress are left out: a player issues many range requests for one video,
 * and an event stream is one long request, neither of which says anything about abuse.
 * Per process, like the auth limiter — the web service runs one replica.
 */
import type { NextFunction, Request, Response } from "express";
import { checkRateLimit } from "./rateLimit";

export const API_RATE_LIMIT_PER_MIN_DEFAULT = 600;

export function apiRateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.API_RATE_LIMIT_PER_MIN?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return API_RATE_LIMIT_PER_MIN_DEFAULT;
  return Math.min(10_000, Math.max(60, n));
}

const EXEMPT: readonly RegExp[] = [
  /^\/api\/stream\//,
  /^\/api\/download\//,
  /^\/api\/events\//,
  /^\/api\/health\/live$/,
];

export function isRateLimitedApiPath(p: string): boolean {
  return p.startsWith("/api/") && !EXEMPT.some((re) => re.test(p));
}

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!isRateLimitedApiPath(req.path)) {
    next();
    return;
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (!checkRateLimit(`api:${ip}`, apiRateLimitPerMinute())) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Too many requests — please try again in a minute" });
    return;
  }
  next();
}
