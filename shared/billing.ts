/**
 * Fastvid Pro subscription — the one place the price is written down.
 *
 * Everything that shows a price reads from here: the home page, the subscribe page, the dashboard
 * upsell, the admin revenue figure, and the Stripe checkout amount. Changing the number below
 * changes all of them at once, which is the only way they can be guaranteed to agree.
 */
export const FASTVID_PRO_MONTHLY_USD = 1199;
export const FASTVID_PRO_PRICE_CENTS = FASTVID_PRO_MONTHLY_USD * 100;

/** `$1,199` — grouped, because a four-figure price without a separator reads as a typo. */
export const FASTVID_PRO_PRICE_DISPLAY = `$${FASTVID_PRO_MONTHLY_USD.toLocaleString("en-US")}`;
export const FASTVID_PRO_PRICE_LABEL = `${FASTVID_PRO_PRICE_DISPLAY}/month`;
