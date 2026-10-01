/**
 * ONE ROUTE — the guarantees the full code audit added or made true, each on the behaviour itself
 * where it can be called, and on the source where the guarantee is "this route no longer exists".
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { judgeArchiveAsset, judgeArchiveAssetScore } from "./visualJudge";
import { finalTimelineFootageRefusal } from "./deliveryGate";
import { footageSourceForArchiveAssets } from "./youtubeFootageInFilm";
import { archiveAssetIdsOfStoredTimeline } from "./projectTimeline";
import { rankCandidatesWithContext, type AssetDirectorContext } from "./assetDirector";

const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8");
const PIPE = read("videoPipeline.ts");

describe("P4 — the taste model blends each candidate's own AssetDirector score", () => {
  it("the AssetDirector hands back a score for every candidate it ranked", () => {
    const paths = ["/tmp/a_wide_city.mp4", "/tmp/b_close_face.mp4", "/tmp/c_medium_street.mp4"];
    const ctx: AssetDirectorContext = { usedPaths: new Set(), usedCategories: new Map(), sceneAdoptedClips: [], prevSceneClips: [] };
    const out = rankCandidatesWithContext(paths, "a crowded city street", 0, 0, ctx);
    expect([...out.scores.keys()].sort()).toEqual([...paths].sort());
    expect(out.rankedPaths.map((p) => out.scores.get(p)!)).toEqual(
      [...out.rankedPaths.map((p) => out.scores.get(p)!)].sort((x, y) => y - x)
    );
  });

  it("no position-based estimate is built any more", () => {
    expect(PIPE).not.toContain("adResult.topScore.finalScore - _i * 5");
    expect(PIPE).toContain("const adScores = adResult.scores;");
  });
});

describe("P5/P6 — the archive's content refusals are the VisualJudge's, and only what production ran", () => {
  it("a negative match score is refused by the judge, a zero or positive one is not", () => {
    expect(judgeArchiveAssetScore(-1).decision).toBe("REJECT");
    expect(judgeArchiveAssetScore(0).decision).toBe("ACCEPT");
    expect(judgeArchiveAssetScore(40).decision).toBe("ACCEPT");
  });

  it("judgeArchiveAsset: non-documentary material, then the score — nothing else", () => {
    const asset = { title: "x", tags: ["street", "city"], mediaType: "video", mixKind: null } as never;
    expect(judgeArchiveAsset({ asset, score: 10 }).decision).toBe("ACCEPT");
    expect(judgeArchiveAsset({ asset, score: -5 }).reason).toBe("negative_match_score");
  });

  it("the matcher asks the judge, and no flag gates archive refusals any more", () => {
    const curated = read("curatedMediaSourcing.ts");
    expect(curated).toContain('judgeArchiveAssetScore(score).decision === "REJECT"');
    expect(curated).not.toContain("if (score < 0) continue;");
    for (const f of ["curatedMediaSourcing.ts", "visualJudge.ts", "visualBeatTags.ts", "sourcingPolicy.ts"]) {
      expect(read(f), f).not.toContain("metadataVisualBlocksEnabled");
      expect(read(f), f).not.toContain("literalVisualGateEnabled");
    }
  });
});

describe("P7 — pieces of one source count as one piece of footage", () => {
  it("archive pieces are grouped under their parent; YouTube segments under their video", async () => {
    const rows: Record<number, { sourcePlatform?: string; sourceUrl?: string; parentAssetId?: number | null }> = {
      1: { sourcePlatform: "upload", parentAssetId: 100 },
      2: { sourcePlatform: "upload", parentAssetId: 100 },
      3: { sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk" },
      4: { sourcePlatform: "upload", parentAssetId: null },
    };
    const clips = [1, 2, 3, 4].map((id) => ({ source: { archiveAssetId: id } }));
    const map = await footageSourceForArchiveAssets(clips, async (id) => rows[id]);
    expect(map.get(1)).toBe("archive:100");
    expect(map.get(2)).toBe("archive:100");
    expect(map.get(3)).toBe("youtube:abcdefghijk");
    expect(map.has(4)).toBe(false);
  });

  it("two pieces of one upload filling the film are refused by the DeliveryGate", () => {
    const clip = (id: string, archiveAssetId: number, start: number, end: number) =>
      ({ id, disabled: false, timelineStart: start, timelineEnd: end, source: { provider: "upload", archiveAssetId } }) as never;
    const clips = [clip("a", 1, 0, 30), clip("b", 2, 30, 60), clip("c", 5, 60, 70)];
    expect(finalTimelineFootageRefusal(clips)).toBeNull();
    const grouped = new Map<number, string>([[1, "archive:100"], [2, "archive:100"]]);
    expect(finalTimelineFootageRefusal(clips, undefined, grouped)).toMatch(/archive:100/);
  });
});

describe("P15 — an archive asset a stored film uses is switched off, not deleted", () => {
  it("reads the picture track's archive asset ids from a stored timeline", () => {
    const stored = {
      tracks: [
        { kind: "VIDEO", clips: [{ source: { archiveAssetId: 7 } }, { source: { archiveAssetId: 9 } }, { source: {} }] },
        { kind: "AUDIO", clips: [{ source: { archiveAssetId: 11 } }] },
      ],
    };
    expect(archiveAssetIdsOfStoredTimeline(stored)).toEqual([7, 9]);
    expect(archiveAssetIdsOfStoredTimeline(null)).toEqual([]);
  });

  it("the delete route switches used assets off", () => {
    const db = read("db.ts");
    expect(db).toContain("archiveAssetIdsOfStoredTimeline(row.videoTimeline)");
    expect(db).toContain(".set({ isActive: 0 }).where(inArray(mediaArchiveAssets.id, [...inUse]))");
  });
});

describe("P2/P3/P9 — one YouTube search owner, one candidate pool, no second adoption", () => {
  it("YouTube rows come only from the video's pool; a beat never searches YouTube itself", () => {
    expect(PIPE).not.toContain("searchYoutubeVideoCandidates(");
    expect(PIPE).not.toContain("this beat searches YouTube itself");
    expect(PIPE).toContain("const items = poolRows;");
  });

  it("the person's archive footage joins the one pool instead of a second adoption", () => {
    expect(PIPE).not.toContain("adoptBestCelebrityClip(");
    expect(PIPE).toContain("const candidates = [...(ytCandidates ?? []), ...(pool ?? []), ...(personPool ?? [])];");
  });

  it("the YouTube turn only supplies candidates; the cascade never asks YouTube", () => {
    expect(PIPE).not.toContain('finish("YOUTUBE_ADOPTED"');
    expect(PIPE).not.toMatch(/HISTORICAL_SOURCE_TIER_ORDER = \[[^\]]*youtube_cc/);
    expect(PIPE).not.toContain("YoutubeBeatOffer");
  });
});

describe("P1/P11/P12 — no switch selects a second route or turns the VisualJudge off", () => {
  it("the switches are gone from the code", () => {
    const names = [
      "ENFORCE_FUNNEL_ADOPTION",
      "ENABLE_BEAT_IMAGE_RELEVANCE_GATE",
      "CINEMATIC_EDITING_ENGINE",
      "CINEMATIC_RENDER_PATH",
      "SCRIPT_ENGINE_V2",
      "SOURCING_YOUTUBE_FIRST",
      "REAL_FOOTAGE_FIRST",
      "ASSET_DIRECTOR_ENABLED",
      "DOCUMENTARY_TASTE_MODEL_ENABLED",
      "ENABLE_METADATA_VISUAL_BLOCKS",
      "LITERAL_VISUAL_GATE",
    ];
    const files = ["videoPipeline.ts", "config.ts", "adoptionPolicy.ts", "routers.ts", "scriptEngine.ts", "sourcingPolicy.ts",
      "assetDirector.ts", "documentaryTasteModel.ts", "mediaResearchEngine.ts", "cinematicProduction.ts", "visualJudge.ts"];
    for (const f of files) {
      const src = read(f);
      for (const n of names) expect(src, `${f} still reads ${n}`).not.toMatch(new RegExp(`process\\.env\\.${n}\\b|"${n}"`));
    }
    expect(PIPE).not.toMatch(/process\.env\.YOUTUBE_FIRST\b/);
  });
});
