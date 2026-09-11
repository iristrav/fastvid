import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * SETTING YOUTUBE_ONLY_SOURCING=true DOES NOTHING ON ITS OWN, AND SAID SO NOWHERE.
 *
 * `beatPrimaryFetch` opens with `if (curatedArchiveOnlyVisuals())` and RETURNS inside that branch
 * — curated archive, then Wikimedia, then Pexels. The `if (youtubeOnlySourcingEnabled())` that
 * follows is therefore unreachable while the curated mode is on, and the curated mode is on by
 * default (`CURATED_ARCHIVE_ONLY !== "false"`).
 *
 * So an operator who turns YouTube-only on to make a film out of YouTube gets a render that
 * behaves exactly as before, with nothing anywhere saying the setting was overruled. These tests
 * pin the structure that makes that true, and the line that now reports it.
 */

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const POLICY = readFileSync(join(__dirname, "sourcingPolicy.ts"), "utf8");

describe("the conflict is real, and these are the facts behind the warning", () => {
  it("the curated branch comes FIRST in beatPrimaryFetch", () => {
    const at = PIPE.indexOf("async function beatPrimaryFetch(");
    expect(at, "beatPrimaryFetch not found").toBeGreaterThan(0);
    const curatedAt = PIPE.indexOf("if (curatedArchiveOnlyVisuals()) {", at);
    const youtubeAt = PIPE.indexOf("if (youtubeOnlySourcingEnabled()) {", at);
    expect(curatedAt).toBeGreaterThan(at);
    expect(youtubeAt, "the YouTube-only branch sits after the curated one").toBeGreaterThan(curatedAt);
  });

  it("AND IT RETURNS, so the YouTube-only branch is unreachable while it is on", () => {
    /**
     * This is the whole reason one flag silently beats the other. Every exit inside the curated
     * branch is a `return`, so control never arrives at the branch below it.
     */
    const at = PIPE.indexOf("async function beatPrimaryFetch(");
    const curatedAt = PIPE.indexOf("if (curatedArchiveOnlyVisuals()) {", at);
    const youtubeAt = PIPE.indexOf("if (youtubeOnlySourcingEnabled()) {", at);
    const branch = PIPE.slice(curatedAt, youtubeAt);
    expect(branch).toContain("if (archiveClip !== null) return archiveClip;");
    expect(branch, "the branch always leaves the function").toContain("return fetchBeatStockFallback(");
    expect(branch).toContain("return null;");
  });

  it("the curated mode is ON unless the operator turns it off", () => {
    // `!== "false"` — absent means on. That is why the conflict is the DEFAULT, not an edge case.
    expect(POLICY).toContain('return process.env.CURATED_ARCHIVE_ONLY !== "false";');
  });

  it("YouTube-only is strictly opt-in", () => {
    expect(PIPE).toContain('return youtubeSourcingEnabled() && envFlagIsOn("YOUTUBE_ONLY_SOURCING");');
  });

  it("YouTube-FIRST is switched off by the same flag", () => {
    /**
     * The second casualty of the same default: the bounded YouTube-first slice — the thing built
     * so YouTube would stop arriving at a scene with no budget left — never runs either.
     */
    expect(PIPE).toContain(
      "if (youtubeFirstEnabled() && !youtubeOnlySourcingEnabled() && !curatedArchiveOnlyVisuals()) {"
    );
    expect(POLICY).toContain('return process.env.YOUTUBE_FIRST !== "false";');
  });
});

describe("the render says a choice was overruled", () => {
  it("warns once, naming both flags and the remedy", () => {
    expect(PIPE).toContain("if (curatedArchiveOnlyVisuals() && youtubeOnlySourcingEnabled()) {");
    expect(PIPE).toContain("SOURCING_CONFLICT");
    expect(PIPE, "it names the flag that was overruled").toContain("YOUTUBE_ONLY_SOURCING=true is overruled by");
    expect(PIPE, "and the one to set").toContain("CURATED_ARCHIVE_ONLY=false as well");
  });

  it("NOTHING ABOUT WHICH MODE WINS IS CHANGED", () => {
    /**
     * The warning reports; it must not decide. Silently preferring YouTube-only here would change
     * every render that has both flags set, which is not what saying so out loud is for.
     */
    const at = PIPE.indexOf("if (curatedArchiveOnlyVisuals() && youtubeOnlySourcingEnabled()) {");
    /** Bounded at the `console.log` that prints the budget line, which is the next statement. */
    const block = PIPE.slice(at, PIPE.indexOf("console.log(", at));
    expect(block).toContain("console.warn(");
    /**
     * The flag NAMES appear inside the message text, so "contains an =" proves nothing. What must
     * be absent is a statement that changes anything: an env write, a reassignment of either mode,
     * or a call that resolves the conflict differently from `beatPrimaryFetch`.
     */
    const code = block.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code, "no assignment of any kind").not.toMatch(/[^=!<>]=[^=>]/);
    expect(code, "and nothing awaited").not.toContain("await ");
    const calls = code.match(/\b[A-Za-z_$][\w$.]*\(/g) ?? [];
    expect(
      calls.filter((c) => c !== "console.warn(" && c !== "curatedArchiveOnlyVisuals(" && c !== "youtubeOnlySourcingEnabled("),
      "it reads the two flags and prints; it calls nothing else"
    ).toEqual([]);
  });

  it("it sits beside the line that reports the winner, not per beat", () => {
    // Once per render. A per-beat warning would bury the one fact it exists to surface.
    const warnAt = PIPE.indexOf("SOURCING_CONFLICT");
    const budgetAt = PIPE.indexOf("[Pipeline] Perf budget:");
    expect(warnAt).toBeGreaterThan(0);
    expect(budgetAt).toBeGreaterThan(warnAt);
  });

  it("the winner line still resolves the conflict the way the code does", () => {
    /** curated first, then YouTube-only — the same order `beatPrimaryFetch` applies. */
    expect(PIPE).toContain(
      'sourcing=${curatedArchiveOnlyVisuals() ? "media archive only" : youtubeOnlySourcingEnabled()'
    );
  });
});
