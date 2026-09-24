/**
 * RONDE 649 — NO SUBTITLES IN THE PICTURE UNLESS THE USER ASKED FOR THEM.
 *
 * Render 606 was made with subtitles off (the dashboard's default) and still carried twelve
 * narration subtitles: the cinematic planner turns them on by default, and the pipeline never
 * handed it the video's own setting. The setting now reaches the planner, on the real chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { planAndStoreCinematicTimeline } from "./cinematicProduction";
import { captionTrack } from "./projectTimeline";
import type { SceneFacts } from "./cinematicPipelineInputs";

function sceneFacts(index: number): SceneFacts {
  const beats = [0, 1].map((i) => ({
    index: i,
    text: `Beat ${i}: Berlin, April 1945.`,
    searchQuery: "berlin 1945",
    powerWord: "Berlin",
    holdSec: 4,
    voiceStartSec: i * 4,
    voiceEndSec: i * 4 + 4,
  }));
  return {
    scene: { index, text: "Berlin, April 1945.", visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 },
    beats,
    clips: beats.map((_, i) => ({
      facts: { localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10 },
      adoption: { provider: "pexels", providerAssetId: `${index}${i}`, sourceUrl: "https://videos.pexels.com/x.mp4", query: "berlin 1945" },
    })),
  };
}

const persist = async () => ({ saved: true });
const KEYS = ["CINEMATIC_EDITING_ENGINE", "AI_DIRECTOR"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CINEMATIC_EDITING_ENGINE = "true";
  process.env.AI_DIRECTOR = "true";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the video's subtitle setting decides", () => {
  it("subtitles off: the stored timeline carries no subtitle", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 606, scenes: [sceneFacts(0), sceneFacts(1)], persist, includeSubtitles: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(captionTrack(outcome.timeline)).toHaveLength(0);
  });

  it("subtitles on: they are there, so the switch really switches", async () => {
    const outcome = await planAndStoreCinematicTimeline({
      videoId: 606, scenes: [sceneFacts(0), sceneFacts(1)], persist, includeSubtitles: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(captionTrack(outcome.timeline).length).toBeGreaterThan(0);
  });
});

describe("nobody else's text in the picture either", () => {
  /**
   * The operator's choice (2026-09-24): a shot with on-screen text — burnt-in subtitles, a title
   * bar, a channel logo — is refused, even when the picture editor liked it for its beat. The text
   * detector cannot tell a subtitle from a logo, so there is no approval that lets text through.
   */
  it("the archive refuses any clip with text, and no caller can wave it through", () => {
    const INGEST = readFileSync(join(__dirname, "archiveIngestion.ts"), "utf8");
    expect(INGEST).toContain('if (overlay.verdict === "has_text") {');
    expect(INGEST).not.toContain("approvedForBeat");
  });
});

describe("the wiring", () => {
  it("the render hands the planner the video's own setting", () => {
    const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const call = SRC.slice(SRC.indexOf("const outcome = await planAndStoreCinematicTimeline({"));
    expect(call.slice(0, 400)).toContain("includeSubtitles: enableSubtitles,");
  });

  it("new videos start with subtitles off", () => {
    const ROUTERS = readFileSync(join(__dirname, "routers.ts"), "utf8");
    expect(ROUTERS).toContain("enableSubtitles: z.boolean().default(false),");
    const DASH = readFileSync(join(__dirname, "..", "client", "src", "pages", "Dashboard.tsx"), "utf8");
    expect(DASH).toContain("const [enableSubtitles, setEnableSubtitles] = useState(false);");
    // The internal trigger does not ask; the column's default (1) must not decide for it.
    const INTERNAL = readFileSync(join(__dirname, "_core", "index.ts"), "utf8");
    expect(INTERNAL).toContain("status: 'queued', enableSubtitles: 0 });");
  });
});
