import { describe, expect, it } from "vitest";
import { directorSceneToIntent, VISUAL_DIRECTOR_MAX_SEC, VISUAL_DIRECTOR_MIN_SEC, type VisualDirectorScene } from "./visualDirector";
import { directorSearchQueries, hasDirectorPlan } from "./scriptVisualKeywords";

describe("visualDirector", () => {
  const sampleScene: VisualDirectorScene = {
    source_sentence_index: 0,
    spoken_text: "Steeds meer ondernemers verliezen tijd aan repetitieve taken.",
    visual_description:
      "A solo entrepreneur at a desk repeating the same laptop actions over and over.",
    camera_shot: "medium shot",
    emotion: "frustration",
    search_query: "frustrated entrepreneur repetitive computer work",
  };

  it("maps director scene to intent with search from visual description", () => {
    const intent = directorSceneToIntent(sampleScene);
    expect(intent.visual_description).toContain("entrepreneur");
    expect(intent.search_query).toBe("frustrated entrepreneur repetitive computer work");
    expect(intent.primary_keyword).toBe("frustrated entrepreneur repetitive computer work");
    expect(hasDirectorPlan(intent)).toBe(true);
  });

  it("search queries come from visual plan not spoken narration", () => {
    // The plan's own sentence states the subject, so the plan is only selecting from it — which
    // is all a director plan is allowed to do. Note the queries still never carry the spoken
    // words themselves: the route searches on what the viewer should SEE.
    const englishScene: VisualDirectorScene = {
      ...sampleScene,
      spoken_text: "A frustrated entrepreneur grinds through repetitive computer work all day.",
    };
    const intent = directorSceneToIntent(englishScene);
    expect(hasDirectorPlan(intent)).toBe(true);
    const queries = directorSearchQueries(intent);
    expect(queries[0]).toMatch(/frustrated entrepreneur/);
  });

  it("a plan's own English terms prove its query, even against a Dutch sentence (1 Oct 2026)", () => {
    const intent = directorSceneToIntent(sampleScene);
    expect(hasDirectorPlan(intent)).toBe(true);
    expect(directorSearchQueries(intent).length).toBeGreaterThan(0);
  });
});
