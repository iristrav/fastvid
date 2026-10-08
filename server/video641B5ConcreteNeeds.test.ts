import { describe, expect, it } from "vitest";

import * as contract from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";
import { MAX_YOUTUBE_SEARCHES_PER_VIDEO, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { analyzeVideo, validVisualNeeds, type GateVerdict, type PlannerInput, type VisualNeed } from "./youtubeVideoSearchPlanner";
import { buildVideoYoutubePool, type PoolDeps, type SearchItem, type Triage } from "./youtubeVideoPool";

/**
 * VIDEO 641 (B5 REPAIR) — AN IDEA LEAVES A NEED; ITS SCENE DOES NOT.
 *
 * The first B5 cut every setting word from a need that held a name and dropped every role-and-setting
 * need under a sentence that names something. Replayed on 641's six real planner needs:
 *
 *     "Calabasas corporate office"   → "Calabasas"
 *     "Accountants in office"        → (gone)
 *
 * so the only situation 641's sentence 8 describes ("In the Calabasas corporate office, accountants lay
 * out the stark reality …") could no longer reach a targeted search. Idea words still leave
 * ("Kim Kardashian hype creation" → "Kim Kardashian"); a setting stays, and so does an idea word that
 * describes a concrete thing after it ("Kris Jenner brand meeting").
 */

/** 641 as its production log gives it (the endings of [1], [8] and [9] completed). */
const SCRIPT_641: PlannerInput = {
  prompt: "Are the Kardashians really as rich as they seem",
  title: "The Kardashian Wealth Illusion",
  sceneTexts: [
    "Despite their billion-dollar empire, the Kardashians may not be as cash-flush as you think. " +
      "Much of their wealth is tied up in assets that can’t be easily turned into cash—a potential financial house of cards. " +
      "So, are the Kardashians really as rich as they seem?",
    "Much of the Kardashian wealth is an illusion, with assets locked in real estate and ventures controlled by Kris Jenner. " +
      "So, what's holding back their fortune from being more tangible? Let's delve deeper to understand the real financial dynamics. " +
      "Finance analysts reveal that the Kardashians' income relies heavily on volatile social media monetization. " +
      "Their wealth is a mirage shaped by media trends and unpredictable projections.",
    "In the Calabasas corporate office, accountants lay out the stark reality: operational expenses are massive, often overshadowing their earnings. " +
      "While Kim Kardashian excels at hype creation, sustaining that wealth is another story.",
  ],
};
/** The six needs 641's planner returned ([VISUAL_NEEDS] video=641, 2026-10-08 06:21:09). */
const NEEDS_641: VisualNeed[] = [
  { subject: "Kardashians", beats: [0, 3, 6, 7] },
  { subject: "Kris Jenner", beats: [3, 6] },
  { subject: "Calabasas corporate office", beats: [8] },
  { subject: "Finance analysts", beats: [6] },
  { subject: "Kim Kardashian hype creation", beats: [9] },
  { subject: "Accountants in office", beats: [8] },
];

const a641 = analyzeVideo(SCRIPT_641);
const one = (subject: string, beats: number[], input = SCRIPT_641, a = a641) =>
  validVisualNeeds([{ subject, beats }], a, input).map((n) => n.subject);

describe("B5 repair — the cases the audit proved", () => {
  it("the replay is 641's own: ten sentences, sentence 8 is the Calabasas office", () => {
    expect(a641.sentences).toHaveLength(10);
    expect(a641.sentences[8]).toMatch(/^In the Calabasas corporate office, accountants/);
  });

  it("A. a named need keeps its setting: Calabasas corporate office", () => {
    expect(one("Calabasas corporate office", [8])).toEqual(["Calabasas corporate office"]);
  });

  it("B. a role in a setting its own sentence describes is not dropped: Accountants in office", () => {
    expect(one("Accountants in office", [8])).toEqual(["Accountants in office"]);
    /** under a sentence that never puts accountants in an office, it is invented scenery: left out */
    expect(one("Accountants in office", [3])).toEqual([]);
  });

  it("C. an idea word after a name leaves: Kim Kardashian hype creation → Kim Kardashian", () => {
    expect(one("Kim Kardashian hype creation", [9])).toEqual(["Kim Kardashian"]);
  });

  it("D. Finance analysts: an idea word and a role, no setting, under a sentence that names the Kardashians — left out", () => {
    expect(one("Finance analysts", [6])).toEqual([]);
  });

  const DOCS: PlannerInput = {
    prompt: "How Kris Jenner runs the family business",
    title: "Kris Jenner",
    sceneTexts: [
      "Kris Jenner keeps a real estate documents stack on her desk. " +
        "The family signs legal documents and contracts in the boardroom. " +
        "Kris Jenner leads every brand meeting herself. " +
        "Accountants check the financial reports every week.",
    ],
  };
  const aDocs = analyzeVideo(DOCS);
  const at = (needle: string) => aDocs.sentences.findIndex((s) => s.includes(needle));

  it("E. real estate documents stack stays", () => {
    expect(one("real estate documents stack", [at("documents stack")], DOCS, aDocs)).toEqual(["real estate documents stack"]);
  });

  it("F. legal documents contracts boardroom stays", () => {
    expect(one("legal documents contracts boardroom", [at("boardroom")], DOCS, aDocs)).toEqual(["legal documents contracts boardroom"]);
  });

  it("G. Kris Jenner brand meeting stays whole — not cut to Kris Jenner", () => {
    expect(one("Kris Jenner brand meeting", [at("brand meeting")], DOCS, aDocs)).toEqual(["Kris Jenner brand meeting"]);
    /** an idea word that describes a concrete thing stays: financial reports */
    expect(one("financial reports", [at("financial reports")], DOCS, aDocs)).toEqual(["financial reports"]);
  });

  it("H. valid name needs are unchanged", () => {
    expect(one("Kardashians", [0, 3, 6, 7])).toEqual(["Kardashians"]);
    expect(one("Kris Jenner", [3, 6])).toEqual(["Kris Jenner"]);
    expect(one("Kim Kardashian", [9])).toEqual(["Kim Kardashian"]);
    /** an idea before a name still leaves, as before: "wealth of Kris Jenner" → "Kris Jenner" */
    expect(one("wealth of Kris Jenner", [3])).toEqual(["Kris Jenner"]);
  });
});

describe("B5 repair — the contract that stays", () => {
  it("a pure idea is still left out", () => {
    expect(one("wealth illusion", [3])).toEqual([]);
    expect(one("media monetization", [6])).toEqual([]);
    expect(one("Kardashian wealth", [3])).toEqual(["Kardashian"]);
  });

  it("the narration's-own-words rule and the 1–5 word rule are unchanged", () => {
    /** 641's narration never says "documents" or "stack": the planner may not invent them */
    expect(one("real estate documents stack", [1])).toEqual([]);
    expect(one("Calabasas corporate office tower lobby desk", [8])).toEqual([]);
  });

  it("641 replayed: the six real needs", () => {
    expect(validVisualNeeds(NEEDS_641, a641, SCRIPT_641).map((n) => n.subject)).toEqual([
      "Kardashians",
      "Kris Jenner",
      "Calabasas corporate office",
      "Kim Kardashian",
      "Accountants in office",
    ]);
  });
});

/**
 * Production's video-pool gate, exactly as `productionVideoPoolDeps` builds it: the whole narration as
 * evidence, SEARCH_GATE_STRICT's decision and its canonical narrowing. Not `ok: true` — that stand-in
 * admitted "Accountants in office", which the real gate refuses (SUBJECT_NOT_NAMED).
 */
function realGate(input: PlannerInput): (q: string) => GateVerdict {
  const narration = input.sceneTexts.join(" ");
  const ctx = buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt });
  return (query) =>
    contract.withSearchProvenance(ctx, () => {
      const decision = contract.searchGateDecision("youtube", query, "video_pool");
      if (decision.admitted) return { ok: true, sentAs: decision.text };
      const why = contract.validateSearchQuery(query, ctx);
      return { ok: false, reason: why.ok ? "NO_SEARCH_CONTEXT" : why.reason, offendingTerm: why.ok ? undefined : why.offendingTerm };
    });
}

describe("B5 repair — 641's targeted searches, through the existing pool and the real gate (no search is real)", () => {
  function deps(): PoolDeps & { searches: string[] } {
    const searches: string[] = [];
    let asked = 0;
    return {
      searches,
      store: memoryYoutubeSearchBudgetStore(),
      llm: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(
                ++asked === 1
                  ? { mainSubject: "Kardashians", recurringSubjects: [], query: "Kim Kardashian", visualNeeds: NEEDS_641 }
                  : { mainSubject: "Kardashians", recurringSubjects: [], query: "Kris Jenner Calabasas" }
              ),
            },
          },
        ],
      }),
      gate: realGate(SCRIPT_641),
      search: async (query) => {
        searches.push(query);
        /** search #1 shows the family; nothing else answers — as thin as 641's pool */
        const items: SearchItem[] =
          searches.length === 1 ? [{ videoId: "kardashian01", title: "Kim Kardashian interview", description: "", channel: "c", thumb: "t" }] : [];
        return { status: 200, items };
      },
      details: async (list) => new Map(list.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
      triage: async (_it, _t, sentences, subjects = []): Promise<Triage> => ({
        footageType: "real_footage",
        servesBeats: [0],
        depicts: "",
        shows: subjects.map((s, k) => (s === "Kardashians" ? k : -1)).filter((k) => k >= 0),
      }),
      archive: async () => [],
      log: () => {},
    };
  }

  it("#1 and #2 as in 641; #3 and #4 aim at the two needs of sentence 8 — still at most 4 searches", async () => {
    /** the real gate refuses the need as written; Option A names it by its own sentence (Calabasas) */
    expect(realGate(SCRIPT_641)("Accountants in office")).toMatchObject({ ok: false, reason: "SUBJECT_NOT_NAMED" });
    const d = deps();
    const pool = await buildVideoYoutubePool(d, { videoId: 64199, ...SCRIPT_641 });
    expect(d.searches).toEqual([
      "Kim Kardashian footage",
      "Kris Jenner Calabasas footage",
      "Calabasas corporate office footage",
      "Calabasas Accountants in office footage",
    ]);
    expect(d.searches.length).toBe(MAX_YOUTUBE_SEARCHES_PER_VIDEO);
    expect((pool.entityTargets ?? []).map((t) => [t.n, t.name, t.beats])).toEqual([
      [3, "Calabasas corporate office", [8]],
      [4, "Accountants in office", [8]],
    ]);
  });
});
