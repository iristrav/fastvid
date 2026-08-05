import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { getSessionSecret } from "./sessionSecret";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

async function getUserFromCookie(cookieHeader: string | undefined): Promise<User | null> {
  if (!cookieHeader) return null;
  const cookies = parseCookieHeader(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { algorithms: ["HS256"] });
    const userId = payload.userId as number | undefined;
    if (!userId) return null;
    const user = await db.getUserById(userId);
    return user ?? null;
  } catch {
    return null;
  }
}

export async function getUserFromRequest(req: { headers: { cookie?: string } }): Promise<User | null> {
  return getUserFromCookie(req.headers.cookie);
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  const user = await getUserFromRequest(opts.req);
  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
