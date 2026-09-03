/**
 * THE STARTUP BANNER MAY NOT STATE A FACT IT NEVER CHECKED.
 *
 * ── The line, and what it cost ──────────────────────────────────────────────────────────────
 *
 * For its whole life this was a literal:
 *
 *     console.log("[Fastvid] YouTube clip sourcing: disabled");
 *
 * No environment read, no branch. Every boot printed `disabled`, whatever ENABLE_YOUTUBE_SOURCING
 * was set to — so the log asserted the exact opposite of the truth for any deployment that had
 * turned YouTube on.
 *
 * It produced a wrong diagnosis in this repository. Asked why YouTube contributed nothing to a
 * production render, this line was read as the answer: the flag is off. It was not. The same
 * render's log carries seventeen live YouTube searches and seventeen download attempts, and every
 * YouTube call site — `maxEntityYoutubeFetchesPerVideo` returns 0, `fetchBeatYoutubeOnly` returns
 * null, the pool skips the provider — is gated on `youtubeSourcingEnabled()`. A render with the
 * flag off cannot search YouTube seventeen times. The flag was on; the banner could not say so,
 * and an hour went into the wrong explanation.
 *
 * ── What this file pins ─────────────────────────────────────────────────────────────────────
 *
 * That the line is computed. A status line whose value is a constant is worse than no line at all:
 * it is not silence, it is a false statement that gets believed precisely because it is specific.
 *
 * The same rule is asserted for the sibling key lines, which were already computed and stay that
 * way — this is a property of the banner, not of one string that happened to be wrong.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatYoutubeReadiness, youtubeSourcingEnabled } from "./sourcingPolicy";

const banner = () => fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the YouTube banner reports the flag", () => {
  /** The exact defect, by its exact shape. */
  it("is not a hardcoded verdict", () => {
    expect(
      banner(),
      "the banner states YouTube's status without reading it"
    ).not.toContain('console.log("[Fastvid] YouTube clip sourcing: disabled")');
  });

  it("reads the flag that actually gates every YouTube call site", () => {
    const src = banner();
    const at = src.indexOf('"[Fastvid] YouTube clip sourcing:"');
    expect(at, "the YouTube status line is gone").toBeGreaterThan(-1);
    const line = src.slice(at, at + 400);
    expect(line).toContain("youtubeSourcingEnabled()");
    // Both verdicts must exist, or it is a constant with extra steps.
    expect(line).toContain('"enabled"');
    expect(line).toContain("disabled (ENABLE_YOUTUBE_SOURCING is not true)");
  });

  /**
   * The flag alone was never the whole story — YouTube needs a search key and a download route
   * besides — so the line carries the readiness summary that names what is missing.
   */
  it("says what is missing, not merely that something is", () => {
    const src = banner();
    const at = src.indexOf('"[Fastvid] YouTube clip sourcing:"');
    expect(src.slice(at, at + 400)).toContain("formatYoutubeReadiness()");
    expect(src).toContain("youtubeReadinessWarnings()");
  });

  /** And it is genuinely computed — the same input produces the two different answers. */
  it("changes its answer when the flag changes", () => {
    vi.stubEnv("ENABLE_YOUTUBE_SOURCING", "true");
    expect(youtubeSourcingEnabled()).toBe(true);
    const on = formatYoutubeReadiness();
    vi.stubEnv("ENABLE_YOUTUBE_SOURCING", "false");
    expect(youtubeSourcingEnabled()).toBe(false);
    expect(formatYoutubeReadiness()).not.toBe(on);
    expect(formatYoutubeReadiness()).toContain("ENABLE_YOUTUBE_SOURCING");
  });

  /** Never a key's value, in either state. */
  it("prints names and presence, never a secret", () => {
    for (const flag of ["true", "false"]) {
      vi.stubEnv("ENABLE_YOUTUBE_SOURCING", flag);
      vi.stubEnv("YOUTUBE_API_KEY", "super-secret-value");
      vi.stubEnv("RAPIDAPI_KEY", "another-secret-value");
      expect(formatYoutubeReadiness()).not.toContain("super-secret-value");
      expect(formatYoutubeReadiness()).not.toContain("another-secret-value");
    }
  });
});

describe("the sibling key lines were already computed and stay that way", () => {
  it("each reports presence from the environment", () => {
    const src = banner();
    for (const key of ["RAPIDAPI_KEY", "YOUTUBE_API_KEY"]) {
      const at = src.indexOf(`"[Fastvid] ${key}:"`);
      expect(at, `${key} is no longer reported`).toBeGreaterThan(-1);
      const line = src.slice(at, at + 200);
      expect(line, `${key} is stated rather than checked`).toMatch(/ytDownload|ytSearch/);
      expect(line).toContain("✓ set");
    }
  });
});
