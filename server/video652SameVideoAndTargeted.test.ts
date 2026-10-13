/**
 * VIDEO 652 — s1b4 ("Was this meteoric rise Elon Musk's ultimate triumph…") ended on a colour field
 * while the film's pool held 23 usable Musk/Tesla videos and nine of their moments were ready for it.
 *
 *   1. The targeted search #3 ("Lotus chassis", made for s0b0) stocked "video of lotus 30 mk 1
 *      chassis 12"; ready stock that serves nothing still came before every download, so it was the
 *      first row of s1b4 (and of s0b2).
 *   2. Four moments of that one video were judged for s1b4 in a row: four of its five looks.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { beatRowsInStockOrder } from "./youtubeShotStock";
import {
  noteSameVideoRefusal,
  SAME_VIDEO_REFUSALS_PER_SENTENCE,
  sameVideoRefusedEnough,
  youtubeSourceOfKey,
  type SameVideoRefusals,
} from "./sameVideoRefusals";
import { refusalHoldsForEverySentence } from "./videoPipeline";

type Row = { id: string; ready?: boolean; serves?: boolean; shown?: boolean; targeted?: boolean };
const order = (rows: Row[], withTargeted = true) =>
  beatRowsInStockOrder(rows, {
    ready: (r) => Boolean(r.ready),
    serves: (r) => Boolean(r.serves),
    shownRecently: (r) => Boolean(r.shown),
    ...(withTargeted ? { targeted: (r: Row) => Boolean(r.targeted) } : {}),
  });

describe("VIDEO 652 — a targeted search's video goes to the sentences it was searched for", () => {
  /** s1b4's rows: the Lotus answer was ready; the Musk/Tesla videos that could serve it were not cut yet. */
  const s1b4Rows: Row[] = [
    { id: "hTz7PN5qS20", ready: true, targeted: true }, // "video of lotus 30 mk 1 chassis 12" — searched for s0b0
    { id: "musk-interview", ready: false },
    { id: "tesla-factory", ready: true },
  ];

  it("job 652 s1b4: the Lotus video is not offered; the other rows keep their order", () => {
    const o = order(s1b4Rows);
    const offered = [...o.first, ...o.rest].map((r) => r.id);
    expect(offered).not.toContain("hTz7PN5qS20");
    expect(o.dropped.map((r) => r.id)).toEqual(["hTz7PN5qS20"]);
    expect(offered).toEqual(["tesla-factory", "musk-interview"]);
  });

  it("before the fix the Lotus video was the first row offered (reproduces 652)", () => {
    const o = order(s1b4Rows, false);
    expect([...o.first, ...o.rest][0]!.id).toBe("hTz7PN5qS20");
    expect(o.dropped).toEqual([]);
  });

  it("the sentence it was searched for still gets it first", () => {
    const s0b0 = order([{ id: "other", ready: true, serves: true }, { id: "hTz7PN5qS20", ready: true, serves: true, targeted: true }]);
    expect(s0b0.first.map((r) => r.id)).toEqual(["other", "hTz7PN5qS20"]);
    expect(s0b0.dropped).toEqual([]);
  });

  it("a targeted video the look judged to serve this sentence too is offered here", () => {
    const o = order([{ id: "barra", ready: true, serves: true, targeted: true }]);
    expect(o.first.map((r) => r.id)).toEqual(["barra"]);
  });

  it("a targeted row still downloading is not offered to another sentence either", () => {
    const o = order([{ id: "lotus-dl", ready: false, targeted: true }, { id: "x", ready: false }]);
    expect(o.rest.map((r) => r.id)).toEqual(["x"]);
    expect(o.dropped.map((r) => r.id)).toEqual(["lotus-dl"]);
  });

  it("untargeted ready stock that does not serve the sentence keeps its old place", () => {
    const o = order([
      { id: "serving-dl", serves: true },
      { id: "other-ready", ready: true },
      { id: "other-dl" },
    ]);
    expect(o.rest.map((r) => r.id)).toEqual(["serving-dl", "other-ready", "other-dl"]);
  });

  it("the pipeline passes the stock's own targeted marker and logs what it held back", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const call = PIPE.slice(PIPE.indexOf("const order = beatRowsInStockOrder("), PIPE.indexOf("servingReadyRows = new Set(order.first);"));
    expect(call).toContain("targeted: (r) => poolVideoId != null && idOf(r) != null && stockVideoTargeted(poolVideoId, idOf(r)!)");
    expect(call).toContain("targeted video(s) searched for other sentences");
  });
});

describe("VIDEO 652 — one YouTube video does not spend a sentence's looks on itself", () => {
  const lotus = (t: number) => `youtube_cc:cb91b3c6d04157c4@t${t}d40`;

  it("a moment's content key names its video; other providers have none", () => {
    expect(youtubeSourceOfKey(lotus(7118))).toBe("youtube_cc:cb91b3c6d04157c4");
    expect(youtubeSourceOfKey("youtube_cc:abc")).toBe("youtube_cc:abc");
    expect(youtubeSourceOfKey("curated:asset:60531")).toBeNull();
    expect(youtubeSourceOfKey(null)).toBeNull();
  });

  it("job 652 s1b4: after two refused Lotus moments the third and fourth are not judged", () => {
    const refusals: SameVideoRefusals = new Map();
    const judged: number[] = [];
    for (const t of [7118, 7176, 7271, 7325]) {
      if (sameVideoRefusedEnough(refusals, lotus(t))) continue;
      judged.push(t);
      noteSameVideoRefusal(refusals, lotus(t)); // the picture editor refused every Lotus moment
    }
    expect(SAME_VIDEO_REFUSALS_PER_SENTENCE).toBe(2);
    expect(judged).toEqual([7118, 7176]);
  });

  it("one refused moment does not shut the video out (one moment can fail for text on screen)", () => {
    const refusals: SameVideoRefusals = new Map();
    noteSameVideoRefusal(refusals, lotus(7118));
    expect(sameVideoRefusedEnough(refusals, lotus(7176))).toBe(false);
  });

  it("another video is not affected; nor is a non-YouTube candidate", () => {
    const refusals: SameVideoRefusals = new Map();
    noteSameVideoRefusal(refusals, lotus(7118));
    noteSameVideoRefusal(refusals, lotus(7176));
    expect(sameVideoRefusedEnough(refusals, "youtube_cc:musk1234@t100d40")).toBe(false);
    noteSameVideoRefusal(refusals, "curated:asset:60531");
    noteSameVideoRefusal(refusals, "curated:asset:60531");
    expect(sameVideoRefusedEnough(refusals, "curated:asset:60531")).toBe(false);
  });

  it("the reason is the sentence's own: the moment is not refused for other sentences", () => {
    expect(refusalHoldsForEverySentence("same_video_refused_on_sentence")).toBe(false);
  });

  it("the adoption loop checks before any probe or look, and counts only the picture editor's refusals", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const check = PIPE.indexOf('refuse("same_video_refused_on_sentence")');
    const probe = PIPE.indexOf("let fileRefusal = technicalFileRefusal(p);");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(probe);
    expect(PIPE).toContain("if (!requeuedAfterRefusal.has(p) && sameVideoRefusedEnough(sameVideoRefusals, clipContentKey(p))) {");
    const refusedBranch = PIPE.slice(PIPE.indexOf('logAdoptTiming("judge:refused");'), PIPE.indexOf('registerRejection(dedup.rejections, sceneIndex, beatIndex, p, "beat_image_gate", sourceQuery);'));
    expect(refusedBranch).toContain("noteSameVideoRefusal(sameVideoRefusals, contentKey);");
  });
});
