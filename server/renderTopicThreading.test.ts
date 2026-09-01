/**
 * FINAL PRODUCTION VALIDATION §6 — the render's topic reaches the search gate.
 *
 * ── The production defect ───────────────────────────────────────────────────────────────────
 *
 * The first real Railway render (Stauffenberg / July 20 plot) blocked 101 of 157 provider queries.
 * `[SearchQueryAudit]` named `["WWII"]` eighteen separate times as `UNVERIFIED_TERM`, while the
 * proven terms read `["Claus von Stauffenberg","Adolf Hitler","Berlin"]`. The people and the place
 * were proven; the ERA the person had asked for was not — because no beat's sentence happens to
 * contain the string "WWII".
 *
 * R160 anticipated exactly this and built the fix: a `topic` field on VerifiedQueryContext, fed by
 * `videos.prompt`, with its own provenance channel so an audit can tell "the beat said this" from
 * "the person asked for this". Then it wired nothing. `grep -c "topic:"` across the four call sites
 * that reach `buildVerifiedQueryContextForBeat` in production returned zero. The channel existed
 * and carried nothing for the whole of its life.
 *
 * ── What is NOT the fix ─────────────────────────────────────────────────────────────────────
 *
 * Not a "WWII" whitelist, not a historical-term allowance, not SEARCH_GATE_STRICT off, not a lower
 * threshold. Every one of those admits terms nobody authorised. The person typed the word; the word
 * is authorised; the job was to carry it down the call chain.
 *
 * ── The rule these tests exist to keep ──────────────────────────────────────────────────────
 *
 * `videos.prompt` ONLY. A TITLE is a claim the model made about the video — admitting it as
 * evidence re-opens the hole RONDE 90 closed, where "Adolf Hitler France" was measured against a
 * beat naming neither. The last describe block below is what stops a future edit from widening the
 * wiring to the title, since no runtime check can tell one string from another.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  getRenderTopic,
  validateSearchQuery,
  withRenderTopic,
  termProvenance,
} from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

/** The beat from the production render, verbatim in shape: it names the people, not the era. */
const BEAT = "Claus von Stauffenberg placed the briefcase beside Hitler in the conference room.";

/** The prompt the person actually typed — the authorisation. */
const PROMPT = "A WWII documentary about the July 20 plot to kill Hitler";

/** The query the gate refused eighteen times in production. */
const QUERY = "WWII archival footage";

/* ═══════════════════════ the defect, reproduced and closed ═══════════════════════ */

describe("§6 — a term the person asked for is admitted on a beat that does not repeat it", () => {
  /**
   * The BEFORE state, kept as a test rather than a comment: outside any render scope nothing has
   * been authorised, and "WWII" is correctly refused. This is also the mutation guard — delete the
   * `getRenderTopic()` fallback in `buildVerifiedQueryContextForBeat` and the next test fails while
   * this one keeps passing, which is precisely the production symptom.
   */
  it("is refused when no render scope has stated a topic", () => {
    const ctx = buildVerifiedQueryContextForBeat(BEAT, { sceneText: BEAT });
    expect(ctx.topic).toBeUndefined();
    const v = validateSearchQuery(QUERY, ctx);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.blockedTerms).toContain("WWII");
  });

  it("is admitted inside a render scope carrying the user's prompt", () => {
    withRenderTopic(PROMPT, () => {
      const ctx = buildVerifiedQueryContextForBeat(BEAT, { sceneText: BEAT });
      expect(ctx.topic).toBe(PROMPT);
      expect(validateSearchQuery(QUERY, ctx).ok).toBe(true);
    });
  });

  /**
   * And the audit can still say WHY. The whole point of a separate channel is that a log
   * distinguishes the beat's own words from the person's — a topic-proven term must not read as if
   * the sentence had proven it.
   */
  it("records the term as topic-proven, not as beat-proven", () => {
    withRenderTopic(PROMPT, () => {
      const ctx = buildVerifiedQueryContextForBeat(BEAT, { sceneText: BEAT });
      expect(termProvenance("WWII", ctx)).toMatchObject({
        provenance: "topic",
        source: "video.prompt",
        approved: true,
      });
      /** A name the beat states is proven by the beat, not demoted to the topic channel. */
      expect(termProvenance("Stauffenberg", ctx).provenance).not.toBe("topic");
    });
  });
});

/* ═══════════════════════ the scope behaves like a render ═══════════════════════ */

describe("§6 — the scope is per-render and survives the pipeline's own shape", () => {
  /**
   * The pipeline awaits between the entry point and the first provider search — dozens of times.
   * A mechanism that did not survive an await would look correct in a synchronous test and carry
   * nothing in production, which is the failure this whole round is about.
   */
  it("survives awaits, the way the real pipeline reaches the gate", async () => {
    await withRenderTopic(PROMPT, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve();
      const ctx = buildVerifiedQueryContextForBeat(BEAT, { sceneText: BEAT });
      expect(validateSearchQuery(QUERY, ctx).ok).toBe(true);
    });
  });

  /**
   * Concurrent renders must not read each other's prompt. This is the reason the topic is ambient
   * storage rather than a module-level variable: two renders in one worker process would otherwise
   * authorise each other's terms.
   */
  it("does not leak one render's topic into a concurrent render", async () => {
    const [a, b] = await Promise.all([
      withRenderTopic("A documentary about WWII", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return validateSearchQuery(QUERY, buildVerifiedQueryContextForBeat(BEAT)).ok;
      }),
      withRenderTopic("A documentary about coral reefs", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return validateSearchQuery(QUERY, buildVerifiedQueryContextForBeat(BEAT)).ok;
      }),
    ]);
    expect(a, "the WWII render lost its own topic").toBe(true);
    expect(b, "the reef render was handed the WWII render's topic").toBe(false);
  });

  it("leaves no topic behind after the render ends", () => {
    withRenderTopic(PROMPT, () => expect(getRenderTopic()).toBe(PROMPT));
    expect(getRenderTopic()).toBeUndefined();
  });

  it("sets nothing for an absent or blank prompt", () => {
    withRenderTopic(undefined, () => expect(getRenderTopic()).toBeUndefined());
    withRenderTopic("   ", () => expect(getRenderTopic()).toBeUndefined());
  });

  /** An explicit topic is the narrower claim and keeps winning over the ambient one. */
  it("an explicitly passed topic still wins", () => {
    withRenderTopic(PROMPT, () => {
      const ctx = buildVerifiedQueryContextForBeat(BEAT, { topic: "coral reefs" });
      expect(ctx.topic).toBe("coral reefs");
      expect(validateSearchQuery(QUERY, ctx).ok).toBe(false);
    });
  });
});

/* ═══════════════════════ the gate is still a gate ═══════════════════════ */

describe("§6 — nothing outside the prompt became admissible", () => {
  /**
   * The load-bearing test. A prompt authorises ITS OWN words and nothing else — a topic that
   * admitted anything adjacent would be the whitelist this round was told not to build.
   */
  it("still refuses a term neither the beat nor the prompt contains", () => {
    withRenderTopic(PROMPT, () => {
      const ctx = buildVerifiedQueryContextForBeat(BEAT, { sceneText: BEAT });
      const v = validateSearchQuery("panzer division advance", ctx);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.blockedTerms).toContain("panzer");
    });
  });

  /**
   * A term the TITLE supplies stays unproven. `title_inference` is a forbidden provenance and this
   * round did not touch it: the title's words are admissible only where the script repeats them.
   */
  it("still refuses a term that only a title would supply", () => {
    withRenderTopic("A documentary about the July 20 plot", () => {
      /** As if the title were "Hitler's Final Hours in France" — France is in neither. */
      const ctx = buildVerifiedQueryContextForBeat(BEAT, { sceneText: BEAT });
      const v = validateSearchQuery("Adolf Hitler France", ctx);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.blockedTerms).toContain("France");
    });
  });

  it("still refuses a query with no subject at all", () => {
    withRenderTopic(PROMPT, () => {
      const v = validateSearchQuery("aerial footage", buildVerifiedQueryContextForBeat(BEAT));
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason).toBe("NO_CONTENT_ANCHOR");
    });
  });
});

/* ═══════════════════════ the wiring passes the prompt and only the prompt ═══════════════════════ */

describe("§6 — the production call site cannot drift to the title", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  /** Without this the whole mechanism is R160 again: correct, exported, and called by nobody. */
  it("runVideoPipeline opens a render-topic scope", () => {
    const entry = SRC.slice(SRC.indexOf("export async function runVideoPipeline("));
    const body = entry.slice(0, entry.indexOf("\nasync function _runVideoPipelineInner("));
    expect(body, "the render entry point sets no topic — the channel carries nothing again")
      .toContain("withRenderTopic(");
  });

  /**
   * No runtime check can tell a prompt from a title — both are strings. So the guard is on the
   * source: the expression handed to `withRenderTopic` must mention `prompt` and must not mention
   * a title. An edit that widens it to `?? ownerRow?.title` fails here, which is the only place it
   * can be caught before it reaches a render.
   */
  it("hands it videos.prompt, never a title", () => {
    const at = SRC.indexOf("withRenderTopic(");
    expect(at, "no withRenderTopic call site to check").toBeGreaterThan(-1);
    const call = SRC.slice(at, SRC.indexOf("\n", at));
    expect(call).toMatch(/prompt/);
    expect(call.toLowerCase(), `topic is fed from a title: ${call.trim()}`).not.toMatch(/title/);
  });
});
