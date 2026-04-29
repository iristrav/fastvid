import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createUserContext(overrides: Partial<AuthenticatedUser> = {}): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user-openid",
    email: "user@test.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    subscriptionStatus: "active",
    subscriptionStartDate: new Date(),
    subscriptionEndDate: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

function createAdminContext(): TrpcContext {
  return createUserContext({ id: 99, role: "admin", openId: "admin-openid" });
}

function createInactiveContext(): TrpcContext {
  return createUserContext({ subscriptionStatus: "inactive" });
}

describe("auth.me", () => {
  it("returns the current user when authenticated", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toMatchObject({ id: 1, role: "user" });
  });

  it("returns null when not authenticated", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });
});

describe("video.generate", () => {
  it("throws FORBIDDEN for inactive subscription", async () => {
    const ctx = createInactiveContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.video.generate({ prompt: "A test video about technology", videoLength: "5-8" })
    ).rejects.toThrow("Active subscription required");
  });

  it("throws UNAUTHORIZED when not logged in", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.video.generate({ prompt: "A test video about technology", videoLength: "5-8" })
    ).rejects.toThrow();
  });

  it("validates prompt minimum length", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.video.generate({ prompt: "short", videoLength: "5-8" })
    ).rejects.toThrow();
  });
});

describe("admin procedures", () => {
  it("throws FORBIDDEN for non-admin users on stats", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.stats()).rejects.toThrow("Admin access required");
  });

  it("throws FORBIDDEN for non-admin on listUsers", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.listUsers({ limit: 10, offset: 0 })).rejects.toThrow("Admin access required");
  });

  it("throws FORBIDDEN for non-admin on updateUserRole", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.updateUserRole({ userId: 1, role: "admin" })).rejects.toThrow("Admin access required");
  });
});

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const ctx = createUserContext();
    const clearedCookies: { name: string; options: Record<string, unknown> }[] = [];
    (ctx.res as { clearCookie: (name: string, options: Record<string, unknown>) => void }).clearCookie = (name, options) => {
      clearedCookies.push({ name, options });
    };
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.options).toMatchObject({ maxAge: -1 });
  });
});
