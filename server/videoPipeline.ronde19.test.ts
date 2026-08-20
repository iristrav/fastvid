import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 19 — render 526 burned its entire 180s/scene budget re-hammering providers that were
// timing out (GDELT 74×, SepiaSearch 44×, Pexels 40×, Pixabay/Internet Archive 19× each) because
// every breaker only tripped after 8 consecutive failures — and GDELT had no breaker at all.
// Fix: (A) trip every visual/search provider after 3 via one shared constant; (B) give GDELT the
// same breaker as the others, and honor it at the top of fetchGdeltTvNewsClips.

const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const VISUAL_PROVIDERS = [
  "WIKIMEDIA", "INTERNET_ARCHIVE", "PEXELS", "PIXABAY", "EUROPEANA", "NARA", "FLICKR",
  "SEPIASEARCH", "VIMEO", "MEDIA_CCC", "NASA", "YOUTUBE", "SERPAPI", "GDELT",
];
const TTS_PROVIDERS = ["ELEVENLABS", "FISH_AUDIO", "GOOGLE_TTS"];

describe("RONDE 19A — visual/search providers trip after 3, voice stays at 8", () => {
  it("defines the shared trip constant at 3", () => {
    expect(src).toContain("const VISUAL_PROVIDER_FAILURE_STREAK_TRIP = 3;");
  });

  it.each(VISUAL_PROVIDERS)("%s references the shared 3-failure trip", (p) => {
    expect(src).toContain(`const ${p}_FAILURE_STREAK_TRIP = VISUAL_PROVIDER_FAILURE_STREAK_TRIP;`);
  });

  it.each(TTS_PROVIDERS)("voice provider %s keeps its own 8-failure trip", (p) => {
    expect(src).toContain(`const ${p}_FAILURE_STREAK_TRIP = 8;`);
  });
});

describe("RONDE 19B — GDELT gets a real breaker and honors it", () => {
  it("defines the GDELT breaker state and helpers", () => {
    expect(src).toContain("const GDELT_FAILURE_STREAK_TRIP = VISUAL_PROVIDER_FAILURE_STREAK_TRIP;");
    expect(src).toContain("function isGdeltInCooldown()");
    expect(src).toContain("function markGdeltSearchResult(success: boolean)");
  });

  it("skips the GDELT tier while it is in cooldown", () => {
    // Guard must sit inside fetchGdeltTvNewsClips, before the network fan-out.
    const fn = src.slice(
      src.indexOf("export async function fetchGdeltTvNewsClips"),
      src.indexOf("providerMetrics(sourcingCache, \"gdelt_tv\").resultCount"),
    );
    // RONDE 20 widened this guard to also honor the download breaker; the search guard remains.
    expect(fn).toContain("if (isGdeltInCooldown() || isGdeltDownloadInCooldown()) return [];");
    // A run of pure timeouts must be able to trip the breaker; a reachable response resets it.
    expect(fn).toContain("markGdeltSearchResult(true)");
    expect(fn).toContain("markGdeltSearchResult(false)");
  });
});
