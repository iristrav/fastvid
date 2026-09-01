/**
 * RONDE 160 — FASE 3: the SearchQueryAudit learns where the user's own words come from.
 *
 * ── The production failure, reproduced ───────────────────────────────────────────────────────
 *
 * A render logged:
 *
 *     [SearchQueryAudit] unexpected terms detected: "WWII" => UNVERIFIED_TERM
 *
 * on a video whose entire subject was WWII. Reproduced before any change was made: a beat reading
 * "German commanders redrew the front line in the winter of 1942" proves "German", "commanders" and
 * "1942" — and does not contain the string "WWII" anywhere. The only evidence the validator had was
 * the beat plus its scene, so the single word naming the subject of the whole video was the one
 * word a query could not use.
 *
 * ── The rule this must NOT break ────────────────────────────────────────────────────────────
 *
 * RONDE 90 refused the video's TITLE as evidence, because a title is LLM-generated and admitting it
 * let "Adolf Hitler France" be measured on a beat that names neither. That stays refused. What is
 * admitted here is `videos.prompt` — what the PERSON TYPED. It is not a derivation; it is the
 * authorisation. Half of the tests below exist to prove the difference is real: a term from the
 * user's prompt is accepted, and a term from nowhere is still rejected exactly as before.
 */
import { describe, expect, it } from "vitest";

import {
  emptyQueryContext,
  provenToken,
  termProvenance,
  validateSearchQuery,
  type VerifiedQueryContext,
} from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

/** The exact beat from the reproduction: it is about WWII and never says so. */
const BEAT = "German commanders redrew the front line in the winter of 1942.";

function ctxWithTopic(topic: string): VerifiedQueryContext {
  const ctx = emptyQueryContext(BEAT, topic);
  ctx.places.push(provenToken("front line", "place", "beat_text", BEAT));
  return ctx;
}

/* ═══════════════════════ the failure, and the fix ═══════════════════════ */

describe("FASE 3 — a term the user typed is allowed; a term from nowhere is not", () => {
  /** Exactly the state that produced the production log line. */
  it("without a topic, WWII is still refused — the old behaviour is unchanged", () => {
    const ctx = emptyQueryContext(BEAT);
    const v = validateSearchQuery("WWII archival footage", ctx);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("UNVERIFIED_TERM");
    expect(v.offendingTerm).toBe("WWII");
  });

  it("with the user's prompt as the topic, WWII is accepted", () => {
    expect(validateSearchQuery("WWII archival footage", ctxWithTopic("wwii")).ok).toBe(true);
  });

  /** Case must not matter: the person typed "wwii", the query says "WWII". */
  it("the match is case-insensitive in both directions", () => {
    expect(validateSearchQuery("WWII archival footage", ctxWithTopic("wwii")).ok).toBe(true);
    expect(validateSearchQuery("wwii archival footage", ctxWithTopic("WWII")).ok).toBe(true);
  });

  /** A realistic prompt, not a bare keyword — this is what the form actually collects. */
  it("a full sentence prompt proves the words inside it", () => {
    const ctx = ctxWithTopic("The rise and fall of Blockbuster — what really happened");
    expect(validateSearchQuery("Blockbuster archival footage", ctx).ok).toBe(true);
  });

  /**
   * The half of this that matters most. The audit exists to catch invented terms, and a topic must
   * not become a licence for everything: a word that is in neither the script nor the prompt is
   * still refused, with the same reason as before.
   */
  it("a term in neither the script nor the prompt is STILL refused", () => {
    const ctx = ctxWithTopic("wwii");
    for (const query of [
      "WWII panzer archival footage",
      "WWII Normandy archival footage",
      "WWII Churchill archival footage",
    ]) {
      const v = validateSearchQuery(query, ctx);
      expect(v.ok, query).toBe(false);
      if (v.ok) continue;
      expect(v.reason).toBe("UNVERIFIED_TERM");
    }
  });

  it("the refusal names every unproven word, not just the first", () => {
    const v = validateSearchQuery("WWII panzer Normandy archival footage", ctxWithTopic("wwii"));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.blockedTerms).toEqual(["panzer", "Normandy"]);
    expect(v.blockedTerms).not.toContain("WWII");
  });

  /**
   * RONDE 90's hole, still closed. A title is LLM-generated, so it is not a topic and must not be
   * fed in as one — but even a term the extractors traced to `title_inference` stays refused, and
   * is named by that route rather than lumped in with the anonymous ones.
   */
  it("a term traced to the LLM title is still refused, and named as such", () => {
    const ctx = ctxWithTopic("wwii");
    ctx.persons.push({
      term: "Adolf Hitler",
      type: "person",
      source: "title_inference",
      verified: false,
    });
    const v = validateSearchQuery("Adolf Hitler archival footage", ctx);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("TITLE_INFERENCE_NOT_ALLOWED");
  });

  it("an LLM-generated term is still refused, and named as such", () => {
    const ctx = ctxWithTopic("wwii");
    ctx.objects.push({ term: "panzer", type: "object", source: "llm_generated", verified: false });
    const v = validateSearchQuery("WWII panzer archival footage", ctx);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("LLM_GENERATED_TERM");
  });

  /** An empty topic must change nothing at all — no accidental wildcard. */
  it("an empty or whitespace topic proves nothing", () => {
    for (const topic of ["", "   ", "\n"]) {
      const v = validateSearchQuery("WWII archival footage", emptyQueryContext(BEAT, topic));
      expect(v.ok, JSON.stringify(topic)).toBe(false);
    }
  });

  /** A pronoun is refused with or without a topic — the closed classes are untouched. */
  it("the topic does not license a pronoun", () => {
    const v = validateSearchQuery("She archival footage", ctxWithTopic("wwii"));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("FORBIDDEN_PRONOUN");
  });

  /** Nor a query with no subject at all — check H still stands. */
  it("the topic does not license a query with no content anchor", () => {
    const v = validateSearchQuery("archival footage", ctxWithTopic("wwii"));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("NO_CONTENT_ANCHOR");
  });
});

/* ═══════════════════════ provenance, stated explicitly ═══════════════════════ */

/**
 * FASE 3 asked for a query to be able to say, in so many words:
 *
 *     queryTerm = "WWII"; provenance = "topic"; source = "video.topic"; approved = true
 *
 * `termProvenance` is that sentence. These tests are the sentence being true.
 */
describe("FASE 3 — termProvenance says WHICH channel proved a word", () => {
  it("names the topic for a word only the user's prompt supplies", () => {
    expect(termProvenance("WWII", ctxWithTopic("wwii"))).toEqual({
      term: "WWII",
      provenance: "topic",
      source: "video.prompt",
      approved: true,
    });
  });

  it("names the beat for a word the script itself uses", () => {
    const p = termProvenance("commanders", ctxWithTopic("wwii"));
    expect(p.approved).toBe(true);
    expect(p.provenance).toBe("beat_text");
  });

  /** The narrower claim wins: a typed token beats the raw evidence it came from. */
  it("names the typed token when an extractor proved one", () => {
    const p = termProvenance("front", ctxWithTopic("wwii"));
    expect(p.approved).toBe(true);
    expect(p.source).toBe("place_token");
  });

  it("refuses a word nothing supplies, and says so", () => {
    expect(termProvenance("panzer", ctxWithTopic("wwii"))).toEqual({
      term: "panzer",
      provenance: "unknown",
      source: null,
      approved: false,
    });
  });

  it("names the forbidden route when a word is traceable to one", () => {
    const ctx = ctxWithTopic("wwii");
    ctx.persons.push({
      term: "Churchill",
      type: "person",
      source: "title_inference",
      verified: false,
    });
    const p = termProvenance("Churchill", ctx);
    expect(p.approved).toBe(false);
    expect(p.provenance).toBe("title_inference");
  });

  it("treats camera vocabulary as technical rather than as content", () => {
    const p = termProvenance("archival", ctxWithTopic("wwii"));
    expect(p.approved).toBe(true);
    expect(p.provenance).toBe("technical");
  });

  /** Every word of an accepted query must have a provenance — no word gets in unexplained. */
  it("every word of an accepted query can name its own source", () => {
    const ctx = ctxWithTopic("wwii");
    const query = "WWII commanders archival footage";
    expect(validateSearchQuery(query, ctx).ok).toBe(true);
    for (const word of query.split(/\s+/)) {
      const p = termProvenance(word, ctx);
      expect(p.approved, `${word} got into an accepted query with no provenance`).toBe(true);
    }
  });
});

/* ═══════════════════════ reachable from the production builder ═══════════════════════ */

/**
 * The bug was never in a function — it was in what the production builder passed. So the last
 * tests go through `buildVerifiedQueryContextForBeat`, which is what the pipeline actually calls.
 */
describe("FASE 3 — the production context builder carries the prompt", () => {
  it("puts the prompt on the context, separately from the evidence", () => {
    const ctx = buildVerifiedQueryContextForBeat(BEAT, { topic: "wwii" });
    expect(ctx.topic).toBe("wwii");
    /** Kept apart on purpose: a log must be able to tell "the beat said it" from "the user asked". */
    expect(ctx.evidence).toContain("German commanders");
    expect(ctx.evidence).not.toContain("wwii");
  });

  it("a query built from that context accepts the prompt's word", () => {
    const ctx = buildVerifiedQueryContextForBeat(BEAT, { topic: "wwii" });
    expect(validateSearchQuery("WWII archival footage", ctx).ok).toBe(true);
  });

  it("omitting the prompt leaves the old behaviour byte-for-byte", () => {
    const withOut = buildVerifiedQueryContextForBeat(BEAT);
    expect(withOut.topic).toBeUndefined();
    expect(validateSearchQuery("WWII archival footage", withOut).ok).toBe(false);
  });
});
