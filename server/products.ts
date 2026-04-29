/**
 * Fastvid — Stripe Product & Price Configuration
 * Pro Plan: €500/month, unlimited video generation
 */

export const FASTVID_PRO_PLAN = {
  name: "Fastvid Pro",
  description: "Unlimited AI YouTube video generation — all lengths, all features",
  priceEur: 500_00, // in cents
  currency: "eur",
  interval: "month" as const,
  features: [
    "Unlimited video generation",
    "All 5 video lengths (5–8, 8–12, 12–15, 15–20, 20+ min)",
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
