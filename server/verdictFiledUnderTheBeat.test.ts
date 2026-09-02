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

/* ═══════════════════════ the ladder files under the beat it is told ═══════════════════════ */

describe("the guaranteed ladder files its verdict under the beat, not the slot", () => {
  /** The parameter that lets a caller say which beat the picture is actually for. */
  it("accepts the beat index from its caller", () => {
    const at = CODE.indexOf("export async function generateGuaranteedBeatClip(");
    expect(at, "the ladder has moved").toBeGreaterThan(-1);
    expect(argsAt(CODE, at), "the relevance object cannot carry a beat index").toContain(
      "beatIndex?: number"
    );
  });

  /**
   * Both the judge call and the context it builds. Filing under the beat and then describing the
   * slot would leave the ledger's key and its contents disagreeing about which beat this is.
   */
  it("uses it for the judgement AND for the context", () => {
    const at = CODE.indexOf("export async function generateGuaranteedBeatClip(");
    const body = CODE.slice(at, at + 3000);
    expect(body).toContain("const verdictBeatIndex = relevance.beatIndex ?? slotIndex;");
    expect(body, "the judgement is still filed under the fetch slot").toContain(
      "judgeBeatClipRelevance(relevance.dedup, sceneIndex, verdictBeatIndex,"
    );
    expect(body, "the context still describes the fetch slot").toContain(
      "beatIndex: verdictBeatIndex,"
    );
    expect(
      body,
      "a bare slotIndex is still being filed as a beat somewhere in this function"
    ).not.toContain("beatIndex: slotIndex,");
  });

  /** Absent means "the slot IS the beat", which is true of the seven sites that already matched. */
  it("falls back to the slot when the caller says nothing", () => {
    const at = CODE.indexOf("export async function generateGuaranteedBeatClip(");
    expect(CODE.slice(at, at + 3000)).toContain("relevance.beatIndex ?? slotIndex");
  });
});

/* ═══════════════════════ every offsetting call site says so ═══════════════════════ */

describe("a call site that offsets the slot declares the real beat", () => {
  /**
   * THE MEASUREMENT THIS ROUND RESTS ON. Any call whose slot argument is an EXPRESSION rather than
   * a plain variable is offsetting the slot away from the beat — and must then say which beat it
   * means, or the verdict lands in a drawer nothing opens.
   *
   * Written as a rule over all thirteen calls rather than as six pinned line numbers, so a
   * fourteenth caller inventing a new offset fails this instead of shipping another silent
   * `never_asked`.
   */
  it("no call offsets its slot without naming the beat", () => {
    const offenders: string[] = [];
    for (const args of ladderCalls(CODE)) {
      const slot = args.split(",")[1]?.trim() ?? "";
      const offsets = /[+\-*]/.test(slot);
      if (offsets && !args.includes("beatIndex:")) offenders.push(slot);
    }
    expect(
      offenders,
      `these calls shift the slot away from the beat and file the verdict under the shifted ` +
        `number: ${offenders.join(" | ")}`
    ).toEqual([]);
  });

  /** The three offsets the logs actually produced, named so a revert is unmistakable. */
  it.each([
    ["2000 + slot", "beatIndex: 2000 + slot"],
    ["beat.index + attempt * 100", "beatIndex: beat.index"],
  ])("the %s site declares %s", (_slot, declaration) => {
    expect(CODE).toContain(declaration);
  });

  /** `si` is a plain variable, so the rule above cannot see it — pinned by hand. */
  it("the slotBeatIndex sites declare the beat they were fetched for", () => {
    const declared = [...CODE.matchAll(/beatIndex: slotBeatIndex \?\? si/g)];
    expect(
      declared.length,
      "a rescue slot files its verdict under the slot number again; the adoption beside it is " +
        "recorded under slotBeatIndex, so the two records describe different beats"
    ).toBe(3);
  });

  /** And every call still passes the relevance object at all — the check needs a context. */
  it("every call still asks for a verdict", () => {
    const calls = ladderCalls(CODE);
    expect(calls.length, "the ladder's call sites have moved").toBeGreaterThanOrEqual(13);
    for (const args of calls) {
      expect(args, `a call stopped asking for a verdict: ${args.slice(0, 80)}`).toMatch(
        /dedup[,:]/
      );
    }
  });
});

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

  /** And still says never_asked when there genuinely is nothing — that answer stays available. */
  it("still reports never_asked when no verdict exists at all", () => {
    const at = STATUS.indexOf("function verificationForBeat(");
    expect(STATUS.slice(at, at + 900)).toContain('return onThisBeat ?? "never_asked";');
  });
});
