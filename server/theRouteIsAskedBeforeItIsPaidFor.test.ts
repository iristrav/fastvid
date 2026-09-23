/**
 * THE ROUTE IS ASKED BEFORE IT IS PAID FOR — RONDE 638.
 *
 * ── What learning it the slow way costs ─────────────────────────────────────────────────────
 *
 * The egress latch skips a dead cloud route for free. Something has to CLOSE it, and until now
 * the only thing that could was a download that had already spent its whole window timing out.
 * The latch resets every render — deliberately, because one that outlived its render would turn a
 * bad hour into a permanent outage — so every render paid that discovery once. Render 599, one
 * scene:
 *
 *     Cloud DL failed z2kp1wkRE8o: … exceeded 117s — falling back to RapidAPI
 *     Cloud DL failed FLal-KvTNAQ: … exceeded 117s — falling back to RapidAPI
 *     Cloud DL failed aZbpVsQzBeU: … exceeded  84s — falling back to RapidAPI
 *     Cloud DL failed 7bx_yqMF3jc: … exceeded  54s — falling back to RapidAPI
 *
 * "The scene's wall was 276s and it used 280s, so five later YouTube candidates were refused
 * before they started, under the 12s floor."
 *
 * ── The answer already existed, in the wrong place ──────────────────────────────────────────
 *
 * RONDE 258 built `egressRefusalReason` against the service's own `/health/egress`, and wired it
 * to the TIMEOUT path: "Asked only on a timeout, only while the latch is open." That is after the
 * cost it exists to avoid. The same signature defect as the rest of this sequence — the answer is
 * computed, published, and not fetched at the moment a decision depends on it.
 *
 * ── A SOURCE of evidence, not a way around the threshold ────────────────────────────────────
 *
 * The latch needs THREE consecutive refusals, and that rule has a good reason: a residential proxy
 * rotates the address, so one refusal is about one IP out of ninety million — render 582 is what
 * closing after the first one cost. Three still means three. What changes is that a strike can now
 * cost a millisecond instead of two minutes.
 *
 * Asked no more often than the probe's own cache TTL, because the probe caches its answer and
 * counting one measurement three times would be a flattered metric rather than evidence. That gap
 * also bounds the one cost the probe can impose: a FAILURE to answer is deliberately not cached,
 * so an unreachable probe spends its 3s ceiling — once per 30s window, against a 117s download.
 *
 * ── What is NOT changed ─────────────────────────────────────────────────────────────────────
 *
 * The route is not removed and not reordered. This codebase has argued twice against "try the
 * fast route first, or latch this one shut", and render 582 is the cost of having done it:
 * RapidAPI fetches the WHOLE source before trimming, so the cloud route is the only one that
 * fetches just the seconds a beat needs. It stays. It is simply not paid for before it is asked.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  claimCloudEgressPreflight,
  noteCloudEgressBlocked,
  cloudEgressRefusal,
  resetCloudEgressBlocked,
} from "./providerFailureClass";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const PROBE = readFileSync(join(__dirname, "youtubeEgressProbe.ts"), "utf8");
const CLASS = readFileSync(join(__dirname, "providerFailureClass.ts"), "utf8");

beforeEach(() => resetCloudEgressBlocked());

/* ═══════════ §1 — a fresh measurement, not one answer read three times ═══════════ */

describe("§1 — the preflight is gated on the probe's own cache window", () => {
  it("A SECOND ASK INSIDE THE WINDOW IS REFUSED", () => {
    const t0 = 1_000_000;
    expect(claimCloudEgressPreflight(30_000, t0)).toBe(true);
    expect(claimCloudEgressPreflight(30_000, t0 + 1)).toBe(false);
    expect(claimCloudEgressPreflight(30_000, t0 + 29_999)).toBe(false);
  });

  it("and past the window it is a fresh request, so it counts", () => {
    const t0 = 1_000_000;
    expect(claimCloudEgressPreflight(30_000, t0)).toBe(true);
    expect(claimCloudEgressPreflight(30_000, t0 + 30_000)).toBe(true);
    expect(claimCloudEgressPreflight(30_000, t0 + 60_000)).toBe(true);
  });

  it("a new render may ask immediately, because the latch resets with it", () => {
    const t0 = 1_000_000;
    expect(claimCloudEgressPreflight(30_000, t0)).toBe(true);
    expect(claimCloudEgressPreflight(30_000, t0 + 1)).toBe(false);
    resetCloudEgressBlocked();
    expect(claimCloudEgressPreflight(30_000, t0 + 2)).toBe(true);
  });

  it("the reset clears the latch and the gate together, never one without the other", () => {
    noteCloudEgressBlocked("v1", "bot_check");
    noteCloudEgressBlocked("v2", "bot_check");
    noteCloudEgressBlocked("v3", "bot_check");
    claimCloudEgressPreflight(30_000, 1_000_000);
    expect(cloudEgressRefusal()).not.toBeNull();
    resetCloudEgressBlocked();
    expect(cloudEgressRefusal()).toBeNull();
    expect(claimCloudEgressPreflight(30_000, 1_000_001)).toBe(true);
  });
});

/* ═══════════ §1b — THE THRESHOLD IS NOT LOWERED ═══════════ */

describe("§1b — three still means three", () => {
  /**
   * The streak rule exists because a residential proxy ROTATES the address: one refusal is about
   * one IP out of ninety million, and render 582 is what closing after the first one cost. The
   * preflight is a cheaper SOURCE of evidence, never a way around the bar.
   */
  it("ONE PREFLIGHT ANSWER DOES NOT CLOSE THE LATCH", () => {
    expect(noteCloudEgressBlocked("v1", "bot_check")).toBe(false);
    expect(cloudEgressRefusal()).toBeNull();
  });

  it("two do not either", () => {
    noteCloudEgressBlocked("v1", "bot_check");
    expect(noteCloudEgressBlocked("v2", "bot_check")).toBe(false);
    expect(cloudEgressRefusal()).toBeNull();
  });

  it("and the third closes it, exactly as a third failed download would have", () => {
    noteCloudEgressBlocked("v1", "bot_check");
    noteCloudEgressBlocked("v2", "bot_check");
    expect(noteCloudEgressBlocked("v3", "bot_check")).toBe(true);
    expect(cloudEgressRefusal()?.reason).toBe("bot_check");
  });

  it("the threshold itself is untouched", () => {
    expect(CLASS).toContain("return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 3;");
    expect(CLASS).toContain("CONSECUTIVE is the whole of it: any success resets the count");
  });
});

/* ═══════════ §2 — the wiring: asked before the window, not after ═══════════ */

describe("§2 — the probe runs ahead of the call it protects", () => {
  it("THE PREFLIGHT SITS BEFORE THE LATCH READ, WHICH SITS BEFORE THE BUDGET CHECK", () => {
    const preflight = PIPE.indexOf("claimCloudEgressPreflight(YOUTUBE_EGRESS_CACHE_MS)");
    const latch = PIPE.indexOf("const egressBlocked = cloudEgressRefusal();");
    const budget = PIPE.indexOf("if (remainingForCloud < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
    expect(preflight).toBeGreaterThan(-1);
    expect(latch).toBeGreaterThan(preflight);
    expect(budget).toBeGreaterThan(latch);
  });

  it("it only asks while the latch is still open", () => {
    expect(PIPE).toContain("!cloudEgressRefusal() &&");
    expect(PIPE).toContain("claimCloudEgressPreflight(YOUTUBE_EGRESS_CACHE_MS)");
  });

  it("A BLOCKED ANSWER COUNTS AS A REFUSAL, WITHOUT A WINDOW BEING SPENT", () => {
    const at = PIPE.indexOf("const preflightBlocked = await egressRefusalReason()");
    expect(at).toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 700);
    expect(block).toContain("noteCloudEgressBlocked(videoId, preflightBlocked)");
    expect(block).toContain("learned without spending a download window");
  });

  it("a probe that cannot be asked changes nothing", () => {
    expect(PIPE).toContain("await egressRefusalReason().catch(() => null);");
    /* Only a truthy reason arms the latch — null falls straight through to the route. */
    expect(PIPE).toContain("if (preflightBlocked) {");
  });

  it("and the after-timeout path is still there, as the second chance it always was", () => {
    expect(PIPE).toContain('if (thrownAs === "DOWNLOAD_TIMEOUT" && !cloudEgressRefusal()) {');
  });
});

/* ═══════════ §3 — the route is not removed and not reordered ═══════════ */

describe("§3 — the trade this file has refused twice is still refused", () => {
  it("THE CLOUD ROUTE IS STILL TRIED, AND STILL FIRST", () => {
    const cloud = PIPE.indexOf("const cloudTmpPath = outPath.replace");
    const rapid = PIPE.indexOf('const tmpPath = outPath.replace(/\\.mp4$/, "_rapid_tmp.mp4");');
    expect(cloud).toBeGreaterThan(-1);
    expect(rapid).toBeGreaterThan(cloud);
  });

  it("and the reason it is kept is recorded where the ordering lives", () => {
    expect(PIPE).toContain("fetches the WHOLE source before trimming");
    expect(PIPE).toContain('Deliberately NOT "try the fast one first"');
  });

  it("the cloud route still asks for only the seconds the beat needs", () => {
    expect(PIPE).toContain("/download?id=${videoId}&duration=${duration}&start=${clipStart}");
  });

  it("nothing about the probe's own ceilings moved", () => {
    expect(PROBE).toContain("export const YOUTUBE_EGRESS_PROBE_TIMEOUT_MS = 3_000;");
    expect(PROBE).toContain("export const YOUTUBE_EGRESS_CACHE_MS = 30_000;");
  });

  it("and a failure to ask is still not cached, which is why this asks only once", () => {
    expect(PROBE).toContain("A FAILURE TO ASK IS NOT CACHED");
  });
});
