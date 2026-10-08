import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRejectionRegistry, registerRejection, beatRejectCount } from "./rejectionRegistry";
import { formatAssetTrace, VisualSourceLedger, type VisualLineageEvent } from "./visualSourceLineage";

/**
 * VIDEO 641 (W1) — ONE MOMENT, ONE RECORD, EVERY EVENT UNDER ITS OWN SENTENCE.
 *
 * `youtube_cc:00366246f9a1b17d@t2059d40` (M5_AJMSkTxs, 205.9 s) was opened under s2b0 and then offered
 * to s1b1, s0b3 and s1b3. Every event took its sentence from the one record:
 *
 *     06:26:32  #1 scene=2 beat=0 ELIGIBLE REJECTED beat_image_gate   ← s1b1 refused it
 *     06:27:34  #1 scene=2 beat=0 ELIGIBLE REJECTED beat_image_gate   ← s0b3 refused it
 *     06:27:49  #1 scene=2 beat=0 RANKED / SELECTED                   ← s1b3 chose it
 *     06:27:52  #1 scene=1 beat=3 ELIGIBLE REJECTED already_used_…    ← after SELECTED moved the record
 *
 * Observability only: the record, its identity and every decision are unchanged. The event now
 * carries the sentence its writer knows.
 */

afterEach(() => vi.restoreAllMocks());
const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

const KEY = "youtube_cc:00366246f9a1b17d@t2059d40";
const fileFor = (scene: number) => `/w/scene_${scene}_ytfu_0m0_t2059d40__pid_youtube_cc-00366246f9a1b17d.mp4`;

function open(ledger: VisualSourceLedger, sceneIndex: number, beatIndex: number, contentKey = KEY, localPath = fileFor(sceneIndex)) {
  return ledger.createLineage({
    sceneIndex,
    beatIndex,
    candidateId: contentKey,
    contentKey,
    localPath,
    provider: "youtube_cc",
    providerAssetId: "M5_AJMSkTxs",
  });
}
const at = (e: VisualLineageEvent) => `s${e.sceneIndex}b${e.beatIndex} ${e.stage} ${e.status}${e.reason ? ` ${e.reason}` : ""}`;

describe("W1 — one moment offered to three sentences", () => {
  it("A, B and C see the same fragment: one record, each event under its own sentence", () => {
    quiet();
    const ledger = new VisualSourceLedger({ renderId: "w1" });
    const registry = createRejectionRegistry();
    registry.lineage = ledger;
    const a = open(ledger, 2, 0);
    const b = open(ledger, 1, 1);
    const c = open(ledger, 1, 3);
    /** one canonical identity, no duplicate asset */
    expect(b.lineageId).toBe(a.lineageId);
    expect(c.lineageId).toBe(a.lineageId);
    expect(ledger.allRecords()).toHaveLength(1);
    /** A and B refuse it, C chooses it — the writers pass the sentence they act for */
    registerRejection(registry, 2, 0, fileFor(2), "beat_image_gate", "", { contentKey: KEY });
    registerRejection(registry, 1, 1, fileFor(1), "beat_image_gate", "", { contentKey: KEY });
    ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK", sceneIndex: 1, beatIndex: 3, currentPath: fileFor(1) });
    expect(ledger.allEvents().map(at)).toEqual([
      "s2b0 FOUND OK",
      "s1b1 FOUND OK same_asset_seen_again",
      "s1b3 FOUND OK same_asset_seen_again",
      "s2b0 ELIGIBLE REJECTED beat_image_gate",
      "s1b1 ELIGIBLE REJECTED beat_image_gate",
      "s1b3 SELECTED OK",
    ]);
    /** the record itself is untouched: it still names the sentence that opened it */
    expect([a.sceneIndex, a.beatIndex]).toEqual([2, 0]);
    /** the per-sentence refusal counts were always right and stay right */
    expect(beatRejectCount(registry, 2, 0)).toBe(1);
    expect(beatRejectCount(registry, 1, 1)).toBe(1);
    expect(beatRejectCount(registry, 1, 3)).toBe(0);
  });

  it("a later adoption context does not rewrite the events filed before it", () => {
    quiet();
    const ledger = new VisualSourceLedger({ renderId: "w1b" });
    const a = open(ledger, 2, 0);
    ledger.recordRejection(fileFor(1), "beat_image_gate", KEY, { sceneIndex: 1, beatIndex: 1 });
    ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK", sceneIndex: 1, beatIndex: 3 });
    /** the pipeline moves the record to the adopting sentence (unchanged behaviour) … */
    a.sceneIndex = 1;
    a.beatIndex = 3;
    /** … and a refusal filed afterwards for s2b0 is still filed under s2b0 */
    ledger.recordRejection(fileFor(2), "already_used_in_render", KEY, { sceneIndex: 2, beatIndex: 0 });
    expect(ledger.allEvents().map(at)).toEqual([
      "s2b0 FOUND OK",
      "s1b1 ELIGIBLE REJECTED beat_image_gate",
      "s1b3 SELECTED OK",
      "s2b0 ELIGIBLE REJECTED already_used_in_render",
    ]);
  });

  it("[AssetTrace] names the event's sentence", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    const ledger = new VisualSourceLedger({ renderId: "w1c" });
    const a = open(ledger, 2, 0);
    const e = ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK", sceneIndex: 1, beatIndex: 3 })!;
    expect(formatAssetTrace(a, "SELECTED", e)).toContain(" scene=1 beat=3 ");
    expect(lines.find((l) => l.includes("status=SELECTED"))).toContain(" scene=1 beat=3 ");
  });

  it("a writer that knows no sentence still files the record's own, as before", () => {
    quiet();
    const ledger = new VisualSourceLedger({ renderId: "w1d" });
    const a = open(ledger, 2, 0);
    ledger.recordEvent(a.lineageId, "DOWNLOAD_SUCCEEDED", { status: "OK" });
    ledger.recordRejection(fileFor(2), "mostly_black", KEY);
    const registry = createRejectionRegistry();
    registry.lineage = ledger;
    registerRejection(registry, 2, undefined, fileFor(2), "invalid_file", "", { contentKey: KEY });
    expect(ledger.allEvents().slice(1).map(at)).toEqual([
      "s2b0 DOWNLOAD_SUCCEEDED OK",
      "s2b0 COMPOSED REJECTED mostly_black",
      "s2b0 ELIGIBLE REJECTED invalid_file",
    ]);
  });
});

describe("W1 — negative: three different fragments for three sentences", () => {
  it("X for A, Y for B, Z for C: three records, no cross-sentence contamination", () => {
    quiet();
    const ledger = new VisualSourceLedger({ renderId: "w1n" });
    const registry = createRejectionRegistry();
    registry.lineage = ledger;
    const keys = ["youtube_cc:aaaaaaaaaaaaaaaa@t100d40", "youtube_cc:bbbbbbbbbbbbbbbb@t200d40", "youtube_cc:cccccccccccccccc@t300d40"];
    const files = keys.map((k, i) => `/w/scene_${i}_x${i}.mp4`);
    const recs = [open(ledger, 0, 1, keys[0], files[0]), open(ledger, 1, 2, keys[1], files[1]), open(ledger, 2, 0, keys[2], files[2])];
    expect(new Set(recs.map((r) => r.lineageId)).size).toBe(3);
    registerRejection(registry, 0, 1, files[0], "beat_image_gate", "", { contentKey: keys[0] });
    ledger.recordEvent(recs[1].lineageId, "SELECTED", { status: "OK", sceneIndex: 1, beatIndex: 2 });
    registerRejection(registry, 2, 0, files[2], "hard_mismatch", "", { contentKey: keys[2] });
    const byRecord = (id: string) => ledger.allEvents().filter((e) => e.lineageId === id).map(at);
    expect(byRecord(recs[0].lineageId)).toEqual(["s0b1 FOUND OK", "s0b1 ELIGIBLE REJECTED beat_image_gate"]);
    expect(byRecord(recs[1].lineageId)).toEqual(["s1b2 FOUND OK", "s1b2 SELECTED OK"]);
    expect(byRecord(recs[2].lineageId)).toEqual(["s2b0 FOUND OK", "s2b0 ELIGIBLE REJECTED hard_mismatch"]);
  });
});

describe("W1 — nothing but the event's sentence changes", () => {
  it("records, indexes, provider, outcome counts and summary are the same with or without the context", () => {
    quiet();
    const run = (withContext: boolean) => {
      const ledger = new VisualSourceLedger({ renderId: "same" });
      const registry = createRejectionRegistry();
      registry.lineage = ledger;
      const a = open(ledger, 2, 0);
      open(ledger, 1, 1);
      const ctx = (s: number, b: number) => (withContext ? { sceneIndex: s, beatIndex: b } : {});
      ledger.recordRejection(fileFor(1), "beat_image_gate", KEY, ctx(1, 1));
      ledger.recordEvent(a.lineageId, "SELECTED", { status: "OK", ...ctx(1, 3) });
      ledger.recordEvent(a.lineageId, "ADOPTED", { status: "OK", ...ctx(1, 3) });
      return {
        records: ledger.allRecords().map((r) => ({ ...r, createdAt: 0, selectedAt: 0, adoptedAt: 0 })),
        stages: ledger.allEvents().map((e) => `${e.lineageId} ${e.stage} ${e.status} ${e.reason ?? ""} ${e.provider}`),
        resolved: ledger.resolve(fileFor(1), KEY)?.lineageId,
        summary: JSON.stringify(ledger.summary()),
        rejections: beatRejectCount(registry, 1, 1),
      };
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe("W1 — the writers pass the sentence they act for", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const REG = fs.readFileSync(path.join(__dirname, "rejectionRegistry.ts"), "utf8");
  it("adoptClip's RANKED/SELECTED and every registered refusal carry scene and beat", () => {
    expect(PIPE).toContain('const selectedFor = { status: "OK" as const, sceneIndex, beatIndex, currentPath: p };');
    expect(PIPE).toContain('lineage.recordEvent(eligibleRecord.lineageId, "SELECTED", selectedFor);');
    expect(REG).toContain("recordRejection(clipPath, reason, detail.contentKey, beatIndex == null ? {} : { sceneIndex, beatIndex })");
  });
});
