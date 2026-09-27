/**
 * THE JUDGE ANSWERED, AND THE ANSWER WENT IN THE WRONG DRAWER.
 *
 * ── What eight renders measured ─────────────────────────────────────────────────────────────
 *
 *     [BeatVisual] … verification=never_asked reason=real_footage_never_judged source=rescue_archive
 *
 * 79 of those lines across 8 render logs, and `rescue_archive` — the guaranteed ladder's topical
 * rung — accounts for 49 of them:
 *
 *     rescue_archive 49   archive 14   internet_archive 6
 *     subject_fallback 4  rescue_stock 4   wikimedia 2
 *
 * Read literally the line says the picture editor was never asked. That is not what happened.
 * `generateGuaranteedBeatClip` judges every clip it returns, and all thirteen of its call sites
 * pass the context needed to do it — both facts checked rather than assumed, after two earlier
 * guesses about this same function turned out to be wrong.
 *
 * ── The actual fault ────────────────────────────────────────────────────────────────────────
 *
 * It filed the verdict under `slotIndex`. A slot is a FETCH position, and six call sites
 * deliberately offset it away from the real beat:
 *
 *     2000 + slot                 keeps a synthetic entry from colliding with a genuine one
 *     beat.index + attempt * 100  keeps retries apart
 *     si, where the beat is       slotBeatIndex
 *
 * Every one of those then records the ADOPTION under the real beat. So the verdict sat on the slot
 * number and `verificationForBeat`, which looks by (scene, beat), found nothing and said
 * `never_asked`.
 *
 * ── Why this is worse than never asking ─────────────────────────────────────────────────────
 *
 * A refusal filed under slot 2000+n cannot stop an adoption recorded under beat n. The gate
 * looked, said the picture did not belong, and the pipeline used it anyway — not because it
 * overruled the judge, but because it could not find an answer that already existed.
 *
 * ── The rule is not new ─────────────────────────────────────────────────────────────────────
 *
 * RONDE 34 wrote it on the adopt side, in a comment sitting directly above one of these very call
 * sites: "record the beat this slot was fetched FOR, not the slot number — the audit is read back
 * as a clip->beat mapping." It was applied to one of the two records and forgotten on the other.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
/** Claims below are about executable code, not the comments that quote the defect. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/** The balanced argument list of one call, from the position of its name. */
function argsAt(src: string, at: number): string {
  const open = src.indexOf("(", at);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open + 1, i);
}

/** Every call to the ladder, excluding its own declaration. */
function ladderCalls(src: string): string[] {
  const out: string[] = [];
  const re = /generateGuaranteedBeatClip\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 40), m.index).trimEnd();
    if (before.endsWith("export async function")) continue;
    out.push(argsAt(src, m.index));
  }
  return out;
}

/* ═══════════════════════ what the lookup does with it ═══════════════════════ */

describe("the lookup that reported never_asked", () => {
  const STATUS = fs
    .readFileSync(path.join(__dirname, "beatVisualStatus.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * Unchanged on purpose. It looks by (scene, beat) and that is correct — the fault was upstream,
   * in what got filed. Loosening this to find a verdict under any index would have hidden the bug
   * instead of fixing it, and would let one beat's verdict answer for another.
   */
  it("still looks by scene and beat, and was not relaxed to paper over this", () => {
    const at = STATUS.indexOf("function verificationForBeat(");
    expect(at).toBeGreaterThan(-1);
    const body = STATUS.slice(at, at + 900);
    expect(body).toContain("if (ctx.sceneIndex !== sceneIndex || ctx.beatIndex !== beatIndex) continue;");
    expect(body, "the lookup now accepts a verdict from any beat").not.toMatch(
      /ctx\.beatIndex !== beatIndex\s*\)\s*\{?\s*\}/
    );
  });

  /**
   * And still says never_asked when there genuinely is nothing — that answer stays available.
   *
   * ── Why this assertion changed shape in RONDE 117 ───────────────────────────────────────
   *
   * It used to match the literal `return onThisBeat ?? "never_asked";`. RONDE 117 added a third
   * step after the beat scan — the ledger's `byContentKey` index, for a verdict filed under a
   * FETCH SLOT rather than a beat — so that one line became two returns. Keeping the old string
   * alive would have meant writing an unreachable statement to satisfy a match, which is the
   * test-shaping this file exists to prevent.
   *
   * The PROPERTY is unchanged and is asserted twice over: the beat scan still runs first and its
   * answer still wins (the ordering below), and `never_asked` is still what comes back when
   * nothing was recorded — proven behaviourally, not by spelling, in
   * `ronde117VerdictFiledUnderASlot.test.ts` ("no verdict anywhere is still never_asked").
   */
  it("still reports never_asked when no verdict exists at all", () => {
    const at = STATUS.indexOf("function verificationForBeat(");
    const body = STATUS.slice(at, at + 900);
    expect(body).toContain('return "never_asked";');
    /** The beat's own answer is returned BEFORE the asset index is consulted. */
    const beatAnswer = body.indexOf("if (onThisBeat) return onThisBeat;");
    const assetLookup = body.indexOf("ledger.byContentKey.get(");
    expect(beatAnswer).toBeGreaterThan(-1);
    expect(assetLookup).toBeGreaterThan(beatAnswer);
  });
});
