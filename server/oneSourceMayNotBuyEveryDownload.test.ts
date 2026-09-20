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

import {
  capCandidatesPerSource,
  isStockSource,
  shortlistCapForSource,
} from "./retrievalFunnel";
import {
  beatCandidateAccountingHolds,
  beatRecord,
  createBeatOutcomeAudit,
  formatBeatLedgerLine,
  noteBeatVisionVerdict,
} from "./beatOutcomeAudit";

/* ═══════════════════ A. the download cap ═══════════════════ */

const c = (source: string, id: string) => ({ source, id });

describe("the per-source download cap is one rule, and both routes read it", () => {
  it("STOCK GETS ONE SLOT — the number the funnel has used since FASE 4", () => {
    expect(shortlistCapForSource("pexels")).toBe(1);
    expect(shortlistCapForSource("pixabay")).toBe(1);
    expect(isStockSource("pexels")).toBe(true);
    expect(isStockSource("wikimedia")).toBe(false);
  });

  it("an open or historical source gets two, and the curated archive three", () => {
    expect(shortlistCapForSource("wikimedia")).toBe(2);
    expect(shortlistCapForSource("internet_archive")).toBe(2);
    expect(shortlistCapForSource("openverse")).toBe(2);
    expect(shortlistCapForSource("archive")).toBe(3);
  });

  it("RENDER 593'S BEAT: eight stock candidates become one download attempt", () => {
    const eightPexels = Array.from({ length: 8 }, (_, i) => c("pexels", `p${i}`));
    expect(capCandidatesPerSource(eightPexels, 8)).toEqual([c("pexels", "p0")]);
  });

  it("and the source that was being crowded out keeps its slots", () => {
    const mixed = [
      c("pexels", "p0"),
      c("pexels", "p1"),
      c("pexels", "p2"),
      c("wikimedia", "w0"),
      c("wikimedia", "w1"),
      c("openverse", "o0"),
    ];
    const out = capCandidatesPerSource(mixed, 6);
    expect(out.filter((x) => x.source === "pexels")).toHaveLength(1);
    expect(out.filter((x) => x.source === "wikimedia")).toHaveLength(2);
    expect(out.filter((x) => x.source === "openverse")).toHaveLength(1);
  });

  it("NO PROVIDER IS SWITCHED OFF — a beat whose pool is only stock still asks stock", () => {
    /**
     * The whole safety argument. The cap removes DUPLICATE attempts at one library, never the
     * library. A beat with nothing else keeps its attempt, and a beat this leaves empty falls
     * through to the cascade and the rescue ladder exactly as a beat that found nothing always has.
     */
    expect(capCandidatesPerSource([c("pexels", "only")], 8)).toEqual([c("pexels", "only")]);
    expect(capCandidatesPerSource([c("pixabay", "a"), c("pixabay", "b")], 8)).toHaveLength(1);
  });

  it("the non-stock backfill is the funnel's, kept verbatim", () => {
    /**
     * Unused room goes back to what the cap refused — NON-STOCK ONLY. The exclusion is the
     * funnel's own and for its own stated reason: six generic stock clips of one query are
     * interchangeable, so fetching six to fill six slots buys nothing but wall time. Different
     * holdings of different archival material are not interchangeable, and get the room back.
     */
    const archiveHeavy = Array.from({ length: 6 }, (_, i) => c("wikimedia", `w${i}`));
    expect(capCandidatesPerSource(archiveHeavy, 6)).toHaveLength(6);
    const stockHeavy = Array.from({ length: 6 }, (_, i) => c("pexels", `p${i}`));
    expect(capCandidatesPerSource(stockHeavy, 6)).toHaveLength(1);
  });

  it("it only ever REMOVES — the result is a subsequence of the input, in the caller's order", () => {
    const mixed = [
      c("wikimedia", "w0"),
      c("pexels", "p0"),
      c("wikimedia", "w1"),
      c("pexels", "p1"),
      c("openverse", "o0"),
    ];
    const out = capCandidatesPerSource(mixed, 5);
    let at = -1;
    for (const kept of out) {
      const next = mixed.indexOf(kept);
      expect(next, "the caller's ranking order was not preserved").toBeGreaterThan(at);
      at = next;
    }
    expect(out.every((x) => mixed.includes(x))).toBe(true);
  });

  it("a zero or empty budget invents nothing", () => {
    expect(capCandidatesPerSource([c("pexels", "p")], 0)).toEqual([]);
    expect(capCandidatesPerSource([], 8)).toEqual([]);
  });

  it("THE POOL ROUTE READS IT — the half of the fix that is not in this module", () => {
    const pipe = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = pipe.indexOf("poolCandidates = capCandidatesPerSource(");
    expect(at, "the scene-pool download loop is uncapped again").toBeGreaterThan(-1);
    /** And it runs BEFORE the loop that downloads, or it caps nothing. */
    const loopAt = pipe.indexOf("for (const candidate of poolCandidates) {", at);
    expect(loopAt).toBeGreaterThan(at);
  });

  it("and the funnel still reads the same function, so the two cannot drift", () => {
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(funnel).toContain("const capFor = (source: FunnelCandidateSource): number => shortlistCapForSource(source);");
  });
});

/* ═══════════════════ B. one picture is one candidate ═══════════════════ */

describe("a candidate asked about fifteen times is still one candidate", () => {
  it("REPEATED LOOKUPS DO NOT MULTIPLY THE CANDIDATE", () => {
    const audit = createBeatOutcomeAudit();
    for (let i = 0; i < 15; i++) {
      noteBeatVisionVerdict(audit, 0, 0, "rejected", "contentkey:abc");
    }
    const rec = beatRecord(audit, 0, 0);
    expect(rec.visionRejected, "one picture counted more than once").toBe(1);
    expect(rec.lookups, "the cost of asking is no longer visible").toBe(15);
    expect(rec.lookupsRepeated).toBe(14);
    expect(rec.countedCandidates?.size).toBe(1);
    expect(beatCandidateAccountingHolds(rec)).toBe(true);
  });

  it("distinct candidates are still counted distinctly", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatVisionVerdict(audit, 1, 2, "accepted", "k1");
    noteBeatVisionVerdict(audit, 1, 2, "rejected", "k2");
    noteBeatVisionVerdict(audit, 1, 2, "unclear", "k3");
    noteBeatVisionVerdict(audit, 1, 2, "never_asked", "k4", "BEAT_LOOK_CEILING");
    const rec = beatRecord(audit, 1, 2);
    expect([rec.visionAccepted, rec.visionRejected, rec.visionUnclear, rec.visionNeverAsked]).toEqual([1, 1, 1, 1]);
    expect(rec.lookups).toBe(4);
    expect(rec.lookupsRepeated).toBe(0);
    expect(beatCandidateAccountingHolds(rec)).toBe(true);
  });

  it("THE FIRST VERDICT DECIDES WHICH COUNTER A CANDIDATE JOINS", () => {
    /**
     * The four counters claim to partition distinct candidates. If a later ask about the same
     * picture could move it from one counter to another they would not partition anything — and
     * a `never_asked` that later becomes `rejected` would add one to each.
     */
    const audit = createBeatOutcomeAudit();
    noteBeatVisionVerdict(audit, 0, 0, "never_asked", "same", "BEAT_LOOK_CEILING");
    noteBeatVisionVerdict(audit, 0, 0, "rejected", "same");
    noteBeatVisionVerdict(audit, 0, 0, "accepted", "same");
    const rec = beatRecord(audit, 0, 0);
    expect(rec.visionNeverAsked).toBe(1);
    expect(rec.visionRejected).toBe(0);
    expect(rec.visionAccepted).toBe(0);
    expect(rec.lookups).toBe(3);
    expect(beatCandidateAccountingHolds(rec)).toBe(true);
  });

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

  it("THE INVARIANT THE TYPE HAS ALWAYS DECLARED NOW HOLDS", () => {
    /**
     * "they sum to the number of candidates the gate returned a verdict for, and never to more."
     * Asserted rather than trusted, against the shape render 593 actually produced: a handful of
     * pictures, asked about many times over.
     */
    const audit = createBeatOutcomeAudit();
    const keys = ["a", "b", "c", "d", "e"];
    for (let round = 0; round < 12; round++) {
      for (const k of keys) noteBeatVisionVerdict(audit, 3, 1, "rejected", k);
    }
    const rec = beatRecord(audit, 3, 1);
    const verdicts = rec.visionAccepted + rec.visionRejected + rec.visionUnclear + rec.visionNeverAsked;
    expect(verdicts).toBe(keys.length);
    expect(verdicts).toBeLessThanOrEqual(rec.countedCandidates!.size);
    expect(rec.lookups).toBe(60);
    expect(beatCandidateAccountingHolds(rec)).toBe(true);
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
  it("THE SUBJECT ANCHOR OF 14b7cc2 IS INTACT", () => {
    const plan = readFileSync(join(__dirname, "visualSearchPlan.ts"), "utf8");
    expect(plan).toContain("export function ensureSubjectAnchor");
    expect(plan).toContain("export function subjectAnchorForBeat");
    expect((plan.match(/anchorTierQueries\(/g) ?? []).length).toBe(5);
  });

  it("no quality gate, threshold or timeout was changed", () => {
    const gate = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");
    expect(gate).toContain('return process.env.SEARCH_GATE_STRICT !== "false";');
    const policy = readFileSync(join(__dirname, "adoptionPolicy.ts"), "utf8");
    expect(policy).toContain('return process.env.ENFORCE_FUNNEL_ADOPTION !== "false";');
    const mismatch = readFileSync(join(__dirname, "visualMismatchFeedback.ts"), "utf8");
    expect(mismatch).toContain("export function reprieveAllowedFor");
    expect(mismatch.slice(mismatch.indexOf("export function reprieveAllowedFor"))).toContain("return false;");
  });

  it("the download BUDGET is untouched — only who may fill it changed", () => {
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(funnel).toContain("export const MAX_FUNNEL_CANDIDATES_TO_SCORE = 6;");
    expect(funnel).toContain("const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;");
    expect(funnel).toContain("const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;");
  });

  it("dedup, the archive and the delivery gate are not mentioned by either fix", () => {
    const audit = readFileSync(join(__dirname, "beatOutcomeAudit.ts"), "utf8");
    expect(audit).not.toMatch(/archiveAssetId|deliveryGate|dedup/i);
  });
});
