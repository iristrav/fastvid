/**
 * STAP 1 — the stored VisualDirector plan is the render's visual intent.
 *
 * Video 626 asked for "Musk" as a place, "blazed" as an action and "vanished" as a subject, while
 * `videos.metadata.visualIntents` already said what each line should show. These tests feed a
 * stored plan in and check what comes out; none of them reads source text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { directorSceneToIntent } from "./visualDirector";
import {
  beatVisualSearchSubjects,
  mergeVisualIntentsIntoMetadata,
  resolveBeatVisualIntent,
  storedVisualIntentForBeat,
  withRenderVisualPlan,
} from "./scriptVisualKeywords";
import { buildBeatVisualIntent, formatVisualIntent } from "./beatVisualIntent";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";
import { validateSearchQuery } from "./searchQueryContract";

const TWEET = "A tweet from Musk, apparently confirming a wild rumor, blazed across the internet.";
const VANISHED = "Minutes later, it vanished, leaving Twitter HQ buzzing.";
const NOT_PLANNED = "Nobody could say what the company would do next.";

/** What `attachScriptVisualKeywords` stores: director scenes turned into intent entries. */
const metadata = mergeVisualIntentsIntoMetadata({}, [
  directorSceneToIntent({
    source_sentence_index: 0,
    spoken_text: TWEET,
    visual_description: "Close-up of a phone screen showing an Elon Musk tweet going viral.",
    camera_shot: "close-up",
    emotion: "tense",
    search_query: "Elon Musk tweet phone screen",
  }),
  directorSceneToIntent({
    source_sentence_index: 1,
    spoken_text: VANISHED,
    visual_description: "Twitter headquarters building in San Francisco with staff outside.",
    camera_shot: "wide shot",
    emotion: "uneasy",
    search_query: "Twitter headquarters San Francisco",
  }),
]);

function logLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

afterEach(() => vi.restoreAllMocks());

describe("the stored plan reaches the render", () => {
  it("a planned sentence gets the director's description, shot and search query", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const intent = withRenderVisualPlan(metadata, () => resolveBeatVisualIntent(TWEET));
    expect(intent.visual_description).toBe("Close-up of a phone screen showing an Elon Musk tweet going viral.");
    expect(intent.camera_shot).toBe("close-up");
    expect(intent.search_query).toBe("elon musk tweet phone screen");
  });

  it("the search subjects are the plan's own queries, so the sentence's filler words are gone", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(beatVisualSearchSubjects(VANISHED)).toContain("minutes twitter");
    const planned = withRenderVisualPlan(metadata, () => beatVisualSearchSubjects(VANISHED));
    expect(planned[0]).toBe("twitter headquarters san francisco");
    expect(planned.join(" ")).not.toMatch(/\b(minutes|vanished)\b/);
    const tweet = withRenderVisualPlan(metadata, () => beatVisualSearchSubjects(TWEET));
    expect(tweet[0]).toBe("elon musk tweet phone screen");
  });

  it("each sentence reports plan=found once per render", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withRenderVisualPlan(metadata, () => {
      resolveBeatVisualIntent(TWEET);
      resolveBeatVisualIntent(TWEET);
    });
    const lines = logLines(spy).filter((l) => l.startsWith("[VisualIntentPlan] plan="));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("plan=found");
    expect(lines[0]).not.toContain("VISUAL_INTENT_FALLBACK");
  });

  it("a beat that is part of a planned sentence reports plan=partial and still uses the plan", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const intent = withRenderVisualPlan(metadata, () =>
      resolveBeatVisualIntent("A tweet from Musk, apparently confirming a wild rumor")
    );
    expect(intent.search_query).toBe("elon musk tweet phone screen");
    expect(logLines(spy).some((l) => l.includes("plan=partial"))).toBe(true);
  });
});

describe("the word rules are a visible fallback", () => {
  it("a sentence the plan does not hold falls back, and says so", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const intent = withRenderVisualPlan(metadata, () => resolveBeatVisualIntent(NOT_PLANNED));
    expect(intent.search_query).toBeUndefined();
    expect(
      logLines(spy).some((l) => l.includes("plan=missing VISUAL_INTENT_FALLBACK reason=sentence_not_in_plan"))
    ).toBe(true);
  });

  it("a video with no stored plan falls back for every sentence, and says so", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withRenderVisualPlan({}, () => resolveBeatVisualIntent(TWEET));
    const lines = logLines(spy);
    expect(lines.some((l) => l.includes("stored plan sentences=0 VISUAL_INTENT_FALLBACK reason=no_plan_for_video"))).toBe(true);
    expect(lines.some((l) => l.includes("plan=missing VISUAL_INTENT_FALLBACK reason=no_plan_for_video"))).toBe(true);
  });

  it("outside a render nothing changes: the word rules answer and nothing is logged", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const intent = resolveBeatVisualIntent(TWEET);
    expect(intent.search_query).toBeUndefined();
    expect(logLines(spy).filter((l) => l.startsWith("[VisualIntentPlan]"))).toHaveLength(0);
    expect(storedVisualIntentForBeat(TWEET)).toBeUndefined();
  });
});

describe("the beat's intent record reads the plan first (video 626)", () => {
  const intentFor = (sentence: string) =>
    buildBeatVisualIntent({
      sceneIndex: 1,
      beatIndex: 4,
      ctx: buildVerifiedQueryContextForBeat(sentence),
      plan: storedVisualIntentForBeat(sentence),
    });

  it("without a plan the word rules make a verb the subject — the 626 failure", () => {
    const old = intentFor(VANISHED);
    expect(old.subject).toBe("vanished");
    expect(old.fromPlan).toBe(false);
    expect(formatVisualIntent(old)).toContain("intent=rules");
  });

  it("with the plan the subject and shot are the director's", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = withRenderVisualPlan(metadata, () => intentFor(VANISHED));
    expect(planned.subject).toBe("twitter headquarters san francisco");
    expect(planned.preferredShot).toBe("wide shot");
    expect(planned.evidenceRequirement).toBe("soft");
    expect(formatVisualIntent(planned)).toContain("intent=plan");
  });

  it("a person named in the sentence is no longer the beat's subject-as-place", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = withRenderVisualPlan(metadata, () => intentFor(TWEET));
    expect(planned.subject).toBe("elon musk tweet phone screen");
    expect(planned.preferredShot).toBe("close-up");
  });
});

describe("the search gate accepts what this sentence's plan states, and nothing else (1B)", () => {

  it("a word neither the sentence nor its plan states is still refused", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    withRenderVisualPlan(metadata, () => {
      const ctx = buildVerifiedQueryContextForBeat(TWEET);
      expect(validateSearchQuery("Elon Musk battlefield explosion", ctx).ok).toBe(false);
    });
  });

  it("another sentence's plan proves nothing here", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    withRenderVisualPlan(metadata, () => {
      const ctx = buildVerifiedQueryContextForBeat(TWEET);
      expect(validateSearchQuery("Twitter headquarters San Francisco", ctx).ok).toBe(false);
    });
  });
});
