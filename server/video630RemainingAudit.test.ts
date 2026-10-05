/**
 * VIDEO 630 — the last four release blockers, each fixed where it starts.
 *
 *   F1  Stability answered HTTP 402 (credits spent) and was asked again for every sentence.
 *   F2  The main subject was "Europe" for a film titled "How World War II Changed the World
 *       Forever", so the rescue round searched maps of the European Union.
 *   F3  The storyboard model returned the prompt's own rules as beat 0's shot.
 *   F4  "World War II's" / "Germany’s" in the narration did not prove "II" / "Germany".
 *
 * And what must stay as it was: the Judge, the look ceilings, P0/P1/P2 and the identity rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const llm = vi.hoisted(() => ({ reply: "" as string }));
vi.mock("./_core/llm", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    invokeLLM: vi.fn(async () => ({ choices: [{ message: { content: llm.reply } }] })),
  };
});

import {
  ACCOUNT_REFUSAL_COOLDOWN_MS,
  generatedImageDecision,
  imageServiceStandingDown,
  resetImageServiceStandDownForTests,
  setStillImageGeneratorForTests,
  stillImageGenerator,
} from "./generatedImageFallback";
import { namedInHeading, videoMainSubject } from "./mainSubject";
import { enrichBeatFromShot, getOrGenerateStoryboard, getShotForBeat, shotEchoesRules } from "./editorialSequencePlanner";
import { evidenceStems, validateSearchQuery, type VerifiedQueryContext } from "./searchQueryContract";
import { approvalRestsOnAGuess, MAX_JUDGEMENTS_PER_BEAT, maxBeatImageJudgementsPerRender } from "./beatImageRelevanceGate";
import { maxRelevanceLooksPerBeat, putRefusedElsewhereLast } from "./beatVisualRelevance";
import { onScreenTextRefusesBeforeVision } from "./visualJudge";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Render 630's narration, as its VisualIntentPlan lines logged it. */
const V630 = {
  prompt: "Ww2 explained",
  title: "How World War II Changed the World Forever",
  sceneTexts: [
    "September 1, 1939. Adolf Hitler orders German troops into Poland, igniting a conflict that spreads like wildfire. " +
      "As tanks rumble through Warsaw, Europe holds its breath. How did this invasion spark a war that would engulf the " +
      "entire world? But this was only the beginning of a conflict that would engulf the world.",
    "Over 100 million people mobilized for a conflict that spanned continents and oceans. Battles raged across Europe " +
      "and the vast Pacific. Leaders like Franklin Roosevelt and Joseph Stalin commanded immense forces. But despite the " +
      "horrors, pivotal moments redefined the war and its outcome. As dawn broke on June 6, 1944, the D-Day Invasion " +
      "launched with ferocity across the English Channel. Under Dwight Eisenhower's command, Allied forces swarmed " +
      "Normandy's beaches, dismantling Europe's defences. This audacious gamble turned the tide against Nazi control. " +
      "But how could such devastation lead to a reconstructed world?",
    "World War II's destruction led to progress unimaginable in its time. With the dawn of the United Nations in " +
      "San Francisco, delegates from many nations met. Was this the birth of modern global collaboration?",
  ],
};

describe("F1 — an account refusal (401/402/403) stands Stability down for 30 minutes", () => {
  const calls: number[] = [];
  beforeEach(() => {
    resetImageServiceStandDownForTests();
    setStillImageGeneratorForTests(null);
    calls.length = 0;
    vi.stubEnv("STABILITY_AI_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetImageServiceStandDownForTests();
  });
  /** The service answers `status`; a 200 carries a PNG-sized body. */
  const answer = (status: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push(status);
        return status === 200 ? new Response(Buffer.alloc(5_000, 7), { status }) : new Response("no", { status });
      })
    );
  const out = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "f1-")), "x.png");
  const ask = () => stillImageGenerator()("German tanks rolling through Warsaw", out());

  it("1–3. first 402 stands the provider down; the second and third beat send no request", async () => {
    answer(402);
    expect(await ask()).toBe(false);
    expect(imageServiceStandingDown()).toBe(true);
    expect(await ask()).toBe(false);
    expect(await ask()).toBe(false);
    expect(calls).toEqual([402]);
  });

  it("4–5. unavailable for 30 minutes, asked again after expiry — no permanent blacklist", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T14:09:47Z"));
    answer(402);
    await ask();
    expect(ACCOUNT_REFUSAL_COOLDOWN_MS).toBe(30 * 60_000);
    vi.setSystemTime(new Date("2026-10-05T14:39:46Z"));
    expect(imageServiceStandingDown()).toBe(true);
    await ask();
    expect(calls).toEqual([402]);
    vi.setSystemTime(new Date("2026-10-05T14:39:48Z"));
    expect(imageServiceStandingDown()).toBe(false);
    answer(200);
    expect(await ask(), "credits topped up: the picture is made again").toBe(true);
    expect(calls).toEqual([402, 200]);
  });

  it("401 and 403 are about the account too; a 500 or a 400 stays per picture", async () => {
    for (const status of [401, 403]) {
      resetImageServiceStandDownForTests();
      calls.length = 0;
      answer(status);
      await ask();
      await ask();
      expect(calls).toEqual([status]);
    }
    for (const status of [500, 400]) {
      resetImageServiceStandDownForTests();
      calls.length = 0;
      answer(status);
      await ask();
      await ask();
      expect(calls).toEqual([status, status]);
      expect(imageServiceStandingDown()).toBe(false);
    }
  });

  it("6. other fallbacks carry on: the loop stops without throwing, and the chapter card / graphics never read the stand-down", async () => {
    answer(402);
    await ask();
    const loop = PIPE.slice(PIPE.indexOf("async function generateMissingBeatImages("));
    const stop = loop.indexOf("if (imageServiceStandingDown()) {");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(loop.indexOf("const clip = await fetchBeatGeneratedImage("));
    expect(loop.slice(stop, stop + 300)).toContain("return;");
    /** One reader in the pipeline: the generated-image loop. */
    expect(PIPE.match(/imageServiceStandingDown\(\)/g)).toHaveLength(1);
    const inputs = fs.readFileSync(path.join(__dirname, "cinematicPipelineInputs.ts"), "utf8");
    expect(inputs).not.toContain("imageServiceStandingDown");
    /** The decision itself is untouched: a sentence still qualifies for a picture by its own rules. */
    expect(generatedImageDecision({ hasPicture: false, graphicCanStandIn: false, people: [], budgetLeft: 3 })).toEqual({ generate: true });
  });

  it("7. a working Stability flow is unchanged: the picture is written and nothing stands down", async () => {
    answer(200);
    const file = out();
    expect(await stillImageGenerator()("German tanks rolling through Warsaw", file)).toBe(true);
    expect(fs.statSync(file).size).toBe(5_000);
    expect(await ask()).toBe(true);
    expect(calls).toEqual([200, 200]);
    expect(imageServiceStandingDown()).toBe(false);
  });
});

describe("F2 — the main subject is what the video is about, when the narration says it", () => {
  const film = (prompt: string, title: string, ...sceneTexts: string[]) => ({ prompt, title, sceneTexts });

  it("World War II → World War II (render 630, and the prompt example), not Europe", () => {
    expect(videoMainSubject(null, V630)).toBe("World War II");
    expect(
      videoMainSubject(null, film("The history of World War II", "t", "World War II changed Europe forever.", "Europe was rebuilt. Europe recovered."))
    ).toBe("World War II");
  });

  it("Berlin Wall → Berlin Wall", () => {
    expect(
      videoMainSubject(
        null,
        film("The fall of the Berlin Wall", "The Fall of the Berlin Wall",
          "In 1961 Germany was divided. East Germany sealed the border.", "In 1989 the Berlin Wall fell. Crowds filled Germany's streets.")
      )
    ).toBe("Berlin Wall");
  });

  it("Space Race → Space Race", () => {
    expect(
      videoMainSubject(
        null,
        film("the space race", "The Space Race",
          "The Space Race began in 1957. The Soviet Union launched Sputnik.", "America answered. The Soviet Union sent Gagarin up.")
      )
    ).toBe("Space Race");
  });

  it("no subject of the prompt or title in the narration → the old fallback decides, unchanged", () => {
    const dutch = { ...V630, prompt: "De val van de Berlijnse Muur in 1989", title: "x" };
    expect(videoMainSubject(null, dutch)).toBe("Europe");
    expect(videoMainSubject(null, { prompt: "x", title: "x", sceneTexts: ["It happened in 1999. Nobody knew why."] })).toBeNull();
  });

  it("no regression for ordinary subjects: a locked person first, a single title word only when it is a name", () => {
    expect(videoMainSubject("Elon Musk", V630)).toBe("Elon Musk");
    expect(
      videoMainSubject(null, film("the story of the Titanic", "Titanic",
        "In 1912 the Titanic left Southampton. The Titanic was the largest ship afloat.", "The Titanic struck an iceberg in 1912."))
    ).toBe("Titanic");
    /** "Changed the World" is in the title; the narration writes "the world" — never a subject. */
    expect(namedInHeading(["How World War II Changed the World Forever"], "It changed the world.", [])).toBeNull();
    expect(namedInHeading(["How Steel Changed Everything"], "How did it start? Steel was cheap.", [])).toBeNull();
    /** No hard-coded subjects: the rule knows none of the names above. */
    const src = fs.readFileSync(path.join(__dirname, "mainSubject.ts"), "utf8");
    for (const name of ["World War", "Berlin", "D-Day", "Space Race", "Europe"]) {
      expect(src.replace(/\/\*\*[\s\S]*?\*\//g, ""), name).not.toContain(name);
    }
  });
});

describe("F3 — a storyboard shot that echoes the prompt's instructions is dropped", () => {
  const real = (searchQuery: string, shotType = "wide", visualStyle = "newsreel") => ({ shotType, visualStyle, searchQuery });

  it("an exact rule line → filtered (render 630's beat-0 shot)", () => {
    expect(
      shotEchoesRules({
        shotType: "wide/medium/close-up/aerial/extreme close-up/archival still/map/document",
        visualStyle: "photograph/video footage/engraving/painting/newsreel/map/illustration",
        searchQuery: "4-7 words, specific and searchable on stock/archive sites",
      })
    ).toBe(true);
    expect(shotEchoesRules(real("4-7 words, specific and searchable on stock/archive sites"))).toBe(true);
  });

  it("a partial instruction echo → filtered", () => {
    expect(shotEchoesRules(real("4-7 words, specific"))).toBe(true);
    expect(shotEchoesRules(real("specific and searchable on stock/archive sites"))).toBe(true);
    expect(shotEchoesRules(real("German tanks Warsaw", "wide/medium/close-up"))).toBe(true);
    expect(shotEchoesRules(real("German tanks Warsaw", "wide", "photograph/video footage"))).toBe(true);
    expect(shotEchoesRules(real("find a concrete visual metaphor"))).toBe(true);
  });

  it("a normal short shot and a normal 4–7 word shot → kept; one option on its own is an answer", () => {
    expect(shotEchoesRules(real("Crowds gather at Checkpoint Charlie"))).toBe(false);
    expect(shotEchoesRules(real("Checkpoint Charlie"))).toBe(false);
    expect(shotEchoesRules(real("German tanks rolling through Warsaw 1939", "extreme close-up", "photograph"))).toBe(false);
    expect(shotEchoesRules(real("Allied troops landing Normandy beach", "archival still", "video footage"))).toBe(false);
    expect(shotEchoesRules(real("world map spread of war", "map", "map"))).toBe(false);
  });

  it("no regression to an empty scene: the echo is dropped, the real shot kept, the beat keeps its own query", async () => {
    llm.reply = JSON.stringify({
      shots: [
        { beatIndex: 0, shotType: "wide/medium/close-up", action: "", location: "", era: "", visualStyle: "photograph", searchQuery: "4-7 words, specific", alternatives: [], emotion: "neutral" },
        { beatIndex: 1, shotType: "wide", action: "crowds at the wall", location: "Berlin", era: "1989", visualStyle: "newsreel", searchQuery: "Crowds gather at Checkpoint Charlie", alternatives: [], emotion: "tense" },
      ],
    });
    const board = await getOrGenerateStoryboard(9630, "scene", [{ index: 0, text: "a" }, { index: 1, text: "b" }], "t", {
      people: [], period: "", locations: [], visualStyles: [],
    });
    expect(board.shots.map((s) => s.beatIndex)).toEqual([1]);
    expect(getShotForBeat(9630, 0)).toBeNull();
    expect(getShotForBeat(9630, 1)?.searchQuery).toBe("Crowds gather at Checkpoint Charlie");
    /** What the pipeline does with "no shot": the beat's own query, untouched. */
    expect(enrichBeatFromShot("a", ["german troops poland 1939"], getShotForBeat(9630, 0)).pexelsQueries).toEqual(["german troops poland 1939"]);
  });
});

describe("F4 — a possessive proves the word itself, whole words only", () => {
  const ctx = (evidence: string): VerifiedQueryContext => ({
    persons: [], places: [], countries: [], events: [], actions: [], objects: [], time: [], years: [], evidence,
  });
  const proves = (evidence: string, query: string) => validateSearchQuery(query, ctx(evidence)).ok;

  it("Germany’s → Germany, America’s → America, Hitler’s → Hitler (typographic and plain apostrophe)", () => {
    for (const q of ["’", "'", "‘", "ʼ"]) {
      expect(proves(`Germany${q}s history`, "Germany"), q).toBe(true);
      expect(proves(`America${q}s economy`, "America"), q).toBe(true);
      expect(proves(`Hitler${q}s rise`, "Hitler"), q).toBe(true);
    }
    /** Short words too: render 630's "II". */
    expect(evidenceStems("II’s")).toContain("ii");
    expect(proves("World War II's destruction led to progress.", "World War II")).toBe(true);
  });

  it("plain Germany → Germany, unchanged", () => {
    expect(proves("Germany invaded Poland.", "Germany")).toBe(true);
  });

  it("no false positive from a longer word, and no wider gate", () => {
    expect(proves("Americana’s charm", "America")).toBe(false);
    expect(proves("Germanic’s roots", "Germany")).toBe(false);
    expect(proves("He raised his arm.", "army")).toBe(false);
    /** Render 630's query: "post-war" is still a word the sentence never says. */
    const q = validateSearchQuery("World War II post-war industrial progress", ctx("World War II's destruction led to progress."));
    expect(q.ok).toBe(false);
    expect(q.offendingTerm).toBe("post-war");
  });
});

describe("regression — what these fixes must not move", () => {
  it("look ceilings and render budget unchanged: 4 + 1 per sentence, 120 per render", () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBe(4);
    expect(maxRelevanceLooksPerBeat()).toBe(5);
    expect(maxBeatImageJudgementsPerRender()).toBe(120);
  });

  it("P0 baked text and P2 ordering still hold", () => {
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "fills_picture" })).toBe(true);
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "overlay" })).toBe(false);
    expect(putRefusedElsewhereLast(["refused_a", "fresh_b"], (p) => p.startsWith("refused_")).paths).toEqual(["fresh_b", "refused_a"]);
  });

  it("P1, technical refusals and the identity rule still hold", async () => {
    const pipe = await import("./videoPipeline");
    expect(pipe.archiveHitIsRefused({ verdict: "does_not_fit", evaluated: true, reprieved: false })).toBe(true);
    expect(pipe.refusalHoldsForEverySentence("not_a_valid_video")).toBe(true);
    expect(pipe.refusalHoldsForEverySentence("refused on s1b4: does not fit")).toBe(false);
    expect(
      approvalRestsOnAGuess(
        { verdict: "fits", depicts: "A man at a podium.", reason: "The speaker appears to be Joseph Stalin." },
        "Joseph Stalin commanded immense forces.", undefined, () => "Joseph Stalin"
      )
    ).toBe(true);
  }, 120_000);
});
