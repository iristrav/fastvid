/**
 * OCTOBER 2026 — a YouTube video's moment is chosen by the picture editor, not by a hash.
 * See `youtubeMoments.ts`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  chooseAmongMoments,
  chooseMoments,
  momentVideoOf,
  sectionMoments,
  youtubeMomentSpanSec,
  youtubeMomentSpanStartSec,
  youtubeMomentsPerVideo,
} from "./youtubeMoments";
import { buildBeatImagePrompt, momentRank, readFitScore, situationRule } from "./beatImageRelevanceGate";
import { releaseYoutubeShotStock, startYoutubeShotStock, takeStockShot, takeStockShots } from "./youtubeShotStock";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

afterEach(() => {
  delete process.env.YOUTUBE_MOMENTS_PER_VIDEO;
  delete process.env.YOUTUBE_MOMENT_SPAN_SEC;
});

const shot = (s: number, e: number, handedOut = 0) => ({ path: `/x/${s}.mp4`, sourceStartSec: s, sourceEndSec: e, handedOut });

describe("how many moments, from how much of the video", () => {
  it("three moments by default, at most five", () => {
    expect(youtubeMomentsPerVideo()).toBe(3);
    process.env.YOUTUBE_MOMENTS_PER_VIDEO = "5";
    expect(youtubeMomentsPerVideo()).toBe(5);
    process.env.YOUTUBE_MOMENTS_PER_VIDEO = "9";
    expect(youtubeMomentsPerVideo()).toBe(3);
  });

  it("a 20 s section, never past the video's end nor the service's 120 s", () => {
    expect(youtubeMomentSpanSec(5, 600)).toBe(20);
    expect(youtubeMomentSpanSec(5, 12)).toBe(12);
    process.env.YOUTUBE_MOMENT_SPAN_SEC = "500";
    expect(youtubeMomentSpanSec(5, 600)).toBe(20);
    process.env.YOUTUBE_MOMENT_SPAN_SEC = "120";
    expect(youtubeMomentSpanSec(5, 600)).toBe(120);
  });

  it("the section is centred on the planned window and stays inside the video", () => {
    expect(youtubeMomentSpanStartSec(100, 4, 20, 600)).toBe(92);
    expect(youtubeMomentSpanStartSec(3, 4, 20, 600)).toBe(0);
    expect(youtubeMomentSpanStartSec(595, 4, 20, 600)).toBe(580);
  });
});

describe("which shots the picture editor is shown", () => {
  it("spread over the section, not three neighbours", () => {
    const shots = [shot(0, 4), shot(4, 8), shot(8, 12), shot(12, 16), shot(16, 20)];
    expect(chooseMoments(shots, 3).map((s) => s.sourceStartSec)).toEqual([0, 8, 16]);
  });

  it("shots offered to fewer beats come first", () => {
    const shots = [shot(0, 4, 2), shot(4, 8, 0), shot(8, 12, 1)];
    expect(chooseMoments(shots, 2).map((s) => s.sourceStartSec).sort((a, b) => a - b)).toEqual([4, 8]);
  });

  it("the one nearest a planned second is looked at first", () => {
    const shots = [shot(0, 4), shot(8, 12), shot(16, 20)];
    expect(chooseMoments(shots, 3, 15).map((s) => s.sourceStartSec)).toEqual([16, 8, 0]);
  });

  it("nothing in, nothing out", () => {
    expect(chooseMoments([], 3)).toEqual([]);
    expect(chooseMoments([shot(0, 4)], 0)).toEqual([]);
  });
});

describe("a section is cut where the picture changes", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ytmoments-"));
  const writer = (calls: string[]) => ({
    extract: async (_i: string, o: string, s: number, e: number) => {
      calls.push(`${s}-${e}`);
      fs.writeFileSync(o, "x");
    },
  });

  it("each shot keeps its seconds in the YouTube video", async () => {
    const d = dir();
    const src = path.join(d, "section.mp4");
    fs.writeFileSync(src, "x");
    const calls: string[] = [];
    const got = await sectionMoments(src, 92, 100, 4, d, {
      detect: async () => ({ durationSec: 20, cutsSec: [6, 13] }),
      ...writer(calls),
    });
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got[0]!.sourceStartSec).toBeGreaterThanOrEqual(92);
    expect(got.every((m) => m.sourceEndSec <= 112)).toBe(true);
  });

  it("an unfinished cut scan falls back to the planned window, never to nothing", async () => {
    const d = dir();
    const src = path.join(d, "section.mp4");
    fs.writeFileSync(src, "x");
    const calls: string[] = [];
    const got = await sectionMoments(src, 92, 100, 4, d, {
      detect: async () => ({ durationSec: 0, cutsSec: [], incomplete: "timeout" }),
      ...writer(calls),
    });
    expect(calls).toEqual(["8-12"]);
    expect(got).toEqual([expect.objectContaining({ sourceStartSec: 100, sourceEndSec: 104 })]);
  });
});

describe("the film's stock hands a beat several shots", () => {
  it("up to N, each marked as handed out; the one-shot wrapper still gives one", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ytstock-"));
    const film = 990_001;
    startYoutubeShotStock(film, [{ videoId: "vid", title: "t", durationSec: 600, serves: 1 }], {
      workDir: d,
      startFor: () => 100,
      log: () => undefined,
      download: async (_id, _s, _d, out) => (fs.writeFileSync(out, "x"), true),
      cut: async (_f, dirOut) =>
        [0, 5, 10, 15, 20].map((s, i) => {
          const p = path.join(dirOut, `shot_${i}.mp4`);
          fs.writeFileSync(p, "x");
          return { path: p, startSec: s, endSec: s + 5 };
        }),
    });
    const many = await takeStockShots(film, "vid", 2_000, () => false, 3);
    expect(many.shots.map((s) => s.sourceStartSec)).toEqual([100, 110, 120]);
    expect(many.shots.every((s) => s.handedOut === 1)).toBe(true);
    const one = await takeStockShot(film, "vid", 0);
    expect(one.shot?.sourceStartSec).toBe(105);
    releaseYoutubeShotStock(film);
  });
});

describe("the pipeline offers the moments to the judge instead of adopting a hashed window", () => {
  it("a guessed start fetches a section; a transcript start keeps its one window", () => {
    expect(PIPE).toContain("!startIsExact && youtubeMomentsPerVideo() > 1 && sourceDurationSec >= clipDur * 2");
    expect(PIPE).toContain("const fetchStart = momentsMode");
  });

  it("every moment is its own candidate with its own lineage and seconds", () => {
    const at = PIPE.indexOf("const offerMoments = async (");
    const body = PIPE.slice(at, PIPE.indexOf("return offered;", at));
    expect(body).toContain("tagPathWithProviderAsset(");
    expect(body).toContain("recordSourceTrim(momentPath");
    expect(body).toContain("recordProviderDownloadOutcome(sourcingCache, momentPath");
    expect(body).toContain("results.push(momentPath)");
  });

  it("the stock and the live section both go through the same offer", () => {
    expect(PIPE).toContain("takeStockShots(");
    expect(PIPE.match(/await offerMoments\(/g)?.length).toBe(2);
  });
});

describe("the judge compares a video's moments and the beat takes the best", () => {
  const base = { waitedForSiblings: false, yieldedToBetter: false, approved: [], unlooked: [] };
  it("reads the video out of a fragment key, and nothing out of anything else", () => {
    expect(momentVideoOf("youtube_cc:abc123@t12d4")).toBe("abc123");
    expect(momentVideoOf("curated:asset:9")).toBeNull();
    expect(momentVideoOf(null)).toBeNull();
  });
  it("an approved moment waits once while the same video has moments nobody looked at", () => {
    expect(chooseAmongMoments({ ...base, video: "v", ownScore: 6, unlooked: [{ video: "v" }] })).toBe("look_at_siblings_first");
    expect(chooseAmongMoments({ ...base, video: "v", ownScore: 6, unlooked: [{ video: "other" }] })).toBe("adopt");
    expect(
      chooseAmongMoments({ ...base, video: "v", ownScore: 6, unlooked: [{ video: "v" }], waitedForSiblings: true })
    ).toBe("adopt");
  });
  it("a higher-scored approved moment of the same video goes first, once", () => {
    const approved = [{ video: "v", score: 9 }];
    expect(chooseAmongMoments({ ...base, video: "v", ownScore: 6, approved })).toBe("better_moment_first");
    expect(chooseAmongMoments({ ...base, video: "v", ownScore: 9, approved })).toBe("adopt");
    expect(chooseAmongMoments({ ...base, video: "v", ownScore: 6, approved, yieldedToBetter: true })).toBe("adopt");
    expect(chooseAmongMoments({ ...base, video: "v", ownScore: 6, approved: [{ video: "w", score: 10 }] })).toBe("adopt");
  });
  it("a clip that is not a YouTube moment is adopted as before", () => {
    expect(chooseAmongMoments({ ...base, video: null, ownScore: 2, approved: [{ video: "v", score: 10 }] })).toBe("adopt");
  });
  it("walks a real queue: three approved moments, the 9 is adopted, not the first", () => {
    const scores: Record<string, number> = { a: 5, b: 9, c: 7 };
    const queue = ["a", "b", "c"];
    const visited = new Set<string>();
    const approved = new Map<string, { video: string; score: number }>();
    const waited = new Set<string>();
    const yielded = new Set<string>();
    let adopted: string | null = null;
    for (const p of queue) {
      visited.add(p);
      const choice = chooseAmongMoments({
        video: "v",
        ownScore: scores[p],
        unlooked: queue.filter((q) => q !== p && !visited.has(q)).map(() => ({ video: "v" })),
        approved: [...approved].filter(([q]) => q !== p).map(([, v]) => v),
        waitedForSiblings: waited.has(p),
        yieldedToBetter: yielded.has(p),
      });
      approved.set(p, { video: "v", score: scores[p]! });
      if (choice === "adopt") {
        adopted = p;
        break;
      }
      (choice === "look_at_siblings_first" ? waited : yielded).add(p);
      queue.push(p);
    }
    expect(adopted).toBe("b");
  });
  it("the judge is asked for a 1..10 score, and only a sane one is kept", () => {
    expect(readFitScore(8)).toBe(8);
    expect(readFitScore(7.6)).toBe(8);
    expect(readFitScore(0)).toBeUndefined();
    expect(readFitScore(42)).toBeUndefined();
    expect(readFitScore("9")).toBeUndefined();
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(gate).toMatch(/required: \[[^\]]*"fit_score"[^\]]*"visual_quality"/);
    expect(PIPE).toMatch(/chooseAmongMoments\(\{/);
  });
});

describe("the moments are ranked on what the line needs, not on who comes first", () => {
  it("fit first, then action and context, then picture quality", () => {
    const close = momentRank({ fitScore: 7, actionMatches: true, contextMatches: true, visualQuality: 6 });
    const redCarpet = momentRank({ fitScore: 7, actionMatches: false, contextMatches: false, visualQuality: 9 });
    expect(close).toBeGreaterThan(redCarpet);
    /** A sharper picture never outranks a better fit on its own. */
    expect(momentRank({ fitScore: 9, visualQuality: 1 })).toBeGreaterThan(momentRank({ fitScore: 8, visualQuality: 10 }));
    expect(momentRank({})).toBe(0);
  });
  it("the judge is asked for all of them, about THIS line", () => {
    const p = buildBeatImagePrompt("Kris Jenner turned her family's fame into a global media empire.", 3);
    expect(p).toContain("action_matches");
    expect(p).toContain("context_matches");
    expect(p).toContain("visual_quality");
    expect(p).toContain("THE QUESTION — narration for this shot");
  });
  it("Kris Jenner on a red carpet under a line about her media empire is refused: subject without the situation", () => {
    const j = situationRule(
      { verdict: "fits" as const, reason: "Kris Jenner is on screen" },
      { subject_matches: true, situation_matches: false }
    );
    expect(j.verdict).toBe("does_not_fit");
  });
});

describe("the 20 s section is never used whole", () => {
  it("each moment is one shot, cut at its own start and to the sentence's length at most", () => {
    expect(PIPE).toContain("Math.min(clipDur, Number((s.sourceEndSec - s.sourceStartSec).toFixed(2)))");
    const cut = PIPE.slice(PIPE.indexOf("async function stockShotToBeatFile"), PIPE.indexOf("async function stockShotToBeatFile") + 600);
    expect(cut).toContain("shot.sourceEndSec - shot.sourceStartSec > durationSec + 0.3");
    expect(cut).toContain("extractVideoSegment(shot.path, outPath, 0, durationSec)");
    /** The lineage records exactly the seconds used, so the timeline places exactly those. */
    expect(PIPE).toContain("recordSourceTrim(momentPath, { inSec: momentStart, outSec: momentStart + dur })");
  });
});
