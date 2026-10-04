/**
 * AUDIT 3f9ba94 — image search and image choice (renders 627/628 and the ten-topic probe).
 *
 *   F1  a sentence's query says what the viewer must see (its VisualIntent), not only its names;
 *   F2  a beat finds its VisualIntent plan through a lost article or a split sentence;
 *   F3  a short shot may be a small file when its duration is measured;
 *   F4  the archive router matches whole words, never fragments or stop words;
 *   F5  tied candidates are ordered by the sentence's subject words — the Judge still decides;
 *   F6  an asset refused for what the FILE is is not offered again this render;
 *   F9  MediaForm is a preference the ranking reads;
 *   F10 an abstract sentence still asks something when its plan says what to show.
 *
 * F7 (fill only with a verdict for the new sentence) and F8 (only drawable graphics planned) are
 * pinned in `auditFillAndGraphics.test.ts`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  namesInSentence,
  sentenceOnlyYoutubeQueries,
  subjectWordOverlap,
  subjectWords,
  visualIntentSearchQuery,
} from "./youtubeNonFootage";
import {
  compareScoredCandidates,
  pathsNotRefusedEarlier,
  refusalHoldsForEverySentence,
  STILL_FRIENDLY_FORMS,
  youtubeQueryPlanForSentence,
} from "./videoPipeline";
import { storedVisualIntentForBeat, withRenderVisualPlan } from "./scriptVisualKeywords";
import {
  ADOPT_MIN_FILE_BYTES,
  isSizeFloorRefusal,
  technicalFileRefusal,
  technicalMediaRefusal,
} from "./technicalMediaGate";
import { scoreArchiveMetadata } from "./curatedMediaSourcing";
import { mediaFormsForIntent } from "./beatVisualIntent";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const PIPELINE = read("videoPipeline.ts");

/** One plan entry, the way the visual director stores it. */
const planned = (sentence: string, search_query: string, visual_description = search_query) => ({
  sentence,
  primary_keyword: search_query,
  search_query,
  visual_description,
});

/* ═══════════════════════ F1 — the query says what the viewer must see ═══════════════════════ */

describe("F1 — a sentence's query comes from its VisualIntent", () => {
  it("a sentence that names nobody gets its VisualIntent query instead of nothing", () => {
    const sentence = "Scientists cut a single gene inside a living cell, changing how disease could be treated.";
    const intent = { search_query: "CRISPR gene editing scientists laboratory" };
    /** Before: the sentence cut alone left nothing. */
    expect(youtubeQueryPlanForSentence(["CRISPR gene editing laboratory documentary footage"], sentence, sentence, undefined).queries).toEqual([]);
    const plan = youtubeQueryPlanForSentence(["CRISPR gene editing laboratory documentary footage"], sentence, sentence, intent);
    expect(plan.from).toBe("intent");
    expect(plan.queries[0]).toBe("CRISPR gene editing scientists laboratory");
  });

  it("a sentence with names keeps its names AND gains the context of what is happening", () => {
    const sentence = "In the 2022 World Cup final in Qatar, Messi lifted the trophy after a dramatic penalty shootout.";
    const q = visualIntentSearchQuery({ search_query: "Messi lifting World Cup trophy celebration" }, sentence, sentence);
    expect(q.toLowerCase()).toContain("messi");
    expect(q.toLowerCase()).toContain("trophy");
    const words = q.toLowerCase().split(/\s+/);
    expect(new Set(words).size).toBe(words.length);
    expect(words.length).toBeLessThanOrEqual(7);
    /** And the sentence's own cut still follows it, so nothing it asked before is lost. */
    const plan = youtubeQueryPlanForSentence(["Messi World Cup 2022 final"], sentence, sentence, { search_query: "Messi lifting World Cup trophy" });
    expect(plan.queries[0]).toContain("trophy");
    expect(plan.queries).toContain("Messi World Cup 2022 final");
  });

  it("no word is asked twice: 'Amazon Amazon' and 'Messi Messi' collapse", () => {
    expect(sentenceOnlyYoutubeQueries(["Amazon Amazon"], "The Amazon carries more water than any river.", "", "", ["Amazon"])).toEqual(["Amazon"]);
    expect(sentenceOnlyYoutubeQueries(["Messi Messi World Cup"], "Messi lifted the World Cup.", "lifted")).toEqual(["Messi World Cup"]);
  });

  it("production words and a placeholder plan never become the query", () => {
    expect(visualIntentSearchQuery({ search_query: "documentary broll scene" }, "Our brains want comfort now.")).toBe("");
    expect(visualIntentSearchQuery({ search_query: "archival footage wide shot" }, "Our brains want comfort now.")).toBe("");
    expect(visualIntentSearchQuery(undefined, "Our brains want comfort now.")).toBe("");
  });

  it("no plan: the sentence cut answers exactly as before", () => {
    const sentence = "In 2007, Steve Jobs walked onto the stage and pulled the first iPhone from his pocket.";
    const plan = youtubeQueryPlanForSentence(["Steve Jobs iPhone 2007 keynote archival footage"], sentence, sentence, undefined);
    expect(plan.from).toBe("sentence");
    expect(plan.queries).toEqual(["Steve Jobs iPhone 2007"]);
  });

  it("an initial is part of a name: 'Dwight D. Eisenhower' is not cut to 'Dwight D'", () => {
    expect(namesInSentence("In one bold move, Dwight D. Eisenhower ordered the invasion.")).toContain("Dwight D Eisenhower");
  });

  it("the open sources ask the VisualIntent first, inside the same cap of three", () => {
    const at = PIPELINE.indexOf("async function gatherHistoricalBeatVideoPoolInner(");
    const body = PIPELINE.slice(at, at + 6000);
    expect(body).toContain("const intentLead = visualIntentSearchQuery(storedVisualIntentForBeat(beat.text), beat.text, scene.text);");
    expect(body).toContain("...(intentLead ? [intentLead] : [])");
    expect(body).toContain("const queryCap = 3;");
  });

  /** Eight topics, one rule: no topic word is wired in anywhere. */
  const TOPICS: Array<[string, string, string, string[]]> = [
    ["WWII", "In 1945, three-quarters of the world's nations were at war.", "world map nations at war 1945", ["map", "1945"]],
    ["Tesla", "Thousands of workers assembled cars around the clock to meet demand.", "Tesla factory workers assembly line", ["factory", "assembly"]],
    ["football", "In the 2022 World Cup final in Qatar, Messi lifted the trophy.", "Messi lifting World Cup trophy", ["messi", "trophy"]],
    ["science", "Scientists cut a single gene inside a living cell.", "CRISPR gene editing laboratory", ["crispr", "gene"]],
    ["economics", "Inflation reached 10% as prices soared in every shop.", "rising prices supermarket inflation chart", ["prices", "inflation"]],
    ["technology", "In 2007, Steve Jobs pulled the first iPhone from his pocket.", "Steve Jobs iPhone keynote 2007", ["jobs", "iphone"]],
    ["geography", "The Amazon carries more water than the next seven rivers combined.", "Amazon river aerial rainforest", ["river", "rainforest"]],
    ["abstract", "The shift from war to collaboration changed the world.", "diplomatic meeting international cooperation", ["diplomatic", "cooperation"]],
  ];
  for (const [topic, sentence, search, mustHave] of TOPICS) {
    it(`${topic}: the query names what is on screen and nothing the plan or sentence does not say`, () => {
      const plan = youtubeQueryPlanForSentence([], sentence, sentence, { search_query: search });
      expect(plan.queries.length).toBeGreaterThan(0);
      const q = plan.queries[0]!.toLowerCase();
      for (const w of mustHave) expect(q).toContain(w);
      const allowed = new Set(`${sentence} ${search}`.toLowerCase().split(/[^\p{L}\p{N}]+/u));
      for (const w of q.split(/\s+/)) expect(allowed.has(w)).toBe(true);
    });
  }
});

/* ═══════════════════════ F2 — the beat finds its plan ═══════════════════════ */

describe("F2 — matchBeatVisualIntent sees through small differences", () => {
  const PLAN = {
    visualIntents: [
      planned("This shift from war to collaboration signaled a new global order.", "world leaders signing treaty"),
      planned(
        "In Geneva, Switzerland, leaders like Neville Chamberlain clung to peace through the League of Nations, unfolding in the stark invasion of Poland.",
        "league of nations assembly geneva"
      ),
      planned("By 1950, former allies stood on the brink of nuclear conflict.", "cold war nuclear test"),
    ],
  };
  const lookup = (beat: string) => withRenderVisualPlan(PLAN, () => storedVisualIntentForBeat(beat)?.search_query);

  it("the exact sentence", () => {
    expect(lookup("By 1950, former allies stood on the brink of nuclear conflict.")).toBe("cold war nuclear test");
  });

  it("the voice lost an article (render 628: 'signaled new global order')", () => {
    expect(lookup("shift from war to collaboration signaled new global order.")).toBe("world leaders signing treaty");
  });

  it("a beat that is a piece of a longer plan sentence", () => {
    expect(lookup("In Geneva, Switzerland, leaders like Neville Chamberlain clung to peace through the League of Nations")).toBe(
      "league of nations assembly geneva"
    );
  });

  it("a longer beat holding the plan sentence", () => {
    expect(lookup("By 1950, former allies stood on the brink of nuclear conflict. And then?")).toBe("cold war nuclear test");
  });

  it("a sentence the plan does not hold is not matched", () => {
    expect(lookup("Scientists cut a single gene inside a living cell.")).toBeUndefined();
  });

  it("two equally good plan sentences: no guess, the word rules stand", () => {
    const twin = {
      visualIntents: [
        planned("Prices rose in every city across the country that year.", "rising prices city shops"),
        planned("Prices rose in every town across the country that year.", "rising prices town market"),
      ],
    };
    expect(withRenderVisualPlan(twin, () => storedVisualIntentForBeat("Prices rose in every across the country that year."))).toBeUndefined();
  });
});

/* ═══════════════════════ F3 — a short shot is a small file ═══════════════════════ */

describe("F3 — the size floor reads the measured duration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f3-"));
  const file = (name: string, bytes: number) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };

  it("a 4 s YouTube moment of 108 KB (render 628) passes once its duration is measured", () => {
    const p = file("moment.mp4", 108_761);
    expect(technicalFileRefusal(p)).toBe("below_size_floor_108761_bytes");
    expect(isSizeFloorRefusal(technicalFileRefusal(p))).toBe(true);
    expect(technicalFileRefusal(p, 4.0)).toBeNull();
  });

  it("a long clip in a small file is still refused", () => {
    const p = file("long.mp4", 170_000);
    expect(technicalFileRefusal(p, 30)).toBe("below_size_floor_170000_bytes");
  });

  it("without a measured duration the old floor stands", () => {
    const p = file("unknown.mp4", 150_000);
    expect(technicalFileRefusal(p)).toBe("below_size_floor_150000_bytes");
    expect(technicalFileRefusal(p, 0)).toBe("below_size_floor_150000_bytes");
    expect(technicalFileRefusal(p, Number.NaN)).toBe("below_size_floor_150000_bytes");
  });

  it("a sliver or a near-empty file is refused whatever it claims", () => {
    expect(technicalFileRefusal(file("sliver.mp4", 30_000), 0.5)).toMatch(/^below_size_floor_/);
    expect(technicalFileRefusal(file("empty.mp4", 10_000), 0.9)).toMatch(/^below_size_floor_/);
  });

  it("a file at or above the floor is untouched, and a missing one is still missing", () => {
    expect(technicalFileRefusal(file("big.mp4", ADOPT_MIN_FILE_BYTES))).toBeNull();
    expect(technicalFileRefusal(path.join(dir, "nope.mp4"), 4)).toBe("file_missing");
  });

  it("a corrupt file is still refused by the decode check after the size check", async () => {
    const probes = { isValidVideo: async () => false, isPipelineFallback: () => false, isMostlyBlack: async () => false };
    expect(await technicalMediaRefusal(file("corrupt.mp4", 120_000), probes)).toBe("not_a_valid_video");
    const at = PIPELINE.indexOf("let fileRefusal = technicalFileRefusal(p);");
    const loop = PIPELINE.slice(at, at + 1600);
    expect(loop).toContain("fileRefusal = technicalFileRefusal(p, await probeVideoDurationSec(p))");
    expect(loop.indexOf("technicalMediaRefusal(p, MEDIA_PROBES)")).toBeGreaterThan(loop.indexOf("fileRefusal = technicalFileRefusal(p, await"));
  });
});

/* ═══════════════════════ F4 — whole words in the archive router ═══════════════════════ */

describe("F4 — the archive router matches whole words, never fragments or stop words", () => {
  const ELON = { name: "Elon Musk", description: "Elon Musk, Tesla and SpaceX interviews", nicheTags: ["elon musk", "tesla", "spacex"] };
  const ARCTIC = { name: "Arctic & Polar Exploration", description: "Expeditions to the poles", nicheTags: ["explorers", "polar", "antarctica"] };
  const COLD_WAR = { name: "Cold War Espionage", description: "Spies and the iron curtain", nicheTags: ["cold war", "spies", "kgb"] };
  const YOUTUBE = { name: "YouTube", description: "Footage downloaded from YouTube, showing many subjects", nicheTags: [] as string[] };
  const SOFTWARE = { name: "Software History", description: "Computers and programmers", nicheTags: ["software"] };

  it("a fragment no longer matches: 'war' is not in 'software', 'explore' is not 'explorers'", () => {
    expect(scoreArchiveMetadata(SOFTWARE, ["war"], [])).toBe(0);
    expect(scoreArchiveMetadata(ARCTIC, ["explore", "these", "institutions", "evolved"], [])).toBe(0);
  });

  it("stop and shot words route nowhere (render 628: 'archive, footage, showing' → YouTube)", () => {
    expect(scoreArchiveMetadata(YOUTUBE, ["archive", "footage", "showing", "1950"], [])).toBe(0);
    expect(scoreArchiveMetadata(ELON, ["this", "just", "from", "broll", "scene", "wide", "medium"], [])).toBe(0);
  });

  it("a WWII sentence no longer reaches the Elon Musk archive", () => {
    expect(scoreArchiveMetadata(ELON, ["roosevelt", "winston", "churchill", "watched", "delegates"], [])).toBe(0);
  });

  it("whole words still match, so routing still selects", () => {
    expect(scoreArchiveMetadata(ELON, ["tesla", "factory"], [])).toBeGreaterThanOrEqual(8);
    expect(scoreArchiveMetadata(COLD_WAR, ["kgb", "spies"], [])).toBeGreaterThanOrEqual(8);
    expect(scoreArchiveMetadata(ARCTIC, ["antarctica"], [])).toBeGreaterThanOrEqual(8);
    expect(scoreArchiveMetadata({ name: "Cold War Berlin", description: "Checkpoint and wall footage", nicheTags: [] }, ["checkpoint"], ["berlin"])).toBeGreaterThanOrEqual(8);
  });

  it("a beat with no tags at all still scores 1 — no information is never a refusal", () => {
    expect(scoreArchiveMetadata(ELON, [], [])).toBe(1);
  });
});

/* ═══════════════════════ F5 — the best approved, not the first in a tie ═══════════════════════ */

describe("F5 — tied candidates are ordered by what the sentence is about", () => {
  const order = (cands: Array<{ id: string; score: number; subjectWords: number; still: boolean }>) =>
    [...cands].sort(compareScoredCandidates).map((c) => c.id);

  it("FIT A and FIT B at the same score: the one whose title says the sentence's subject is judged first", () => {
    expect(
      order([
        { id: "A_hitler_promises", score: 5, subjectWords: 0, still: false },
        { id: "B_un_charter_signing", score: 5, subjectWords: 3, still: false },
      ])
    ).toEqual(["B_un_charter_signing", "A_hitler_promises"]);
  });

  it("a clear score difference still wins over a word in a title", () => {
    expect(
      order([
        { id: "strong", score: 30, subjectWords: 0, still: false },
        { id: "wordy", score: 5, subjectWords: 4, still: false },
      ])
    ).toEqual(["strong", "wordy"]);
  });

  it("an exact tie in everything keeps the old motion preference", () => {
    expect(
      order([
        { id: "still", score: 5, subjectWords: 1, still: true },
        { id: "video", score: 5, subjectWords: 1, still: false },
      ])
    ).toEqual(["video", "still"]);
  });

  it("subject words are whole words of the candidate's own text", () => {
    const wanted = subjectWords("Delegates in San Francisco sign the United Nations Charter.");
    expect(subjectWordOverlap("United Nations Charter signed in San Francisco, 1945", wanted)).toBeGreaterThanOrEqual(4);
    expect(subjectWordOverlap("Hitler's Early Promises - A German Perspective on War!", wanted)).toBe(0);
    expect(subjectWordOverlap("Franciscan unitedness", wanted)).toBe(0);
  });

  it("the Judge stays the authority: only a FIT is adopted, a refusal is never rescued by its title", () => {
    const at = PIPELINE.indexOf("async function adoptClip(");
    const body = PIPELINE.slice(at, at + 90_000);
    /** The ordering is the only place the subject words are read. */
    expect(body.match(/subjectMatchOf\(/g)?.length).toBe(4);
    expect(body).toContain('if (beatEvidence !== "FIT" && firstLookAtCandidate) {');
    expect(body).toContain('registerRejection(dedup.rejections, sceneIndex, beatIndex, p, "hard_mismatch", sourceQuery);');
  });
});

/* ═══════════════════════ F6 — refused once is refused for the render ═══════════════════════ */

describe("F6 — an asset refused for what the file is, is not offered again", () => {
  it("file refusals hold for every sentence; picture refusals do not", () => {
    for (const r of ["baked_edit_text_before_vision", "below_size_floor_108761_bytes", "mostly_black", "not_a_valid_video", "pipeline_fallback"]) {
      expect(refusalHoldsForEverySentence(r)).toBe(true);
    }
    for (const r of ["beat_image_gate", "hard_mismatch", "already_used_in_render", "shortlist_full", "file_missing"]) {
      expect(refusalHoldsForEverySentence(r)).toBe(false);
    }
  });

  it("render 628: the Internet Archive clip refused for its text is not offered to the next sentence", () => {
    const key = (p: string) => p.replace(/^scene_\d+_b\d+_/, "");
    const refused = new Map([["primary_hist_archive_0__pid_internet_archive-0843df636a32847c.mp4", "baked_edit_text_before_vision"]]);
    const offered = pathsNotRefusedEarlier(
      [
        "scene_1_b3_primary_hist_archive_0__pid_internet_archive-0843df636a32847c.mp4",
        "scene_1_b3_primary_inet_img_serp_serp_0__pid_serpapi-c73821ab124a5a16.mp4",
      ],
      refused,
      key
    );
    expect(offered).toEqual(["scene_1_b3_primary_inet_img_serp_serp_0__pid_serpapi-c73821ab124a5a16.mp4"]);
    expect(pathsNotRefusedEarlier(["a.mp4"], undefined, key)).toEqual(["a.mp4"]);
  });

  it("adoptClip writes the memory where it refuses, and reads it before it ranks", () => {
    const at = PIPELINE.indexOf("async function adoptClip(");
    const body = PIPELINE.slice(at, at + 90_000);
    expect(body).toContain("if (refusalHoldsForEverySentence(reason)) {");
    expect(body.indexOf("pathsNotRefusedEarlier(paths, refusedEarlier, clipContentKey)")).toBeLessThan(body.indexOf("const sortedPaths = [...offered].sort("));
  });
});

/* ═══════════════════════ F9 — MediaForm is read ═══════════════════════ */

describe("F9 — MediaForm is a preference the ranking reads", () => {
  it("a sentence that states a quantity prefers data, and footage stays acceptable", () => {
    const need = mediaFormsForIntent({ event: ["inflation"] }, true);
    expect(need.preferred[0]).toBe("DATA_VISUALIZATION");
    expect(need.acceptable).toEqual(expect.arrayContaining(["REAL_FOOTAGE", "PHOTO", "B_ROLL"]));
    expect(STILL_FRIENDLY_FORMS.has(need.preferred[0]!)).toBe(true);
  });

  it("for such a sentence a still is not demoted against comparable footage", () => {
    /** `still: false` is what adoptClip passes for a still when the MediaForm prefers one. */
    const order = [
      { id: "chart_still", score: 5, subjectWords: 0, still: false },
      { id: "street_video", score: 6, subjectWords: 0, still: false },
    ].sort(compareScoredCandidates);
    expect(order.map((c) => c.id)).toEqual(["street_video", "chart_still"]);
    const body = PIPELINE.slice(PIPELINE.indexOf("async function adoptClip("));
    expect(body).toContain('const stillsPreferred = STILL_FRIENDLY_FORMS.has(_intent.mediaForm?.preferred[0] ?? "");');
  });

  it("a sentence with no quantity keeps the footage forms first", () => {
    expect(mediaFormsForIntent({ people: ["Messi"] }, false).preferred[0]).toBe("PERSON");
  });
});

/* ═══════════════════════ F10 — abstract sentences still ask ═══════════════════════ */

describe("F10 — an abstract sentence searches what its plan says to show", () => {
  it("'The shift from war to collaboration' asks for a diplomatic meeting, not nothing", () => {
    const sentence = "The shift from war to collaboration signaled a new global order.";
    const plan = withRenderVisualPlan(
      { visualIntents: [planned(sentence, "diplomatic meeting world leaders cooperation")] },
      () => youtubeQueryPlanForSentence([], sentence, sentence)
    );
    expect(plan.queries[0]).toBe("diplomatic meeting world leaders cooperation");
  });

  it("without a plan the existing fallback is untouched", () => {
    const sentence = "The shift from war to collaboration signaled a new global order.";
    expect(youtubeQueryPlanForSentence([], sentence, sentence).queries).toEqual([]);
  });
});
