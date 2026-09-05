/**
 * RONDE 88A P3 + P4 — WHERE A QUERY CAME FROM, AND WHETHER IT ASKS FOR ANYTHING.
 *
 * ── P3: three fields that were never filled ─────────────────────────────────────────────────
 *
 *     [SearchQueryAudit] render=- scene=? beat=? provider=pexels …
 *
 * Every line of render 568. Not scope loss — nobody ever passed them. `searchGateDecision` minted
 * its ticket with `{ route }` and nothing else, `formatSearchQueryRejected` was called with no
 * scope arguments at all, and `VerifiedQueryContext` deliberately says what a beat PROVES rather
 * than which beat it is. An audit that cannot name the beat cannot be chased back to a shot.
 *
 * ── P4: 128 queries built to be thrown away ─────────────────────────────────────────────────
 *
 *     reason=NO_CONTENT_ANCHOR   documentary ×68   establishing ×40   historical ×20
 *
 * The gate was right all 128 times: "documentary" is a genre, "wide establishing aerial" is a
 * camera instruction, and neither points at anything. Being right after the work is done is not
 * the same as the work not being done. Both generators in `pipelineSelfHeal` append shot
 * vocabulary to a subject and neither ever asked whether the subject was one — measured directly:
 *
 *     buildDocumentaryShotQueries("documentary", 0)
 *       -> ["documentary wide establishing aerial", …]          NO_CONTENT_ANCHOR
 *     buildEmergencyGeoStockQueries("documentary", "documentary")
 *       -> ["documentary documentary footage", "documentary"]   NO_CONTENT_ANCHOR ×2
 *
 * The second output is the literal string the audit counted 68 times.
 *
 * The check is the validator's own rule H, lifted into `hasContentAnchor` and CALLED by rule H, so
 * the generator and the gate cannot answer differently. The gate is not relaxed by any of this: a
 * query that reaches it is judged exactly as before.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  emptyQueryContext,
  formatSearchQueryAudit,
  formatSearchQueryLog,
  formatSearchQueryRejected,
  hasContentAnchor,
  validateSearchQuery,
  withQueryScope,
  getQueryScope,
} from "./searchQueryContract";
import { buildDocumentaryShotQueries, buildEmergencyGeoStockQueries } from "./pipelineSelfHeal";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const POOL = fs.readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
const CONTRACT = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");

/* ═══════════════ P3 — the log says which render, scene and beat ═══════════════ */

const audit = (meta: Partial<Parameters<typeof formatSearchQueryAudit>[0]> = {}) =>
  formatSearchQueryAudit({ query: "berlin 1945", verified: false, ...meta });

describe("a query line names where it happened", () => {
  it("says nothing it cannot know, outside any scope", () => {
    expect(audit()).toContain("render=- scene=? beat=?");
  });

  it("takes the render, scene and beat from the ambient scope", () => {
    const line = withQueryScope({ videoId: 568, sceneIndex: 1, beatIndex: 6 }, () => audit());
    expect(line).toContain("render=568 scene=1 beat=6");
  });

  /** Beat 0 and scene 0 are real answers; `??` on a number is the classic way to lose them. */
  it("does not mistake index 0 for absent", () => {
    expect(withQueryScope({ sceneIndex: 0, beatIndex: 0 }, () => audit())).toContain("scene=0 beat=0");
  });

  /** A caller that knows better than the ambient scope wins. */
  it("lets an explicit value override the scope", () => {
    const line = withQueryScope({ videoId: 568, sceneIndex: 1, beatIndex: 6 }, () =>
      audit({ sceneIndex: 4 })
    );
    expect(line).toContain("scene=4");
    expect(line).toContain("render=568");
  });

  /** The pool states a scene and no beat; a beat scope inside it must not lose the scene. */
  it("merges an inner scope onto the outer one", () => {
    const line = withQueryScope({ videoId: 568, sceneIndex: 2 }, () =>
      withQueryScope({ beatIndex: 9 }, () => audit())
    );
    expect(line).toContain("render=568 scene=2 beat=9");
  });

  it("an empty scope does not shadow the one around it", () => {
    const line = withQueryScope({ videoId: 568, sceneIndex: 2 }, () =>
      withQueryScope({}, () => audit())
    );
    expect(line).toContain("render=568 scene=2");
    expect(withQueryScope({}, () => getQueryScope())).toEqual({});
  });

  /** All three lines, so a reader can join them. */
  it("scopes the rejected line and the admitted line too", () => {
    withQueryScope({ videoId: 568, sceneIndex: 1, beatIndex: 6 }, () => {
      expect(
        formatSearchQueryRejected({ query: "q", reason: "UNVERIFIED_TERM" })
      ).toContain("render=568 scene=1 beat=6");
      expect(formatSearchQueryLog({ query: "q" })).toContain("render=568 scene=1 beat=6");
    });
  });

  it("does not leak a scope out of its own call", () => {
    withQueryScope({ videoId: 568, sceneIndex: 1 }, () => undefined);
    expect(audit()).toContain("render=- scene=? beat=?");
  });
});

describe("the scope is opened where the beat is known", () => {
  /** The leaf RONDE 100B chose for the provenance, for the reason it gives there. */
  it("withBeatProvenance opens it from the beat it already has", () => {
    const at = PIPE.indexOf("function withBeatProvenance<T>(");
    expect(at).toBeGreaterThan(-1);
    const body = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(body).toContain("withQueryScope(");
    expect(body).toContain("sceneIndex: scene.index");
    expect(body).toContain("beatIndex: beat.index");
    expect(body).toContain("getActiveVideoId()");
  });

  /** The pool runs above the beat loop and has always had its scene index in hand. */
  it("the scene candidate pool states its scene", () => {
    const at = POOL.indexOf("export async function buildSceneCandidatePool(");
    expect(at).toBeGreaterThan(-1);
    const body = POOL.slice(at, at + 1600);
    expect(body).toContain("withQueryScope({ videoId: getActiveVideoId(), sceneIndex: req.sceneIndex }");
  });

  /** The ticket carries it too, so anything reading a ticket sees the same answer as the log. */
  it("the gate mints its ticket with the scope", () => {
    const at = CONTRACT.indexOf("export function searchGateDecision(");
    const body = CONTRACT.slice(at, CONTRACT.indexOf("\n}", at));
    expect(body).toContain("const scope = getQueryScope();");
    expect(body).toContain("mintVerifiedQuery(text, ambient, meta)");
    expect(body).not.toContain("mintVerifiedQuery(text, ambient, { route })");
  });
});

/* ═══════════════ P4 — a query has to ask for something ═══════════════ */

describe("hasContentAnchor knows a subject from a way of filming it", () => {
  it("refuses genre and camera vocabulary", () => {
    for (const q of [
      "documentary",
      "establishing",
      "historical",
      "archival footage",
      "wide establishing aerial",
      "documentary b-roll",
      "",
      "   ",
    ]) {
      expect(hasContentAnchor(q), `"${q}" was treated as a subject`).toBe(false);
    }
  });

  it("accepts a real subject, with or without shot vocabulary around it", () => {
    for (const q of [
      "berlin",
      "Berlin wide establishing aerial",
      "Führerbunker",
      "documentary about stalin",
    ]) {
      expect(hasContentAnchor(q), `"${q}" was treated as subject-less`).toBe(true);
    }
  });

  /**
   * ONE DEFINITION, NOT TWO. If the generator's check and the gate's check ever disagree, the
   * generator either drops queries the gate would have sent or keeps building ones it refuses —
   * and the second is the defect this whole item is about.
   */
  it("agrees with the gate's rule H on every case", () => {
    const cases = [
      "documentary", "establishing", "historical", "b-roll", "archival footage",
      "wide establishing aerial", "close up", "berlin", "Berlin aerial", "stalin 1945",
      "the of and", "footage", "Führerbunker", "documentary footage of berlin",
    ];
    for (const q of cases) {
      const gateSaysAnchorless =
        validateSearchQuery(q, emptyQueryContext("zzz")).reason === "NO_CONTENT_ANCHOR";
      expect(gateSaysAnchorless, `disagreement on "${q}"`).toBe(!hasContentAnchor(q));
    }
  });
});

describe("the shot-query generator stops building queries about nothing", () => {
  /** The exact input render 568's audit was full of. */
  it("returns nothing for a genre word", () => {
    for (const base of ["documentary", "historical", "establishing", "archival footage", "b-roll"]) {
      expect(buildDocumentaryShotQueries(base, 0), `"${base}" still produced queries`).toEqual([]);
    }
  });

  /** And is unchanged for a real subject — the fix must not cost the pipeline its queries. */
  it("still builds its two variants for a real subject", () => {
    const out = buildDocumentaryShotQueries("Berlin", 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Berlin");
    expect(out.every(hasContentAnchor)).toBe(true);
  });

  /** The length test was the only guard, and every one of these words is longer than four. */
  it("does not rely on length to catch a genre word", () => {
    expect("documentary".length).toBeGreaterThan(4);
    expect(buildDocumentaryShotQueries("documentary", 0)).toEqual([]);
  });

  it("never emits an anchor-less query for any beat index", () => {
    for (let beat = 0; beat < 6; beat++) {
      for (const base of ["documentary", "Berlin", "the Reichstag", "footage", "Stalin"]) {
        for (const q of buildDocumentaryShotQueries(base, beat)) {
          expect(hasContentAnchor(q), `beat ${beat} "${base}" -> "${q}"`).toBe(true);
        }
      }
    }
  });
});

describe("the emergency stock generator stops building queries about nothing", () => {
  /** "documentary documentary footage" and a bare "documentary" — both measured, both gone. */
  it("drops the anchor-less queries a genre-word title produced", () => {
    const out = buildEmergencyGeoStockQueries("documentary", "documentary");
    expect(out).not.toContain("documentary");
    expect(out.every(hasContentAnchor), JSON.stringify(out)).toBe(true);
  });

  it("still answers for a real place", () => {
    const out = buildEmergencyGeoStockQueries("Berlin", "Berlin");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(hasContentAnchor), JSON.stringify(out)).toBe(true);
  });

  it("never emits an anchor-less query", () => {
    for (const t of ["documentary", "Berlin", "", "historical footage", "Stalin's Moscow"]) {
      for (const q of buildEmergencyGeoStockQueries(t, t)) {
        expect(hasContentAnchor(q), `"${t}" -> "${q}"`).toBe(true);
      }
    }
  });
});

/* ═══════════════ RONDE 95 — a query with no subject is refused with or without a context ═══════════════ */

describe("RONDE 95 — the content anchor needs no context, and no longer waits for one", () => {
  /**
   * THE GAP, MEASURED BEFORE IT WAS CLOSED.
   *
   * `hasContentAnchor("documentary")` already answered false, while
   * `validateSearchQuery("documentary")` answered `{ ok: true }` — because rule H sat BELOW the
   * `if (!ctx) return { ok: true }` early return. Any caller that could not supply a proven
   * context had "documentary", "historical footage" and "documentary wide establishing aerial"
   * accepted as valid searches, which is the exact shape of the render-568 queries this contract
   * exists to stop.
   *
   * The rule needs no context: it asks whether the query's own words contain anything but
   * production vocabulary and function words. Its position below the early return was an ordering
   * accident, and these tests keep it above.
   */
  it.each([
    "documentary",
    "documentary wide establishing aerial",
    "historical footage",
    "archival footage b-roll",
    "wide establishing shot",
    "aerial",
  ])("refuses %j with no context at all", (query) => {
    const verdict = validateSearchQuery(query);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("NO_CONTENT_ANCHOR");
  });

  /** Camera vocabulary may MODIFY a real subject; it may not BE the subject. */
  it("allows camera vocabulary once a real subject is present", () => {
    expect(validateSearchQuery("Fuhrerbunker Berlin aerial").ok).toBe(true);
    expect(validateSearchQuery("documentary Fuhrerbunker").ok).toBe(true);
  });

  /** The generator-side check and the gate-side check stay one definition, never two. */
  it("the two checks agree on every case", () => {
    for (const q of [
      "documentary",
      "historical footage",
      "Fuhrerbunker",
      "Fuhrerbunker Berlin aerial",
      "wide establishing",
      "Churchill 1940",
    ]) {
      const anchored = hasContentAnchor(q);
      const verdict = validateSearchQuery(q);
      const refusedForAnchor = verdict.ok === false && verdict.reason === "NO_CONTENT_ANCHOR";
      expect(refusedForAnchor, `${q}: the two checks disagree`).toBe(!anchored);
    }
  });

  /** One implementation. A second copy of the rule is how the two come to disagree. */
  it("the validator asks the helper rather than re-deriving the rule", () => {
    const SRC = fs.readFileSync(path.join(__dirname, "searchQueryContract.ts"), "utf8");
    const at = SRC.indexOf("export function validateSearchQuery(");
    const body = SRC.slice(at, SRC.indexOf("\n}\n", at));
    expect([...body.matchAll(/hasContentAnchor\(/g)].length).toBe(1);
    expect(body.indexOf("hasContentAnchor(")).toBeLessThan(body.indexOf("if (!ctx) return"));
  });
});
