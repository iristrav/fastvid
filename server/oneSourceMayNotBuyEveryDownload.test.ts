/**
 * ONE SOURCE MAY NOT BUY EVERY DOWNLOAD — AND ONE PICTURE IS ONE CANDIDATE.
 *
 * ── The two things render 593 measured ──────────────────────────────────────────────────────
 *
 *     206 Pexels clips downloaded, 0 Pexels clips adopted, across twenty beats
 *     per beat: vision_evaluated LARGER than offered
 *
 * Both are the same defect class, twice: a rule is written down, and read by one of the several
 * places that decide.
 *
 * A. THE DOWNLOAD CAP. Two routes fetch a beat's pictures. `buildDownloadShortlist` has capped
 *    each source since FASE 4 — stock 1, non-stock 2, archive 3 — and gives unused slots back to
 *    the non-stock overflow. The scene-pool loop in `videoPipeline` walks up to eight candidates
 *    and downloads until one survives technically, and knew nothing about any of it, so all eight
 *    of a beat's attempts could be one stock library. One slot per beat is twenty downloads; the
 *    pool route is where the other ~186 came from.
 *
 * B. THE CANDIDATE COUNTERS. `BeatFunnelRecord` says of its four vision counters: "Kept strictly
 *    disjoint. One candidate contributes to exactly one of the three … and never to more." That
 *    was an intention, not a behaviour: `noteBeatVisionVerdict` fired once per CALL to
 *    `judgeBeatClipRelevance`, and the same picture is asked about by the adopt path, the compose
 *    barrier, the refill and the rescue ladder. A subset cannot be larger than its set, and
 *    `vision_evaluated > offered` is that contradiction printed once per beat.
 *
 * ── What is deliberately NOT done ───────────────────────────────────────────────────────────
 *
 * No provider is switched off, no threshold moves, no gate is relaxed and no timeout changes.
 * The cap numbers are the funnel's own, unchanged; the counter names are unchanged and now mean
 * what they always claimed. `vision_never_asked` is NOT renamed into something friendlier — the
 * population underneath it is corrected, and the lookups it used to absorb are counted separately
 * and broken out by the gate's own `VisionDeclineCause`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { beatRecord, createBeatOutcomeAudit, formatBeatLedgerLine, noteBeatVisionVerdict } from "./beatOutcomeAudit";

/* ═══════════════════ A. the download cap ═══════════════════ */

const c = (source: string, id: string) => ({ source, id });

/* ═══════════════════ B. one picture is one candidate ═══════════════════ */

describe("a candidate asked about fifteen times is still one candidate", () => {

  it("THE DECLINE CAUSES ARE THE GATE'S OWN, SPLIT OUT — not one bucket", () => {
    /**
     * `vision_never_asked` absorbed four different events. They are the gate's own
     * `VisionDeclineCause` values, carried on the decision and never re-derived from prose, and
     * they are counted per LOOKUP on purpose: "how often did the ceiling stop us" is a question
     * about attempts, not about pictures.
     */
    const audit = createBeatOutcomeAudit();
    noteBeatVisionVerdict(audit, 0, 0, "never_asked", "a", "GATE_DISABLED");
    noteBeatVisionVerdict(audit, 0, 0, "never_asked", "b", "NO_NARRATION");
    noteBeatVisionVerdict(audit, 0, 0, "never_asked", "c", "BEAT_LOOK_CEILING");
    noteBeatVisionVerdict(audit, 0, 0, "never_asked", "d", "BEAT_LOOK_CEILING");
    const rec = beatRecord(audit, 0, 0);
    expect(rec.lookupsByDecline.get("GATE_DISABLED")).toBe(1);
    expect(rec.lookupsByDecline.get("NO_NARRATION")).toBe(1);
    expect(rec.lookupsByDecline.get("BEAT_LOOK_CEILING")).toBe(2);
    expect(rec.visionNeverAsked, "four distinct candidates, four declines").toBe(4);
  });

  it("a caller with no identity to give behaves exactly as it did before", () => {
    /** The fix may not quietly change a route that cannot name its candidate. */
    const audit = createBeatOutcomeAudit();
    noteBeatVisionVerdict(audit, 0, 0, "rejected");
    noteBeatVisionVerdict(audit, 0, 0, "rejected");
    const rec = beatRecord(audit, 0, 0);
    expect(rec.visionRejected).toBe(2);
    expect(rec.lookups).toBe(2);
    expect(rec.lookupsRepeated).toBe(0);
  });

  it("vision_never_asked IS NOT RENAMED — the population under it is corrected", () => {
    /**
     * Explicitly forbidden by the brief and worth pinning: a cosmetic rename would make the number
     * smaller without making it true. The name stays; what changes is what it counts.
     */
    const audit = createBeatOutcomeAudit();
    noteBeatVisionVerdict(audit, 0, 0, "never_asked", "k", "GATE_DISABLED");
    const line = formatBeatLedgerLine(beatRecord(audit, 0, 0));
    expect(line).toContain("vision_never_asked=1");
    expect(line).toContain("lookups=1");
    expect(line).toContain("distinct_candidates=1");
    expect(line).toContain("gate_disabled=1");
  });

  it("THE CALL SITE HANDS OVER THE IDENTITY — the half of the fix that is not in this module", () => {
    /**
     * Added because a mutation survived without it: replacing the identity at the call site with
     * `undefined` left every assertion above green, because `noteBeatVisionVerdict` is correct and
     * simply was not being told which picture it was counting.
     *
     * That is the defect class this whole programme keeps meeting — the helper is right and the
     * one caller that matters forgets — so the wiring is pinned, not only the helper. There is
     * exactly one place a beat's vision verdict is recorded: `judgeBeatClipRelevance`.
     */
    const pipe = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = pipe.indexOf("noteBeatVisionVerdict(");
    expect(at, "nothing records a beat's vision verdict any more").toBeGreaterThan(-1);
    const call = pipe.slice(at, pipe.indexOf(");", pipe.indexOf("declineCause", at)));
    expect(call, "the verdict is recorded without saying WHICH picture it is about").toContain(
      "params.contentKey || params.clipPath"
    );
    expect(call, "the gate's own decline cause is no longer carried").toContain(
      "decision.declineCause"
    );
    /** And it stays the only one, or a second route would count the same picture twice. */
    expect((pipe.match(/noteBeatVisionVerdict\(/g) ?? []).length).toBe(1);
  });

  it("the ledger line separates the two populations onto their own rows", () => {
    const audit = createBeatOutcomeAudit();
    for (let i = 0; i < 9; i++) noteBeatVisionVerdict(audit, 2, 3, "rejected", "one");
    const line = formatBeatLedgerLine(beatRecord(audit, 2, 3));
    expect(line).toContain("vision_evaluated=1");
    expect(line).toContain("repeated=8");
    expect(line.split("\n")).toHaveLength(2);
  });
});

/* ═══════════════════ what this round may not have touched ═══════════════════ */

describe("the invariants this round is not allowed to have moved", () => {

  it("no quality gate, threshold or timeout was changed", () => {
    const gate = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(require("fs").readFileSync(require("path").join(__dirname, "config.ts"), "utf8")).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
    const policy = readFileSync(join(__dirname, "adoptionPolicy.ts"), "utf8");
    expect(policy).not.toContain("process.env.ENFORCE_FUNNEL_ADOPTION");
    const mismatch = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");
    expect(mismatch).toContain("export function reprieveAllowedFor");
    expect(mismatch.slice(mismatch.indexOf("export function reprieveAllowedFor"))).toContain("return false;");
  });

  it("dedup, the archive and the delivery gate are not mentioned by either fix", () => {
    const audit = readFileSync(join(__dirname, "beatOutcomeAudit.ts"), "utf8");
    expect(audit).not.toMatch(/archiveAssetId|deliveryGate|dedup/i);
  });
});
