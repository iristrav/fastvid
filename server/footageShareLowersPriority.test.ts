/**
 * OCTOBER 2026 — a footage that already fills much of the film goes behind fresher candidates.
 * Renders 612 and 616 were refused at the end (ONE_FOOTAGE_FILLS_FILM) with nothing earlier
 * preferring anything else. See usageDiversity.preferLessFilledFootage.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  FILM_SHARE_FLOOR_SEC,
  footageKeyOf,
  footageShareSoFar,
  noteFootageOnScreen,
  preferLessFilledFootage,
} from "./usageDiversity";
import { MAX_DELIVERABLE_FOOTAGE_SHARE } from "./deliveryGate";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Test paths whose content key is the path itself. */
const key = (p: string) => p;

describe("which footage a clip belongs to", () => {
  it("every fragment of one YouTube video is that video", () => {
    expect(footageKeyOf("youtube_cc:0123456789abcdef@t1000d40")).toBe("youtube_cc:0123456789abcdef");
    expect(footageKeyOf("youtube_cc:0123456789abcdef@t2500d50")).toBe("youtube_cc:0123456789abcdef");
  });
  it("anything else is itself", () => {
    expect(footageKeyOf("archive:77")).toBe("archive:77");
    expect(footageKeyOf("")).toBeNull();
    expect(footageKeyOf(null)).toBeNull();
  });
});

describe("the film's share, as clips are pushed", () => {
  it("counted per footage, against at least the floor", () => {
    const film = {};
    noteFootageOnScreen(film, "youtube_cc:aaaaaaaaaaaaaaaa@t100d40", 4);
    expect(footageShareSoFar(film, "youtube_cc:aaaaaaaaaaaaaaaa@t900d40")).toBeCloseTo(4 / FILM_SHARE_FLOOR_SEC);
    noteFootageOnScreen(film, "youtube_cc:aaaaaaaaaaaaaaaa@t200d40", 4);
    noteFootageOnScreen(film, "archive:1", 4);
    noteFootageOnScreen(film, "archive:2", 12);
    expect(footageShareSoFar(film, "youtube_cc:aaaaaaaaaaaaaaaa@t300d40")).toBeCloseTo(8 / 24);
    expect(footageShareSoFar(film, "archive:3")).toBe(0);
  });

  it("one render's counts never reach another's", () => {
    const a = {};
    const b = {};
    noteFootageOnScreen(a, "archive:1", 30);
    expect(footageShareSoFar(b, "archive:1")).toBe(0);
  });
});

describe("the beat's ranking", () => {
  it("a footage that fills much of the film goes behind fresher ones; order otherwise kept", () => {
    const film = {};
    noteFootageOnScreen(film, "youtube_cc:aaaaaaaaaaaaaaaa@t100d40", 12);
    noteFootageOnScreen(film, "archive:9", 12);
    noteFootageOnScreen(film, "archive:8", 4);
    const ranked = [
      "youtube_cc:aaaaaaaaaaaaaaaa@t500d40", // its video already holds 12/28 = 43%
      "archive:9", // 43%
      "archive:8", // 14% — below the first tier
      "archive:50", // fresh
    ];
    const out = preferLessFilledFootage(ranked, key, film);
    expect(out.paths).toEqual(["archive:8", "archive:50", "youtube_cc:aaaaaaaaaaaaaaaa@t500d40", "archive:9"]);
    expect(out.moved.map((m) => m.path)).toEqual(["youtube_cc:aaaaaaaaaaaaaaaa@t500d40", "archive:9"]);
  });

  it("nothing is refused — a well-used footage is still in the list", () => {
    const film = {};
    noteFootageOnScreen(film, "archive:9", 100);
    const out = preferLessFilledFootage(["archive:9"], key, film);
    expect(out.paths).toEqual(["archive:9"]);
  });

  it("before anything is on screen the ranking is untouched", () => {
    const ranked = ["a", "b", "c"];
    expect(preferLessFilledFootage(ranked, key, {}).paths).toEqual(ranked);
  });

  it("the share is still measured at the end — reported as a quality note, never a block", () => {
    expect(MAX_DELIVERABLE_FOOTAGE_SHARE).toBe(0.5);
    expect(PIPE).toContain("QUALITY_NOTE ONE_FOOTAGE_FILLS_FILM — ${footageNote}");
    expect(PIPE).not.toContain("cinematicRefusal = `ONE_FOOTAGE_FILLS_FILM");
  });
});

describe("wired at the two places that know", () => {
  it("counted at the one push point, with the seconds the clip actually runs", () => {
    const at = PIPE.indexOf("const pushSceneClip = async (");
    const body = PIPE.slice(at, at + 3000);
    expect(body).toContain("markAssetUsedInVideo(dedup, identity);");
    expect(body).toContain("noteFootageOnScreen(dedup, key, actualHold);");
  });

  it("applied to the ranked list the picture editor walks, before it walks it", () => {
    const reorder = PIPE.indexOf("preferLessFilledFootage(tasteResult.rankedPaths, (p) => clipContentKey(p), dedup)");
    const walk = PIPE.indexOf("const finalPaths = [...lessFilled.paths];");
    expect(reorder).toBeGreaterThan(0);
    expect(walk).toBeGreaterThan(reorder);
  });
});
