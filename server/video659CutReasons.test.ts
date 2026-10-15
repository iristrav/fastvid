/**
 * VIDEO 659 — FIX E: WHY A SECTION GAVE NO USABLE SHOT, AND A WIDER REACH AROUND THE APPROVED FRAME.
 *
 * Production: YseCVuE80Ss was approved on the sheet, its section downloaded, and the stock said only
 * "no single shot long enough to use" — not how long the section was, where it was cut, whether it
 * could be decoded, or whether the shots were found and then lost at extraction. Each of those now
 * has its own log line. And the section reaches four seconds before and eight after the approved
 * frame (was three and seven), inside the video. The approved second and its sentence stay exactly
 * as they were: only a shot that holds that second counts as approved for that sentence; every other
 * shot of the wider section is judged and text-checked as before. The content rules are unchanged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ARCHIVE_PIECE_MIN_SEC, cutLocalVideoIntoShots, explainEmptyCut, type LocalShotCutter } from "./archiveShotPieces";
import {
  clearSheetApprovals,
  MAX_SECTION_TOTAL_SEC,
  MAX_SECTIONS,
  rememberSheetApprovals,
  SECTION_AFTER_SEC,
  SECTION_BEFORE_SEC,
  sheetApprovalFor,
  windowsAroundApprovals,
} from "./youtubePreviewSheet";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const workDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "v659cut-"));
  dirs.push(d);
  return d;
};
const cutter = (durationSec: number, cutsSec: number[], opts: { incomplete?: string; extractWorks?: boolean } = {}): LocalShotCutter => ({
  detect: async () => ({ durationSec, cutsSec, ...(opts.incomplete ? { incomplete: opts.incomplete } : {}) }),
  extract: async (_in, out) => {
    if (opts.extractWorks !== false) fs.writeFileSync(out, "x");
  },
});

describe("VIDEO 659 fix E — the exact reason an empty cut gives", () => {
  it("shot selection: the section's length, every cut point, and its longest shot against the minimum", async () => {
    /** 659's shape: a 10 s section cut every ~2 s — no shot reaches three seconds. */
    const cut = await cutLocalVideoIntoShots("/w/ytstock_YseCVuE80Ss_96.mp4", workDir(), cutter(10, [2.1, 4.0, 6.2, 8.1]));
    expect(cut.kind).toBe("no_clean_shot");
    const why = explainEmptyCut(cut)!;
    expect(why).toContain("section 10.00s with 4 cut(s) at 2.10s, 4.00s, 6.20s, 8.10s");
    expect(why).toContain("longest shot is 2.20s");
    expect(why).toContain(`under the ${ARCHIVE_PIECE_MIN_SEC}s minimum`);
    expect(why).toContain("shot selection");
  });

  it("decoding: the scan did not finish, with its own reason", async () => {
    const cut = await cutLocalVideoIntoShots("/w/x.mp4", workDir(), cutter(0, [], { incomplete: "ffmpeg exited 1: Invalid data found when processing input" }));
    expect(cut.kind).toBe("unmeasured");
    expect(explainEmptyCut(cut)).toMatch(/the cut scan did not finish \(ffmpeg exited 1: Invalid data found.*\) — decode or scan failure/);
  });

  it("duration: a section with nothing measurable in it", () => {
    expect(explainEmptyCut({ kind: "no_clean_shot", durationSec: 0, cuts: 0, cutsSec: [] })).toMatch(/no measurable duration \(0s\)/);
  });

  it("extraction: the shots were found, and none could be written", async () => {
    const cut = await cutLocalVideoIntoShots("/w/x.mp4", workDir(), cutter(12, [6], { extractWorks: false }));
    expect(cut.kind).toBe("pieces");
    expect(explainEmptyCut(cut)).toBe("2 shot(s) found in 12.00s (1 cut(s)), but none could be extracted — extract/decode failure");
  });

  it("a cut that gave shots has nothing to explain", async () => {
    expect(explainEmptyCut(await cutLocalVideoIntoShots("/w/x.mp4", workDir(), cutter(12, [6])))).toBeNull();
    expect(explainEmptyCut({ kind: "one_shot", durationSec: 6 })).toBeNull();
  });

  it("the stock's cut and the second-section cut both write the reason down", () => {
    const stock = PIPE.slice(PIPE.indexOf("        cut: async (filePath, dir) => {"), PIPE.indexOf("          return [];\n        },", PIPE.indexOf("        cut: async (filePath, dir) => {")));
    expect(stock).toContain("const why = explainEmptyCut(cut);");
    expect(stock).toMatch(/no usable shot — \$\{why\}/);
    expect(PIPE).toMatch(/second section @\$\{Math\.round\(cut\.start\)\}s no usable shot — \$\{why\}/);
  });
});

describe("VIDEO 659 fix E — four seconds before, eight after, inside the video", () => {
  it("the reach", () => {
    expect(SECTION_BEFORE_SEC).toBe(4);
    expect(SECTION_AFTER_SEC).toBe(8);
    expect(windowsAroundApprovals([100], 600)).toEqual([{ startSec: 96, durationSec: 12 }]);
  });

  it("never before the video's start nor past its end", () => {
    expect(windowsAroundApprovals([2], 600)).toEqual([{ startSec: 0, durationSec: 10 }]);
    expect(windowsAroundApprovals([595], 600)).toEqual([{ startSec: 591, durationSec: 9 }]);
    expect(windowsAroundApprovals([3], 7)).toEqual([{ startSec: 0, durationSec: 7 }]);
  });

  it("every approved second lies inside its section", () => {
    const approved = [5, 40, 41, 130, 300, 450, 597];
    const w = windowsAroundApprovals(approved, 600);
    for (const s of approved) expect(w.some((x) => s >= x.startSec && s <= x.startSec + x.durationSec)).toBe(true);
  });

  it("six approvals far apart keep all six sections: the wider reach pushes none out", () => {
    const six = [50, 150, 250, 350, 450, 550];
    const w = windowsAroundApprovals(six, 600);
    expect(w).toHaveLength(MAX_SECTIONS);
    expect(MAX_SECTION_TOTAL_SEC).toBe(MAX_SECTIONS * (SECTION_BEFORE_SEC + SECTION_AFTER_SEC));
    expect(w.reduce((n, x) => n + x.durationSec, 0)).toBe(72);
  });
});

describe("VIDEO 659 fix E — the approved second and its sentence are kept; the rest is judged as before", () => {
  const FILM = 965_920;
  const KEY = "youtube_cc:0123456789abcdef";
  const SENTENCE = "Workers assembled the cars by hand on the factory floor.";
  afterEach(() => clearSheetApprovals(FILM));

  it("only the shot holding the approved second, for that sentence, carries the approval", () => {
    rememberSheetApprovals(FILM, KEY, [{ sec: 100, sentence: SENTENCE, depicts: "workers at an assembly line" }]);
    /** The wider section 96–108 s, cut into shots: */
    expect(sheetApprovalFor(FILM, KEY, 98.5, 103, SENTENCE)?.sec).toBe(100);
    /** The extra seconds before and after are other shots: no approval, judged and text-checked as before. */
    expect(sheetApprovalFor(FILM, KEY, 96, 98.2, SENTENCE)).toBeNull();
    expect(sheetApprovalFor(FILM, KEY, 104, 108, SENTENCE)).toBeNull();
    /** Same second, another sentence: no approval either. */
    expect(sheetApprovalFor(FILM, KEY, 98.5, 103, "The stock price fell sharply that winter.")).toBeNull();
  });
});
