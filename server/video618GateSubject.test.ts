/**
 * Video 618 — "Why the Kardashians are really that rich": the search gate narrowed every query that
 * named no person to the render's person, "Kris Jenner"; the planner refused each narrowed query
 * because "Kardashians" was gone. Nine refusals, no search for the video, an empty pool.
 *
 * The fallback now tries what the gate would send, when that text recurs through the video, as the
 * query and the main subject. The gate is the test's stand-in for SEARCH_GATE_STRICT's narrowing and
 * is not changed by the fix.
 */
import { describe, expect, it, vi } from "vitest";
import { analyzeVideo, planVideoQuery, refuseQuery, type GateVerdict } from "./youtubeVideoSearchPlanner";

const kardashians = {
  prompt: "Why the Kardashians are really that rich",
  title: "The Real Reason Kardashians Are Multi-Billionaires",
  sceneTexts: [
    "Forget reality TV: the Kardashians struck gold with a beauty brand. Kris Jenner saw it first.",
    "Behind the glamour of Los Angeles, Kris Jenner orchestrated a business empire for the Kardashians.",
    "Kylie Jenner turned lip kits into a fortune in Los Angeles, and the Kardashians followed.",
  ],
};

/**
 * SEARCH_GATE_STRICT's canonical narrowing, as render 618 logged it: every query left the gate as
 * the render's person, "Kris Jenner".
 */
const narrowsToKris = (q: string): GateVerdict => ({ ok: true, sentAs: "Kris Jenner" });

/** The model's answers in render 618: a family subject, and queries without a person. */
const modelAsIn618 = () =>
  vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({
      mainSubject: "Kardashians' wealth",
      recurringSubjects: ["Kardashians", "Los Angeles"],
      query: "Kardashians Los Angeles TV",
    }) } }],
  }));

describe("Video 618 — what the gate will send, when the video keeps naming it", () => {
  it("the 618 refusal is reproduced: the narrowed query loses the model's main subject", () => {
    const a = analyzeVideo(kardashians);
    expect(refuseQuery("Kardashians Los Angeles", { analysis: a, mainSubject: "Kardashians", gate: narrowsToKris }))
      .toContain('the search gate narrows it to "Kris Jenner"');
    /** And the existing fallback's first choice — the most recurring term — is the family, not the person. */
    expect(a.recurring[0]!.term).toBe("Kardashians");
  });

  it("the planner no longer ends with no query: it searches the recurring person the gate anchors to", async () => {
    const lines: string[] = [];
    const plan = await planVideoQuery({ llm: modelAsIn618(), gate: narrowsToKris, log: (l) => lines.push(l) }, kardashians);
    expect(plan).not.toBeNull();
    expect(plan!.query).toBe("Kris Jenner");
    expect(plan!.mainSubject).toBe("Kris Jenner");
    expect(plan!.source).toBe("fallback");
    expect(lines.join("\n")).toContain("source=fallback_gate_subject");
    expect(lines.join("\n")).not.toContain("NO_QUERY");
  });

  it("no word is added: the query is exactly what the gate sends, and it is in the narration", async () => {
    const plan = await planVideoQuery({ llm: modelAsIn618(), gate: narrowsToKris }, kardashians);
    for (const w of plan!.query.split(/\s+/)) {
      expect(kardashians.sceneTexts.join(" ")).toContain(w);
    }
  });

  it("a narrowed text that does NOT recur through the video is still refused — nothing else loosens", async () => {
    const oneMention = {
      ...kardashians,
      sceneTexts: [
        "Forget reality TV: the Kardashians struck gold with a beauty brand.",
        "Behind the glamour of Los Angeles, the Kardashians built a business empire.",
        "Within months, Kris Jenner negotiated a deal for the Kardashians in Los Angeles.",
      ],
    };
    const recurring = analyzeVideo(oneMention).recurring.filter((r) => r.scenes >= 2 || r.beats >= 2).map((r) => r.term);
    expect(recurring).not.toContain("Kris Jenner");
    const plan = await planVideoQuery({ llm: modelAsIn618(), gate: narrowsToKris }, oneMention);
    expect(plan).toBeNull();
  });

  it("a gate that refuses stays a refusal: nothing is sent", async () => {
    const refuses = (): GateVerdict => ({ ok: false, reason: "UNVERIFIED_TERM", offendingTerm: "TV" });
    const plan = await planVideoQuery({ llm: modelAsIn618(), gate: refuses }, kardashians);
    expect(plan).toBeNull();
  });
});
