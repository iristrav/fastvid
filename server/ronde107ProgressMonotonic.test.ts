/**
 * RONDE 107 — the percent on a video goes up, or starts over. It never slips.
 *
 * A progress bar that steps backwards is not a smaller claim than the one before it; it is a
 * broken one, and once a viewer has seen it happen they stop believing any of the number.
 *
 * It could slip in two independent places, and both had to be closed:
 *
 *   SERVER  The percent is written from a dozen call sites with fixed values — 5, 28, 29, 30,
 *           100 — and the pipeline does not visit them in one ascending order. A render at 45%
 *           reaching a stage hard-coded to 29 wrote 29.
 *
 *   CLIENT  The ratchet in useSmoothedProgressPercent lived in component state, so it lasted
 *           exactly as long as the component. A scroll, a tab switch or a refetch that remounted
 *           the card started it again from the raw backend value — and since the hook deliberately
 *           creeps a few points AHEAD between polls, a remount reliably showed a lower number than
 *           the one that had just been on screen.
 *
 * A RESET is a different thing from a slip and stays possible: a retry is a new run and starts at
 * its own number. Both halves recognise it the same way — the write that sets
 * `generationStartedAt` is the one allowed to lower the stored value, and the client folds that
 * same timestamp into its key so a new run gets a fresh mark.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
const BAR = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "components", "GenerationProgressBar.tsx"),
  "utf8"
);
const DASHBOARD = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "pages", "Dashboard.tsx"),
  "utf8"
);
const ADMIN = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "pages", "Admin.tsx"),
  "utf8"
);

/** The body of one exported function, brace-matched from its declaration. */
function bodyOf(src: string, name: string): string {
  const m = new RegExp(`export async function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  let i = src.indexOf("(", m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) break;
  }
  // The body brace is the LAST `{` on the line the signature ends on — the first can belong to an
  // inline object return type.
  const line = src.slice(i, src.indexOf("\n", i));
  const open = i + line.lastIndexOf("{");
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}" && --d === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`${name} body unbalanced`);
}

/* ═══════════ server ═══════════ */

describe("RONDE 107 — the stored percent cannot go down", () => {
  it("a progress TICK raises the stored value and never lowers it", () => {
    const body = bodyOf(DB, "updateVideoProgress");
    expect(body).toContain("GREATEST(COALESCE(");
    expect(body).toContain("videos.progressPercent");
    // The old unconditional write is gone.
    expect(body).not.toMatch(/set\(\{\s*progressStep,\s*progressPercent,/);
  });

  it("it is done in SQL, so two workers and an out-of-order poll cannot interleave into a drop", () => {
    /**
     * A read-then-write would be correct only if nothing else wrote in between. The pipeline runs
     * with multiple replicas and the SSE/poll paths both touch progress, so the guard has to be
     * part of the statement.
     */
    const body = bodyOf(DB, "updateVideoProgress");
    expect(body).toContain("sql`GREATEST(");
    expect(body).not.toContain("await getVideoById");
  });

  it("a LIFECYCLE write ratchets too, unless it means a genuine restart", () => {
    const body = bodyOf(DB, "updateVideoStatus");
    expect(body).toContain("const isNewRun = extra.generationStartedAt != null;");
    expect(body).toContain(
      'const isNotRunning = status === "queued" || status === "pending" || status === "failed";'
    );
    expect(body).toContain("isNewRun || isNotRunning");
    expect(body).toContain("GREATEST(COALESCE(");
  });

  it("a write with no percent at all is untouched — this round changed one field's rule", () => {
    const body = bodyOf(DB, "updateVideoStatus");
    expect(body).toContain("if (extra?.progressPercent == null) {");
    expect(body).toContain("await db.update(videos).set({ status, ...extra }).where(eq(videos.id, id));");
  });

  it("completion still reaches 100 — the ratchet only ever helps it", () => {
    // 100 is the maximum, so GREATEST can never hold it back. Stated because a reader will ask.
    const pipeline = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipeline).toContain("progressPercent: 100,");
  });

  it("the reason is written down where the next person will look for it", () => {
    expect(DB).toContain("RONDE 107 — a progress percent may go up, or start over. It may never slip.");
    expect(DB).toContain("a dozen places with fixed values");
  });
});

/* ═══════════ client ═══════════ */

describe("RONDE 107 — the shown percent cannot go down either", () => {
  it("the high-water mark lives outside React, so it survives a remount", () => {
    expect(BAR).toContain("const progressHighWater = new Map<string, number>();");
    // ...and is seeded from the mark rather than from the raw value.
    expect(BAR).toContain(
      "const start = key ? Math.max(progressHighWater.get(key) ?? 0, realPercent) : realPercent;"
    );
  });

  it("one place raises it, so the stored mark and the shown number cannot disagree", () => {
    expect(BAR).toContain("const raise = useCallback(");
    // Both the snap-up on a new backend value and the between-poll creep go through it.
    expect(BAR).toContain("setDisplay((d) => raise(Math.max(d, realPercent)));");
    expect(BAR).toContain("raise(Math.min(ceiling, d + 0.3))");
  });

  it("the creep still cannot fake completion", () => {
    // RONDE-era rule, unchanged: never past 99, never more than 4 ahead of the real value.
    expect(BAR).toContain("const ceiling = Math.min(99, realRef.current + 4);");
  });

  it("a RETRY starts over, because the run is part of the key", () => {
    expect(BAR).toContain("export function progressRunKey(");
    expect(BAR).toContain("const run = runStartedAt ? new Date(runStartedAt).getTime() : 0;");
    expect(BAR).toContain("return `video:${videoId}:${Number.isFinite(run) ? run : 0}`;");
  });

  it("the map is bounded, so a long-lived tab does not accumulate marks forever", () => {
    expect(BAR).toContain("const MAX_TRACKED_RUNS = 200;");
    expect(BAR).toContain("progressHighWater.size >= MAX_TRACKED_RUNS");
    expect(BAR).toContain("progressHighWater.delete(oldest)");
  });

  it("a caller without a key keeps the old per-instance behaviour", () => {
    expect(BAR).toContain("key?: string");
    expect(BAR).toContain("if (!key) return next;");
  });

  it("every place that shows a percent passes the run key", () => {
    // The badge and both bars on the dashboard...
    expect(DASHBOARD).toContain("const runKey = progressRunKey(video.id, pollData?.generationStartedAt);");
    expect(DASHBOARD.match(/progressKey=\{runKey\}/g) ?? []).toHaveLength(2);
    expect(DASHBOARD).toContain("isProcessing && rawBadgePct < 100,\n    runKey");
    /**
     * ...and the admin's bar. There were two until RONDE 147: the second belonged to the admin
     * Generate Video panel, which that round removed in favour of Discount Codes. One bar remains,
     * and it still passes a run key — which is the property this test exists for. The count is
     * asserted rather than a mere ">= 1" so that a bar added later without a run key still fails
     * here, exactly as before.
     */
    expect(ADMIN.match(/progressKey=\{/g) ?? []).toHaveLength(1);
    expect(ADMIN.match(/progressRunKey\(/g) ?? []).toHaveLength(1); // the import carries no paren
  });
});

/* ═══════════ the two halves agree ═══════════ */

describe("RONDE 107 — server and client recognise a restart the same way", () => {
  it("both key the exception on generationStartedAt", () => {
    // The server allows exactly one kind of write to lower the stored value; the client resets its
    // mark on exactly the same signal. If those two ever disagreed, a retry would either pin the
    // new run to the old number or show it dropping.
    expect(bodyOf(DB, "updateVideoStatus")).toContain("extra.generationStartedAt != null");
    expect(BAR).toContain("runStartedAt?: Date | string | null");
    expect(DASHBOARD).toContain("progressRunKey(video.id, pollData?.generationStartedAt)");
  });
});
