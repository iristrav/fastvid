/**
 * RONDE 112 — when there is no footage of what the beat SAYS, use footage of what it is ABOUT.
 *
 * RONDE 111 capped slow motion at 2x and made the coverage backfill search harder below the cap.
 * What it left underneath was still technical: re-use the scene's own shot in motion, then hold a
 * frame. Both answer "we have no picture" with "here is the previous picture again".
 *
 * A documentary editor does something else first. The beat reads
 *
 *     "Hitler died in his bunker in 1945."
 *
 * and the archive has nothing of the bunker, nothing of 1945, nothing of the death — but plenty of
 * Hitler. A shot of Hitler under that line is honest and useful. A frozen frame is neither.
 *
 * So a SUBJECT fallback goes in ahead of both technical fallbacks. It is deliberately small:
 *
 *   · the subject comes from signals the chain already extracts. No new NER, no LLM, no new query
 *     builder — this module only CHOOSES among what is already there, and returns null rather than
 *     picking a word out of the sentence;
 *   · the search is the existing cascade, run against a beat whose text is the subject;
 *   · the vision gate is unchanged and still the only content decider. It is asked a narrower
 *     question, and that narrower question is what the derived beat's text says;
 *   · the result is recorded as `subject_fallback` / coverage `subject_only`, which can never
 *     count as a verified own visual, because no check against the beat's full claim was made.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  SUBJECT_FALLBACK_CLAIM,
  SUBJECT_FALLBACK_ROUTE,
  formatNoSubjectLine,
  formatSubjectFallbackEmptyLine,
  formatSubjectFallbackLine,
  isUsableSubject,
  resolveBeatSubject,
} from "./beatSubjectFallback";
import { MAX_COVERAGE_SLOWDOWN, planCoverageFill } from "./coverageFillPlan";
import { buildBeatVisualStatuses, coverageOfAdoptEntry, tallyBeatVisualStatuses } from "./beatVisualStatus";
import { adoptRouteForSource } from "./clipAdoptAudit";
import { montageTailPadFilterChain } from "./videoPipeline";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const SUBJECT = fs.readFileSync(path.join(__dirname, "beatSubjectFallback.ts"), "utf8");
const QUALITY = fs.readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");

const HITLER_BEAT = "Hitler died in his bunker in 1945.";

/* ═══════════ 1. voldoende normale coverage ═══════════ */

describe("RONDE 112 — a covered scene never reaches any of this", () => {
  it("no shortfall means no filter, no extra search, no fallback", () => {
    expect(planCoverageFill(20, 20).action).toBe("none");
    expect(montageTailPadFilterChain(20, 20, "covered")).toBe("");
  });

  it("a scene inside the 2x budget does not pay for extra searching", () => {
    // The header line is emitted and the function returns before any extra round.
    expect(PIPELINE).toContain(
      "note(`${header} — within the ${MAX_COVERAGE_SLOWDOWN}x budget, no extra search needed`);"
    );
  });
});

/* ═══════════ 2. meerdere korte geschikte clips ═══════════ */

describe("RONDE 112 — short clips are stitched before anything else is tried", () => {
  it("the short-clip round runs first, and the subject round only after it", () => {
    const shortRound = PIPELINE.indexOf("Round A — ask for SHORT holds.");
    const subjectRound = PIPELINE.indexOf("Round A2: footage of what the shortest beats are ABOUT");
    const reuseRound = PIPELINE.indexOf("Round B — re-use this scene's OWN footage, in motion.");
    expect(shortRound).toBeGreaterThan(-1);
    expect(subjectRound).toBeGreaterThan(shortRound);
    expect(reuseRound).toBeGreaterThan(subjectRound);
  });

  it("a scene rescued by short clips reports that, and stops", () => {
    expect(PIPELINE).toContain(
      'note("resolution=real_footage — no subject fallback, no held frame", false);'
    );
  });
});

/* ═══════════ 3 & 4. tekort onder en boven 2× ═══════════ */

describe("RONDE 112 — the 2x cap is absolute", () => {
  it("a shortfall inside the cap is still just slowed", () => {
    const chain = montageTailPadFilterChain(12, 20, "inside");
    expect(chain).toContain("setpts=");
    expect(chain).not.toContain("tpad");
  });

  it("NO input produces a factor above the cap — swept, not sampled", () => {
    for (let montage = 0.1; montage <= 30; montage += 0.1) {
      for (const target of [5, 12, 20, 45, 90]) {
        const plan = planCoverageFill(montage, target);
        expect(
          plan.slowdownRatio,
          `${montage.toFixed(1)}s montage in a ${target}s scene`
        ).toBeLessThanOrEqual(MAX_COVERAGE_SLOWDOWN);
      }
    }
  });

  it("the emitted filter string can never carry a factor above 2", () => {
    for (const [montage, target] of [[1, 20], [2, 30], [3, 60], [0.5, 45]]) {
      const chain = montageTailPadFilterChain(montage!, target!, "sweep");
      const m = /setpts=([0-9.]+)\*PTS/.exec(chain);
      if (m) expect(parseFloat(m[1]!)).toBeLessThanOrEqual(MAX_COVERAGE_SLOWDOWN);
    }
  });
});

/* ═══════════ 5. extra zoekrondes ═══════════ */

describe("RONDE 112 — the extra rounds search the beat, not the clock", () => {
  it("both extra rounds pick the beat that is actually short", () => {
    const idx = PIPELINE.indexOf("Round A — ask for SHORT holds.");
    const body = PIPELINE.slice(idx, PIPELINE.indexOf("Round B — re-use this scene's OWN footage"));
    expect((body.match(/pickVoiceBackfillBeatIndex\(/g) ?? []).length).toBe(2);
  });

  it("the search round goes through the existing per-beat cascade", () => {
    const idx = PIPELINE.indexOf("Round A — ask for SHORT holds.");
    const body = PIPELINE.slice(idx, idx + 2400);
    expect(body).toContain("await ensureBeatVisualFilled(");
    expect(body).toContain("semanticProfiles.get(beat.index)");
  });

  it("how many extra searches a scene cost is counted and reported", () => {
    expect(PIPELINE).toContain("let extraSearches = 0;");
    expect(PIPELINE).toContain("extra_searches=${extraSearches}");
  });

  it("the header names needed, available, shortfall and the factor that would be required", () => {
    expect(PIPELINE).toContain("`needed=${scene.duration.toFixed(1)}s available=${coverage.toFixed(1)}s ` +");
    expect(PIPELINE).toContain("`short=${(scene.duration - coverage).toFixed(1)}s ` +");
    expect(PIPELINE).toContain("`would_need=${(scene.duration / Math.max(0.05, coverage)).toFixed(1)}x ` +");
    expect(PIPELINE).toContain("cap=${MAX_COVERAGE_SLOWDOWN}x");
  });
});

/* ═══════════ 6. subject fallback ═══════════ */

describe("RONDE 112 — the subject fallback picks the right subject", () => {
  it("the worked example: Hitler, not bunker, not 1945", () => {
    const subject = resolveBeatSubject({
      beatText: HITLER_BEAT,
      entities: { persons: ["Hitler"], locations: ["Führerbunker"], years: ["1945"] } as never,
    });
    expect(subject?.subject).toBe("Hitler");
    expect(subject?.kind).toBe("person");
    expect(subject?.origin).toBe("semantic_persons");
  });

  it("a person outranks a place, and a place outranks an event", () => {
    expect(
      resolveBeatSubject({
        beatText: "x",
        entities: { persons: ["Churchill"], locations: ["London"], events: ["the Blitz"] },
      })?.subject
    ).toBe("Churchill");
    expect(
      resolveBeatSubject({ beatText: "x", entities: { locations: ["London"], events: ["the Blitz"] } })
        ?.subject
    ).toBe("London");
    expect(resolveBeatSubject({ beatText: "x", entities: { events: ["the Blitz"] } })?.kind).toBe("event");
  });

  it("the video's person lock is used ONLY when the beat actually mentions them", () => {
    /**
     * A video about one man must not answer every beat with his face regardless of what the beat
     * says — that would be the "random footage to fill seconds" this fallback exists to avoid.
     */
    expect(
      resolveBeatSubject({ beatText: "Hitler retreated underground.", primaryPerson: "Adolf Hitler" })
        ?.origin
    ).toBe("person_lock");
    expect(
      resolveBeatSubject({ beatText: "The Red Army reached the outskirts.", primaryPerson: "Adolf Hitler" })
    ).toBeNull();
  });

  it("a name in the beat text works when there is no semantic profile", () => {
    const s = resolveBeatSubject({ beatText: HITLER_BEAT, namesInBeat: ["Hitler"] });
    expect(s?.subject).toBe("Hitler");
    expect(s?.origin).toBe("beat_names");
  });

  it("the reported line carries subject, origin, source, asset id and the claim", () => {
    const line = formatSubjectFallbackLine({
      sceneIndex: 4,
      beatIndex: 2,
      beatText: HITLER_BEAT,
      subject: { subject: "Hitler", kind: "person", origin: "semantic_persons" },
      basename: "curated_55995_s4b2.mp4",
      assetId: 55995,
      provider: "archive",
    });
    expect(line).toContain("[SubjectFallback]");
    expect(line).toContain('subject="Hitler"');
    expect(line).toContain("origin=semantic_persons");
    expect(line).toContain("source=archive");
    expect(line).toContain("asset=55995");
    expect(line).toContain("clip=curated_55995_s4b2.mp4");
    expect(line).toContain(SUBJECT_FALLBACK_CLAIM);
    expect(SUBJECT_FALLBACK_CLAIM).toContain("not necessarily the full event");
  });
});

describe("RONDE 112 — the fallback reuses the chain rather than replacing it", () => {
  it("it searches with the existing per-beat cascade", () => {
    const idx = PIPELINE.indexOf("async function trySubjectFallbackForBeat(");
    expect(idx).toBeGreaterThan(-1);
    const body = PIPELINE.slice(idx, idx + 4200);
    expect(body).toContain("await ensureBeatVisualFilled(");
    expect(body).toContain("subjectBeat, scene, workDir, videoTitle, dedup, capture, undefined, holdSec");
  });

  it("the derived beat keeps its coordinates and narrows only its TEXT", () => {
    /**
     * Same scene/beat index, so provenance, the geo lock and every audit still see the beat they
     * belong to. Different text, because the vision gate reads it — writing the full sentence
     * here and then accepting a portrait would be the gate approving something nobody asked it.
     */
    const idx = PIPELINE.indexOf("const subjectBeat: SceneBeat = {");
    const body = PIPELINE.slice(idx, idx + 400);
    expect(body).toContain("...beat,");
    expect(body).toContain("text: subject.subject,");
    expect(body).toContain("searchQuery: subject.subject,");
    expect(body).toContain("visualDescription: subject.subject,");
    expect(body).not.toContain("index:");
  });

  it("no new decider, no new query builder, no new extractor", () => {
    for (const forbidden of ["judgeBeatImage", "evaluateClipVisionGate", "openai", "buildSearchQuery"]) {
      expect(SUBJECT, forbidden).not.toContain(forbidden);
    }
    // The module has no imports at all — it only chooses among values handed to it.
    expect(SUBJECT).not.toContain("\nimport ");
  });

  it("it runs at most once per beat", () => {
    expect(PIPELINE).toContain("if (dedup.subjectFallbackBeats.has(`${scene.index}:${beat.index}`)) return false;");
    expect(PIPELINE).toContain("subjectFallbackBeats: new Set<string>(),");
  });

  it("it sits before both technical fallbacks in the per-beat ladder", () => {
    const subj = PIPELINE.indexOf("if (await trySubjectFallbackForBeat(beat, scene, workDir");
    const extend = PIPELINE.indexOf("// Try extending the last real clip before falling back to color");
    expect(subj).toBeGreaterThan(-1);
    expect(extend).toBeGreaterThan(subj);
  });
});

/* ═══════════ 7. geen betrouwbaar hoofdonderwerp ═══════════ */

describe("RONDE 112 — no reliable subject means no search, not a random word", () => {
  it("a beat with nothing named returns null", () => {
    expect(resolveBeatSubject({ beatText: "It was the end of an era." })).toBeNull();
    expect(resolveBeatSubject({ beatText: "They never spoke of it again." })).toBeNull();
    expect(resolveBeatSubject({ beatText: "" })).toBeNull();
  });

  it("sentence-openers, calendar words and bare topics are not subjects", () => {
    for (const notSubject of ["The", "They", "history", "war", "1945", "a", "Monday", "world"]) {
      expect(isUsableSubject(notSubject), notSubject).toBe(false);
    }
  });

  it("a real subject is", () => {
    for (const subject of ["Hitler", "Winston Churchill", "Führerbunker", "Apollo 11"]) {
      expect(isUsableSubject(subject), subject).toBe(true);
    }
  });

  it("a whole sentence is not a subject either", () => {
    expect(isUsableSubject(HITLER_BEAT)).toBe(false);
  });

  it("that outcome is reported rather than silently skipped", () => {
    const line = formatNoSubjectLine(3, 1, "It was the end of an era.");
    expect(line).toContain("subject=none");
    expect(line).toContain("reason=no_reliable_subject_in_beat");
    expect(PIPELINE).toContain("const line = formatNoSubjectLine(scene.index, beat.index, beat.text);");
    expect(PIPELINE).toContain("dedup.coverageDecisions.push(line);");
  });
});

/* ═══════════ 8. subject fallback zonder resultaat ═══════════ */

describe("RONDE 112 — a named subject with no footage says so", () => {
  it("the empty-result line names the subject that was tried", () => {
    const line = formatSubjectFallbackEmptyLine(2, 0, {
      subject: "Führerbunker",
      kind: "place",
      origin: "semantic_locations",
    });
    expect(line).toContain('subject="Führerbunker"');
    expect(line).toContain("result=no_footage_found");
    expect(line).toContain("reason=subject_search_returned_nothing");
  });

  it("and the pipeline falls through to the technical fallback rather than stalling", () => {
    const idx = PIPELINE.indexOf("async function trySubjectFallbackForBeat(");
    const body = PIPELINE.slice(idx, idx + 4200);
    expect(body).toContain("if (!adopted) {");
    expect(body).toContain("formatSubjectFallbackEmptyLine(scene.index, beat.index, subject)");
    expect(body).toContain("return false;");
  });
});

/* ═══════════ 9. laatste technische fallback ═══════════ */

describe("RONDE 112 — the held frame is last, and never silent", () => {
  it("it is only reached with a named reason", () => {
    expect(PIPELINE).toContain("resolution=held_frame reason=no_real_clip_to_reuse");
    expect(PIPELINE).toContain("resolution=held_frame reason=exhausted");
  });

  it("the exhausted line carries the applied slowdown and the held seconds", () => {
    expect(PIPELINE).toContain("const plan = planCoverageFill(coverage, scene.duration);");
    expect(PIPELINE).toContain("slowdown=${plan.slowdownRatio.toFixed(2)}x held=${plan.stillShortSec.toFixed(1)}s");
  });

  it("compose still holds only the part slowing could not cover", () => {
    const chain = montageTailPadFilterChain(2, 20, "exhausted");
    expect(chain).toContain("setpts=2.000000*PTS");
    /**
     * SUPERSEDED BY RONDE 130 — the claim this line made is still true; what happens to the
     * remainder is not.
     *
     * It was written to prove the slowdown stops at the 2x cap instead of absorbing a large
     * shortfall, and that half is asserted above and below, unchanged. What it also encoded was a
     * SIXTEEN-SECOND hold — and RONDE 130 measured what that looks like in the finished MP4:
     * 28.13s of unchanging picture for the production case. The montage plays again now instead,
     * which is the same judgement RONDE 112 made for extendLastClip one layer up.
     *
     * A shortfall inside the still limit is still a plain hold; that case has its own test in
     * ronde130VisualIntegrity.
     */
    expect(chain).toContain("loop=loop=");
    expect(chain).not.toContain("tpad=stop_mode=clone");
  });
});

/* ═══════════ de boekhouding blijft eerlijk ═══════════ */

describe("RONDE 112 — subject footage never counts as a verified fit", () => {
  it("it has its own coverage kind", () => {
    expect(coverageOfAdoptEntry({ source: SUBJECT_FALLBACK_ROUTE, basename: "x.mp4" })).toBe(
      "subject_only"
    );
    expect(SUBJECT_FALLBACK_ROUTE).toBe("subject_fallback");
  });

  it("a beat filled this way is NOT a verified own visual, even with a fits verdict", () => {
    const statuses = buildBeatVisualStatuses(
      [{ sceneIndex: 0, beatIndex: 0, beatText: HITLER_BEAT, basename: "c.mp4", source: SUBJECT_FALLBACK_ROUTE } as never],
      {
        byClipPath: new Map([
          ["c.mp4", { ctx: { sceneIndex: 0, beatIndex: 0, beatText: "Hitler" }, decision: { verdict: "fits", reprieved: false } }],
        ]),
        byContentKey: new Map(),
        spendByBeat: new Map(),
      } as never
    );
    expect(statuses[0]!.coverage).toBe("subject_only");
    expect(statuses[0]!.verification).toBe("verified_fit");
    // The gate said yes — to "is this Hitler". Not to the bunker, not to 1945.
    expect(statuses[0]!.verifiedOwnVisual).toBe(false);
    expect(statuses[0]!.reason).toBe("subject_only");
  });

  it("the tally counts it in its own bucket", () => {
    const t = tallyBeatVisualStatuses([
      { sceneIndex: 0, beatIndex: 0, coverage: "subject_only", verification: "verified_fit", source: SUBJECT_FALLBACK_ROUTE, basename: "c.mp4", verifiedOwnVisual: false, reason: "subject_only" },
    ]);
    expect(t.byCoverage.subject_only).toBe(1);
    expect(t.verifiedOwnVisual).toBe(0);
    expect(t.ownFootage).toBe(0);
  });

  it("the score charges for it — less than a stand-in, more than nothing", () => {
    expect(QUALITY).toContain("score -= Math.min(12, t.byCoverage.subject_only * 3);");
    // The stand-in weight it must stay below.
    expect(QUALITY).toContain("score -= Math.min(30, standIns * 5);");
    // ...and it is NOT lumped in with the stand-ins.
    const idx = QUALITY.indexOf("const standIns =");
    expect(QUALITY.slice(idx, idx + 200)).not.toContain("subject_only");
  });

  it("the adopt audit does not call it a primary match", () => {
    expect(adoptRouteForSource(SUBJECT_FALLBACK_ROUTE)).toBe("backfill");
    expect(adoptRouteForSource("archive")).toBe("primary");
  });
});

/* ═══════════ logging ═══════════ */

describe("RONDE 112 — the whole story reaches the pipeline report", () => {
  it("every coverage decision, including the subject lines, is stored", () => {
    expect(PIPELINE).toContain('pipelineReport.addAll("warnings", visualDedup.coverageDecisions);');
    const idx = PIPELINE.indexOf("async function trySubjectFallbackForBeat(");
    const body = PIPELINE.slice(idx, idx + 4200);
    expect((body.match(/dedup\.coverageDecisions\.push\(line\)/g) ?? []).length).toBe(3);
  });

  it("clips refused for length are reported next to the shortfalls they caused", () => {
    expect(PIPELINE).toContain("clips refused for length across this render:");
    expect(PIPELINE).toContain("rejects.source_video_too_short ?? 0");
    expect(PIPELINE).toContain("rejects.trimmed_clip_too_short ?? 0");
  });

  it("the scene 110 upload splitter was not touched", () => {
    // This round changed how a SHORTFALL is filled, not how uploads are cut into scenes.
    const splitter = fs.readFileSync(path.join(__dirname, "archiveVideoSplitter.ts"), "utf8");
    expect(splitter).toContain("Split archive videos at real shot/scene boundaries — NOT on fixed time intervals.");
    expect(splitter).toContain("const sceneAware = cuts.length > 0;");
  });
});
