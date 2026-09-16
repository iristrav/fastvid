/**
 * RONDE 254 — READING THIS CODEBASE AS CODE, WITHOUT THE BLIND SPOT.
 *
 * ── The hole every structural test in this repo had ─────────────────────────────────────────
 *
 * Several tests assert things about `videoPipeline.ts` by reading it as text. They all strip
 * comments first, and they all stripped them with one non-greedy regex that matches from a
 * block-comment OPENER to the next block-comment CLOSER.
 *
 * That is not a comment stripper — it is an opener-to-closer stripper, and it cannot tell whether
 * the opener it found was code. This file contains a fetch header whose Accept value ends in the
 * two characters that open a block comment, inside a STRING. The regex treats that as an opener
 * and runs to the next real closer, 3748 characters later, swallowing among other things the whole
 * declaration of `fetchPexelsClips`. A guard that cannot see 3748 characters of the file is a
 * guard a regression can sit inside.
 *
 * It was found the way these things usually are: a test asserted a signature that plainly exists
 * and got -1.
 *
 * ── The rule, and why it is enough ──────────────────────────────────────────────────────────
 *
 * A full JavaScript lexer would be the general answer and is far more than this needs. Two facts
 * about this codebase make a much smaller rule exact:
 *
 *   · every block comment in it opens at the start of a line, after nothing but whitespace;
 *   · an opener that appears mid-line is inside a string — a media type, a glob, a URL.
 *
 * So a block comment is only opened by a line-leading opener. The same reasoning covers the
 * line-comment marker: a line-leading one is a comment, and one with code before it is the pair
 * of slashes in an `https://` URL.
 *
 * Trailing `// note` after code is therefore NOT stripped. That is deliberate and it is the safe
 * direction: leaving a comment in can only make a "this shape must not appear" assertion stricter,
 * while cutting a URL in half can silently delete real code from the scan — which is exactly the
 * failure this module exists to remove.
 */

/**
 * `videoPipeline.ts` and friends with their comments removed, and nothing else removed.
 *
 * LENGTH-PRESERVING, character for character. Comment text is replaced by spaces rather than
 * deleted, so every offset into the result is the same offset into the original file. That is what
 * lets a caller find a shape here and then edit or report it THERE — a stripper that shortens the
 * text gives back positions that point at the wrong code, which is a worse failure than the one
 * this module was written to fix, because it is silent.
 */
export function stripComments(src: string): string {
  const blank = (s: string): string => " ".repeat(s.length);
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close < 0) {
        out.push(blank(line));
        continue;
      }
      inBlock = false;
      out.push(blank(line.slice(0, close + 2)) + line.slice(close + 2));
      continue;
    }
    const lead = line.match(/^\s*/)![0].length;
    const rest = line.slice(lead);
    /** Line-leading only. An opener anywhere else on this line is inside a string. */
    if (rest.startsWith("/*")) {
      const close = line.indexOf("*/", lead + 2);
      if (close < 0) {
        inBlock = true;
        out.push(blank(line));
        continue;
      }
      out.push(blank(line.slice(0, close + 2)) + line.slice(close + 2));
      continue;
    }
    /** A line-leading line comment. One with code before it belongs to a URL. */
    if (rest.startsWith("//")) {
      out.push(blank(line));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Every call to `name(` in the stripped source, excluding the declaration itself.
 *
 * Returned as offsets into the string the caller passed, so a caller can slice its own window
 * around each one and ask whatever it needs to ask about it.
 */
export function callSitesOf(code: string, name: string): number[] {
  const out: number[] = [];
  for (const m of code.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!);
    if (/\bfunction\s+$/.test(before)) continue;
    out.push(m.index!);
  }
  return out;
}

/** 1-indexed line number of an offset, for a failure message someone has to act on. */
export function lineOf(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length;
}
