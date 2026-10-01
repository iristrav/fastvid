/**
 * ONE ROUTE — the ProjectTimeline is the one persistent truth of a video's cut.
 *
 * A render stores a timeline, never a scene manifest. Old videos that only have a manifest still
 * open and still render, because every reader keeps deriving a timeline from the manifest when no
 * timeline was ever stored. No column was dropped and no data was migrated.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");
const PIPE = read("server/videoPipeline.ts");

describe("new renders write the timeline only", () => {
  it("the render no longer stores a scene manifest, and nothing else does either", () => {
    expect(PIPE).not.toContain("updateVideoScenes(");
    expect(read("server/db.ts")).not.toContain("export async function updateVideoScenes(");
    expect(read("server/routers.ts")).not.toMatch(/getScenes: protectedProcedure|replaceClipInScenes/);
  });

  it("a render whose plan was not stored stores the manifest's timeline instead — once, never over an existing one", () => {
    const at = PIPE.indexOf("const persistTimelineFromManifest = async");
    expect(at).toBeGreaterThan(-1);
    const body = PIPE.slice(at, PIPE.indexOf("\n      };", at));
    expect(body).toContain("if (expectedVersion !== 0) return;");
    expect(body).toContain("timelineFromEditorScenes({ videoId, scenes: editorScenes })");
    expect(body).toContain("saveVideoTimeline({");
    expect(PIPE).toContain("await persistTimelineFromManifest(`plan not stored: ${outcome.code}`);");
    /** Code audit P12: planning has no switch, so "planning off" is no longer a reason. */
    expect(PIPE).not.toContain("cinematicPlanningEnabled(");
  });
});

describe("old videos keep opening and rendering", () => {
  it("the editor derives a timeline from the stored manifest when no timeline was ever saved", () => {
    const router = read("server/timelineRouter.ts");
    expect(router).toContain("const scenes = await getVideoScenes(videoId);");
    expect(router).toContain("timelineFromEditorScenes({");
  });

  it("the render job does the same for a job at timeline version 0", () => {
    const worker = read("server/renderJobWorker.ts");
    expect(worker).toContain("const scenes = await getVideoScenes(job.videoId);");
    expect(worker).toContain('source: "manifest",');
  });

  it("the editor reads the timeline router and nothing else", () => {
    const editor = read("client/src/components/VideoEditor.tsx");
    expect(editor).toContain("trpc.timeline.get.useQuery({ videoId })");
    expect(editor).not.toMatch(/trpc\.video\.(getScenes|replaceClip)/);
  });

  it("the schema still holds both columns — nothing was dropped or migrated", () => {
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('videoScenes: json("videoScenes")');
    expect(schema).toContain('videoTimeline: json("videoTimeline")');
  });
});
