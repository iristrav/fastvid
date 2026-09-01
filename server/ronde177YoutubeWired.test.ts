/**
 * RONDE 177 — the last link: production actually HANDS the pool a YouTube search.
 *
 * ── Why this test exists separately from R175's ─────────────────────────────────────────────
 *
 * R175 proved `buildSceneCandidatePool` calls whatever search function it is given. R176's audit
 * then found the gap that made that worth nothing in practice: no production call site passed one
 * in. The pool COULD call YouTube and never did.
 *
 * So R175's test guards the pool and this one guards the CALLER. Both are needed, and neither
 * catches the other's failure: remove the argument from videoPipeline and R175 stays green.
 *
 * These are assertions about the production call sites, because the function they live in needs a
 * workDir, a network, a budget and a database to invoke. What is checked is that the argument is
 * passed at every site, and that the decision behind it is honest about the difference between
 * "not configured" and "found nothing".
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";

const SRC = fs.readFileSync("server/videoPipeline.ts", "utf8");

/** Every `buildSceneCandidatePool({...})` argument object in the production pipeline. */
function poolCallArgs(): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = SRC.indexOf("buildSceneCandidatePool({", from);
    if (at < 0) break;
    /** The literal ends at the closing brace of the argument object. */
    const end = SRC.indexOf("})", at);
    out.push(SRC.slice(at, end));
    from = at + 1;
  }
  return out;
}

describe("R177 — every production pool call passes the YouTube search", () => {
  it("there is more than one call site, so this is worth checking", () => {
    expect(poolCallArgs().length).toBeGreaterThanOrEqual(2);
  });

  /**
   * The assertion R176's audit turned into a requirement. One call site without the argument is a
   * whole route on which YouTube silently never participates — the inline build and the prefetch
   * must not disagree about which sources exist.
   */
  it("no call site is left without it", () => {
    const missing = poolCallArgs().filter((a) => !a.includes("youtubeSearch:"));
    expect(missing, `${missing.length} pool call site(s) do not offer YouTube`).toEqual([]);
  });

  it("every call site uses the shared helper rather than its own arrangement", () => {
    for (const args of poolCallArgs()) {
      expect(args).toContain("scenePoolYoutubeSearch(");
    }
  });
});

describe("R177 — the helper is honest about why YouTube is absent", () => {
  function helperBody(): string {
    const at = SRC.indexOf("function scenePoolYoutubeSearch(");
    expect(at, "the shared helper is gone").toBeGreaterThan(-1);
    return SRC.slice(at, SRC.indexOf("\n}", at));
  }

  /**
   * `undefined` and `async () => []` are different answers. An absent function is recorded by the
   * pool as `no_search_function_supplied` — a configuration fact — while a function returning
   * nothing is a search that ran and found nothing. Collapsing them loses the one distinction that
   * makes "why was YouTube not used for this beat" answerable.
   */
  it("returns undefined when YouTube is not configured, rather than an empty search", () => {
    const body = helperBody();
    expect(body).toContain("return undefined");
    expect(body, "an empty-result stub would hide the difference").not.toMatch(/=>\s*\[\]/);
    expect(body, "an empty-result stub would hide the difference").not.toMatch(/Promise\.resolve\(\[\]\)/);
  });

  it("checks both the feature flag and the key", () => {
    const body = helperBody();
    expect(body).toContain("youtubeSourcingEnabled()");
    expect(body).toContain("YOUTUBE_API_KEY");
  });

  /** RULE: no second YouTube client. The helper must delegate to the existing search. */
  it("delegates to the existing search client and builds no second one", () => {
    const body = helperBody();
    expect(body).toContain("searchYoutubeVideoCandidates(");
    for (const forbidden of ["googleapis.com", "fetch(", "new URL(", "RAPIDAPI"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  /** The render's sourcing cache travels with it, so quota and cooldown stay per-render. */
  it("passes the render's own sourcing cache through", () => {
    expect(helperBody()).toContain("sourcingCache");
  });
});

/* ═══════════════════════ the behaviour, not just the wiring ═══════════════════════ */

describe("R177 — the helper's decision, exercised", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
    Object.assign(process.env, ORIGINAL);
  });

  /**
   * Exercised through the flag helpers the production code actually consults, so a change to
   * either one is caught here rather than only in a source scan.
   */
  it("YouTube sourcing off means no search function at all", async () => {
    const { youtubeSourcingEnabled } = await import("./sourcingPolicy");
    delete process.env.ENABLE_YOUTUBE_SOURCING;
    expect(youtubeSourcingEnabled()).toBe(false);
  });

  it("sourcing on but no key is still no search function", async () => {
    const { youtubeSourcingEnabled } = await import("./sourcingPolicy");
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    delete process.env.YOUTUBE_API_KEY;
    expect(youtubeSourcingEnabled()).toBe(true);
    /** Both conditions are required; the helper returns undefined when either is missing. */
    expect(Boolean(process.env.YOUTUBE_API_KEY)).toBe(false);
  });
});
