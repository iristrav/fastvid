import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PERSON_PRONOUNS,
  buildPrioritisedQueries,
  checkPersonName,
  emptyQueryContext,
  formatSearchQueryRejected,
  isTitleCasedText,
  provenToken,
  validateSearchQuery,
} from "./searchQueryContract";
import {
  buildVerifiedQueryContextForBeat,
  extractPersonNamesFromText,
  extractPrimaryPersonFromText,
  typedQueryPrefix,
} from "./videoPipeline";

/**
 * RONDE 88 — a search term is proven, or it is not sent.
 *
 * Every case below is a MEASURED output from the RONDE 87 forensic audit, not an invented one.
 * The four person-name failures and the pronoun failure all reached real providers:
 *
 *   "Why Hitler Married Eva Braun Just Before The End"  ->  person "Eva Braun Just"
 *   "Inside The Final Hours Of Adolf Hitler"            ->  person "Of Adolf"
 *   "The Untold Story Of Eva Braun"                     ->  person "Of Eva Braun"
 *   "Why Stalin Purged His Own Generals"                ->  person "Stalin Purged"
 *   "She addressed the nation after the fall of France" ->  query  "She France"
 *
 * Two more were losses rather than fabrications: "Churchill and Roosevelt met at Casablanca"
 * searched for Roosevelt alone, and "Hitler met Eva Braun shortly before the end of the war"
 * produced no query at all.
 */

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const PLAN_SRC = fs.readFileSync(path.join(__dirname, "visualSearchPlan.ts"), "utf8");

const q = (beat: string, opts = {}) => typedQueryPrefix(beat, opts);
const first = (beat: string, opts = {}) => q(beat, opts)[0] ?? "";

/* ═══════════ §1-§5 — de harde prioriteitsvolgorde ═══════════ */

describe("RONDE 88 §1-§5 — PERSON > PLACE > EVENT > ACTION > OBJECT > TIME", () => {
  it("TEST 1 — \"Hitler visited Berlin\" leads with Hitler + Berlin", () => {
    expect(first("Hitler visited Berlin during the war.")).toBe("Hitler Berlin");
    // The action never replaces the name+place combination.
    expect(q("Hitler visited Berlin during the war.")).not.toContain("visited Berlin");
    expect(q("Hitler visited Berlin during the war.")).not.toContain("Berlin visited");
  });

  it("TEST 2 — \"Churchill and Roosevelt met at Casablanca\" keeps BOTH names", () => {
    const queries = q("Churchill and Roosevelt met at Casablanca.");
    expect(queries[0]).toBe("Churchill Roosevelt Casablanca");
    expect(queries).toContain("Churchill Casablanca");
    expect(queries).toContain("Roosevelt Casablanca");
    // Measured before this round: Churchill was dropped entirely.
    expect(queries[0]).toContain("Churchill");
  });

  it("TEST 3 — \"Napoleon Bonaparte crossed the Alps\" leads with the name", () => {
    const queries = q("Napoleon Bonaparte crossed the Alps in 1800.");
    expect(queries[0]).toBe("Napoleon Bonaparte");
    expect(queries.every((x) => x.startsWith("Napoleon Bonaparte"))).toBe(true);
  });

  it("TEST 4 — \"Marie Curie discovered radium in Paris\" leads with name + place", () => {
    expect(first("Marie Curie discovered radium in Paris.")).toBe("Marie Curie Paris");
  });

  it("TEST 17 — a person always precedes a place", () => {
    for (const beat of [
      "Hitler visited Berlin during the war.",
      "Marie Curie discovered radium in Paris.",
      "Churchill spoke in London.",
    ]) {
      const ctx = buildVerifiedQueryContextForBeat(beat);
      const person = ctx.persons[0]!.term;
      const place = ctx.places[0]!.term;
      for (const query of q(beat)) {
        if (!query.includes(person) || !query.includes(place)) continue;
        expect(query.indexOf(person), `${query}: place before person`).toBeLessThan(query.indexOf(place));
      }
    }
  });

  it("TEST 18 — a country is treated as a place, behind the person", () => {
    const queries = q("Hitler invaded Poland in 1939.");
    expect(queries[0]).toBe("Hitler Poland");
    expect(queries).toContain("Hitler Poland 1939");
    expect(queries).not.toContain("invaded Poland 1939");
    expect(queries).not.toContain("Poland invaded");
  });

  it("TEST 19 — person + place come before the action", () => {
    const queries = q("Hitler visited Berlin during the war.");
    const nameAndPlace = queries.indexOf("Hitler Berlin");
    const withAction = queries.indexOf("Hitler Berlin visited");
    expect(nameAndPlace).toBeGreaterThanOrEqual(0);
    expect(withAction).toBeGreaterThan(nameAndPlace);
  });

  it("TEST 5b — no person, but a named event that carries the place, leads with the event", () => {
    const queries = q("The Battle of Berlin began on 16 April 1945.");
    expect(queries[0]).toBe("Battle of Berlin 1945");
    expect(queries).toContain("Battle of Berlin");
  });
});

/* ═══════════ §8-§9 — persoonsextractie ═══════════ */

describe("RONDE 88 §8-§9 — a name is proven or it is not a name", () => {
  it("TEST 5 — a pronoun is NEVER a person", () => {
    const beat = "She addressed the nation after the fall of France.";
    expect(buildVerifiedQueryContextForBeat(beat).persons.filter((p) => p.verified)).toEqual([]);
    expect(extractPersonNamesFromText(beat)).not.toContain("She");
    // Measured before this round: the beat's first provider query was "She France".
    for (const query of q(beat)) expect(query).not.toMatch(/\bShe\b/);
  });

  it("TEST 5c — every forbidden pronoun is refused as a person", () => {
    for (const p of FORBIDDEN_PERSON_PRONOUNS) {
      const capitalised = p[0]!.toUpperCase() + p.slice(1);
      expect(checkPersonName(`${capitalised} Braun`, `${capitalised} Braun spoke.`).ok, p).toBe(false);
    }
  });

  it("TEST 6 — \"Why Hitler Married Eva Braun Just Before The End\" never yields \"Eva Braun Just\"", () => {
    const title = "Why Hitler Married Eva Braun Just Before The End";
    expect(extractPrimaryPersonFromText(title)).not.toBe("Eva Braun Just");
    expect(extractPersonNamesFromText(title)).not.toContain("Eva Braun Just");
    expect(checkPersonName("Eva Braun Just", title).ok).toBe(false);
    expect(checkPersonName("Eva Braun Just", title).reason).toBe("function_word");
  });

  it("TEST 7 — \"Inside The Final Hours Of Adolf Hitler\" never yields \"Of Adolf\"", () => {
    const title = "Inside The Final Hours Of Adolf Hitler";
    expect(extractPrimaryPersonFromText(title)).not.toBe("Of Adolf");
    expect(extractPersonNamesFromText(title)).not.toContain("Of Adolf");
    expect(extractPersonNamesFromText(title)).not.toContain("Of Adolf Hitler");
  });

  it("TEST 8 — \"The Untold Story Of Eva Braun\" never yields \"Of Eva Braun\"", () => {
    const title = "The Untold Story Of Eva Braun";
    expect(extractPrimaryPersonFromText(title)).not.toBe("Of Eva Braun");
    expect(extractPersonNamesFromText(title)).not.toContain("Of Eva Braun");
  });

  it("TEST 9 — \"Why Stalin Purged His Own Generals\" never yields \"Stalin Purged\"", () => {
    const title = "Why Stalin Purged His Own Generals";
    expect(extractPrimaryPersonFromText(title)).not.toBe("Stalin Purged");
    expect(extractPersonNamesFromText(title)).not.toContain("Stalin Purged");
    expect(extractPersonNamesFromText(title)).not.toContain("Own Generals");
  });

  it("TEST 9b — the protection is structural, not a word list", () => {
    // A title nobody has ever seen, with a verb nobody put on any list.
    const invented = "Why Zorbulon Frobnicated His Own Ministers";
    expect(extractPersonNamesFromText(invented)).not.toContain("Zorbulon Frobnicated");
    // The pipeline judges Title Case with its own verb vocabulary plus regular past-tense
    // morphology, which is why a verb nobody ever listed is still refused as a name token.
    const isKnownVerb = (t: string) => t.length >= 6 && t.toLowerCase().endsWith("ed");
    expect(checkPersonName("Zorbulon Frobnicated", invented, "", { isKnownVerb }).ok).toBe(false);
    // Title Case is what makes it unprovable; the same words in a sentence, corroborated, pass.
    expect(isTitleCasedText(invented)).toBe(true);
    expect(checkPersonName("Zorbulon Frobnicated", invented, "Zorbulon Frobnicated wrote it.", { isKnownVerb }).ok).toBe(true);
  });

  it("TEST 10 — \"Hitler met Eva Braun\" produces queries, and keeps both names in order", () => {
    const beat = "Hitler met Eva Braun shortly before the end of the war.";
    const queries = q(beat);
    // Measured before this round: ZERO queries — every combination needed a place or a year.
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]).toBe("Hitler Eva Braun");
  });
});

/* ═══════════ §7/§11 — de titel is geen bewijs ═══════════ */

describe("RONDE 88 §7/§11 — a title cannot put a person in a beat", () => {
  it("TEST 14 — a title person without beat evidence never reaches a query", () => {
    const beat = "She addressed the nation after the fall of France.";
    const queries = typedQueryPrefix(beat, {
      forcePerson: "Eva Braun Just",
      scenePersons: ["Adolf Hitler"],
    });
    // Both were measured in real query lists for this very beat.
    for (const query of queries) {
      expect(query).not.toContain("Eva Braun");
      expect(query).not.toContain("Adolf Hitler");
    }
  });

  it("TEST 14b — a scene person IS allowed when the scene text proves the connection", () => {
    const beat = "He then dictated his political testament in Berlin.";
    const withProof = typedQueryPrefix(beat, {
      scenePersons: ["Adolf Hitler"],
      sceneText: "Adolf Hitler remained in the bunker. He then dictated his political testament.",
    });
    expect(withProof.some((x) => x.includes("Adolf Hitler"))).toBe(true);
    const withoutProof = typedQueryPrefix(beat, { scenePersons: ["Adolf Hitler"] });
    expect(withoutProof.some((x) => x.includes("Adolf Hitler"))).toBe(false);
  });

  it("TEST 14c — an unproven scene person is recorded as unverified, not silently dropped", () => {
    // scenePersons is assembled from the scene AND the video title, so on a beat that names
    // nobody it is an inference. It is kept, marked, and refused — never quietly dropped, so the
    // rejection can name the route that produced it.
    const ctx = buildVerifiedQueryContextForBeat("The city burned.", { scenePersons: ["Adolf Hitler"] });
    const token = ctx.persons.find((p) => p.term === "Adolf Hitler")!;
    expect(token.verified).toBe(false);
    expect(token.source).toBe("title_inference");
  });

  it("TEST 14e — an explicit person-targeted fetch IS proven context", () => {
    // forcePerson means the caller is fetching footage OF this person — a celebrity fetch for
    // Adolf Hitler is about Adolf Hitler by definition. That is the caller's own established
    // context, not a guess about the sentence, and it is a different claim from scenePersons.
    const ctx = buildVerifiedQueryContextForBeat("The city burned.", { forcePerson: "Adolf Hitler" });
    expect(ctx.persons.find((p) => p.term === "Adolf Hitler")!.verified).toBe(true);
    // But a sentence fragment cannot be laundered in through that door.
    const bad = buildVerifiedQueryContextForBeat("The city burned.", { forcePerson: "Eva Braun Just" });
    expect(bad.persons.find((p) => p.term === "Eva Braun Just")!.verified).toBe(false);
  });
});

/* ═══════════ §15/§16 — provenance en de validator ═══════════ */

describe("RONDE 88 §15/§16 — every content word is traceable", () => {
  it("TEST 12 — an unverified term is REJECTED", () => {
    const ctx = emptyQueryContext();
    ctx.persons.push(provenToken("Hitler", "person", "beat_text"));
    const verdict = validateSearchQuery("Hitler Stalingrad", ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("UNVERIFIED_TERM");
    expect(verdict.offendingTerm).toBe("Stalingrad");
  });

  it("TEST 13 — an LLM-generated term is REJECTED and named as such", () => {
    const ctx = emptyQueryContext();
    ctx.objects.push({ term: "empty harbor", type: "object", source: "llm_generated", verified: false });
    const verdict = validateSearchQuery("empty harbor", ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("LLM_GENERATED_TERM");
  });

  it("TEST 14d — a title-derived term is REJECTED with its own reason", () => {
    const ctx = emptyQueryContext();
    ctx.persons.push({ term: "Eva Braun", type: "person", source: "title_inference", verified: false });
    const verdict = validateSearchQuery("Eva Braun France", ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("TITLE_INFERENCE_NOT_ALLOWED");
  });

  it("TEST 12b — a pronoun is refused even with no context at all", () => {
    expect(validateSearchQuery("She France").ok).toBe(false);
    expect(validateSearchQuery("She France").reason).toBe("FORBIDDEN_PRONOUN");
    expect(validateSearchQuery("").reason).toBe("EMPTY_QUERY");
  });

  it("TEST 12c — the one permitted technical term passes, and only behind an entity", () => {
    const ctx = emptyQueryContext();
    ctx.persons.push(provenToken("Hitler", "person", "beat_text"));
    expect(validateSearchQuery("Hitler archival footage", ctx).ok).toBe(true);
    // buildPrioritisedQueries never emits the technical term on its own.
    expect(buildPrioritisedQueries(emptyQueryContext())).toEqual([]);
  });

  it("TEST 12d — the rejection log names the term, the source and the reason", () => {
    const line = formatSearchQueryRejected({
      renderId: "536", sceneIndex: 7, beatIndex: 3,
      query: "Eva Braun Just France", offendingTerm: "Eva Braun Just",
      termSource: "title_inference", reason: "TITLE_INFERENCE_NOT_ALLOWED",
    });
    expect(line).toContain("[SearchQueryRejected]");
    expect(line).toContain('term="Eva Braun Just"');
    expect(line).toContain("termSource=title_inference");
    expect(line).toContain("reason=TITLE_INFERENCE_NOT_ALLOWED");
    expect(line).toContain("verified=false");
  });
});

/* ═══════════ §6/§10/§17/§18 — geen gok, geen metafoor, één contract ═══════════ */

describe("RONDE 88 §6/§10/§17/§18 — no guessing anywhere", () => {
  it("TEST 20 — a beat that proves nothing gets NO query, not a guess", () => {
    for (const beat of ["It ended.", "Everything changed.", "And so it was."]) {
      expect(q(beat), beat).toEqual([]);
    }
  });

  it("TEST 11 — a Dutch beat still recognises the place", () => {
    const ctx = buildVerifiedQueryContextForBeat("Hij bezocht Amsterdam tijdens de oorlog.");
    expect(ctx.places.map((p) => p.term)).toContain("Amsterdam");
    // And "Hij" is not a person — the pronoun rule is not English-only in effect here, because
    // no Dutch pronoun is name-shaped evidence either.
    expect(ctx.persons.filter((p) => p.verified)).toEqual([]);
  });

  it("TEST 13b — the metaphorical-equivalents route is gone", () => {
    expect(PLAN_SRC).not.toContain("metaphorical equivalents");
    expect(PLAN_SRC).not.toContain('{ label: "visual-equiv", items: plan.fallback }');
    expect(PLAN_SRC).toContain("do NOT invent subjects");
  });

  it("TEST 16 — primary and rescue derive from the same proven terms", () => {
    // Both routes call the same builder; there is no second interpretation of the beat.
    const beat = "Hitler visited Berlin during the war.";
    expect(typedQueryPrefix(beat)).toEqual(
      buildPrioritisedQueries(buildVerifiedQueryContextForBeat(beat)).map((x) => x.query)
    );
  });

  it("TEST 17b — every provider search passes the central validator", () => {
    // cachedProviderSearch is the single point all twelve provider searches funnel through.
    const idx = PIPELINE_SRC.indexOf("export async function cachedProviderSearch<T>(");
    expect(idx).toBeGreaterThan(-1);
    const body = PIPELINE_SRC.slice(idx, PIPELINE_SRC.indexOf("\n}", idx));
    // RONDE 89 renamed the local to `text` when the gate began accepting a query OBJECT as well
    // as a string. The property asserted — the gate validates before it sends — is unchanged.
    expect(body).toContain("validateSearchQuery(text)");
    expect(body).toContain("formatSearchQueryRejected(");
  });

  it("TEST 15 — two renders of the same beat produce identical, independent queries", () => {
    const beat = "Hitler visited Berlin during the war.";
    const a = buildVerifiedQueryContextForBeat(beat);
    const b = buildVerifiedQueryContextForBeat(beat);
    expect(a).not.toBe(b);
    expect(typedQueryPrefix(beat)).toEqual(typedQueryPrefix(beat));
    // Mutating one render's context cannot affect another's.
    a.persons[0]!.term = "MUTATED";
    expect(b.persons[0]!.term).toBe("Hitler");
  });
});

/* ═══════════ §22 — de eerdere rondes staan nog ═══════════ */

describe("RONDE 88 §22 — ranking, concurrency and lineage untouched", () => {
  it("TEST 20b — the RONDE 83-87 anchors are all still in place", () => {
    for (const anchor of [
      "export function scoreCandidateAgainstBeat(",
      "rankCuratedPicksByBeatContext(ranked, curatedRankCtx)",
      "export const ARCHIVE_PREPARE_ATTEMPTS_MAX = 6;",
      "if (queue.length >= prepareCap) break;",
      "const visualLimit = pLimit(perf.sceneParallelism);",
      "const beatLimit = pLimit(beatConcurrency);",
      "return withGlobalMediaFetch(() => downloadToFileStreamingInner(",
      "ledger.markFinalVideo(deliveredClips)",
    ]) {
      expect(PIPELINE_SRC, anchor).toContain(anchor);
    }
    expect((PIPELINE_SRC.match(/tpad=stop_mode=clone/g) ?? []).length).toBe(1);
  });
});
