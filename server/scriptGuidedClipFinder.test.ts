import { describe, expect, it } from "vitest";
import {
  findClipStartFromTranscript,
  scoreYoutubeMetadata,
  scriptGuidedClipsEnabled,
  type ScriptGuidedCandidate,
  type TranscriptSegment,
} from "./scriptGuidedClipFinder";

describe("findClipStartFromTranscript", () => {
  const segments: TranscriptSegment[] = [
    { startSec: 0, text: "Welcome to our channel" },
    { startSec: 12, text: "In 1912 the RMS Titanic left Southampton" },
    { startSec: 18, text: "on her maiden voyage across the Atlantic" },
    { startSec: 45, text: "The iceberg collision happened at night" },
  ];

  it("finds the Titanic departure moment", () => {
    const hit = findClipStartFromTranscript(segments, "Titanic departed from Southampton in 1912", [
      "titanic",
      "southampton",
      "1912",
    ]);
    expect(hit).not.toBeNull();
    expect(hit!.startSec).toBeGreaterThanOrEqual(10);
    expect(hit!.startSec).toBeLessThan(20);
    expect(hit!.confidence).toBeGreaterThanOrEqual(2);
  });

  it("returns null when captions are unrelated", () => {
    const hit = findClipStartFromTranscript(
      [{ startSec: 0, text: "Subscribe for more gaming content" }],
      "Titanic sank in 1912",
      ["titanic"]
    );
    expect(hit).toBeNull();
  });
});

describe("scoreYoutubeMetadata", () => {
  it("ranks Titanic documentary above unrelated title", () => {
    const good: ScriptGuidedCandidate = {
      videoId: "a",
      title: "RMS Titanic archival footage 1912 Southampton",
      description: "Historical documentary",
      metadataScore: 3,
    };
    const bad: ScriptGuidedCandidate = {
      videoId: "b",
      title: "Top 10 ocean cruise tips",
      description: "Travel vlog",
      metadataScore: 1,
    };
    expect(scoreYoutubeMetadata(good, ["titanic", "southampton", "1912"])).toBeGreaterThan(
      scoreYoutubeMetadata(bad, ["titanic", "southampton", "1912"])
    );
  });
});

describe("scriptGuidedClipsEnabled", () => {
  it("is on by default", () => {
    const prev = process.env.ENABLE_SCRIPT_GUIDED_CLIPS;
    delete process.env.ENABLE_SCRIPT_GUIDED_CLIPS;
    expect(scriptGuidedClipsEnabled()).toBe(true);
    process.env.ENABLE_SCRIPT_GUIDED_CLIPS = prev;
  });
});
