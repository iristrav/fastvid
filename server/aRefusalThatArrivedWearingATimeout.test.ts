/**
 * RONDE 258 — A REFUSAL THAT ARRIVED WEARING A TIMEOUT.
 *
 * ── What render 585 reported, and what was actually happening ───────────────────────────────
 *
 *     [YouTubeTrace] assets=105 delivered=0 refused=103
 *     [YouTubeTrace]   DOWNLOAD_FAILED FAILED reason=download_timeout     ×103
 *
 * Six rounds were spent looking at budgets and timeouts because of that word. The download service
 * knew better the whole time. Its own boot log, from the same deployment:
 *
 *     13:48:52  [Preflight] OK  youtube_egress  the yt-dlp service reached YouTube
 *     13:55:45  [Preflight] NO  youtube_egress  the yt-dlp service CANNOT reach YouTube
 *                                               (bot_check) — every YouTube download will fail
 *     13:55:48  ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot.
 *
 * Seven minutes apart, same machine, same proxy, same video — the most cached video on YouTube,
 * refused for a metadata call. YouTube blocks this address intermittently.
 *
 * ── Why the pipeline could not see it ───────────────────────────────────────────────────────
 *
 * The cloud route already classifies a refusal correctly, and arms a latch that skips the dead
 * route for the rest of the render:
 *
 *     if (!dlResp.ok) { … youtubeServiceRefusalReason(dlResp.status, errText) … }
 *
 * But that branch needs a RESPONSE. When yt-dlp meets the bot check it retries with backoff, the
 * beat's 22-second budget expires first, and the client aborts before any response arrives — so
 * execution goes to the catch, which files `DOWNLOAD_TIMEOUT` from the error object and asks
 * nothing further. The latch is never armed, and the next hundred candidates each pay the same
 * twenty-two seconds to learn the same thing.
 *
 * The service publishes the answer at `/health/egress`. Nobody asked it at the moment it mattered.
 * Same shape as the review pool, the preparation ledger and the cinematic identity: the answer is
 * computed, written down, and not carried to where the decision is made.
 *
 * ── What changes ────────────────────────────────────────────────────────────────────────────
 *
 * On a cloud-download TIMEOUT the pipeline asks the service once why, through the endpoint that
 * already exists. A `bot_check` answer is filed as a bot check and arms the existing latch.
 *
 * NOTHING IS RETRIED AND NO BUDGET MOVES. The probe is short, cached, and skipped entirely once
 * the latch is armed — so it costs one question per render, against the hundred refusals it stops.
 * A probe that cannot be asked changes nothing at all: "the service did not answer" and "the
 * service answered that it is blocked" stay two different facts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askYoutubeEgress,
  egressRefusalReason,
  resetYoutubeEgressProbeCache,
} from "./youtubeEgressProbe";

const ORIGINAL_FETCH = globalThis.fetch;
const ENV = { ...process.env };

/** One canned reply from the download service's own probe endpoint. */
const reply = (body: unknown, status = 200) =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );

beforeEach(() => {
  resetYoutubeEgressProbeCache();
  process.env.YOUTUBE_CC_DL_SERVICE = "https://ytdlp.example";
  process.env.YOUTUBE_CC_DL_TOKEN = "unit-test-token";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ENV };
  resetYoutubeEgressProbeCache();
  vi.restoreAllMocks();
});

describe("1. the answer the service already had", () => {
  it("a bot check is read as a bot check", async () => {
    globalThis.fetch = reply({ ok: false, reason: "bot_check", detail: "Sign in to confirm" }) as never;
    const verdict = await askYoutubeEgress(2_000);
    expect(verdict).toEqual({ ok: false, reason: "bot_check" });
  });

  it("and a healthy route is read as healthy", async () => {
    globalThis.fetch = reply({ ok: true, reason: null }) as never;
    expect(await askYoutubeEgress(2_000)).toEqual({ ok: true, reason: undefined });
  });
});

describe("2. not being able to ask is not an answer", () => {
  /**
   * The distinction the preflight already draws, kept here: "the service did not answer" sends an
   * operator somewhere else entirely from "the service answered that it is blocked". Null means
   * nothing is claimed, and the caller changes nothing.
   */
  it("an unreachable service yields null, never a verdict", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as never;
    expect(await askYoutubeEgress(2_000)).toBeNull();
  });

  it("a non-JSON or shapeless reply yields null", async () => {
    globalThis.fetch = reply({ nothing: "useful" }) as never;
    expect(await askYoutubeEgress(2_000)).toBeNull();
  });

  it("an unconfigured service is not asked at all", async () => {
    delete process.env.YOUTUBE_CC_DL_SERVICE;
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    expect(await askYoutubeEgress(2_000)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  /** RONDE 258 gives the endpoint an honest status code; an old service still answers 200. */
  it("a 503 carrying a verdict is still read, because the body is the answer", async () => {
    globalThis.fetch = reply({ ok: false, reason: "bot_check" }, 503) as never;
    expect(await askYoutubeEgress(2_000)).toEqual({ ok: false, reason: "bot_check" });
  });
});

describe("3. it is asked once, not once per candidate", () => {
  /**
   * Render 585 had 105 candidates. A probe per candidate would be 105 questions to answer one, and
   * each would spend beat budget the beat has already overspent.
   */
  it("a hundred callers produce one request", async () => {
    const spy = reply({ ok: false, reason: "bot_check" });
    globalThis.fetch = spy as never;
    await Promise.all(Array.from({ length: 100 }, () => askYoutubeEgress(2_000)));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("and the cached answer is the same answer", async () => {
    globalThis.fetch = reply({ ok: false, reason: "bot_check" }) as never;
    const first = await askYoutubeEgress(2_000);
    const second = await askYoutubeEgress(2_000);
    expect(second).toEqual(first);
  });

  it("a failure to ask is not cached as a verdict", async () => {
    const spy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    globalThis.fetch = spy as never;
    await askYoutubeEgress(2_000);
    await askYoutubeEgress(2_000);
    expect(spy, "nothing was learned, so the question may be asked again").toHaveBeenCalledTimes(2);
  });
});

describe("4. what the render files instead of a timeout", () => {
  it("a bot check becomes a reason that names itself", async () => {
    globalThis.fetch = reply({ ok: false, reason: "bot_check" }) as never;
    expect(await egressRefusalReason()).toBe("cloud_egress_bot_check");
  });

  it("a healthy route produces no reason at all, so the timeout stands", async () => {
    globalThis.fetch = reply({ ok: true }) as never;
    expect(
      await egressRefusalReason(),
      "the service can reach YouTube, so this really was a slow transfer"
    ).toBeNull();
  });

  it("and an unreachable service produces no reason either", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as never;
    expect(await egressRefusalReason()).toBeNull();
  });

  /**
   * Every blocked verdict is carried, not only the bot check: a proxy fault and a rate limit send
   * an operator to two different places, and both are better than the word "timeout".
   */
  it("a rate limit is carried under its own name", async () => {
    globalThis.fetch = reply({ ok: false, reason: "rate_limited" }) as never;
    expect(await egressRefusalReason()).toBe("cloud_egress_rate_limited");
  });
});

describe("5. the pipeline asks at the moment it matters", () => {
  const PIPE = require("fs").readFileSync(
    require("path").join(__dirname, "videoPipeline.ts"),
    "utf8"
  ) as string;

  /**
   * The GUARD, not just the name. A first version of this asserted only that
   * `egressRefusalReason` appeared in the block — which a mutation to `if (false)` sailed straight
   * through, because the call was still there, unreachable. A test that cannot tell a live call
   * from a dead one is not watching anything.
   */
  it("the cloud-download catch consults the probe, on a timeout, while the latch is open", () => {
    const at = PIPE.indexOf("YouTube CC cloud download scene");
    expect(at).toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 16000);
    expect(block, "the timeout path asked nothing in render 585").toMatch(
      /if \(thrownAs === "DOWNLOAD_TIMEOUT" && !cloudEgressRefusal\(\)\) \{[\s\S]{0,400}?egressRefusalReason\(\)/
    );
  });

  /** Only on a timeout: a response that arrived is already classified by the branch above. */
  it("and does not ask when the service answered for itself", () => {
    const at = PIPE.indexOf("YouTube CC cloud download scene");
    const block = PIPE.slice(at, at + 16000);
    expect(block, "the !dlResp.ok branch classifies from the body").toContain(
      "youtubeServiceRefusalReason(dlResp.status, errText)"
    );
  });

  it("and arms the latch that already exists rather than a second one", () => {
    const at = PIPE.indexOf("YouTube CC cloud download scene");
    const block = PIPE.slice(at, at + 16000);
    expect(block).toContain("noteCloudEgressBlocked");
  });

  /** The latch is read before the budget check, so a dead route costs nothing. Untouched. */
  it("the existing skip-when-latched path is unchanged", () => {
    expect(PIPE).toContain("const egressBlocked = cloudEgressRefusal();");
    expect(PIPE).toContain('note("cloud", "DOWNLOAD_FAILED", `cloud_egress_blocked:${egressBlocked.reason}`);');
  });
});

describe("6. nothing was retried, raised or loosened", () => {
  it("the download timeout and its floor are the numbers they were", async () => {
    const { youtubeDownloadTimeoutMs, YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS } = await import(
      "./sourcingPolicy"
    );
    expect(youtubeDownloadTimeoutMs()).toBe(180_000);
    expect(YOUTUBE_DOWNLOAD_TIMEOUT_FLOOR_MS).toBe(8_000);
  });

  it("the probe cannot outlast a beat's patience", async () => {
    const { YOUTUBE_EGRESS_PROBE_TIMEOUT_MS } = await import("./youtubeEgressProbe");
    expect(YOUTUBE_EGRESS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(4_000);
  });

  it("and the probe never sends a credential anywhere but the service", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "youtubeEgressProbe.ts"),
      "utf8"
    ) as string;
    expect(src, "the token is a header, never a log line").not.toMatch(
      /console\.[a-z]+\([^)]*TOKEN/i
    );
    expect(src).toContain("Authorization");
  });
});
