/**
 * Fastvid — Stripe Product & Price Configuration
 * Pro Plan: $499/month, unlimited video generation
 */
import { FASTVID_PRO_MONTHLY_USD, FASTVID_PRO_PRICE_CENTS } from "../shared/billing";

export const FASTVID_PRO_PLAN = {
  name: "Fastvid Pro",
  description: "Unlimited AI YouTube video generation — all lengths, all features",
  priceUsd: FASTVID_PRO_PRICE_CENTS,
  currency: "usd" as const,
  interval: "month" as const,
  features: [
    "Unlimited video generation",
    "All 4 video lengths (1, 8–10, 10–15, 15–20 min)",
    "Virally optimized scripts",
    "Professional AI voiceover",
    "Automatic visual matching",
    "Cinematic effects & transitions",
    "AI thumbnail generator",
    "Voice cloning",
    "Multi-language support",
    "4K export",
    "Priority support",
  ],
};

export { FASTVID_PRO_MONTHLY_USD, FASTVID_PRO_PRICE_LABEL } from "../shared/billing";
