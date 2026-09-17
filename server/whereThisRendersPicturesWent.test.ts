/**
 * P0-9 — WHERE THIS RENDER'S PICTURES WENT, ASKED WHERE THE RENDER ACTUALLY ENDED.
 *
 * ── The fourth instance of one defect ───────────────────────────────────────────────────────
 *
 * `assertNoSelectedClipWithoutOutcome` is a good invariant and it had ONE reader: the
 * end-of-render report. A scene with no usable clips throws roughly nine thousand lines earlier,
 * and that throw is the exit the last twenty rounds of failures have actually taken. So on every
 * render this programme has been debugging, the question "did any of the assets we chose end
 * anywhere" was asked by nobody.
 *
 * RONDE 226 found exactly this for `[BeatFunnel]`. RONDE 227 found it again for
 * `beatShortlistViolations`. Both are recorded in this codebase with the same sentence: checking a
 * thing and never reading the answer where it matters is the same defect as not checking it. This
 * is the lineage ledger's instance, and §1 is that it now has two readers and one implementation.
 *
 * ── And the part a fixture cannot settle ────────────────────────────────────────────────────
 *
 * §2 and §3 drive a REAL `VisualSourceLedger` through the REAL event sequences the pipeline emits
 * — `SELECTED` then `ADOPTED`, `SELECTED` then a derived child, `SELECTED` and then nothing — and
 * check what the invariant says about each. That is a stronger claim than a hand-built offender
 * list, and it is still not the strongest one: only a production render can show that the
 * pipeline's own call sites are reached in the order these tests assume. That remains
 * PRODUCTION-UNPROVEN and is stated as such rather than implied to be closed.
 */
import { describe, expect, it } from "vitest";

import {
  VisualSourceLedger,
  assertNoSelectedClipWithoutOutcome,
} from "./visualSourceLineage";
import { stripComments, callSitesOf, lineOf } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const PIPE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));

/** One candidate, opened the way every provider download opens one. */
function withSelectedClip(localPath: string) {
  const ledger = new VisualSourceLedger({ renderId: "p09", videoId: 590 });
  const record = ledger.createLineage({
    sceneIndex: 1,
    beatIndex: 2,
    candidateId: "internet_archive:abc123",
    contentKey: "internet_archive:abc123",
    provider: "internet_archive",
    providerAssetId: "abc123",
    localPath,
    mediaType: "video",
    route: "primary",
  });
  ledger.recordEvent(record.lineageId, "SELECTED", { status: "OK", currentPath: localPath });
  return { ledger, record };
}

/* ═══════════ 1. the invariant is read at both exits ═══════════ */

describe("P0-9 §1 — one implementation, and the exit that throws reads it too", () => {
  it("THE INVARIANT HAS TWO READERS", () => {
    /** `callSitesOf` skips the definition, so this is calls only. */
    const sites = callSitesOf(PIPE, "reportLineageOutcomeInvariant");
    expect(sites.length, "the outcome invariant lost a reader").toBe(2);
  });

  it("AND ONE OF THEM IS THE FAILURE EXIT, BESIDE THE FUNNEL LINES", () => {
    /**
     * Anchored on `beatShortlistViolations`, which RONDE 227 moved to this exit for the same
     * reason. The two belong together: one says which candidates were never put to the editor,
     * the other says what became of the ones that were chosen.
     */
    const anchor = PIPE.indexOf("for (const line of beatShortlistViolations(dedup.beatShortlist)) console.error(line);");
    expect(anchor, "RONDE 227's reader at the failure exit is gone").toBeGreaterThan(0);
    const block = PIPE.slice(anchor, anchor + 700);
    expect(block).toContain("reportLineageOutcomeInvariant(dedup.sourcingCache?.lineage");
  });

  it("and the report route still reads it, through its own report sink", () => {
    const at = PIPE.indexOf('reportLineageOutcomeInvariant(ledger, {');
    expect(at, "the end-of-render reader is gone").toBeGreaterThan(0);
    expect(PIPE.slice(at, at + 300)).toContain('pipelineReport.add("sourcing", line)');
  });

  it("THE TWO READERS DIFFER ONLY IN WHERE THEY PRINT", () => {
    /**
     * A copied block is how the lifecycle audit and this rule came to disagree about
     * DOWNLOAD_FAILED — `unaccountedRecords` documents that and shares an implementation to stop
     * it recurring. The same argument applies one layer up: the offender list, the cap of twelve
     * and the wording must come from one place.
     */
    const def = PIPE.indexOf("function reportLineageOutcomeInvariant(");
    const body = PIPE.slice(def, def + 1600);
    expect(body).toContain("assertNoSelectedClipWithoutOutcome(ledger)");
    expect(body).toContain("selectedWithoutOutcome=0");
    expect(body).toContain("offenders.slice(0, 12)");
    /** And nowhere else may build that wording, or there would be two. */
    expect(PIPE.match(/selectedWithoutOutcome=/g)?.length ?? 0).toBe(2);
    expect(
      callSitesOf(PIPE, "assertNoSelectedClipWithoutOutcome").length,
      "a second caller re-derives the invariant instead of reading the one implementation"
    ).toBe(1);
  });

  it("A RENDER WITH NO LEDGER REPORTS NOTHING — an absent ledger is not a pass", () => {
    /**
     * `selectedWithoutOutcome=0` on a render that kept no lineage at all would be a green light
     * nobody earned, and the failure exit is exactly where a ledger can legitimately be absent.
     */
    const def = PIPE.indexOf("function reportLineageOutcomeInvariant(");
    expect(PIPE.slice(def, def + 1600)).toContain("if (!ledger) return;");
  });

  it("it reports and never throws — an audit must not be able to destroy a finished video", () => {
    const def = PIPE.indexOf("function reportLineageOutcomeInvariant(");
    const body = PIPE.slice(def, def + 1600);
    expect(body).not.toContain("throw ");
    expect(body, "the invariant acquired the power to change a record").not.toContain("recordEvent");
  });
});

/* ═══════════ 2. the real ledger, driven through the real sequences ═══════════ */

describe("P0-9 §2 — selected → outcome, on a ledger that is not a fixture of the answer", () => {
  it("ADOPTED IS NOT AN ENDING — a clip a beat took is not yet a clip the viewer saw", () => {
    /**
     * The distinction this invariant exists for, and the one the fixture for this test got wrong
     * first time. `hasTerminalOutcome` lists REPLACED, REMOVED, CINEMATIC_DROPPED, COMPOSE_DROPPED,
     * a REJECTED status and an unretried DOWNLOAD_FAILED — and FINAL_VIDEO is checked separately.
     * ADOPTED is on none of those lists, correctly: render 555's eighteen offenders had all been
     * adopted, and were then dropped when a coverage repair rebuilt the scene's list.
     */
    const { ledger, record } = withSelectedClip("/w/scene_1_ia_0.mp4");
    ledger.recordEvent(record.lineageId, "ADOPTED", { status: "OK", currentPath: "/w/scene_1_ia_0.mp4" });
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok).toBe(false);
  });

  it("SELECTED THEN DELIVERED IS ACCOUNTED FOR", () => {
    const { ledger, record } = withSelectedClip("/w/scene_1_ia_0b.mp4");
    ledger.recordEvent(record.lineageId, "ADOPTED", { status: "OK", currentPath: "/w/scene_1_ia_0b.mp4" });
    /** The real call the renderer makes with the paths that actually went into the file. */
    expect(ledger.markFinalVideo(["/w/scene_1_ia_0b.mp4"])).toBe(1);
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok).toBe(true);
  });

  it("SELECTED AND THEN NOTHING IS AN OFFENDER — with the route that chose it named", () => {
    const { ledger } = withSelectedClip("/w/scene_1_ia_1.mp4");
    const result = assertNoSelectedClipWithoutOutcome(ledger);
    expect(result.ok).toBe(false);
    expect(result.offenders).toHaveLength(1);
    /**
     * The fields are what make a failure actionable rather than a number: render 555 reported
     * eighteen of these and the shared cause was visible only because each named its route.
     */
    expect(result.offenders[0]).toMatchObject({
      provider: "internet_archive",
      sceneIndex: 1,
      beatIndex: 2,
      route: "primary",
    });
  });

  it("a clip that was REMOVED has an ending — an explained loss is not a disappearance", () => {
    const { ledger } = withSelectedClip("/w/scene_1_ia_2.mp4");
    ledger.recordEventForPath("/w/scene_1_ia_2.mp4", "REMOVED", {
      status: "REMOVED",
      reason: "scene list rebuilt by the coverage repair",
    });
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok).toBe(true);
  });

  it("AND A PARENT WHOSE CHILD WAS ADOPTED IS ACCOUNTED FOR — the transform is not a vanishing", () => {
    /**
     * Render 571's three offenders, all on the providers whose stills need the fair-use transform.
     * The parent ends holding SELECTED and nothing terminal; it became the record directly below
     * it. Driven here through `linkDerivedPath` rather than asserted about, because the link is
     * the thing the invariant reads.
     */
    const RAW = "/w/scene_1_ov_0.jpg";
    const { ledger } = withSelectedClip(RAW);
    const child = ledger.linkDerivedPath("/w/scene_1_ov_0_transformed.mp4", RAW, "TRANSFORMED");
    expect(child, "the transform produced no derived record").not.toBeNull();
    ledger.recordEvent(child!.lineageId, "ADOPTED", { status: "OK" });
    expect(ledger.markFinalVideo(["/w/scene_1_ov_0_transformed.mp4"])).toBe(1);
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok).toBe(true);
  });

  it("but a parent whose CHILD also vanished is still unaccounted — this is not a softer test", () => {
    const RAW = "/w/scene_1_ov_1.jpg";
    const { ledger } = withSelectedClip(RAW);
    const child = ledger.linkDerivedPath("/w/scene_1_ov_1_transformed.mp4", RAW, "TRANSFORMED");
    expect(child).not.toBeNull();
    /** No terminating event anywhere in the chain. Walking it must not invent one. */
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok).toBe(false);
  });
});

/* ═══════════ 3. a render with several assets, counted exactly ═══════════ */

describe("P0-9 §3 — the count is the count, on a mixed render", () => {
  it("FOUR CHOSEN, TWO EXPLAINED, TWO OFFENDERS", () => {
    const ledger = new VisualSourceLedger({ renderId: "p09mix", videoId: 590 });
    const open = (i: number, provider: string) => {
      const r = ledger.createLineage({
        sceneIndex: 0,
        beatIndex: i,
        candidateId: `${provider}:a${i}`,
        contentKey: `${provider}:a${i}`,
        provider,
        providerAssetId: `a${i}`,
        localPath: `/w/s0b${i}_${provider}.mp4`,
        mediaType: "video",
        route: i % 2 === 0 ? "primary" : "rescue",
      });
      ledger.recordEvent(r.lineageId, "SELECTED", { status: "OK" });
      return r;
    };
    const a = open(0, "wikimedia");
    open(1, "pexels");
    const c = open(2, "internet_archive");
    open(3, "openverse");
    ledger.recordEvent(a.lineageId, "ADOPTED", { status: "OK" });
    ledger.recordEvent(c.lineageId, "ADOPTED", { status: "OK" });
    /** One delivered, one explained away. Two endings, two different kinds. */
    expect(ledger.markFinalVideo(["/w/s0b0_wikimedia.mp4"])).toBe(1);
    ledger.recordEventForPath("/w/s0b2_internet_archive.mp4", "REMOVED", {
      status: "REMOVED",
      reason: "replaced by the coverage repair",
    });

    const result = assertNoSelectedClipWithoutOutcome(ledger);
    expect(result.ok).toBe(false);
    expect(result.offenders).toHaveLength(2);
    expect(result.offenders.map((o) => o.provider).sort()).toEqual(["openverse", "pexels"]);
  });

  it("AND A RENDER THAT CHOSE NOTHING IS NOT A RENDER THAT ACCOUNTED FOR EVERYTHING", () => {
    /**
     * A ledger holding records nobody ever selected passes, correctly — the invariant is about
     * assets the render CHOSE. This is pinned so a future change cannot make "ok" mean "we found
     * no selections", which would be true of a render whose selection stage never ran.
     */
    const ledger = new VisualSourceLedger({ renderId: "p09none", videoId: 590 });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "pexels:never",
      contentKey: "pexels:never",
      provider: "pexels",
      providerAssetId: "never",
      localPath: "/w/never.mp4",
      mediaType: "video",
      route: "primary",
    });
    expect(assertNoSelectedClipWithoutOutcome(ledger).ok).toBe(true);
    /** The distinction that keeps the pass honest: nothing was chosen, so nothing was lost. */
    expect(ledger.allEvents().some((e) => e.stage === "SELECTED")).toBe(false);
  });
});

/* ═══════════ 4. what this file does not claim ═══════════ */

describe("P0-9 §4 — the boundary of this proof", () => {
  it("THE PIPELINE'S OWN SELECTED SITES EXIST AND ARE NOT ALONE", () => {
    /**
     * This is the strongest structural statement available without a production render: the
     * pipeline records SELECTED in more than one place, and it records terminating events in more
     * than one place. It does NOT prove they are reached in the right order on every path — that
     * is a runtime fact about a real render, and pretending otherwise is the exact move this
     * programme's proof levels exist to forbid.
     */
    const selected = PIPE.match(/recordEvent\([^)]*"SELECTED"/g)?.length ?? 0;
    const adopted = PIPE.match(/recordEvent\([^)]*"ADOPTED"/g)?.length ?? 0;
    const removed = PIPE.match(/recordEventForPath\([^)]*"REMOVED"/g)?.length ?? 0;
    expect(selected, "nothing records SELECTED any more").toBeGreaterThanOrEqual(2);
    expect(adopted, "nothing records ADOPTED any more").toBeGreaterThanOrEqual(2);
    expect(removed, "nothing records REMOVED any more").toBeGreaterThanOrEqual(2);
  });

  it("and every SELECTED site names the ledger it writes to, never an ambient one", () => {
    for (const at of callSitesOf(PIPE, "recordEvent")) {
      const call = PIPE.slice(at, at + 160);
      if (!call.includes('"SELECTED"')) continue;
      const before = PIPE.slice(Math.max(0, at - 80), at);
      expect(
        /\blineage\.$|\bfunnel\.$|\bledger\.$|composeLedger\.$/.test(before.trimEnd()),
        `a SELECTED is recorded against an unnamed ledger at line ${lineOf(PIPE, at)}`
      ).toBe(true);
    }
  });
});
