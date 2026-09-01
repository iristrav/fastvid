/**
 * The invite code opens the door; the subscription is what gets you inside.
 *
 * ── The gap ──────────────────────────────────────────────────────────────────────────────────
 *
 * The server has always refused the actual work without an active subscription —
 * `subscribedProcedure` throws SUBSCRIPTION_REQUIRED, and that is the enforcement. What the
 * ROUTING did not do was send anyone there, and in one case it actively let them past:
 *
 *     if (!loading && isAuthenticated && user && !hasActiveSubscription && !needsOnboarding) {
 *       navigate("/subscribe");
 *     }
 *
 * A freshly registered account has BOTH — no subscription and an incomplete niche request — so
 * `!needsOnboarding` was false, no redirect fired, and the user landed in the dashboard shell.
 * That is exactly the state an invite code is not supposed to grant.
 *
 * Registration compounded it by sending people to the niche-request form first, so they filled in
 * a form before discovering there was a paywall behind it.
 *
 * ── What changed ─────────────────────────────────────────────────────────────────────────────
 *
 * The subscription is the first question at every entry point: after registering, on "Get started",
 * on "Get started now", and on both Generate buttons. The niche request is not skipped — it is
 * asked for once the subscription is active.
 *
 * These are source-level assertions on the client, which has no test runner here. They are the
 * weaker kind of test and are labelled as such; the behavioural half is the server gate below,
 * which is what actually refuses the work.
 */
import { describe, expect, it } from "vitest";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

/* ═══════════════════════ the enforcement ═══════════════════════ */

describe("the server is what actually refuses the work", () => {
  it("subscribedProcedure blocks a user without an active subscription", () => {
    const trpc = read("server/_core/trpc.ts");
    expect(trpc).toContain('if (ctx.user.subscriptionStatus !== "active")');
    expect(trpc).toContain("APP_ERROR.SUBSCRIPTION_REQUIRED");
  });

  it("...and lets an admin through, which is the only exemption", () => {
    const trpc = read("server/_core/trpc.ts");
    expect(trpc).toContain('if (ctx.user.role === "admin") return next({ ctx });');
  });

  it("video generation runs on that procedure, not on a looser one", () => {
    /**
     * The routing below is a courtesy. If this ever stopped being a subscribedProcedure, every
     * client-side check in this file would become decoration.
     */
    const routers = read("server/routers.ts");
    const idx = routers.indexOf("generate: subscribedProcedure");
    expect(idx, "video.generate must be a subscribedProcedure").toBeGreaterThan(0);
  });
});

/* ═══════════════════════ the routing, at every entry point ═══════════════════════ */

describe("after the invite code, the subscription is the next step", () => {
  it("registering sends the new account to the paywall, not to the niche form", () => {
    /**
     * They arrive with no subscription, so the studio is going to refuse them. Asking for the
     * niche request first meant doing work before finding that out.
     */
    const login = read("client/src/pages/Login.tsx");
    const idx = login.indexOf("const register = trpc.auth.register.useMutation({");
    expect(idx).toBeGreaterThan(0);
    // Bounded by the mutation's own onError, not by the first `});` — which sits inside the
    // toast call and cut the block before the navigate it is about.
    const block = login.slice(idx, login.indexOf("onError:", idx));
    expect(block).toContain('navigate("/subscribe")');
    expect(block).not.toContain('navigate("/dashboard/niche-requests")');
  });

  it("the niche request is reordered, not removed", () => {
    // Still required, still routed to — after paying rather than instead of it.
    const dashboard = read("client/src/pages/Dashboard.tsx");
    expect(dashboard).toContain("needsOnboarding");
    expect(dashboard).toContain("/dashboard/niche-requests");
  });
});

describe("every button on the landing page leads to the paywall", () => {
  const home = () => read("client/src/pages/Home.tsx");

  it("'Get started' and 'Get started now' share one handler", () => {
    /**
     * Four buttons — header, mobile menu, pricing card, closing call to action — all call
     * `handleGetStarted`. One handler is what stops them drifting apart, which is how the gap got
     * in.
     */
    const src = home();
    expect((src.match(/onClick=\{handleGetStarted\}/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("that handler sends an unsubscribed visitor to /subscribe, not to /dashboard", () => {
    const src = home();
    const idx = src.indexOf("const handleGetStarted = () => {");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, src.indexOf("\n};", idx));
    expect(body).toContain('navigate("/login")');
    expect(body).toContain('navigate("/subscribe")');
    expect(body).toContain('navigate("/dashboard")');
    // Order settles it: not signed in → login, signed in but unpaid → subscribe, else dashboard.
    expect(body.indexOf('navigate("/subscribe")')).toBeLessThan(body.indexOf('navigate("/dashboard")'));
  });

  it("the landing page's Generate button does the same, and keeps the prompt", () => {
    /**
     * Someone who typed an idea and pressed Generate has already said what they want. Making them
     * retype it after paying reads as the product losing their work, and the dashboard reads these
     * parameters either way.
     */
    const src = home();
    const idx = src.indexOf("const handleGenerate = () => {");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, src.indexOf("\n  };", idx));
    expect(body).toContain("navigate(`/subscribe?prompt=");
    expect(body).toContain("&length=${selectedLength}");
  });

  it("both handlers read ONE definition of 'may use the product'", () => {
    // The same rule the dashboard and the server use. Two definitions is how the gap returns.
    const src = home();
    expect(src).toContain('?.subscriptionStatus === "active"');
    expect(src).toContain('?.role === "admin"');
  });
});

/* ═══════════════════════ the gap that let people through ═══════════════════════ */

describe("the dashboard no longer waives the paywall during onboarding", () => {
  const dashboard = () => read("client/src/pages/Dashboard.tsx");

  it("THE BUG: `&& !needsOnboarding` let a fresh account into the studio shell", () => {
    /**
     * A freshly registered user has no subscription AND an incomplete niche request, so the
     * condition was false and the redirect never fired — the one combination the guard most needed
     * to catch.
     */
    const src = dashboard();
    expect(src).not.toContain("!hasActiveSubscription && !needsOnboarding");
    expect(src).toContain("if (!loading && isAuthenticated && user && !hasActiveSubscription) {");
  });

  it("Generate says what is missing before it sends anything", () => {
    const src = dashboard();
    const idx = src.indexOf("const handleGenerate = () => {");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, src.indexOf("\n  };", idx));
    expect(body).toContain("if (!hasActiveSubscription)");
    expect(body).toContain('navigate("/subscribe")');
    // The check comes first — before the prompt-length check, so an unpaid user is not asked to
    // fix their prompt for a request that was never going to be accepted.
    expect(body.indexOf("if (!hasActiveSubscription)")).toBeLessThan(
      body.indexOf("prompt.length < 10")
    );
  });

  it("the studio itself still needs both the subscription and the niche request", () => {
    // Paying does not skip onboarding; it only stops onboarding from skipping the paywall.
    expect(dashboard()).toContain("const showVideoStudio = canUsePlatform && hasActiveSubscription;");
  });

  it("admins are unaffected everywhere", () => {
    const dash = dashboard();
    expect(dash).toContain('userSub === "active" || user?.role === "admin"');
  });
});
