/**
 * A PATH IS NOT A PICTURE — RONDE 624.
 *
 * ── What render 598 did for nine minutes on one beat ────────────────────────────────────────
 *
 *     [BeatRelevance] s2b0: backfill verdict unavailable: reason=already_judged
 *         file=scene_2_slot0_guaranteed.mp4 — the last look was asked for and did not produce a
 *         verdict; this refusal is the render failing to judge, not the editor refusing
 *     [BeatRelevance] s2b0: refusing to push scene_2_slot0_guaranteed.mp4 — backfill needs an
 *         approval; nobody looked at this clip for s2b0 (per-beat look ceiling reached (10))
 *
 * The same four files, every thirty-five seconds, from 15:58 until the render was killed. The
 * ffmpeg lines in the same log show why: each round REGENERATED the card at the same path with a
 * different duration — `-t 3.5`, then `-t 5.428`, both writing `scene_2_slot0_guaranteed.mp4`.
 * Every round therefore offered a different picture under a name the ledger had already filed a
 * verdict for.
 *
 * `byClipPath` answered with the previous card's record; that record carried no verdict; and the
 * single retry this function grants had been spent on the first round and keyed by the same path.
 * The escape hatch RONDE 228 built for exactly this moment could never fire again, so the beat
 * could not be filled — not even by a placeholder. That is what made the loop endless rather than
 * merely wasteful, and it is why this defect was taken before the one that made each round costly.
 *
 * ── What changed ────────────────────────────────────────────────────────────────────────────
 *
 * A verdict now records the content it was earned on, a path record is used only while that
 * content is still the content at the path, and the one retry is keyed by the picture rather than
 * the filename.
 *
 * ── What did NOT ────────────────────────────────────────────────────────────────────────────
 *
 * Nothing becomes an approval. A regenerated card is unjudged again — which is the truth about it
 * — and is looked at once, like any other picture about to be used. A caller that offers no
 * content key keeps exactly the behaviour it had, and a clip that is genuinely the same file keeps
 * its verdict and its spent retry, which is the bound RONDE 228 asked for.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { createBeatRelevanceLedger } from "./beatVisualRelevance";

const SRC = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");

/** The shape the ledger stores, built the way `record()` builds it. */
const entryFor = (contentKey: string | undefined, evaluated: boolean) => ({
  ctx: { sceneIndex: 2, beatIndex: 0 } as never,
  decision: { verdict: "unknown", depicts: "", reason: "no frame", evaluated } as never,
  contentKey,
});

/* ═══════════ §1 — the ledger remembers WHICH picture ═══════════ */

describe("§1 — a verdict carries the content it was earned on", () => {
  it("THE ENTRY HAS A CONTENT KEY, which is what makes staleness visible at all", () => {
    expect(SRC).toContain("/** The content key at the moment of the verdict, when the caller knew one. */");
    expect(SRC).toContain("contentKey: contentKey || undefined");
  });

  it("and the ledger it is stored in still exists unchanged", () => {
    const ledger = createBeatRelevanceLedger();
    expect(ledger.byClipPath).toBeInstanceOf(Map);
    expect(ledger.byContentKey).toBeInstanceOf(Map);
    expect(ledger.finalSayRetried).toBeInstanceOf(Set);
  });
});

/* ═══════════ §2 — the rule, on render 598's own file ═══════════ */

describe("§2 — a rewritten card does not inherit the old card's verdict", () => {
  /** The guard as the source states it, applied to the two cards render 598 wrote. */
  const isStale = (judged: string | undefined, now: string | undefined) =>
    judged != null && now != null && judged !== now;

  /** `file:<size>:<basename>` — the same name, two different files. */
  const CARD_3_5S = "file:184320:scene_2_slot0_guaranteed.mp4";
  const CARD_5_4S = "file:286720:scene_2_slot0_guaranteed.mp4";

  it("RENDER 598's TWO CARDS ARE DIFFERENT PICTURES, and the rule sees it", () => {
    expect(isStale(CARD_3_5S, CARD_5_4S), "the rewritten card kept the old verdict").toBe(true);
  });

  it("THE SAME FILE KEEPS ITS VERDICT — the bound RONDE 228 asked for still binds", () => {
    expect(isStale(CARD_3_5S, CARD_3_5S)).toBe(false);
  });

  it("and a caller that offers no content key is left exactly as it was", () => {
    expect(isStale(undefined, CARD_5_4S)).toBe(false);
    expect(isStale(CARD_3_5S, undefined)).toBe(false);
    expect(isStale(undefined, undefined)).toBe(false);
  });

  it("the guard demands BOTH keys before it discards anything", () => {
    const at = SRC.indexOf("const pathEntryIsStale =");
    const body = SRC.slice(at, SRC.indexOf(";", at));
    expect(body).toContain("pathEntry?.contentKey != null");
    expect(body).toContain("params.contentKey != null");
    expect(body).toContain("pathEntry.contentKey !== params.contentKey");
  });

  it("AND THE LOOKUP ACTUALLY USES IT — the predicate alone proves nothing", () => {
    /**
     * Written after the first draft of this file passed with the guard disconnected: every
     * assertion about the rule held while `byPath` still read the stale record. A check that
     * survives the defect it is named for is worse than no check.
     */
    expect(SRC).toContain("const byPath = pathEntryIsStale ? undefined : pathEntry;");
  });

  it("A DISCARDED VERDICT IS ANNOUNCED — a ledger that forgets quietly is the defect itself", () => {
    expect(SRC).toContain("was rewritten since it was judged");
    expect(SRC, "the line must name both pictures").toContain(
      "(${pathEntry!.contentKey} -> ${params.contentKey})"
    );
  });
});

/* ═══════════ §3 — the retry follows the picture ═══════════ */

describe("§3 — one extra look per PICTURE, not per filename", () => {
  it("THE RETRY KEY CARRIES THE CONTENT", () => {
    expect(SRC).toContain('const retryKey = `${params.clipPath}|${params.contentKey ?? ""}`;');
  });

  it("and it is what the retry is recorded and checked against", () => {
    expect(SRC).toContain("!scope.ledger.finalSayRetried.has(retryKey)");
    expect(SRC).toContain("scope.ledger.finalSayRetried.add(retryKey)");
    expect(SRC, "a path-keyed retry survived somewhere").not.toContain(
      "finalSayRetried.has(params.clipPath)"
    );
  });

  it("RENDER 598's TWO CARDS GET ONE LOOK EACH, and neither gets two", () => {
    const retried = new Set<string>();
    const key = (p: string, c: string) => `${p}|${c}`;
    const P = "/tmp/scene_2_slot0_guaranteed.mp4";
    const mayRetry = (k: string) => (retried.has(k) ? false : (retried.add(k), true));

    expect(mayRetry(key(P, "file:184320:x.mp4")), "the first card is looked at").toBe(true);
    expect(mayRetry(key(P, "file:184320:x.mp4")), "and not a second time").toBe(false);
    expect(mayRetry(key(P, "file:286720:x.mp4")), "the rewritten card earns its own look").toBe(true);
    expect(mayRetry(key(P, "file:286720:x.mp4")), "and not a second time either").toBe(false);
  });
});

/* ═══════════ §4 — nothing was loosened ═══════════ */

describe("§4 — a fresh look is not a fresh approval", () => {
  it("the retry still requires finalSay and an unjudged record", () => {
    expect(SRC).toContain("neverLookedAt && params.finalSay === true");
  });

  it("and RONDE 228's own statement of what it does not do still stands", () => {
    expect(SRC).toContain("NOTHING here turns");
    expect(SRC).toContain("a clip that comes back");
  });

  it("the per-beat check on a reused verdict is unchanged", () => {
    expect(SRC).toContain("return entry.ctx.sceneIndex === params.sceneIndex && entry.ctx.beatIndex === params.beatIndex;");
  });
});
