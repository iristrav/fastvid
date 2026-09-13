import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PROVIDER_CAPABILITIES,
  providerFitForNeed,
  orderResearchTasksByNeed,
} from "./providerCapability";
import { mediaFormsForIntent } from "./beatVisualIntent";

/**
 * BREADTH OF A FORM LIST IS NOT SUITABILITY.
 *
 * ── What was measured ───────────────────────────────────────────────────────────────────────
 *
 * The routing was computed against the real registry for a dated beat, and NASA came first:
 *
 *     1. nasa               fit=1.000
 *     2. youtube (entity)   fit=0.833
 *     3. internet archive   fit=0.833
 *     4. europeana          fit=0.833
 *
 * Not because NASA suits a beat about 1945, but because it declares ARCHIVAL_FOOTAGE,
 * REAL_FOOTAGE, PHOTO, OBJECT and B_ROLL — which happens to cover an archival need completely.
 * `providerFitForNeed` rewarded the BREADTH OF THE DECLARED LIST, so the source that claims the
 * most forms won, whatever it is about. On a beat about Berlin that is a task slot spent on
 * spaceflight footage, inside a budget that only runs ten to eighteen of fourteen tasks.
 *
 * ── The rule, and why it names no subject ───────────────────────────────────────────────────
 *
 * `subjectScope` says whether a source covers subject matter broadly or holds one slice of it.
 * "internet_archive holds everything" and "NASA holds spaceflight" are facts about the SOURCES —
 * equally true for a video about Japan's economy and one about a bunker. Nothing here asks what
 * the beat is about, and no subject appears anywhere.
 *
 * A specialist is not demoted. It keeps its place in the round, is still asked, and its candidates
 * are still ranked on their own merits. It is only no longer promoted to the FRONT on form-fit it
 * may have no way to realise.
 */

describe("every source declares how wide its subject matter is", () => {
  it("each entry states a scope — the field is required, so it cannot be forgotten", () => {
    for (const [key, cap] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(["GENERAL", "SPECIALIST"], `${key} has no valid scope`).toContain(cap.subjectScope);
    }
  });

  it("the specialists are the sources bound to one slice of subject matter", () => {
    expect(PROVIDER_CAPABILITIES.nasa!.subjectScope).toBe("SPECIALIST");
    expect(PROVIDER_CAPABILITIES.mediaccc!.subjectScope).toBe("SPECIALIST");
    expect(PROVIDER_CAPABILITIES.own_archive!.subjectScope).toBe("SPECIALIST");
  });

  it("and a source bounded by GEOGRAPHY or by NATION is not thereby a specialist", () => {
    /**
     * The distinction that keeps this honest. Europeana covers all of European culture and NARA
     * the whole American record — broad in subject, bounded in territory. Calling those specialist
     * would bury two real archives on exactly the beats they are best at.
     */
    expect(PROVIDER_CAPABILITIES.europeana!.subjectScope).toBe("GENERAL");
    expect(PROVIDER_CAPABILITIES.nara!.subjectScope).toBe("GENERAL");
    expect(PROVIDER_CAPABILITIES.internet_archive!.subjectScope).toBe("GENERAL");
    expect(PROVIDER_CAPABILITIES.youtube_cc!.subjectScope).toBe("GENERAL");
  });

  it("NO SUBJECT IS NAMED — the rule is about sources, not about topics", () => {
    const SRC = readFileSync(join(__dirname, "providerCapability.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of ["ww2", "hitler", "1945", "japan", "berlin", "napoleon"]) {
      expect(SRC.toLowerCase(), `the registry's code names "${banned}"`).not.toContain(banned);
    }
  });
});

describe("the specialist no longer wins the round on breadth", () => {
  const dated = mediaFormsForIntent({ period: ["1945"] });

  it("NASA WAS 1.000 ON A DATED BEAT AND IS NOW 0.600", () => {
    expect(providerFitForNeed("nasa", dated)).toBeCloseTo(0.6, 3);
  });

  it("which puts it behind the general archives and Wikimedia", () => {
    const nasa = providerFitForNeed("nasa", dated)!;
    expect(nasa).toBeLessThan(providerFitForNeed("internet_archive", dated)!);
    expect(nasa).toBeLessThan(providerFitForNeed("europeana", dated)!);
    expect(nasa).toBeLessThan(providerFitForNeed("wikimedia", dated)!);
  });

  it("AND STILL AHEAD OF STOCK — a discount, not a refusal", () => {
    /**
     * 0.6 and not 0. NASA genuinely can supply archival footage, and a beat that no general archive
     * answers should still reach it before a stock library that cannot supply the form at all.
     */
    const nasa = providerFitForNeed("nasa", dated)!;
    expect(nasa).toBeGreaterThan(providerFitForNeed("pexels", dated)!);
    expect(nasa).toBeGreaterThan(providerFitForNeed("pixabay", dated)!);
  });

  it("a GENERAL source is not discounted at all", () => {
    expect(providerFitForNeed("internet_archive", dated)).toBeCloseTo(0.833, 2);
    expect(providerFitForNeed("youtube_cc", dated)).toBeCloseTo(0.833, 2);
  });

  it("and the discount cannot make a fit negative or exceed one", () => {
    for (const need of [
      mediaFormsForIntent({ period: ["1945"] }),
      mediaFormsForIntent({ people: ["Curie"] }),
      mediaFormsForIntent({ event: ["the vote"] }),
      mediaFormsForIntent({ objects: ["a press"] }),
    ]) {
      for (const p of Object.keys(PROVIDER_CAPABILITIES)) {
        const fit = providerFitForNeed(p, need);
        if (fit == null) continue;
        expect(fit, p).toBeGreaterThanOrEqual(0);
        expect(fit, p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the retrieval round is ordered as it should be now", () => {
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
  const ids = (l: readonly { id: string }[]) => l.map((t) => t.id);

  it("ON A DATED BEAT NASA IS NO LONGER ASKED FIRST", () => {
    const out = ids(orderResearchTasksByNeed(round, mediaFormsForIntent({ period: ["1945"] })));
    expect(out[0]).not.toBe("nasa");
    expect(out.indexOf("internet-archive")).toBeLessThan(out.indexOf("nasa"));
    expect(out.indexOf("europeana")).toBeLessThan(out.indexOf("nasa"));
  });

  it("but it is still in the round, ahead of the stock libraries", () => {
    const out = ids(orderResearchTasksByNeed(round, mediaFormsForIntent({ period: ["1945"] })));
    expect(out).toContain("nasa");
    expect(out.indexOf("nasa")).toBeLessThan(out.indexOf("pexels"));
  });

  it("and every task still survives — this is still a reorder", () => {
    for (const need of [
      mediaFormsForIntent({ period: ["1945"] }),
      mediaFormsForIntent({ people: ["Curie"] }),
      mediaFormsForIntent({}),
    ]) {
      const out = orderResearchTasksByNeed(round, need);
      expect(out).toHaveLength(round.length);
      expect(ids(out).sort()).toEqual(ids(round).sort());
    }
  });

  it("a beat that proved nothing still gets the untouched original order", () => {
    expect(ids(orderResearchTasksByNeed(round, mediaFormsForIntent({})))).toEqual(ids(round));
  });
});
