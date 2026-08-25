import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decadeOf, dropSubsumedTerms } from "./semanticVisualMatching";
import { isOffTopicProtestForBeat, isProtestVisualHay, inferVideoVisualTopic } from "./visualBeatTags";
import { youtubeMaxDownloadAttemptsPerScene } from "./sourcingPolicy";
import { rapidApiYoutubeMetaDurationSec } from "./videoPipeline";

/**
 * RONDE 62 — everything render 532 showed, fixed.
 *
 * The picture gate finally ran in that render and was right about what it saw. What the rest of
 * the log showed was that almost nothing else was:
 *
 *   · the gate covered one of three scenes — the funnel ran for scene 2 only
 *   · src=unknown on all 52 YouTube plans, so every clip was still cut at a flat second 12
 *   · 97 YouTube downloads, 0 used, and every one "cancelled by the enclosing scene budget"
 *   · queries containing "1945s" and "hitler adolf hitler"
 *   · off_topic_protest asked 32 times, matched 0, while two white-lives-matter clips got in
 *   · "0/4 moving" reported for a video holding 22 clips
 *   · 84 stock-rescue rounds, 0 hits
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 62 #1 — the picture gate covers every route, not just the funnel", () => {
  it("the adoption path judges the clip before accepting it", () => {
    const src = PIPELINE();
    const idx = src.indexOf("async function beatClipPassesImageGate(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2400);
    expect(block).toContain("JUDGEMENT_FRAME_FRACTIONS");
    expect(block).toContain("judgeBeatImage({");
    expect(block).toContain('judgement.verdict === "does_not_fit"');
  });

  it("it is wired at the single acceptance point every non-funnel route passes through", () => {
    const src = PIPELINE();
    // Three call sites share that line; the adoption path is the one preceded by the gate.
    const accept = src.indexOf("dedup.usedPaths.add(p);", src.indexOf("async function adoptClip("));
    expect(accept).toBeGreaterThan(-1);
    // The gate runs BEFORE the clip is marked used, so a refusal costs it its place.
    const before = src.slice(Math.max(0, accept - 1400), accept);
    expect(before).toContain("beatClipPassesImageGate(");
    expect(before).toContain('"beat_image_gate"');
    // RONDE 67 put the reprieve between the refusal and the continue, so the window is wider —
    // but a refusal still ends the iteration rather than falling through to acceptance.
    expect(before).toMatch(/beatClipPassesImageGate\([\s\S]{0,700}?continue;/);
  });

  it("it fails open, like every other copy of this gate", () => {
    const src = PIPELINE();
    const idx = src.indexOf("async function beatClipPassesImageGate(");
    const block = src.slice(idx, idx + 2400);
    expect(block).toContain("if (!beatImageRelevanceGateEnabled() || !beatText?.trim()) return true;");
    // Only a definite refusal returns false; everything else adopts.
    expect(block.match(/return false;/g) ?? []).toHaveLength(1);
  });

  it("the frames it judges are cleaned up", () => {
    const src = PIPELINE();
    const idx = src.indexOf("async function beatClipPassesImageGate(");
    const block = src.slice(idx, idx + 2400);
    expect(block).toMatch(/for \(const fp of framePaths\)[\s\S]{0,80}fs\.unlinkSync\(fp\)/);
  });
});

describe("RONDE 62 #2 — the YouTube duration comes from the call that works", () => {
  it("reads lengthSeconds however the provider spells it", () => {
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: "2400" })).toBe(2400);
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: 187 })).toBe(187);
    expect(rapidApiYoutubeMetaDurationSec({ videoDetails: { lengthSeconds: "935" } })).toBe(935);
    expect(rapidApiYoutubeMetaDurationSec({ duration: "42" })).toBe(42);
  });

  it("returns 0 rather than a wrong number when it cannot tell", () => {
    expect(rapidApiYoutubeMetaDurationSec(null)).toBe(0);
    expect(rapidApiYoutubeMetaDurationSec(undefined)).toBe(0);
    expect(rapidApiYoutubeMetaDurationSec({})).toBe(0);
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: "" })).toBe(0);
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: "not a number" })).toBe(0);
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: "0" })).toBe(0);
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: "-5" })).toBe(0);
    // A day-long "duration" is a parse error, not a video.
    expect(rapidApiYoutubeMetaDurationSec({ lengthSeconds: "999999" })).toBe(0);
  });

  it("the metadata call supplies the start offset, with the watch page only as backup", () => {
    const src = PIPELINE();
    expect(src).toContain(
      "rapidApiYoutubeMetaDurationSec(\n                await fetchRapidApiYoutubeMeta(videoId, sceneIndex, sourcingCache)\n              ) || peekYoutubeVideoContext(videoId)?.durationSec || 0"
    );
    expect(src).toContain("pickLongVideoStartSec(sourceDurationSec, clipDur, videoId)");
  });

  it("the planner is handed the length the caller already knows", () => {
    const src = PIPELINE();
    expect(src).toContain("sourceDurationSec,");
    const finder = fs.readFileSync(path.join(__dirname, "scriptGuidedClipFinder.ts"), "utf8");
    expect(finder).toContain("options.sourceDurationSec && options.sourceDurationSec > 0");
    // The watch page only fills in when the caller had nothing.
    expect(finder).toContain("if (durationSec <= 0) durationSec = pageDuration;");
  });
});

describe("RONDE 62 #3 — 97 downloads for nothing does not happen again", () => {
  it("there is a ceiling on attempts, not only on successes", () => {
    expect(youtubeMaxDownloadAttemptsPerScene()).toBeGreaterThan(0);
    // Render 532 averaged ~32 per scene.
    expect(youtubeMaxDownloadAttemptsPerScene()).toBeLessThan(32);
  });

  it("is env-overridable within sane bounds", () => {
    vi.stubEnv("YOUTUBE_MAX_DOWNLOAD_ATTEMPTS", "3");
    expect(youtubeMaxDownloadAttemptsPerScene()).toBe(3);
    vi.stubEnv("YOUTUBE_MAX_DOWNLOAD_ATTEMPTS", "0");
    expect(youtubeMaxDownloadAttemptsPerScene()).toBe(6);
    vi.stubEnv("YOUTUBE_MAX_DOWNLOAD_ATTEMPTS", "junk");
    expect(youtubeMaxDownloadAttemptsPerScene()).toBe(6);
  });

  it("the counter is incremented on the attempt, and checked at all three loop levels", () => {
    const src = PIPELINE();
    expect(src).toContain("downloadAttempts++;\n            const ok = await downloadYouTubeCCClip(");
    const checks = [...src.matchAll(/if \(downloadAttempts >= maxDownloadAttempts\)/g)];
    expect(checks.length).toBe(3);
  });
});

describe("RONDE 62 #4 — the queries stop containing nonsense", () => {
  it("a year becomes its decade, not the year with an s stuck on it", () => {
    expect(decadeOf("1945")).toBe("1940s");
    expect(decadeOf(1945)).toBe("1940s");
    expect(decadeOf("1939")).toBe("1930s");
    expect(decadeOf("1900")).toBe("1900s");
    expect(decadeOf("2001")).toBe("2000s");
    // Never invents one out of something that is not a year.
    expect(decadeOf("nope")).toBe("nope");
    expect(decadeOf("45")).toBe("45");
  });

  it("one person named twice is one term", () => {
    expect(dropSubsumedTerms(["hitler", "adolf hitler"])).toEqual(["adolf hitler"]);
    expect(dropSubsumedTerms(["adolf hitler", "hitler", "berlin"])).toEqual(["adolf hitler", "berlin"]);
    expect(dropSubsumedTerms(["eva braun", "braun", "hitler", "adolf hitler"])).toEqual([
      "eva braun",
      "adolf hitler",
    ]);
  });

  it("leaves genuinely distinct terms alone", () => {
    expect(dropSubsumedTerms(["berlin", "germany", "bunker"])).toEqual(["berlin", "germany", "bunker"]);
    expect(dropSubsumedTerms([])).toEqual([]);
    expect(dropSubsumedTerms(["   "])).toEqual([]);
  });

  it("matches on whole words, so 'ran' does not swallow 'france'", () => {
    expect(dropSubsumedTerms(["ran", "france"])).toEqual(["ran", "france"]);
  });

  it("the builder uses both", () => {
    const src = fs.readFileSync(path.join(__dirname, "semanticVisualMatching.ts"), "utf8");
    expect(src).toContain("decadeOf(years[0])");
    expect(src).not.toContain("`${years[0]}s`");
    expect(src).toContain("dropSubsumedTerms(");
  });
});

describe("RONDE 62 #6 — the protest gate can finally fire", () => {
  const BEAT = "In April 1945, Adolf Hitler married Eva Braun";
  const topic = () => inferVideoVisualTopic("Why Hitler Chose Death", BEAT);

  it("recognises the two clips that actually got into render 532", () => {
    for (const hay of [
      "white lives matter alabama roadside activism",
      "white lives matter montana activism in b",
    ]) {
      expect(isProtestVisualHay(hay)).toBe(true);
      expect(isOffTopicProtestForBeat(BEAT, hay, topic())).toBe(true);
    }
  });

  it("'activism' was the word it could not see — 'activists' it always could", () => {
    expect(isProtestVisualHay("climate activism")).toBe(true);
    expect(isProtestVisualHay("climate activists")).toBe(true);
  });

  it("catches the movement names and rallies too", () => {
    for (const hay of ["black lives matter march", "a blm rally", "antifa counter-protest", "placards raised"]) {
      expect(isProtestVisualHay(hay)).toBe(true);
    }
  });

  it("genuine period footage still survives the era escape hatch", () => {
    // A Nazi rally reel says so in its own metadata, and is kept.
    expect(isOffTopicProtestForBeat(BEAT, "Nazi party rally Nuremberg 1934", topic())).toBe(false);
    expect(isOffTopicProtestForBeat(BEAT, "Bundesarchiv demonstration reel", topic())).toBe(false);
    expect(isOffTopicProtestForBeat(BEAT, "1953 East Berlin uprising newsreel", topic())).toBe(false);
  });

  it("a beat that IS about protests still accepts protest footage", () => {
    expect(
      isOffTopicProtestForBeat("Crowds took to the streets in protest", "white lives matter activism", topic())
    ).toBe(false);
  });

  it("ordinary footage is not suddenly protest footage", () => {
    for (const hay of ["berlin street 1945", "a bunker corridor", "soldiers marching", "typewriter close up"]) {
      expect(isProtestVisualHay(hay)).toBe(false);
    }
  });

  it("with no provider text the gate reads the file name instead of nothing", () => {
    const src = PIPELINE();
    const idx = src.indexOf("function beatClipIsOffTopicProtest(");
    const block = src.slice(idx, idx + 1600);
    expect(block).toContain("path\n      .basename(clipPath)");
    expect(block).toContain("__pid_");
  });

  it("and the funnel now registers the real title, so the fallback is rarely needed", () => {
    const src = PIPELINE();
    expect(src).toContain("providerText: { ...existingMeta.providerText, title: candidate.title },");
  });
});

describe("RONDE 62 #7 — the render can measure its own visual mix", () => {
  it("the funnel counts moving and still, like the adoption path already did", () => {
    const src = PIPELINE();
    const idx = src.indexOf("funnelClip = clipPath;");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2600);
    expect(block).toContain("dedup.stillClipCount++");
    expect(block).toContain("dedup.movingClipCount++");
  });
});

describe("RONDE 62 #5 — the stock rescue stops asking once the answer is clearly no", () => {
  it("a miss streak stands the source down for the rest of the render", () => {
    const src = PIPELINE();
    expect(src).toContain("dedup.planRescueMissStreak < PLAN_RESCUE_MISS_STREAK_TRIP");
    expect(src).toContain("dedup.planRescueMissStreak++;");
    // A hit resets it — this must never be a one-way latch.
    expect(src).toContain("dedup.planRescueMissStreak = 0;");
  });

  it("the streak is render-scoped state, initialised at zero", () => {
    const src = PIPELINE();
    expect(src).toContain("planRescueMissStreak: number;");
    expect(src).toContain("planRescueMissStreak: 0,");
  });

  it("the trip point is more forgiving than the provider breakers", () => {
    const src = PIPELINE();
    const m = /const PLAN_RESCUE_MISS_STREAK_TRIP = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    const trip = Number(m![1]);
    expect(trip).toBeGreaterThan(3);
    // Render 532 ran six rounds on fourteen beats; this caps the waste at a quarter of that.
    expect(trip).toBeLessThanOrEqual(6);
  });
});
