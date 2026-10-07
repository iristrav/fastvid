import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { judgeCandidateMetadata, clipOwnQuery, isRejectedStockClip, type CandidateJudgeInput } from "./visualJudge";
import { belowArchiveMinimumDuration, MIN_VIDEO_DURATION_SEC } from "./archiveIngestion";

/**
 * VIDEO 638 — G1, G2, G3/G4.
 *
 * 638 found 30 YouTube moments and looked at 4. Three causes, each fixed at the smallest point:
 *   G1  the stock lists read the NARRATION as if it described the clip ("iconic" → all six s1b0
 *       candidates refused; "icon", "toy", "animation", "science fiction" still would);
 *   G2  moments under the archive's unchanged 3 s minimum spent a look and were refused at the push;
 *   G3  the own archive was asked before YouTube that was already on disk for the sentence;
 *   G4  inside one review pool, YouTube waited behind Internet Archive and archive candidates.
 */

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const VJ = fs.readFileSync(path.join(__dirname, "visualJudge.ts"), "utf8");
const INGEST = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

const YT = "/w/scene_1_ytfu_0m1_t1710d25__pid_youtube_cc-bab7b347261e7be9.mp4";

const base = (beatText: string, over: Partial<CandidateJudgeInput> = {}): CandidateJudgeInput => ({
  path: YT,
  /** The pool routes hand the sentence itself over as the query (`adoptClip(…, beat.text, …, beat.text)`). */
  sourceQuery: beatText,
  beatText,
  videoTitle: "How Kris Jenner built an empire",
  requireBeatMatch: false,
  scriptAnchored: false,
  entityRules: [],
  signals: { beatMatch: 2, queryInBeat: true, providerTitleSharesNothing: false },
  where: "s1b0",
  ...over,
});

/* ═══════════ G1 — the narration is not clip metadata ═══════════ */

describe("G1 — a word in the sentence never refuses a YouTube candidate before the picture editor", () => {
  for (const sentence of [
    "Kim Kardashian became a pop culture icon almost overnight.",
    "To many, it sounded like science fiction.",
    "Mattel was once just a small toy company.",
    "Pixar changed animation forever.",
    "Nobody could replicate Tesla's success.",
    "Elon Musk wasn't Tesla's founder, yet he became its iconic face by investing $6.5 million.",
  ]) {
    it(`accepted on metadata: "${sentence}"`, () => {
      const v = judgeCandidateMetadata(base(sentence));
      expect(v.decision, `${v.reason}`).toBe("ACCEPT");
    });
  }

  it("the same sentences WOULD refuse if they were tested as clip text — the old input, still refused by the list", () => {
    expect(isRejectedStockClip(YT, "Kim Kardashian became a pop culture icon almost overnight.")).toBe(true);
    expect(isRejectedStockClip(YT, "To many, it sounded like science fiction.")).toBe(true);
  });

  it("a candidate whose OWN file name carries a stock term is still refused", () => {
    const own = "/w/scene_1_cartoon_intro__pid_youtube_cc-0123456789abcdef.mp4";
    expect(judgeCandidateMetadata(base("Kris Jenner built a media empire.", { path: own })).reason).toBe("rejected_stock");
    const toy = "/w/pexels-toy-rocket-launch.mp4";
    expect(judgeCandidateMetadata(base("Kris Jenner built a media empire.", { path: toy })).decision).toBe("REJECT");
  });

  it("a real search query (not the sentence) is still read as before — a diorama query is refused", () => {
    expect(
      judgeCandidateMetadata(base("Berlin fell in 1945.", { sourceQuery: "miniature diorama tank" })).reason
    ).toBe("rejected_stock");
  });

  it("only the narration is dropped: clipOwnQuery keeps every other query and ignores case/space", () => {
    expect(clipOwnQuery("Pixar changed animation forever.", "Pixar changed animation forever.")).toBe("");
    expect(clipOwnQuery("  pixar CHANGED  animation forever. ", "Pixar changed animation forever.")).toBe("");
    expect(clipOwnQuery("pixar studio footage", "Pixar changed animation forever.")).toBe("pixar studio footage");
    expect(clipOwnQuery("pixar studio footage", undefined)).toBe("pixar studio footage");
  });

  it("PERSON_OFFTOPIC_VISUAL_RE still refuses wildlife B-roll on a person film", () => {
    const v = judgeCandidateMetadata(
      base("Kylie Jenner grew up in Calabasas.", {
        path: "/w/scene_0_b1_clip.mp4",
        personTopic: true,
        primaryPerson: "Kylie Jenner",
        sourceQuery: "flamingos lake",
      })
    );
    expect(v.reason).toBe("person_topic_off_topic_visual");
  });

  it("clip-property filters still refuse: an AI-generated file is refused whatever the sentence", () => {
    expect(judgeCandidateMetadata(base("Kris Jenner built a media empire.", { path: "/w/scene_0_b0_stability_still.mp4" })).decision).toBe("REJECT");
  });

  it("wired in one place: both stock tests in judgeCandidateMetadata read clipQuery, the lists are untouched", () => {
    expect(VJ).toContain("const clipQuery = clipOwnQuery(sourceQuery, beatText);");
    expect(VJ).toContain('if (isRejectedStockClip(p, clipQuery)) return reject("metadata", "rejected_stock");');
    expect(VJ).toContain("const category = stockVisualCategory(clipQuery, p);");
    expect(VJ).toContain("emoji|cartoon|animation|icon|illustration|graphic|pattern|sticker|clipart");
    expect(VJ).toContain("miniature|diorama|tabletop|model[- ]?rocket|scale[- ]?model|toy[- ]?rocket|replica|maquette");
  });
});

/* ═══════════ G2 — under 3 s never reaches the picture editor ═══════════ */

describe("G2 — the archive's 3 s minimum, applied before review instead of after it", () => {
  it("the comparison is the ingestion's own: 2.99 under, 3.0 and 3.01 not, unmeasured never", () => {
    expect(MIN_VIDEO_DURATION_SEC).toBe(3);
    expect(belowArchiveMinimumDuration(2.09)).toBe(true);
    expect(belowArchiveMinimumDuration(2.99)).toBe(true);
    expect(belowArchiveMinimumDuration(3.0)).toBe(false);
    expect(belowArchiveMinimumDuration(3.01)).toBe(false);
    expect(belowArchiveMinimumDuration(0)).toBe(false);
  });

  it("the placement rule itself is unchanged: the ingestion still refuses under 3 s at the push", () => {
    expect(INGEST).toContain("export const MIN_VIDEO_DURATION_SEC = 3;");
    expect(INGEST).toContain("if (dur > 0 && dur < MIN_VIDEO_DURATION_SEC) {");
    expect(INGEST).toContain('return refuse("INVALID_DURATION", `${dur.toFixed(2)}s < ${MIN_VIDEO_DURATION_SEC}s`, observed);');
  });

  it("sits in the pool after the file, identity and black-frame checks and before any scoring or look", () => {
    const at = PIPE.indexOf("if (isYoutubeMomentPath(p) && belowArchiveMinimumDuration(await probeVideoDurationSec(p))) {");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.lastIndexOf("const mediaRefusal = await technicalMediaRefusal(p, MEDIA_PROBES);", at)).toBeGreaterThan(at - 1200);
    const after = PIPE.slice(at, at + 400);
    expect(after).toContain("refuse(INVALID_DURATION_BEFORE_REVIEW);");
    expect(after).toContain("continue;");
    expect(PIPE.indexOf("const beatMatch = scoreBeatNarrationMatch(beatText, sourceQuery, p);", at)).toBeGreaterThan(at);
    expect(PIPE).toContain('export const INVALID_DURATION_BEFORE_REVIEW = "invalid_duration_before_review";');
  });

  it("nothing is stretched or rounded on the way: no setpts, loop or speed in the new lines", () => {
    const at = PIPE.indexOf("VIDEO 638 (G2) — a YouTube moment the archive refuses at the push");
    const block = PIPE.slice(at, at + 1200);
    expect(block).not.toMatch(/setpts|stream_loop|Math\.ceil|Math\.round|atempo/);
  });
});

describe("G2 — real files through the real adoption loop", () => {
  let dir: string;
  const clip = (name: string, frames: number) => {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=1280x720:r=100`, "-frames:v", String(frames),
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", out,
    ]);
    return out;
  };
  let short299: string;
  let exact300: string;
  let over301: string;
  let pipeline: typeof import("./videoPipeline");
  let registry: typeof import("./rejectionRegistry");

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-g2-"));
    short299 = clip("scene_0_ytfu_0m0_t1674d30__pid_youtube_cc-1111111111111111.mp4", 299);
    /** A stock word in the FILE NAME refuses on metadata — proof the clip got past the duration check, without a look. */
    exact300 = clip("scene_0_ytfu_0m1_cartoon_t1700d30__pid_youtube_cc-2222222222222222.mp4", 300);
    over301 = clip("scene_0_ytfu_0m2_cartoon_t1720d30__pid_youtube_cc-3333333333333333.mp4", 301);
    pipeline = await import("./videoPipeline");
    registry = await import("./rejectionRegistry");
  }, 120_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const reasonsFor = async (file: string, beat: number) => {
    const dedup = pipeline.createVisualDedupState(pipeline.getPipelinePerfProfile("1"));
    const adopted = await pipeline.adoptClipForTest([file], dedup, 0, beat, "Kris Jenner built a media empire.", dir, "Kris Jenner built a media empire.");
    return { adopted, reasons: registry.beatRejectReasons(dedup.rejections, 0, beat).map(([r]) => r) };
  };

  it("2.99 s is refused before review, with the one reason", async () => {
    expect(await pipeline.probeVideoDurationSec(short299)).toBeCloseTo(2.99, 2);
    const { adopted, reasons } = await reasonsFor(short299, 0);
    expect(adopted).toBeNull();
    expect(reasons).toEqual(["invalid_duration_before_review"]);
  }, 60_000);

  it("3.00 s goes on to the next check (here: its own file name, on metadata)", async () => {
    expect(await pipeline.probeVideoDurationSec(exact300)).toBeCloseTo(3.0, 2);
    const { reasons } = await reasonsFor(exact300, 1);
    expect(reasons).not.toContain("invalid_duration_before_review");
    expect(reasons).toContain("rejected_stock");
  }, 60_000);

  it("3.01 s goes on as well", async () => {
    expect(await pipeline.probeVideoDurationSec(over301)).toBeCloseTo(3.01, 2);
    const { reasons } = await reasonsFor(over301, 2);
    expect(reasons).not.toContain("invalid_duration_before_review");
    expect(reasons).toContain("rejected_stock");
  }, 60_000);

  it("the refusal is a property of the file, so it holds for every sentence; only YouTube files are measured", () => {
    expect(pipeline.refusalHoldsForEverySentence("invalid_duration_before_review")).toBe(true);
    expect(pipeline.isYoutubeMomentPath(short299)).toBe(true);
    expect(pipeline.isYoutubeMomentPath("/w/scene_1_b4_primary_hist_archive_1__pid_internet_archive-1ee7f62d03abb626.mp4")).toBe(false);
    expect(pipeline.isYoutubeMomentPath("/w/scene_0_b1_curated_a58080.mp4")).toBe(false);
  });
});

/* ═══════════ G3 / G4 — YouTube already on disk is looked at first ═══════════ */

describe("G4 — inside one review pool, YouTube first, each group in its existing order", () => {
  let youtubeCandidatesFirst: (p: readonly string[]) => string[];
  beforeAll(async () => {
    ({ youtubeCandidatesFirst } = await import("./videoPipeline"));
  }, 60_000);

  const IA_PODCAST = "/w/scene_1_b3_primary_arch_archive_3__pid_internet_archive-1803926bd0ee2feb.mp4";
  const IA_NEWS = "/w/scene_1_b3_primary_arch_archive_2__pid_internet_archive-19419b78ffaeaa44.mp4";
  const ARCHIVE = "/w/scene_1_b3_curated_a58522.mp4";
  const YT1 = "/w/scene_1_ytfu_1m1_t1711d26__pid_youtube_cc-72f845c990660d8f.mp4";
  const YT2 = "/w/scene_1_ytfu_0m0_t5824d40__pid_youtube_cc-2e842625dab99c98.mp4";

  it("638 s1b3: the YouTube moments at ranks 4–5 come first, everything else keeps its order behind them", () => {
    expect(youtubeCandidatesFirst([ARCHIVE, IA_PODCAST, IA_NEWS, YT1, YT2])).toEqual([YT1, YT2, ARCHIVE, IA_PODCAST, IA_NEWS]);
  });

  it("nothing is added or removed, and a pool without YouTube is returned unchanged", () => {
    const pool = [ARCHIVE, IA_PODCAST, IA_NEWS];
    expect(youtubeCandidatesFirst(pool)).toEqual(pool);
    const mixed = [IA_NEWS, YT2, ARCHIVE, YT1];
    const out = youtubeCandidatesFirst(mixed);
    expect(out).toHaveLength(mixed.length);
    expect([...out].sort()).toEqual([...mixed].sort());
    expect(out).toEqual([YT2, YT1, IA_NEWS, ARCHIVE]);
  });

  it("applied once, before the existing move-back rules; the look loop and its ceilings are untouched", () => {
    expect(PIPE).toContain(
      "const lessFilled = preferLessFilledFootage(youtubeCandidatesFirst(tasteResult.rankedPaths), (p) => clipContentKey(p), dedup);"
    );
    expect(PIPE.match(/youtubeCandidatesFirst\(/g)?.length).toBe(2); // definition + one call
    expect(PIPE).toContain("const refusedElsewhere = putRefusedElsewhereLast(finalPaths, (p) =>");
    expect(PIPE).toContain("if (beatShortlistExhausted(dedup.beatShortlist, sceneIndex, beatIndex)) {");
    const BVR = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
    expect(BVR).toContain("return Number.isFinite(n) && n >= 1 && n <= 20 ? n : MAX_JUDGEMENTS_PER_BEAT + 1;");
    expect(BVR).toContain("if (!alreadyKnown && spentOnBeat >= maxRelevanceLooksPerBeat() && !params.finalSay) {");
  });
});

describe("G3 — ready YouTube for the sentence is looked at before the own archive", () => {
  let p: typeof import("./videoPipeline");
  let dir: string;
  beforeAll(async () => {
    p = await import("./videoPipeline");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-g3-"));
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fnBody = () => {
    const at = PIPE.indexOf("export async function fetchBeatArchivalThenPexels(");
    return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
  };

  it("asked before the archive lookup, and again before the archive hit's own look", () => {
    const body = fnBody();
    const before = body.indexOf('const youtubeBeforeArchive = await readyYoutubeFirst("before_archive");');
    const lookup = body.indexOf("ownArchiveBeatClip(beat, scene, workDir, sceneIndex, dedup, videoTitle)");
    const beforeHit = body.indexOf('const youtubeBeforeArchiveHit = await readyYoutubeFirst("before_archive_hit");');
    const hitLook = body.indexOf("archiveHitRefused = await archiveHitRefusedByPictureEditor(");
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(beforeHit);
    expect(beforeHit).toBeLessThan(hitLook);
    expect(body).toContain("if (youtubeBeforeArchive) return youtubeBeforeArchive;");
    expect(body).toContain("if (youtubeBeforeArchiveHit) return youtubeBeforeArchiveHit;");
  });

  it("takes only files already prepared for THIS sentence, through the one adoptClip — no search, no download", () => {
    const body = fnBody();
    const at = body.indexOf("const readyYoutubeFirst = async");
    const helper = body.slice(at, body.indexOf("};", at));
    expect(helper).toContain("takeReadyLookaheadCandidates(dedup, youtubeTurnKey(sceneIndex, beat.index))");
    expect(helper).toContain("adoptHistoricalBeatVideoPool(ready, beat, workDir, sceneIndex, dedup, loose)");
    expect(helper).toContain("if (ready.length === 0) return null;");
    expect(helper).not.toMatch(/fetchYouTubeCCClips|tryBeatRealYouTubeFootage|runCentralYoutube|searchYouTube|claimYoutubeTurn|youtubeSearchBudget/i);
  });

  it("nothing adopted → the archive flow runs exactly as before (no early return on an empty or refused set)", () => {
    const body = fnBody();
    expect(body).toContain("return clip && isAuthenticVideoClip(clip) ? clip : null;");
    expect(body).toContain('console.log(`[ArchiveFirst] s${sceneIndex}b${beat.index} ARCHIVE_HIT — no supplier asked`);');
    expect(body).toContain("noteTierAttempted(\"YOUTUBE\", \"youtube_first_turn\");");
  });

  it("not ready → nothing taken; ready but gone from disk → not offered; each file handed out once", () => {
    const dedup = {};
    expect(p.takeReadyLookaheadCandidates(dedup, "s0b0")).toEqual([]);
    const real = path.join(dir, "scene_2_ytfu_1m0_t5533d40__pid_youtube_cc-acc0dfc922f30224.mp4");
    fs.writeFileSync(real, "x");
    p.noteLookaheadCandidateReady(dedup, "s2b0", real);
    p.noteLookaheadCandidateReady(dedup, "s2b0", path.join(dir, "gone__pid_youtube_cc-0000000000000000.mp4"));
    expect(p.takeReadyLookaheadCandidates(dedup, "s2b0")).toEqual([real]);
    expect(p.takeReadyLookaheadCandidates(dedup, "s2b0")).toEqual([]);
    expect(p.lookaheadCandidateWasHanded(dedup, real)).toBe(true);
  });

  it("a file the sentence already took is never offered again as LATE to the next sentence", () => {
    expect(PIPE).toContain(
      "const rest = late.paths.filter((p) => !ready.includes(p) && !lookaheadCandidateWasHanded(dedup, p));"
    );
  });

  it("638 s0b0: the moments ready before its old boundary were all under 3 s — G2 removes them, no false promise", () => {
    for (const ms of [2.09, 2.3, 2.3]) expect(belowArchiveMinimumDuration(ms)).toBe(true);
    /** s2b0 had YRvf 3× 4.0 s and QIt8 3.5/3.6 s ready: those pass G2 and go first. */
    for (const ms of [4.0, 4.0, 4.0, 3.5, 3.6]) expect(belowArchiveMinimumDuration(ms)).toBe(false);
    expect(belowArchiveMinimumDuration(2.9)).toBe(true);
  });
});

/* ═══════════ untouched ═══════════ */

describe("untouched: search limit, per-beat search, W1–W6, F2", () => {
  it("the YouTube search limit is still 2 per video", async () => {
    const { MAX_YOUTUBE_SEARCHES_PER_VIDEO } = await import("./youtubeSearchBudget");
    expect(MAX_YOUTUBE_SEARCHES_PER_VIDEO).toBe(2);
  });
});
