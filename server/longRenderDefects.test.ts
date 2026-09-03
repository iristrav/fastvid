/**
 * TWO DEFECTS THAT ONLY A LONG FILM COULD FIND.
 *
 * ── Why they survived 7,478 tests ───────────────────────────────────────────────────────────
 *
 * The longest render anywhere in this suite was R182's TWELVE SECONDS: three shots, two dissolves,
 * no hard cut between them, no audio track. Everything this codebase had proven about its own
 * renderer, it had proven on that film.
 *
 * §42 asked for a render at the length the product actually sells. The first attempt at nine
 * minutes did not produce a degraded video; it produced a ZERO-BYTE FILE, and the second attempt
 * produced a film with no sound at all that passed the A/V check reporting `ok=true no findings`.
 *
 * ── 1. `concat` and `xfade` cannot share a chain ────────────────────────────────────────────
 *
 * `buildTransitionGraph` joins segments with `xfade` where the planner asked for a dissolve and
 * `concat` where it asked for a cut. `concat` emits on AV_TIME_BASE (1/1000000); a raw decoded
 * input arrives on its stream's own timebase (1/12800 at 25fps). `xfade` refuses two inputs whose
 * timebases differ:
 *
 *     First input link main timebase (1/1000000) do not match
 *     the corresponding second input link xfade timebase (1/12800)
 *     Nothing was written into output file
 *
 * So a hard cut followed anywhere later by a dissolve killed the render outright. That combination
 * needs three shots with a cut before a dissolve — it cannot happen in a two-transition film, and
 * it happens in the first thirty seconds of any real documentary.
 *
 * ── 2. `-select_streams` does not filter `format` ───────────────────────────────────────────
 *
 * `streamDuration` falls back to the container's duration when a stream carries none of its own,
 * which is right. It asked for it with `-select_streams a:0 -show_entries format=duration`, on the
 * assumption that the selector would return nothing when there is no audio. It does not:
 * `-select_streams` filters STREAM entries only, so on a video-only file that query returns the
 * container's duration and the audio was recorded as exactly as long as the picture.
 *
 * `no_audio` — the one finding a viewer notices within a second — could therefore never fire.
 */
import { describe, expect, it } from "vitest";

import { buildTransitionGraph } from "./timelineFilters";
import { checkAvSync } from "./avSyncCheck";

/* ═══════════════════════ 1. every link on one timebase ═══════════════════════ */

const dissolve = { kind: "dissolve", durationSec: 0.5 };
const cut = { kind: "hard_cut" };

describe("the transition graph puts every input on one timebase", () => {
  it("normalises each input before anything joins it", () => {
    const g = buildTransitionGraph({
      durations: [3, 3, 3],
      transitions: [cut, dissolve, dissolve],
    })!;
    expect(g.filter).toContain("[0:v]settb=AVTB[t0]");
    expect(g.filter).toContain("[1:v]settb=AVTB[t1]");
    expect(g.filter).toContain("[2:v]settb=AVTB[t2]");
  });

  /**
   * The shape that produced a zero-byte file: a cut, then a dissolve. The dissolve's first input is
   * the concat's output and its second is a raw input, and those two disagreed.
   */
  it("a cut followed by a dissolve reaches xfade with both inputs normalised", () => {
    const g = buildTransitionGraph({
      durations: [3, 3, 3],
      transitions: [cut, cut, dissolve],
    })!;
    expect(g.filter).toContain("concat=n=2:v=1:a=0[v1]");
    // The xfade's second input is the normalised label, never the raw stream.
    expect(g.filter).toMatch(/\[v1\]\[t2\]xfade=/);
    expect(g.filter).not.toMatch(/\]\[2:v\]xfade=/);
  });

  /** No join anywhere may take a raw `N:v` — that is precisely the mismatch. */
  it("no join reads a raw input directly", () => {
    const g = buildTransitionGraph({
      durations: [2, 2, 2, 2, 2, 2, 2, 2],
      transitions: [cut, dissolve, cut, cut, dissolve, cut, dissolve, cut],
    })!;
    const joins = g.filter.split(";").filter((s) => s.includes("xfade=") || s.includes("concat="));
    expect(joins.length).toBe(7);
    for (const step of joins) {
      expect(step, `${step} takes a raw input`).not.toMatch(/\[\d+:v\]/);
    }
  });

  /**
   * The normalisation is metadata only, so the arithmetic this graph exists for must be untouched:
   * each dissolve still overlaps its neighbours and each cut still does not.
   */
  it("does not change the length the graph reports", () => {
    expect(
      buildTransitionGraph({ durations: [4, 4, 4], transitions: [cut, dissolve, cut] })!.totalSec
    ).toBeCloseTo(4 + 4 - 0.5 + 4, 3);
    expect(
      buildTransitionGraph({ durations: [4, 4, 4], transitions: [cut, cut, cut] })
    ).toBeNull();
  });

  /** A film of pure cuts still takes the stream-copy path rather than building a graph at all. */
  it("still refuses to build a graph for a film with no transition in it", () => {
    expect(buildTransitionGraph({ durations: [3, 3, 3], transitions: [cut, cut, cut] })).toBeNull();
  });

  /**
   * Normalising unconditionally is the point. A version that only normalised "where a concat is
   * involved" would be a rule about which joins a planner may combine, kept somewhere nobody would
   * look, and getting it wrong costs the whole render.
   */
  it("normalises even when every join is a dissolve", () => {
    const g = buildTransitionGraph({
      durations: [3, 3],
      transitions: [dissolve, dissolve],
    })!;
    expect(g.filter).toContain("[0:v]settb=AVTB[t0]");
    expect(g.filter).toContain("[1:v]settb=AVTB[t1]");
  });
});

/* ═══════════════════════ 2. a film with no sound says so ═══════════════════════ */

describe("a film with no audio is reported as having no audio", () => {
  it("names it, rather than reporting a healthy file", () => {
    const r = checkAvSync({ videoSec: 540, audioSec: null, firstSoundSec: null, lastSoundSec: null });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("no_audio");
  });

  /**
   * The exact shape the bug produced: the container's duration returned for an absent stream, so
   * the audio measured EQUAL to the picture and every check agreed the film was fine.
   */
  it("an audio length equal to the picture is not by itself proof of sound", () => {
    const asIfBugged = checkAvSync({
      videoSec: 540, audioSec: 540, firstSoundSec: null, lastSoundSec: null,
    });
    expect(asIfBugged.findings.map((f) => f.code)).not.toContain("no_audio");
    // …which is why the measurement, not the judge, had to be fixed. See streamDuration.
  });

  /** The fallback still exists for its real case: a stream that is present and carries no duration. */
  it("asks whether the stream exists before falling back to the container", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src = fs.readFileSync(path.join(__dirname, "avSyncCheck.ts"), "utf8");
    const at = src.indexOf("async function streamDuration(");
    expect(at).toBeGreaterThan(-1);
    /** To the function's own closing brace — the first `}` in column 0 after it. */
    const body = src.slice(at, src.indexOf("\n}", at));
    /**
     * Read from the ffprobe invocations, not from the file text: the comment above the fix quotes
     * both queries while explaining them, so a plain `indexOf` compares prose to code and finds the
     * explanation before the thing it explains.
     */
    const queries = body
      .split("exec(")
      .slice(1)
      // Each call's argument list, up to its timeout — the template literal is written across
      // several concatenated lines, so the backticks and the `+` joins are collapsed away first.
      .map((chunk) => chunk.slice(0, chunk.indexOf("{ timeout")).replace(/`\s*\+\s*`/g, "")
        .replace(/\s+/g, " "));
    expect(queries).toHaveLength(3);
    expect(queries[0], "the per-stream duration is still asked for first").toContain(
      "-show_entries stream=duration"
    );
    expect(queries[1], "the existence probe must precede the fallback").toContain(
      "-show_entries stream=index"
    );
    expect(queries[2], "the fallback is the container's own duration").toContain(
      "-show_entries format=duration"
    );
    // And it no longer pretends `-select_streams` narrows a format query.
    expect(queries[2]).not.toContain("-select_streams");
  });
});
