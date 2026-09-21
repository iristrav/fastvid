/**
 * RONDE 260 — THE ROUTES DRANK IN TURN, AND THE ONE THAT WORKED ARRIVED TO AN EMPTY GLASS.
 *
 * ── What render 586 measured, with the previous round's fix deployed ────────────────────────
 *
 *     eigen yt-dlp service   8 real attempts   0 succeeded   6 cut off mid-transfer, 2× http_502
 *     RapidAPI fallback      2 real attempts   2 succeeded
 *
 *     NM3YUyKJywg   7.3 MB   16:47:51.888 → 16:47:53.291   1.4 s
 *     Go-Whu1eSOU   6.3 MB   16:48:46.026 → 16:48:50.173   4.1 s
 *
 * A WORKING YOUTUBE TRANSFER TAKES BETWEEN ONE AND FOUR SECONDS. The floor that refused
 * ninety-four of them is twelve seconds and the ceiling above it is a hundred and eighty, so the
 * transfer's own clock was never the constraint and RONDE 259 was looking at the wrong number.
 *
 * ── The two things that were actually wrong ─────────────────────────────────────────────────
 *
 * §1  There were no SHARES. The cloud route asked for everything the scope had left, and the
 *     fallback took `scopedTimeoutMs` of whatever survived that. The first route is the broken
 *     one, so the working one kept finding nothing left: both successes happened only because the
 *     service answered 502 quickly enough to leave a few seconds behind.
 *
 * §2  The question "is there time to finish this?" was asked at the TILL. Fifty times the pipeline
 *     found a video, opened a lineage record, claimed a download slot, wrote DOWNLOAD_STARTED,
 *     looked at the clock and stopped. The whole ceremony of a download, with the network never
 *     touched. Asked at the DOOR — before the first query — the answer is usually yes, because a
 *     beat opens with a full slice.
 *
 * §3  And `0s left in the scene budget`, ninety-four times, never said WHOSE budget. Five clocks
 *     nest here and three scenes run at once. RONDE 259 could prove its reserve did not hold and
 *     could not prove where it leaked; that cost a round.
 *
 * NO BUDGET MOVES. §4 pins every number. The floor stays 12s, the ceiling stays 180s, the beat and
 * scene windows are untouched — the change is that YouTube hands out shares instead of letting its
 * routes drink in order, and asks its one existing question early enough for the answer to differ.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  affordsYoutubeTurn,
YOUTUBE_DOWNLOAD_ROUTES,
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_SEARCH_TIMEOUT_MS,
  describeEnclosingScope,
  withSceneFetchTimeout,
  youtubeRouteShareMs,
} from "./videoPipeline";
import { callSitesOf, stripComments } from "./sourceScan.test.support";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CODE = stripComments(PIPE);

/* ═══════════ 1. a share, not a turn at the glass ═══════════ */

describe("R260 §1 — YouTube hands out shares", () => {
  it("one route may take half of what is left, so the other half survives it", () => {
    expect(YOUTUBE_DOWNLOAD_ROUTES).toBe(2);
    expect(youtubeRouteShareMs(45_000)).toBe(22_500);
    expect(youtubeRouteShareMs(60_000)).toBe(30_000);
  });

  it("A SHARE IS A CEILING, NOT A SPEND: the divisor is the number of routes", () => {
    /**
     * A divisor that drifts from the number of routes stops being a share without saying so, so
     * the two are one constant. Three routes would each get a third by construction.
     */
    const src = CODE.slice(
      CODE.indexOf("export function youtubeRouteShareMs("),
      CODE.indexOf("export const YOUTUBE_SEARCH_TIMEOUT_MS")
    );
    expect(src).toContain("Math.floor(totalMs / YOUTUBE_DOWNLOAD_ROUTES)");
    expect(src, "a literal 2 would drift away from the route count silently").not.toMatch(
      /totalMs \/ 2\b/
    );
  });

  it("nothing to divide divides to nothing", () => {
    expect(youtubeRouteShareMs(0)).toBe(0);
    expect(youtubeRouteShareMs(-1_000)).toBe(0);
    expect(youtubeRouteShareMs(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("THE CLOUD ROUTE IS CAPPED BY ITS SHARE — this is the line render 586 needed", () => {
    expect(CODE).toContain(
      "const cloudWindowMs = Math.max(\n      YOUTUBE_MIN_DOWNLOAD_WINDOW_MS,\n      youtubeRouteShareMs(remainingForCloud)\n    );"
    );
    expect(CODE, "the cloud call still asks for everything the scope has").toContain(
      "Math.min(youtubeDownloadTimeoutMs(budgetMs), cloudWindowMs)"
    );
  });

  it("but never below the floor — a share smaller than a transfer is a refusal in disguise", () => {
    /**
     * With one floor's worth left there is only room for one attempt, and halving it would leave
     * two attempts that each cannot finish. The floor wins there, which is today's behaviour.
     */
    const at = CODE.indexOf("const cloudWindowMs =");
    expect(at).toBeGreaterThan(-1);
    expect(CODE.slice(at, at + 200)).toContain("Math.max(");
    expect(CODE.slice(at, at + 200)).toContain("YOUTUBE_MIN_DOWNLOAD_WINDOW_MS");
  });

  it("the fallback still takes what is genuinely left, so an early finish is given back", () => {
    expect(CODE, "the RapidAPI leg stopped sizing itself against the scope").toContain(
      "scopedTimeoutMs(youtubeDownloadTimeoutMs(), 5_000)"
    );
  });
});

/* ═══════════ 2. the door, not the till ═══════════ */

describe("R260 §2 — a turn is declined before it is performed", () => {
  it("a turn costs one search plus one transfer, both numbers that already existed", () => {
    expect(YOUTUBE_SEARCH_TIMEOUT_MS).toBe(12_000);
    expect(YOUTUBE_MIN_TURN_MS).toBe(24_000);
    expect(CODE).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
  });

  it("and the search timeout is the one the search actually uses, not a second copy", () => {
    expect(CODE, "the fetch kept its own literal, free to drift from the door's price").toContain(
      "YOUTUBE_SEARCH_TIMEOUT_MS,\n      `YouTube RapidAPI search scene ${sceneIndex}`"
    );
  });

  it("THE CHECK STANDS BEFORE THE FIRST QUERY, WHICH IS THE WHOLE POINT", () => {
    const fn = CODE.slice(
      CODE.indexOf("export async function fetchYouTubeCCClips("),
      CODE.indexOf("export async function fetchYouTubeCCClips(") + 20_000
    );
    /**
     * RONDE 604 — the same guard, now inside `canAffordYoutubeTurn` so the door, the reserve and
     * the two beat walls cannot drift apart again. RONDE 600 repaired three of those five readers
     * and render 597 still searched once, because the two it missed were enough to keep the source
     * shut. The PRICE is untouched: `YOUTUBE_MIN_TURN_MS`, one search plus the download floor.
     */
    const door = fn.indexOf("if (!canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS)) {");
    expect(door, "no door check").toBeGreaterThan(-1);
    const firstSearch = fn.indexOf("uniqueQueryStrings(");
    expect(firstSearch).toBeGreaterThan(-1);
    expect(door, "the queries are built before anyone asks if there is time").toBeLessThan(
      firstSearch
    );
  });

  it("it is loud, because a source that declines silently is the bug we keep finding", () => {
    expect(CODE).toContain("[YouTube] TURN_DECLINED scene=");
  });

  it("outside a scope nothing is declined — the prefetch case is untouched", () => {
    expect(CODE).toContain("const turnMs = remainingScopeMs();");
    /**
     * RONDE 604 — asserted by BEHAVIOUR rather than by text now, which is the stronger claim and
     * the one this test was always making: a budget of Infinity is no enclosing clock, not a short
     * one, and reading it as a number would switch YouTube off in exactly the case that has no
     * deadline to protect.
     */
    expect(
      affordsYoutubeTurn(Number.POSITIVE_INFINITY, YOUTUBE_MIN_TURN_MS),
      "an Infinity budget would fail a numeric comparison and switch YouTube off entirely"
    ).toBe(true);
    const fn = CODE.slice(CODE.indexOf("export function affordsYoutubeTurn("));
    expect(fn).toContain("if (!Number.isFinite(windowMs)) return true;");
  });

  it("THE TILL IS STILL THERE — the door does not replace the floor, it precedes it", () => {
    expect(CODE, "RONDE 68's guard was removed in favour of the new one").toContain(
      "if (remainingForCloud < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {"
    );
    expect(CODE).toContain("if (remainingMs < YOUTUBE_MIN_DOWNLOAD_WINDOW_MS) {");
  });
});

/* ═══════════ 3. which clock ═══════════ */

describe("R260 §3 — a refusal names the clock that refused", () => {
  it("the scope carries its own label and the window it was granted", async () => {
    let seen = "";
    await withSceneFetchTimeout(
      async () => {
        seen = describeEnclosingScope();
      },
      45_000,
      "youtube-first s0 b1"
    );
    expect(seen).toContain('clock="youtube-first s0 b1"');
    expect(seen).toMatch(/granted=4[45]s/);
    expect(seen).toMatch(/used=\ds/);
    /** `transferReserveFor(45_000)` is half of 45s — the half-rule binds before the 24s cap. */
    expect(seen).toMatch(/transferReserve=2[23]s/);
  });

  it("a nested clock reports ITSELF, because it is the one that refused", async () => {
    let inner = "";
    await withSceneFetchTimeout(
      async () => {
        await withSceneFetchTimeout(
          async () => {
            inner = describeEnclosingScope();
          },
          90_000,
          "the child"
        );
      },
      40_000,
      "the parent"
    );
    expect(inner).toContain('clock="the child"');
    expect(inner, "a child reported its parent's grant, which is the confusion this removes").toMatch(
      /granted=(39|40)s/
    );
  });

  it("and outside a scope it says so rather than inventing one", () => {
    expect(describeEnclosingScope()).toBe("no enclosing scope");
  });

  it("EVERY LINE THAT REPORTS RUNNING OUT NOW NAMES ITS CLOCK", () => {
    /**
     * The four that mattered in render 586: two download refusals and two search refusals. The
     * phrase they all used — "in the scene budget" — named a clock that was usually not the one
     * that had run out.
     */
    for (const anchor of [
      "not calling the yt-dlp cloud service for",
      "skipping YouTube download of",
      "scene budget already spent",
      "what is left of this scope is the transfer reserve",
    ]) {
      const at = CODE.indexOf(anchor);
      expect(at, `${anchor} is gone`).toBeGreaterThan(-1);
      expect(
        CODE.slice(at, at + 900),
        `${anchor} still reports a clock it cannot name`
      ).toContain("describeEnclosingScope()");
    }
  });

  it("the label reaches the scope from the caller, not from a second source of truth", () => {
    const fn = CODE.slice(
      CODE.indexOf("export function withSceneFetchTimeout<T>("),
      CODE.indexOf("function assertPipelineWithinBudget(")
    );
    expect(fn).toContain("label,");
    expect(fn).toContain("grantedMs: deadlineAtMs - openedAtMs,");
    expect(fn).toContain("openedAtMs,");
  });
});

/* ═══════════ 4. nothing was raised, lowered or loosened ═══════════ */

describe("R260 §4 — the numbers, all of them, unchanged", () => {
  it("the download floor and the transfer ceiling stand", async () => {
    expect(CODE).toContain("const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS = 12_000;");
    const policy = await import("./sourcingPolicy");
    expect(policy.youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(policy.YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS).toBe(8_000);
  });

  it("the beat and scene windows stand", () => {
    const budget = fs.readFileSync(path.join(__dirname, "renderBudget.ts"), "utf8");
    expect(budget).toContain("BEAT_SEARCH_MIN_MS   =  10_000;");
    expect(budget).toContain("BEAT_SEARCH_MAX_MS   =  40_000;");
    const scene = fs.readFileSync(path.join(__dirname, "sceneSearchBudget.ts"), "utf8");
    expect(scene).toContain("export const SCENE_SEARCH_MIN_MS = 60_000;");
    expect(scene).toContain("export const SCENE_SEARCH_MAX_FACTOR = 2.5;");
  });

  it("the YouTube beat budget stands", () => {
    const policy = fs.readFileSync(path.join(__dirname, "sourcingPolicy.ts"), "utf8");
    expect(policy).toContain("isFastShortVideoLength(videoLength) ? 30_000 : 45_000");
  });

  it("and RONDE 259's reserve is still computed the way it was", () => {
    expect(CODE).toContain("export const TRANSFER_RESERVE_MS = YOUTUBE_MIN_DOWNLOAD_WINDOW_MS * 2;");
    expect(CODE).toContain("return Math.min(TRANSFER_RESERVE_MS, Math.floor(windowMs / 2));");
  });

  it("THE ORDER OF THE TWO ROUTES IS UNCHANGED — this round did not bet on today's measurement", () => {
    /**
     * Two successes out of two is not a reason to promote a route; the share holds whichever of
     * the two turns out to be broken next. The cloud branch still stands first.
     */
    const fn = CODE.slice(
      CODE.indexOf("async function downloadYouTubeCCClip("),
      CODE.indexOf("export async function fetchYouTubeCCClips(")
    );
    const cloud = fn.indexOf("if (cloudDlService && !egressBlocked) {");
    const rapid = fn.indexOf("scopedTimeoutMs(youtubeDownloadTimeoutMs(), 5_000)");
    expect(cloud).toBeGreaterThan(-1);
    expect(rapid).toBeGreaterThan(-1);
    expect(cloud, "the routes were reordered").toBeLessThan(rapid);
  });

  it("and the download still funnels through the one function it always did", () => {
    expect(callSitesOf(CODE, "downloadYouTubeCCClip")).toHaveLength(2);
  });
});
