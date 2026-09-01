/**
 * RONDE 169 — eighteen assets chosen, delivered nowhere, and one cause behind all of them.
 *
 * ── What render 555 measured ─────────────────────────────────────────────────────────────────
 *
 *     [OutcomeInvariant] FAILED selectedWithoutOutcome=18
 *     [AssetLifecycleAudit] assets=49 delivered=11 resolved=15 neverChosen=5 unresolved=18
 *     [AssetLifecycleAudit] unresolvedByRoute backfill=6 rescue=6 fallback=4 primary=2
 *
 * RONDE 167 gave those warnings a route and a filename, which is what made the pattern visible:
 * every one of the eighteen carried `provider=UNVERIFIED`. That is the signature of
 * `recordClipAdopt`'s hole-filling branch, which opens a record with no provider for a clip the
 * ledger has never seen — the branch the backfill, rescue and fallback routes go through.
 *
 * ── The cause ────────────────────────────────────────────────────────────────────────────────
 *
 * Fourteen places assign `sceneVisualResults[i]`. Several rebuild a scene's picture list from
 * scratch: a coverage repair, a strict-voice refill, a guaranteed fill after an empty scene. The
 * clips of the PREVIOUS list were adopted and then simply stopped being referenced. No gate
 * refused them, nothing replaced them one for one, and the array they lived in was overwritten.
 *
 * One cause, not eighteen — which is why the fix is one writer rather than fourteen patches.
 *
 * ── Why the writer sits in the pipeline and not in the audit ─────────────────────────────────
 *
 * The audit could derive this at the end: "adopted, not delivered, therefore dropped." That would
 * make `unresolved` unfalsifiable — every hole would explain itself and the number would stop
 * being able to find anything. The code that drops the clip is the code that knows, so it says so.
 *
 * `hasOutcomeFor` keeps it honest in the other direction: a clip a compose gate already refused
 * keeps that specific ending, and this never overwrites a precise reason with a vaguer one.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { clipContentKey } from "./videoPipeline";
import {
  VisualSourceLedger,
  assertNoSelectedClipWithoutOutcome,
  formatAssetLifecycleAudit,
  recordAssetOutcome,
} from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** A scene's clips as the backfill route leaves them: adopted, provider unproven. */
function adoptedScene(paths: string[]): VisualSourceLedger {
  const ledger = new VisualSourceLedger({ renderId: "r169" });
  ledger.setContentKeyResolver(clipContentKey);
  for (const p of paths) {
    const r = ledger.createLineage({ sceneIndex: 1, beatIndex: 2, localPath: p, route: "backfill" });
    ledger.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
  }
  return ledger;
}

/**
 * The writer, as videoPipeline runs it.
 *
 * Modelled here only because `noteSceneClipsResourced` is module-private; every rule it applies —
 * the diff, the already-explained guard, the reason — is exercised through the real ledger, so a
 * change to the ledger's notion of "accounted for" fails this.
 */
function noteResourced(
  ledger: VisualSourceLedger,
  previous: string[],
  next: string[],
  context = "scene_1_resourced"
): void {
  const kept = new Set(next);
  for (const clip of previous) {
    if (!clip || kept.has(clip)) continue;
    const key = clipContentKey(clip);
    if (ledger.hasOutcomeFor(clip, key)) continue;
    recordAssetOutcome(ledger, clip, "scene_resourced", context, key);
  }
}

const unaccounted = (l: VisualSourceLedger): number =>
  assertNoSelectedClipWithoutOutcome(l).offenders.length;

describe("RONDE 169 — a rebuilt scene says what became of the old list", () => {
  it("the bug: overwriting the list left every dropped clip unaccounted for", () => {
    // Render 555's shape: a guaranteed fill adopts four cards, a refill replaces them all.
    const l = adoptedScene([
      "/w/scene_1_slot2_guaranteed.mp4",
      "/w/scene_1_slot3_guaranteed.mp4",
      "/w/scene_1_slot4_guaranteed.mp4",
      "/w/scene_1_slot5_guaranteed.mp4",
    ]);
    l.markFinalVideo([]);
    expect(unaccounted(l)).toBe(4);
  });

  it("with the writer, the same four are accounted for", () => {
    const previous = [
      "/w/scene_1_slot2_guaranteed.mp4",
      "/w/scene_1_slot3_guaranteed.mp4",
      "/w/scene_1_slot4_guaranteed.mp4",
      "/w/scene_1_slot5_guaranteed.mp4",
    ];
    const l = adoptedScene(previous);
    noteResourced(l, previous, ["/w/scene_1_b0_real.mp4"]);
    l.markFinalVideo([]);
    expect(unaccounted(l)).toBe(0);
    expect(formatAssetLifecycleAudit(l)[0]).toContain("unresolved=0");
    expect(formatAssetLifecycleAudit(l)[0]).toContain("resolved=4");
  });

  it("a clip the new list KEEPS is not given an ending", () => {
    // The commonest assignment only refines a list. Ending a clip that is still on screen would
    // be a lie in the other direction, and would show up as REPLACED on a delivered asset.
    const previous = ["/w/a.mp4", "/w/b.mp4"];
    const l = adoptedScene(previous);
    noteResourced(l, previous, ["/w/a.mp4"]);
    l.markFinalVideo(["/w/a.mp4"]);
    expect(unaccounted(l)).toBe(0);
    const kept = l.resolve("/w/a.mp4")!;
    expect(l.allEvents().filter((e) => e.lineageId === kept.lineageId && e.stage === "REPLACED"))
      .toHaveLength(0);
  });

  it("a clip that already has a specific ending keeps it", () => {
    /**
     * The guard that stops this becoming a catch-all. A clip the compose barrier refused is
     * `vision_rejected`, and overwriting that with "the scene was re-cut" would delete the only
     * useful half of the record.
     */
    const previous = ["/w/refused.mp4", "/w/dropped.mp4"];
    const l = adoptedScene(previous);
    recordAssetOutcome(l, "/w/refused.mp4", "vision_rejected", "s1b2");
    noteResourced(l, previous, []);
    const refused = l.resolve("/w/refused.mp4")!;
    const reasons = l
      .allEvents()
      .filter((e) => e.lineageId === refused.lineageId && e.status !== "OK")
      .map((e) => e.reason);
    expect(reasons).toEqual(["vision_rejected:s1b2"]);
    expect(reasons.join(" ")).not.toContain("scene_resourced");
  });

  it("a delivered clip is never given a second ending either", () => {
    const previous = ["/w/delivered.mp4"];
    const l = adoptedScene(previous);
    l.markFinalVideo(["/w/delivered.mp4"]);
    noteResourced(l, previous, []);
    const rec = l.resolve("/w/delivered.mp4")!;
    expect(l.allEvents().filter((e) => e.lineageId === rec.lineageId && e.stage === "REPLACED"))
      .toHaveLength(0);
  });

  it("running it twice writes one ending, not two", () => {
    // Fourteen call sites, and a scene can pass through several of them in one render.
    const previous = ["/w/a.mp4"];
    const l = adoptedScene(previous);
    noteResourced(l, previous, []);
    const after = l.allEvents().length;
    noteResourced(l, previous, []);
    expect(l.allEvents().length).toBe(after);
  });

  it("the reason names the scene it happened in", () => {
    const l = adoptedScene(["/w/a.mp4"]);
    noteResourced(l, ["/w/a.mp4"], [], "scene_7_resourced");
    expect(l.allEvents().at(-1)?.reason).toBe("scene_resourced:scene_7_resourced");
  });

  it("scene_resourced is REPLACED, not a refusal", () => {
    // Nothing objected to these clips. Filing them as REJECTED would put a content verdict on the
    // record that no gate ever gave — the same mistake RONDE 167 found on the extend route.
    const l = adoptedScene(["/w/a.mp4"]);
    noteResourced(l, ["/w/a.mp4"], []);
    expect(l.allEvents().at(-1)?.status).toBe("REPLACED");
    expect(l.allEvents().at(-1)?.stage).toBe("REPLACED");
  });

  it("an empty previous list, or none at all, does nothing", () => {
    const l = adoptedScene([]);
    const before = l.allEvents().length;
    noteResourced(l, [], ["/w/new.mp4"]);
    expect(l.allEvents().length).toBe(before);
  });
});

describe("RONDE 169 — every assignment site is covered", () => {
  it("all fourteen sceneVisualResults assignments report what they replaced", () => {
    /**
     * The count is the assertion. A fifteenth assignment added without the writer is the same bug
     * returning, and it would be invisible again — which is exactly how render 555 accumulated
     * eighteen of them across four different routes.
     */
    const assignments = PIPE.match(/^\s*sceneVisualResults\[(si|i)\] = /gm) ?? [];
    const notes = PIPE.match(/noteSceneClipsResourced\(visualDedup, prevSceneVisual_\d+,/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    expect(notes.length).toBe(assignments.length);
  });

  it("each one captures the previous result BEFORE assigning", () => {
    // Reading it afterwards would diff the new list against itself and find nothing.
    for (const m of PIPE.matchAll(/const (prevSceneVisual_\d+) = sceneVisualResults\[(si|i)\];/g)) {
      const capture = PIPE.indexOf(m[0]);
      const assign = PIPE.indexOf(`sceneVisualResults[${m[2]}] = `, capture);
      const note = PIPE.indexOf(`noteSceneClipsResourced(visualDedup, ${m[1]},`, capture);
      expect(assign, m[1]).toBeGreaterThan(capture);
      expect(note, m[1]).toBeGreaterThan(assign);
    }
  });

  it("the writer skips clips that already have an ending", () => {
    const idx = PIPE.indexOf("function noteSceneClipsResourced(");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, PIPE.indexOf("async function appendGuaranteedSceneClips(", idx));
    expect(block).toContain("lineage.hasOutcomeFor(clip, contentKey)");
    expect(block).toContain('"scene_resourced"');
    expect(block).toContain("kept.has(clip)");
  });
});

describe("RONDE 169 — earlier rounds intact", () => {
  it("RONDE 167's invariant and RONDE 168's judged-winner rule still stand", () => {
    expect(PIPE).toContain("assertNoSelectedClipWithoutOutcome(ledger)");
    expect(PIPE).toContain("const judgedOnly = keepOnlyJudgedWinner(");
    expect(PIPE).toContain("cache.lineage.setContentKeyResolver(clipContentKey);");
  });

  it("hasOutcomeFor uses the one shared definition of an ending", () => {
    // A download that never finished counts, exactly as reconcile() and the audit read it.
    const l = new VisualSourceLedger({ renderId: "r169" });
    const r = l.createLineage({ sceneIndex: 0, beatIndex: 0, localPath: "/w/a.mp4", provider: "loc" });
    l.recordEvent(r.lineageId, "SELECTED", { status: "OK" });
    expect(l.hasOutcomeFor("/w/a.mp4")).toBe(false);
    l.recordEvent(r.lineageId, "DOWNLOAD_FAILED", { status: "FAILED" });
    expect(l.hasOutcomeFor("/w/a.mp4")).toBe(true);
  });
});
