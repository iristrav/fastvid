/**
 * RONDE 110 — trimming the HEAD of an archive clip is as workable as trimming the tail.
 *
 * The capability was already there: RONDE 98 replaced the single "cut everything after this"
 * marker with a start and an end, and RONDE 108 made the whole path actually reach ffmpeg. What
 * was still missing was any way to place the start precisely.
 *
 * There was exactly one: park the playhead, click "Begin hier". That works for a rough cut and is
 * useless for the two seconds of slate at the head of a clip, where the operator knows they want
 * 2.4 and gets whichever frame the player happened to stop on. And the moment they played past
 * their own marker, the playhead — a filled bar from zero to the current position, drawn OVER the
 * kept range — covered the marker and the kept region both, so there was nothing left to aim at.
 *
 * This round gives each end the same row of controls: a typed value, nudges, a jump to the mark,
 * a clear. The timeline shades what will be DISCARDED and draws the playhead as a line. And
 * "Bekijk selectie" plays exactly the range that will survive, so the cut is seen before it
 * overwrites the original.
 *
 * The trim RULE is untouched. This round changed how a number is chosen, not what is allowed.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { MIN_TRIMMED_CLIP_SEC, validateTrimRange } from "@shared/archiveTrim";

const GRID = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "components", "admin", "ArchiveClipsGrid.tsx"),
  "utf8"
);
const TRIM = fs.readFileSync(path.join(__dirname, "archiveTrimToScene.ts"), "utf8");
const SPLITTER = fs.readFileSync(path.join(__dirname, "archiveVideoSplitter.ts"), "utf8");

/** Source with comment lines stripped — an assertion must not pass by reading its own note. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/* ═══════════ the rule did not move ═══════════ */

describe("RONDE 110 — trimming the head was always allowed, and still is", () => {
  it("a head-only trim is a valid range", () => {
    const v = validateTrimRange({ startSec: 2.4 }, 10);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.startSec).toBe(2.4);
      expect(v.endSec).toBe(10);
    }
  });

  it("both ends at once is a valid range", () => {
    const v = validateTrimRange({ startSec: 2.4, endSec: 8.1 }, 10);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.endSec - v.startSec).toBeCloseTo(5.7, 5);
  });

  it("the engine seeks to the start rather than always taking the head", () => {
    // -ss BEFORE -i, then -t for the kept length: that is what makes a head trim possible at all.
    expect(TRIM).toContain("-ss ${startSec.toFixed(3)} -i");
    expect(TRIM).toContain("-t ${keepSec.toFixed(3)}");
  });
});

/* ═══════════ one guarded setter ═══════════ */

describe("RONDE 110 — every control that moves a mark goes through the same guard", () => {
  it("there is one setter, and it holds the min-gap rule", () => {
    const idx = GRID.indexOf('function applyMark(which: "start" | "end", raw: number)');
    expect(idx).toBeGreaterThan(-1);
    const body = codeOnly(GRID.slice(idx, idx + 1200));
    expect(body).toContain("MIN_TRIMMED_CLIP_SEC");
    expect(body).toContain("setTrimStart(t);");
    expect(body).toContain("setTrimEnd(t);");
  });

  it("it clamps to the clip, so a nudge or a typed value cannot leave it", () => {
    const idx = GRID.indexOf('function applyMark(which: "start" | "end", raw: number)');
    const body = GRID.slice(idx, idx + 400);
    expect(body).toContain("Math.max(0, duration > 0 ? Math.min(raw, duration) : raw)");
  });

  it("the click, the nudges and the typed field all use it", () => {
    // The click path (markAt) delegates...
    expect(GRID).toContain("applyMark(which, read.sec);");
    // ...and so do the two rows, for both ends.
    expect(GRID).toContain('onNudge={(delta) => applyMark("start", rangeStart + delta)}');
    expect(GRID).toContain('onType={(sec) => applyMark("start", sec)}');
    expect(GRID).toContain('onNudge={(delta) => applyMark("end", rangeEnd + delta)}');
    expect(GRID).toContain('onType={(sec) => applyMark("end", sec)}');
  });

  it("a refusal still says which end it is about", () => {
    expect(GRID).toContain(
      "toast.error(`Startpunt moet minstens ${MIN_TRIMMED_CLIP_SEC}s vóór het eindpunt liggen`)"
    );
    expect(GRID).toContain(
      "toast.error(`Eindpunt moet minstens ${MIN_TRIMMED_CLIP_SEC}s ná het startpunt liggen`)"
    );
    expect(MIN_TRIMMED_CLIP_SEC).toBe(0.5);
  });
});

/* ═══════════ both ends, same controls ═══════════ */

describe("RONDE 110 — the head and the tail are edited the same way", () => {
  it("there is one row component, used twice", () => {
    expect(GRID).toContain("function TrimMarkRow({");
    expect(GRID).toContain('label="Begin"');
    expect(GRID).toContain('label="Einde"');
    expect((GRID.match(/<TrimMarkRow/g) ?? []).length).toBe(2);
  });

  it("each end can be typed as a number of seconds", () => {
    const idx = GRID.indexOf("function TrimMarkRow({");
    const body = GRID.slice(idx, idx + 3500);
    expect(body).toContain("function commit(raw: string)");
    // A comma is what a Dutch keyboard produces for a decimal point.
    expect(body).toContain('parseFloat(raw.replace(",", "."))');
    expect(body).toContain("if (!isFinite(n)) {");
    // Half-typed input is not thrown away on every keystroke.
    expect(body).toContain("const [draft, setDraft] = useState<string | null>(null);");
  });

  it("each end can be nudged coarse and fine", () => {
    const idx = GRID.indexOf("function TrimMarkRow({");
    const body = GRID.slice(idx, idx + 3500);
    expect(body).toContain("{[-1, -0.1, 0.1, 1].map((d) => (");
  });

  it("each end can be jumped to and cleared", () => {
    const idx = GRID.indexOf("function TrimMarkRow({");
    const body = GRID.slice(idx, idx + 3500);
    expect(body).toContain("onClick={onSeek}");
    expect(body).toContain("onClick={onClear}");
    expect(body).toContain("onClick={onSetFromPlayhead}");
    // Clearing is only offered for a mark that was actually placed.
    expect(body).toContain("{markSet && onClear && (");
  });

  it("an untouched end is the clip's own head or tail, so both rows always have a value", () => {
    expect(GRID).toContain("const rangeStart = trimStart ?? 0;");
    expect(GRID).toContain("const rangeEnd = trimEnd ?? duration;");
  });

  it("an untouched clip says what the controls are for instead of showing nothing", () => {
    expect(GRID).toContain("Zet een begin- en/of eindpunt om deze clip bij te knippen.");
  });
});

/* ═══════════ seeing the cut before making it ═══════════ */

describe("RONDE 110 — the operator can see what will survive", () => {
  it("the kept range can be played on its own", () => {
    expect(GRID).toContain("function previewKeptRange()");
    const idx = GRID.indexOf("function previewKeptRange()");
    const body = GRID.slice(idx, idx + 700);
    expect(body).toContain("v.currentTime = rangeStart;");
    expect(body).toContain("previewStopRef.current = rangeEnd > rangeStart ? rangeEnd : null;");
    expect(GRID).toContain("Bekijk selectie");
  });

  it("the preview stops at the end mark, driven by the video's own clock", () => {
    // A setTimeout would drift with buffering; timeupdate cannot.
    const idx = GRID.indexOf('["timeupdate", () => {');
    expect(idx).toBeGreaterThan(-1);
    const body = GRID.slice(idx, idx + 500);
    expect(body).toContain("const stopAt = previewStopRef.current;");
    expect(body).toContain("v.pause();");
    expect(body).toContain("previewStopRef.current = null;");
  });

  it("the stop point is a ref, because the listener is attached once", () => {
    /**
     * The timeupdate listener is added inside an effect keyed on asset.id and never re-attached,
     * so a state value read inside it would be frozen at whatever it was when the modal opened.
     */
    expect(GRID).toContain("const previewStopRef = useRef<number | null>(null);");
  });

  it("any other seek cancels the preview, so it cannot pause somewhere unexpected later", () => {
    const idx = GRID.indexOf("function seekTo(sec: number)");
    expect(idx).toBeGreaterThan(-1);
    expect(GRID.slice(idx, idx + 500)).toContain("previewStopRef.current = null;");
    // The scrub bar and both "Ga heen" buttons go through it.
    expect(GRID).toContain("seekTo(frac * duration);");
    expect(GRID).toContain("onSeek={() => seekTo(rangeStart)}");
    expect(GRID).toContain("onSeek={() => seekTo(rangeEnd)}");
  });
});

/* ═══════════ the timeline stopped hiding the marks ═══════════ */

describe("RONDE 110 — the marks stay visible while the clip plays", () => {
  it("the playhead is a line, not a bar drawn over the kept range", () => {
    // The old fill: a bar from 0 to the current position, on top of everything.
    expect(codeOnly(GRID)).not.toContain('className="absolute top-0 h-full bg-white/30 rounded-full"');
    expect(GRID).toContain('className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/80"');
  });

  it("what will be DISCARDED is shaded, at both ends", () => {
    expect(GRID).toContain("{rangeStart > 0 && (");
    expect(GRID).toContain("{rangeEnd < duration && (");
    expect(GRID).toContain("wordt weggeknipt aan het begin");
    expect(GRID).toContain("wordt weggeknipt aan het einde");
  });

  it("both markers are still drawn on top", () => {
    expect(GRID).toContain("bg-emerald-300 rounded-full");
    expect(GRID).toContain("bg-red-400 rounded-full");
  });
});

/* ═══════════ the other question: scenes or seconds ═══════════ */

describe("RONDE 110 — an uploaded video is split at scenes, not at a stopwatch", () => {
  /**
   * Asked directly: when a long video with several scenes is uploaded, does it cut per scene or
   * per second? These pin the answer so it stays true.
   */
  it("the splitter's whole premise is shot boundaries", () => {
    expect(SPLITTER).toContain("Split archive videos at real shot/scene boundaries — NOT on fixed time intervals.");
  });

  it("two independent detectors decide where the cuts are", () => {
    expect(SPLITTER).toContain("async function detectScdetCutTimes(");
    expect(SPLITTER).toContain("async function detectSceneFilterCutTimes(");
    expect(SPLITTER).toContain("combineShotCutTimes([scdetCuts, sceneCuts])");
  });

  it("clip ranges are built from the detected cuts and nothing else", () => {
    const idx = SPLITTER.indexOf("export function buildClipRanges(");
    const body = SPLITTER.slice(idx, idx + 800);
    expect(body).toContain("const points = [0, ...cutPoints, totalDuration];");
  });

  it("a detected scene is NOT chopped to a fixed length — only a failed detection is", () => {
    /**
     * RONDE 98's finding, still the rule: a 38-second continuous shot used to come out as seven
     * 5.4-second clips because the six-second ceiling was applied to every range. The ceiling now
     * depends on whether the detector found anything at all.
     */
    expect(SPLITTER).toContain("const sceneAware = cuts.length > 0;");
    expect(SPLITTER).toContain(
      "const splitCeiling = sceneAware ? sceneSafetyMaxSec() : maxClipDurationSec();"
    );
  });

  it("the fixed-interval path is the fallback for a video with no detectable cuts", () => {
    expect(SPLITTER).toContain("no valid shot ranges after detection — fixed-interval fallback");
    expect(SPLITTER).toContain("ranges = splitLongRanges([{ start: 0, end: effectiveDur }]);");
  });

  it("even the fallback's output is re-scanned for real boundaries afterwards", () => {
    expect(SPLITTER).toContain("Rescanning interval-split clips for scene boundaries");
    expect(SPLITTER).toContain("ranges = await rescanRangesForInteriorCuts(");
  });

  it("an extracted clip that still holds two shots is split again", () => {
    expect(SPLITTER).toContain("async function enforceSingleSceneClipSegments(");
    expect(SPLITTER).toContain("still has ");
    expect(SPLITTER).toContain("interior cut(s) → splitting into ");
  });
});
