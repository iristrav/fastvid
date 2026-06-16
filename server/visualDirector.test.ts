import { describe, expect, it } from "vitest";
import {
  directorSceneToIntent,
  directorScenesForSceneVoice,
  estimateDirectorSceneHoldSec,
  parseVisualDirectorFromMetadata,
  VISUAL_DIRECTOR_MAX_SEC,
  VISUAL_DIRECTOR_MIN_SEC,
  type VisualDirectorScene,
} from "./visualDirector";
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

  it("search queries come from visual plan not spoken Dutch text", () => {
    const intent = directorSceneToIntent(sampleScene);
    expect(hasDirectorPlan(intent)).toBe(true);
    const queries = directorSearchQueries(intent);
    expect(queries[0]).toMatch(/frustrated entrepreneur/);
    expect(queries.join(" ")).not.toMatch(/ondernemers|repetitieve|taken/);
  });

  it("hold duration stays within 3-5 seconds", () => {
    const hold = estimateDirectorSceneHoldSec(sampleScene.spoken_text, 20, 4);
    expect(hold).toBeGreaterThanOrEqual(VISUAL_DIRECTOR_MIN_SEC);
    expect(hold).toBeLessThanOrEqual(VISUAL_DIRECTOR_MAX_SEC);
  });

  it("matches director scenes to scene voice block", () => {
    const sceneText =
      "Steeds meer ondernemers verliezen tijd aan repetitieve taken. Klanten bestellen online.";
    const other: VisualDirectorScene = {
      ...sampleScene,
      source_sentence_index: 1,
      spoken_text: "Klanten bestellen online.",
      visual_description: "Customer browsing products on a smartphone at home.",
      search_query: "online shopping smartphone customer",
    };
    const matched = directorScenesForSceneVoice(sceneText, [sampleScene, other]);
    expect(matched).toHaveLength(2);
  });

  it("parses director scenes from metadata", () => {
    const parsed = parseVisualDirectorFromMetadata({
      visualDirectorScenes: [sampleScene],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.camera_shot).toBe("medium shot");
  });
});
