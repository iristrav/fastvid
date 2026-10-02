/**
 * The product wiring the editor relies on, checked where it is decided: every save is a version
 * that can be restored, the editor autosaves and keeps its undo stack across saves, the AI and the
 * automatic replacement go through the timeline routes, and every length runs the one pipeline.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { VIDEO_LENGTH_VALUES, targetVideoDurationMinutes } from "@shared/videoLengths";
import { getScriptLengthBudget } from "./scriptWriter";
import { getScenesForLength } from "./videoPipeline";
import { absoluteMinDurationSec } from "./deliveryGate";
import { maxPipelineWallClockMin } from "./sourcingPolicy";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const ROUTER = read("timelineRouter.ts");
const EDITOR = read("../client/src/components/VideoEditor.tsx");

describe("versions: every save is kept and can be restored", () => {
  it("the editor's save and every server-side edit record a snapshot", () => {
    expect(ROUTER.match(/await recordTimelineSnapshot\(/g)?.length).toBe(2);
    expect(ROUTER).toContain("versions: protectedProcedure");
    expect(ROUTER).toContain("restoreVersion: protectedProcedure");
    /** A restore is a NEW version through the same validated persist path. */
    expect(ROUTER).toContain("what: `restore v${snapshot.timelineVersion}`");
  });

  it("the migration that creates the table is in the journal", () => {
    const journal = JSON.parse(read("../drizzle/meta/_journal.json")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.at(-1)?.tag).toBe("0064_editor_timeline_snapshots");
    expect(read("../drizzle/0064_editor_timeline_snapshots.sql")).toContain("CREATE TABLE IF NOT EXISTS `timeline_snapshots`");
  });
});

describe("the editor autosaves and keeps undo across saves", () => {
  it("autosaves two seconds after a change, and a save no longer resets the undo stack", () => {
    expect(EDITOR).toContain('save("autosave", true)');
    expect(EDITOR).not.toContain("setHistory(newHistory(result.timeline as Timeline));");
    expect(EDITOR).toContain("All changes saved");
  });

  it("AI commands and automatic replacement use the timeline routes, never a render route", () => {
    expect(EDITOR).toContain("trpc.timeline.aiEdit.useMutation()");
    expect(EDITOR).toContain("applyEditorOps(draft as unknown as EditableTimeline, plan.ops)");
    expect(EDITOR).toContain("trpc.timeline.autoReplaceClip.useMutation()");
    expect(ROUTER).toContain('route: "editor_auto_replace"');
    /** One replace route: the manual panel and the automatic one both end in the same function. */
    expect(ROUTER.match(/return replaceClipWithArchiveAsset\(/g)?.length).toBe(1);
    expect(ROUTER.match(/await replaceClipWithArchiveAsset\(/g)?.length).toBe(1);
  });
});

describe("every length runs the one pipeline; only budgets scale", () => {
  it("1, 3, 5, 10, 20, 30 and 60 minutes each have a script, scene count, delivery floor and time budget that grow with the length", () => {
    let lastWords = 0;
    let lastScenes = 0;
    let lastFloor = 0;
    let lastBudget = 0;
    for (const len of VIDEO_LENGTH_VALUES) {
      const words = getScriptLengthBudget(len).targetWords;
      const scenes = getScenesForLength(len);
      const floor = absoluteMinDurationSec(len);
      const budget = maxPipelineWallClockMin(len);
      expect(words, len).toBeGreaterThan(lastWords);
      expect(scenes, len).toBeGreaterThanOrEqual(lastScenes);
      expect(floor, len).toBeGreaterThan(lastFloor);
      expect(budget, len).toBeGreaterThanOrEqual(lastBudget);
      expect(floor, `${len}: the floor stays below the target length`).toBeLessThan(targetVideoDurationMinutes(len) * 60);
      lastWords = words;
      lastScenes = scenes;
      lastFloor = floor;
      lastBudget = budget;
    }
  });
});
