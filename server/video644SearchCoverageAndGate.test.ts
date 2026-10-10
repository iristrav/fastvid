/**
 * VIDEO 644 — H2: WHAT YOUTUBE FOUND DECIDES WHETHER YOUTUBE IS ASKED AGAIN, AND THE NAME THE
 * VIDEO KEEPS SAYING NAMES ITS SUBJECT.
 *
 * Render 644 (10 October): search #1 "Tesla Model footage" → 7 usable videos covering 3 of 13
 * sentences; the archive added 16 earlier finds and the coverage on paper became 11/13, so
 * `search2=NO` — while a sentence-specific gap query had passed the gate. And search #1 itself was
 * the fallback because the model called the subject "How Tesla Changed the Car Industry" and the
 * gate wanted two of those words in every query.
 */
import { describe, expect, it } from "vitest";
import { search2Reasons, type PoolCandidate } from "./youtubeVideoPool";
import { analyzeVideo, refuseQuery, type GateVerdict } from "./youtubeVideoSearchPlanner";

const candidate = (id: string, from: number, serves: number[]): PoolCandidate => ({
  videoId: id,
  title: id,
  description: "",
  thumb: "",
  durationSec: 600,
  footageType: "real_footage",
  serves,
  from,
  usable: true,
  why: "ok",
});

describe("H2 — the archive does not count as search coverage", () => {
  const sentences = Array.from({ length: 13 }, (_, i) => `sentence ${i}`);
  /** 644: 7 search videos over sentences 0–2, 16 archive videos spread over 11 sentences. */
  const search = Array.from({ length: 7 }, (_, i) => candidate(`s${i}`, 1, [i % 3]));
  const archive = Array.from({ length: 16 }, (_, i) => candidate(`a${i}`, 0, [i % 11]));

  it("644's numbers now ask for search #2: the search's own coverage was 3/13", () => {
    const reasons = search2Reasons({ sentences, candidates: [...search, ...archive] });
    expect(reasons).toContain("coverage 3/13 < 50%");
  });

  it("the same pool without the archive gives the same answer — the archive changed nothing", () => {
    expect(search2Reasons({ sentences, candidates: search })).toEqual(search2Reasons({ sentences, candidates: [...search, ...archive] }));
  });

  it("a search that covers enough on its own still needs no second search", () => {
    const wide = Array.from({ length: 8 }, (_, i) => candidate(`w${i}`, 1, [i, i + 4]));
    expect(search2Reasons({ sentences, candidates: [...wide, ...archive] })).toEqual([]);
  });

  it("an archive video refused on screen still counts as a refusal reason, as before", () => {
    const refused = new Set(["a0", "a1", "a2"]);
    const reasons = search2Reasons({ sentences, candidates: [...search, ...archive] }, refused);
    expect(reasons.some((r) => r.startsWith("refused in this render 3 >="))).toBe(true);
  });
});

describe("H2 — the recurring name names the subject (the 644 title case)", () => {
  const allow = (): GateVerdict => ({ ok: true });
  /** Tesla in every scene, Elon Musk in two, New Jersey and California in one each — as in 644. */
  const input = {
    prompt: "How Tesla changed the car industry",
    title: "How Tesla Changed the Car Industry",
    sceneTexts: [
      "Tesla redefined the industry. Elon Musk promised a future of electric cars. Tesla sold its cars directly.",
      "In New Jersey the dealers fought Tesla. Elon Musk went to court. Tesla won the right to sell.",
      "In California Tesla earned carbon credits. The credits financed Tesla. Tesla kept building.",
    ],
  };
  const analysis = analyzeVideo(input);
  const titleAsSubject = "How Tesla Changed the Car Industry";

  it("the fixture reads like 644: Tesla is the name that recurs most", () => {
    expect(analysis.recurring[0]?.term).toBe("Tesla");
  });

  it("644's refused query is accepted: it names Tesla, the recurring name inside the five-word subject", () => {
    expect(refuseQuery("Tesla Elon Musk electric cars", { analysis, mainSubject: titleAsSubject, gate: allow })).toBeNull();
  });

  it("a query without the recurring name is still refused for the subject", () => {
    expect(refuseQuery("Elon Musk electric cars", { analysis, mainSubject: titleAsSubject, gate: allow })).toContain(
      'main subject "How Tesla Changed the Car Industry" is not in the query'
    );
  });

  it("a two-word subject is unchanged: one of its words still names it", () => {
    expect(refuseQuery("Tesla Elon Musk electric cars", { analysis, mainSubject: "Tesla cars", gate: allow })).toBeNull();
  });

  it("World War II still needs World War II: the P5 rule holds when the recurring name IS the long subject", () => {
    const war = analyzeVideo({
      prompt: "World War II in the Pacific",
      title: "World War II in the Pacific",
      sceneTexts: [
        "World War II reached the Pacific in 1941. World War II changed the fleet.",
        "World War II turned at Midway. World War II carriers struck first.",
        "World War II ended in 1945. World War II fell silent.",
      ],
    });
    expect(war.recurring[0]?.term).toBe("World War II");
    expect(refuseQuery("war footage Pacific fleet", { analysis: war, mainSubject: "World War II", gate: allow })).toContain(
      'main subject "World War II" is not in the query'
    );
    expect(refuseQuery("World War II footage", { analysis: war, mainSubject: "World War II", gate: allow })).toBeNull();
  });

  it("a year that recurs most never names a subject", () => {
    const dated = analyzeVideo({
      prompt: "The crash of 2008",
      title: "The crash of 2008",
      sceneTexts: ["In 2008 the banks fell. Lehman Brothers closed.", "In 2008 the markets panicked. Lehman Brothers was gone.", "2008 changed finance."],
    });
    if (dated.recurring[0]?.term === "2008") {
      expect(refuseQuery("2008 banks crisis", { analysis: dated, mainSubject: "The crash of 2008 financial crisis", gate: allow })).toContain("is not in the query");
    }
  });
});
