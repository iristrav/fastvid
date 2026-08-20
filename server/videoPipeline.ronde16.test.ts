import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 16 — "why does YouTube CC return 0 results?"
//
// Production logs: youtube_cc searches=1 results=0, long stretches of "YouTube clip sourcing:
// disabled", and — when enabled — "✅ YouTube CC via RapidAPI: found 5 relevant videos" followed by
// "YouTube CC API error 429" / "0 relevant results". The official YouTube Data API v3 search costs
// 100 quota units/call and 429s after a few renders, which trips a cooldown. RONDE 10 built a
// quota-free RapidAPI fair-use fallback for exactly that case — but both searchYoutubeVideoCandidates
// and fetchYouTubeCCClips had `if (isYoutubeInCooldown()) return []` BEFORE the fallback, so the
// cooldown (set by Google's quota) suppressed the RapidAPI fallback too, even though RapidAPI hits a
// different host and has nothing to do with Google's quota. Net: YouTube CC went fully dark for the
// whole 45+ minute cooldown — the fallback could never run in the exact situation it exists for.
//
// Fix: the cooldown now skips only the OFFICIAL call (never re-hammered); the quota-free RapidAPI
// fair-use fallback still runs.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function fnBody(marker: string): string {
  const start = pipelineSrc.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = pipelineSrc.indexOf("\nexport async function ", start + 1);
  return codeOnly(pipelineSrc.slice(start, end === -1 ? start + 9000 : end));
}

describe("RONDE 16 — the official-API cooldown no longer suppresses the quota-free RapidAPI fallback", () => {
  const searchBody = fnBody("export async function searchYoutubeVideoCandidates");

  it("searchYoutubeVideoCandidates no longer hard-returns [] on cooldown before the fallback", () => {
    // The old `if (isYoutubeInCooldown()) return [];` early-out is gone from this function.
    expect(searchBody).not.toContain("if (isYoutubeInCooldown()) return [];");
  });

  it("instead, cooldown skips ONLY the official API call (searchData = null), so the fallback runs", () => {
    expect(searchBody).toContain("const searchData = isYoutubeInCooldown()");
    expect(searchBody).toContain("? null");
    expect(searchBody).toContain(": await cachedProviderSearch(");
  });

  it("the RapidAPI fair-use fallback is still gated to license=any + opt-in (unchanged policy)", () => {
    expect(searchBody).toContain('license === "any"');
    expect(searchBody).toContain("youtubeRapidSearchFallbackEnabled()");
    expect(searchBody).toContain("searchYoutubeViaRapidApi(");
  });

  const fetchBody = fnBody("export async function fetchYouTubeCCClips");

  it("fetchYouTubeCCClips only bails on cooldown when there is no quota-free fallback to try", () => {
    expect(fetchBody).toContain(
      "if (isYoutubeInCooldown() && !(youtubeRapidSearchFallbackEnabled() && youtubeFairUseEnabled())) return [];"
    );
    // the unconditional early return is gone
    expect(fetchBody).not.toContain("if (isYoutubeInCooldown()) return [];");
  });
});
