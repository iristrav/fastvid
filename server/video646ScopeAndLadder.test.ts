/**
 * VIDEO 646 — 2,086 SCOPE_EXPIRED LINES AND TWO TIER_OUT_OF_ORDER REFUSALS, ONE CAUSE EACH.
 *
 * ── E ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *     [SceneFetchScope] SCOPE_EXPIRED label="luma scene_2_…_t5769d40_…_transformed.mp4@0.35:left"
 *       — opened 111s after the enclosing budget had already ended …   (×36 per clip)
 *
 * RONDE 263 refuses a scope that opens after its parent's deadline — correctly, and one warning per
 * refusal. The black-bar probes of the fair-use transform open one scope per ffmpeg binary (4), per
 * region (3), per sample time (3): thirty-six refused scopes per clip, each tried after the previous
 * refusal, inside a scene whose clock had run out up to 111 s earlier. 489 of the 500 sampled
 * SCOPE_EXPIRED lines of render 646 were these probes. Nothing ran; everything was logged.
 *
 * The caller now asks the same question ONCE (`enclosingScopeHasEnded`) before the batch, says so
 * on one line, and a probe refused for the budget does not try the next ffmpeg binary. A scope with
 * time left is untouched to the millisecond; two scenes' scopes never see each other.
 *
 * ── F ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *     20:56:32.330  SCOPE_EXPIRED label="archive s0 b2" — opened 0s after …
 *     20:56:32.330  [ArchiveFirst] s0b2 ARCHIVE_GAP (no match) — asking suppliers …
 *     20:56:34.105  [CentralSourcing] s0b2 TIER_OUT_OF_ORDER provider=serpapi tier=4 skipped=2:OWN_ARCHIVE
 *     20:56:36.919  … ladder 1=ATTEMPTED 2=NOT_REACHED 3=DECLINED(ALREADY_ASKED_THIS_RENDER) 4=NOT_REACHED
 *
 * The own-archive lookup runs inside a scope; refused for the budget it never ran, and tier 2 — which
 * marks itself attempted INSIDE that lookup — was never recorded. "No match" was printed about an
 * archive nobody asked, and the order check (right) refused stock for skipping it. The ladder is
 * now told, in its own vocabulary, that tier 2 was DECLINED because the budget had ended; the order
 * check, the budgets and the lookup are unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  enclosingScopeHasEnded,
  hasEmbeddedBlackBars,
  isScopeAbortError,
  remainingScopeMs,
  withSceneFetchTimeout,
} from "./videoPipeline";
import {
  admitProviderForTier,
  declineTier,
  forgetRenderSourcing,
  noteTierAttempted,
  runCentralVisualSourcing,
} from "./centralVisualSourcing";
import { tierMayRun } from "./sourcingTiers";
import { stripComments } from "./sourceScan.test.support";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CODE = stripComments(PIPELINE);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Render 587's shape (see aScopeThatOpensAfterItsDeadline.test.ts): a parent that is alive by its own
 * timer and past its clamped deadline. `body` runs inside that parent once the budget has ended.
 */
async function insideAnEndedBudget<T>(body: () => Promise<T>): Promise<T> {
  let result!: Promise<T>;
  let armed!: () => void;
  const ready = new Promise<void>((r) => (armed = r));
  void withSceneFetchTimeout(
    () =>
      withSceneFetchTimeout(
        async () => {
          await sleep(60);
          result = body();
          armed();
          await result.catch(() => {});
        },
        600_000,
        "parent"
      ),
    30,
    "grandparent"
  ).catch(() => {});
  await ready;
  return result;
}

describe("VIDEO 646 E — optional work inside an ended budget is not started, and says so once", () => {
  afterEach(() => vi.restoreAllMocks());

  it("outside any scope the budget has not ended", () => {
    expect(enclosingScopeHasEnded()).toBe(false);
    expect(remainingScopeMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it("inside a live scope the budget has not ended", async () => {
    const seen = await withSceneFetchTimeout(async () => enclosingScopeHasEnded(), 5_000, "live");
    expect(seen).toBe(false);
  });

  it("inside a scope whose deadline has passed the budget has ended", async () => {
    const seen = await insideAnEndedBudget(async () => enclosingScopeHasEnded());
    expect(seen).toBe(true);
  });

  it("the black-bar probes inside an ended budget: one PROBES_SKIPPED line, zero SCOPE_EXPIRED, nothing started", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answer = await insideAnEndedBudget(() => hasEmbeddedBlackBars("/nonexistent/scene_2_clip__pid_youtube_cc-acc0dfc922f30224_transformed.mp4"));
    expect(answer).toBe(false);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("PROBES_SKIPPED"))).toHaveLength(1);
    expect(lines[0]).toContain('label="luma scene_2_clip__pid_youtube_cc-acc0dfc922f30224_transformed.mp4"');
    expect(lines.filter((l) => l.includes("SCOPE_EXPIRED"))).toHaveLength(0);
  });

  it("inside a live scope the probes run as before (and a missing file is simply not black-barred)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answer = await withSceneFetchTimeout(() => hasEmbeddedBlackBars("/nonexistent/clip.mp4"), 20_000, "live scene");
    expect(answer).toBe(false);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("PROBES_SKIPPED"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("SCOPE_EXPIRED"))).toHaveLength(0);
  }, 30_000);

  it("outside any scope the probes run as before", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await hasEmbeddedBlackBars("/nonexistent/clip.mp4")).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("PROBES_SKIPPED"))).toHaveLength(0);
  }, 30_000);

  it("two scenes' scopes do not see each other: one ended, the other keeps its time", async () => {
    const other = withSceneFetchTimeout(async () => {
      await sleep(120);
      return { ended: enclosingScopeHasEnded(), left: remainingScopeMs() };
    }, 5_000, "scene 1");
    const ended = await insideAnEndedBudget(async () => enclosingScopeHasEnded());
    const o = await other;
    expect(ended).toBe(true);
    expect(o.ended).toBe(false);
    expect(o.left).toBeGreaterThan(4_000);
  });

  it("a running probe started while the scope was live is left to finish; only NEW scopes are refused", async () => {
    /**
     * The guard is asked on entry. Work that already runs inside a scope is governed by that scope's
     * own abort (RONDE 52), which this round does not touch: a body started with time left completes.
     */
    const out = await withSceneFetchTimeout(async () => {
      const startedLive = !enclosingScopeHasEnded();
      await sleep(80);
      return { startedLive, endedNow: enclosingScopeHasEnded(), stillAnswered: true };
    }, 50 + 600_000, "scene with time");
    expect(out).toEqual({ startedLive: true, endedNow: false, stillAnswered: true });
  });

  it("a refused scope still carries the scope-abort flag, so a probe stops at the first refusal instead of trying the next binary", async () => {
    const err = await insideAnEndedBudget(() => withSceneFetchTimeout(async () => "ran", 10_000, "luma x@0.35:left")).catch((e) => e);
    expect(isScopeAbortError(err)).toBe(true);
    const probe = CODE.slice(CODE.indexOf("async function probeClipRegionMeanLuma("), CODE.indexOf("export async function hasEmbeddedBlackBars("));
    expect(probe).toContain("if (enclosingScopeHasEnded()) return null;");
    expect(probe).toContain("if (isScopeAbortError(err)) return null;");
    const mean = CODE.slice(CODE.indexOf("async function probeClipMeanLuma("), CODE.indexOf("async function probeClipRegionMeanLuma("));
    expect(mean).toContain("if (enclosingScopeHasEnded()) return null;");
    expect(mean).toContain("if (isScopeAbortError(err)) return null;");
  });

  it("the RONDE 263 guard itself is untouched: a scope past its parent's deadline is still refused", () => {
    expect(CODE).toContain("if (deadlineAtMs <= openedAtMs) {");
    expect(CODE).toContain("return Promise.reject(scopeExpiredError(label, overrunMs));");
    /** And no timeout was raised to make the noise go away. */
    expect(CODE.slice(CODE.indexOf("async function probeClipMeanLuma("), CODE.indexOf("export async function hasEmbeddedBlackBars(")).match(/10_000/g)).toHaveLength(2);
  });
});

describe("VIDEO 646 F — a tier the budget made unavailable is DECLINED, not left NOT_REACHED", () => {
  afterEach(() => forgetRenderSourcing("r646"));

  const beat = <T>(run: () => T) =>
    runCentralVisualSourcing({ renderId: "r646", sceneIndex: 0, beatIndex: 2 }, async () => run());

  it("render 646's shape: YouTube attempted, archive never asked, open sources declined — stock is refused for skipping tier 2", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const verdict = await beat(() => {
        noteTierAttempted("YOUTUBE", "youtube_first_turn");
        declineTier("OPEN_SOURCES", "ALREADY_ASKED_THIS_RENDER");
        return admitProviderForTier("serpapi");
      });
      expect(verdict).toMatchObject({ admitted: false, reason: "TIER_OUT_OF_ORDER", skipped: ["OWN_ARCHIVE"] });
    } finally {
      log.mockRestore();
    }
  });

  it("the fix: the archive that could not be asked is declined with its reason, and the ladder goes on in order", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const verdict = await beat(() => {
        noteTierAttempted("YOUTUBE", "youtube_first_turn");
        declineTier("OWN_ARCHIVE", "BUDGET_ENDED_BEFORE_ASKED");
        declineTier("OPEN_SOURCES", "ALREADY_ASKED_THIS_RENDER");
        return admitProviderForTier("serpapi");
      });
      expect(verdict).toEqual({ admitted: true });
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("TIER_DECLINED tier=2:OWN_ARCHIVE reason=BUDGET_ENDED_BEFORE_ASKED"))).toBe(true);
      expect(lines.some((l) => l.includes("TIER_OUT_OF_ORDER"))).toBe(false);
      expect(lines.at(-1)).toContain("1=ATTEMPTED 2=DECLINED(BUDGET_ENDED_BEFORE_ASKED) 3=DECLINED(ALREADY_ASKED_THIS_RENDER) 4=ATTEMPTED");
    } finally {
      log.mockRestore();
    }
  });

  describe("the order is kept in every outcome of the tier before", () => {
    const after = (tier2: "usable" | "empty" | "error" | "budget" | "still_running") =>
      beat(() => {
        noteTierAttempted("YOUTUBE", "youtube_first_turn");
        switch (tier2) {
          case "usable":
          case "empty":
          case "error":
            /** Attempting is recorded on ENTRY: a found clip, an empty archive and a thrown lookup are all "asked". */
            noteTierAttempted("OWN_ARCHIVE", "curated");
            break;
          case "budget":
            declineTier("OWN_ARCHIVE", "BUDGET_ENDED_BEFORE_ASKED");
            break;
          case "still_running":
            /** The lookup is in flight: neither attempted nor declined yet. */
            break;
        }
        return admitProviderForTier("internet_archive");
      });

    it.each(["usable", "empty", "error", "budget"] as const)("tier 3 is admitted after tier 2 ended as %s", async (how) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await after(how)).toEqual({ admitted: true });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("tier 3 is refused while tier 2 is still running — the order check is not weakened", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await after("still_running")).toMatchObject({ admitted: false, reason: "TIER_OUT_OF_ORDER", skipped: ["OWN_ARCHIVE"] });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("YouTube keeps its place: a decline of tier 2 admits nothing while tier 1 is untouched", () => {
      expect(tierMayRun("internet_archive", new Set(), new Set(["OWN_ARCHIVE"]))).toEqual({ ok: false, skipped: ["YOUTUBE"] });
      expect(tierMayRun("pexels", new Set(), new Set(["OWN_ARCHIVE", "OPEN_SOURCES"]))).toEqual({ ok: false, skipped: ["YOUTUBE"] });
      expect(tierMayRun("pexels", new Set(["YOUTUBE"]), new Set(["OWN_ARCHIVE", "OPEN_SOURCES"]))).toEqual({ ok: true });
      /** And a declined tier is not thereby "attempted": asking it later is still allowed (going back up is never skipping). */
      expect(tierMayRun("curated", new Set(["YOUTUBE"]), new Set(["OWN_ARCHIVE"]))).toEqual({ ok: true });
    });
  });

  it("wired: the archive-first route declines tier 2 only on a scope abort, and names it in the gap line", () => {
    const fn = CODE.slice(CODE.indexOf("export async function fetchBeatArchivalThenPexels("), CODE.indexOf("ARCHIVE_GAP") + 400);
    expect(fn).toContain("if (isScopeAbortError(err)) ownArchiveNotAsked =");
    expect(fn).toContain('if (ownArchiveNotAsked) declineTier("OWN_ARCHIVE", "BUDGET_ENDED_BEFORE_ASKED");');
    expect(fn).toContain('ownArchiveNotAsked ? "not completed — the beat\'s budget had ended" : "no match"');
    /** The decline comes BEFORE the suppliers are asked, so the ladder reads it when stock asks. */
    expect(fn.indexOf('declineTier("OWN_ARCHIVE"')).toBeLessThan(fn.indexOf('noteTierAttempted("YOUTUBE", "youtube_first_turn")'));
    /** Tier 2 still marks itself attempted inside the lookup — an archive that RAN and found nothing is attempted, not declined. */
    expect(CODE).toContain('noteTierAttempted("OWN_ARCHIVE", "curated");');
    /** No new provider, no raised timeout. */
    expect(CODE.match(/declineTier\("OWN_ARCHIVE"/g)).toHaveLength(1);
  });
});
