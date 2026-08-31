import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  createClipRejectAudit,
  recordClipReject,
  beatRejectCount,
  beatRejectReasons,
  summarizeClipRejectAudit,
  formatClipRejectAuditCapacity,
  CLIP_REJECT_DETAIL_CAPACITY,
} from "./clipRejectAudit";
import {
  createBeatOutcomeAudit,
  noteBeatCandidatesOffered,
  noteBeatEligible,
  noteBeatAdopted,
  noteBeatPlaceholder,
  noteBeatVision,
  resolveBeatStatus,
  finalizeBeatOutcomes,
  collectReportableBeats,
  formatBeatFunnelLine,
  summarizeBeatOutcomes,
  beatRecord,
  renderBeatFunnelReport,
  formatEligibleNotAdoptedByProvider,
} from "./beatOutcomeAudit";

/**
 * RONDE 70 — the render has to be able to explain itself.
 *
 * Render 534 produced 398 candidates, 8 clips and 23 beats without a picture, and the logs could
 * not say where the other 390 went. Three reasons, all of them measurement defects rather than
 * sourcing defects:
 *
 *   1. clipRejectAudit stopped recording after 80 entries, silently and chronologically — so
 *      late beats reported rejected=0, which is indistinguishable from "nothing was found".
 *   2. [VisualCoverage] only fires on the placeholder path, so successful beats logged nothing.
 *   3. "passed every gate but never became a clip" had no counter at all.
 *
 * These tests pin the measurement, not any sourcing behaviour.
 */

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ───────────────────────── 1. AUDIT OVERFLOW ───────────────────────── */

describe("RONDE 70 §1 — the reject audit no longer loses information silently", () => {
  it("more rejections than the cap: the DETAIL is bounded and the loss is counted", () => {
    const audit = createClipRejectAudit(10);
    for (let i = 0; i < 25; i++) {
      recordClipReject(audit, 0, 0, `/tmp/c${i}.mp4`, "vision_gate", "q");
    }
    expect(audit.entries).toHaveLength(10);
    expect(audit.capacity).toBe(10);
    expect(audit.recorded).toBe(25);
    expect(audit.dropped).toBe(15);
    // recorded is every call; dropped is the ones whose detail was not stored.
    expect(audit.recorded - audit.dropped).toBe(audit.entries.length);
  });

  it("the overflow is REPORTED, not just held — auditEntriesRecorded/Dropped/Capacity", () => {
    const audit = createClipRejectAudit(4);
    for (let i = 0; i < 9; i++) recordClipReject(audit, 1, 2, `/tmp/x${i}.mp4`, "beat_image_gate");
    const line = formatClipRejectAuditCapacity(audit);
    expect(line).toContain("auditEntriesRecorded=9");
    expect(line).toContain("auditEntriesDropped=5");
    expect(line).toContain("auditCapacity=4");
  });

  it("NO FALSE rejected=0 — a late beat past the cap still reports its real count", () => {
    // The render-534 shape: an early beat floods the audit, a late beat is refused afterwards.
    const audit = createClipRejectAudit(20);
    for (let i = 0; i < 100; i++) recordClipReject(audit, 0, 0, `/tmp/early${i}.mp4`, "vision_gate");
    for (let i = 0; i < 7; i++) recordClipReject(audit, 9, 3, `/tmp/late${i}.mp4`, "beat_image_gate");

    // The detail array holds nothing at all about the late beat.
    expect(audit.entries.filter((e) => e.sceneIndex === 9)).toHaveLength(0);
    // The tally still knows exactly what happened to it. This is the whole point.
    expect(beatRejectCount(audit, 9, 3)).toBe(7);
    expect(beatRejectReasons(audit, 9, 3)).toEqual([["beat_image_gate", 7]]);
    // And the early beat is not overstated either.
    expect(beatRejectCount(audit, 0, 0)).toBe(100);
  });

  it("the render-wide summary is complete past the cap too", () => {
    const audit = createClipRejectAudit(5);
    for (let i = 0; i < 30; i++) recordClipReject(audit, i, 0, `/tmp/a${i}.mp4`, "vision_gate");
    for (let i = 0; i < 12; i++) recordClipReject(audit, i, 1, `/tmp/b${i}.mp4`, "beat_image_gate");
    // Summing the 5 stored entries would give 5. Summing the tally gives the truth.
    expect(summarizeClipRejectAudit(audit)).toEqual({ vision_gate: 30, beat_image_gate: 12 });
  });

  it("a beat nothing was ever recorded for reads zero, not undefined", () => {
    const audit = createClipRejectAudit();
    expect(beatRejectCount(audit, 4, 4)).toBe(0);
    expect(beatRejectReasons(audit, 4, 4)).toEqual([]);
  });

  it("the cap still bounds memory — it was made honest, not removed", () => {
    expect(CLIP_REJECT_DETAIL_CAPACITY).toBeGreaterThan(80);
    expect(CLIP_REJECT_DETAIL_CAPACITY).toBeLessThanOrEqual(2000);
    const audit = createClipRejectAudit();
    for (let i = 0; i < CLIP_REJECT_DETAIL_CAPACITY * 3; i++) {
      recordClipReject(audit, 0, i, `/tmp/z${i}.mp4`, "vision_gate");
    }
    expect(audit.entries.length).toBe(CLIP_REJECT_DETAIL_CAPACITY);
  });

  it("no reject REASON was added, removed or renamed — only the counting changed", () => {
    const src = PIPELINE();
    for (const reason of [
      "documentary_beat_gate", "entity_evidence", "off_topic_visual", "vision_gate",
      "beat_image_gate", "baked_text", "off_topic_protest", "still_cap",
    ]) {
      expect(src).toContain(`"${reason}"`);
    }
  });
});

/* ───────────────────────── 2. EVERY BEAT ───────────────────────── */

describe("RONDE 70 §2 — every beat gets exactly one VisualCoverageFinal line", () => {
  const planned = [
    { sceneIndex: 0, beatIndex: 0 },
    { sceneIndex: 0, beatIndex: 1 },
    { sceneIndex: 1, beatIndex: 0 },
    { sceneIndex: 1, beatIndex: 1 },
    { sceneIndex: 1, beatIndex: 2 },
  ];

  it("a multi-beat render reports every beat, adopted and failed alike", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 0, 0, "wikimedia", "wiki_a.mp4");
    noteBeatPlaceholder(audit, 1, 1);
    // Beats 0b1, 1b0 and 1b2 recorded nothing at all — they must still be reported.
    const rows = finalizeBeatOutcomes(audit, collectReportableBeats(audit, planned, []), () => 0);
    expect(rows).toHaveLength(planned.length);
    const keys = rows.map((r) => `s${r.record.sceneIndex}b${r.record.beatIndex}`);
    expect(keys).toEqual(["s0b0", "s0b1", "s1b0", "s1b1", "s1b2"]);
    // Exactly one row per beat — no duplicates, so no beat can carry two statuses.
    expect(new Set(keys).size).toBe(rows.length);
  });

  it("a beat the plan never named but the audit saw is still reported", () => {
    // The fast-path and rescue routes fill a scene without recording a beat list.
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 7, 4, "internet_archive", "ia.mp4");
    const rows = finalizeBeatOutcomes(audit, collectReportableBeats(audit, planned, []), () => 0);
    expect(rows.map((r) => `s${r.record.sceneIndex}b${r.record.beatIndex}`)).toContain("s7b4");
  });

  it("a beat only the REJECT tally saw is still reported", () => {
    const audit = createBeatOutcomeAudit();
    const rejects = createClipRejectAudit();
    recordClipReject(rejects, 3, 9, "/tmp/r.mp4", "vision_gate");
    const beats = collectReportableBeats(audit, planned, rejects.perBeat.keys());
    expect(beats).toContainEqual({ sceneIndex: 3, beatIndex: 9 });
  });

  it("the beats come out in render order, not insertion order", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatAdopted(audit, 2, 1, "pexels", "p.mp4");
    noteBeatAdopted(audit, 0, 3, "wikimedia", "w.mp4");
    const rows = finalizeBeatOutcomes(audit, collectReportableBeats(audit, [], []), () => 0);
    expect(rows.map((r) => [r.record.sceneIndex, r.record.beatIndex])).toEqual([[0, 3], [2, 1]]);
  });

  it("the line carries every funnel stage the audit asks for", () => {
    const rec = beatRecord(createBeatOutcomeAudit(), 1, 3);
    rec.offered = 12;
    rec.eligible = 2;
    rec.adopted = 1;
    rec.visionJudged = 3;
    rec.visionUnavailable = 1;
    rec.origin = "wikimedia";
    rec.selected = "File_Hitler_1945.mp4";
    const line = formatBeatFunnelLine(rec, "adopted", 9, "beat_image_gate:7,vision_gate:2");
    expect(line).toContain("[VisualCoverageFinal]");
    expect(line).toContain("scene=1 beat=3");
    expect(line).toContain("status=adopted");
    expect(line).toContain("origin=wikimedia");
    expect(line).toContain("offered=12");
    expect(line).toContain("rejected=9");
    expect(line).toContain("eligible=2");
    expect(line).toContain("adopted=1");
    expect(line).toContain("visionJudged=3");
    expect(line).toContain("visionUnavailable=1");
    expect(line).toContain("topRejects=beat_image_gate:7,vision_gate:2");
    expect(line).toContain("selected=File_Hitler_1945.mp4");
  });

  it("a failed beat says selected=none rather than omitting the field", () => {
    const rec = beatRecord(createBeatOutcomeAudit(), 1, 3);
    const line = formatBeatFunnelLine(rec, "placeholder", 4, "vision_gate:4");
    expect(line).toContain("status=placeholder");
    expect(line).toContain("selected=none");
    expect(line).toContain("origin=none");
  });

  it("RUNTIME — the report really produces one line per beat, plus a TOTAL and the cap line", () => {
    // Counted, not read off the source. A source assertion cannot tell `for (const r of rows)`
    // from `for (const r of rows.slice(1))`, which is precisely how RONDE 62's ceiling passed
    // its tests while bounding nothing.
    const audit = createBeatOutcomeAudit();
    const rejects = createClipRejectAudit();
    noteBeatAdopted(audit, 0, 0, "wikimedia", "w.mp4");
    noteBeatPlaceholder(audit, 1, 1);
    recordClipReject(rejects, 1, 1, "/tmp/a.mp4", "beat_image_gate");

    const lines = renderBeatFunnelReport(audit, planned, rejects);
    const beatLines = lines.filter((l) => /\bscene=\d+ beat=\d+\b/.test(l));
    expect(beatLines).toHaveLength(planned.length);
    // Every planned beat appears exactly once, by name.
    for (const b of planned) {
      const hits = beatLines.filter((l) => l.includes(`scene=${b.sceneIndex} beat=${b.beatIndex} `));
      expect(hits).toHaveLength(1);
    }
    expect(lines.filter((l) => l.includes("TOTAL beats="))).toHaveLength(1);
    expect(lines.find((l) => l.includes("TOTAL beats="))).toContain(`TOTAL beats=${planned.length}`);
    expect(lines.some((l) => l.includes("auditEntriesRecorded="))).toBe(true);
  });

  it("RUNTIME — the TOTAL adds up to the number of beat lines", () => {
    const audit = createBeatOutcomeAudit();
    const rejects = createClipRejectAudit();
    noteBeatAdopted(audit, 0, 0, "wikimedia", "w.mp4");
    noteBeatAdopted(audit, 0, 1, "pexels", "p.mp4");
    noteBeatPlaceholder(audit, 1, 0);
    noteBeatEligible(audit, 1, 1);
    noteBeatCandidatesOffered(audit, 1, 2, 3);
    recordClipReject(rejects, 1, 2, "/tmp/a.mp4", "vision_gate");

    const lines = renderBeatFunnelReport(audit, planned, rejects);
    const total = lines.find((l) => l.includes("TOTAL beats="))!;
    expect(total).toContain("TOTAL beats=5");
    expect(total).toContain("adopted=2");
    expect(total).toContain("placeholder=1");
    expect(total).toContain("eligibleNotAdopted=1");
    expect(total).toContain("rejected=1");
    const nums = [...total.matchAll(/(?:adopted|placeholder|eligibleNotAdopted|rejected|noCandidates|unknown)=(\d+)/g)]
      .map((m) => Number(m[1]));
    expect(nums.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("the pipeline calls the report and prints every line it returns", () => {
    const src = PIPELINE();
    expect(src).toContain("for (const line of renderBeatFunnelReport(");
    expect(src).toContain("console.log(line);");
    expect(src).toContain("formatEligibleNotAdoptedByProvider(visualDedup.sourcingCache.metrics)");
  });

  it("RUNTIME — the provider-level category D line reports the gap", () => {
    const line = formatEligibleNotAdoptedByProvider([
      ["wikimedia", { eligibleCount: 3, adoptedCount: 2 }],
      ["internet_archive", { eligibleCount: 0, adoptedCount: 0 }],
      ["youtube_cc", { eligibleCount: 5, adoptedCount: 0 }],
    ]);
    expect(line).toContain("wikimedia: eligible=3 adopted=2 eligibleNotAdopted=1");
    expect(line).toContain("youtube_cc: eligible=5 adopted=0 eligibleNotAdopted=5");
    // A provider that neither qualified nor adopted anything is not listed as a loss.
    expect(line).not.toContain("internet_archive");
  });
});

/* ───────────────── 3 + 4. STATUS, AND CATEGORY D ───────────────── */

describe("RONDE 70 §3/§4 — adopted, placeholder, and the gap between eligible and adopted", () => {
  it("ADOPTED — a beat with a real asset reports status=adopted and its origin", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 0, 0, 6);
    noteBeatEligible(audit, 0, 0);
    noteBeatAdopted(audit, 0, 0, "wikimedia", "File_Adolf_Hitler_1945.mp4");
    const [row] = finalizeBeatOutcomes(audit, collectReportableBeats(audit, [], []), () => 3);
    expect(row!.status).toBe("adopted");
    expect(row!.record.origin).toBe("wikimedia");
    expect(row!.record.selected).toBe("File_Adolf_Hitler_1945.mp4");
  });

  it("PLACEHOLDER — a beat with nothing usable reports status=placeholder", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 1, 3, 5);
    noteBeatPlaceholder(audit, 1, 3);
    const [row] = finalizeBeatOutcomes(audit, collectReportableBeats(audit, [], []), () => 5);
    expect(row!.status).toBe("placeholder");
    expect(row!.record.adopted).toBe(0);
  });

  it("ELIGIBLE BUT NOT ADOPTED — the gate said yes and the clip never arrived", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatCandidatesOffered(audit, 2, 0, 4);
    noteBeatEligible(audit, 2, 0);
    noteBeatEligible(audit, 2, 0);
    // No noteBeatAdopted: the file failed validation, or the fair-use transform produced nothing.
    const [row] = finalizeBeatOutcomes(audit, collectReportableBeats(audit, [], []), () => 1);
    expect(row!.status).toBe("eligible_not_adopted");
    expect(row!.record.eligible).toBe(2);
    expect(row!.record.adopted).toBe(0);
  });

  it("NO FALSE D — an adopted beat is never also eligible_not_adopted", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatEligible(audit, 3, 1);
    noteBeatEligible(audit, 3, 1);
    noteBeatEligible(audit, 3, 1);
    noteBeatAdopted(audit, 3, 1, "sepiasearch", "s.mp4");
    const [row] = finalizeBeatOutcomes(audit, collectReportableBeats(audit, [], []), () => 12);
    // Three candidates passed the gates, one became the clip. The beat is adopted, full stop.
    expect(row!.status).toBe("adopted");
    expect(row!.status).not.toBe("eligible_not_adopted");
  });

  it("adopted also wins over placeholder — one status per beat, never two", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatPlaceholder(audit, 5, 0);
    noteBeatAdopted(audit, 5, 0, "pexels", "p.mp4");
    const [row] = finalizeBeatOutcomes(audit, collectReportableBeats(audit, [], []), () => 0);
    expect(row!.status).toBe("adopted");
  });

  it("vision is attributed to the beat that asked — judged and unavailable stay separate", () => {
    const audit = createBeatOutcomeAudit();
    noteBeatVision(audit, 2, 5, "judged");
    noteBeatVision(audit, 2, 5, "judged");
    noteBeatVision(audit, 2, 5, "unavailable");
    noteBeatVision(audit, 3, 0, "unavailable");
    const rec = beatRecord(audit, 2, 5);
    expect(rec.visionJudged).toBe(2);
    expect(rec.visionUnavailable).toBe(1);
    // A different beat's outage does not land on this one — "said no" and "could not look"
    // lead to opposite conclusions, and so do "this beat" and "some other beat".
    expect(beatRecord(audit, 3, 0).visionJudged).toBe(0);
    expect(beatRecord(audit, 3, 0).visionUnavailable).toBe(1);
    const line = formatBeatFunnelLine(rec, "adopted", 0, "none");
    expect(line).toContain("visionJudged=2");
    expect(line).toContain("visionUnavailable=1");
  });

  it("the four failure shapes are told apart", () => {
    const rec = () => beatRecord(createBeatOutcomeAudit(), 0, 0);
    // A: nothing was ever offered.
    expect(resolveBeatStatus(rec(), 0)).toBe("no_candidates");
    // C: candidates were offered and every one was refused.
    const refused = rec();
    refused.offered = 5;
    expect(resolveBeatStatus(refused, 5)).toBe("rejected");
    // D: something passed the gates and still did not arrive.
    const d = rec();
    d.offered = 5;
    d.eligible = 1;
    expect(resolveBeatStatus(d, 4)).toBe("eligible_not_adopted");
    // E: it arrived.
    const e = rec();
    e.offered = 5;
    e.eligible = 1;
    e.adopted = 1;
    expect(resolveBeatStatus(e, 4)).toBe("adopted");
  });

  it("a beat that reached no terminal point at all is 'unknown', never missing", () => {
    const odd = beatRecord(createBeatOutcomeAudit(), 0, 0);
    odd.offered = 3;
    // Offered candidates, nothing rejected, nothing eligible, no placeholder — should not
    // happen, and if it does the report must say so rather than drop the beat.
    expect(resolveBeatStatus(odd, 0)).toBe("unknown");
  });

  it("the roll-up counts every beat exactly once", () => {
    const rows = [
      { status: "adopted" as const }, { status: "adopted" as const },
      { status: "placeholder" as const }, { status: "eligible_not_adopted" as const },
      { status: "rejected" as const }, { status: "no_candidates" as const },
    ];
    const t = summarizeBeatOutcomes(rows);
    expect(t.adopted).toBe(2);
    expect(t.placeholder).toBe(1);
    expect(t.eligible_not_adopted).toBe(1);
    expect(t.rejected).toBe(1);
    expect(t.no_candidates).toBe(1);
    expect(Object.values(t).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });

  it("WIRING — each funnel note is called from the pipeline, exactly once, at its own point", () => {
    // The audit module is exercised directly above; this pins that the pipeline actually calls
    // it. Removing any one of these hooks makes the corresponding stage silently read zero for
    // every beat of every render — the exact failure mode this round exists to end.
    const src = PIPELINE();
    const callsOf = (fn: string) =>
      src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes(`${fn}(`)).length;
    // Import lines carry no parenthesis, so these are call sites only — one each.
    expect(callsOf("noteBeatCandidatesOffered")).toBe(1);
    expect(callsOf("noteBeatEligible")).toBe(1);
    expect(callsOf("noteBeatAdopted")).toBe(1);
    expect(callsOf("noteBeatPlaceholder")).toBe(1);
    /**
     * SUPERSEDED BY RONDE 103, deliberately.
     *
     * RONDE 70's rule is that vision spend is attributed to the beat that asked for it, at every
     * beat-attributable judgement site. There were two such sites and one helper reading the
     * state's counters either side of the call. There are now five routes into one gate, so the
     * helper takes the spend the gate reports instead of bracketing the call — the same
     * attribution, from the one place that can see every route.
     */
    expect(callsOf("noteVisionDelta")).toBe(0);
    // Its declaration plus one call from each route that can spend a judgement.
    expect(callsOf("noteVisionSpend")).toBeGreaterThanOrEqual(4);
    // Still counts judged and unavailable separately, and still only there.
    expect(callsOf("noteBeatVision")).toBe(2);
  });

  it("WIRING — eligible is noted at the acceptance point, adopted only inside markAdopted", () => {
    const src = PIPELINE();
    // The acceptance point: every gate passed, the clip not yet on the timeline.
    const accept = src.indexOf('const providerOfKey = contentKey.split(":")[0] || "unknown";');
    expect(accept).toBeGreaterThan(-1);
    const acceptBlock = src.slice(accept, accept + 900);
    expect(acceptBlock).toContain("eligibleCount++");
    expect(acceptBlock).toContain("noteBeatEligible(dedup.beatOutcomeAudit, sceneIndex, beatIndex);");
    // adopted is NOT noted here — that is the whole distinction.
    const beforeMark = src.slice(accept, src.indexOf("const markAdopted", accept));
    expect(beforeMark).not.toContain("noteBeatAdopted");
    expect(beforeMark).not.toContain("adoptedCount++");
  });

  it("WIRING — the placeholder note sits in the block that hands out the placeholder", () => {
    const src = PIPELINE();
    const note = src.indexOf("noteBeatPlaceholder(dedup.beatOutcomeAudit, scene.index, beat.index);");
    expect(note).toBeGreaterThan(-1);
    const loop = src.indexOf("for (let attempt = 0; attempt < 4; attempt++)", note);
    expect(loop).toBeGreaterThan(note);
    // And it is the same block that prints the per-beat [VisualCoverage] warning.
    expect(src.slice(note, loop)).toContain("[VisualCoverage] s${scene.index}b${beat.index}");
  });

  it("eligibleCount and adoptedCount are their own counters — acceptedCount is NOT aliased", () => {
    const src = PIPELINE();
    expect(src).toContain("eligibleCount: number;");
    expect(src).toContain("adoptedCount: number;");
    // acceptedCount still exists and is still bumped exactly where it always was.
    expect(src).toContain('providerMetrics(dedup.sourcingCache, providerOfKey).acceptedCount++;');
    // The two new counters are bumped at two DIFFERENT points, not the same line.
    expect(src).toContain('providerMetrics(dedup.sourcingCache, providerOfKey).eligibleCount++;');
    expect(src).toContain('providerMetrics(dedup.sourcingCache, providerOfKey).adoptedCount++;');
    // adoptedCount lives in the single adoption choke point, after every gate AND after the
    // file validation and fair-use transform that can still fail.
    const mark = src.indexOf("const markAdopted = (finalPath: string): string => {");
    expect(mark).toBeGreaterThan(-1);
    expect(src.slice(mark, mark + 400)).toContain("adoptedCount++");
    for (const ret of ["return markAdopted(p);", "return markAdopted(transformed);", "return markAdopted(trimmed);"]) {
      expect(src).toContain(ret);
    }
  });
});

/* ───────────────── 6 + 7. RONDE 69 MUST SURVIVE ───────────────── */

describe("RONDE 70 §6/§7 — Ronde 69 is still intact", () => {
  it("Wikimedia HTTP failures still log their status, and still nothing else", () => {
    const src = PIPELINE();
    const start = src.indexOf("function logWikimediaHttpFailure(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    for (const forbidden of ["url", "Url", "URL", "json(", "text(", "body", "headers", "KEY", "key"]) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain("resp.status");
    expect(body).toContain("resp.statusText");
    // All five !resp.ok sites still log before they count.
    const lines = src.split("\n");
    const silent: number[] = [];
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
      if (!l.includes("markWikimediaSearchResult(false)")) return;
      if (l.includes("isScopeAbortError")) return;
      if (!lines.slice(Math.max(0, i - 4), i).join("\n").includes("logWikimediaHttpFailure(")) {
        silent.push(i + 1);
      }
    });
    expect(silent).toEqual([]);
  });

  it("a scope cancellation is still not a provider failure", () => {
    const src = PIPELINE();
    expect(
      [...src.matchAll(/if \(!isScopeAbortError\(err\)\) markWikimediaSearchResult\(false\);/g)]
    ).toHaveLength(4); // RONDE 136 added the batched imageinfo helper — see ronde69's note.
    expect(src).toContain("const WIKIMEDIA_FAILURE_STREAK_TRIP = VISUAL_PROVIDER_FAILURE_STREAK_TRIP;");
    expect(src).toContain("const WIKIMEDIA_COOLDOWN_MS = 3 * 60_000;");
  });

  it("the YouTube claim is still atomic and still sits before the download", () => {
    const src = PIPELINE();
    const start = src.indexOf("export function claimYoutubeDownloadSlot(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(src.indexOf("{", start), src.indexOf("\n}", start));
    const statements = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    expect(statements).toEqual([
      "{",
      'const m = providerMetrics(cache, "youtube_cc");',
      "if (m.downloadCount >= maxDownloads) return false;",
      "m.downloadCount++;",
      "return true;",
    ]);
    const claim = src.indexOf("if (!claimDownloadSlot()) {");
    const download = src.indexOf("const ok = await downloadYouTubeCCClip(", claim);
    expect(download).toBeGreaterThan(claim);
    expect(src.slice(claim, download)).not.toContain("await");
  });

  it("every fetchYouTubeCCClips call site still threads the render's cache", () => {
    const src = PIPELINE();
    const lines = src.split("\n");
    const missing: number[] = [];
    lines.forEach((l, i) => {
      if (!l.includes("fetchYouTubeCCClips(")) return;
      if (l.includes("async function")) return;
      const start = src.indexOf("fetchYouTubeCCClips(", lines.slice(0, i).join("\n").length);
      let depth = 0;
      let j = src.indexOf("(", start + "fetchYouTubeCCClips".length - 1);
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      if (!src.slice(start, j + 1).includes("sourcingCache")) missing.push(i + 1);
    });
    expect(missing).toEqual([]);
  });
});

/* ───────────────── 10. NOTHING ELSE MOVED ───────────────── */

describe("RONDE 70 §10 — observability only", () => {
  it("no provider call, no ranking and no LLM call was added to the audit modules", () => {
    for (const file of ["beatOutcomeAudit.ts", "clipRejectAudit.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      for (const forbidden of ["fetch(", "invokeLLM", "await ", "providerLimiter", "import fetch"]) {
        expect(src).not.toContain(forbidden);
      }
    }
  });

  it("the funnel report starts no request and judges nothing", () => {
    const src = PIPELINE();
    const start = src.indexOf("RONDE 70: one funnel line per beat, for EVERY beat.");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("const gateStats = getActiveGateFiringStats();", start));
    for (const forbidden of ["await", "fetch(", "judgeBeatImage", "invokeLLM", "providerLimiter"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("the vision attribution reads the state's own counters and changes no verdict", () => {
    const src = PIPELINE();
    const start = src.indexOf("function noteVisionSpend(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    // The delta itself is now measured inside the gate and handed over, so the attribution reads
    // what it was given rather than bracketing a call it does not own.
    expect(body).toContain("spent.judged");
    expect(body).toContain("spent.failed");
    for (const forbidden of ["await", "verdict", "return false", "return true"]) {
      expect(body).not.toContain(forbidden);
    }
    // And the gate measures that delta off the state's own counters, exactly as before.
    const mod = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
    expect(mod).toContain("judged: state.judgementAttempts - before.attempts");
    expect(mod).toContain("failed: state.judgementsFailed - before.failed");
    // judgeBeatImage's own signature is untouched.
    const gate = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    /**
     * SUPERSEDED BY RONDE 175 — the budgets moved, deliberately, and are not what this test is
     * about. It guards that the attribution reads the state's own counters and changes no verdict;
     * pinning the two numbers here made it an unrelated tripwire on every budget change. Their own
     * assertions live in ronde175BeatFitJudgement.
     */
    expect(gate).toContain("export const MAX_JUDGEMENTS_PER_BEAT = envInt(");
    expect(gate).toContain('envInt("MAX_BEAT_IMAGE_JUDGEMENTS",');
  });

  it("no threshold, source priority or fallback policy was touched", () => {
    const src = PIPELINE();
    expect(src).toContain("/** Quick script-ordered rescue: YouTube CC first, then capped Pexels. */");
    expect(src).toContain("if (realFootageFirstEnabled() && !youtubeOnlySourcingEnabled()) {");
    expect(src).toContain("const VISUAL_PROVIDER_FAILURE_STREAK_TRIP = 3;");
    expect(src).toContain("maxVisualCandidatesPerBeatTry");
    expect(src).toContain("MAX_FUNNEL_CANDIDATES_TO_SCORE");
  });

  it("no new database table or schema change came with this", () => {
    const src = PIPELINE();
    const start = src.indexOf("RONDE 70: one funnel line per beat, for EVERY beat.");
    const block = src.slice(start, src.indexOf("const gateStats = getActiveGateFiringStats();", start));
    for (const forbidden of ["db.", "drizzle", "insert(", "pgTable"]) {
      expect(block).not.toContain(forbidden);
    }
  });
});
