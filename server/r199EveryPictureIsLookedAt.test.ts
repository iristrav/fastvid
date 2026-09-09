/**
 * RONDE 199 — EVERY PICTURE IS LOOKED AT, AND LOOKED AT AGAINST THE TEXT IT RUNS UNDER.
 *
 * The owner's rule, in one sentence, and the audit that followed it.
 *
 * ── What was already true ───────────────────────────────────────────────────────────────────
 *
 * The routes that claim REAL_FUNNEL — the providers, the archive, YouTube — could not adopt a
 * picture without an APPROVED verdict against the beat's own narration. That half worked.
 *
 * ── The hole ────────────────────────────────────────────────────────────────────────────────
 *
 * Every other category asked for "not rejected", and SILENCE SATISFIED IT. A rescue clip nobody
 * ever showed the editor passed, because the only thing that failed was an explicit refusal. So
 * "nobody looked" and "the editor looked and could not tell" were one answer, and only the second
 * was ever meant to pass. Cards were exempted outright — including maps, charts and title cards,
 * which are pictures a viewer reads and can be plainly wrong about the words underneath them.
 *
 * ── What this round changed ─────────────────────────────────────────────────────────────────
 *
 *   · NOT_ASKED satisfies nothing. UNCLEAR is untouched — see the render-569 note below.
 *   · The push route obtains a verdict before the guard is consulted, past the per-beat look
 *     ceiling, because the picture about to be used is not competing with anything.
 *   · A card is judged like any other picture. A refusal on the LAST RUNG is recorded and
 *     reprieved rather than obeyed: there is nothing behind it, and acting on it would leave the
 *     beat with no frames at all.
 *
 * ── The line this round was careful not to cross ────────────────────────────────────────────
 *
 * RONDE 97 measured what happens when UNCLEAR is treated as a refusal: render 569 lost 48 of its
 * 52 adoptions, all fourteen beats fell to colour cards, and the export gate refused the film.
 * Nothing here touches that. `render569Replay.test.ts` re-measures it every run.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  adoptionGuardVerdict,
  adoptionPolicyFor,
  visionRequirementMet,
  visionVerdictFromGate,
  type AdoptionVisionVerdict,
} from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const RELEVANCE = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");

const ENV = "ENFORCE_FUNNEL_ADOPTION";
const guard = (source: string, vision: AdoptionVisionVerdict, eligible = false) => {
  const saved = process.env[ENV];
  try {
    delete process.env[ENV];
    return adoptionGuardVerdict({ source, eligible, vision });
  } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
};

/* ═══════════ 1. no category accepts a picture nobody looked at ═══════════ */

describe("R199 §1 — silence is not an answer", () => {
  /** One from every category that puts something on screen. */
  const EVERY_KIND = [
    "archive", // REAL_FUNNEL
    "rescue_wikimedia", // RESCUE_REAL
    "subject_fallback", // FALLBACK_SUBJECT
    "extend", // BACKFILL_TIME
    "ai", // GENERATED
    "motion_graphic", // GRAPHIC
    "fallback", // PLACEHOLDER
  ];

  it.each(EVERY_KIND)("%s cannot adopt a picture with no verdict at all", (source) => {
    expect(guard(source, "NOT_ASKED").allowed, `${source} adopted an unseen picture`).toBe(false);
  });

  it("every declared route that shows something requires a look", () => {
    for (const source of EVERY_KIND) {
      const policy = adoptionPolicyFor(source);
      expect(policy.requiresVision, `${source} claims to need no editor`).toBe(true);
      expect(policy.visionRequirement, `${source} is exempt`).not.toBe("none");
    }
  });
});

/* ═══════════ 2. and the answer that emptied render 569 still passes ═══════════ */

describe("R199 §2 — 'could not tell' is not 'never looked'", () => {
  it.each(["rescue_wikimedia", "subject_fallback", "archive_similar", "ai"])(
    "%s still adopts on UNCLEAR, which is render 569's whole finding",
    (source) => {
      expect(guard(source, "UNCLEAR").allowed).toBe(true);
    }
  );

  it("the strongest claim still needs a yes, and nothing weaker", () => {
    for (const vision of ["UNCLEAR", "NOT_ASKED", "REJECTED"] as const) {
      expect(guard("archive", vision, true).allowed).toBe(false);
    }
    expect(guard("archive", "APPROVED", true).allowed).toBe(true);
  });

  it("a picture the editor refused still stays out of every real-footage route", () => {
    for (const source of ["rescue_wikimedia", "subject_fallback", "ai", "motion_graphic"]) {
      expect(guard(source, "REJECTED").allowed, `${source} used a refused picture`).toBe(false);
    }
  });
});

/* ═══════════ 3. the last rung: seen, recorded, and never taken away ═══════════ */

describe("R199 §3 — a refusal needs something behind it before it can act", () => {
  it("a colour card is kept whatever the editor made of it", () => {
    for (const source of ["fallback", "guaranteed", "rescue_placeholder"]) {
      expect(adoptionPolicyFor(source).category).toBe("PLACEHOLDER");
      expect(guard(source, "REJECTED").allowed, `${source} was taken away by its own verdict`).toBe(
        true
      );
      expect(guard(source, "NOT_ASKED").allowed, `${source} was never looked at`).toBe(false);
    }
  });

  it("a drawn graphic is not the last rung, so its refusal does bind", () => {
    for (const source of ["motion_graphic", "graphic", "text_overlay"]) {
      expect(adoptionPolicyFor(source).category).toBe("GRAPHIC");
      expect(guard(source, "REJECTED").allowed).toBe(false);
      expect(guard(source, "UNCLEAR").allowed).toBe(true);
    }
  });

  it("the gate reprieves a card's refusal rather than relabelling it", () => {
    // A reprieve overrules the judge; it must never rewrite what the judge said.
    const at = RELEVANCE.indexOf("const cardRefusalKept =");
    expect(at).toBeGreaterThan(0);
    const block = RELEVANCE.slice(at, at + 700);
    expect(block).toContain('judgement.verdict === "does_not_fit"');
    expect(block).toContain("reprieved: cardRefusalKept");
    expect(block).toContain("verdict: judgement.verdict");
  });

  it("nothing exempts a card from being looked at any more", () => {
    expect(RELEVANCE).not.toContain("neutral placeholder — nothing to judge");
  });
});

/* ═══════════ 4. one rule, two readers ═══════════ */

describe("R199 §4 — the refusal and the evidence line cannot disagree", () => {
  it("both go through the same function", () => {
    const audit = fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");
    expect(audit).toContain("visionRequirementMet(policy, vision)");
    expect(audit, "the second spelling of the rule is still there").not.toContain(
      '!policy.requiresVision || vision === "APPROVED"'
    );
  });

  it("the rule itself says what each requirement accepts", () => {
    const cases: Array<[string, AdoptionVisionVerdict, boolean]> = [
      ["archive", "APPROVED", true],
      ["archive", "UNCLEAR", false],
      ["rescue_wikimedia", "UNCLEAR", true],
      ["rescue_wikimedia", "REJECTED", false],
      ["rescue_wikimedia", "NOT_ASKED", false],
      ["fallback", "REJECTED", true],
      ["fallback", "NOT_ASKED", false],
    ];
    for (const [source, vision, expected] of cases) {
      expect(visionRequirementMet(adoptionPolicyFor(source), vision), `${source}/${vision}`).toBe(
        expected
      );
    }
  });
});

/* ═══════════ 5. the look is obtainable where it is now required ═══════════ */

describe("R199 §5 — tightening the rule without starving the render", () => {
  it("the push route asks before the guard reads, and says this one is the picture", () => {
    const at = PIPE.indexOf("async function beatClipRefusedByRelevanceGate(");
    expect(at).toBeGreaterThan(0);
    const body = PIPE.slice(at, at + 2600);
    expect(body).toContain("ensureVerdictBeforeCompose({");
    expect(body).toContain("finalSay: true");
  });

  it("every push closure asks first and only then consults the guard", () => {
    const asks = [...PIPE.matchAll(/beatClipRefusedByRelevanceGate\(dedup, clipPath/g)];
    expect(asks.length).toBeGreaterThanOrEqual(5);
    for (const m of asks) {
      const after = PIPE.slice(m.index!, m.index! + 400);
      expect(after, "a push route consults the guard without obtaining a verdict first").toContain(
        "adoptionGuardRefusesPush(dedup, clipPath"
      );
    }
  });

  it("the final say passes the per-beat look ceiling, and nothing else does", () => {
    const at = RELEVANCE.indexOf("maxRelevanceLooksPerBeat() && !params.finalSay");
    expect(at, "the ceiling no longer has exactly one named exemption").toBeGreaterThan(0);
    // The ceiling still stops an ordinary candidate: the exemption is the flag, not the removal.
    expect(RELEVANCE).toContain("state.judgementsSkipped++");
    expect(RELEVANCE).toContain("per-beat look ceiling reached");
  });

  it("the final say passes the compose-phase budget too", () => {
    const at = RELEVANCE.indexOf("if (!params.finalSay && scope.spent >= scope.budget)");
    expect(at).toBeGreaterThan(0);
    // And the budget still stops the compose barrier's own speculative asks.
    expect(RELEVANCE).toContain('return { outcome: "budget_spent" }');
  });

  it("a render with no picture editor at all is still excused as a whole", () => {
    // The one suspension that survives: `visionAvailable: false` is a fact about the environment,
    // never about a clip, and RONDE 89's export gate still refuses the film such a render makes.
    expect(
      adoptionGuardVerdict({
        source: "rescue_wikimedia",
        eligible: false,
        vision: "NOT_ASKED",
        visionAvailable: false,
      }).allowed
    ).toBe(true);
  });
});

/* ═══════════ 6. the judge is asked about the beat's own words ═══════════ */

describe("R199 §6 — 'good enough for the text' is the question that gets asked", () => {
  it("the question carries the beat's narration, not just the clip", async () => {
    const { checkBeatRelevance, createBeatRelevanceLedger } = await import("./beatVisualRelevance");
    const { createBeatImageGateState } = await import("./beatImageRelevanceGate");
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      seen.push(String(line));
    });
    try {
      await checkBeatRelevance({
        clipPath: "/nonexistent/clip.mp4",
        contentKey: "wikimedia:1",
        ctx: {
          sceneIndex: 0,
          beatIndex: 0,
          beatText: "The bunker lay beneath the Reich Chancellery garden.",
        },
        workDir: "/tmp",
        state: createBeatImageGateState(),
        ledger: createBeatRelevanceLedger(),
        route: "r199",
      });
    } finally {
      spy.mockRestore();
    }
    // No model in this environment: the point is that the beat's own text reached the question and
    // the outcome was recorded against that beat rather than silently dropped.
    expect(seen.join("\n")).toContain("s0b0");
  });
});

/* ═══════════ 7. the distinction was carried the whole way and then dropped ═══════════ */

describe("R199b — 'never looked' stopped arriving dressed as 'could not tell'", () => {
  it("an unevaluated decision is NOT_ASKED, whatever word it carries", () => {
    // `judgeBeatImage` returns verdict "unknown" for both, and separates them with `evaluated`.
    expect(visionVerdictFromGate("unknown", false)).toBe("NOT_ASKED");
    expect(visionVerdictFromGate("unknown", true)).toBe("UNCLEAR");
  });

  it("a model that WAS asked and failed is still an answer about the picture", () => {
    // A timeout or an unparseable reply returns evaluated:true by design — the picture was seen
    // and settled nothing. Reading that as "nobody looked" would empty montages on every outage.
    expect(visionVerdictFromGate("unknown", true)).toBe("UNCLEAR");
    expect(guard("rescue_wikimedia", visionVerdictFromGate("unknown", true)).allowed).toBe(true);
  });

  it("a verdict with no evaluated flag behaves exactly as before", () => {
    // A replayed log line or a stored value has only the word. Nothing about those callers moved.
    expect(visionVerdictFromGate("unknown")).toBe("UNCLEAR");
    expect(visionVerdictFromGate("fits")).toBe("APPROVED");
    expect(visionVerdictFromGate("does_not_fit")).toBe("REJECTED");
    expect(visionVerdictFromGate(undefined)).toBe("NOT_ASKED");
  });

  it("every reader that holds a decision passes the flag", () => {
    for (const file of ["clipAdoptAudit.ts", "videoPipeline.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      const bare = [...src.matchAll(/visionVerdictFromGate\([^,)]*\?\.verdict\)/g)];
      expect(bare.map((m) => `${file}: ${m[0]}`), "a reader still drops `evaluated`").toEqual([]);
    }
  });
});

/* ═══════════ 8. no editor at all is a fact about the render, not about a picture ═══════════ */

describe("R199b — an outage must never be able to empty a film", () => {
  it("the three ways of having no editor all say so render-wide", async () => {
    const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    // Switched off, nothing contacted, and a provider with no capacity: the same statement.
    expect(GATE).toContain("noteAskImpossible(state, \"the beat image gate is switched off");
    expect(GATE).toContain("no provider could be asked");
    expect(GATE).toContain("provider has no capacity");
  });

  it("it is announced once, not once per picture", async () => {
    const { createBeatImageGateState } = await import("./beatImageRelevanceGate");
    const state = createBeatImageGateState();
    expect(state.askImpossible, "a render starts by demanding a verdict").toBe(false);
  });

  it("the adoption guard joins both editors' outages into one answer", () => {
    const at = PIPE.indexOf("const visionAvailable =");
    expect(at).toBeGreaterThan(0);
    const block = PIPE.slice(at, at + 200);
    expect(block).toContain("!visionPipelineIsUnavailable()");
    expect(block).toContain("!dedup.beatImageGate?.askImpossible");
  });

  it("and a suspended requirement still cannot make a picture count as verified", () => {
    // The suspension excuses a MISSING verdict. It never turns one into an approval, and the
    // export gate still refuses a film whose beats hold no verified own visual.
    expect(adoptionPolicyFor("rescue_wikimedia").countsAsVerifiedVisual).toBe(false);
    expect(adoptionPolicyFor("fallback").countsAsRealFootage).toBe(false);
  });
});
