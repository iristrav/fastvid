/**
 * A CLAIM THAT CANNOT BE PROVEN IS NOT A CLAIM — RONDE 607.
 *
 * ── What render 597 did ─────────────────────────────────────────────────────────────────────
 *
 *   07:57:31  [RenderJob] job=17 video=597 attempt=2 status=failed
 *             RENDER_FAILED — transition graph: Error while processing the decoded data for
 *             stream #10:0
 *             [DeliveryGate] DELIVERY_GATE_FAIL video=597 AUTHORITATIVE_RENDER_FAILED
 *
 *   07:57:43  [DeliveryGate] DELIVERY_GATE_PASS video=597 clips=11 route=cinematic_timeline
 *   07:57:47  [RenderJob] job=17 video=597 attempt=2 status=completed published=true
 *             output=edits/render_17_b695d79b.mp4 duration=61.14s
 *
 * One job row, one attempt number, sixteen seconds apart, failed and then completed. Two renders
 * ran on job 17 — and a full render cannot start and finish in sixteen seconds, so the second was
 * already in flight when the first died.
 *
 * ── The cause, and it is the programme's usual shape ────────────────────────────────────────
 *
 * `claimQueuedRenderJob` is a conditional UPDATE `queued → running`. MySQL does let exactly one
 * caller win it. The count that says who won was read as:
 *
 *     (result as { rowsAffected?: number })?.rowsAffected
 *
 * `rowsAffected` is libSQL's spelling, on the tuple. This process runs `drizzle-orm/mysql2`, which
 * returns `[ResultSetHeader, FieldPacket[]]` and spells it `affectedRows` on element ZERO. So the
 * read was `undefined` on every call, the `typeof affected === "number"` guard never fired, and
 * the function fell through to:
 *
 *     return job && job.status === "running" ? job : null;
 *
 * which is TRUE FOR THE LOSER TOO — it is reading the winner's own write, one millisecond old. The
 * database answered the question correctly and the answer never reached the code that decided.
 *
 * The same misread sat on `saveVideoTimeline`, `publishEditedVideo` and an operator reset counter.
 * Ten other call sites in this file read `[0].affectedRows` correctly, and a comment beside one of
 * them has stated the right form all along.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { affectedRowCount } from "./db";

const DB = readFileSync(join(__dirname, "db.ts"), "utf8");
const ROUTERS = readFileSync(join(__dirname, "routers.ts"), "utf8");

/** What `drizzle-orm/mysql2` actually hands back from `.update()`. */
const mysql2Result = (affectedRows: number) => [
  { fieldCount: 0, affectedRows, insertId: 0, info: "", serverStatus: 2, warningStatus: 0 },
  undefined,
];

/* ═══════════ §1 — the count, read under both spellings ═══════════ */

describe("§1 — affectedRowCount", () => {
  it("reads mysql2's shape: affectedRows on element zero", () => {
    expect(affectedRowCount(mysql2Result(1))).toBe(1);
    expect(affectedRowCount(mysql2Result(0))).toBe(0);
  });

  it("THE LOSER'S RESULT IS ZERO, AND ZERO IS NOT UNKNOWN", () => {
    /** The distinction the old code could not make. Both used to arrive as `undefined`. */
    expect(affectedRowCount(mysql2Result(0))).toBe(0);
    expect(affectedRowCount(mysql2Result(0))).not.toBeNull();
  });

  it("still reads libSQL's spelling, so a driver swap does not silently unlock everything", () => {
    expect(affectedRowCount({ rowsAffected: 1 })).toBe(1);
    expect(affectedRowCount({ rowsAffected: 0 })).toBe(0);
    expect(affectedRowCount([{ rowsAffected: 3 }])).toBe(3);
  });

  it("a driver that reports nothing is UNKNOWN — never zero, never success", () => {
    expect(affectedRowCount(undefined)).toBeNull();
    expect(affectedRowCount({})).toBeNull();
    expect(affectedRowCount([{}])).toBeNull();
    expect(affectedRowCount([{ affectedRows: "1" }]), "a string is not a count").toBeNull();
    expect(affectedRowCount([{ affectedRows: NaN }]), "NaN is not a count").toBeNull();
  });

  it("THE OLD READ, RUN AGAINST THE REAL SHAPE — this is the whole defect in one line", () => {
    const result = mysql2Result(0);
    const old = (result as unknown as { rowsAffected?: number })?.rowsAffected;
    expect(old, "if this is ever a number again, the misread was not the bug").toBeUndefined();
    expect(typeof old === "number" && old === 0, "the guard the loser walked past").toBe(false);
    expect(affectedRowCount(result), "and what it should have said").toBe(0);
  });
});

/* ═══════════ §2 — the claim fails closed ═══════════ */

describe("§2 — claimQueuedRenderJob", () => {
  const body = (() => {
    const at = DB.indexOf("export async function claimQueuedRenderJob(");
    return DB.slice(at, DB.indexOf("\n}", at));
  })();

  it("decides on the count, not on a re-read of the row's status", () => {
    expect(body).toContain("const affected = affectedRowCount(result);");
    expect(body, "the misread came back").not.toContain("})?.rowsAffected");
  });

  it("THE RE-READ NO LONGER DECIDES ANYTHING — it cannot tell a win from a loss", () => {
    /**
     * `job.status === "running"` is still there, as a sanity check AFTER the count has already
     * said this caller won. What must never return again is a path that reaches it without a
     * proven count, because the loser's row is running too.
     */
    const countAt = body.indexOf("const affected = affectedRowCount(result);");
    const rereadAt = body.indexOf("await getRenderJobById(jobId)");
    expect(countAt).toBeGreaterThan(-1);
    expect(rereadAt, "the row is read before the count is known").toBeGreaterThan(countAt);
  });

  it("an unknown count LOSES, loudly", () => {
    expect(body).toContain("if (affected == null) {");
    expect(body).toContain("CLAIM_UNPROVABLE");
    const unknownAt = body.indexOf("if (affected == null) {");
    const zeroAt = body.indexOf("if (affected === 0) return null;");
    expect(zeroAt).toBeGreaterThan(unknownAt);
    const branch = body.slice(unknownAt, zeroAt);
    expect(branch, "an unprovable claim must not be granted").toContain("return null;");
  });

  it("and zero still loses", () => {
    expect(body).toContain("if (affected === 0) return null;");
  });
});

/* ═══════════ §3 — both callers already handle losing ═══════════ */

describe("§3 — failing closed costs a render nothing", () => {
  it("the pipeline delivers the compose montage and says why", () => {
    const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = PIPELINE.indexOf("const claimed = await claimQueuedRenderJob(");
    expect(at).toBeGreaterThan(-1);
    const after = PIPELINE.slice(at, at + 400);
    expect(after).toContain("if (!claimed) {");
    expect(after, "a lost claim must set a stated refusal").toContain("cinematicRefusal =");
  });

  it("the poll loop moves to the next job", () => {
    const WORKER = readFileSync(join(__dirname, "renderJobWorker.ts"), "utf8");
    const at = WORKER.indexOf("const claimed = await claimQueuedRenderJob(queued[0]!.id);");
    expect(at).toBeGreaterThan(-1);
    expect(WORKER.slice(at, at + 200)).toContain("if (!claimed) continue;");
  });
});

/* ═══════════ §4 — the other three misreads ═══════════ */

describe("§4 — no production code reads the wrong spelling any more", () => {
  it("db.ts has exactly one reader, and it is the helper", () => {
    /**
     * Comments may name the old spelling — that is the record of what went wrong. What must not
     * come back is a CAST that reads it off a result.
     */
    const casts = [...DB.matchAll(/as unknown as \{\s*rowsAffected/g)];
    expect(casts, "a second reader of the libSQL spelling grew back").toHaveLength(0);
    expect(DB.split("export function affectedRowCount(").length - 1).toBe(1);
  });

  it("saveVideoTimeline and publishEditedVideo read the count first, re-read only as fallback", () => {
    for (const fn of ["saveVideoTimeline", "publishEditedVideo"]) {
      const at = DB.indexOf(`export async function ${fn}(`);
      const fnBody = DB.slice(at, DB.indexOf("\n}", DB.indexOf("return", at + 400)));
      expect(fnBody, `${fn} does not use the shared reader`).toContain(
        "const affected = affectedRowCount(result);"
      );
      expect(fnBody, `${fn} still has the misread`).not.toContain("})?.rowsAffected");
    }
  });

  it("and the operator reset counter no longer always reports zero", () => {
    expect(ROUTERS).toContain("affectedRowCount(result) ?? 0");
    expect(ROUTERS).not.toContain("(result as { rowsAffected?: number }).rowsAffected");
  });

  it("affectedOne — the render lock — turns on the same arithmetic", () => {
    const at = DB.indexOf("function affectedOne(result: unknown): boolean {");
    const fnBody = DB.slice(at, DB.indexOf("\n}", at));
    expect(fnBody).toContain("affectedRowCount(result)");
    expect(fnBody, "an unknown count must not read as a held lock").toContain("affected != null");
  });
});
