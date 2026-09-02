/**
 * THE RENDER THAT ASKED ABOUT ITS OWN TITLE.
 *
 * Render 563's script is about Martin Bormann, Berlin and Hitler's war decisions. Its title is
 * "The Unseen Forces That Shaped Hitler's World War II Decisions". Sixteen live YouTube searches
 * went out, and the word "Hitler" appears in none of them:
 *
 *     "Unseen Forces"        "Unseen Forces Berlin"
 *     "Unseen Forces Turkey" "Unseen Forces Turkey archival footage"
 *
 * ── The gate was never the problem ──────────────────────────────────────────────────────────
 *
 * Every one of them was refused, and the refusal names the whole tragedy in a single line:
 *
 *     [SearchQueryAudit] provider=youtube_cc query="Unseen Forces Berlin" status=BLOCKED
 *       terms=["Martin Bormann","Berlin","unexpected note","involved"]
 *       blockedTerms=["Unseen","Forces"] reason=TITLE_INFERENCE_NOT_ALLOWED
 *
 * `terms=` is what the beat had PROVEN. The pipeline held "Martin Bormann" and "Berlin" the entire
 * time and asked about two decorative words from the thumbnail instead. 199 of that render's 252
 * queries were refused this way — 54 of them for "Unseen"/"Forces", 12 more for "Shaped" — which
 * is why so little topical footage came back and why the montage filled with period-plausible,
 * subject-wrong material.
 *
 * So this is not a YouTube bug, and the fix is not at the gate. The same query was refused on
 * internet_archive and sepiasearch in the same second; pexels was refused 109 times. One builder
 * feeds them all, and it chose its anchor without ever consulting the evidence.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * An anchor is checked against the same context the provider gate will consult, by the same
 * function. When it cannot be traced, the beat's own proven subject takes its place — and the
 * swap is announced, because changing what a render asks nine providers is not a detail.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildHistoricalArchivalQueries,
  chooseProvenAnchor,
  looksLikeSentenceFragment,
  type MediaSearchIntent,
} from "./mediaResearchEngine";
import {
  emptyQueryContext,
  provenToken,
  validateSearchQuery,
  withSearchProvenance,
  type VerifiedQueryContext,
} from "./searchQueryContract";

/* ═══════════════════════ render 563, reconstructed ═══════════════════════ */

const TITLE = "The Unseen Forces That Shaped Hitler's World War II Decisions";

/** Scene 1, beat 1 — the beat behind the "Unseen Forces Berlin" refusals. */
const BEAT =
  "Martin Bormann was involved in an unexpected note that reached Berlin before the decision was made.";

/**
 * The context that render logged as `terms=["Martin Bormann","Berlin","unexpected note",...]`.
 * Persons the scene proves are verified; the title's two words are `title_inference`, exactly as
 * `buildVerifiedQueryContextForBeat` marks them.
 */
function render563Context(): VerifiedQueryContext {
  const ctx = emptyQueryContext(BEAT);
  ctx.persons.push(provenToken("Martin Bormann", "person", "scene_text", BEAT));
  ctx.persons.push({
    term: "Unseen Forces",
    type: "person",
    source: "title_inference",
    verified: false,
  });
  ctx.places.push(provenToken("Berlin", "place", "beat_text", BEAT));
  return ctx;
}

function intent(overrides: Partial<MediaSearchIntent> = {}): MediaSearchIntent {
  return {
    beatText: BEAT,
    searchQueries: ["Unseen Forces Berlin"],
    keywords: [],
    primaryPerson: "",
    persons: [],
    topicKind: "historical",
    videoTitle: TITLE,
    powerWord: "Unseen Forces",
    personTopicLock: false,
    spaceTopic: false,
    muskTopic: false,
    ...overrides,
  };
}

/* ═══════════════════════ the anchor answers to the evidence ═══════════════════════ */

describe("an anchor the beat cannot prove is not an anchor", () => {
  /** The exact string render 563 built four query families on. */
  it("refuses the title's decorative words", () => {
    const { anchor, rejected } = chooseProvenAnchor(["Unseen Forces"], render563Context());
    expect(rejected).toContain("Unseen Forces");
    expect(anchor, "the anchor is still the title's own words").not.toBe("Unseen Forces");
  });

  /**
   * The point of the whole change. Refusing the bad anchor and stopping there would leave the
   * beat with nothing to ask — which is what render 563 already did, only more quietly.
   */
  it("falls through to the subject the beat proved", () => {
    expect(chooseProvenAnchor(["Unseen Forces"], render563Context()).anchor).toBe("Martin Bormann");
  });

  /** A proven anchor is taken as offered — this must not become a rewriter. */
  it("leaves a traceable anchor alone", () => {
    const { anchor, rejected } = chooseProvenAnchor(["Martin Bormann"], render563Context());
    expect(anchor).toBe("Martin Bormann");
    expect(rejected).toEqual([]);
  });

  /** First traceable candidate wins, in the caller's order of preference. */
  it("takes the first candidate that holds, not the last", () => {
    const { anchor } = chooseProvenAnchor(["Unseen Forces", "Berlin", "Martin Bormann"], render563Context());
    expect(anchor).toBe("Berlin");
  });

  /**
   * Persons outrank places, the same order buildPrioritisedQueries ranks by: "Martin Bormann"
   * finds the man, "Berlin" finds a city of three million people across two centuries.
   */
  it("prefers a proven person over a proven place when falling back", () => {
    const ctx = emptyQueryContext(BEAT);
    ctx.places.push(provenToken("Berlin", "place", "beat_text", BEAT));
    ctx.persons.push(provenToken("Martin Bormann", "person", "scene_text", BEAT));
    expect(chooseProvenAnchor(["Unseen Forces"], ctx).anchor).toBe("Martin Bormann");
  });

  /** A beat that proves nothing gets no invented anchor. Empty is an honest answer. */
  it("invents nothing when the beat proves nothing", () => {
    expect(chooseProvenAnchor(["Unseen Forces"], emptyQueryContext("")).anchor).toBe("");
  });

  /* ─────────────────── RENDER 564: the fallback traded down ─────────────────── */

  /**
   * THE LINE THAT EXPOSED IT.
   *
   *     [QueryAnchor] rejected="Führerbunker interior Berlin 1945" reason=UNVERIFIED_TERM
   *                   chosen="made final stand"
   *
   * The refusal was right — none of those terms is in that beat. The replacement was not: "made
   * final stand archival footage" is not a question any provider can answer. `looksLikeSentence
   * Fragment` is this module's own check for a clause-shaped anchor and was never applied here.
   */
  it("does not fall back to a verb phrase", () => {
    const beat = "He made his final stand in the bunker as the shells came closer.";
    const ctx = emptyQueryContext(beat);
    ctx.events.push(provenToken("made final stand", "event", "beat_text", beat));
    expect(
      chooseProvenAnchor(["Führerbunker interior Berlin 1945"], ctx).anchor,
      "a clause was chosen as the thing to search for"
    ).not.toBe("made final stand");
  });

  /**
   * A clause is SKIPPED, and the search continues past it — it does not merely lose a ranking.
   *
   * The first version of this test was called "prefers a proven object over an event phrase" and
   * it passed with the ordering change reverted, because the fragment check had already removed
   * the clause. It was pinning an ordering that was doing nothing. What actually matters is this:
   * a clause-shaped candidate does not stop the loop, so a real subject further down is still
   * reached.
   */
  it("keeps looking past a clause instead of settling for it", () => {
    const beat = "He made his final stand in the bunker as the shells came closer.";
    const ctx = emptyQueryContext(beat);
    ctx.events.push(provenToken("made final stand", "event", "beat_text", beat));
    ctx.objects.push(provenToken("bunker", "object", "beat_text", beat));
    expect(
      chooseProvenAnchor(["Führerbunker interior Berlin 1945"], ctx).anchor,
      "the clause ended the search and the beat lost the subject sitting behind it"
    ).toBe("bunker");
  });

  /** Events are demoted, not removed — a named event is still a good anchor. */
  it("still uses a named event when nothing else is proven", () => {
    const beat = "The Battle of Berlin reached the city centre that April.";
    const ctx = emptyQueryContext(beat);
    ctx.events.push(provenToken("Battle of Berlin", "event", "beat_text", beat));
    expect(chooseProvenAnchor(["Unseen Forces"], ctx).anchor).toBe("Battle of Berlin");
  });

  /**
   * The light and reporting verbs a narration sentence turns on. The list already carried
   * "chose", "decided" and "ordered"; "made" was missing, which is the whole of render 564's
   * defect. Checked through the public function so this holds wherever the list is consulted.
   */
  it.each(["made", "took", "gave", "became", "began", "brought", "wrote", "thought"])(
    "treats a phrase led by '%s' as a clause, not a subject",
    (verb) => {
      expect(looksLikeSentenceFragment(`${verb} final stand`)).toBe(true);
    }
  );

  /** And the words that name things are untouched by that list. */
  it.each(["Adolf Hitler", "Berlin bunker", "Battle of Berlin", "Eva Braun", "bunker"])(
    "still accepts '%s' as a subject",
    (subject) => {
      expect(looksLikeSentenceFragment(subject)).toBe(false);
    }
  );

  /**
   * Outside a beat scope — unit tests, callers that hold no provenance — the validator approves
   * everything, and so must this. The change may not narrow what the gate itself would allow.
   */
  it("changes nothing when there is no context to check against", () => {
    const { anchor, rejected } = chooseProvenAnchor(["Unseen Forces"], undefined);
    expect(anchor).toBe("Unseen Forces");
    expect(rejected).toEqual([]);
  });
});

/* ═══════════════════════ the queries render 563 actually sent ═══════════════════════ */

describe("the family built for render 563's beat", () => {
  const build = () =>
    withSearchProvenance(render563Context(), () => buildHistoricalArchivalQueries(intent(), BEAT));

  /** The four strings in the log, and every variant of them. */
  it("no longer asks about the title", () => {
    for (const q of build()) {
      expect(q.toLowerCase(), `"${q}" still carries the title's words`).not.toMatch(
        /\bunseen\b|\bforces\b/
      );
    }
  });

  /** And asks about the man the beat is actually about. */
  it("asks about the beat's subject instead", () => {
    const asked = build().join(" | ").toLowerCase();
    expect(asked, "the beat's proven subject reaches no provider").toContain("martin bormann");
  });

  /**
   * A query that the gate will refuse spends one of the twelve slots and reaches no provider.
   * Every query this builder hands out must survive the check its caller is about to apply.
   */
  it("hands out nothing the provider gate would refuse", () => {
    const ctx = render563Context();
    const queries = build();
    expect(queries.length, "the beat was left with no query at all").toBeGreaterThan(0);
    for (const q of queries) {
      const verdict = validateSearchQuery(q, ctx);
      expect(verdict.ok, `"${q}" would be BLOCKED at the provider (${verdict.reason})`).toBe(true);
    }
  });

  /** Silence is how render 562 hid an entire missing provider. This swap says so. */
  it("says out loud that it swapped the anchor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      build();
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[QueryAnchor]"));
      expect(lines.length, "the anchor changed with no line in the log").toBeGreaterThan(0);
      expect(lines[0]).toContain("Unseen Forces");
      expect(lines[0], "the log does not say WHY it was refused").toContain(
        "TITLE_INFERENCE_NOT_ALLOWED"
      );
    } finally {
      warn.mockRestore();
    }
  });

  /** A beat whose anchor holds must not pay for this at all. */
  it("stays quiet when the anchor was fine", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      withSearchProvenance(render563Context(), () =>
        buildHistoricalArchivalQueries(
          intent({ powerWord: "Martin Bormann", searchQueries: ["Martin Bormann Berlin"] }),
          BEAT
        )
      );
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("[QueryAnchor]"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

/* ═══════════════════════ "Shaped Hitler" ═══════════════════════ */

describe("a title is not a list of people", () => {
  /**
   * `knownFullNames` mined the title with a bare two-capitals regex, so "That Shaped Hitler's"
   * yielded the name "Shaped Hitler" — and `expandAnchorToKnownPerson` completes a lone "Hitler"
   * against that list. Twelve of render 563's refusals read `blockedTerms=["Shaped"]`.
   */
  it("does not complete a surname into a verb from the title", () => {
    const ctx = emptyQueryContext("Hitler weighed the decision through the winter of 1941.");
    ctx.persons.push(
      provenToken("Hitler", "person", "scene_text", "Hitler weighed the decision through the winter of 1941.")
    );
    const queries = withSearchProvenance(ctx, () =>
      buildHistoricalArchivalQueries(
        intent({
          beatText: "Hitler weighed the decision through the winter of 1941.",
          powerWord: "Hitler",
          searchQueries: ["Hitler 1941"],
        }),
        "Hitler weighed the decision through the winter of 1941."
      )
    );
    expect(queries.length, "the beat lost every query").toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.toLowerCase(), `"${q}" carries a verb the title capitalised`).not.toContain("shaped");
    }
  });

  /**
   * MUTATION M4 ESCAPED HERE.
   *
   * The test above passed with the title-corroboration rule deleted, because the anchor check
   * caught "Shaped Hitler" on the way out — right answer, wrong reason, and it would have gone on
   * passing after the title-mining bug came back.
   *
   * Outside a beat's provenance scope there is no anchor check: the validator approves everything,
   * exactly as it did before any of this. That is where mining the title raw is visible, and it is
   * not a hypothetical path — several callers build queries with no ambient context.
   */
  it("refuses the title's verb even where nothing else would catch it", () => {
    const beat = "Hitler weighed the decision through the winter of 1941.";
    const queries = buildHistoricalArchivalQueries(
      intent({ beatText: beat, powerWord: "Hitler", searchQueries: ["Hitler 1941"] }),
      beat
    );
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(
        q.toLowerCase(),
        `"${q}" — the title's "That Shaped Hitler's" became the name "Shaped Hitler"`
      ).not.toContain("shaped");
    }
  });

  /**
   * The rule is corroboration, not blanket refusal: a real name the title states AND the beat
   * writes out is still a name, and a lone surname still completes to it.
   */
  it("still completes a surname the beat itself writes out in full", () => {
    const beat = "Adolf Hitler signed the order in the Berlin bunker.";
    const ctx = emptyQueryContext(beat);
    ctx.persons.push(provenToken("Adolf Hitler", "person", "scene_text", beat));
    const queries = withSearchProvenance(ctx, () =>
      buildHistoricalArchivalQueries(
        intent({
          beatText: beat,
          videoTitle: "Inside The Final Hours Of Adolf Hitler",
          powerWord: "Hitler",
          searchQueries: ["Hitler bunker"],
        }),
        beat
      )
    );
    expect(
      queries.join(" | ").toLowerCase(),
      "a name the beat states in full no longer reaches a provider"
    ).toContain("adolf hitler");
  });
});
