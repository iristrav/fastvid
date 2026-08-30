/**
 * The price, and the one variable that can carry it into Stripe.
 *
 * Every price on the site is derived from one number in `shared/billing.ts`, so the risk is not
 * that one page disagrees with another — it is that a page hard-codes its own figure and then
 * quietly keeps showing the old one after a price change. These tests are about the arithmetic
 * and about that single source of truth, not about layout.
 */
import { describe, expect, it } from "vitest";

import {
  FASTVID_PRO_MONTHLY_USD,
  FASTVID_PRO_PRICE_CENTS,
  FASTVID_PRO_PRICE_DISPLAY,
  FASTVID_PRO_PRICE_LABEL,
} from "../shared/billing";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};

describe("the price", () => {
  it("is $1,199 per month", () => {
    expect(FASTVID_PRO_MONTHLY_USD).toBe(1199);
    expect(FASTVID_PRO_PRICE_DISPLAY).toBe("$1,199");
    expect(FASTVID_PRO_PRICE_LABEL).toBe("$1,199/month");
  });

  it("reaches Stripe in cents, because Stripe counts in cents", () => {
    /**
     * The one conversion that silently overcharges or undercharges by a factor of a hundred:
     * Stripe's `unit_amount` is minor units, so a price passed in dollars would bill $11.99.
     */
    expect(FASTVID_PRO_PRICE_CENTS).toBe(119900);
    expect(FASTVID_PRO_PRICE_CENTS).toBe(FASTVID_PRO_MONTHLY_USD * 100);
    expect(Number.isInteger(FASTVID_PRO_PRICE_CENTS)).toBe(true);
  });

  it("is grouped, so a four-figure price does not read as a typo", () => {
    // "$1199" invites a second look; "$1,199" does not.
    expect(FASTVID_PRO_PRICE_DISPLAY).toBe("$1,199");
  });
});

describe("one source of truth", () => {
  it("every display string is built from FASTVID_PRO_MONTHLY_USD", () => {
    const digits = FASTVID_PRO_MONTHLY_USD.toLocaleString("en-US");
    expect(FASTVID_PRO_PRICE_DISPLAY).toContain(digits);
    expect(FASTVID_PRO_PRICE_LABEL).toContain(digits);
    expect(FASTVID_PRO_PRICE_CENTS / 100).toBe(FASTVID_PRO_MONTHLY_USD);
  });

  it("the pipeline's plan config agrees with it", async () => {
    // server/products.ts feeds the Stripe checkout; drift here means the site advertises one
    // price and charges another.
    const { FASTVID_PRO_PLAN } = await import("./products");
    expect(FASTVID_PRO_PLAN.priceUsd).toBe(FASTVID_PRO_PRICE_CENTS);
    expect(FASTVID_PRO_PLAN.currency).toBe("usd");
    expect(FASTVID_PRO_PLAN.interval).toBe("month");
  });

  it("no page hard-codes a price of its own", () => {
    /**
     * The property that makes a price change a one-line edit. A literal "$599" left behind on one
     * page after a change is the classic way a site ends up quoting two different prices.
     */
    for (const page of ["Home.tsx", "Subscribe.tsx", "Dashboard.tsx", "Admin.tsx"]) {
      const src = read(`client/src/pages/${page}`);
      expect(src, page).not.toContain("$599");
      expect(src, page).not.toContain("$1199");
      expect(src, page).not.toContain("$1,199");
    }
  });

  it("the old price is gone from the shared module too", () => {
    const billing = read("shared/billing.ts");
    expect(billing).not.toContain("599");
  });
});

describe("the Stripe checkout", () => {
  const routers = read("server/routers.ts");

  it("bills the configured price when STRIPE_PRO_PRICE_ID is set", () => {
    expect(routers).toContain("process.env.STRIPE_PRO_PRICE_ID?.trim()");
    expect(routers).toContain("line_items: [{ price: priceId, quantity: 1 }]");
  });

  it("still works without it, so a missing variable cannot cost a sale", () => {
    // The fallback creates a Price on the fly, exactly as before — it costs a tidy dashboard,
    // never a subscription.
    expect(routers).toContain("configuredPriceId ||");
    expect(routers).toContain("prices.create({");
    expect(routers).toContain("unit_amount: FASTVID_PRO_PLAN.priceUsd");
  });

  it("refuses a value that is not a price ID, naming the variable", () => {
    // The STRIPE_SECRET_KEY lesson, applied to the second Stripe variable: say which variable is
    // wrong rather than forwarding the value and relaying Stripe's confusion about it.
    expect(routers).toContain('!configuredPriceId.startsWith("price_")');
    expect(routers).toContain("STRIPE_PRO_PRICE_ID must be a Stripe price ID");
  });

  it("adds no tax handling — the listed price is what is charged", () => {
    expect(routers).not.toContain("automatic_tax");
    expect(routers).not.toContain("tax_behavior");
  });

  it("discount codes still work at checkout", () => {
    expect(routers).toContain("allow_promotion_codes: true");
  });
});
