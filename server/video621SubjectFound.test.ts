/**
 * VIDEO 621 — "Tesla bankruptcy": the video's person and its whole-video YouTube search.
 *
 * The person lock read "Elon Musk Shocks" off the title and, since the narration never says that,
 * gave up. The planner counted "Despite Elon Musk" and "How Elon Musk" as two different names, so
 * "Elon Musk" never recurred, every query was refused and YouTube had no pool for the video.
 */
import { describe, expect, it, vi } from "vitest";
import { analyzeVideo, planVideoQuery, type GateVerdict } from "./youtubeVideoSearchPlanner";
import { resolvePrimaryPersonLock } from "./videoPipeline";

/** Narration in the shape render 621 logged (power words, refusals, audit terms). */
const tesla = {
  prompt: "Tesla bankruptcy",
  title: "Elon Musk Shocks the World: Tesla Failliet",
  sceneTexts: [
    "Tesla, once a titan of innovation, now teeters on the edge. Its success was unprecedented. How Elon Musk lost control is the story.",
    "Despite Elon Musk and his promises, the Tesla Gigafactory in Sparks struggled. In Palo Alto, the board of Tesla met in silence.",
    "Across America, investors fled. Tesla filed for bankruptcy, and Elon Musk faced the cameras alone.",
  ],
};

/** SEARCH_GATE_STRICT as render 621 logged it: a query naming the person leaves as "Elon Musk". */
const narrowsToMusk = (q: string): GateVerdict =>
  /elon musk/i.test(q) ? { ok: true, sentAs: "Elon Musk" } : { ok: true };

const modelAsIn621 = () =>
  vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({
      mainSubject: "Tesla Bankruptcy",
      recurringSubjects: ["Tesla", "Elon Musk"],
      query: "Elon Musk Tesla Gigafactory",
    }) } }],
  }));

describe("Video 621 — the person the title names is found in the narration", () => {
  it("\"Elon Musk Shocks\" is not said; \"Elon Musk\" is, and locks", () => {
    const script = `# ${tesla.title}\n\n${tesla.sceneTexts.join("\n\n")}`;
    expect(
      resolvePrimaryPersonLock({ prompt: tesla.prompt, videoTitle: tesla.title, topicContext: tesla.prompt, script })
    ).toBe("Elon Musk");
  });

  it("a name the narration never says still does not lock, however short it is made", () => {
    const script = "# Rome\n\nThe empire grew. Its legions marched across the provinces.";
    expect(
      resolvePrimaryPersonLock({ prompt: "Julius Caesar Rome", videoTitle: "Julius Caesar Rome", topicContext: "", script })
    ).toBe("");
  });
});

describe("Video 621 — a sentence's first word is not part of the name after it", () => {
  it("\"Despite Elon Musk\" and \"How Elon Musk\" are counted as \"Elon Musk\"", () => {
    const terms = analyzeVideo(tesla).recurring.map((r) => r.term);
    expect(terms).toContain("Elon Musk");
    expect(terms).not.toContain("Despite Elon Musk");
    expect(terms).not.toContain("How Elon Musk");
    const musk = analyzeVideo(tesla).recurring.find((r) => r.term === "Elon Musk")!;
    expect(musk.scenes).toBe(3);
  });

  it("a name that opens a sentence keeps its first word", () => {
    const terms = analyzeVideo({
      prompt: "x",
      title: "x",
      sceneTexts: ["Elon Musk built a company. Elon Musk sold cars.", "Elon Musk left."],
    }).recurring.map((r) => r.term);
    expect(terms).toContain("Elon Musk");
    expect(terms).not.toContain("Musk");
  });

  it("the planner no longer ends with no query: the video is searched on the person it keeps naming", async () => {
    const lines: string[] = [];
    const plan = await planVideoQuery({ llm: modelAsIn621(), gate: narrowsToMusk, log: (l) => lines.push(l) }, tesla);
    expect(plan).not.toBeNull();
    expect(plan!.query).toBe("Elon Musk");
    expect(lines.join("\n")).not.toContain("NO_QUERY");
  });
});
