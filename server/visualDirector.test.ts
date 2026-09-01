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

  it("RONDE 91 §3 — a plan term its own sentence does not state is discarded", () => {
    // The sample plan is English and its sentence is Dutch, so not one of "frustrated",
    // "entrepreneur", "repetitive" or "computer" stands in the sentence the plan was written for.
    //
    // This is a real capability loss and it is deliberate: nothing in the pipeline can tell a
    // TRANSLATION of a stated subject apart from an INVENTED one, and the round's rule is that an
    // unprovable term does not reach a provider. It did not reach one before this change either —
    // RONDE 90's gate refused it against the same Dutch beat — so what changed is that the
    // pipeline no longer spends a round building queries it may not send, and the refusal is now
    // logged as LLM_UNPROVEN_CONTENT instead of an anonymous UNVERIFIED_TERM.
    const intent = directorSceneToIntent(sampleScene);
    expect(hasDirectorPlan(intent)).toBe(true);
    expect(directorSearchQueries(intent)).toEqual([]);
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
