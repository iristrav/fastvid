/**
 * RONDE 652 — HEALTH PROBES THAT SPEND MONEY OR QUOTA ARE FOR THE OPERATOR ONLY.
 *
 * `/api/health/youtube-probe` sends one real YouTube `search.list` per request, and the project
 * has 100 a day for every customer together: a hundred anonymous requests — a monitor, a crawler,
 * anyone who read the URL — and nobody gets YouTube footage until the quota resets.
 * `/api/health/stability-probe` pays for a Stability image per request, `/api/health/llm-smoke` for
 * an LLM call. None of them asked who was calling.
 *
 * An operator is either a signed-in admin (the session cookie, the same check `/api/debug/ffmpeg`
 * already makes) or a caller presenting `x-operator-key` equal to `OPERATOR_PROBE_KEY`, for an
 * external monitor that cannot sign in. The key is only accepted when it is set and at least 24
 * characters long, and it is compared in constant time. It is never logged.
 */
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";

const MIN_KEY_LENGTH = 24;

export function operatorKeyMatches(presented: unknown, expected: string | undefined): boolean {
  const want = expected?.trim() ?? "";
  if (want.length < MIN_KEY_LENGTH) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireOperator(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (operatorKeyMatches(req.headers["x-operator-key"], process.env.OPERATOR_PROBE_KEY)) {
    next();
    return;
  }
  const { parse: parseCookies } = await import("cookie");
  const { jwtVerify } = await import("jose");
  const { COOKIE_NAME } = await import("@shared/const");
  const { getSessionSecret } = await import("./sessionSecret");
  const token = parseCookies(req.headers.cookie ?? "")[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let userId: number;
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { algorithms: ["HS256"] });
    userId = payload.userId as number;
    if (!userId) throw new Error("No userId in token");
  } catch {
    res.status(401).json({ error: "Invalid session" });
    return;
  }
  const { getUserById } = await import("../db");
  const user = await getUserById(userId).catch(() => undefined);
  if (user?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
