/**
 * EVERY WALL A YOUTUBE TURN OPENS UNDER — RONDE 622.
 *
 * ── What render 598 measured, on the deploy carrying every fix of that session ───────────────
 *
 *     [YouTube] TURN_DECLINED scene=0 — 20s left and a turn costs 24s
 *         clock="b0_fastyt-first s0 b0" granted=20s
 *
 * Eleven beats, one number: `granted=20s`, every time. Render 597 printed the identical figure
 * many rounds earlier. That repetition is the tell — a clock clamped by traffic varies, and this
 * one never did, because it was not traffic. It was a literal:
 *
 *     const primaryMs = historicalDoc ? 15_000 : 20_000;   // wraps beatPrimaryFetch
 *
 * `beatPrimaryFetch` opens the YouTube turn on that route, and a turn costs YOUTUBE_MIN_TURN_MS —
 * one 12s search plus the 12s download floor. Twenty is less than twenty-four; fifteen is less
 * still. The door refused every turn on that route, correctly, for a window nobody meant to
 * withhold, and no render on that path has ever searched YouTube.
 *
 * ── AND IT WAS NOT THE ONLY ONE, WHICH IS THE POINT OF THIS FILE ────────────────────────────
 *
 * RONDE 615 declared this closed after building the nest in a test and reading 55s at the
 * innermost point. That nest was assembled from the layers I believed production used; production
 * takes another route. A reconstruction can only ever prove something about itself.
 *
 * So this file does not reconstruct. It reads the pipeline source, finds every
 * `withSceneFetchTimeout` scope, walks the call graph from each one, and asserts that every scope
 * which can reach `runCentralYoutubeTurn` sizes itself with `beatWallWithYoutubeTurn`. Walking the
 * graph is what found the two the measurement had not reached yet:
 *
 *     Scene N pre-compose recovery        20s   -> recoverSceneClipsIfEmptyInner -> beatPrimaryFetch
 *     Scene N pre-compose strict refill   25s   -> refillSceneStrictVoiceMatch  -> the same
 *
 * The first can never pay. The second clears the price by one second and so cannot survive a
 * second of its own work. Nine other narrow scopes in the same file — Pexels, Wikimedia,
 * Openverse, the celebrity fetcher, ffmpeg — cannot host a turn at all and are left alone.
 *
 * ── What did NOT change ─────────────────────────────────────────────────────────────────────
 *
 * No base number moves: the three walls still spend 15s, 20s and 25s on their own work. The
 * supplement is `YOUTUBE_TURN_WINDOW_MS` and is zero when there is no YouTube to budget for, so a
 * build without a key keeps every wall to the millisecond. RONDE 600 wrote that helper for exactly
 * this: the turn's window is ADDED rather than carved out, so the cascade loses nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  YOUTUBE_MIN_TURN_MS,
  YOUTUBE_TURN_WINDOW_MS,
  affordsYoutubeTurn,
  beatWallWithYoutubeTurn,
} from "./videoPipeline";

const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const LINES = SRC.split("\n");

const withYoutube = <T>(fn: () => T): T => {
  const saved = { ...process.env };
  try {
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    process.env.YOUTUBE_API_KEY = "test-key-present";
    process.env.YOUTUBE_CC_DL_SERVICE = "https://example.invalid/dl";
    delete process.env.YOUTUBE_ONLY_SOURCING;
    return fn();
  } finally {
    process.env = saved;
  }
};

/* ═══════════ §1 — render 598's own numbers ═══════════ */

describe("§1 — the wall that could never pay", () => {
  /** The literal that produced `granted=20s`, and the historical-documentary case beneath it. */
  const R598_GRANTED_MS = 20_000;
  const HISTORICAL_DOC_MS = 15_000;

  it("THE DEFECT: neither base could ever afford a turn", () => {
    expect(affordsYoutubeTurn(R598_GRANTED_MS, YOUTUBE_MIN_TURN_MS)).toBe(false);
    expect(affordsYoutubeTurn(HISTORICAL_DOC_MS, YOUTUBE_MIN_TURN_MS)).toBe(false);
  });

  it("THE REPAIR: both clear the price once the turn's own window is added", () => {
    withYoutube(() => {
      for (const base of [HISTORICAL_DOC_MS, R598_GRANTED_MS, 25_000]) {
        expect(
          affordsYoutubeTurn(beatWallWithYoutubeTurn(base), YOUTUBE_MIN_TURN_MS),
          `a wall of ${base}ms still cannot pay`
        ).toBe(true);
      }
    });
  });

  it("and a build without YouTube keeps every base to the millisecond", () => {
    const saved = { ...process.env };
    try {
      delete process.env.YOUTUBE_API_KEY;
      delete process.env.YOUTUBE_ONLY_SOURCING;
      for (const base of [15_000, 20_000, 25_000]) {
        expect(beatWallWithYoutubeTurn(base)).toBe(base);
      }
    } finally {
      process.env = saved;
    }
  });

  it("the base numbers themselves did not move", () => {
    expect(SRC).toContain("beatWallWithYoutubeTurn(historicalDoc ? 15_000 : 20_000)");
    expect(SRC).toContain("? 25_000\n          : 45_000");
    expect(SRC).toContain("? 20_000\n          : 35_000");
  });
});

/* ═══════════ §2 — THE CLAIM THAT MATTERS: no fourth wall ═══════════ */

describe("§2 — every scope that can reach a turn is sized for one", () => {
  /** Top-level function bodies, so the call graph can be walked from any entry point. */
  const bodies = (() => {
    const FN = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/;
    const starts: Array<[number, string]> = [];
    LINES.forEach((l, i) => {
      const m = FN.exec(l);
      if (m) starts.push([i, m[1]!]);
    });
    const out = new Map<string, string>();
    starts.forEach(([i, name], k) => {
      const end = k + 1 < starts.length ? starts[k + 1]![0] : LINES.length;
      out.set(name, LINES.slice(i, end).join("\n"));
    });
    return out;
  })();

  /** Does this function, or anything it calls, open a YouTube turn? */
  const reachesTurn = (entry: string, seen = new Set<string>(), depth = 0): boolean => {
    if (depth > 12 || seen.has(entry)) return false;
    seen.add(entry);
    const body = bodies.get(entry);
    if (!body) return false;
    if (body.includes("runCentralYoutubeTurn({")) return true;
    for (const m of new Set(body.match(/\b[a-zA-Z][A-Za-z0-9_]{4,}(?=\s*\()/g) ?? [])) {
      if (bodies.has(m) && !seen.has(m) && reachesTurn(m, seen, depth + 1)) return true;
    }
    return false;
  };

  /**
   * Every `withSceneFetchTimeout`, with its ms argument read by BALANCED PARENS rather than by a
   * fixed window — the first draft of this test used a fourteen-line slice and reported nine false
   * offenders, every one of them a wall that was already correct behind a variable or a doc
   * comment. A check that cries wolf is a check nobody reads.
   *
   * One level of indirection is resolved: `const wallMs = beatWallWithYoutubeTurn(...)` a few
   * lines above is how most of these walls are actually written.
   */
  const argsOf = (start: number): string[] => {
    const open = SRC.indexOf("(", start);
    let depth = 0;
    const args: string[] = [];
    let cur = "";
    for (let i = open; i < SRC.length; i++) {
      const c = SRC[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          args.push(cur);
          break;
        }
      }
      if (depth === 1 && c === ",") {
        args.push(cur);
        cur = "";
        continue;
      }
      if (!(depth === 1 && cur === "" && /\s/.test(c))) cur += c;
    }
    return args.map((a) => a.trim());
  };

  const resolve = (expr: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) return expr;
    const decl = new RegExp(`const ${expr}\\s*=\\s*([^;]+);`).exec(SRC);
    return decl ? `${expr} = ${decl[1]}` : expr;
  };

  const scopes = (() => {
    const found: Array<{ line: number; callee: string; ms: string }> = [];
    let from = 0;
    for (;;) {
      const at = SRC.indexOf("withSceneFetchTimeout(", from);
      if (at < 0) break;
      from = at + 1;
      const args = argsOf(at);
      if (args.length < 2) continue;
      const callee = /(?:\(\)\s*=>\s*)?([A-Za-z0-9_]+)\s*\(/.exec(args[0] ?? "")?.[1];
      if (!callee) continue;
      found.push({
        line: SRC.slice(0, at).split("\n").length,
        callee,
        ms: resolve(args[1] ?? ""),
      });
    }
    return found;
  })();

  it("the walker finds the scopes it is meant to — a silent zero would prove nothing", () => {
    expect(scopes.length, "no withSceneFetchTimeout scopes were parsed").toBeGreaterThan(20);
    expect(bodies.size, "no function bodies were parsed").toBeGreaterThan(200);
    /** And it can tell the two apart: one route reaches a turn, one plainly cannot. */
    expect(reachesTurn("beatPrimaryFetch"), "beatPrimaryFetch must reach a turn").toBe(true);
    expect(reachesTurn("fetchOpenverseImages"), "Openverse must not").toBe(false);
  });

  /**
   * WHAT THIS CHECK COVERS, STATED SO IT IS NOT MISTAKEN FOR MORE.
   *
   * It flags a scope that can host a turn and is sized by a HAND-WRITTEN NUMBER below the price.
   * That is precisely the defect class this round found three times — `20_000`, `15_000`, `25_000`
   * typed into a call — and precisely what no reviewer spots by eye in a 52,000-line file.
   *
   * A scope sized by a named budget function carries no literal here and is not flagged; what that
   * function returns is its own business and its own test. Naming those functions in a whitelist
   * would be the weaker check: a whitelist forgives by name, and this forgives only an absence of
   * numbers.
   */
  it("NO SCOPE THAT CAN HOST A TURN IS SIZED BY A LITERAL BELOW THE PRICE", () => {
    const offenders: string[] = [];
    for (const s of scopes) {
      if (!reachesTurn(s.callee)) continue;
      /** The helper adds the turn's window, so a small base under it is correct by construction. */
      const outsideHelper = s.ms.replace(/beatWallWithYoutubeTurn\([\s\S]*\)/g, "");
      for (const lit of outsideHelper.match(/\b\d{1,3}(?:_\d{3})+\b/g) ?? []) {
        const ms = Number(lit.replace(/_/g, ""));
        if (ms < YOUTUBE_MIN_TURN_MS) {
          offenders.push(`line ${s.line}: ${s.callee} sized ${lit} (< ${YOUTUBE_MIN_TURN_MS})`);
        }
      }
    }
    expect(
      offenders,
      "a wall a YouTube turn opens under is narrower than the turn costs"
    ).toEqual([]);
  });

  it("AND THE CHECK CATCHES ONE — a literal below the price is not silently tolerated", () => {
    /** Without this, the assertion above could pass by finding nothing at all. */
    const sample = "beatWallWithYoutubeTurn(20_000)".replace(/beatWallWithYoutubeTurn\([\s\S]*\)/g, "");
    expect(sample, "the helper must hide its own base").toBe("");
    const bare = "historicalDoc ? 15_000 : 20_000";
    const found = (bare.match(/\b\d{1,3}(?:_\d{3})+\b/g) ?? []).map((l) => Number(l.replace(/_/g, "")));
    expect(found.some((n) => n < YOUTUBE_MIN_TURN_MS), "a bare literal must be seen").toBe(true);
  });

  it("the three this round repaired are among the scopes the walker sees", () => {
    const repaired = scopes.filter(
      (s) => s.ms.includes("beatWallWithYoutubeTurn(") && reachesTurn(s.callee)
    );
    expect(repaired.length, "the repaired walls are no longer recognised").toBeGreaterThanOrEqual(3);
  });
});

/* ═══════════ §3 — the helper is still the single answer ═══════════ */

describe("§3 — one addition, one place", () => {
  it("no wall adds the turn window by hand", () => {
    expect(SRC.match(/\+\s*YOUTUBE_TURN_WINDOW_MS/g) ?? []).toHaveLength(0);
  });

  it("and the supplement is the turn's own window, unchanged", () => {
    withYoutube(() => {
      expect(beatWallWithYoutubeTurn(0)).toBe(YOUTUBE_TURN_WINDOW_MS);
    });
  });

  it("THE PRICE DID NOT MOVE — this round widened walls, it did not cheapen turns", () => {
    expect(SRC).toContain(
      "export const YOUTUBE_MIN_TURN_MS = YOUTUBE_SEARCH_TIMEOUT_MS + YOUTUBE_MIN_DOWNLOAD_WINDOW_MS;"
    );
  });
});
