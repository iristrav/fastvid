import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * VIDEO 644 — eight of twelve sentences became a title card while Tesla footage sat in the pool.
 * The judge refused every general shot of the subject under a line that describes no situation a
 * camera can film ("matches the subject of Tesla. However, it does not visually depict the specific
 * situation of …"). `abstractLineRule` admits such a shot, and only such a shot: the line's own
 * intent must say it needs nothing specific, the model must have seen the subject, and nothing may
 * contradict the line. Every other refusal, and every existing guard, stays exactly as it was.
 */
const answer = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const persisted = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("./_core/llm", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_core/llm")>();
  return {
    ...real,
    invokeLLM: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(answer.current) } }] })),
  };
});
vi.mock("./beatRelevanceVerdictStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("./beatRelevanceVerdictStore")>();
  return {
    ...real,
    lookupVerdict: vi.fn(async () => null),
    persistVerdict: vi.fn(async (...args: unknown[]) => {
      persisted.calls.push(args);
    }),
  };
});

import {
  BROLL_PREFIX,
  abstractLineRule,
  createBeatImageGateState,
  judgeBeatImage,
  situationRule,
  ACCEPTABLE_PREFIX,
} from "./beatImageRelevanceGate";
import {
  buildBeatVisualIntent,
  createBeatVisualIntentState,
  ensureBeatVisualIntent,
  lineFactsFor,
  lineFactsOf,
  type LineFacts,
} from "./beatVisualIntent";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";
import { statesAQuantity } from "./cinematicEditingEngine/motionGraphicsPlanner";

const ABSTRACT: LineFacts = { evidenceRequirement: "soft", wantsSpecificPicture: false };
const HARD: LineFacts = { evidenceRequirement: "hard", wantsSpecificPicture: false };
const CONCRETE: LineFacts = { evidenceRequirement: "soft", wantsSpecificPicture: true };
const NONE: LineFacts = { evidenceRequirement: "none", wantsSpecificPicture: false };

/** The 644 s1b0 refusal, as the model gave it. */
const refused = {
  verdict: "does_not_fit" as const,
  depicts: "Interior of a Tesla car with a focus on the dashboard, driving autonomously on a suburban road.",
  reason: "The frames focus on the interior of a Tesla car, which matches the subject of Tesla. However, it does not visually depict the specific situation of the direct-to-consumer model.",
};
const subjectOnly = { subject_matches: true, situation_matches: false };
/** An abstract line: a subject, no event a camera could film, no claim about money, tax, law or markets. */
const ABSTRACT_LINE = "Tesla, the electric car company that changed the industry.";

describe("abstractLineRule — the pure rule", () => {
  it("admits general footage of the subject under an abstract line with soft evidence and no specific picture wanted", () => {
    const out = abstractLineRule(refused, subjectOnly, ABSTRACT, ABSTRACT_LINE);
    expect(out.verdict).toBe("fits");
    expect(out.reason.startsWith(BROLL_PREFIX)).toBe(true);
    expect(out.depicts).toBe(refused.depicts);
  });

  it("strips the situation rule's own prefix when it admits a refusal that rule wrote", () => {
    const flipped = situationRule({ verdict: "fits" as const, reason: "shows a Tesla on the road" }, subjectOnly);
    expect(flipped.verdict).toBe("does_not_fit");
    expect(flipped.reason).toBe("situation not shown: shows a Tesla on the road");
    const out = abstractLineRule({ ...flipped, depicts: "A Tesla car driving on a road." }, subjectOnly, ABSTRACT, ABSTRACT_LINE);
    expect(out.verdict).toBe("fits");
    expect(out.reason).toBe(`${BROLL_PREFIX}shows a Tesla on the road`);
  });

  it("does nothing for a line with a hard evidence requirement — a car interior does not prove a claim the planner pinned", () => {
    expect(abstractLineRule(refused, subjectOnly, HARD, ABSTRACT_LINE)).toBe(refused);
  });

  it("does nothing for a line that wants a specific picture — a lawsuit, a launch, a factory, a year", () => {
    expect(abstractLineRule(refused, subjectOnly, CONCRETE, ABSTRACT_LINE)).toBe(refused);
  });

  it("does nothing for a line whose intent cannot say what it is about (evidence none)", () => {
    expect(abstractLineRule(refused, subjectOnly, NONE, ABSTRACT_LINE)).toBe(refused);
  });

  it("does nothing without line facts — a route that has no intent keeps the full rule", () => {
    expect(abstractLineRule(refused, subjectOnly, undefined, ABSTRACT_LINE)).toBe(refused);
  });

  it("does nothing when the subject does not match", () => {
    const wrong = { ...refused, depicts: "A Ford pickup truck on a dirt road.", reason: "The frames show a Ford truck, not the subject." };
    expect(abstractLineRule(wrong, { subject_matches: false, situation_matches: false }, ABSTRACT, ABSTRACT_LINE)).toBe(wrong);
  });

  it("does nothing when the model's answer lacks the two fields or says the situation IS shown", () => {
    expect(abstractLineRule(refused, {}, ABSTRACT, ABSTRACT_LINE)).toBe(refused);
    expect(abstractLineRule(refused, { subject_matches: true }, ABSTRACT, ABSTRACT_LINE)).toBe(refused);
    expect(abstractLineRule(refused, { subject_matches: true, situation_matches: true }, ABSTRACT, ABSTRACT_LINE)).toBe(refused);
    expect(abstractLineRule(refused, { subject_matches: "true", situation_matches: "false" }, ABSTRACT, ABSTRACT_LINE)).toBe(refused);
  });

  it("does nothing when what the model saw or said contradicts the line", () => {
    const cases = [
      { depicts: "A title card reading 'Tesla' on a dark background.", reason: "Only a title card." },
      { depicts: "A screenshot of a web page about Tesla.", reason: "A screenshot, not footage." },
      { depicts: "An animated Tesla logo spinning.", reason: "It is an animation." },
      { depicts: "A Tesla on the road.", reason: "The footage is from a different era than the narration." },
      { depicts: "A Tesla on the road.", reason: "The frames show a different company's factory." },
      { depicts: "A Tesla on the road.", reason: "The frames are unrelated to the line." },
      { depicts: "A Tesla on the road.", reason: "This contradicts the narration." },
    ];
    for (const c of cases) {
      const j = { verdict: "does_not_fit" as const, ...c };
      expect(abstractLineRule(j, subjectOnly, ABSTRACT, ABSTRACT_LINE), c.reason).toBe(j);
    }
  });

  it("never touches a fit or an unknown", () => {
    const fit = { verdict: "fits" as const, depicts: refused.depicts, reason: "fits" };
    expect(abstractLineRule(fit, subjectOnly, ABSTRACT, ABSTRACT_LINE)).toBe(fit);
    const unknown = { verdict: "unknown" as const, depicts: "", reason: "no answer" };
    expect(abstractLineRule(unknown, subjectOnly, ABSTRACT, ABSTRACT_LINE)).toBe(unknown);
  });
});

describe("abstractLineRule — a concrete claim keeps the full rule even when the intent typed nothing", () => {
  const CLAIMS = [
    "The settlement with the SEC was costly for Tesla.",
    "The fine was the largest in the agency's history.",
    "Tesla's regulatory credits were highly profitable.",
    "Tesla's tax credits were controversial.",
    "The lawsuit against Tesla was dismissed.",
    "Tesla's strategy was simple: cut prices and win market share from rivals.",
    "Tesla is the most valuable automaker in the world.",
    "The subsidies made Tesla's cars affordable.",
    "Tesla's shares are volatile.",
    "The court ruled against Tesla.",
    "Tesla's revenue comes mostly from car sales.",
    "The recall affected thousands of vehicles.",
    "The investigation into Autopilot is ongoing.",
    "Tesla acquired SolarCity in a controversial deal.",
  ];
  it("financial, tax, legal, regulatory and market claims are never admitted, whatever the intent says", () => {
    for (const text of CLAIMS) {
      expect(abstractLineRule(refused, subjectOnly, ABSTRACT, text), text).toBe(refused);
    }
  });
  it("no line text at all reads as unknown and keeps the full rule", () => {
    expect(abstractLineRule(refused, subjectOnly, ABSTRACT, undefined)).toBe(refused);
    expect(abstractLineRule(refused, subjectOnly, ABSTRACT, "   ")).toBe(refused);
  });
  it("a general strategy line without a claim is still admitted", () => {
    expect(abstractLineRule(refused, subjectOnly, ABSTRACT, "Tesla's approach redefined how the industry thinks about selling cars.").verdict).toBe("fits");
    expect(abstractLineRule(refused, subjectOnly, ABSTRACT, ABSTRACT_LINE).verdict).toBe("fits");
  });
});

describe("the real extractors — concrete claims that look abstract never reach the admission", () => {
  /** Exactly what `adoptClip` builds, with the planner's subject and the sentence's own words. */
  const factsFor = (text: string): LineFacts =>
    lineFactsOf(
      buildBeatVisualIntent({
        sceneIndex: 0,
        beatIndex: 0,
        ctx: buildVerifiedQueryContextForBeat(text),
        plan: { search_query: "tesla" },
        statesQuantity: statesAQuantity(text),
      })
    );
  const judged = (text: string) => abstractLineRule(refused, subjectOnly, factsFor(text), text);

  it("financial claims: a figure, a currency or a quantity word wants a data picture", () => {
    for (const text of [
      "Tesla earned $1.5 billion from selling carbon credits in 2020.",
      "The company reported record profits last quarter.",
      "Tesla's valuation surpassed Toyota's, making it the most valuable automaker.",
    ]) {
      expect(factsFor(text).wantsSpecificPicture, text).toBe(true);
      expect(judged(text), text).toBe(refused);
    }
  });

  it("tax and regulatory claims", () => {
    for (const text of [
      "Tesla benefited from federal tax credits worth $7,500 per vehicle.",
      "Tesla leveraged California's regulatory landscape by selling carbon credits to rivals.",
      "The tax credit expired, and demand fell sharply.",
      "The subsidies made Tesla's cars affordable.",
    ]) {
      expect(judged(text), text).toBe(refused);
    }
  });

  it("lawsuits, courts, fines and investigations", () => {
    for (const text of [
      "Tesla faced a lawsuit over its Autopilot marketing.",
      "Tesla was sued by shareholders in 2018.",
      "The lawsuit against Tesla was dismissed.",
      "The settlement with the SEC was costly for Tesla.",
      "The fine was the largest in the agency's history.",
      "Regulators fined Tesla for misleading claims about self-driving.",
      "The court ruled against Tesla.",
    ]) {
      expect(judged(text), text).toBe(refused);
    }
  });

  it("specific corporate strategy with a concrete move, a place, a person or a deal", () => {
    for (const text of [
      "Tesla's direct-to-consumer sales model bypassed traditional dealerships.",
      "Tesla opened a factory in Shanghai.",
      "Musk announced the strategy on Twitter.",
      "Tesla acquired SolarCity in a controversial deal.",
      "Tesla slashed prices by 20% to win market share.",
    ]) {
      expect(judged(text), text).toBe(refused);
    }
  });

  it("the two cases that measured as untyped and carry a claim are stopped by the line's own words", () => {
    for (const text of ["The settlement with the SEC was costly for Tesla.", "The fine was the largest in the agency's history."]) {
      const facts = factsFor(text);
      expect(facts, text).toEqual({ evidenceRequirement: "soft", wantsSpecificPicture: false });
      expect(judged(text), text).toBe(refused);
    }
  });

  it("a genuinely abstract line about the subject is admitted", () => {
    const facts = factsFor(ABSTRACT_LINE);
    expect(facts).toEqual({ evidenceRequirement: "soft", wantsSpecificPicture: false });
    expect(judged(ABSTRACT_LINE).verdict).toBe("fits");
  });

  it("a line without a planned subject is never admitted, whatever the extractors made of it", () => {
    for (const text of ["It changed everything.", "Nothing was the same again."]) {
      const facts = lineFactsOf(buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0, ctx: buildVerifiedQueryContextForBeat(text) }));
      expect(abstractLineRule(refused, subjectOnly, facts, text), text).toBe(refused);
    }
    /** And with no extractor output at all the intent reads `none`, which the rule never admits. */
    const none = lineFactsOf(buildBeatVisualIntent({ sceneIndex: 0, beatIndex: 0 }));
    expect(none.evidenceRequirement).toBe("none");
    expect(abstractLineRule(refused, subjectOnly, none, ABSTRACT_LINE)).toBe(refused);
  });
});

describe("lineFactsOf / lineFactsFor — the facts come from the intent, not from the sentence", () => {
  const at = { sceneIndex: 0, beatIndex: 2 };

  it("644 s0b2: a planned subject and nothing typed reads soft + wants nothing specific", () => {
    const intent = buildBeatVisualIntent({ ...at, plan: { search_query: "tesla cars factory advanced manufacturing" } });
    expect(intent.evidenceRequirement).toBe("soft");
    expect(lineFactsOf(intent)).toEqual({ evidenceRequirement: "soft", wantsSpecificPicture: false });
  });

  it("a planner mustContain reads hard", () => {
    const intent = buildBeatVisualIntent({ ...at, contract: { mustContain: ["Tesla Gigafactory"] } as never });
    expect(lineFactsOf(intent).evidenceRequirement).toBe("hard");
  });

  it("a typed event, person, place, period, object or action wants a specific picture", () => {
    const typed = [
      { events: [{ term: "Autopilot lawsuit" }] },
      { persons: [{ term: "Elon Musk" }] },
      { places: [{ term: "Fremont" }] },
      { years: [{ term: "2018" }] },
      { objects: [{ term: "battery pack" }] },
      { actions: [{ term: "assembling" }] },
    ];
    for (const ctx of typed) {
      const intent = buildBeatVisualIntent({ ...at, ctx: ctx as never, plan: { search_query: "tesla" } });
      expect(lineFactsOf(intent).wantsSpecificPicture, JSON.stringify(ctx)).toBe(true);
    }
  });

  it("a quantity in the sentence wants a specific picture (a data graphic), so the rule stays off", () => {
    const intent = buildBeatVisualIntent({ ...at, plan: { search_query: "tesla" }, statesQuantity: true });
    expect(lineFactsOf(intent).wantsSpecificPicture).toBe(true);
  });

  it("no subject at all reads none", () => {
    expect(lineFactsOf(buildBeatVisualIntent(at)).evidenceRequirement).toBe("none");
  });

  it("lineFactsFor reads the beat that was built and nothing for a beat that was not", () => {
    const state = createBeatVisualIntentState();
    ensureBeatVisualIntent(state, { ...at, plan: { search_query: "tesla" } });
    expect(lineFactsFor(state, 0, 2)).toEqual(ABSTRACT);
    expect(lineFactsFor(state, 0, 3)).toBeUndefined();
    expect(lineFactsFor(undefined, 0, 2)).toBeUndefined();
  });
});

/* ── the judge end to end, with the model's answer mocked ───────────────────────────────── */

let dir: string;
let frame: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "v644-broll-"));
  frame = path.join(dir, "frame.jpg");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=1:duration=1", "-frames:v", "1", frame]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let logs: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  logs = [];
  persisted.calls.length = 0;
  vi.spyOn(console, "log").mockImplementation((l: unknown) => void logs.push(String(l)));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const LINE = "Tesla's approach redefined how the industry thinks about selling cars.";
const judge = (line: LineFacts | undefined, beatText = LINE, state = createBeatImageGateState()) =>
  judgeBeatImage({
    framePaths: [frame],
    beatText,
    contentKey: `clip-${Math.random()}`,
    beatIdentity: `beat-${Math.random()}`,
    state,
    timeoutMs: 10_000,
    ...(line ? { line } : {}),
  }).then((j) => ({ j, state }));
const admitted = () => logs.filter((l) => l.includes("abstract line — b-roll admitted"));
const situationLines = () => logs.filter((l) => l.includes("subject without the situation"));

const model644 = {
  depicts: "Interior of a Tesla car with a focus on the dashboard and center screen, driving autonomously on a suburban road.",
  subject_matches: true,
  situation_matches: false,
  belongs: false,
  reason: "The frames focus on the interior of a Tesla car, which matches the subject of Tesla. However, it does not visually depict the specific situation of the direct-to-consumer model.",
  framing: "medium",
};

describe("judgeBeatImage — the rule in its place", () => {
  it("644 s1b0: the model's own refusal of subject-only footage becomes a fit under an abstract line, logged and persisted as such", async () => {
    answer.current = model644;
    const { j, state } = await judge(ABSTRACT);
    expect(j.verdict).toBe("fits");
    expect(j.reason.startsWith(BROLL_PREFIX)).toBe(true);
    expect(j.evaluated).toBe(true);
    expect(admitted()).toHaveLength(1);
    expect(admitted()[0]).toContain("evidence=soft want=NONE");
    expect(situationLines()).toHaveLength(0);
    expect(state.judgementsFits).toBe(1);
    expect(state.judgementsMismatch).toBe(0);
    expect(persisted.calls).toHaveLength(1);
    expect(persisted.calls[0]![1]).toBe("fits");
    expect(String(persisted.calls[0]![3]).startsWith(BROLL_PREFIX)).toBe(true);
  });

  it("the same answer without line facts is not a fit — VIDEO 650: ACCEPTABLE, adopted only without a fit", async () => {
    /** The b-roll rule still does not admit it (no line facts); the subject-only answer is now `acceptable` rather than a refusal. */
    answer.current = model644;
    const { j, state } = await judge(undefined);
    expect(j.verdict).toBe("acceptable");
    expect(j.reason).toBe(`${ACCEPTABLE_PREFIX}${model644.reason}`.slice(0, 160));
    expect(admitted()).toHaveLength(0);
    expect(state.judgementsMismatch).toBe(0);
    expect(state.judgementsAcceptable).toBe(1);
  });

  it("the same answer under a hard-evidence line, or a line that wants a specific picture, is refused — not even ACCEPTABLE; a line with no evidence requirement is ACCEPTABLE", async () => {
    answer.current = model644;
    expect((await judge(HARD)).j.verdict).toBe("does_not_fit");
    expect((await judge(CONCRETE)).j.verdict).toBe("does_not_fit");
    /** VIDEO 650 — no evidence requirement, no concrete claim: the subject-only picture is the sentence's fallback, never a FIT */
    const { j } = await judge(NONE);
    expect(j.verdict).toBe("acceptable");
    expect(j.reason.startsWith(ACCEPTABLE_PREFIX)).toBe(true);
    expect(admitted()).toHaveLength(0);
  });

  it("a refusal that says the subject is NOT shown stays a refusal under an abstract line", async () => {
    answer.current = {
      ...model644,
      depicts: "A portrait of a historical figure, same image across frames.",
      subject_matches: false,
      reason: "The frames show a historical portrait, which does not relate to Tesla.",
    };
    const { j } = await judge(ABSTRACT);
    expect(j.verdict).toBe("does_not_fit");
    expect(admitted()).toHaveLength(0);
  });

  it("the situation rule still refuses an approval of subject-only footage when the line names a situation", async () => {
    answer.current = { ...model644, belongs: true };
    const { j } = await judge(CONCRETE);
    expect(j.verdict).toBe("does_not_fit");
    expect(j.reason.startsWith("situation not shown: ")).toBe(true);
    expect(situationLines()).toHaveLength(1);
    expect(admitted()).toHaveLength(0);
  });

  it("under an abstract line the situation rule's own refusal is admitted again, and both steps are logged", async () => {
    answer.current = { ...model644, belongs: true };
    const { j } = await judge(ABSTRACT);
    expect(j.verdict).toBe("fits");
    expect(j.reason.startsWith(BROLL_PREFIX)).toBe(true);
    expect(j.reason).not.toContain("not shown:");
    expect(situationLines()).toHaveLength(1);
    expect(admitted()).toHaveLength(1);
  });

  it("the logo-only guard still runs after the admission", async () => {
    answer.current = {
      ...model644,
      depicts: "The Tesla logo on a white background.",
      reason: "The frames show the Tesla logo, which matches the subject but not the situation.",
    };
    const { j } = await judge(ABSTRACT);
    expect(j.verdict).toBe("does_not_fit");
    expect(j.reason.startsWith("only a logo: ")).toBe(true);
    expect(admitted()).toHaveLength(1);
  });

  it("the identity-guess guard still runs after the admission", async () => {
    answer.current = {
      ...model644,
      depicts: "A man sitting in a car, looking at a screen.",
      reason: "The man is presumably Elon Musk given the narration, which matches the subject, but the situation is not shown.",
    };
    const { j } = await judge(ABSTRACT, "Elon Musk's approach redefined how the industry thinks about selling cars.");
    expect(j.verdict).toBe("does_not_fit");
    expect(j.reason.startsWith("identity guessed, not seen: ")).toBe(true);
    expect(admitted()).toHaveLength(1);
  });

  it("a contradiction in the model's words blocks the admission", async () => {
    answer.current = {
      ...model644,
      depicts: "A screenshot of a web page with a Tesla article.",
      reason: "A screenshot of a website about Tesla matches the subject; the situation is not shown.",
    };
    const { j } = await judge(ABSTRACT);
    expect(j.verdict).toBe("does_not_fit");
    expect(admitted()).toHaveLength(0);
  });
});

/* ── the wiring, pinned in the source ───────────────────────────────────────────────────── */

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("wiring — the facts reach the judge on every pipeline route", () => {
  it("judgeBeatImage applies the rule after the situation rule and before the identity guards", () => {
    const gate = read("beatImageRelevanceGate.ts");
    /** Inside `settleSituationQuestion`: the situation rule, then its exception. */
    const situation = gate.indexOf("const judgementAfterSituation = situationRule(judgementAsGiven, parsed);");
    const abstract = gate.indexOf("const judgementAfterAbstractLine = abstractLineRule(judgementAfterSituation, parsed, line, beatText);");
    expect(situation).toBeGreaterThan(0);
    expect(abstract).toBeGreaterThan(situation);
    /** VIDEO 650 — one more step after the exception: what is still a subject-only refusal becomes acceptable. */
    const acceptable = gate.indexOf("const judgementAfterAcceptable = acceptableRule(judgementAfterAbstractLine, parsed, { beatText, subject: guess?.subject, personAsRead: guess?.personAsRead }, line);");
    expect(acceptable).toBeGreaterThan(abstract);
    expect(gate.slice(acceptable, acceptable + 700)).toContain("return judgementAfterAcceptable;");
    /** In `judgeBeatImage`: the settled answer is what the identity guards receive. */
    /** VIDEO 650 — the settle step also receives what the identity guard knows, so an acceptable never rests on a guessed subject. */
    const settled = gate.indexOf("const judgementAfterSituation = settleSituationQuestion(judgementAsGiven, parsed, params.line, beatText, { subject: params.anchors?.subject, personAsRead: state.personAsRead });");
    const guards = gate.indexOf("const judgement = refuseGuessedIdentity(judgementAfterSituation, beatText, params.anchors?.subject, state.personAsRead);");
    expect(settled).toBeGreaterThan(abstract);
    expect(guards).toBeGreaterThan(settled);
    /** The identity log compares with what reached that rule, so an admission is not logged as a guess. */
    expect(gate).toContain("if (judgement !== judgementAfterSituation) {");
  });

  it("checkBeatRelevance hands the context's line facts to the judge", () => {
    const rel = read("beatVisualRelevance.ts");
    expect(rel).toContain("line?: LineFacts;");
    expect(rel).toContain("line: ctx.line,");
  });

  it("the pipeline's one judge entry reads the facts from the render's intent state", () => {
    const vp = read("videoPipeline.ts");
    const fn = vp.indexOf("async function judgeBeatClipRelevance(");
    const body = vp.slice(fn, vp.indexOf("noteBeatVisionVerdict(", fn));
    expect(body).toContain("const line = params.ctx.line ?? lineFactsFor(dedup.beatIntent, sceneIndex, beatIndex);");
    expect(body).toContain("if (line && !params.ctx.line) params = { ...params, ctx: { ...params.ctx, line } };");
    /** VIDEO 627's own-sentence override is unchanged and spreads the context that now carries the facts. */
    const facts = body.indexOf("params = { ...params, ctx: { ...params.ctx, line } };");
    const override = body.indexOf("...(ownSentence?.trim() ? { ctx: { ...params.ctx, beatText: ownSentence } } : {}),");
    expect(facts).toBeGreaterThan(0);
    expect(override).toBeGreaterThan(facts);
  });

  it("the compose-time look gets the same facts through contextFor", () => {
    const vp = read("videoPipeline.ts");
    const scope = vp.indexOf("composeJudgeScope.contextFor = (sceneIndex, beatIndex) => {");
    const body = vp.slice(scope, scope + 900);
    expect(body).toContain("lineFactsFor(visualDedup.beatIntent, sceneIndex, beatIndex)");
  });

  it("the editor route carries no intent and is deliberately unchanged", () => {
    const tr = read("timelineRouter.ts");
    const at = tr.indexOf('route: "editor_auto_replace"');
    expect(at).toBeGreaterThan(0);
    const ctx = tr.slice(tr.lastIndexOf("ctx: {", at), at);
    expect(ctx).not.toContain("line");
    expect(tr).not.toContain("lineFactsFor");
  });

  it("archive-first and push ask through ensureVerdictBeforeCompose, whose context comes from contextFor", () => {
    const vp = read("videoPipeline.ts");
    for (const route of ['route: "archive_first"', 'route: "push"']) {
      const at = vp.indexOf(route);
      expect(at, route).toBeGreaterThan(0);
      expect(vp.slice(at - 300, at), route).toContain("ensureVerdictBeforeCompose({");
    }
    const rel = read("beatVisualRelevance.ts");
    const fn = rel.indexOf("export async function ensureVerdictBeforeCompose(");
    const ctxRead = rel.indexOf("const ctx = scope.contextFor(at.sceneIndex, at.beatIndex);");
    expect(fn).toBeGreaterThan(0);
    expect(ctxRead).toBeGreaterThan(fn);
    /** Only one function reads the scope's context, so the read belongs to this one. */
    expect(rel.indexOf("export async function", fn + 10) === -1 || rel.indexOf("export async function", fn + 10) > ctxRead).toBe(true);
  });

  it("the judge's rules key is unchanged — stored verdicts are read under the same key", () => {
    expect(read("beatImageRelevanceGate.ts")).toContain('export const BEAT_JUDGE_RULES = "r2610-subject-and-situation";');
  });
});
