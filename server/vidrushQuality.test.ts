import { describe, expect, it } from "vitest";
import {
  buildVidrushOpeningQueries,
  clampVidrushClipDuration,
  clipPassesVidrushOpeningGate,
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
    expect(maxDirectorBeatsForSceneDuration(23)).toBe(6);
    expect(maxDirectorBeatsForSceneDuration(8)).toBe(2);
  });

  it("never returns below floor when scaling down", () => {
    expect(clampVidrushClipDuration(0.2, 0, 0)).toBeGreaterThanOrEqual(vidrushOpeningClipSec());
    expect(clampVidrushClipDuration(0.2, 2, 1)).toBeGreaterThanOrEqual(vidrushMinClipSec());
  });

  it("blocks sim/game CGI hay and sticky NL/US segment lock", () => {
    expect(isNonDocumentaryVisualHay("simcity suburban isometric city")).toBe(true);
    expect(isNonDocumentaryVisualHay("amsterdam canal drone broll")).toBe(false);
    expect(isWrongRegionForSegmentLock("american downtown skyline", "nl")).toBe(true);
    expect(isWrongRegionForSegmentLock("amsterdam gracht bicycles", "nl")).toBe(false);
    expect(isWrongRegionForSegmentLock("1966 toronto transportation expressways scarborough", "nl")).toBe(true);
    expect(isWrongRegionForSegmentLock("gardiner expressway ontario map", "nl")).toBe(true);
    let lock = resolveSegmentGeoLock(inferBeatGeoRegion("In the Netherlands cycling is normal", "NL vs US"), null, "Netherlands vs US");
    expect(lock).toBe("nl");
    lock = resolveSegmentGeoLock(inferBeatGeoRegion("American suburbs sprawl outward", "NL vs US"), lock, "Netherlands vs US");
    expect(lock).toBe("us");
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
