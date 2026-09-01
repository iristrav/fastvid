/**
 * RONDE 109 — asking for a second video parks it instead of refusing it.
 *
 * Reported from the dashboard: "Failed to start generation — You already have a video in progress.
 * Wait until it is finished before starting a new one." Nothing was created. The person had to sit
 * and watch a fifteen-minute render end before they could ask for the next one, which is the
 * machine's scheduling problem handed to a human.
 *
 * The queue was always there and always worked — enqueueVideoJob, an ordered picker, an automatic
 * tick the moment a slot frees. The only thing standing in front of it was a hard-coded
 * "more than zero in flight is too many" in assertUserCanEnqueueVideo. The whole feature was one
 * comparison away from existing, and MAX_QUEUED_JOBS_PER_USER was already read from the
 * environment, already defaulted, already unit-tested — and never consulted by any code path.
 *
 * What changed:
 *   - the enqueue check compares against a real depth (five) instead of zero;
 *   - the picker's per-user "is this user busy" count now includes awaiting_approval, so the brief
 *     mid-render window in that status cannot be read as an idle user and start a second render;
 *   - the person is told their position in THEIR OWN line, not the platform's.
 *
 * What did NOT change, and is the point of the round: how many videos RUN at once.
 * maxActiveJobsPerUser is still 1. The five go one after the other.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  USER_ACTIVE_VIDEO_STATUSES,
  USER_IN_FLIGHT_VIDEO_STATUSES,
  USER_QUEUE_DEPTH_DEFAULT,
  readQueueConfig,
} from "@shared/videoQueue";

const QUEUE = fs.readFileSync(path.join(__dirname, "videoQueue.ts"), "utf8");
const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
const DASHBOARD = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "pages", "Dashboard.tsx"),
  "utf8"
);
const QUEUE_INDEX = fs.readFileSync(path.join(__dirname, "queue", "index.ts"), "utf8");
const BULLMQ = fs.readFileSync(path.join(__dirname, "queue", "bullmqQueue.ts"), "utf8");

/** Source with comment lines stripped — so an assertion cannot pass by reading its own note. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/* ═══════════ the rule ═══════════ */

describe("RONDE 109 — the depth is five, and it is a real setting", () => {
  it("five is the product rule, written down once", () => {
    expect(USER_QUEUE_DEPTH_DEFAULT).toBe(5);
  });

  it("the config defaults to it instead of to one", () => {
    expect(readQueueConfig({}).maxQueuedJobsPerUser).toBe(5);
  });

  it("an operator can still override it", () => {
    expect(readQueueConfig({ MAX_QUEUED_JOBS_PER_USER: "3" }).maxQueuedJobsPerUser).toBe(3);
    // A value that is not a usable depth falls back to the rule rather than to zero, which would
    // refuse every video. "0" is one of those: a queue nobody may enter is not a configuration,
    // it is a typo, so it lands on the documented default like any other unparseable value.
    expect(readQueueConfig({ MAX_QUEUED_JOBS_PER_USER: "nonsense" }).maxQueuedJobsPerUser).toBe(5);
    expect(readQueueConfig({ MAX_QUEUED_JOBS_PER_USER: "0" }).maxQueuedJobsPerUser).toBe(5);
  });

  it("HOW MANY RUN AT ONCE did not change — this round raised the queue, not the concurrency", () => {
    /**
     * The whole request was "the next one starts by itself when this one is done". If this ever
     * became 5, five renders would run at once for one account: five ffmpeg pipelines, five sets
     * of provider quotas, and a machine that falls over. The depth and the concurrency are two
     * different numbers and only one of them moved.
     */
    expect(readQueueConfig({}).maxActiveJobsPerUser).toBe(1);
  });
});

/* ═══════════ the check that used to refuse ═══════════ */

describe("RONDE 109 — the enqueue check compares against a depth, not against zero", () => {
  it("the old 'more than zero is too many' is gone", () => {
    expect(codeOnly(QUEUE)).not.toContain("if (inFlight > 0) {");
    expect(QUEUE).toContain("const limit = userQueueDepthLimit();");
    expect(QUEUE).toContain("if (inFlight >= limit) {");
  });

  it("the limit comes from the config, so it is one number and not a literal in the check", () => {
    expect(QUEUE).toContain("export function userQueueDepthLimit(): number {");
    expect(QUEUE).toContain("return readQueueConfig().maxQueuedJobsPerUser;");
  });

  it("the refusal, when it does happen, says what the limit is and what to do", () => {
    // The old message told the person to wait, which is now wrong advice four times out of five.
    // Comments stripped first: the note above the check quotes the old wording, and an assertion
    // that reads its own documentation proves nothing.
    expect(codeOnly(QUEUE)).not.toContain("Wait until it is finished before starting a new one");
    expect(QUEUE).toContain("is the maximum");
    expect(QUEUE).toContain("They run one after the other");
  });

  it("an accepted check reports how full the line already is", () => {
    expect(QUEUE).toContain("return { ok: true, inFlight, limit };");
    expect(QUEUE).toContain("| { ok: true; inFlight: number; limit: number }");
  });

  it("the retry path still excludes the video being retried from its own count", () => {
    // Otherwise a retry of the user's only video would count that video against the limit.
    expect(QUEUE).toContain("countUserInFlightVideos(userId, exceptVideoId)");
    expect(ROUTERS).toContain("assertUserCanEnqueueVideo(ctx.user.id, video.id)");
  });

  it("a WAITING video counts against the limit — otherwise the depth would not be a depth", () => {
    expect(USER_IN_FLIGHT_VIDEO_STATUSES).toContain("queued");
  });
});

/* ═══════════ the next one starts by itself ═══════════ */

describe("RONDE 109 — the queue picks up the next one without being asked", () => {
  it("finishing a job ticks the queue again", () => {
    // This is what makes "as soon as it is done, continue with the next" true rather than a
    // promise kept by a five-second poll.
    const idx = QUEUE.indexOf("const releaseSlot = () => {");
    const body = QUEUE.slice(idx, idx + 300);
    expect(body).toContain("decrementActiveJobs();");
    expect(body).toContain("void processQueueTick();");
  });

  it("the poll is the backstop, so a missed tick costs seconds and not the whole queue", () => {
    expect(QUEUE).toContain("pollTimer = setInterval(() => {");
    expect(readQueueConfig({}).pollIntervalMs).toBe(5000);
  });

  it("a user's own videos are started in the order they were asked for", () => {
    expect(DB).toContain(".orderBy(videos.createdAt, videos.id)");
  });
});

/* ═══════════ the race the depth makes reachable ═══════════ */

describe("RONDE 109 — a user cannot end up with two renders at once", () => {
  it("awaiting_approval counts as 'this user is busy' for the picker", () => {
    /**
     * A full run writes awaiting_approval when the script is finished and moves to
     * generating_voiceover a moment later. That status is not a pipeline-processing status, so a
     * picker tick landing inside that window used to see the user as idle. Before this round the
     * user could not have a second video queued, so nothing was there to claim; now there can be
     * four, and the window would be enough to start one alongside the running render.
     */
    expect(USER_ACTIVE_VIDEO_STATUSES).toContain("awaiting_approval");
    for (const s of ["generating_script", "generating_voiceover", "generating_visuals"]) {
      expect(USER_ACTIVE_VIDEO_STATUSES).toContain(s);
    }
  });

  it("...but 'queued' is NOT in that list, or the picker would never start anything", () => {
    expect(USER_ACTIVE_VIDEO_STATUSES).not.toContain("queued");
  });

  it("the picker uses the wider count, not the processing-only one", () => {
    const idx = QUEUE.indexOf("async function pickNextQueuedVideo()");
    const body = QUEUE.slice(idx, idx + 1200);
    expect(body).toContain("await countActiveVideosByUsers(uniqueUserIds)");
    expect(body).not.toContain("countProcessingVideosByUsers");
    expect(body).toContain("if (userActive >= config.maxActiveJobsPerUser) continue;");
  });

  it("the wider count is one query for all users, like the one it replaces", () => {
    // The picker looks at up to 100 queued rows per tick; a query per user would be 100 queries
    // every five seconds.
    const idx = DB.indexOf("export async function countActiveVideosByUsers(");
    expect(idx).toBeGreaterThan(-1);
    const body = DB.slice(idx, idx + 700);
    expect(body).toContain("inArray(videos.status, USER_ACTIVE_STATUS_LIST)");
    expect(body).toContain(".groupBy(videos.userId)");
  });

  it("the global caps are untouched — one account still cannot take the platform", () => {
    const idx = QUEUE.indexOf("async function pickNextQueuedVideo()");
    const body = QUEUE.slice(idx, idx + 1200);
    expect(body).toContain("if (globalActive >= config.maxConcurrentJobs) return undefined;");
    expect(QUEUE).toContain("while (activeJobsCount() < renderCap) {");
  });
});

/* ═══════════ what the person is told ═══════════ */

describe("RONDE 109 — the queued video says it is ready, not that it failed", () => {
  it("the position reported is the person's own line, not the platform's", () => {
    const idx = DB.indexOf("export async function getUserQueuePosition(");
    expect(idx).toBeGreaterThan(-1);
    const body = DB.slice(idx, idx + 900);
    expect(body).toContain("eq(videos.userId, video.userId)");
    expect(body).toContain('eq(videos.status, "queued")');
    // 1-based, same convention as the platform-wide one.
    expect(body).toContain('return Number(row?.count ?? 0) + 1;');
  });

  it("only a queued video has a position at all", () => {
    const idx = DB.indexOf("export async function getUserQueuePosition(");
    expect(DB.slice(idx, idx + 400)).toContain('if (!video || video.status !== "queued") return null;');
  });

  it("enqueueing returns both positions", () => {
    expect(QUEUE).toContain("Promise<{ queuePosition: number; userQueuePosition: number }>");
    expect(QUEUE).toContain("return { queuePosition, userQueuePosition };");
  });

  it("generate reports the person's own position and the limit", () => {
    const idx = ROUTERS.indexOf("const { queuePosition, userQueuePosition } = await enqueueVideoJob(");
    expect(idx).toBeGreaterThan(-1);
    const block = ROUTERS.slice(idx, idx + 900);
    expect(block).toContain("queueLimit: userQueueDepthLimit(),");
    expect(block).toContain("`Video queued — ${userQueuePosition} of yours waiting`");
  });

  it("polling a queued video returns its position, so the card can keep showing it", () => {
    expect(ROUTERS).toContain(
      'video.status === "queued" ? await getUserQueuePosition(video.id) : null'
    );
    expect(ROUTERS).toContain("userQueuePosition,");
  });

  it("the card says it is waiting and that it starts by itself", () => {
    expect(DASHBOARD).toContain("(pollData?.userQueuePosition ?? 0) > 1 &&");
    expect(DASHBOARD).toContain("Ready and waiting");
    expect(DASHBOARD).toContain("Starts automatically");
  });

  it("the success toast no longer implies the person has to do something", () => {
    expect(DASHBOARD).toContain("it starts automatically when the video before it finishes");
    expect(DASHBOARD).toContain("data.queueLimit ?? 5");
  });
});

/* ═══════════ both backends ═══════════ */

describe("RONDE 109 — the switchable queue backends still agree on their shape", () => {
  it("the backend switch exposes the new helpers", () => {
    expect(QUEUE_INDEX).toContain("export const getUserQueuePosition = dbQueue.getUserQueuePosition;");
    expect(QUEUE_INDEX).toContain("export const userQueueDepthLimit = dbQueue.userQueueDepthLimit;");
    expect(QUEUE_INDEX).toContain(
      "Promise<{ queuePosition: number; userQueuePosition: number }>"
    );
  });

  it("the opt-in BullMQ backend returns the same fields", () => {
    expect(BULLMQ).toContain("return { queuePosition, userQueuePosition };");
  });

  it("BullMQ's missing per-user gate is written down rather than left to be discovered", () => {
    // It is off by default and its concurrency is 1, and the per-user render semaphore in
    // _generateVideoWithAI serialises within a process — but anyone raising either needs to know.
    expect(BULLMQ).toContain("no per-user picker check");
    expect(BULLMQ).toContain("per-user claim gate");
  });
});
