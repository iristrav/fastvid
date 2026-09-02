/**
 * WHY YOUTUBE FETCHED NOTHING, AND WHY NOBODY COULD TELL.
 *
 * ── What render 562 shows ───────────────────────────────────────────────────────────────────
 *
 *     [YouTubeUsage] used=0
 *     …and not one live YouTube search anywhere in the log.
 *
 * (The eleven `[YouTubeLicense]` lines in that render are archive.org's own `youtube-<id>`
 * mirrors, fetched from Internet Archive. Live YouTube never ran.)
 *
 * ── Why one flag was never the answer ───────────────────────────────────────────────────────
 *
 * YouTube needs three separate things, and the third surprises people:
 *
 *   ENABLE_YOUTUBE_SOURCING           the switch, default off
 *   YOUTUBE_API_KEY                   to SEARCH
 *   RAPIDAPI_KEY | YOUTUBE_CC_DL_SERVICE   to DOWNLOAD
 *
 * YouTube serves no media files. The Data API finds videos and will not give you one, so a
 * deployment with the flag and the API key finds clips it cannot fetch. Two of these are keys for
 * different companies.
 *
 * The route line reported the FLAG alone, so that deployment logged `youtube=on` and searched
 * nothing — and `searchYoutubeVideoCandidates` returned `[]` without a word, so the provider was
 * absent from the render with no trace anywhere that it had been asked for.
 *
 * ── The one that is set but wrong ───────────────────────────────────────────────────────────
 *
 * `YOUTUBE_CC_DL_SERVICE` authenticates with `Authorization: Bearer <YOUTUBE_CC_DL_TOKEN>` and
 * answers 401 without it. A token-less service is genuinely supported, so this is not a missing
 * requirement — but the first version of this readiness check called that configuration `ready`,
 * which is how a download route that 401s on every request would have looked healthy.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  formatYoutubeReadiness,
  youtubeReadinessWarnings,
  youtubeSourcingReadiness,
} from "./sourcingPolicy";

const VARS = [
  "ENABLE_YOUTUBE_SOURCING",
  "YOUTUBE_API_KEY",
  "RAPIDAPI_KEY",
  "YOUTUBE_CC_DL_SERVICE",
  "YOUTUBE_CC_DL_TOKEN",
] as const;

const saved = new Map<string, string | undefined>();
const set = (name: string, value: string | undefined) => {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/** Nothing configured at all — the state a fresh deployment is in. */
function clearAll() {
  for (const v of VARS) set(v, undefined);
}

/* ═══════════════════════ the three requirements ═══════════════════════ */

describe("YouTube needs three things, and says which one is absent", () => {
  it("names all three when nothing is configured", () => {
    clearAll();
    const { ready, missing } = youtubeSourcingReadiness();
    expect(ready).toBe(false);
    expect(missing).toContain("ENABLE_YOUTUBE_SOURCING");
    expect(missing).toContain("YOUTUBE_API_KEY");
    expect(missing).toContain("RAPIDAPI_KEY|YOUTUBE_CC_DL_SERVICE");
  });

  /**
   * The configuration that produced render 562's silence: switched on, and unable to do anything.
   */
  it("the flag alone is not enough, and says exactly what is still missing", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    const { ready, missing } = youtubeSourcingReadiness();
    expect(ready, "the flag alone was treated as working YouTube sourcing").toBe(false);
    expect(missing).not.toContain("ENABLE_YOUTUBE_SOURCING");
    expect(missing).toEqual(["YOUTUBE_API_KEY", "RAPIDAPI_KEY|YOUTUBE_CC_DL_SERVICE"]);
  });

  /** Search without download: finds clips it cannot fetch. */
  it("a search key without a download route is still blocked", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "k");
    const { ready, missing } = youtubeSourcingReadiness();
    expect(ready, "YouTube serves no media files — a search key cannot download").toBe(false);
    expect(missing).toEqual(["RAPIDAPI_KEY|YOUTUBE_CC_DL_SERVICE"]);
  });

  /** Either download route satisfies the third requirement — they are alternatives. */
  it.each(["RAPIDAPI_KEY", "YOUTUBE_CC_DL_SERVICE"])("%s alone completes the set", (route) => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "k");
    set(route, route === "YOUTUBE_CC_DL_SERVICE" ? "https://dl.example" : "k");
    if (route === "YOUTUBE_CC_DL_SERVICE") set("YOUTUBE_CC_DL_TOKEN", "t");
    expect(youtubeSourcingReadiness().ready).toBe(true);
  });
});

/* ═══════════════════════ set, but shaped wrong ═══════════════════════ */

describe("a download route that will 401 on every request", () => {
  it("warns when the cloud service has no token", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "k");
    set("YOUTUBE_CC_DL_SERVICE", "https://dl.example");
    const { ready, warnings } = youtubeSourcingReadiness();
    /** Still ready — a token-less service is supported, so this must not block a render. */
    expect(ready).toBe(true);
    expect(warnings.join(" "), "a service that 401s on every call looked healthy").toContain(
      "YOUTUBE_CC_DL_TOKEN"
    );
    expect(formatYoutubeReadiness()).toContain("youtubeWarn=1");
  });

  it("is quiet once the token is there", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "k");
    set("YOUTUBE_CC_DL_SERVICE", "https://dl.example");
    set("YOUTUBE_CC_DL_TOKEN", "t");
    expect(youtubeSourcingReadiness().warnings).toEqual([]);
    expect(formatYoutubeReadiness()).toBe("youtube=ready");
  });

  /** The token belongs to the cloud service only — RapidAPI has nothing to do with it. */
  it("does not warn about a token the RapidAPI route never uses", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "k");
    set("RAPIDAPI_KEY", "k");
    expect(youtubeSourcingReadiness().warnings).toEqual([]);
  });

  it("the warning is a whole line the render can print", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "k");
    set("YOUTUBE_CC_DL_SERVICE", "https://dl.example");
    expect(youtubeReadinessWarnings()[0]).toContain("[YouTube] CONFIG_WARNING");
  });
});

/* ═══════════════════════ no key's value ever reaches a log ═══════════════════════ */

describe("names and presence only", () => {
  it("prints no value, from any of the five", () => {
    clearAll();
    set("ENABLE_YOUTUBE_SOURCING", "true");
    set("YOUTUBE_API_KEY", "SEARCH-SECRET-VALUE");
    set("YOUTUBE_CC_DL_SERVICE", "https://dl.internal.example");
    set("YOUTUBE_CC_DL_TOKEN", undefined);
    const printed = [formatYoutubeReadiness(), ...youtubeReadinessWarnings()].join(" ");
    expect(printed).not.toContain("SEARCH-SECRET-VALUE");
    expect(printed, "an internal hostname is a secret too").not.toContain("dl.internal.example");
  });
});

/* ═══════════════════════ the search says when it does not run ═══════════════════════ */

describe("a search that does not happen says so", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /**
   * `if (!youtubeApiKey) return []` was the whole branch. That is how a render can be configured
   * for YouTube, ask for it fifty times, and leave no evidence at all.
   */
  it("the missing-key branch logs instead of returning silently", () => {
    const at = PIPE.indexOf("export async function searchYoutubeVideoCandidates(");
    expect(at, "the search function has moved").toBeGreaterThan(-1);
    const head = PIPE.slice(at, at + 2500);
    expect(head, "the search still returns empty without a word").toContain("SEARCH_SKIPPED");
    expect(head).toContain("YOUTUBE_API_KEY not set");
  });

  /** Once per render, not once per query — fifty identical lines say nothing extra. */
  it("warns once, not per query", () => {
    expect(PIPE).toContain("let youtubeSearchKeyWarned = false;");
    const at = PIPE.indexOf("export async function searchYoutubeVideoCandidates(");
    const head = PIPE.slice(at, at + 2500);
    expect(head).toContain("if (!youtubeSearchKeyWarned)");
  });

  /** And the render prints the config warnings beside the route line. */
  it("the render surfaces a misconfigured download route", () => {
    expect(PIPE).toContain("for (const warning of youtubeReadinessWarnings())");
  });

  /**
   * THE EXIT THAT PROVED THE OTHERS WERE NEVER REACHED.
   *
   * `fetchYouTubeCCClips` already logged a reason for a missing key and for a missing download
   * route. Render 562's log carries NEITHER, which is exactly how we know the function stopped
   * before them — on `if (!youtubeSourcingEnabled()) return []`, which said nothing at all. The
   * whole YouTube branch was absent from that render with no line anywhere explaining it.
   *
   * So it was not that RapidAPI failed. It was never asked.
   */
  it("the disabled flag says so instead of returning silently", () => {
    const at = PIPE.indexOf("if (!youtubeSourcingEnabled()) {");
    expect(at, "the flag guard returns silently again").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 700);
    expect(block).toContain("SOURCING_DISABLED");
    expect(block).toContain("ENABLE_YOUTUBE_SOURCING is not true");
    expect(PIPE).toContain("let youtubeDisabledWarned = false;");
  });

  /** The quota cooldown was the other silent exit — it now names itself and the way out. */
  it("the quota cooldown names itself and the fallback that would avoid it", () => {
    const at = PIPE.indexOf("if (isYoutubeInCooldown() && !(youtubeRapidSearchFallbackEnabled()");
    expect(at, "the cooldown guard has moved").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 600);
    expect(block, "the cooldown exit is still silent").toContain("quota cooldown");
    expect(block).toContain("ENABLE_YOUTUBE_RAPID_SEARCH");
  });

  /**
   * Every exit from the YouTube branch now says why. Counted rather than listed, so a new silent
   * `return []` added later fails this instead of going unnoticed for another render.
   */
  it("no exit from fetchYouTubeCCClips is silent", () => {
    const at = PIPE.indexOf("export async function fetchYouTubeCCClips(");
    expect(at, "fetchYouTubeCCClips has moved").toBeGreaterThan(-1);
    const head = PIPE.slice(at, PIPE.indexOf("const queryList", at));
    const returns = [...head.matchAll(/return \[\];/g)];
    const logs = [...head.matchAll(/console\.warn\(/g)];
    expect(returns.length, "there are no guards left to check").toBeGreaterThanOrEqual(4);
    expect(
      logs.length,
      "an exit from the YouTube branch returns without saying why — that is how render 562 " +
        "skipped YouTube entirely with no line in the log"
    ).toBe(returns.length);
  });
});
