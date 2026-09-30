/**
 * THE DASHBOARD'S LIST IS LIGHT — "Ik vind de site heel traag."
 *
 * `video.list` returned every column of every video — the script, the scene manifest, the editor's
 * timeline, the progress log — and the dashboard asked for it every five seconds. Production timed
 * it at 2 to 4 seconds on every load and 20, 46 and 62 seconds at worst, on a service using a tenth
 * of a CPU. The list now carries what a card shows, and refreshes itself only while a video is
 * being made.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { VIDEO_LIST_METADATA_KEYS, slimListMetadata } from "./db";

const ROOT = path.join(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("the list reads only what a card shows", () => {
  it("of metadata only the keys the card reads, from text or object; absent keys are dropped", () => {
    expect([...VIDEO_LIST_METADATA_KEYS]).toEqual(["generationDurationSec", "nicheTitle", "exportBlocked"]);
    expect(slimListMetadata('{"generationDurationSec": 312, "nicheTitle": null, "exportBlocked": null}')).toEqual({
      generationDurationSec: 312,
    });
    expect(slimListMetadata({ nicheTitle: "History", pipelineReport: { huge: true } })).toEqual({ nicheTitle: "History" });
    expect(slimListMetadata({ exportBlocked: { reason: "x" } })).toEqual({ exportBlocked: { reason: "x" } });
    expect(slimListMetadata(null)).toBeNull();
    expect(slimListMetadata("not json")).toBeNull();
    expect(slimListMetadata('{"generationDurationSec": null}')).toBeNull();
  });

  it("the query names its columns; the script, scenes, timeline and progress log are not among them", () => {
    const db = read("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getVideoListRowsByUserId("), db.indexOf("export function slimListMetadata("));
    for (const col of ["script", "videoScenes", "videoTimeline", "progressLog"]) {
      expect(fn, col).not.toContain(`videos.${col}`);
    }
    expect(fn).toContain("JSON_EXTRACT(${videos.metadata}");
    expect(fn).not.toContain("db.select().from(videos)");
  });

  it("video.list uses it; a video in flight is read in full only for its recovery", () => {
    const routers = read("server/routers.ts");
    const list = routers.slice(routers.indexOf("    list: protectedProcedure.query(async ({ ctx }) => {"));
    const body = list.slice(0, list.indexOf("    get: protectedProcedure"));
    expect(body).toContain("await getVideoListRowsByUserId(ctx.user.id)");
    expect(body).not.toContain("getVideosByUserId(");
    expect(body).toContain("const full = await getVideoById(v.id);");
    expect(body).toContain("metadata: slimListMetadata(recovered.metadata),");
  });
});

describe("the dashboard refreshes the list only while a video is being made", () => {
  const dash = read("client/src/pages/Dashboard.tsx");

  it("the five-second refresh depends on a video in flight", () => {
    const at = dash.indexOf("trpc.video.list.useQuery(undefined, {");
    const opts = dash.slice(at, at + 400);
    expect(opts).toContain("refetchInterval: (query) =>");
    expect(opts).toContain('.some((v) => !["completed", "failed"].includes(v.status))');
    expect(opts).not.toContain("refetchInterval: showVideoStudio ? 5000 : false");
  });

  it("a retry refreshes the list itself, since nothing else would", () => {
    const at = dash.indexOf("const regenScriptMutation = trpc.video.regenScript.useMutation({");
    expect(dash.slice(at, at + 300)).toContain("utils.video.list.invalidate()");
  });
});

describe("a video is complete when its file is, and a failed one can be deleted", () => {
  /**
   * 626: the voice-over was stored at 16:18:49 with `updateVideoStatus(id, "completed", …)`, the
   * render job ran for four minutes after it, and a look at 16:18:52 read "This video completed
   * but the file is missing".
   */
  it("storing the voice-over writes its address only, never the status", () => {
    const pipe = read("server/videoPipeline.ts");
    expect(pipe).not.toContain('updateVideoStatus(videoId, "completed", { voiceoverUrl: persisted.url })');
    expect(pipe).toContain("await updateVideoVoiceoverUrl(videoId, persisted.url);");
    const db = read("server/db.ts");
    const fn = db.slice(db.indexOf("export async function updateVideoVoiceoverUrl("), db.indexOf("export async function updateVideoProgress("));
    expect(fn).toContain(".set({ voiceoverUrl })");
    expect(fn).not.toContain("status");
  });

  /** `render_jobs.videoId` has no ON DELETE CASCADE: "delete all failed" answered 500. */
  it("deleting a video removes its render jobs first, in one transaction", () => {
    const db = read("server/db.ts");
    const one = db.slice(db.indexOf("export async function deleteVideo("), db.indexOf("export async function updateVideoTitle("));
    expect(one).toContain("db.transaction(");
    expect(one.indexOf("tx.delete(renderJobs)")).toBeGreaterThan(-1);
    expect(one.indexOf("tx.delete(renderJobs)")).toBeLessThan(one.indexOf("tx.delete(videos)"));
    const all = db.slice(db.indexOf("export async function deleteAllFailedVideosForUser("), db.indexOf("const IN_PROGRESS_STATUSES"));
    expect(all).toContain("db.transaction(");
    expect(all).toContain("tx.delete(renderJobs).where(inArray(renderJobs.videoId, ids))");
    expect(all.indexOf("tx.delete(renderJobs)")).toBeLessThan(all.indexOf("tx.delete(videos)"));
    /** Still only this user's failed videos. */
    expect(all).toContain('and(eq(videos.userId, userId), eq(videos.status, "failed"), inArray(videos.id, ids))');
  });
});
