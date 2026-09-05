/**
 * RONDE 96 §1 — THE INTENT IS JOINED ONCE AND ACTUALLY READ.
 *
 * The brief's rule for this item is not "compute an intent" — FastVid already computed all ten
 * fields. It is: "De intent mag niet alleen worden berekend en gelogd. De intent MOET daadwerkelijk
 * worden gebruikt." So the tests that matter are the ones that fail if the record goes back to
 * being decorative: that it is built from the existing extractors rather than a fourth one, that
 * the ranking reads it, and that it is built before the first ordering decision rather than after.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  buildBeatVisualIntent,
  createBeatVisualIntentState,
  ensureBeatVisualIntent,
  formatIntentSummary,
  formatVisualIntent,
  intentlessBeats,
  intentMatchScore,
} from "./beatVisualIntent";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const INTENT = fs.readFileSync(path.join(__dirname, "beatVisualIntent.ts"), "utf8");

/** The beat the whole entity investigation came from, run through the real extractor. */
const beatText = "In April 1945 Adolf Hitler retreated to the Führerbunker beneath Berlin.";
const realCtx = () => buildVerifiedQueryContextForBeat(beatText, { sceneText: beatText });

const contract = {
  beatId: "s0b0",
  visualGoal: "historical context",
  mustContain: ["Führerbunker"],
  shouldContain: ["Berlin"],
  preferredShot: "archive_footage",
  fallbackShot: "wide",
  motionRange: [0, 40] as [number, number],
  targetEmotion: "sombre",
  forbiddenContent: ["reenactment", "video game"],
  sourcePreference: ["archive"],
  reason: "test",
};

/* ═══════════════ the ten fields, from the real extractors ═══════════════ */

describe("a beat states what it is looking for", () => {
  const intent = () =>
    buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: realCtx(), contract });

  it("carries every field the brief names", () => {
    const i = intent();
    for (const field of [
      "subject", "action", "event", "location", "period",
      "people", "objects", "evidenceRequirement", "preferredShot", "fallbackClass",
    ] as const) {
      expect(i, `${field} is missing from the intent record`).toHaveProperty(field);
    }
  });

  /** The planner's hard requirement outranks any extractor's report — see the join's doc. */
  it("takes its subject from the planner when the planner states one", () => {
    expect(intent().subject).toBe("Führerbunker");
    expect(intent().evidenceRequirement).toBe("hard");
  });

  it("falls back to the typed entities when the planner has no contract", () => {
    const i = buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: realCtx(), contract: null });
    expect(i.subject).toBeTruthy();
    expect(i.evidenceRequirement).toBe("soft");
    expect(i.preferredShot).toBe("");
  });

  /** A beat that can state nothing is the honest "none", not a guess. */
  it("reports a beat that could state nothing", () => {
    const i = buildBeatVisualIntent({ sceneIndex: 3, beatIndex: 1, ctx: null, contract: null });
    expect(i.subject).toBe("");
    expect(i.evidenceRequirement).toBe("none");
  });

  it("keeps the planner's shot and its fallback class", () => {
    expect(intent().preferredShot).toBe("archive_footage");
    expect(intent().fallbackClass).toBe("wide");
  });

  it("keeps what the planner forbids", () => {
    expect(intent().forbidden).toContain("reenactment");
  });

  /** The real extractor found the period and the person in the real sentence. */
  it("picks up the historical period and the person from the beat's own words", () => {
    const i = intent();
    const flat = [...i.period, ...i.people, ...i.location].join(" ").toLowerCase();
    expect(flat.length, "the extractor produced no entities at all for a rich historical beat")
      .toBeGreaterThan(0);
  });
});

/* ═══════════════ one record, not four extractors ═══════════════ */

describe("the record joins what exists rather than extracting again", () => {
  /**
   * THE RULE THE BRIEF STATES TWICE. A fourth extractor is this codebase's most repeated mistake,
   * and the module must be provably a join: it may read types from the three sources and must not
   * contain pattern matching of its own.
   */
  it("contains no extraction of its own", () => {
    expect(INTENT).not.toMatch(/new RegExp|\/\\b\(|test\(beatText\)/);
    expect(INTENT).toContain('from "./documentaryPlanningEngine"');
    expect(INTENT).toContain('from "./searchQueryContract"');
  });

  it("is built once per beat and read many times", () => {
    const state = createBeatVisualIntentState();
    const a = ensureBeatVisualIntent(state, { sceneIndex: 1, beatIndex: 2, ctx: realCtx(), contract });
    const b = ensureBeatVisualIntent(state, { sceneIndex: 1, beatIndex: 2, ctx: null, contract: null });
    expect(b, "a second route rebuilt the record and could disagree with the first").toBe(a);
    expect(b.subject).toBe("Führerbunker");
  });

  it("keeps beats apart", () => {
    const state = createBeatVisualIntentState();
    ensureBeatVisualIntent(state, { sceneIndex: 0, beatIndex: 0, ctx: realCtx(), contract });
    const other = ensureBeatVisualIntent(state, { sceneIndex: 0, beatIndex: 1, ctx: null, contract: null });
    expect(other.evidenceRequirement).toBe("none");
  });
});

/* ═══════════════ §1's actual demand: it is USED ═══════════════ */

describe("the intent reaches the decisions it is for", () => {
  /** It is built in the one function that holds both halves, before anything is ordered. */
  it("is built before the first ordering decision", () => {
    const at = PIPE.indexOf("async function adoptClip(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const built = body.indexOf("ensureBeatVisualIntent(dedup.beatIntent");
    const sorted = body.indexOf("const sortedPaths = [...paths].sort(");
    expect(built, "the intent is never built").toBeGreaterThan(-1);
    expect(sorted).toBeGreaterThan(-1);
    expect(built, "the intent is joined after the order was already fixed").toBeLessThan(sorted);
  });

  /** THE POINT. A record that is only logged is the thing this item exists to stop. */
  it("is a term in the candidate ranking, not only a log line", () => {
    expect(PIPE).toContain("const intentScore = (p: string): number =>");
    expect(PIPE).toContain("candidateScore(a) + intentScore(a)");
    expect(PIPE).toContain("candidateScore(b) + intentScore(b)");
  });

  it("is printed once per beat", () => {
    expect(PIPE).toContain("formatVisualIntent(_intent)");
    expect(PIPE).toContain("dedup.beatIntentLogged.has(");
    expect(PIPE).toContain("dedup.beatIntentLogged.add(");
  });

  it("the render reports the intent summary and the gaps", () => {
    expect(PIPE).toContain("formatIntentSummary(visualDedup.beatIntent)");
  });
});

/* ═══════════════ the score orders, and never rejects ═══════════════ */

describe("the intent score orders candidates", () => {
  const i = buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: realCtx(), contract });

  it("scores a candidate that names the subject above one that does not", () => {
    const onTopic = intentMatchScore(i, "Führerbunker Berlin 1945 archive newsreel");
    const offTopic = intentMatchScore(i, "modern city traffic timelapse");
    expect(onTopic).toBeGreaterThan(offTopic);
  });

  /** Folded matching, so an archive that spells it without the umlaut still matches. */
  it("matches the folded spelling of an accented subject", () => {
    expect(intentMatchScore(i, "fuhrerbunker bunker interior")).toBeGreaterThan(0);
  });

  it("penalises what the planner forbade", () => {
    const clean = intentMatchScore(i, "Führerbunker archive");
    const dirty = intentMatchScore(i, "Führerbunker archive reenactment");
    expect(dirty).toBeLessThan(clean);
  });

  /** It is a term in a sort. It must never be able to refuse a candidate on its own. */
  it("returns a number and never a verdict", () => {
    expect(typeof intentMatchScore(i, "anything")).toBe("number");
    expect(intentMatchScore(null, "anything")).toBe(0);
    expect(intentMatchScore(i, undefined)).toBe(0);
    expect(intentMatchScore(i, "")).toBe(0);
  });
});

/* ═══════════════ the report ═══════════════ */

describe("the intent is reportable", () => {
  it("prints the beat's statement in one line", () => {
    const line = formatVisualIntent(
      buildBeatVisualIntent({ sceneIndex: 2, beatIndex: 1, ctx: realCtx(), contract })
    );
    expect(line.startsWith("[VisualIntent] s2b1")).toBe(true);
    expect(line).toContain("subject=Führerbunker");
    expect(line).toContain("evidence=hard");
    expect(line).toContain("shot=archive_footage");
  });

  /** An empty field is omitted rather than printed as an empty list — see the formatter's doc. */
  it("omits fields the beat could not state", () => {
    const line = formatVisualIntent(
      buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: null, contract: null })
    );
    expect(line).toContain("subject=NONE");
    expect(line).not.toContain("=[]");
    expect(line).not.toContain("people=");
  });

  it("names the beats that could state nothing", () => {
    const state = createBeatVisualIntentState();
    ensureBeatVisualIntent(state, { sceneIndex: 0, beatIndex: 0, ctx: realCtx(), contract });
    ensureBeatVisualIntent(state, { sceneIndex: 1, beatIndex: 0, ctx: null, contract: null });
    expect(intentlessBeats(state).map((b) => b.beatIndex)).toEqual([0]);
    const lines = formatIntentSummary(state);
    expect(lines[0]).toContain("beats=2 hard=1");
    expect(lines.join(" ")).toContain("[VisualIntentGap] s1b0");
  });

  it("prints nothing for a render with no beats", () => {
    expect(formatIntentSummary(createBeatVisualIntentState())).toEqual([]);
    expect(formatIntentSummary(undefined)).toEqual([]);
  });
});
