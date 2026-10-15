/**
 * VIDEO 659 (cost) — "Hoe kunnen we verder nog meer kosten besparen?" → three things, built:
 *
 *   1. one cost line per video (`[RenderCost]`), so the next decision is a measurement;
 *   2. the pool's thumbnails judged twenty to a sheet, one call, instead of one call each;
 *   3. no second, separate text look for a shot the sharp look already approved for its sentence.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatRenderCost, noteRenderCost, renderCost, takeRenderCostLine } from "./renderCostLedger";
import { runWithActiveVideoId } from "./videoGenerationCancel";
import { recordLlmUsage } from "./_core/llmBudget";
import { memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import { buildVideoYoutubePool, type PoolDeps, type SearchItem, type Triage } from "./youtubeVideoPool";
import {
  parseTriageBatchAnswer,
  TRIAGE_BATCH,
  triageYoutubeThumbnails,
  youtubeTriageBatchEnabled,
  youtubeTriageBatchPrompt,
  youtubeTriagePrompt,
} from "./youtubeVideoPoolProduction";
import { clearSheetApprovals, rememberSheetApprovals } from "./youtubePreviewSheet";
import { sheetApprovedTextClean, textCheckForClip } from "./videoPipeline";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const PIPE = read("videoPipeline.ts");

/* ═══════════ 1 — the cost line ═══════════ */

describe("1 — what one video cost, on one line", () => {
  afterEach(() => {
    takeRenderCostLine(65901);
  });

  it("adds what each paid call reports to the video it ran for, and prints it once", () => {
    noteRenderCost({ llmCalls: 1, visionCalls: 1, promptTokens: 1200, completionTokens: 80, llmUsd: 0.004 }, 65901);
    noteRenderCost({ youtubeDownloads: 2, youtubeBytes: 3 * 1_048_576 }, 65901);
    noteRenderCost({ serpapiSearches: 1, tunelioPaidCalls: 1, aiStills: 1, aiVideos: 1, aiVideoSec: 5, voiceChars: 900 }, 65901);
    const line = formatRenderCost(65901);
    expect(line).toBe(
      "[RenderCost] video=65901 llm=1 (vision=1) tokens=1200+80 llmUsd=0.004 youtubeDownloads=2 youtubeMB=3.0 " +
        "tunelioPaid=1 serpapi=1 aiVideos=1 (5s) aiStills=1 voiceChars=900"
    );
    expect(takeRenderCostLine(65901)).toBe(line);
    /** Taken once: the next video starts from nothing. */
    expect(renderCost(65901).llmCalls).toBe(0);
  });

  it("a call made inside a render is counted for THAT render; outside a render it is not counted here", () => {
    runWithActiveVideoId(65901, () => recordLlmUsage("gpt-4o-mini", 1000, 100, null, true));
    expect(renderCost(65901)).toMatchObject({ llmCalls: 1, visionCalls: 1, promptTokens: 1000, completionTokens: 100 });
    expect(renderCost(65901).llmUsd).toBeGreaterThan(0);
    recordLlmUsage("gpt-4o-mini", 1000, 100, null, false);
    expect(renderCost(65901).llmCalls).toBe(1);
  });

  it("every paid route reports to the ledger", () => {
    expect(read("_core/llmBudget.ts")).toContain("noteRenderCost({ llmCalls: 1, visionCalls: hasVision ? 1 : 0, promptTokens, completionTokens, llmUsd: costUsd });");
    expect(read("_core/llm.ts").match(/getActiveUserId\(\) \?\? null, hasVision\);/g)).toHaveLength(2);
    expect(PIPE).toContain("if (response.ok) noteRenderCost({ voiceChars: text.length });");
    expect(read("voiceTtsAlignment.ts")).toContain("if (response.ok) noteRenderCost({ voiceChars: text.length });");
    expect(PIPE.match(/noteRenderCost\(\{ serpapiSearches: 1 \}\);/g)).toHaveLength(2);
    expect(PIPE).toContain("if (dlResp.ok) noteRenderCost({ youtubeDownloads: 1, youtubeBytes: bytesWritten ?? 0 });");
    expect(read("tunelioDownloader.ts")).toContain("noteRenderCost({ tunelioPaidCalls: 1 });");
    expect(read("generatedImageFallback.ts")).toContain("if (resp.ok) noteRenderCost({ aiStills: 1 });");
    expect(read("elevenLabsVideoGeneration.ts")).toContain("if (created.ok) noteRenderCost({ aiVideos: 1, aiVideoSec: opts.durationSec });");
  });

  it("the line is printed in the render's finally, whatever the ending", () => {
    const at = PIPE.indexOf("console.log(takeRenderCostLine(videoId));");
    expect(at).toBeGreaterThan(0);
    expect(PIPE.lastIndexOf("} finally {", at)).toBeGreaterThan(PIPE.lastIndexOf("export async function runVideoPipeline(", at));
  });
});

/* ═══════════ 2 — twenty thumbnails, one look ═══════════ */

const SENTENCES = ["Tesla robots assembled the Model S in Fremont.", "Elon Musk slept on the factory floor."];
const items = (n: number): SearchItem[] =>
  Array.from({ length: n }, (_, i) => ({ videoId: `vid${String(i).padStart(8, "0")}`, title: `Result ${i}`, description: "", channel: "c", thumb: `https://i.ytimg.com/vi/${i}/hq.jpg` }));

describe("2 — the pool's thumbnails are judged on one sheet", () => {
  it("the sheet prompt carries the same rules as the single look, every result numbered once", () => {
    const single = youtubeTriagePrompt({ title: "x", channel: "c", description: "" }, "Tesla", SENTENCES);
    const batch = youtubeTriageBatchPrompt(items(3), "Tesla", SENTENCES);
    expect(batch).toContain(single.slice(single.indexOf("footageType:\n")));
    expect(batch).toContain('[1] "Result 0" (channel: c)');
    expect(batch).toContain('[3] "Result 2" (channel: c)');
    expect(batch).toMatch(/A thumbnail with the right face proves nothing/);
  });

  it("the answer is held to the sheet: unknown numbers, duplicates and unknown types are dropped", () => {
    const raw = JSON.stringify({
      results: [
        { n: 1, footageType: "real_footage", servesBeats: [0, 1], depicts: "robots" },
        { n: 1, footageType: "talking_head", servesBeats: [], depicts: "dup" },
        { n: 2, footageType: "cartoon", servesBeats: [], depicts: "?" },
        { n: 9, footageType: "real_footage", servesBeats: [0], depicts: "off the sheet" },
      ],
    });
    const m = parseTriageBatchAnswer(raw, 3, false);
    expect([...m.keys()]).toEqual([1]);
    expect(m.get(1)).toEqual({ footageType: "real_footage", servesBeats: [0, 1], depicts: "robots" });
    expect(parseTriageBatchAnswer("nope", 3, false).size).toBe(0);
  });

  it("twenty-five thumbnails → two sheets, two calls (not twenty-five); answers land on the right videos", async () => {
    let calls = 0;
    const llm = async (p: unknown) => {
      calls++;
      const text = ((p as { messages: Array<{ content: unknown }> }).messages[1]!.content as Array<{ type: string; text?: string }>)[0]!.text!;
      const count = Number(/sheet of (\d+) YouTube/.exec(text)![1]);
      return { choices: [{ message: { content: JSON.stringify({ results: Array.from({ length: count }, (_, i) => ({ n: i + 1, footageType: i % 2 ? "talking_head" : "real_footage", servesBeats: [0], depicts: `#${i + 1}` })) }) } }] };
    };
    const out = await triageYoutubeThumbnails(items(25), "Tesla", SENTENCES, llm, [], {
      fetchThumb: async () => Buffer.from("jpg"),
      compose: async (_files, outPath) => {
        fs.writeFileSync(outPath, "sheet");
        return true;
      },
    });
    expect(calls).toBe(2);
    expect(out.size).toBe(25);
    expect(out.get("vid00000000")).toMatchObject({ footageType: "real_footage", depicts: "#1" });
    expect(out.get("vid00000001")).toMatchObject({ footageType: "talking_head", depicts: "#2" });
    /** The second sheet starts at its own number 1. */
    expect(out.get(`vid000000${TRIAGE_BATCH}`)).toMatchObject({ depicts: "#1" });
  });

  it("a thumbnail that would not download is left off the sheet, and the numbering follows the ones that came", async () => {
    const llm = async () => ({ choices: [{ message: { content: JSON.stringify({ results: [{ n: 1, footageType: "real_footage", servesBeats: [], depicts: "first kept" }, { n: 2, footageType: "real_footage", servesBeats: [], depicts: "second kept" }] }) } }] });
    const out = await triageYoutubeThumbnails(items(3), "Tesla", SENTENCES, llm, [], {
      fetchThumb: async (url) => (url.includes("/0/") ? null : Buffer.from("jpg")),
      compose: async (_f, o) => (fs.writeFileSync(o, "s"), true),
    });
    expect(out.has("vid00000000")).toBe(false);
    expect(out.get("vid00000001")!.depicts).toBe("first kept");
    expect(out.get("vid00000002")!.depicts).toBe("second kept");
  });

  it("in the pool: one sheet first, and only what it did not answer is asked alone", async () => {
    const singles: string[] = [];
    const deps: PoolDeps = {
      store: memoryYoutubeSearchBudgetStore(),
      llm: async () => ({ choices: [{ message: { content: JSON.stringify({ mainSubject: "Tesla", recurringSubjects: [], query: "Tesla Elon Musk factory footage" }) } }] }),
      gate: () => ({ ok: true }),
      search: async () => ({ status: 200, items: items(6) }),
      details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 300, embeddable: true, live: false }])),
      triage: async (it): Promise<Triage> => {
        singles.push(it.videoId);
        return { footageType: "real_footage", servesBeats: [0], depicts: "" };
      },
      /** The sheet answers for all but the last result. */
      triageMany: async (its) => new Map(its.slice(0, -1).map((it) => [it.videoId, { footageType: "real_footage", servesBeats: [0, 1], depicts: "sheet" } as Triage])),
      archive: async () => [],
      log: () => undefined,
    };
    const pool = await buildVideoYoutubePool(deps, {
      videoId: 65902,
      prompt: "How Tesla built the Model S",
      title: "Tesla",
      sceneTexts: ["Tesla robots assembled the Model S in Fremont. Elon Musk slept on the factory floor at Tesla."],
    });
    expect(singles).toEqual(["vid00000005"]);
    expect(pool.candidates.filter((c) => c.usable)).toHaveLength(6);
  });

  it("on by default, and it can be switched off", () => {
    expect(youtubeTriageBatchEnabled({})).toBe(true);
    expect(youtubeTriageBatchEnabled({ YOUTUBE_TRIAGE_BATCH: "false" })).toBe(false);
    expect(read("youtubeVideoPoolProduction.ts")).toContain("...(youtubeTriageBatchEnabled() ? { triageMany } : {}),");
  });
});

/* ═══════════ 3 — no second text look for a shot the sharp look approved ═══════════ */

describe("3 — the sharp look's approval carries the text check", () => {
  const FILM = 65903;
  const ASSET = "youtube_cc:0123456789abcdef";
  afterEach(() => clearSheetApprovals(FILM));

  it("an approved moment under its own sentence is recorded clean; anything else is not", () => {
    rememberSheetApprovals(FILM, ASSET, [{ sec: 99, sentence: SENTENCES[0]!, depicts: "robots" }]);
    const dedup = {};
    expect(sheetApprovedTextClean(dedup, `${ASSET}@t970d40`, SENTENCES[0]!, FILM)).toBe(true);
    expect(textCheckForClip(dedup, `${ASSET}@t970d40`)).toBe("clean");
    const other = {};
    expect(sheetApprovedTextClean(other, `${ASSET}@t970d40`, SENTENCES[1]!, FILM)).toBe(false);
    expect(sheetApprovedTextClean(other, `${ASSET}@t3000d40`, SENTENCES[0]!, FILM)).toBe(false);
    expect(sheetApprovedTextClean(other, "pexels:123", SENTENCES[0]!, FILM)).toBe(false);
    expect(textCheckForClip(other, `${ASSET}@t970d40`)).toBeNull();
  });

  it("both text looks ask it first: the adopt route and the mandatory check", () => {
    expect(PIPE).toContain("if (clipRequiresFairUseTransform(p) && sheetApprovedTextClean(dedup, contentKey, beatText)) {");
    expect(PIPE).toContain('if (sheetApprovedTextClean(dedup, contentKey, beat.text)) return "clean";');
    const mandatory = PIPE.indexOf('if (sheetApprovedTextClean(dedup, contentKey, beat.text)) return "clean";');
    const ask = PIPE.indexOf("checkText: async () => {", mandatory);
    expect(ask).toBeGreaterThan(mandatory);
  });

  it("the sharp look refuses text, so its approval can stand for it", () => {
    expect(read("youtubePreviewSheet.ts")).toContain(
      "Also never: burned-in subtitles, a channel watermark, caption text across the picture or a news ticker / headline bar."
    );
  });
});

void os;
