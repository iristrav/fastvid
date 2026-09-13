import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PROVIDER_CAPABILITIES,
  providerCapability,
  providerSuppliesForm,
  providerFitForNeed,
  orderResearchTasksByNeed,
  type CapabilityGrade,
} from "./providerCapability";
import { mediaFormsForIntent } from "./beatVisualIntent";
import { contextualSourcePriority } from "./poolRanking";
import { DEFAULT_SOURCE_PRIORITY } from "./visualMatchingV2/candidateRanking";

/**
 * THE SOURCE IS CHOSEN FOR WHAT THE BEAT NEEDS.
 *
 * ── The defect these tests close ────────────────────────────────────────────────────────────
 *
 * `DEFAULT_SOURCE_PRIORITY` is one fixed order for every beat of every topic:
 *
 *     own_archive 100 · wikimedia 90 · europeana 85 · pexels 80
 *     pixabay 70 · internet_archive 60 · youtube_cc 55 · ai_generated 50
 *
 * On a beat about 1945 that order is provably wrong. Stock footage is shot now — pexels and
 * pixabay cannot supply archival material at all — and both sit above both archives. Render 577
 * filled historical beats from a stock library and the funnel recorded it as working correctly,
 * because nothing in the system knew the beat wanted an archive.
 *
 * ── What must NOT happen ────────────────────────────────────────────────────────────────────
 *
 * The fix must not be "prefer YouTube", and must not be a topic table. Both are asserted below:
 * YouTube gains only where it supplies the form and loses where it does not, and no provider name
 * appears in any rule — the same code moves wikimedia up on a portrait beat and down on a news one.
 */

const GRADES: CapabilityGrade[] = ["GREEN", "YELLOW", "RED", "UNKNOWN"];

/* ═══════════════════ A · the registry is honest ═══════════════════ */

describe("the registry states only what the code can prove", () => {
  it("every entry keys itself and carries its evidence", () => {
    for (const [key, cap] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(cap.provider, `${key} disagrees with its own key`).toBe(key);
      expect(cap.evidence.length, `${key} has no evidence`).toBeGreaterThan(20);
    }
  });

  it("every grade is one of the four — no invented values", () => {
    const fields = [
      "historical", "modern", "people", "events", "locations", "objects",
      "documents", "maps", "news", "metadataQuality", "dateEvidence",
      "placeEvidence", "rightsEvidence", "searchQuality", "downloadCapability",
    ] as const;
    for (const cap of Object.values(PROVIDER_CAPABILITIES)) {
      for (const f of fields) {
        expect(GRADES, `${cap.provider}.${f} = ${cap[f]}`).toContain(cap[f]);
      }
    }
  });

  it("no source supplies nothing — an entry with no media forms has no reason to exist", () => {
    for (const cap of Object.values(PROVIDER_CAPABILITIES)) {
      expect(cap.mediaForms.length, `${cap.provider} supplies nothing`).toBeGreaterThan(0);
    }
  });

  it("UNKNOWN IS NOT 'NO' — an uncharacterised source is reported as unknown, never as false", () => {
    /**
     * The rule the whole design rests on. `providerSuppliesForm` and `providerFitForNeed` return
     * null for a source nobody has characterised, so a router has to decide what to do about it
     * rather than being handed a `false` it will read as a refusal.
     */
    expect(providerCapability("a_source_nobody_has_written")).toBeNull();
    expect(providerSuppliesForm("a_source_nobody_has_written", "PHOTO")).toBeNull();
    expect(
      providerFitForNeed("a_source_nobody_has_written", {
        preferred: ["ARCHIVAL_FOOTAGE"],
        acceptable: ["ARCHIVAL_FOOTAGE", "B_ROLL"],
      })
    ).toBeNull();
  });

  it("STOCK CANNOT SUPPLY ARCHIVAL FOOTAGE — the fact render 577 had nowhere to record", () => {
    expect(providerSuppliesForm("pexels", "ARCHIVAL_FOOTAGE")).toBe(false);
    expect(providerSuppliesForm("pixabay", "ARCHIVAL_FOOTAGE")).toBe(false);
    expect(PROVIDER_CAPABILITIES.pexels!.historical).toBe("RED");
    expect(PROVIDER_CAPABILITIES.pixabay!.historical).toBe("RED");
  });

  it("and the archives can", () => {
    for (const p of ["own_archive", "internet_archive", "europeana", "nara"]) {
      expect(providerSuppliesForm(p, "ARCHIVAL_FOOTAGE"), `${p} cannot`).toBe(true);
    }
  });

  it("YouTube's own unknowns are recorded as unknown, not as working", () => {
    /** The download is not production-proven, and the registry says so rather than assuming. */
    expect(PROVIDER_CAPABILITIES.youtube_cc!.downloadCapability).toBe("UNKNOWN");
    expect(PROVIDER_CAPABILITIES.youtube_cc!.rightsEvidence).toBe("YELLOW");
    expect(PROVIDER_CAPABILITIES.youtube_cc!.metadataQuality).toBe("YELLOW");
  });

  it("generated imagery has RED provenance rather than UNKNOWN provenance", () => {
    /** Nobody needs to characterise this: a generated picture has no date and no place, ever. */
    expect(PROVIDER_CAPABILITIES.ai_generated!.dateEvidence).toBe("RED");
    expect(PROVIDER_CAPABILITIES.ai_generated!.placeEvidence).toBe("RED");
  });

  it("no topic, subject or person appears anywhere in the registry", () => {
    /**
     * The subject-neutrality rule, enforced rather than promised. A registry that mentioned WW2 or
     * Japan would be the hardcoding this architecture exists to remove.
     */
    const text = JSON.stringify(PROVIDER_CAPABILITIES).toLowerCase();
    for (const banned of ["ww2", "hitler", "napoleon", "japan", "trump", "world war"]) {
      expect(text, `the registry names "${banned}"`).not.toContain(banned);
    }
  });
});

/* ═══════════════════ B · fit is a score, never a refusal ═══════════════════ */

describe("fit orders sources and refuses none", () => {
  const dated = mediaFormsForIntent({ period: ["1945"] });

  it("a source that supplies the preferred form beats one that does not", () => {
    const archive = providerFitForNeed("internet_archive", dated)!;
    const stock = providerFitForNeed("pexels", dated)!;
    expect(archive).toBeGreaterThan(stock);
  });

  it("but the weak source still scores above zero — 0 would read as a refusal", () => {
    expect(providerFitForNeed("pexels", dated)!).toBeGreaterThan(0);
  });

  it("every fit is a proportion", () => {
    for (const p of Object.keys(PROVIDER_CAPABILITIES)) {
      const fit = providerFitForNeed(p, dated);
      if (fit == null) continue;
      expect(fit, p).toBeGreaterThanOrEqual(0);
      expect(fit, p).toBeLessThanOrEqual(1);
    }
  });

  it("A BEAT WITH NO OPINION PRODUCES NO FIT AT ALL", () => {
    /** Not a flat zero for everyone — that would be a judgement the beat never made. */
    const none = mediaFormsForIntent({});
    expect(providerFitForNeed("pexels", none)).toBeNull();
    expect(providerFitForNeed("internet_archive", none)).toBeNull();
  });
});

/* ═══════════════════ C · the priority table, re-answered ═══════════════════ */

describe("the source priority answers for THIS beat", () => {
  it("WITHOUT A NEED IT IS THE DEFAULT TABLE, UNCHANGED", () => {
    /**
     * The compatibility guarantee. Every existing caller passes no need, so every existing caller
     * gets exactly the behaviour it had.
     */
    expect(contextualSourcePriority()).toEqual(DEFAULT_SOURCE_PRIORITY);
    expect(contextualSourcePriority(mediaFormsForIntent({}))).toEqual(DEFAULT_SOURCE_PRIORITY);
    expect(contextualSourcePriority(mediaFormsForIntent(null))).toEqual(DEFAULT_SOURCE_PRIORITY);
  });

  it("ON A DATED BEAT THE ARCHIVES PASS THE STOCK LIBRARIES", () => {
    /** The single outcome the audit proved wrong, asserted as the single outcome that changed. */
    const p = contextualSourcePriority(mediaFormsForIntent({ period: ["1945"] }));
    expect(p.internet_archive).toBeGreaterThan(p.pexels);
    expect(p.internet_archive).toBeGreaterThan(p.pixabay);
    expect(p.europeana).toBeGreaterThan(p.pexels);
    expect(p.own_archive).toBeGreaterThan(p.pexels);
  });

  it("and generated imagery falls furthest on a beat that wants the real past", () => {
    const p = contextualSourcePriority(mediaFormsForIntent({ period: ["1945"] }));
    expect(p.ai_generated).toBeLessThan(DEFAULT_SOURCE_PRIORITY.ai_generated);
    expect(p.ai_generated).toBeLessThan(p.internet_archive);
  });

  it("YOUTUBE IS NOT PREFERRED — it gains where it supplies the form and nowhere else", () => {
    /**
     * The rule the round was given twice: YouTube must become strong where it genuinely is the
     * best source, never by artificial preference. On a dated beat it supplies archival footage
     * and moves up; on a beat that wants a photograph it supplies none and does not.
     */
    const archival = contextualSourcePriority(mediaFormsForIntent({ period: ["1945"] }));
    expect(archival.youtube_cc).toBeGreaterThan(DEFAULT_SOURCE_PRIORITY.youtube_cc);
    /** And it still does not outrank the archives, which is the other half of the same rule. */
    expect(archival.youtube_cc).toBeLessThan(archival.internet_archive);
    expect(archival.youtube_cc).toBeLessThan(archival.own_archive);

    const portrait = contextualSourcePriority(mediaFormsForIntent({ people: ["Marie Curie"] }));
    expect(portrait.wikimedia).toBeGreaterThan(portrait.youtube_cc);
  });

  it("a news beat moves the news source up and the archives down", () => {
    /**
     * The same code, the opposite direction — which is what makes it routing rather than a
     * hardcoded preference for archival material.
     */
    const news = contextualSourcePriority(mediaFormsForIntent({ event: ["the vote"] }));
    const archival = contextualSourcePriority(mediaFormsForIntent({ period: ["1945"] }));
    expect(news.youtube_cc).toBeGreaterThan(news.europeana);
    expect(archival.europeana).toBeGreaterThan(archival.youtube_cc);
  });

  it("every priority stays inside the table's own range", () => {
    for (const need of [
      mediaFormsForIntent({ period: ["1945"] }),
      mediaFormsForIntent({ people: ["Curie"] }),
      mediaFormsForIntent({ event: ["the vote"] }),
      mediaFormsForIntent({ location: ["Tokyo"] }),
      mediaFormsForIntent({ action: ["smelting"] }),
    ]) {
      for (const [source, value] of Object.entries(contextualSourcePriority(need))) {
        expect(value, source).toBeGreaterThanOrEqual(0);
        expect(value, source).toBeLessThanOrEqual(100);
      }
    }
  });

  it("and the table keeps exactly the sources the engine knows", () => {
    expect(Object.keys(contextualSourcePriority(mediaFormsForIntent({ period: ["1945"] })).valueOf()).sort()).toEqual(
      Object.keys(DEFAULT_SOURCE_PRIORITY).sort()
    );
  });
});

/* ═══════════════════ D · the round is ordered, never pruned ═══════════════════ */

describe("routing reorders the retrieval round and removes nothing", () => {
  /** The fourteen tasks as the round builds them, in source-code order. */
  const round = [
    { provider: "youtube_cc", id: "yt-entity" },
    { provider: "youtube_cc", id: "yt-query" },
    { id: "celebrity" },
    { provider: "wikimedia", id: "wikimedia-video" },
    { provider: "internet_archive", id: "internet-archive" },
    { provider: "europeana", id: "europeana" },
    { provider: "nasa", id: "nasa" },
    { provider: "wikimedia", id: "wikimedia-images" },
    { provider: "openverse", id: "openverse" },
    { id: "unsplash" },
    { id: "serpapi" },
    { provider: "pexels", id: "stock-combined" },
    { provider: "pexels", id: "pexels" },
    { provider: "pixabay", id: "pixabay" },
  ];

  const ids = (list: readonly { id: string }[]) => list.map((t) => t.id);

  it("EVERY TASK SURVIVES — a reorder, never a filter", () => {
    /**
     * The safety property the whole step rests on. The caller slices the first `maxTasks`, so a
     * function that could DROP a task could silently remove the only route that would have found
     * the shot. This one cannot: the output is a permutation of the input.
     */
    for (const need of [
      mediaFormsForIntent({ period: ["1945"] }),
      mediaFormsForIntent({ people: ["Curie"] }),
      mediaFormsForIntent({ event: ["the vote"] }),
      mediaFormsForIntent({}),
    ]) {
      const out = orderResearchTasksByNeed(round, need);
      expect(out).toHaveLength(round.length);
      expect(ids(out).sort()).toEqual(ids(round).sort());
    }
  });

  it("A BEAT THAT PROVED NOTHING GETS THE ORDER IT ALWAYS HAD", () => {
    /** The compatibility guarantee, at the level of the actual list. */
    expect(ids(orderResearchTasksByNeed(round, mediaFormsForIntent({})))).toEqual(ids(round));
    expect(ids(orderResearchTasksByNeed(round, mediaFormsForIntent(null)))).toEqual(ids(round));
  });

  it("on a dated beat the archives are asked before the stock libraries", () => {
    const out = ids(orderResearchTasksByNeed(round, mediaFormsForIntent({ period: ["1945"] })));
    expect(out.indexOf("internet-archive")).toBeLessThan(out.indexOf("pexels"));
    expect(out.indexOf("europeana")).toBeLessThan(out.indexOf("pexels"));
    expect(out.indexOf("internet-archive")).toBeLessThan(out.indexOf("pixabay"));
  });

  it("AN UNLABELLED TASK KEEPS ITS PLACE AMONG ITS EQUALS", () => {
    /**
     * Three of the fourteen — the celebrity route, Unsplash and SerpAPI — have no registry entry.
     * They must not be buried for being uncharacterised, which is what a `null → 0` reading would
     * have done. They sort as average, so they stay ahead of the sources that genuinely do not
     * answer the need and behind the ones that do.
     */
    const out = ids(orderResearchTasksByNeed(round, mediaFormsForIntent({ period: ["1945"] })));
    expect(out).toContain("celebrity");
    expect(out).toContain("unsplash");
    expect(out).toContain("serpapi");
    expect(out.indexOf("celebrity")).toBeLessThan(out.indexOf("pixabay"));
  });

  it("ties keep their original relative order — the sort is stable", () => {
    const out = ids(orderResearchTasksByNeed(round, mediaFormsForIntent({ period: ["1945"] })));
    expect(out.indexOf("yt-entity")).toBeLessThan(out.indexOf("yt-query"));
    expect(out.indexOf("wikimedia-video")).toBeLessThan(out.indexOf("wikimedia-images"));
    expect(out.indexOf("pexels")).toBeLessThan(out.indexOf("pixabay"));
  });

  it("the same round and the same need always produce the same order", () => {
    const need = mediaFormsForIntent({ period: ["1945"], people: ["Hitler"] });
    expect(ids(orderResearchTasksByNeed(round, need))).toEqual(
      ids(orderResearchTasksByNeed(round, need))
    );
  });

  it("and routing never promotes YouTube on a beat it cannot answer", () => {
    /**
     * An OBJECT beat — "a printing press", "the treaty" — is the honest test of this rule.
     * `youtube_cc` declares no OBJECT form; wikimedia and openverse do, and both pass it.
     *
     * A PERSON beat is NOT such a case, and the first version of this test wrongly used one:
     * YouTube supplies PERSON, and footage of a person is exactly what it is good at. It scored
     * above wikimedia there and the code was right to put it there. The rule being protected is
     * "no artificial preference", not "YouTube last".
     */
    const out = ids(
      orderResearchTasksByNeed(round, mediaFormsForIntent({ objects: ["a printing press"] }))
    );
    expect(out.indexOf("wikimedia-video")).toBeLessThan(out.indexOf("yt-entity"));
    expect(out.indexOf("openverse")).toBeLessThan(out.indexOf("yt-entity"));
  });

  it("but it does promote YouTube where YouTube genuinely is a good answer", () => {
    /** The other half, so this file cannot be read as "keep YouTube down". */
    const news = ids(orderResearchTasksByNeed(round, mediaFormsForIntent({ event: ["the vote"] })));
    expect(news.indexOf("yt-entity")).toBeLessThan(news.indexOf("europeana"));
  });
});

/* ═══════════════════ E · the need has a writer ═══════════════════ */

describe("THE NEED IS ACTUALLY SUPPLIED — this round does not add another reader with no writer", () => {
  /**
   * The defect this codebase keeps finding is a value computed and not carried: `recordClipAdopt`
   * at one call site of five, the beat audit at one, `metadata.publishedAt` at none. A media-form
   * need that nothing ever passes would be the same mistake in a new place — `contextualSourcePriority`
   * would fall back to the default table on every beat and the whole round would be inert.
   *
   * So the chain is asserted end to end, by source: the pipeline builds the need, the pool context
   * declares it, and the pool hands it to the ranking engine.
   */
  const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

  it("the pipeline builds a need for the beat it is selecting for", () => {
    const PIPE = read("videoPipeline.ts");
    expect(PIPE).toContain("mediaFormNeed: mediaFormsForIntent(");
    expect(PIPE).toContain("beatVisualIntent(dedup.beatIntent, scene.index, beat.index)");
  });

  it("the pool's selection context carries it", () => {
    const POOL = read("scenePool.ts");
    expect(POOL).toContain("mediaFormNeed?: {");
    expect(POOL).toContain("...(ctx.mediaFormNeed ? { mediaFormNeed: ctx.mediaFormNeed } : {}),");
  });

  it("AND THE RANKING ENGINE RECEIVES IT", () => {
    const RANK = read("poolRanking.ts");
    expect(RANK).toContain("sourcePriority: contextualSourcePriority(req.mediaFormNeed)");
    expect(RANK).toContain("weights: freshnessAwareWeights(req.mediaFormNeed)");
  });

  it("and the retrieval round is ordered by the same need, from the same builder", () => {
    const PIPE = read("videoPipeline.ts");
    expect(PIPE).toContain("orderResearchTasksByNeed(");
    expect(PIPE).toContain(
      "mediaFormsForIntent(beatVisualIntent(dedup.beatIntent, sceneIndex, beat.index))"
    );
  });
});

/* ═══════════════════ F · nothing was weakened ═══════════════════ */

describe("the ranking engine itself is untouched", () => {
  it("the default table still holds the values it held", () => {
    /**
     * This round re-answers the table per beat; it does not edit it. A changed default would move
     * every beat at once, including the ones nobody measured.
     */
    expect(DEFAULT_SOURCE_PRIORITY).toEqual({
      own_archive: 100,
      wikimedia: 90,
      europeana: 85,
      pexels: 80,
      pixabay: 70,
      internet_archive: 60,
      youtube_cc: 55,
      ai_generated: 50,
    });
  });
});
