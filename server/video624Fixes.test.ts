/**
 * VIDEO 624 — what the logs of the first render after the neutral rules showed.
 *
 *   1  tnBQmEqBCY0 came from the archive without a title. The clip downloaded, reached the beat,
 *      and was refused for `entity_evidence`: the person check had no text to read. YouTube's own
 *      title was in the videos.list answer the pool already asked for.
 *   2  "Uncover Musk's tales…" gave the capital-letter reader a person called "Uncover Musk", and
 *      "Uncover Musk" went to Unsplash, archive.org, Pexels and Pixabay. The render's reading of the
 *      narration had named one person, Elon Musk. Every capitalised name is now read against it.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { buildVideoYoutubePool, withYoutubeOwnText, type PoolDeps, type SearchItem } from "./youtubeVideoPool";
import { extractBeatRealEntities, personAsRead, setRenderPeopleReadingForTests } from "./videoPipeline";

const TITLE = "How Elon Musk shapes the news";
const input = {
  videoId: 624_001,
  prompt: TITLE,
  title: TITLE,
  sceneTexts: ["Elon Musk posts, and the papers follow.", "Uncover Musk's tales and you find a strategy."],
};

describe("1. an archive item carries YouTube's own title", () => {
  const archived = (videoId: string, title: string): SearchItem => ({ videoId, title, description: "", channel: "archive", thumb: "t" });
  const own = { durationSec: 600, embeddable: true, live: false, title: "Elon Musk at the AI meeting", description: "Full speech", channel: "News Channel" };

  it("an empty or placeholder title is filled; a real one is kept", () => {
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", ""), own).title).toBe("Elon Musk at the AI meeting");
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", "YouTube tnBQmEqBCY0"), own).title).toBe("Elon Musk at the AI meeting");
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", "Stored title"), own).title).toBe("Stored title");
    const filled = withYoutubeOwnText(archived("tnBQmEqBCY0", ""), own);
    expect(filled.description).toBe("Full speech");
    expect(filled.channel).toBe("News Channel");
    /** Without an answer from YouTube the item is what it was. */
    expect(withYoutubeOwnText(archived("tnBQmEqBCY0", ""), null).title).toBe("");
  });

  it("the pool's candidate from the archive carries the title the beat's person check reads", async () => {
    const deps: PoolDeps = {
      store: memoryYoutubeSearchBudgetStore(),
      llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Elon Musk", recurringSubjects: [], query: "Elon Musk" }) } }] }),
      gate: () => ({ ok: true }),
      search: async () => ({ status: 200, items: [] }),
      details: async (ids) => new Map(ids.map((id) => [id, own])),
      triage: async () => ({ footageType: "real_footage", servesBeats: [0], depicts: "" }),
      archive: async () => [archived("tnBQmEqBCY0", "")],
      notFootage: () => null,
      log: () => {},
    };
    const pool = await buildVideoYoutubePool(deps, input);
    const c = pool.candidates.find((x) => x.videoId === "tnBQmEqBCY0");
    expect(c?.title).toBe("Elon Musk at the AI meeting");
    expect(c?.description).toBe("Full speech");
  });

  it("the production videos.list keeps the snippet's title, description and channel", () => {
    const src = fs.readFileSync(path.join(__dirname, "youtubeVideoPoolProduction.ts"), "utf8");
    expect(src).toContain('url.searchParams.set("part", "contentDetails,status,snippet")');
    expect(src).toMatch(/title: v\.snippet\?\.title/);
    expect(src).toMatch(/description: v\.snippet\?\.description/);
    expect(src).toMatch(/channel: v\.snippet\?\.channelTitle/);
  });
});

describe("2. a capitalised name is the person the reading names", () => {
  afterEach(() => setRenderPeopleReadingForTests(null));

  it("a word shared with one read person is that person; none shared is no person", () => {
    setRenderPeopleReadingForTests(["Elon Musk"]);
    expect(personAsRead("Uncover Musk")).toBe("Elon Musk");
    expect(personAsRead("Musk's")).toBe("Elon Musk");
    expect(personAsRead("elon musk")).toBe("Elon Musk");
    expect(personAsRead("Palo Alto")).toBeNull();
  });

  it("the same for any name, and two people sharing a word stay a person", () => {
    setRenderPeopleReadingForTests(["Marie Curie", "Pierre Curie"]);
    expect(personAsRead("Marie Curie")).toBe("Marie Curie");
    expect(personAsRead("Discover Curie")).toBe("Discover Curie");
    expect(personAsRead("Sorbonne")).toBeNull();
    setRenderPeopleReadingForTests(["Frida Kahlo"]);
    expect(personAsRead("Meet Kahlo")).toBe("Frida Kahlo");
  });

  it("without a reading nothing changes", () => {
    setRenderPeopleReadingForTests(null);
    expect(personAsRead("Uncover Musk")).toBeUndefined();
  });

  it("no rule for a person called 'Uncover Musk', and 'Our Musk' is not a thing called Musk", () => {
    setRenderPeopleReadingForTests(["Elon Musk"]);
    const of = (t: string) => extractBeatRealEntities(t).map((r) => `${r.kind}:${r.stockQueries[0]}`);
    expect(of("Uncover Musk's tales of war.")).toEqual([]);
    expect(of("Our Musk is a myth.")).toEqual([]);
    expect(of("Elon Musk tweets. Uncover Musk himself.")).toEqual(["person:Elon Musk"]);
    expect(of("In 1976 Steve Jobs founded a company in Palo Alto.")).not.toContain("person:Palo Alto");
  });

  it("the scene's persons are read the same way", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const body = src.slice(src.indexOf("function resolveScenePersons("), src.indexOf("function resolveScenePersons(") + 1400);
    expect(body).toContain("personAsRead(name)");
    expect(body).toMatch(/if \(read === null\) continue;/);
  });
});
