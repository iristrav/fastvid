import { describe, expect, it } from "vitest";
import {
  buildVidrushOpeningQueries,
  clampVidrushClipDuration,
  clipPassesVidrushOpeningGate,
  clipPassesDocumentaryBeatGate,
  clipPassesGeoUrbanBeatGate,
  enforceMontageDurationFloors,
  inferBeatGeoRegion,
  inferPrimaryGeoFromTitle,
  isNonDocumentaryVisualHay,
  isOffTopicGeoUrbanOpeningVisual,
  isOffTopicGeoUrbanVisual,
  isWrongRegionForSegmentLock,
  maxDirectorBeatsForSceneDuration,
  maxMontageClipsForVoiceSec,
  resolveSegmentGeoLock,
  vidrushMinClipSec,
  vidrushOpeningClipSec,
} from "./vidrushQuality";
import { mergeDirectorScenesForPacing } from "./visualDirector";

describe("vidrushQuality", () => {
  it("enforces 3.5s opening and 3.5s minimum clip floor", () => {
    expect(vidrushOpeningClipSec()).toBeGreaterThanOrEqual(3.5);
    expect(vidrushMinClipSec()).toBeGreaterThanOrEqual(3.5);
    const durs = enforceMontageDurationFloors([0.4, 1.2, 2.0], 0);
    expect(durs[0]).toBeGreaterThanOrEqual(vidrushOpeningClipSec());
    expect(durs[1]).toBeGreaterThanOrEqual(vidrushMinClipSec());
  });

  it("caps director beats to scene duration", () => {
    // RONDE 30: these were hardcoded to 6 and 2, which matched a smaller minimum clip length
    // than the current one. Derived from vidrushMinClipSec() now, so raising the floor again
    // changes the expectation with it instead of silently reddening this file.
    const floor = vidrushMinClipSec();
    expect(maxDirectorBeatsForSceneDuration(23)).toBe(Math.floor(23 / floor));
    expect(maxDirectorBeatsForSceneDuration(8)).toBe(Math.floor(8 / floor));
    // The relationship that actually matters: a longer scene never yields fewer beats.
    expect(maxDirectorBeatsForSceneDuration(23)).toBeGreaterThan(maxDirectorBeatsForSceneDuration(8));
  });

  it("never returns below floor when scaling down", () => {
    expect(clampVidrushClipDuration(0.2, 0, 0)).toBeGreaterThanOrEqual(vidrushOpeningClipSec());
    expect(clampVidrushClipDuration(0.2, 2, 1)).toBeGreaterThanOrEqual(vidrushMinClipSec());
  });

  it("caps montage clip count for short voice scenes", () => {
    expect(maxMontageClipsForVoiceSec(23)).toBeLessThanOrEqual(12);
    expect(maxMontageClipsForVoiceSec(8)).toBeGreaterThanOrEqual(2);
    // 15.5s voice @ 3.5s min + 0.4s xfade needs ≥5 clips (+ backfill headroom)
    expect(maxMontageClipsForVoiceSec(15.5)).toBeGreaterThanOrEqual(5);
  });

  it("builds topic-aware opening queries for any subject", () => {
    const wwii = buildVidrushOpeningQueries("Hitler: Rise of the Third Reich", "Germany was in turmoil");
    expect(wwii.some((q) => /world war|archival|1930s/i.test(q))).toBe(true);

    const nl = buildVidrushOpeningQueries("Why the Netherlands is the Opposite of the U.S.", "Welcome to the Netherlands");
    expect(nl.some((q) => /netherlands|amsterdam|dutch/i.test(q))).toBe(true);
    expect(nl.some((q) => /comparison|american|usa/i.test(q))).toBe(true);

    const space = buildVidrushOpeningQueries("How NASA Built the Moon Rocket", "The Saturn V was enormous");
    expect(space.some((q) => /saturn|documentary|aerial|establishing/i.test(q))).toBe(true);
    expect(space.length).toBeGreaterThanOrEqual(4);
  });

  it("blocks off-topic geo-urban stock and weak openings", () => {
    expect(isOffTopicGeoUrbanVisual("ford dealer showroom classic car")).toBe(true);
    expect(isOffTopicGeoUrbanVisual("walgreens 1950s drugstore")).toBe(true);
    expect(isOffTopicGeoUrbanVisual("amsterdam canal drone broll")).toBe(false);
    expect(
      isOffTopicGeoUrbanOpeningVisual(
        "vintage ford dealership 1950s",
        inferPrimaryGeoFromTitle("Why the Netherlands is the Opposite of the U.S.")
      )
    ).toBe(true);
    expect(
      clipPassesVidrushOpeningGate(
        "/tmp/open_ford_dealer.mp4",
        "ford dealership",
        "Welcome to the Netherlands",
        "Why the Netherlands is the Opposite of the U.S."
      )
    ).toBe(false);
    expect(
      clipPassesDocumentaryBeatGate(
        "/tmp/columbus_city_council.mp4",
        "city council meeting",
        "American downtown planning",
        "Netherlands vs United States cities"
      )
    ).toBe(false);
    expect(
      clipPassesDocumentaryBeatGate(
        "/tmp/amsterdam_canal_bikes.mp4",
        "amsterdam canal",
        "Dutch cycling infrastructure",
        "Netherlands vs United States cities"
      )
    ).toBe(true);
    expect(clipPassesGeoUrbanBeatGate).toBe(clipPassesDocumentaryBeatGate);
  });
});

describe("mergeDirectorScenesForPacing", () => {
  it("merges excess director scenes to fit max beats", () => {
    const scenes = Array.from({ length: 8 }, (_, i) => ({
      source_sentence_index: i,
      spoken_text: `Line ${i}`,
      visual_description: `Visual ${i}`,
      camera_shot: "wide shot",
      emotion: "calm",
      search_query: `query ${i}`,
    }));
    const merged = mergeDirectorScenesForPacing(scenes, 4);
    expect(merged.length).toBeLessThanOrEqual(4);
    expect(merged[0]?.spoken_text).toContain("Line 0");
  });
});
