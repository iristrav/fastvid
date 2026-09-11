import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  BLOCKED_EXPORT_METADATA_KEY,
  blockedExportForVideo,
  readBlockedExport,
} from "@shared/exportBlocked";

/**
 * A BLOCKED EXPORT MAY NOT PUBLISH THE FILM. IT MAY NOT LOSE IT EITHER.
 *
 * Render 577 uploaded 71 MB to S3, failed `enforceQualityExportGate` on
 * MOSTLY_UNVERIFIED_CLIPS, and left a row reading `failed` with no `videoUrl` — because the
 * only write that records the URL sits past the gate. The film existed and nobody could
 * reach it. These tests pin the repair, and pin just as hard that it is not a relaxation:
 * the gate still throws, the status is still `failed`, and nothing reads a stored URL as
 * approval to publish.
 */

const repoRoot = join(__dirname, "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

describe("the record itself", () => {
  const record = { reason: "Export blocked — MOSTLY_UNVERIFIED_CLIPS", videoUrl: "/manus-storage/videos/577/final.mp4", at: "2026-09-11T10:00:00.000Z" };

  it("reads back what was written", () => {
    expect(readBlockedExport({ [BLOCKED_EXPORT_METADATA_KEY]: record })).toEqual(record);
  });

  it("a half-written record is NOT a blocked export", () => {
    /**
     * The UI puts a player on screen on the strength of this answer. A record without a URL
     * would promise a film it cannot point at, which is the failure this whole change exists
     * to end — in the other direction.
     */
    expect(readBlockedExport({ [BLOCKED_EXPORT_METADATA_KEY]: { reason: "x", at: "y" } })).toBeNull();
    expect(readBlockedExport({ [BLOCKED_EXPORT_METADATA_KEY]: { videoUrl: "u", at: "y" } })).toBeNull();
    expect(readBlockedExport({ [BLOCKED_EXPORT_METADATA_KEY]: { reason: "x", videoUrl: "u" } })).toBeNull();
    expect(readBlockedExport({ [BLOCKED_EXPORT_METADATA_KEY]: { reason: "   ", videoUrl: "u", at: "y" } })).toBeNull();
  });

  it("an unrelated metadata blob answers null rather than throwing", () => {
    expect(readBlockedExport(null)).toBeNull();
    expect(readBlockedExport({ nicheTitle: "WW2" })).toBeNull();
    expect(readBlockedExport([1, 2, 3])).toBeNull();
    expect(readBlockedExport("not json")).toBeNull();
  });

  it("ONLY A STILL-FAILED VIDEO IS SHOWING THE BLOCKED RENDER", () => {
    /**
     * The record stays in metadata across a retry — it is history, not a live flag. So the
     * status is part of the question. A render that went on to succeed must not carry a
     * "not published" banner over the film that WAS published.
     */
    const meta = { [BLOCKED_EXPORT_METADATA_KEY]: record };
    expect(blockedExportForVideo({ status: "failed", metadata: meta })).toEqual(record);
    expect(blockedExportForVideo({ status: "completed", metadata: meta })).toBeNull();
    expect(blockedExportForVideo({ status: "generating_visuals", metadata: meta })).toBeNull();
    expect(blockedExportForVideo({ status: "queued", metadata: meta })).toBeNull();
    expect(blockedExportForVideo(null)).toBeNull();
  });

  it("a failed video WITHOUT a record is an ordinary failure", () => {
    // A crash before the upload leaves no film. Nothing must offer to play one.
    expect(blockedExportForVideo({ status: "failed", metadata: { nicheTitle: "WW2" } })).toBeNull();
    expect(blockedExportForVideo({ status: "failed", metadata: null })).toBeNull();
  });
});

describe("the write", () => {
  const db = () => read("server/db.ts");

  it("status and URL are written in ONE statement", () => {
    /**
     * `recoverVideoCompletionState` promotes a non-terminal row that has a `videoUrl` straight
     * to `completed`. Recording the URL first and letting routers.ts set `failed` afterwards
     * would leave a window in which a dashboard poll publishes the film the gate just refused.
     * One `.set()` carrying both closes it.
     */
    const src = db();
    const fn = src.slice(src.indexOf("export async function recordBlockedExport"));
    const body = fn.slice(0, fn.indexOf("\nexport async function", 10));
    const setCalls = body.match(/\.set\(/g) ?? [];
    expect(setCalls.length, "one write, not two").toBe(1);
    const setBlock = body.slice(body.indexOf(".set("));
    expect(setBlock).toContain('status: "failed"');
    expect(setBlock).toContain("videoUrl,");
    expect(setBlock).toContain("[BLOCKED_EXPORT_METADATA_KEY]: record");
  });

  it("THE STATUS IS FAILED AND NOTHING ELSE", () => {
    // The one line that would turn this repair into a gate bypass.
    const src = db();
    const fn = src.slice(src.indexOf("export async function recordBlockedExport"));
    const body = fn.slice(0, fn.indexOf("\nexport async function", 10));
    expect(body).not.toContain('"completed"');
  });

  it("earlier metadata survives — the record is merged, not substituted", () => {
    const src = db();
    const fn = src.slice(src.indexOf("export async function recordBlockedExport"));
    const body = fn.slice(0, fn.indexOf("\nexport async function", 10));
    expect(body).toContain("...readVideoMetadataObject(video)");
  });

  it("recovery still refuses to promote a failed row", () => {
    /**
     * The guard this repair leans on. If `recoverVideoCompletionState` ever stopped returning
     * early for `failed`, every blocked render would publish itself on the next poll.
     */
    const src = db();
    const fn = src.slice(src.indexOf("export async function recoverVideoCompletionState"));
    const firstLine = fn.slice(0, fn.indexOf("\n", fn.indexOf("{")) + 200);
    expect(firstLine).toContain('if (video.status === "completed" || video.status === "failed") return video;');
  });
});

describe("the pipeline call site", () => {
  const pipeline = () => read("server/videoPipeline.ts");

  it("the gate is still called, and its error still travels on", () => {
    const src = pipeline();
    const at = src.indexOf("enforceQualityExportGate(videoId, qualityReport, videoLength, finalValidation)");
    expect(at, "the gate call is still there").toBeGreaterThan(0);
    const around = src.slice(at, at + 900);
    expect(around, "the refusal is rethrown, never swallowed").toContain("throw gateError;");
  });

  it("THE GATE'S VERDICT IS NOT INSPECTED, WEAKENED OR RECLASSIFIED", () => {
    /**
     * The catch exists to record a location. The moment it starts reading which condition
     * fired and deciding some of them are acceptable, it has become a second gate.
     */
    const src = pipeline();
    const at = src.indexOf("} catch (gateError) {");
    const body = src.slice(at, src.indexOf("throw gateError;", at));
    expect(body).not.toContain("MOSTLY_UNVERIFIED");
    expect(body).not.toContain("NO_VERIFIED_OWN_VISUAL");
    expect(body).not.toContain("indefensible");
    expect(body).not.toContain("updateVideoStatus");
  });

  it("nothing is recorded when there is no file to record", () => {
    // A render that never reached the upload has no URL. It must not claim one.
    const src = pipeline();
    const at = src.indexOf("} catch (gateError) {");
    const body = src.slice(at, src.indexOf("throw gateError;", at));
    expect(body).toContain("if (url) {");
  });
});

describe("what the owner can reach", () => {
  it("the download route asks for ownership and a file, never for a status", () => {
    /**
     * This is why persisting the URL is enough to make the film reachable at all: the route
     * was never gated on `completed`. Pinned so a later status check cannot quietly close the
     * door again.
     */
    const src = read("server/_core/index.ts");
    const at = src.indexOf('app.get("/api/download/video/:id"');
    const body = src.slice(at, src.indexOf('app.get("/api/stream/video/:id"'));
    expect(body).toContain("video.userId !== userId && user?.role !== \"admin\"");
    expect(body).toContain("if (!video.videoUrl)");
    expect(body, "no status gate on the owner's own file").not.toContain('status === "completed"');
  });

  it("the dashboard offers the blocked render a way in", () => {
    const src = read("client/src/pages/Dashboard.tsx");
    expect(src).toContain('import { blockedExportForVideo } from "@shared/exportBlocked";');
    expect(src, "a card that only offers Retry is how 577 became unreachable").toContain("Watch anyway");
    expect(src).toContain('{(currentStatus === "completed" || blockedExport) && (');
    expect(src).toContain('{(video.status === "completed" || blockedExport) && video.videoUrl && !fileMissing && (');
  });

  it("the dashboard says it is NOT published", () => {
    // No silent substitution: the banner carries the gate's own sentence.
    const src = read("client/src/pages/Dashboard.tsx");
    expect(src).toContain("Not published — the quality gate held this render back");
    expect(src).toContain("appErrorText(blockedExport.reason)");
  });

  it("a blocked render does not reach the editor", () => {
    /**
     * The scene manifest is written past the gate, so there is nothing for the editor to open.
     * Offering the button would teach people the feature is broken — RONDE 148 §12's own
     * reasoning, applied to the new case.
     */
    const src = read("client/src/pages/Dashboard.tsx");
    const at = src.indexOf("RONDE 148 §12 — the way in.");
    const around = src.slice(at, at + 1200);
    expect(around).toContain('{video.status === "completed" && (');
    expect(around).toContain("Edit video");
  });

  it("a blocked render is never counted as a completed one", () => {
    const src = read("client/src/pages/Dashboard.tsx");
    expect(src).toContain('const completedVideos = videos?.filter(v => v.status === "completed") ?? [];');
  });
});
