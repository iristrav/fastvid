/**
 * RENDER 571 — TWO INVARIANTS THAT FIRED, AND WHAT THEY WERE ACTUALLY DETECTING.
 *
 * ── The report ──────────────────────────────────────────────────────────────────────────────
 *
 *     [BeatFunnel] s0b3 shortlisted=8/8 visionAsked=14
 *     [BeatFunnel] TOTAL shortlisted=117 visionAsked=128
 *     [AdoptionEvidence] adoptions=42 realFunnel=8 backed=3 withoutEligibility=4 withoutVision=0
 *     INVARIANT_H REAL_FUNNEL_ADOPTION_WITHOUT_ELIGIBILITY count=4
 *
 * Both numbers are real. Both conclusions drawn from them were wrong, and in the same way: a
 * measurement was asked to name a cause it could not distinguish.
 *
 * ── P0-A — `visionAsked > shortlisted` is not proof of a bypass ─────────────────────────────
 *
 * `admitToShortlist` returns `alreadyOnList` for a content key it has already admitted and does
 * not spend a second slot — correctly, it is the same picture. The ask is counted anyway. So a
 * member asked twice lifts `visionAsked` above `shortlisted` while nothing has got past the bound.
 * The old check called that VISION_OUTSIDE_SHORTLIST. A real outsider and a repeated member
 * produce the identical inequality, so the name was a guess.
 *
 * ── P0-B — the evidence line asked a different question than the guard ──────────────────────
 *
 *     guard   isEligible(clipPath, clipContentKey(clipPath))
 *     audit   isEligible(clipPath)
 *
 * A curated record is opened against `archive-asset:<id>` with content key `curated:asset:<id>`,
 * never against the prepared clip's path — so without the key `resolve` finds nothing. Measured on
 * a real ledger in RONDE 98: `isEligible(clip, key)` true, `isEligible(clip)` false. INVARIANT_H
 * was reporting adoptions the guard had every right to allow.
 *
 * Neither fix relaxes anything. An adoption the guard refuses is still unbacked here, and a
 * candidate that never passed admission is still a violation — now under its own name.
 */
import * as fsSync from "fs";
import * as pathSync from "path";
import { describe, expect, it, vi } from "vitest";

import {
  admitToShortlist,
  beatFunnel,
  beatShortlistViolations,
  createBeatShortlistState,
  formatBeatShortlists,
  noteVisionAsked,
} from "./beatShortlist";
import {
  bindContentKeyResolver,
  bindLineageLedger,
  formatAdoptionEvidence,
  recordClipAdopt,
  type ClipAdoptEntry,
} from "./clipAdoptAudit";
import {
  VisualSourceLedger,
  assertNoSelectedClipWithoutOutcome,
  curatedAssetContentKey,
  ensureCuratedAssetLineageOn,
} from "./visualSourceLineage";

const ASSET = 57488;
const KEY = curatedAssetContentKey(ASSET);
const CLIP = `/w/scene_1_b6_curated_a${ASSET}.mp4`;

/* ═════════════ P0-A — a repeat and a bypass are no longer the same finding ═════════════ */

describe("P0-A: asking twice about one member is not a bypass", () => {
  const askedTwice = () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 3, KEY);
    noteVisionAsked(state, 0, 3, KEY);
    noteVisionAsked(state, 0, 3, KEY);
    return state;
  };

  it("render 571's shape reproduces: one slot, two asks", () => {
    const f = beatFunnel(askedTwice(), 0, 3);
    expect(f.shortlisted).toBe(1);
    expect(f.visionAsked, "the old inequality, exactly").toBe(2);
  });

  it("the repeat is counted as a repeat", () => {
    const f = beatFunnel(askedTwice(), 0, 3);
    expect(f.visionRepeatAsks).toBe(1);
    expect(f.visionOutsideShortlist, "nothing escaped the bound").toBe(0);
  });

  it("and is reported as VISION_REPEAT_ASKS, not as a bypass", () => {
    const v = beatShortlistViolations(askedTwice());
    expect(v.join("\n")).toContain("VISION_REPEAT_ASKS");
    expect(v.join("\n")).not.toContain("VISION_OUTSIDE_SHORTLIST");
  });
});

describe("P0-A: a candidate that never passed admission is still a violation", () => {
  const bypassed = () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 0, 3, KEY);
    /** Never admitted — this is the breach the shortlist exists to prevent. */
    noteVisionAsked(state, 0, 3, "pexels:deadbeef");
    return state;
  };

  it("is counted", () => {
    expect(beatFunnel(bypassed(), 0, 3).visionOutsideShortlist).toBe(1);
  });

  it("is named, with its own violation and not the repeat one", () => {
    const v = beatShortlistViolations(bypassed()).join("\n");
    expect(v).toContain("VISION_OUTSIDE_SHORTLIST");
    expect(v).toContain("never passed admission");
    expect(v).not.toContain("VISION_REPEAT_ASKS");
  });

  it("says so at the moment it happens, not only in the summary", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      bypassed();
      expect(warn.mock.calls.flat().join(" ")).toContain("VISION_OUTSIDE_SHORTLIST");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("P0-A: the bound itself is unchanged", () => {
  it("a full shortlist still refuses the next candidate", () => {
    const state = createBeatShortlistState();
    for (let i = 0; i < 8; i++) admitToShortlist(state, 1, 1, `k${i}`, 8);
    const ninth = admitToShortlist(state, 1, 1, "k8", 8);
    expect(ninth.admitted).toBe(false);
    expect(ninth.admitted === false && ninth.reason).toBe("SHORTLIST_FULL");
  });

  it("an already-admitted key still costs no second slot", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 1, 1, KEY, 8);
    const again = admitToShortlist(state, 1, 1, KEY, 8);
    expect(again.admitted).toBe(true);
    expect(again.alreadyOnList).toBe(true);
    expect(beatFunnel(state, 1, 1).shortlisted).toBe(1);
  });

  it("a healthy beat reports no violation and no extra noise", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 2, 0, KEY);
    noteVisionAsked(state, 2, 0, KEY);
    expect(beatShortlistViolations(state).join("\n")).not.toContain("VISION_");
    const line = formatBeatShortlists(state).join("\n");
    expect(line).not.toContain("repeatAsks");
    expect(line).not.toContain("OUTSIDE_SHORTLIST");
  });

  it("an ask with no content key is counted but not classified either way", () => {
    const state = createBeatShortlistState();
    admitToShortlist(state, 3, 0, KEY);
    noteVisionAsked(state, 3, 0, undefined);
    const f = beatFunnel(state, 3, 0);
    expect(f.visionAsked).toBe(1);
    expect(f.visionOutsideShortlist, "absence of identity is not evidence of a bypass").toBe(0);
    expect(f.visionRepeatAsks).toBe(0);
  });
});

/* ═════════════ P0-B — the evidence line asks the guard's question ═════════════ */

describe("P0-B: INVARIANT_H no longer fires on a curated adoption the guard allowed", () => {
  const audit = (bindResolver: boolean): ClipAdoptEntry[] => {
    const a: ClipAdoptEntry[] = [];
    const ledger = new VisualSourceLedger({ renderId: "t" });
    ensureCuratedAssetLineageOn(ledger, { asset: { id: ASSET }, archiveName: "ww2", score: 9 }, 1, 6);
    ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    bindLineageLedger(a, ledger);
    if (bindResolver) bindContentKeyResolver(a, () => KEY);
    recordClipAdopt(a, 1, 6, "beat", CLIP, "archive");
    return a;
  };

  /** The defect, pinned: the same ledger, the same clip, two different answers. */
  it("without the resolver the audit calls an eligible clip ineligible", () => {
    const line = formatAdoptionEvidence(audit(false)).join("\n");
    expect(line).toContain("withoutEligibility=1");
    expect(line).toContain("INVARIANT_H");
  });

  it("with the resolver it agrees with the guard", () => {
    const line = formatAdoptionEvidence(audit(true)).join("\n");
    expect(line).toContain("withoutEligibility=0");
    expect(line).not.toContain("INVARIANT_H");
  });

  /** The ledger fact both readings rest on — measured, not assumed. */
  it("the two spellings of the question genuinely differ", () => {
    const ledger = new VisualSourceLedger({ renderId: "t" });
    ensureCuratedAssetLineageOn(ledger, { asset: { id: ASSET }, archiveName: "ww2", score: 9 }, 1, 6);
    ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    expect(ledger.isEligible(CLIP, KEY)).toBe(true);
    expect(ledger.isEligible(CLIP), "this is what the audit was asking").toBe(false);
  });
});

describe("P0-B: nothing was made easier", () => {
  const auditFor = (markEligible: boolean): ClipAdoptEntry[] => {
    const a: ClipAdoptEntry[] = [];
    const ledger = new VisualSourceLedger({ renderId: "t" });
    ensureCuratedAssetLineageOn(ledger, { asset: { id: ASSET }, archiveName: "ww2", score: 9 }, 1, 6);
    if (markEligible) ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    bindLineageLedger(a, ledger);
    bindContentKeyResolver(a, () => KEY);
    recordClipAdopt(a, 1, 6, "beat", CLIP, "archive");
    return a;
  };

  /** A clip that never became eligible is still reported, key or no key. */
  it("an adoption the guard would refuse is still unbacked", () => {
    const line = formatAdoptionEvidence(auditFor(false)).join("\n");
    expect(line).toContain("withoutEligibility=1");
    expect(line).toContain("REAL_FUNNEL_ADOPTION_WITHOUT_ELIGIBILITY");
  });

  it("a resolver that throws leaves the answer exactly as it was", () => {
    const a: ClipAdoptEntry[] = [];
    const ledger = new VisualSourceLedger({ renderId: "t" });
    ensureCuratedAssetLineageOn(ledger, { asset: { id: ASSET }, archiveName: "ww2", score: 9 }, 1, 6);
    ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    bindLineageLedger(a, ledger);
    bindContentKeyResolver(a, () => {
      throw new Error("no key");
    });
    expect(() => recordClipAdopt(a, 1, 6, "beat", CLIP, "archive")).not.toThrow();
    expect(formatAdoptionEvidence(a).join("\n")).toContain("withoutEligibility=1");
  });

  it("an unbound resolver behaves as before the change", () => {
    expect(formatAdoptionEvidence(audit(false)).join("\n")).toContain("withoutEligibility=1");
  });

  const audit = (bindResolver: boolean): ClipAdoptEntry[] => {
    const a: ClipAdoptEntry[] = [];
    const ledger = new VisualSourceLedger({ renderId: "t" });
    ensureCuratedAssetLineageOn(ledger, { asset: { id: ASSET }, archiveName: "ww2", score: 9 }, 1, 6);
    ledger.markEligible(CLIP, KEY, "vision_gate:archive");
    bindLineageLedger(a, ledger);
    if (bindResolver) bindContentKeyResolver(a, () => KEY);
    recordClipAdopt(a, 1, 6, "beat", CLIP, "archive");
    return a;
  };
});

/* ═════════════ the render binds the resolver ═════════════ */

describe("the render hands its key function over", () => {
  it("beside the two ledgers, in one place", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const at = pipe.indexOf("bindRelevanceLedger(state.clipAdoptAudit");
    expect(at).toBeGreaterThan(-1);
    expect(pipe.slice(at, at + 1400)).toContain("bindContentKeyResolver(state.clipAdoptAudit, clipContentKey)");
  });

  it("and the vision gate passes the key admission was granted on", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("noteVisionAsked(dedup.beatShortlist, scene.index, beat.index, shortlistKey)");
  });
});

/* ═════════════ P0-C — every push refusal records the asset's ending ═════════════ */

/**
 * RENDER 571: `selectedWithoutOutcome=3` — three assets (serpapi x2, openverse) left the render
 * with no terminal lifecycle event.
 *
 * A CORRECTION, KEPT. The first pass here accused the barrier refusal of being the leak: a grep of
 * the twelve lines above its `tracePushOutcome` found no `recordRejection`, and a fix was written
 * on that. Widening the window disproved it — the write is there, further up, at the single seam
 * all four `pushSceneClip` definitions pass through, with its own note explaining why it sits
 * there rather than in the callers. The fix was a duplicate and was removed.
 *
 * So P0-C's cause is NOT established. What these tests pin is the property that has to hold
 * whatever the cause turns out to be, so the next capture starts from a checked invariant rather
 * than from a second guess: every push refusal files the asset's ending, not only the beat's.
 */
describe("P0-C: a refused push is an ending on the asset, not only on the beat", () => {
  const PIPE = fsSync.readFileSync(pathSync.join(__dirname, "videoPipeline.ts"), "utf8");

  /** The window is 3000 bytes on purpose: the seam write sits well above the trace call. */
  const refusalSites = (): string[] => {
    const out: string[] = [];
    let at = PIPE.indexOf("tracePushOutcome(dedup");
    while (at > -1) {
      const line = PIPE.slice(at, PIPE.indexOf("\n", at));
      if (line.includes("false,")) out.push(PIPE.slice(Math.max(0, at - 3000), at));
      at = PIPE.indexOf("tracePushOutcome(dedup", at + 1);
    }
    return out;
  };

  it("all three refusal paths exist", () => {
    expect(refusalSites()).toHaveLength(3);
  });

  it("EVERY ONE of them files a rejection on the lineage first", () => {
    for (const before of refusalSites()) {
      expect(before, "a refusal that leaves the asset unaccounted").toContain("recordRejection(");
    }
  });

  /** One write per refusal — the duplicate this round briefly added would fail here. */
  it("and files it exactly once", () => {
    const barrier = refusalSites().find((s) => s.includes("barrier.reason"));
    expect(barrier).toBeDefined();
    expect((barrier!.match(/recordRejection\(clipPath, barrier\.reason/g) ?? []).length).toBe(1);
  });

  /** The status filed has to be one the invariant accepts, or the write buys nothing. */
  it("a filed rejection satisfies the terminal-outcome rule", () => {
    const ledger = new VisualSourceLedger({ renderId: "t" });
    const rec = ensureCuratedAssetLineageOn(
      ledger,
      { asset: { id: ASSET }, archiveName: "ww2", score: 9 },
      1,
      6
    );
    ledger.recordEvent(rec.lineageId, "SELECTED", { status: "OK" });
    expect(assertNoSelectedClipWithoutOutcome(ledger).offenders.length, "unaccounted before").toBe(1);
    expect(ledger.recordRejection(CLIP, "barrier_reason", KEY)).toBe(true);
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok, "accounted after").toBe(true);
  });
});
