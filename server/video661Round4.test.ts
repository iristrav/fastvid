import { describe, expect, it } from "vitest";
import { segmentFrameCount } from "./timelineRenderer";
import { cardPhrase, chapterCardFallbackFor, filmSubjectChapterCard } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { WORLD_LOCATIONS, spokenLocationName } from "./cinematicMotion/locationMap";
import { placeSaidIn } from "./cinematicEditingEngine/captionPlanner";
import { adoptionIsClipAsset, pickLocalFileByIdentity, pickLocalFileForClip } from "./cinematicPipelineInputs";
import { stripWriterInstructions } from "./scriptWriter";
import type { VisualIntent } from "./visualMatchingV2/types";

/**
 * VIDEO 661, round 4 — from render 70: chapter cards said one word only, one black frame stood
 * before a card, and "the Netherlands" was pinned as Amsterdam.
 */

describe("VIDEO 661 — a card says the sentence's own phrase under its title", () => {
  const spoken = "Rotterdam became the busiest port of Europe, moving goods across the continent.";

  it("the phrase comes from the sentence and never repeats the title", () => {
    expect(cardPhrase("Netherlands", spoken)).toEqual({ subtitle: expect.any(String) });
    expect(spoken.toLowerCase()).toContain(cardPhrase("Netherlands", spoken).subtitle!.toLowerCase());
    expect(cardPhrase("Rotterdam became the busiest", "Rotterdam became the busiest")).toEqual({});
    expect(cardPhrase("Netherlands", "")).toEqual({});
  });

  it("both card builders carry it", () => {
    const filmCard = filmSubjectChapterCard("Netherlands", 0, 5, spoken)!;
    expect(filmCard.data.subtitle).toBeTruthy();
    const intent = {
      spokenText: spoken, events: [], people: [], visualSubject: "Rotterdam harbour cranes", visualTime: "",
    } as unknown as VisualIntent;
    const sentenceCard = chapterCardFallbackFor(intent, 0, 5);
    expect(sentenceCard).not.toBeNull();
    expect(sentenceCard!.data.subtitle).toBeTruthy();
  });

  it("the renderer draws the subtitle on a chapter card", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");
    const chapter = src.slice(src.indexOf('case "chapter_card":'), src.indexOf("default:", src.indexOf('case "chapter_card":')));
    expect(chapter).toContain('readAny(g, "subtitle")');
  });
});

describe("VIDEO 661 — segments are counted on the timeline's own frame grid (no black frame)", () => {
  it("contiguous hard cuts add up to exactly the frame the overlay uses, however many there are", () => {
    const fps = 30;
    /** lengths that each round differently: 2.349 → 70 frames, 2.351 → 71, 2.345 → 70 (70.35) */
    const lengths = [2.349, 2.351, 2.345, 3.017, 1.983, 4.444, 2.016, 5.05, 1.234, 3.333];
    let t = 0;
    let frames = 0;
    for (let i = 0; i < 40; i++) {
      const len = lengths[i % lengths.length]!;
      const clip = { timelineStart: Number(t.toFixed(3)), timelineEnd: Number((t + len).toFixed(3)) };
      frames += segmentFrameCount(clip, fps);
      t = clip.timelineEnd;
      /** the next cut starts exactly where Remotion puts its graphics: round(start × fps) */
      expect(frames).toBe(Math.round(clip.timelineEnd * fps));
    }
  });

  it("the seconds-based count drifted, which is what put the black frame on screen", () => {
    const fps = 30;
    const lengths = [2.349, 2.351, 2.345, 3.017, 1.983, 4.444, 2.016, 5.05, 1.234, 3.333];
    let t = 0;
    let old = 0;
    let drifted = false;
    for (let i = 0; i < 40; i++) {
      const len = lengths[i % lengths.length]!;
      old += Math.round(len * fps);
      t += len;
      if (old !== Math.round(t * fps)) drifted = true;
    }
    expect(drifted).toBe(true);
  });

  it("a transition handle adds its own whole frames", () => {
    expect(segmentFrameCount({ timelineStart: 1, timelineEnd: 3 }, 30, 0.5)).toBe(60 + 15);
    expect(segmentFrameCount({ timelineStart: 1, timelineEnd: 1.001 }, 30)).toBe(1);
  });
});

describe("VIDEO 661 — the map and the location tag name only what the voice says", () => {
  const amsterdam = WORLD_LOCATIONS.find((l) => l.iso3 === "NLD")!;

  it("'the Netherlands' is labelled Netherlands, 'Amsterdam' is labelled Amsterdam", () => {
    expect(spokenLocationName(amsterdam, "netherlands")).toBe("Netherlands");
    expect(spokenLocationName(amsterdam, "dutch")).toBe("Netherlands");
    expect(spokenLocationName(amsterdam, "amsterdam")).toBe("Amsterdam");
  });

  it("every country keyword names its country, not its capital", () => {
    const by = (iso3: string, kw: string) => spokenLocationName(WORLD_LOCATIONS.find((l) => l.keywords.includes(kw) && l.iso3 === iso3)!, kw);
    expect(by("FRA", "france")).toBe("France");
    expect(by("DEU", "germany")).toBe("Germany");
    expect(by("GBR", "uk")).toBe("United Kingdom");
    expect(by("USA", "america")).toBe("United States");
    expect(by("ZAF", "south africa")).toBe("South Africa");
    expect(by("FRA", "paris")).toBe("Paris, France");
  });

  it("Gaza, Tel Aviv and Palestine are no longer pinned on Jerusalem", () => {
    const all = WORLD_LOCATIONS.flatMap((l) => l.keywords);
    for (const kw of ["gaza", "tel aviv", "palestin"]) expect(all).not.toContain(kw);
  });

  it("the location tag is written only when the sentence says the place", () => {
    expect(placeSaidIn("Netherlands", "Water has shaped this low country for centuries.")).toBeNull();
    expect(placeSaidIn("Netherlands", "The Netherlands has fought the sea for centuries.")).toBe("Netherlands");
    expect(placeSaidIn("Rotterdam, Netherlands", "Rotterdam handles more cargo than any port in Europe.")).toBe("Rotterdam");
    expect(placeSaidIn("", "Rotterdam")).toBeNull();
  });
});

describe("VIDEO 661 — two moments of one YouTube video each get their own file (s1b4)", () => {
  /** Render 70: Ab1qyz96XiE at 82.8 s (archive 61497) and 92.7 s (61498), both approved for s1b4. */
  const adoption = (archiveAssetId: number) =>
    ({ provider: "youtube_cc", providerAssetId: "Ab1qyz96XiE", archiveAssetId, sourceUrl: "", assetTitle: "", query: "" }) as never;
  const files = [
    { path: "/tmp/s1b4_61497.mp4", adoption: adoption(61497) },
    { path: "/tmp/s1b4_61498.mp4", adoption: adoption(61498) },
  ];
  const clip = (archiveAssetId: number, sourceIn: number) => ({
    source: { provider: "youtube_cc", providerAssetId: "Ab1qyz96XiE", archiveAssetId },
    sourceIn,
  });

  it("the second moment is no longer handed the first moment's file", () => {
    expect(pickLocalFileForClip(files, clip(61497, 0))).toBe("/tmp/s1b4_61497.mp4");
    expect(pickLocalFileForClip(files, clip(61498, 0))).toBe("/tmp/s1b4_61498.mp4");
    expect(pickLocalFileByIdentity(files, clip(61498, 0))).toBe("/tmp/s1b4_61498.mp4");
  });

  it("without an archive id on one side the provider id still decides, as before", () => {
    const noArchive = { source: { provider: "youtube_cc", providerAssetId: "Ab1qyz96XiE" }, sourceIn: 0 };
    expect(pickLocalFileForClip(files, noArchive)).toBe("/tmp/s1b4_61497.mp4");
    expect(adoptionIsClipAsset({ providerAssetId: "other" }, adoption(61497))).toBe(false);
    expect(adoptionIsClipAsset({ archiveAssetId: 1 }, adoption(61497))).toBe(false);
  });
});

describe("VIDEO 661 — a scene does not end on a question (the planner's bridge)", () => {
  const script = [
    "# Water and Power",
    "## Opening",
    "The Dutch built a country below the sea. How did they survive?",
    "## The Dikes",
    "Engineers raised walls of earth and stone along every coast. How did these engineering feats transform into economic power?",
    "## The Port",
    'Rotterdam grew into the busiest port of Europe. A trader once asked, "Why here?"',
    "## Today",
    "Ships still arrive every hour.",
  ].join("\n");

  it("removes the scene-ending question, keeps the hook's question, quotes and statements", () => {
    const { script: out, removed } = stripWriterInstructions(script);
    expect(removed).toEqual(["How did these engineering feats transform into economic power?"]);
    expect(out).toContain("How did they survive?");
    expect(out).toContain('"Why here?"');
    expect(out).toContain("Engineers raised walls of earth and stone along every coast.");
  });

  it("a scene that is only a question keeps it — silence is worse", () => {
    const only = "# T\n## Opening\nA fact.\n## Two\nWhy did it fail?\n## Three\nIt failed.";
    expect(stripWriterInstructions(only).script).toContain("Why did it fail?");
  });

  it("the prompts ask for statements: bridges and loops are no longer questions", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const writer = fs.readFileSync(path.join(__dirname, "scriptWriter.ts"), "utf8");
    const engine = fs.readFileSync(path.join(__dirname, "scriptEngine.ts"), "utf8");
    expect(writer).toContain("at most ONE question in the whole script");
    expect(writer).not.toContain("MICRO LOOPS: Every 3–5 sentences — rhetorical questions");
    expect(engine).toContain("written as a statement, never as a question");
  });
});
