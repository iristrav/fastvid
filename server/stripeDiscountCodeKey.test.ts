/**
 * "Invalid API Key provided: price_..." — a discount code that could not be created.
 *
 * ── What the panel reported ──────────────────────────────────────────────────────────────────
 *
 * /admin → Discount Codes, on create:
 *
 *     Invalid API Key provided: price_...
 *
 * Stripe echoes back the key it was given, so that message names the value it received: a Stripe
 * PRICE ID, sent as the API key.
 *
 * ── Where it came from, and where it did not ─────────────────────────────────────────────────
 *
 * Not from a mapping in FastVid. Both `getStripe()` factories — routers.ts and stripeWebhook.ts —
 * read STRIPE_SECRET_KEY and nothing else, there is no second Stripe client, no per-call `apiKey`
 * override, and FastVid stores no price ID anywhere: `billing.createCheckout` builds an inline
 * `price_data` from FASTVID_PRO_PLAN rather than referencing a price object. The whole repository
 * contains no `price_…` literal. The wrong value was in the environment variable.
 *
 * What the code did wrong was let it through. Every gate asked the same question —
 *
 *     if (!process.env.STRIPE_SECRET_KEY) …
 *
 * — which a price ID answers as well as a real key does. So it was forwarded to Stripe, and the
 * resulting error pointed at Stripe's configuration instead of at the one variable at fault.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────
 *
 * One validator in `_core/env.ts`, beside the other `…KeyFromEnv` readers, used by both existing
 * clients and all three call-site gates. A value that is not a secret key is refused with a
 * sentence naming the variable and what belongs in it, and a startup line says the same thing
 * before anyone reaches the panel. The key itself is never printed — the prefix identifies the kind
 * of value, the tail is the secret, and only the prefix is ever shown.
 */
import { describe, expect, it, vi } from "vitest";

import {
  describeStripeKeyProblem,
  redactStripeKey,
  stripeKeyMode,
  stripeKeyProblem,
  stripeSecretKeyFromEnv,
} from "./_core/env";
import { stripeDiagnostic } from "./stripeStartupDiagnostics";

/**
 * Fixtures with the real shapes, assembled at runtime.
 *
 * None of these is a real key — they are invented — but a literal of this shape in a source file
 * trips GitHub's push protection, which cannot tell an invented Stripe key from a leaked one and
 * should not try. Building them from parts keeps the shapes exact (the validator reads prefixes, so
 * the shape is what matters) without putting a key-shaped string in the repository.
 */
const BODY = "51QRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLm";
const key = (prefix: string, body = BODY) => `${prefix}_${body}`;

/** The production value, in the shape Stripe's error quoted it. */
const PRICE_ID = key("price", "1QRsTuVwXyZaBcDeFgHiJkLm");
const LIVE_KEY = key("sk_live");
const TEST_KEY = key("sk_test");

describe("a price ID is never accepted as an API key", () => {
  it("THE BUG: the value from production is refused, and named for what it is", () => {
    expect(stripeKeyProblem(PRICE_ID)).toBe("PRICE_ID");
    const message = describeStripeKeyProblem("PRICE_ID", PRICE_ID);
    // The message has to be actionable by someone reading it in a panel with no log access.
    expect(message).toContain("STRIPE_SECRET_KEY");
    expect(message).toContain("PRICE ID");
    expect(message).toContain("sk_live_");
  });

  it("the old check — non-empty — is exactly what let it through", () => {
    // Kept as the statement of the bug: this is what every gate used to ask.
    expect(Boolean(PRICE_ID)).toBe(true);
    expect(stripeKeyProblem(PRICE_ID)).not.toBeNull();
  });

  it("the other pastes from the same dashboard are caught too", () => {
    expect(stripeKeyProblem(key("prod", "NabcDEfGhIJKlm"))).toBe("PRODUCT_ID");
    expect(stripeKeyProblem(key("pk_live", "51QRsTuVwXyZaBcDe"))).toBe("PUBLISHABLE_KEY");
    expect(stripeKeyProblem(key("whsec", "abcdef1234567890"))).toBe("WEBHOOK_SECRET");
    expect(stripeKeyProblem(key("cus", "NabcDEfGhIJKlm"))).toBe("NOT_A_SECRET_KEY");
    expect(stripeKeyProblem("")).toBe("MISSING");
    expect(stripeKeyProblem(undefined)).toBe("MISSING");
    expect(stripeKeyProblem("   ")).toBe("MISSING");
  });

  it("a real secret key passes, in both modes and in restricted form", () => {
    // The change must not start refusing keys that work. Restricted keys are Stripe's own
    // recommendation for server-side use and authenticate identically.
    expect(stripeKeyProblem(LIVE_KEY)).toBeNull();
    expect(stripeKeyProblem(TEST_KEY)).toBeNull();
    expect(stripeKeyProblem(key("rk_live", "51QRsTuVwXyZaBcDeFgHi"))).toBeNull();
    expect(stripeKeyProblem(key("rk_test", "51QRsTuVwXyZaBcDeFgHi"))).toBeNull();
    // ...including with the stray whitespace a copy-paste leaves behind.
    expect(stripeKeyProblem(`  ${LIVE_KEY}  `)).toBeNull();
  });

  it("every problem has a message, and every message names the variable", () => {
    for (const problem of [
      "MISSING", "PRICE_ID", "PRODUCT_ID", "PUBLISHABLE_KEY", "WEBHOOK_SECRET", "NOT_A_SECRET_KEY",
    ] as const) {
      const message = describeStripeKeyProblem(problem, PRICE_ID);
      expect(message, problem).toContain("STRIPE_SECRET_KEY");
      expect(message.length, problem).toBeGreaterThan(40);
    }
  });
});

describe("the secret is never logged", () => {
  it("only the prefix and the length survive redaction", () => {
    const redacted = redactStripeKey(LIVE_KEY);
    expect(redacted).toBe(`sk_live_…(${LIVE_KEY.length} chars)`);
    expect(redacted).toContain("59 chars");
    // The body — the part that is actually secret — appears nowhere.
    expect(redacted).not.toContain(BODY);
    expect(LIVE_KEY.includes(redacted.split("…")[0])).toBe(true);
  });

  it("nothing that is printed anywhere contains the key", () => {
    /**
     * The rule stated as a property rather than as a review note: every string this feature can
     * emit about a key is checked against the key's own secret tail.
     */
    const tail = LIVE_KEY.slice(8);
    const emitted = [
      redactStripeKey(LIVE_KEY),
      stripeDiagnostic(LIVE_KEY, true).line,
      stripeDiagnostic(LIVE_KEY, false).line,
      describeStripeKeyProblem("NOT_A_SECRET_KEY", LIVE_KEY),
    ];
    for (const line of emitted) expect(line.includes(tail), line).toBe(false);
  });

  it("a redacted empty value says so rather than printing nothing", () => {
    expect(redactStripeKey("")).toBe("(empty)");
    expect(redactStripeKey(undefined)).toBe("(empty)");
  });
});

describe("the startup line says what is wrong before anyone opens the panel", () => {
  it("a price ID is an ERROR at boot, not a shrug", () => {
    const diag = stripeDiagnostic(PRICE_ID, true);
    expect(diag.ok).toBe(false);
    expect(diag.isError).toBe(true);
    expect(diag.line).toContain("INVALID");
    expect(diag.line).toContain("PRICE ID");
  });

  it("an absent key is reported but is not an error — Stripe is optional here", () => {
    // `.env.example` files Stripe under "not required for video quality"; a missing key must not
    // read like a misconfiguration, and must not stop the process either.
    const diag = stripeDiagnostic("", false);
    expect(diag.ok).toBe(false);
    expect(diag.isError).toBe(false);
    expect(diag.line).toContain("NOT SET");
  });

  it("a good key reports its mode and nothing more", () => {
    expect(stripeDiagnostic(LIVE_KEY, true).ok).toBe(true);
    expect(stripeDiagnostic(LIVE_KEY, true).line).toContain("live mode");
    expect(stripeDiagnostic(TEST_KEY, false).ok).toBe(true);
    expect(stripeDiagnostic(TEST_KEY, false).line).toContain("test mode");
  });

  it("test and live keys mixed up are caught in both directions", () => {
    const testInProd = stripeDiagnostic(TEST_KEY, true);
    expect(testInProd.isError).toBe(true);
    expect(testInProd.line).toContain("TEST key in production");

    const liveInDev = stripeDiagnostic(LIVE_KEY, false);
    expect(liveInDev.isError).toBe(true);
    expect(liveInDev.line).toContain("LIVE key outside production");
  });

  it("the mode is only claimed when it is actually known", () => {
    expect(stripeKeyMode(LIVE_KEY)).toBe("live");
    expect(stripeKeyMode(TEST_KEY)).toBe("test");
    expect(stripeKeyMode(PRICE_ID)).toBeNull();
    // A key with no mode segment is still a usable key; it just cannot be placed.
    expect(stripeKeyMode(key("sk", "51QRsTuVwXyZaBcDe"))).toBeNull();
    expect(stripeKeyProblem(key("sk", "51QRsTuVwXyZaBcDe"))).toBeNull();
  });

  it("it never throws, whatever is in the variable", () => {
    for (const value of ["", " ", PRICE_ID, LIVE_KEY, "\n", "sk_", "rk_", "12345"]) {
      expect(() => stripeDiagnostic(value, true)).not.toThrow();
      expect(() => stripeDiagnostic(value, false)).not.toThrow();
    }
  });
});

describe("the reader that the whole feature hangs on", () => {
  it("reads STRIPE_SECRET_KEY, trimmed, and nothing else", () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    try {
      process.env.STRIPE_SECRET_KEY = `  ${LIVE_KEY}  `;
      expect(stripeSecretKeyFromEnv()).toBe(LIVE_KEY);
      delete process.env.STRIPE_SECRET_KEY;
      expect(stripeSecretKeyFromEnv()).toBe("");
    } finally {
      if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = saved;
    }
  });

  it("no other variable can stand in for it", () => {
    /**
     * The mistake this bug invites is a helpful fallback — reading a price or a publishable key
     * "just in case". There is none, and there must not be one: that is how a price ID would reach
     * Stripe again by a different road.
     */
    const saved = { ...process.env };
    try {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_PRICE_ID = PRICE_ID;
      process.env.STRIPE_PUBLISHABLE_KEY = key("pk_live", "51QRsTuVwXyZaBcDe");
      expect(stripeSecretKeyFromEnv()).toBe("");
      expect(stripeKeyProblem(stripeSecretKeyFromEnv())).toBe("MISSING");
    } finally {
      delete process.env.STRIPE_PRICE_ID;
      delete process.env.STRIPE_PUBLISHABLE_KEY;
      if (saved.STRIPE_SECRET_KEY !== undefined) process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
    }
  });
});

describe("both Stripe clients and all three gates use the one validator", () => {
  const read = (file: string) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(__dirname, file), "utf8");
  };

  it("there is still exactly one Stripe client per entry point, and no third", () => {
    /**
     * The brief's constraint, asserted: the fix must not add a second client or a parallel config.
     * The two that exist are the pre-existing tRPC and webhook ones.
     */
    const routers = read("routers.ts");
    const webhook = read("stripeWebhook.ts");
    expect((routers.match(/new Stripe\(/g) ?? []).length).toBe(1);
    expect((webhook.match(/new Stripe\(/g) ?? []).length).toBe(1);
  });

  it("both construct the client from a validated key", () => {
    for (const file of ["routers.ts", "stripeWebhook.ts"]) {
      const src = read(file);
      expect(src, file).toContain("stripeKeyProblem(key)");
      expect(src, file).toContain("new Stripe(key)");
      // The raw read is gone from the client factory — that is what accepted a price ID.
      expect(src, file).toContain("stripeSecretKeyFromEnv()");
    }
  });

  it("no gate asks the old non-empty question any more", () => {
    // Including the two that are not the discount panel: a price ID must not reach Stripe from
    // checkout or from the redemption-count refresh either.
    const routers = read("routers.ts");
    expect(routers).not.toContain("if (!process.env.STRIPE_SECRET_KEY)");
    expect(routers).not.toContain("!rows.length || !process.env.STRIPE_SECRET_KEY");
    expect((routers.match(/process\.env\.STRIPE_SECRET_KEY/g) ?? []).length).toBe(0);
  });

  it("the create-discount-code gate refuses before it reaches Stripe", () => {
    const routers = read("routers.ts");
    const idx = routers.indexOf("create: adminProcedure");
    expect(idx).toBeGreaterThan(0);
    const block = routers.slice(idx, routers.indexOf("coupons.create(", idx));
    expect(block).toContain("stripeKeyProblem(stripeSecretKeyFromEnv())");
    expect(block).toContain("describeStripeKeyProblem(");
  });

  it("the startup check is actually wired into boot", () => {
    const index = read("_core/index.ts");
    expect(index).toContain("logStripeStartupDiagnostics();");
    expect(index).toContain('from "../stripeStartupDiagnostics"');
  });
});

describe("the discount-code flow itself is unchanged", () => {
  it("a code is still a real Stripe coupon plus promotion code, mirrored locally", () => {
    // Nothing about this round touches what a discount code IS — only which key reaches Stripe.
    const routers = (() => {
      const { readFileSync } = require("fs") as typeof import("fs");
      const { join } = require("path") as typeof import("path");
      return readFileSync(join(__dirname, "routers.ts"), "utf8");
    })();
    const idx = routers.indexOf("create: adminProcedure");
    const block = routers.slice(idx, routers.indexOf("setActive: adminProcedure", idx));
    expect(block).toContain("coupons.create(");
    expect(block).toContain("promotionCodes.create(");
    expect(block).toContain("stripeCouponId: coupon.id");
    expect(block).toContain("stripePromotionCodeId: promo.id");
    // And checkout still builds its price inline rather than from a stored price ID.
    expect(routers).toContain("unit_amount: FASTVID_PRO_PLAN.priceUsd");
    expect(routers).toContain("allow_promotion_codes: true");
  });

  it("no price ID is stored or read anywhere in the server", () => {
    /**
     * The structural reason a price ID could only have come from the environment: FastVid has no
     * price ID to confuse with a key. If one is ever introduced, this test is where the confusion
     * gets caught.
     */
    const { execFileSync } = require("child_process") as typeof import("child_process");
    // grep exits 1 when it finds nothing, which is the passing case here.
    const hits = ((): string => {
      try {
        return execFileSync(
          "grep",
          [
            "-rIl", "-e", "STRIPE_PRICE_ID", "-e", "priceId",
            "--include=*.ts", "--include=*.tsx",
            // Tests may name what they guard against; production code may not.
            "--exclude=*.test.ts", "--exclude-dir=node_modules",
            "server", "shared", "client",
          ],
          { cwd: `${__dirname}/..`, encoding: "utf8" }
        ).toString().trim();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 1) return "";
        throw err;
      }
    })();
    expect(hits).toBe("");
  });
});

/* ═══════════ the flow, driven end to end against a stubbed Stripe ═══════════ */

const stripeStub = vi.hoisted(() => ({
  /** Every key `new Stripe(key)` was constructed with, in order. */
  keys: [] as string[],
  couponParams: [] as Record<string, unknown>[],
  promoParams: [] as Record<string, unknown>[],
}));

vi.mock("stripe", () => {
  class FakeStripe {
    coupons = {
      create: async (params: Record<string, unknown>) => {
        stripeStub.couponParams.push(params);
        return { id: "coupon_test_1" };
      },
      del: async () => ({ deleted: true }),
    };
    promotionCodes = {
      create: async (params: Record<string, unknown>) => {
        stripeStub.promoParams.push(params);
        return { id: "promo_test_1" };
      },
      update: async () => ({}),
      retrieve: async () => ({ times_redeemed: 0 }),
    };
    constructor(key: string) {
      /**
       * The assertion the whole bug turns on: whatever FastVid hands Stripe as the API key is
       * recorded here, so a test can state that it is the secret key and not a price.
       */
      stripeStub.keys.push(key);
    }
  }
  return { default: FakeStripe };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getDiscountCodeByCode: async () => null,
    createDiscountCodeRow: async () => 42,
  };
});

describe("creating a discount code from the admin panel", () => {
  const KEY_ENV = "STRIPE_SECRET_KEY";

  /**
   * `_stripe` is a module-level singleton in routers.ts — the first construction wins for the life
   * of the module — so each case loads a fresh copy with the environment already set.
   */
  async function callCreate(key: string | undefined) {
    vi.resetModules();
    stripeStub.keys.length = 0;
    stripeStub.couponParams.length = 0;
    stripeStub.promoParams.length = 0;
    const saved = process.env[KEY_ENV];
    if (key === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = key;
    try {
      const { appRouter } = await import("./routers");
      const caller = appRouter.createCaller({
        user: {
          id: 99, openId: "admin-openid", email: "admin@test.com", name: "Admin",
          loginMethod: "manus", role: "admin", subscriptionStatus: "active",
          subscriptionStartDate: new Date(), subscriptionEndDate: null,
          stripeCustomerId: null, stripeSubscriptionId: null,
          createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
        },
        req: { protocol: "https", headers: {} },
        res: { clearCookie: () => {} },
      } as unknown as Parameters<typeof appRouter.createCaller>[0]);
      return await caller.discount.create({ code: "LAUNCH20", percentOff: 20 });
    } finally {
      if (saved === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = saved;
    }
  }

  /** Every distinct key Stripe was constructed with. The count of constructions is an internal
   *  detail (the module caches one client); WHICH key it got is the whole question here. */
  const keysGiven = () => [...new Set(stripeStub.keys)];

  it("THE REPORTED FAILURE: a price ID is refused with a message about the variable", async () => {
    await expect(callCreate(PRICE_ID)).rejects.toThrow(/STRIPE_SECRET_KEY.*PRICE ID/s);
    // And Stripe was never constructed, so no price ID left the process.
    expect(keysGiven()).toEqual([]);
  }, 60_000);

  it("THE FIX: with a real secret key the code is created, and Stripe gets that key", async () => {
    const result = await callCreate(LIVE_KEY);
    expect(result).toEqual({ id: 42, code: "LAUNCH20" });
    // The key handed to Stripe is the secret key — the assertion the bug report asks for.
    expect(keysGiven()).toEqual([LIVE_KEY]);
    expect(keysGiven()[0].startsWith("sk_")).toBe(true);
    expect(keysGiven()[0].startsWith("price_")).toBe(false);
  }, 60_000);

  it("the coupon and promotion code carry what the admin asked for", async () => {
    await callCreate(TEST_KEY);
    expect(keysGiven()).toEqual([TEST_KEY]);
    expect(stripeStub.couponParams[0]).toMatchObject({ name: "LAUNCH20", percent_off: 20 });
    expect(stripeStub.promoParams[0]).toMatchObject({
      code: "LAUNCH20",
      promotion: { type: "coupon", coupon: "coupon_test_1" },
    });
  }, 60_000);

  it("an unset key still says Stripe is not configured", async () => {
    await expect(callCreate(undefined)).rejects.toThrow(/STRIPE_SECRET_KEY is not set/);
    expect(keysGiven()).toEqual([]);
  }, 60_000);

  it("a non-admin cannot reach the procedure at all", async () => {
    // The access rule this router rests on, re-checked because this file now constructs callers.
    vi.resetModules();
    stripeStub.keys.length = 0;
    process.env[KEY_ENV] = LIVE_KEY;
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      user: null,
      req: { protocol: "https", headers: {} },
      res: { clearCookie: () => {} },
    } as unknown as Parameters<typeof appRouter.createCaller>[0]);
    await expect(caller.discount.create({ code: "NOPE", percentOff: 10 })).rejects.toThrow();
    // Refused before any Stripe work, so an unauthenticated caller cannot even probe the config.
    expect(keysGiven()).toEqual([]);
    delete process.env[KEY_ENV];
  }, 60_000);
});
